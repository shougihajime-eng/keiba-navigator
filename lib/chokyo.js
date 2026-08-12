"use strict";
//
// chokyo.js — 調教（追い切り＝レース前の稽古）を読み取る純関数モジュール
//
// ■ このファイルがやること
//   「レースID を渡すと、その出走各馬の直近の追い切りを返す」だけ。
//   画面（HTML/CSS）にも ファイル読み書きにも 一切さわらない ＝ 純粋な計算だけ。
//
// ■ 使い方（サーバー側の例）
//     const C   = require("./lib/chokyo.js");
//     const idx = JSON.parse(fs.readFileSync("data/jv_cache/chokyo/index.json", "utf8"));
//     const rows = C.rowsForRaceId(idx, "202608090101061200");
//     // rows = [{ number, ketto_num, hasData, note, counts, latest, sessions }, …]
//
//   索引に無いレースでも、レースJSON そのものを渡せば動く:
//     const rows = C.rowsForRace(idx, raceJson);
//
// ■ 「速い/普通/遅い」の決め方（netkeiba と同じ考え方）
//   絶対値のしきい値（例:「坂路4ハロン 52秒より速ければ速い」）は 1つも書いていない。
//   **同じ条件（同じトレセン・同じ調教コース・同じ距離）の中で 上位何% か** だけで決める。
//     上位 5% まで  → とても速い   （netkeiba のオレンジ相当）
//     上位 20% まで → 速い         （netkeiba の黄色相当）
//     下位 20%      → 遅い
//     それ以外      → ふつう
//   何%なのかは必ず percent に入れて返す。色だけ出して根拠を隠さない。
//
// ■ 数字を作らないための約束
//   ・調教データが無い馬は hasData:false を返す。それらしい平均値で埋めない。
//   ・同じ条件のサンプルが少ない分布では順位を出さない（grade は null ＋ 理由を note に）。
//   ・レース当日および それより後の調教は絶対に混ぜない（未来を見ない）。
//
// ■ JRA-VAN の調教データに入っていないもの（このモジュールも出さない）
//   乗り役 / 併せ馬・脚色（馬なり・一杯）/ 芝・ダート・プール・角馬場の調教。
//   ＝ JRA-VAN は 坂路(SLOP) と ウッドチップ(WOOD) の2種類しか配信していない。
//   netkeiba のそれらは netkeiba 独自の取材データで、この契約では取れない。
//
// 元データ: data/jv_cache/chokyo/index.json （jv_bridge/build_chokyo.py が作る）
//

// ── 判定の段階（順位だけで決める。秒数は一切使わない） ────────
const TIERS = [
  { tier: "top5",  maxPercent: 5,   label: "とても速い", rank: 3 },
  { tier: "top20", maxPercent: 20,  label: "速い",       rank: 2 },
  { tier: "mid",   maxPercent: 80,  label: "ふつう",     rank: 1 },
  { tier: "slow",  maxPercent: 100, label: "遅い",       rank: 0 },
];

// 何ハロン目のタイムを どの名前で扱うか
const METRICS = {
  total: { label: "全体",       from: "total" },
  f4:    { label: "4ハロン",    from: "cum",  key: "4" },
  f3:    { label: "3ハロン",    from: "cum",  key: "3" },
  f1:    { label: "ラスト1ハロン", from: "lap", key: "1" },
};

const KIND_LABEL = { H: "坂路", W: "ウッド" };

// ── 小さな道具 ────────────────────────────────────────────

function isKetto(v) {
  return typeof v === "string" ? /^[0-9]{10}$/.test(v) : false;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// レースID (18桁 = 西暦4 + 月日4 + 場2 + 回2 + 日次2 + R2 + "00") から日付を取り出す
function raceDateOf(raceId) {
  const s = String(raceId || "");
  if (!/^[0-9]{16,18}$/.test(s)) return null;
  const d = s.slice(0, 8);
  return /^(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])$/.test(d) ? d : null;
}

function formatDate(yyyymmdd) {
  const s = String(yyyymmdd || "");
  if (s.length !== 8) return s || null;
  return `${Number(s.slice(4, 6))}月${Number(s.slice(6, 8))}日`;
}

// 「何日前か」。日付は YYYYMMDD の文字列なので UTC で日数に直して引き算する。
function daysBetween(fromYmd, toYmd) {
  const a = String(fromYmd || ""), b = String(toYmd || "");
  if (a.length !== 8 || b.length !== 8) return null;
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const diff = (t(b) - t(a)) / 86400000;
  return Number.isFinite(diff) ? Math.round(diff) : null;
}

// 同じ条件でくらべるための鍵。build_chokyo.py の group_key と必ず同じにする。
function groupKey(session) {
  if (!session) return null;
  const kind = session.kindCode || (session.kind === "坂路" ? "H" : session.kind === "ウッド" ? "W" : null);
  const tresen = session.tresenCode != null ? String(session.tresenCode)
               : session.tresen === "美浦" ? "0" : session.tresen === "栗東" ? "1" : null;
  const f = session.furlongs;
  if (!kind || tresen == null || !f) return null;
  return `${kind}|${tresen}|${f}`;
}

// 軽い索引では kind / tresen / meters を落として小さくしてある（コードから作れるので）。
// ここで元に戻す。--full の索引はそのまま入っているのでそちらを使う。
function kindOf(session) {
  if (!session) return null;
  return session.kind || KIND_LABEL[session.kindCode] || null;
}
function tresenOf(session) {
  if (!session) return null;
  if (session.tresen) return session.tresen;
  const c = String(session.tresenCode);
  return c === "0" ? "美浦" : c === "1" ? "栗東" : null;
}
function metersOf(session) {
  if (!session) return null;
  if (session.meters) return session.meters;
  return session.furlongs ? session.furlongs * 200 : null;
}

// この調教の「場所」を人の言葉で（例:「栗東 坂路 800m」「美浦 ウッド 1200m Aコース」）
function placeLabel(session) {
  if (!session) return null;
  const m = metersOf(session);
  const parts = [tresenOf(session), kindOf(session), m ? `${m}m` : null];
  const base = parts.filter(Boolean).join(" ");
  return session.course ? `${base} ${session.course}コース` : base;
}

// そのセッションから metric の秒数を取り出す
function valueOf(session, metric) {
  const m = METRICS[metric];
  if (!m || !session) return null;
  if (m.from === "total") return num(session.total);
  const src = session[m.from];
  if (!src || typeof src !== "object") return null;
  return num(src[m.key]);
}

// ── 分布の中の順位（ここが判定の心臓） ──────────────────────

// 分布表 stats から「この秒数は上から何%か」を出す。0 に近いほど速い。
// 分布が無い / サンプルが足りない条件では null（＝分からない）を返す。
//
// 分布は「0.1秒ごとに何本あったか」の数え上げ（累積度数 cum）で持っている。
// だから順位は 数えた結果そのもの＝誤差ゼロ。
// （代表値を並べて間を線形で割る昔のやり方は、同じタイムが何千本もある所で
//   最大4.2ポイントもズレた。「上位3%」が本当は上位7%、という嘘になるのでやめた）
// 同じタイムが並ぶ時は その真ん中の順位で数える（統計のふつうのやり方）。
function percentileOf(stats, key, metric, value) {
  if (!stats || !stats.groups || key == null) return null;
  const g = stats.groups[key];
  if (!g || !g.metrics) return null;
  const m = g.metrics[metric];
  if (!m || !Array.isArray(m.cum) || !m.cum.length || !m.n) return null;
  const v = num(value);
  if (v == null) return null;

  const i = Math.round((v - m.min) / m.step);
  if (i < 0) return 0;
  if (i >= m.cum.length) return 100;
  const below = i > 0 ? m.cum[i - 1] : 0;   // これより速い本数
  const atOrBelow = m.cum[i];               // これ以下の本数
  const rank = below + (atOrBelow - below) / 2;
  return Math.round((100 * rank / m.n) * 100) / 100;
}

// 上位何% → 段階（速い/ふつう/遅い）。ここも秒数は見ない。
function tierOf(percent) {
  const p = num(percent);
  if (p == null) return null;
  for (const t of TIERS) {
    if (p <= t.maxPercent) return { tier: t.tier, label: t.label, rank: t.rank };
  }
  return { tier: "slow", label: "遅い", rank: 0 };
}

// 1つの metric を採点する。返り値には必ず「上位何%」を入れる。
function gradeMetric(stats, session, metric) {
  const value = valueOf(session, metric);
  if (value == null) return null;
  const key = groupKey(session);
  const g = stats && stats.groups ? stats.groups[key] : null;
  const percent = percentileOf(stats, key, metric, value);
  if (percent == null) {
    // 分布が無い＝くらべる相手がいない。秒数だけ返して判定はしない。
    return {
      metric,
      metricLabel: METRICS[metric] ? METRICS[metric].label : metric,
      seconds: value,
      percent: null,
      tier: null,
      label: null,
      text: `${value.toFixed(1)}秒（くらべる同じ条件のデータが足りない）`,
      sampleSize: g && g.metrics && g.metrics[metric] ? g.metrics[metric].n : 0,
      groupLabel: g ? g.label : null,
    };
  }
  const t = tierOf(percent);
  const m = g.metrics[metric];
  return {
    metric,
    metricLabel: METRICS[metric] ? METRICS[metric].label : metric,
    seconds: value,
    percent,                       // 上から何%（小さいほど速い）
    tier: t.tier,
    label: t.label,
    rank: t.rank,
    sampleSize: m.n,               // 何本の中でくらべたか
    groupLabel: g.label,           // 何とくらべたか（例:「栗東 坂路 800m」）
    text: `${value.toFixed(1)}秒・上位${percent.toFixed(1)}%（${g.label} ${m.n.toLocaleString("ja-JP")}本の中）`,
  };
}

// 1本の調教に点をつける（4ハロン・3ハロン・ラスト1ハロン と 全体）
function gradeSession(stats, session, raceDate) {
  if (!session) return null;
  const grades = {};
  for (const metric of Object.keys(METRICS)) {
    const g = gradeMetric(stats, session, metric);
    if (g) grades[metric] = g;
  }
  const key = groupKey(session);
  const grp = stats && stats.groups ? stats.groups[key] : null;
  const enough = !!(grp && grp.metrics && Object.keys(grp.metrics).length);

  return {
    date: session.date,
    dateLabel: formatDate(session.date),
    daysBefore: raceDate ? daysBetween(session.date, raceDate) : null,
    kind: kindOf(session),                                        // 坂路 / ウッド
    tresen: tresenOf(session),                                    // 美浦 / 栗東
    course: session.course || null,                               // ウッドの A〜E
    place: placeLabel(session),
    furlongs: session.furlongs || null,
    meters: metersOf(session),
    // 秒数（無い所は null。埋めない）
    total: num(session.total),
    f4: valueOf(session, "f4"),
    f3: valueOf(session, "f3"),
    f1: valueOf(session, "f1"),
    laps: session.lap || {},
    cum: session.cum || {},
    // 採点（分布の中の順位だけで決めたもの）
    grades,
    best: bestGrade(grades),
    graded: enough,
    gradeNote: enough ? null
      : "同じ条件（トレセン・コース・距離）のデータが少ないので、速い遅いの判定はしていない",
    // JRA-VAN に無いので必ず null（画面で「不明」と出すため）
    rider: null,
    style: null,
  };
}

// いちばん強く出ている評価（画面の色をどれか1つで決めたい時用）
function bestGrade(grades) {
  let best = null;
  for (const k of ["total", "f4", "f3", "f1"]) {
    const g = grades[k];
    if (!g || g.percent == null) continue;
    if (!best || g.percent < best.percent) best = g;
  }
  return best;
}

// ── 馬ごとの取り出し ──────────────────────────────────────

// ある馬の「その日より前」の調教を新しい順に
function sessionsForHorse(idx, opts) {
  const o = opts || {};
  const ketto = isKetto(String(o.ketto || "")) ? String(o.ketto) : null;
  if (!ketto || !idx || !idx.horses) return [];
  const all = idx.horses[ketto];
  if (!Array.isArray(all)) return [];
  const before = o.beforeDate ? String(o.beforeDate) : null;
  const limit = o.limit == null ? 6 : o.limit;
  const out = [];
  for (const s of all) {
    if (before && !(String(s.date) < before)) continue;   // 当日・未来は入れない
    out.push(s);
    if (limit > 0 && out.length >= limit) break;
  }
  return out;
}

// レース前 days 日のうち いちばん速かった1本（＝いわゆる「追い切り」）。
// 速さは 分布の中の順位でくらべる（秒数の生くらべだと 坂路とウッドを混ぜられない）。
function sharpestOf(gradedSessions, days) {
  let best = null;
  for (const s of (gradedSessions || [])) {
    if (s.daysBefore != null && (s.daysBefore < 0 || s.daysBefore > days)) continue;
    if (!s.best || s.best.percent == null) continue;
    if (!best || s.best.percent < best.best.percent) best = s;
  }
  return best;
}

// 直近 N 日で何本 追い切ったか（＝「本数」）
function countWithin(sessions, raceDate, days) {
  if (!raceDate || !Array.isArray(sessions)) return null;
  let n = 0;
  for (const s of sessions) {
    const d = daysBetween(s.date, raceDate);
    if (d != null && d >= 0 && d <= days) n++;
  }
  return n;
}

// ── 出走表の行を作る ──────────────────────────────────────

function rowsFromEntries(idx, entries, raceDate, opts) {
  const o = opts || {};
  const limit = o.limit == null ? 6 : o.limit;
  const stats = (idx && idx.stats) || null;
  const win = (idx && idx.window) || {};
  const rows = [];

  for (const e of (entries || [])) {
    const ketto = isKetto(String(e.ketto || e.ketto_num || "")) ? String(e.ketto || e.ketto_num) : null;
    const raw = ketto ? sessionsForHorse(idx, { ketto, beforeDate: raceDate, limit }) : [];
    // 本数は limit で切る前の全部から数えたいので、別に取り直す
    const rawAll = ketto ? sessionsForHorse(idx, { ketto, beforeDate: raceDate, limit: 0 }) : [];
    const sessions = raw.map((s) => gradeSession(stats, s, raceDate));

    let note = null;
    if (!ketto) {
      note = "血統登録番号が分からないので調教を引けない";
    } else if (rawAll.length === 0) {
      note = `調教データなし（この索引は ${formatDate(win.from) || "取り込みぶん"} 以降ぶんだけ・`
           + "地方所属や外国馬はトレセンで調教しないので元から入っていない）";
    }

    rows.push({
      number: e.number != null ? e.number : null,
      name: e.name || null,
      ketto_num: ketto,
      hasData: sessions.length > 0,
      note,                                    // 無いときの理由。そのまま画面に出せば正直
      counts: {                                // 「本数」
        d14: countWithin(rawAll, raceDate, 14),
        d30: countWithin(rawAll, raceDate, 30),
        d60: countWithin(rawAll, raceDate, 60),
      },
      latest: sessions.length ? sessions[0] : null,   // いちばん最近の1本
      // ★ふつう「追い切り」と呼ぶのはこちら★
      //  毎朝の稽古はほとんどが軽いキャンターで、直近の1本がそれだと調子が読めない。
      //  レース前 14日 の中でいちばん速かった1本＝勝負どころの追い切り。
      sharpest: sharpestOf(sessions, o.sharpDays == null ? 14 : o.sharpDays),
      sessions,                                        // 新しい順
    });
  }
  rows.sort((a, b) => (a.number || 99) - (b.number || 99));
  return rows;
}

// ★ 本命の入口 ★ レースIDを渡すと、その出走各馬の直近の追い切りを返す。
//   索引にそのレースが入っていなければ null（そのときは rowsForRace を使う）。
function rowsForRaceId(idx, raceId, opts) {
  if (!idx || !idx.races) return null;
  const r = idx.races[String(raceId)];
  if (!r) return null;
  return rowsFromEntries(idx, r.entries, r.date || raceDateOf(raceId), opts);
}

// レースJSON そのもの（data/jv_cache/races/<id>.json の中身、または当日の出走表）を渡す版。
// 索引に無い新しいレースでも使える。
function rowsForRace(idx, race, opts) {
  if (!race || !Array.isArray(race.horses)) return [];
  const date = raceDateOf(race.race_id) || (opts && opts.date) || null;
  const entries = race.horses.map((h) => ({
    number: h.number,
    name: h.name,
    ketto: h.ketto_num || h.ketto || null,
  }));
  return rowsFromEntries(idx, entries, date, opts);
}

// 1行を1文にする（画面に出す前の下ごしらえ。文言はここだけ直せばよい）
//
// ⚠ わざと latest ではなく sharpest（14日でいちばん速い1本＝追い切り）を主役にする。
//   毎朝の稽古はほとんどが軽いキャンターなので、直近の1本だと
//   「ラスト1ハロン19秒＝遅い」のような、調子と関係ない文が出てしまう。
function summaryOf(row) {
  if (!row) return null;
  if (!row.hasData) return row.note || "調教データなし";
  const s = row.sharpest || row.latest;
  const head = `${s.dateLabel} ${s.place}`;
  if (!s.graded || !s.best) return `${head} ${s.total != null ? s.total.toFixed(1) + "秒" : ""}（判定なし）`;
  const b = s.best;
  const ago = s.daysBefore != null ? `${s.daysBefore}日前 ` : "";
  return `${ago}${head} ${b.metricLabel} ${b.seconds.toFixed(1)}秒 = ${b.label}（上位${b.percent.toFixed(1)}%）`;
}

// 索引が「使える状態か」を確かめる。読めていないのに合格を出さないための入口チェック。
function health(idx) {
  const problems = [];
  if (!idx || typeof idx !== "object") return { ok: false, problems: ["索引が読めていない"] };
  if (!idx.horses || !Object.keys(idx.horses).length) problems.push("馬が1頭も入っていない");
  if (!idx.stats || !idx.stats.groups || !Object.keys(idx.stats.groups).length) problems.push("分布表が無い");
  let graded = 0;
  for (const g of Object.values((idx.stats && idx.stats.groups) || {})) {
    if (g.metrics && Object.keys(g.metrics).length) graded++;
  }
  if (!graded) problems.push("順位を出せる条件が1つも無い");
  return {
    ok: problems.length === 0,
    problems,
    horses: idx.horses ? Object.keys(idx.horses).length : 0,
    races: idx.races ? Object.keys(idx.races).length : 0,
    groups: Object.keys((idx.stats && idx.stats.groups) || {}).length,
    gradedGroups: graded,
    window: idx.window || null,
    notAvailable: idx.notAvailable || [],
  };
}

const _exports = {
  // 定数
  TIERS, METRICS, KIND_LABEL,
  // 道具
  isKetto, raceDateOf, formatDate, daysBetween, groupKey, placeLabel, valueOf,
  kindOf, tresenOf, metersOf,
  // 判定（分布の中の順位だけで決める）
  percentileOf, tierOf, gradeMetric, gradeSession, bestGrade,
  // 取り出し
  sessionsForHorse, sharpestOf, countWithin, rowsFromEntries, rowsForRaceId, rowsForRace,
  summaryOf, health,
};

if (typeof module !== "undefined" && module.exports) module.exports = _exports;
if (typeof window !== "undefined") window.Chokyo = _exports;
