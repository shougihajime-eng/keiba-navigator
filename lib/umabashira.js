"use strict";
//
// umabashira.js — 馬柱（うまばしら＝各馬の過去5走）を組み立てる純関数モジュール
//
// ■ このファイルがやること
//   「レースID を渡すと、その出走各馬の過去5走の配列を返す」だけ。
//   画面（HTML/CSS）にもファイル読み書きにも一切さわらない ＝ 純粋な計算だけ。
//
// ■ 使い方（サーバー側の例）
//     const U   = require("./lib/umabashira.js");
//     const uma = JSON.parse(fs.readFileSync("data/jv_cache/umabashira.json", "utf8"));
//     const rows = U.rowsForRaceId(uma, "202608090101061200");
//     // rows = [{ number, frame, name, ketto_num, isFirstStart, record, runs:[過去5走…] }, …]
//
//   索引(umabashira.json)に無いレースでも、レースJSON そのものを渡せば動く:
//     const rows = U.rowsForRace(uma, raceJson);
//
// ■ 絶対に守っていること（データを作らない）
//   ・過去走が1つも無い馬（新馬）は runs:[] を返し isFirstStart:true を立てる。推測で埋めない。
//   ・値がおかしい（読み取り事故で壊れている）データは null にする。それらしい値を捏造しない。
//   ・着差（馬身）は元データに無いので出さない。代わりに実タイムから引き算した「タイム差(秒)」だけを出す。
//
// 元データ: data/jv_cache/races/<raceId>.json （JV-Link から作った出走表＋確定結果）
//

// ── 表記辞書（JRA-VAN の公開コード。推測なし） ──────────────
const JYO_NAMES = {
  "01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京",
  "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉",
};

const SURFACE_SHORT = { "芝": "芝", "ダート": "ダ", "障害": "障" };

// 異常区分コード（JV-Data コード表 2101）。0 = ふつうに走った。
const ABNORMAL_LABELS = {
  "0": null,
  "1": "取消",
  "2": "発走除外",
  "3": "除外",
  "4": "中止",
  "5": "失格",
  "6": "再騎乗",
  "7": "降着",
};

// 今回レース脚質判定（1逃げ 2先行 3差し 4追込 5マクリ）
const RUN_STYLE_LABELS = {
  "1": "逃げ", "2": "先行", "3": "差し", "4": "追込", "5": "マクリ",
};

// ── 正気度チェックの範囲（この外は「壊れている」とみなして null にする） ──
// 2026-08 実データで確認: 一部のレースファイルは取り込み事故で
// 馬名が文字化けし、人気50・着順47・斤量null などの ありえない値が入っている。
const SANE = {
  weightKg:    [40, 70],     // 斤量
  bodyWeight:  [300, 700],   // 馬体重
  bodyDiffAbs: 60,           // 馬体重の増減
  last3f:      [25, 60],     // 上がり3ハロン(秒)
  speedMps:    [8, 22],      // 走破タイムの妥当性 = 距離 ÷ 秒
  fieldSize:   [2, 28],      // 出走頭数
  maxNumber:   28,           // 馬番
};

// 1頭でも「取り込み事故のしるし」があれば、そのレースはまるごと使わない。
//   理由: 事故はバイトのずれで起きるので、名前が読めている馬でも
//   人気・着順・斤量などの数字がずれている可能性が高い。
//   （2026-08 実データ: 4,380レース中 268レース＝2026年5月の全開催日が該当。
//     3つのしるし〔馬名・騎手・調教師〕がぴたり同じ268件を指した＝見分けは確実）
function isRaceCorrupt(race) {
  const horses = (race && Array.isArray(race.horses)) ? race.horses : [];
  if (!horses.length) return true;
  for (const h of horses) {
    if (isBrokenText(h && h.name)) return true;                     // 馬名が文字化け／空
    const jk = (h && typeof h.jockey === "string") ? h.jockey.trim() : "";
    if (jk && (/[?？�]/.test(jk) || /^[0-9]+$/.test(jk))) return true; // 騎手名の場所に数字コード
    const tr = (h && typeof h.trainer === "string") ? h.trainer.trim() : "";
    if (tr && /[?？�]/.test(tr)) return true;                        // 調教師名が文字化け
  }
  return false;
}

// 馬柱の列（netkeiba 流のおすすめ並び順）。画面を作る人がそのまま使える表。
const COLUMNS = [
  { key: "date",       label: "日付",   note: "YYYYMMDD。表示は 26.08.09 など好きな形に" },
  { key: "venue",      label: "場",     note: "新潟・東京 など" },
  { key: "raceLabel",  label: "レース", note: "レース名。無い条件戦は 12R のように出る" },
  { key: "courseLabel",label: "距離",   note: "芝1600 / ダ1800 / 障2890" },
  { key: "going",      label: "馬場",   note: "良・稍重・重・不良" },
  { key: "fieldSize",  label: "頭数",   note: "出走頭数" },
  { key: "frame",      label: "枠",     note: "枠番" },
  { key: "number",     label: "馬番",   note: "馬番" },
  { key: "popularity", label: "人気",   note: "単勝人気" },
  { key: "rankLabel",  label: "着順",   note: "着順。取消・中止などは その言葉が入る" },
  { key: "time",       label: "タイム", note: "1:58.2 の形" },
  { key: "last3f",     label: "上り",   note: "上がり3ハロン(秒)。last3fRank は順位" },
  { key: "passing",    label: "通過",   note: "5-5-4-3 の形" },
  { key: "weight",     label: "斤量",   note: "kg" },
  { key: "jockey",     label: "騎手",   note: "騎手名" },
  { key: "bodyLabel",  label: "馬体重", note: "478(-4) の形" },
];

// ── 小さな道具 ───────────────────────────────────

// 馬名の突き合わせ用に空白を全部とる（「サクラ バクシンオー」と「サクラバクシンオー」を同じ扱いに）
function normalizeName(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[\s　]+/g, "");
}

// 文字化け・空っぽの判定。'?' や U+FFFD が入っていたら読み取り事故。
function isBrokenText(s) {
  if (typeof s !== "string") return true;
  const t = s.trim();
  if (!t) return true;
  return /[?？�]/.test(t);
}

// 18桁のレースIDをばらす
function parseRaceId(id) {
  if (typeof id !== "string" || !/^[0-9]{18}$/.test(id)) return null;
  const jyoCode = id.slice(8, 10);
  return {
    date:    id.slice(0, 8),                    // "20260809"
    year:    Number(id.slice(0, 4)),
    month:   Number(id.slice(4, 6)),
    day:     Number(id.slice(6, 8)),
    jyoCode,
    venue:   JYO_NAMES[jyoCode] || null,
    kaiji:   Number(id.slice(10, 12)),
    nichiji: Number(id.slice(12, 14)),
    raceNum: Number(id.slice(14, 16)),
  };
}

// "20260809" → "2026/08/09"
function formatDate(yyyymmdd, sep) {
  const s = String(yyyymmdd || "");
  if (!/^[0-9]{8}$/.test(s)) return null;
  const d = sep == null ? "/" : sep;
  return s.slice(0, 4) + d + s.slice(4, 6) + d + s.slice(6, 8);
}

// 走破タイム "1582"(9分99秒9形式) → 秒。おかしければ null。
function parseTimeSec(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!/^[0-9]{4}$/.test(s)) return null;
  const min = Number(s[0]);
  const sec = Number(s.slice(1, 3));
  const tenth = Number(s[3]);
  if (sec > 59) return null;
  const total = min * 60 + sec + tenth / 10;
  return total > 0 ? Math.round(total * 10) / 10 : null;
}

// 秒 → "1:58.2"
function formatTimeSec(sec) {
  if (typeof sec !== "number" || !isFinite(sec) || sec <= 0) return null;
  const t = Math.round(sec * 10) / 10;
  const m = Math.floor(t / 60);
  const rest = t - m * 60;
  const whole = Math.floor(rest);
  const tenth = Math.round((rest - whole) * 10);
  return `${m}:${String(whole).padStart(2, "0")}.${tenth}`;
}

// 通過順 [5,5,4,3] → "5-5-4-3"（0/null のコーナーは無かったコーナーなので飛ばす）
function formatPassing(corners, fieldSize) {
  const max = (typeof fieldSize === "number" && fieldSize > 0) ? fieldSize : SANE.maxNumber;
  const out = [];
  for (const c of (corners || [])) {
    if (typeof c !== "number" || !isFinite(c)) continue;
    if (c < 1 || c > max) continue;   // 0 = そのコーナーが無い / 範囲外 = 壊れている
    out.push(c);
  }
  return out.length ? out.join("-") : null;
}

function inRange(v, range) {
  return typeof v === "number" && isFinite(v) && v >= range[0] && v <= range[1];
}

function numOrNull(v, range) {
  return inRange(v, range) ? v : null;
}

// ── レース1本 → 出走各馬の「1走ぶん」の記録に変換 ────────────

// レースの見出し情報だけを取り出す
function raceMeta(race) {
  if (!race || typeof race !== "object") return null;
  const id = race.race_id;
  const p = parseRaceId(id);
  if (!p) return null;
  const fieldSize = Array.isArray(race.horses) ? race.horses.length : 0;
  const surface = race.surface || null;
  const short = SURFACE_SHORT[surface] || null;
  const distance = inRange(race.distance, [800, 5000]) ? race.distance : null;
  const rawName = typeof race.race_name === "string" ? race.race_name.trim() : "";
  const raceName = (rawName && !isBrokenText(rawName)) ? rawName : null;
  return {
    race_id:     id,
    date:        p.date,
    venue:       p.venue,
    venueCode:   p.jyoCode,
    raceNum:     p.raceNum,
    raceName,                                   // 条件戦は空のことが多い（JV-Data にクラス名が無い）
    grade:       race.is_g1 === true ? "G1" : null,
    raceLabel:   raceName || (p.raceNum ? `${p.raceNum}R` : null),
    surface,
    distance,
    courseLabel: (short && distance) ? `${short}${distance}` : (distance ? String(distance) : null),
    going:       race.going || null,
    weather:     race.weather || null,
    fieldSize:   inRange(fieldSize, SANE.fieldSize) ? fieldSize : null,
  };
}

// 1レースぶんの全馬の記録を作る。
// 戻り値 { meta, runs:[…], corrupt:boolean, skipped:n }
//   corrupt=true のレースは、取り込み事故で中身が壊れているので馬柱に使わない。
function runsOfRace(race) {
  const meta = raceMeta(race);
  if (!meta) return { meta: null, runs: [], corrupt: true, skipped: 0 };

  const horses = Array.isArray(race.horses) ? race.horses : [];
  const fieldSize = meta.fieldSize || horses.length;

  // ① レースまるごと壊れていないか（1頭でもしるしがあれば使わない）
  if (isRaceCorrupt(race)) return { meta, runs: [], corrupt: true, skipped: horses.length };

  // ② 勝ち馬と、上がり3ハロンの順位を先に求める（1走の中身に入れるため）
  let winner = null;             // { name, timeSec }
  let second = null;
  const l3list = [];
  for (const h of horses) {
    const t = parseTimeSec(h.time);
    const sec = (t != null && meta.distance && inRange(meta.distance / t, SANE.speedMps)) ? t : null;
    if (h.kakutei_jyuni === 1 && !winner) winner = { name: h.name, timeSec: sec };
    if (h.kakutei_jyuni === 2 && !second) second = { name: h.name, timeSec: sec };
    if (inRange(h.haron_l3, SANE.last3f)) l3list.push(h.haron_l3);
  }
  l3list.sort((a, b) => a - b);

  // ③ 1頭ずつ
  const runs = [];
  let skipped = 0;
  for (const h of horses) {
    const name = typeof h.name === "string" ? h.name.trim() : "";
    const ketto = String(h.ketto_num || "");
    if (isBrokenText(name) || !/^[0-9]{10}$/.test(ketto)) { skipped++; continue; }

    const number = inRange(h.number, [1, SANE.maxNumber]) ? h.number : null;
    if (number == null) { skipped++; continue; }

    const rankRaw = h.kakutei_jyuni;
    const rank = (typeof rankRaw === "number" && rankRaw >= 1 && rankRaw <= (fieldSize || SANE.maxNumber))
      ? rankRaw : null;

    const abnormalCode = String(h.ijyou_code == null ? "" : h.ijyou_code);
    const abnormal = Object.prototype.hasOwnProperty.call(ABNORMAL_LABELS, abnormalCode)
      ? ABNORMAL_LABELS[abnormalCode] : null;

    const timeSecRaw = parseTimeSec(h.time);
    const timeSec = (timeSecRaw != null && meta.distance && inRange(meta.distance / timeSecRaw, SANE.speedMps))
      ? timeSecRaw : null;

    const last3f = numOrNull(h.haron_l3, SANE.last3f);
    let last3fRank = null;
    if (last3f != null && l3list.length) last3fRank = l3list.indexOf(last3f) + 1;

    const bodyWeight = numOrNull(h.body_weight, SANE.bodyWeight);
    let bodyDiff = null;
    if (bodyWeight != null && typeof h.weight_diff === "number" &&
        isFinite(h.weight_diff) && Math.abs(h.weight_diff) <= SANE.bodyDiffAbs) {
      bodyDiff = h.weight_diff;
    }

    const jockeyRaw = typeof h.jockey === "string" ? h.jockey.trim() : "";
    // 取り込み事故のときは騎手名の場所に数字コードが入る
    const jockey = (!isBrokenText(jockeyRaw) && !/^[0-9]+$/.test(jockeyRaw)) ? jockeyRaw : null;

    // 相手（自分が勝っていれば2着馬、そうでなければ勝ち馬）とのタイム差
    const rival = (rank === 1) ? second : winner;
    let diffSec = null;
    if (timeSec != null && rival && rival.timeSec != null) {
      diffSec = Math.round((timeSec - rival.timeSec) * 10) / 10;
    }
    const rivalName = (rival && !isBrokenText(rival.name)) ? rival.name.trim() : null;

    // 出走したのに結果が1つも入っていない＝結果データがまだ届いていないレース
    // （2026-08 実データ: 4,380レース中43本。空欄だらけの行を黙って出すと「壊れている」に見えるので、
    //   はっきり「結果なし」と書く。走らなかったことにして隠すのも嘘なので、行自体は残す）
    const resultMissing = (rank == null && abnormal == null && timeSec == null && last3f == null);

    runs.push({
      race_id:     meta.race_id,
      date:        meta.date,
      venue:       meta.venue,
      raceNum:     meta.raceNum,
      raceName:    meta.raceName,
      grade:       meta.grade,
      raceLabel:   meta.raceLabel,
      surface:     meta.surface,
      distance:    meta.distance,
      courseLabel: meta.courseLabel,
      going:       meta.going,
      weather:     meta.weather,
      fieldSize:   meta.fieldSize,
      frame:       inRange(h.frame, [1, 8]) ? h.frame : null,
      number,
      popularity:  (typeof h.popularity === "number" && h.popularity >= 1 &&
                    h.popularity <= (fieldSize || SANE.maxNumber)) ? h.popularity : null,
      rank,
      abnormal,
      resultMissing,
      rankLabel:   rank != null ? String(rank) : (abnormal || (resultMissing ? "結果なし" : null)),
      time:        formatTimeSec(timeSec),
      timeSec,
      diffSec,                                  // 勝ち馬との差(秒)。自分が勝ったならマイナス
      rivalName,                                // 勝ち馬（自分が勝った時は2着馬）
      last3f,
      last3fRank,
      passing:     formatPassing([h.jyuni_1c, h.jyuni_2c, h.jyuni_3c, h.jyuni_4c], fieldSize),
      runStyle:    RUN_STYLE_LABELS[String(h.kyakusitu)] || null,
      weight:      numOrNull(h.weight, SANE.weightKg),
      jockey,
      bodyWeight,
      bodyDiff,
      bodyLabel:   bodyWeight == null ? null
                    : (bodyDiff == null ? String(bodyWeight)
                       : `${bodyWeight}(${bodyDiff > 0 ? "+" : ""}${bodyDiff})`),
      // どの馬の1走か（索引を作るときに使う。索引に入れたあとは消す）
      _ketto:      ketto,
      _name:       name,
      _sexAge:     (typeof h.sex_age === "string" && !isBrokenText(h.sex_age)) ? h.sex_age.trim() : null,
    });
  }
  return { meta, runs, corrupt: false, skipped };
}

// ── 索引づくり ──────────────────────────────────
//
//   buildIndex(races, {keep}) →
//     {
//       horses: { <血統登録番号>: [走, 走, …] }   … 新しい順・最大 keep 本
//       names:  { <空白を取った馬名>: [血統登録番号, …] }
//       races:  { <レースID>: { date, venue, raceNum, raceName, …, entries:[{number,frame,name,ketto}] } }
//       stats:  { races, usable, corrupt, starts, horses }
//     }
//
function buildIndex(races, opts) {
  const keep = (opts && opts.keep) || 8;
  const horses = Object.create(null);
  const names = Object.create(null);
  const raceMap = Object.create(null);
  const stats = { races: 0, usable: 0, corrupt: 0, starts: 0, skipped: 0, horses: 0 };

  for (const race of (races || [])) {
    stats.races++;
    const { meta, runs, corrupt, skipped } = runsOfRace(race);
    stats.skipped += skipped || 0;
    if (!meta) continue;
    if (corrupt) { stats.corrupt++; continue; }
    stats.usable++;

    const entries = [];
    for (const r of runs) {
      stats.starts++;
      const ketto = r._ketto;
      const name = r._name;
      entries.push({ number: r.number, frame: r.frame, name, ketto, sexAge: r._sexAge });
      const clean = Object.assign({}, r);
      delete clean._ketto; delete clean._name; delete clean._sexAge;
      (horses[ketto] || (horses[ketto] = [])).push(clean);
      const key = normalizeName(name);
      const list = names[key] || (names[key] = []);
      if (list.indexOf(ketto) === -1) list.push(ketto);
    }
    entries.sort((a, b) => a.number - b.number);
    raceMap[meta.race_id] = Object.assign({}, meta, { entries });
  }

  // 新しい順に並べ、keep 本だけ残す
  for (const k of Object.keys(horses)) {
    horses[k].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.raceNum - a.raceNum));
    if (horses[k].length > keep) horses[k].length = keep;
  }
  stats.horses = Object.keys(horses).length;

  return { horses, names, races: raceMap, stats };
}

// ── 取り出し（ここが本番の入口） ──────────────────────

// 名前だけしか分からない時に血統登録番号を引く。
// 同じ名前の馬が2頭以上いる時は「分からない」として null を返す（違う馬を出さないため）。
function kettoByName(uma, name) {
  if (!uma || !uma.names) return null;
  const list = uma.names[normalizeName(name)];
  if (!list || list.length !== 1) return null;
  return list[0];
}

// ある馬の「その日より前」の走りを新しい順に limit 本
function pastRuns(uma, opts) {
  const o = opts || {};
  const limit = o.limit == null ? 5 : o.limit;
  let ketto = o.ketto && /^[0-9]{10}$/.test(String(o.ketto)) ? String(o.ketto) : null;
  if (!ketto && o.name) ketto = kettoByName(uma, o.name);
  if (!ketto || !uma || !uma.horses) return [];
  const all = uma.horses[ketto];
  if (!Array.isArray(all)) return [];
  const before = o.beforeDate ? String(o.beforeDate) : null;
  const out = [];
  for (const r of all) {
    if (before && !(r.date < before)) continue;   // その日より前だけ（当日・未来は入れない）
    out.push(r);
    if (limit > 0 && out.length >= limit) break;
  }
  return out;
}

// 過去走の成績をかぞえる（渡した走りの範囲だけ。全キャリアではない）
function recordOf(runs) {
  const rec = { starts: 0, win: 0, second: 0, third: 0, in3: 0 };
  for (const r of (runs || [])) {
    rec.starts++;
    if (r.rank === 1) rec.win++;
    else if (r.rank === 2) rec.second++;
    else if (r.rank === 3) rec.third++;
  }
  rec.in3 = rec.win + rec.second + rec.third;
  return rec;
}

// 出走馬の一覧（{number, frame, name, ketto, sexAge}）から馬柱の行を作る共通処理
//
// ⚠ 正直にしていること:
//   過去走が0本でも「新馬」とは言い切らない。この索引は 2025-05-17 以降しか持っていないので、
//   「久しぶりの出走」「地方・海外から来た馬」も0本になる。分かるのは
//   「この期間に見つからなかった」ことだけ。2歳馬なら新馬とほぼ言い切れるので、そこだけ区別する。
function rowsFromEntries(uma, entries, raceDate, opts) {
  const limit = (opts && opts.limit != null) ? opts.limit : 5;
  const from = (uma && uma.history_window && uma.history_window.from) || null;
  const rows = [];
  for (const e of (entries || [])) {
    const ketto = e.ketto || e.ketto_num || null;
    const runs = pastRuns(uma, { ketto, name: e.name, beforeDate: raceDate, limit });
    const sexAge = e.sexAge || e.sex_age || null;
    const age = sexAge ? Number(String(sexAge).replace(/[^0-9]/g, "")) : null;
    let historyNote = null;
    if (runs.length === 0) {
      historyNote = (age === 2)
        ? "新馬（中央では初出走）"
        : `過去走なし（この表は ${from ? formatDate(from) : "取り込みぶん"} 以降の中央競馬のみ）`;
    }
    rows.push({
      number:      e.number != null ? e.number : null,
      frame:       e.frame != null ? e.frame : null,
      name:        e.name || null,
      sexAge,
      ketto_num:   (ketto && /^[0-9]{10}$/.test(String(ketto))) ? String(ketto) : null,
      noPastRuns:  runs.length === 0,   // 過去走が1本も見つからなかった
      historyNote,                      // その理由。画面にはこの言葉をそのまま出せば正直
      record:      recordOf(runs),      // ここに出した過去走の範囲だけの成績（通算ではない）
      runs,
    });
  }
  rows.sort((a, b) => (a.number || 99) - (b.number || 99));
  return rows;
}

// ★ 本命の入口 ★  レースIDを渡すと、その出走各馬の過去5走を返す。
//   索引にそのレースが入っていなければ null（そのときは rowsForRace を使う）。
function rowsForRaceId(uma, raceId, opts) {
  if (!uma || !uma.races) return null;
  const r = uma.races[String(raceId)];
  if (!r) return null;
  return rowsFromEntries(uma, r.entries, r.date, opts);
}

// レースJSON そのもの（data/jv_cache/races/<id>.json の中身、または当日の出走表）を渡す版。
// 索引に無い新しいレースでも使える。
function rowsForRace(uma, race, opts) {
  if (!race || !Array.isArray(race.horses)) return [];
  const p = parseRaceId(race.race_id);
  const date = p ? p.date : (opts && opts.date) || null;
  const entries = race.horses.map((h) => ({
    number: h.number, frame: h.frame, name: h.name,
    ketto: h.ketto_num || h.ketto || null,
    sexAge: h.sex_age || h.sexAge || null,
  }));
  return rowsFromEntries(uma, entries, date, opts);
}

const _exports = {
  // 定数
  JYO_NAMES, SURFACE_SHORT, ABNORMAL_LABELS, RUN_STYLE_LABELS, COLUMNS, SANE,
  // 道具
  normalizeName, isBrokenText, isRaceCorrupt, parseRaceId, formatDate,
  parseTimeSec, formatTimeSec, formatPassing,
  // 生データ → 記録
  raceMeta, runsOfRace, buildIndex,
  // 取り出し
  kettoByName, pastRuns, recordOf, rowsForRaceId, rowsForRace,
};

if (typeof module !== "undefined" && module.exports) module.exports = _exports;
if (typeof window !== "undefined") window.Umabashira = _exports;
