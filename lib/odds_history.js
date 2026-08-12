"use strict";
// ============================================================
// odds_history.js — 「オッズが発走までどう動いたか」を系列にして、絵(SVG)にする
//
// ★なぜ作るか
//   このアプリは 2026-05-30 から「発走前の単勝オッズ」を貯め始めた
//   （data/jv_cache/signals/<raceId>.json ・2026-08-12 時点で 744 レース）。
//   ところが**それを見る手段が1つも無かった**。貯めているのに誰も見られない。
//   netkeiba 等では「オッズの時系列」だけで専門サイトが成り立つほど中核の機能。
//
//   さらに世界最大級の研究（Hanyu et al. 2025 / JRA-VAN 89万件）で
//   **発走直前5分のオッズ変化率**が単独の説明変数としていちばん強い（係数 -0.3386）。
//   🚨 ただし **-15〜-10分“だけ”を切り出すと符号が逆転する（+0.3674）**。
//   だから「直前5分」と「それより前」は絶対に混ぜない。
//   その切り分けは **すでに lib/late_move.js が持っている**ので、
//   このファイルは自分で計算し直さず **late_move を呼ぶ**（数字の出どころを1つにする）。
//
// ★このファイルがすること
//   1) buildOddsSeries()    … 生のスナップから「馬ごとの 時刻→単勝オッズ」の系列＋要約を作る（純関数）
//   2) readOddsHistory()    … レースIDからファイルを読んで 1) を呼ぶ（/api/odds-history 用）
//   3) buildOddsChartSvg()  … 1) の結果から SVG の文字列を組み立てる（純関数・外部ライブラリ ゼロ）
//
// ★このファイルがしないこと（正直に）
//   ・「買え／買うな」を決めない。数字と絵を作るだけ。
//   ・**無い数字を作らない**。オッズが取れていない時間は**線を切る**（つないで嘘の直線を描かない）。
//   ・発走時刻を決め打ちしない。必ず races/<raceId>.json の hassou_time（本物）を使う。
//
// ★使い方（親が API に繋ぐとき）
//   const OH = require("./odds_history");
//   const r = OH.readOddsHistory("202607260402020700");   // → JSON にして返す
//   const svg = OH.buildOddsChartSvg(r, { width: 390 });   // → そのまま HTML に埋められる文字列
// ============================================================

const fs = require("fs");
const path = require("path");
const LM = require("./late_move");

let RaceId = null;
try { RaceId = require("./race_id"); } catch (e) { RaceId = null; }

const SIGNALS_DIR = path.join(__dirname, "..", "data", "jv_cache", "signals");
const RACES_DIR = path.join(__dirname, "..", "data", "jv_cache", "races");

const MS_PER_MIN = 60000;

// ── 既定値 ────────────────────────────────────────────────
const DEFAULTS = {
  // 何分前から描くか。実測（645レース）＝オッズ取得はだいたい1時間おきで、
  // 前日の前売り（-800〜-1500分）と当日ぶんの間に **12時間以上の空白**が空く。
  // 全部を横軸に載せると当日の動きが画面の数%に潰れるので、既定は「直近8時間」。
  // 8時間なら当日ぶんはほぼ全部入る（実測：97%のレースで2点以上・中央値5点）。
  // 全部見たいときは windowMin: 0（= 制限なし）。
  windowMin: 480,
  // 濃く描く頭数（人気上位）。線が多すぎると読めない。
  topN: 6,
  // それに加えて「大きく動いた馬」を何頭まで足すか（上位人気に入っていなくても）。
  moversN: 2,
  // 「大きく動いた」と認める最低の変化率（0.15 = 15%）
  moverMinChange: 0.15,
  // これより長く間が空いたら線を切る（分）。ふつうの取得は60分おきなので 120 で切る。
  gapBreakMin: 120,
  // 直前◯分（研究どおり 5）。late_move に渡す。
  lateMinutes: 5,
  // 発走の◯分前を締切とみなす（0＝発走時刻ちょうどまで）
  cutoffMinutes: 0,
};

// ── 小道具 ────────────────────────────────────────────────
function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

// スナップ1枚の時刻。signals は ts（UTCのISO）。念のため fetchedAt も見る。
function snapMs(snap) {
  if (!snap || typeof snap !== "object") return null;
  return toMs(snap.ts) != null ? toMs(snap.ts) : toMs(snap.fetchedAt);
}

// epoch ms → 日本時間の "HH:MM"
function jstHHMM(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms + 9 * 60 * MS_PER_MIN);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mi}`;
}

// ── 1枚のスナップ → 「馬番 → 単勝オッズ」 ────────────────────
//   ⚠ 実データの落とし穴：同じ馬が何回も入っている壊れたスナップが 99 枚ある
//     （馬16頭のはずが160件＝10回ぶん重なっている。既知の SE 重複バグの名残）。
//     中身を全部数えたら「値がちがう重複」は 0 件で、必ず「null が並んだ最後に本物が1つ」だった。
//     → **最後に出てきた“ちゃんとした値”を採る**。これは late_move.priceMap と同じ振る舞い
//       （あちらも Map に set し続けるので後勝ち・1.0以下は捨てる）。数字の食い違いを作らない。
function oddsMapFromSnapshot(snap) {
  const out = new Map();
  const list = snap && Array.isArray(snap.horses) ? snap.horses : [];
  for (const h of list) {
    if (!h) continue;
    const n = Number(h.n);
    if (!Number.isFinite(n) || n <= 0) continue;
    const v = Number(h.o);
    // オッズ 1.0 以下は「まだ値が付いていない／欠測」。混ぜると変化率が壊れる。
    if (!Number.isFinite(v) || v <= 1.0) continue;
    const p = Number(h.p);
    out.set(n, { odds: v, popularity: Number.isFinite(p) && p > 0 ? p : null });
  }
  return out;
}

// ── signals の形 → late_move が読める形 に翻訳する（計算はしない）────
//   late_move は snap.odds.tansho.items[{key, odds}] を読む作り。
//   signals は horses[{n, o}] なので、ここで“通訳”だけする。
//   ⚠ これは late_move の作り直しではない。計算は必ず late_move にやらせる。
function toLateMoveSnapshots(signals) {
  const out = [];
  for (const s of (Array.isArray(signals) ? signals : [])) {
    const ms = snapMs(s);
    if (ms == null) continue;
    const m = oddsMapFromSnapshot(s);
    const items = [];
    for (const [n, v] of m) items.push({ key: String(n), number: n, odds: v.odds });
    out.push({
      fetchedAt: new Date(ms).toISOString(),
      odds: { tansho: { kind: "tansho", items } },
    });
  }
  out.sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
  return out;
}

// 発走時刻（本物）を作る。races/<raceId>.json の hassou_time を渡す。
function postTimeForRace(raceId, hassouHHMM) {
  return LM.postTimeFromHassou(String(raceId || ""), hassouHHMM);
}

// ============================================================
// 本体① 系列づくり（純関数）
// ============================================================
//  引数
//    raceId     … 18桁のレースID（表示用。無くてもよい）
//    snapshots  … signals/<raceId>.json の中身（配列）
//    postAt     … 発走時刻（epoch ms）。races の hassou_time から作る。null なら描けない。
//    horses     … races/<raceId>.json の horses（馬名・枠を出すため。無くてもよい）
//    windowMin / topN / moversN / gapBreakMin …（DEFAULTS 参照）
//
//  返り値の要点
//    horses[].points … その馬の「発走まで何分・オッズ」の並び（**オッズが有る時刻だけ**）
//    horses[].segments … 線を引くまとまり（**間が空いた所で切れている**）
//    summary.late     … late_move が出した「直前5分」の動き（研究のいちばん強い変数）
//    summary.movers   … 観測できた範囲での動き（⚠ 直前5分とは別物。混ぜない）
function buildOddsSeries(params) {
  const p = params || {};
  const o = Object.assign({}, DEFAULTS, p);
  const raceId = p.raceId != null ? String(p.raceId) : null;
  const postAt = toMs(p.postAt);
  const rawSnaps = Array.isArray(p.snapshots) ? p.snapshots : [];

  const base = {
    ok: false,
    reason: null,
    raceId,
    postAt,
    postTimeJst: postAt == null ? null : jstHHMM(postAt),
    label: raceId && RaceId && RaceId.labelOf ? RaceId.labelOf(raceId) : (raceId || ""),
    window: { minutes: null, fromMinutes: null, toMinutes: 0, hiddenBefore: null },
    counts: { snapshots: rawSnaps.length, withOdds: 0, prePost: 0, afterPost: 0, plotted: 0, horses: 0 },
    times: [],
    horses: [],
    summary: null,
    notes: [],
    options: {
      windowMin: o.windowMin, topN: o.topN, moversN: o.moversN,
      gapBreakMin: o.gapBreakMin, lateMinutes: o.lateMinutes, cutoffMinutes: o.cutoffMinutes,
    },
  };

  if (!rawSnaps.length) return Object.assign(base, { reason: "no_snapshots" });
  if (postAt == null) {
    // 発走時刻が分からない＝「発走まで何分」が作れない。横軸が作れないので描かない。
    // （ここで決め打ちの発走時刻を作ると、全部が静かにズレる）
    return Object.assign(base, { reason: "post_time_unknown" });
  }

  // ── 時刻つきに整えて、古い順に並べる ─────────────────────
  const rows = [];
  for (const s of rawSnaps) {
    const ms = snapMs(s);
    if (ms == null) continue;
    const m = (ms - postAt) / MS_PER_MIN; // マイナス＝発走前
    const map = oddsMapFromSnapshot(s);
    rows.push({ ms, minutesToPost: m, map, going: s ? s.go : null, weather: s ? s.we : null });
  }
  rows.sort((a, b) => a.ms - b.ms);

  const withOdds = rows.filter(r => r.map.size > 0);
  base.counts.withOdds = withOdds.length;
  const prePost = withOdds.filter(r => r.minutesToPost < -Math.abs(o.cutoffMinutes || 0));
  base.counts.prePost = prePost.length;
  base.counts.afterPost = withOdds.length - prePost.length;

  if (prePost.length === 0) return Object.assign(base, { reason: "no_odds_before_post" });

  // ── 表示する時間の幅を決める ────────────────────────────
  //   既定は「直近8時間」。そこに2点も無いときだけ全部にひろげる（正直に notes に書く）。
  const earliest = prePost[0].minutesToPost;
  let winMin = Number(o.windowMin);
  if (!Number.isFinite(winMin) || winMin <= 0) winMin = Math.ceil(-earliest) + 1; // 0 = 制限なし
  let shown = prePost.filter(r => r.minutesToPost >= -winMin);
  if (shown.length < 2) {
    shown = prePost.slice();
    winMin = Math.ceil(-earliest) + 1;
    base.notes.push("直近の時間の中に2枚も無かったので、取れている全部を表示しています。");
  }
  const hiddenCount = prePost.length - shown.length;
  base.window.minutes = winMin;
  base.window.fromMinutes = shown.length ? shown[0].minutesToPost : null;
  base.window.toMinutes = 0;
  if (hiddenCount > 0) {
    base.window.hiddenBefore = { count: hiddenCount, earliestMinutes: earliest };
    base.notes.push(
      `これより前（前日の前売りなど）に ${hiddenCount} 枚のオッズがあります` +
      `（いちばん古いのは発走の ${Math.round(-earliest / 60)} 時間前）。` +
      `表示は直近 ${Math.round(winMin / 60)} 時間ぶんです。`
    );
  }
  base.counts.plotted = shown.length;
  base.times = shown.map(r => ({
    ms: r.ms, minutesToPost: r.minutesToPost, iso: new Date(r.ms).toISOString(), jst: jstHHMM(r.ms),
  }));

  // ── 馬ごとの系列を組む ──────────────────────────────────
  const nameByNumber = new Map();
  const frameByNumber = new Map();
  for (const h of (Array.isArray(p.horses) ? p.horses : [])) {
    if (!h) continue;
    const n = Number(h.number != null ? h.number : h.n);
    if (!Number.isFinite(n)) continue;
    if (!nameByNumber.has(n) && h.name) nameByNumber.set(n, String(h.name));
    if (!frameByNumber.has(n) && h.frame != null) frameByNumber.set(n, Number(h.frame));
  }

  const numbers = new Set();
  for (const r of shown) for (const n of r.map.keys()) numbers.add(n);
  const sortedNumbers = [...numbers].sort((a, b) => a - b);
  base.counts.horses = sortedNumbers.length;

  const horses = [];
  for (const n of sortedNumbers) {
    const points = [];
    for (const r of shown) {
      const v = r.map.get(n);
      if (!v) continue; // ⚠ 無い時刻は入れない＝あとで線が切れる（作り話をしない）
      points.push({ ms: r.ms, minutesToPost: r.minutesToPost, odds: v.odds, popularity: v.popularity });
    }
    if (!points.length) continue;
    const first = points[0], last = points[points.length - 1];
    const changeRate = (last.odds - first.odds) / first.odds;
    horses.push({
      number: n,
      name: nameByNumber.get(n) || null,
      frame: frameByNumber.has(n) ? frameByNumber.get(n) : null,
      points,
      segments: splitSegments(points, o.gapBreakMin),
      first: { minutesToPost: first.minutesToPost, odds: first.odds, popularity: first.popularity },
      last: { minutesToPost: last.minutesToPost, odds: last.odds, popularity: last.popularity },
      changeRateObserved: changeRate,
      logChangeObserved: Math.log(last.odds / first.odds),
      popularityFirst: first.popularity,
      popularityLast: last.popularity,
      popularityDelta: (first.popularity != null && last.popularity != null)
        ? (first.popularity - last.popularity) // プラス＝人気が上がった（順位の数字が小さくなった）
        : null,
      missingCount: shown.length - points.length,
      highlight: false,
      colorSlot: null,
    });
  }

  if (!horses.length) return Object.assign(base, { reason: "no_odds_before_post" });
  base.horses = horses;

  // ── どの馬を濃く描くか ──────────────────────────────────
  //   ①最後に人気だった上位 topN 頭（＝みんなが見る馬）
  //   ②それに入っていなくても大きく動いた馬を moversN 頭まで
  const byPop = horses.slice().sort((a, b) => {
    const pa = a.popularityLast == null ? 999 : a.popularityLast;
    const pb = b.popularityLast == null ? 999 : b.popularityLast;
    if (pa !== pb) return pa - pb;
    return a.last.odds - b.last.odds;
  });
  const pick = new Set(byPop.slice(0, Math.max(0, o.topN)).map(h => h.number));
  const movers = horses.slice()
    .filter(h => Math.abs(h.changeRateObserved) >= o.moverMinChange && !pick.has(h.number))
    .sort((a, b) => Math.abs(b.changeRateObserved) - Math.abs(a.changeRateObserved))
    .slice(0, Math.max(0, o.moversN));
  for (const h of movers) pick.add(h.number);

  // 色の枠は 8 個まで（9色目を作らない＝色覚のちがう人に見分けられなくなるため）
  const highlighted = horses.filter(h => pick.has(h.number)).slice(0, 8);
  highlighted.forEach((h, i) => { h.highlight = true; h.colorSlot = i; h.isMover = movers.indexOf(h) >= 0; });

  // ── 要約 ────────────────────────────────────────────────
  const lmSnaps = toLateMoveSnapshots(rawSnaps);
  const lm = LM.computeLateMove({
    snapshots: lmSnaps, postAt, kind: "tansho",
    lateMinutes: o.lateMinutes, cutoffMinutes: o.cutoffMinutes,
  });
  const lastPre = LM.pickLastPrePost(lmSnaps, postAt, { cutoffMinutes: o.cutoffMinutes });

  const sortedByChange = horses.slice().sort((a, b) => a.changeRateObserved - b.changeRateObserved);
  const popMoves = horses
    .filter(h => h.popularityDelta != null && h.popularityDelta !== 0)
    .map(h => ({
      number: h.number, name: h.name,
      from: h.popularityFirst, to: h.popularityLast, delta: h.popularityDelta,
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  base.summary = {
    // 研究のいちばん強い変数。ここは late_move の答えをそのまま出す（作り直さない）。
    late: packWindow(lm.late, o.lateMinutes),
    early: packWindow(lm.early),
    mid1510: packWindow(lm.mid1510),
    lateOk: !!(lm.late && lm.late.ok),
    lateReason: lm.late ? lm.late.reason : "unknown",
    lastPrePost: lastPre ? {
      minutesToPost: lastPre.minutesToPost,
      jst: jstHHMM(lastPre.ms),
      postTimeKnown: lastPre.postTimeKnown !== false,
    } : null,
    // ⚠ ここから下は「観測できた範囲（表示している時間）での動き」＝直前5分とは別物。
    observed: {
      fromMinutes: base.window.fromMinutes,
      toMinutes: shown.length ? shown[shown.length - 1].minutesToPost : null,
      biggestDrop: sortedByChange.length ? briefMove(sortedByChange[0]) : null,
      biggestRise: sortedByChange.length ? briefMove(sortedByChange[sortedByChange.length - 1]) : null,
    },
    popularityMoves: popMoves,
  };

  // ── 正直な注記 ──────────────────────────────────────────
  if (!base.summary.lateOk) {
    base.notes.push(lateReasonJa(base.summary.lateReason, o.lateMinutes));
  }
  if (horses.some(h => h.missingCount > 0)) {
    base.notes.push("オッズが取れていない時刻がある馬は、そこで線を切っています（つないだ直線は描きません）。");
  }
  if (shown.length < 3) {
    base.notes.push("オッズの点が少ないので、動きの向きは参考程度に見てください。");
  }

  base.ok = shown.length >= 2;
  if (!base.ok) base.reason = "not_enough_points";
  return base;
}

// 点の並びを「間が空いた所」で切る。空いた所をつなぐと嘘の直線になる。
function splitSegments(points, gapBreakMin) {
  const gap = Number.isFinite(gapBreakMin) && gapBreakMin > 0 ? gapBreakMin : Infinity;
  const segs = [];
  let cur = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && (points[i].minutesToPost - points[i - 1].minutesToPost) > gap) {
      if (cur.length) segs.push(cur);
      cur = [];
    }
    cur.push(points[i]);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

function briefMove(h) {
  return {
    number: h.number, name: h.name,
    from: h.first.odds, to: h.last.odds,
    changeRate: h.changeRateObserved,
  };
}

// late_move の窓の結果を、馬番（数字）キーに直して持ち直す
function packWindow(w, lateMinutes) {
  if (!w) return { ok: false, reason: "not_computed", byNumber: {}, from: null, to: null, summary: null };
  const byNumber = {};
  for (const k of Object.keys(w.byKey || {})) {
    const n = Number(k);
    if (!Number.isFinite(n)) continue;
    byNumber[n] = w.byKey[k];
  }
  return {
    ok: !!w.ok,
    reason: w.reason || null,
    lateMinutes: lateMinutes != null ? lateMinutes : undefined,
    from: w.from || null,
    to: w.to || null,
    spanMin: w.spanMin != null ? w.spanMin : null,
    byNumber,
    summary: w.summary || null,
  };
}

function lateReasonJa(reason, lateMinutes) {
  const m = lateMinutes || 5;
  switch (reason) {
    case "no_snapshot_inside_late_window":
      return `発走${m}分前より内側のオッズは、このレースでは取れていません（＝研究でいちばん強い「直前${m}分の動き」は出せません）。`;
    case "anchor_too_old":
      return `直前${m}分の起点にできるオッズが古すぎます（早い時間の動きが混ざるので、直前${m}分としては出しません）。`;
    case "no_anchor_before_late_window":
      return `発走${m}分前より古いオッズが無いので、直前${m}分の動きは出せません。`;
    case "not_enough_snapshots":
      return "オッズの枚数が足りないので、直前の動きは出せません。";
    case "no_common_keys":
      return "前と後で同じ馬のオッズがそろわないので、直前の動きは出せません。";
    case "no_pre_post_snapshot":
      return "発走前のオッズが1枚もありません。";
    case "post_time_unknown":
      return "発走時刻が分からないので、直前の動きは出せません。";
    default:
      return "直前の動きは出せませんでした。";
  }
}

// ============================================================
// 本体② 読み取り（/api/odds-history?raceId=… 用）
// ============================================================
//  ⚠ ここだけファイルを読む（上の buildOddsSeries は純関数のまま）。
//  返り値はそのまま JSON にして返せる形。描く材料が無いときも
//  ok:false と reason を返す（黙って空を返さない）。
function readOddsHistory(raceId, opts) {
  const id = String(raceId == null ? "" : raceId).trim();
  // ⚠ API から来る値は文字列（?windowMin=120）。数でないものが混ざると
  //    slice(0, NaN) で「濃い線が1本も無いグラフ」になるので、ここで必ず数に直す。
  const o = Object.assign({}, DEFAULTS, numify(opts));
  const bad = (reason, extra) => Object.assign({
    ok: false, reason, raceId: id || null, postAt: null, horses: [], times: [],
    counts: { snapshots: 0, withOdds: 0, prePost: 0, afterPost: 0, plotted: 0, horses: 0 },
    summary: null, notes: [],
  }, extra || {});

  if (!id) return bad("no_race_id");
  // 18桁の JRA のレースID以外は受け付けない（変な文字でファイルを探しに行かせない）
  const looksJra = RaceId && RaceId.isJraRaceId ? RaceId.isJraRaceId(id) : /^\d{18}$/.test(id);
  if (!looksJra) return bad("bad_race_id");

  let signals = null;
  try {
    signals = JSON.parse(fs.readFileSync(path.join(SIGNALS_DIR, id + ".json"), "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return bad("no_signals_file");
    return bad("signals_read_failed", { error: String(e && e.message || e) });
  }
  if (!Array.isArray(signals)) return bad("signals_broken");

  let race = null;
  try {
    race = JSON.parse(fs.readFileSync(path.join(RACES_DIR, id + ".json"), "utf8"));
  } catch (e) {
    race = null; // 出走表が無くても、発走時刻さえ分かれば描ける…が、発走時刻はここにしか無い
  }

  // 🚨 発走時刻は races/*.json の hassou_time が本物。決め打ちしない。
  const postAt = race ? postTimeForRace(id, race.hassou_time) : null;

  const built = buildOddsSeries({
    raceId: id,
    snapshots: signals,
    postAt,
    horses: race && Array.isArray(race.horses) ? race.horses : [],
    windowMin: o.windowMin, topN: o.topN, moversN: o.moversN,
    moverMinChange: o.moverMinChange, gapBreakMin: o.gapBreakMin,
    lateMinutes: o.lateMinutes, cutoffMinutes: o.cutoffMinutes,
  });

  // 画面に出すときのタイトル材料（出走表があるときだけ）
  built.race = race ? {
    raceId: id,
    raceName: race.race_name || null,
    course: race.course || null,
    surface: race.surface || null,
    distance: race.distance || null,
    hassouTime: race.hassou_time || null,
    going: race.going || null,
    weather: race.weather || null,
  } : null;
  if (!race) built.notes.push("出走表（races/*.json）が見つからないので、馬名と発走時刻は出せません。");
  return built;
}

// 文字で来た数を数に直す（数にならないものは既定にまかせる＝捨てる）
function numify(opts) {
  const src = opts || {};
  const out = {};
  const NUM = ["windowMin", "topN", "moversN", "moverMinChange", "gapBreakMin", "lateMinutes", "cutoffMinutes"];
  for (const k of Object.keys(src)) {
    if (NUM.indexOf(k) < 0) { out[k] = src[k]; continue; }
    const v = Number(src[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

// 履歴が在るレースID一覧（親が「どのレースを描けるか」を出すとき用）
function listRacesWithHistory(opts) {
  const o = opts || {};
  let files = [];
  try {
    files = fs.readdirSync(SIGNALS_DIR).filter(f => /^\d{18}\.json$/.test(f));
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("[odds_history] readdir failed:", e.message);
    return [];
  }
  let ids = files.map(f => f.slice(0, 18)).sort();
  if (o.date) ids = ids.filter(id => id.slice(0, 8) === String(o.date));
  if (o.limit > 0) ids = ids.slice(-o.limit);
  return ids;
}

// ============================================================
// 本体③ 絵にする（純関数・外部ライブラリ ゼロ・SVG の文字列を返す）
// ============================================================
//
// ★縦軸を「対数（log）」にする理由 — 見た目の好みではなく、中身の都合
//   ①実データのオッズは **1.1倍 〜 915.2倍**（744レース・64,310点の実測）＝3桁ちがう。
//     ふつうの目盛だと、1.5〜10倍の人気馬が全部いちばん下に潰れて動きが見えない。
//   ②研究が見ているのは **変化“率”**（(後-前)/前）。対数だと
//     「20%下がった」が 2.0→1.6 でも 100→80 でも **同じ高さの落ち方**に見える。
//     ＝この絵で目に見える傾きが、そのまま late_move の測っている量になる。
//   （オッズが全部10倍以内の狭いレースでは log でも lin でも見た目はほぼ同じ）
//
// ★横軸は「発走まで何分」。右端が発走（0分）。
//   発走5分前から右を **薄く塗って「ここから先が本番」** と分かるようにする。
//
// opts: { width, height, title, showLegend, maxLegend, surface, lang }
function buildOddsChartSvg(series, opts) {
  const o = Object.assign({
    width: 390,
    plotHeight: 168,
    showLegend: true,
    maxLegend: 8,
    title: null,
    subtitle: null,
  }, opts || {});

  const W = Math.max(280, Math.round(Number(o.width) || 390));
  const C = {
    surface: "#FFFDF6",   // 白いカード面（アプリと同じ）
    ink: "#463527",       // 見出しの墨
    ink2: "#5F4A38",      // 本文
    mute: "#77604A",      // 補足（白カード上 5.8:1）
    grid: "#EADFCB",      // 罫線＝地色から一段だけ落とした色（細い実線・点線にしない）
    axis: "#D8C8AE",
    faint: "#C3B49C",     // 目立たせない馬の線
    zone: "#F3E7D2",      // 発走5分前からの帯
    // ── 系列の色（dataviz の検証ずみパレット）─────────────────
    //   `validate_palette.js "…" --mode light --surface #FFFDF6` で
    //   明るさ・彩度・色覚のちがう人の見分け・ふつうの目の見分け すべて PASS。
    //   （明るい3色は白地でコントラストが 3:1 未満なので、
    //     線の端に **馬番の札** と 下の一覧を必ず出す＝色だけに頼らない）
    series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  };
  const FONT = "system-ui,-apple-system,'Hiragino Sans','Noto Sans JP','Yu Gothic',sans-serif";

  // 描けないときは「描けません」と正直に出す（空の絵を返さない）
  if (!series || !series.ok) {
    const why = series ? (series.reason || "unknown") : "no_data";
    return emptyCard(W, C, FONT, noDataJa(why), series && series.notes ? series.notes : []);
  }

  const highlighted = series.horses.filter(h => h.highlight);
  const others = series.horses.filter(h => !h.highlight);

  // ── 枠 ────────────────────────────────────────────────
  const padL = 40, padR = 30, padT = 34, padB = 46;
  const plotH = Math.max(110, Math.round(Number(o.plotHeight) || 168));
  const plotW = W - padL - padR;
  const legendRows = o.showLegend ? Math.min(highlighted.length, o.maxLegend) : 0;
  const legendH = legendRows ? (legendRows * 19 + 10) : 0;
  const notes = (series.notes || []).slice(0, 3);
  const noteLines = [];
  for (const n of notes) noteLines.push(...wrapJa(n, Math.floor((W - 16) / 12)));
  const noteH = noteLines.length ? (noteLines.length * 15 + 6) : 0;
  const H = padT + plotH + padB + legendH + noteH;

  // ── ものさし ──────────────────────────────────────────
  const xMin = Math.min(series.window.fromMinutes, -1);
  const xMax = 0;
  const xOf = (m) => padL + ((clamp(m, xMin, xMax) - xMin) / (xMax - xMin)) * plotW;

  let lo = Infinity, hi = -Infinity;
  for (const h of series.horses) for (const pt of h.points) { if (pt.odds < lo) lo = pt.odds; if (pt.odds > hi) hi = pt.odds; }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return emptyCard(W, C, FONT, "オッズがありません", []);
  const yLo = Math.max(1.0, lo / 1.15);
  const yHi = hi * 1.15;
  const l0 = Math.log10(yLo), l1 = Math.log10(yHi);
  const yOf = (v) => padT + ((l1 - Math.log10(clamp(v, yLo, yHi))) / (l1 - l0 || 1)) * plotH;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" font-family="${FONT}">`);
  parts.push(`<title>${esc(o.title || series.label || "オッズの動き")}</title>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${C.surface}"/>`);

  // ── 見出し ────────────────────────────────────────────
  const title = o.title || [series.label, series.race && series.race.raceName ? series.race.raceName : ""].filter(Boolean).join(" ");
  parts.push(`<text x="12" y="16" font-size="13" font-weight="600" fill="${C.ink}">${esc(cut(title, Math.floor((W - 24) / 13)))}</text>`);
  const sub = o.subtitle != null ? o.subtitle
    : `単勝オッズの動き（発走 ${series.postTimeJst || "--:--"}・縦は対数めもり）`;
  parts.push(`<text x="12" y="29" font-size="12" fill="${C.mute}">${esc(cut(sub, Math.floor((W - 24) / 12)))}</text>`);

  // ── 発走5分前からの帯（＝ここから先が本番）───────────────
  const lateM = -(series.options && series.options.lateMinutes ? series.options.lateMinutes : 5);
  const zoneX = xOf(lateM);
  if (zoneX < padL + plotW) {
    parts.push(`<rect x="${r1(zoneX)}" y="${padT}" width="${r1(padL + plotW - zoneX)}" height="${plotH}" fill="${C.zone}"/>`);
  }

  // ── 横の罫線（オッズ）＋ 目盛の数字 ──────────────────────
  for (const t of oddsTicks(yLo, yHi)) {
    const y = r1(yOf(t));
    parts.push(`<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="${C.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 6}" y="${y + 4}" font-size="12" text-anchor="end" fill="${C.mute}">${esc(fmtOddsTick(t))}</text>`);
  }
  // 縦線（発走5分前）— これは「しきい」なので、罫線と区別できるよう破線にする
  if (zoneX > padL && zoneX < padL + plotW) {
    parts.push(`<line x1="${r1(zoneX)}" y1="${padT}" x2="${r1(zoneX)}" y2="${padT + plotH}" stroke="${C.axis}" stroke-width="1" stroke-dasharray="3 3"/>`);
  }
  // 発走の線（右端）
  parts.push(`<line x1="${padL + plotW}" y1="${padT}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="${C.axis}" stroke-width="1"/>`);
  parts.push(`<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="${C.axis}" stroke-width="1"/>`);

  // ── 横の目盛（発走まで何分）────────────────────────────
  for (const t of timeTicks(xMin, plotW)) {
    const x = xOf(t.m);
    if (x < padL - 2 || x > padL + plotW + 2) continue;
    parts.push(`<text x="${r1(x)}" y="${padT + plotH + 15}" font-size="12" text-anchor="${t.m === 0 ? "end" : "middle"}" fill="${C.mute}">${esc(t.label)}</text>`);
  }
  // 「ここから先が本番」の説明（帯はレースによっては数pxしか無いので、必ず言葉で出す）
  //   1時間おきの取得だと -5分〜0分は横幅の1%しか無い。細いことを隠さず、
  //   「その帯の中に点が有るのか無いのか」まで書く。
  {
    const inZone = series.times.filter(t => t.minutesToPost > lateM).length;
    const zoneNote = inZone > 0
      ? `▐ 帯＝発走${-lateM}分前から（ここが本番）・この中のオッズ ${inZone}枚`
      : `▐ 帯＝発走${-lateM}分前から（ここが本番）・この中のオッズは無し`;
    parts.push(`<rect x="12" y="${padT + plotH + 22}" width="8" height="10" fill="${C.zone}" stroke="${C.axis}" stroke-width="1"/>`);
    parts.push(`<text x="24" y="${padT + plotH + 31}" font-size="12" fill="${C.mute}">${esc(cutJa(zoneNote.replace("▐ ", ""), Math.floor((W - 36) / 12)))}</text>`);
  }

  // ── 目立たせない馬（薄い線）──────────────────────────
  for (const h of others) {
    for (const seg of h.segments) {
      if (seg.length < 2) continue;
      parts.push(`<path d="${pathOf(seg, xOf, yOf)}" fill="none" stroke="${C.faint}" stroke-width="1.5" stroke-opacity="0.55" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
  }

  // ── 濃く描く馬 ────────────────────────────────────────
  for (const h of highlighted) {
    const col = C.series[h.colorSlot % C.series.length];
    const tip = `${h.number}番 ${h.name || ""} ${fmtOdds(h.first.odds)}倍 → ${fmtOdds(h.last.odds)}倍 (${fmtPct(h.changeRateObserved)})`;
    parts.push(`<g><title>${esc(tip)}</title>`);
    for (const seg of h.segments) {
      if (seg.length >= 2) {
        parts.push(`<path d="${pathOf(seg, xOf, yOf)}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      } else {
        // 点が1つだけの区間は「点」として置く（線でつながない）
        parts.push(`<circle cx="${r1(xOf(seg[0].minutesToPost))}" cy="${r1(yOf(seg[0].odds))}" r="2.5" fill="${col}"/>`);
      }
    }
    // 最後の点（8px の丸・地色の輪でまわりと分ける）
    const last = h.points[h.points.length - 1];
    parts.push(`<circle cx="${r1(xOf(last.minutesToPost))}" cy="${r1(yOf(last.odds))}" r="4" fill="${col}" stroke="${C.surface}" stroke-width="2"/>`);
    parts.push(`</g>`);
  }

  // ── 線の端に「馬番の札」（色だけに頼らないための直接ラベル）──
  //   札は**グラフの外（右の余白）**に縦に並べる。中に置くと線の端の丸と重なって
  //   どの札がどの線か分からなくなる（実際にそうなった）。
  //   札と線の端が離れたときは、細い引き出し線でつなぐ。
  const chips = highlighted.map(h => {
    const lastPt = h.points[h.points.length - 1];
    return { h, ex: xOf(lastPt.minutesToPost), ey: yOf(lastPt.odds), y: yOf(lastPt.odds) };
  }).sort((a, b) => a.y - b.y);
  deCollide(chips, 15, padT + 7, padT + plotH - 7);
  const chipX = padL + plotW + 4;
  for (const c of chips) {
    const col = C.series[c.h.colorSlot % C.series.length];
    const w = String(c.h.number).length >= 2 ? 22 : 17;
    if (Math.abs(c.y - c.ey) > 2 || c.ex < padL + plotW - 6) {
      parts.push(`<path d="M${r1(c.ex + 4)} ${r1(c.ey)} L${r1(chipX - 2)} ${r1(c.y)}" fill="none" stroke="${col}" stroke-width="1" stroke-opacity="0.5"/>`);
    }
    parts.push(`<rect x="${r1(chipX)}" y="${r1(c.y - 7)}" width="${w}" height="14" rx="4" fill="${col}"/>`);
    parts.push(`<text x="${r1(chipX + w / 2)}" y="${r1(c.y + 4)}" font-size="12" font-weight="700" text-anchor="middle" fill="${chipInk(col)}">${c.h.number}</text>`);
  }

  // ── 下の一覧（＝色が薄い馬でも必ず読める・表のかわり）──────
  let y = padT + plotH + padB;
  if (legendRows) {
    for (let i = 0; i < legendRows; i++) {
      const h = highlighted[i];
      const col = C.series[h.colorSlot % C.series.length];
      const rowY = y + i * 19;
      parts.push(`<rect x="12" y="${rowY - 8}" width="12" height="3" rx="1.5" fill="${col}"/>`);
      const nm = `${h.number} ${h.name || ""}`.trim();
      const move = `${fmtOdds(h.first.odds)}→${fmtOdds(h.last.odds)}`;
      const pct = fmtPct(h.changeRateObserved);
      const pctW = 46, moveW = 78;
      const nameMax = Math.max(3, Math.floor((W - 30 - pctW - moveW - 16) / 12));
      parts.push(`<text x="30" y="${rowY}" font-size="12" fill="${C.ink2}">${esc(cutJa(nm, nameMax))}</text>`);
      parts.push(`<text x="${W - 12 - pctW}" y="${rowY}" font-size="12" text-anchor="end" fill="${C.mute}">${esc(move)}</text>`);
      // ⚠ ここは色を付けない。オッズが下がった＝お金が入った、は「良い/悪い」ではなく
      //    ただの向き。緑にすると「当たり色」に見えて“買え”と言っているように読める。
      //    向きは + と − の符号だけで伝える。
      parts.push(`<text x="${W - 12}" y="${rowY}" font-size="12" text-anchor="end" fill="${C.ink2}">${esc(pct)}</text>`);
    }
    y += legendRows * 19 + 10;
  }

  // ── 正直な注記 ────────────────────────────────────────
  for (let i = 0; i < noteLines.length; i++) {
    parts.push(`<text x="12" y="${y + 4 + i * 15}" font-size="12" fill="${C.mute}">${esc(noteLines[i])}</text>`);
  }

  parts.push("</svg>");
  return parts.join("");
}

// ── SVG の小道具 ──────────────────────────────────────────
function pathOf(points, xOf, yOf) {
  let d = "";
  for (let i = 0; i < points.length; i++) {
    d += (i === 0 ? "M" : "L") + r1(xOf(points[i].minutesToPost)) + " " + r1(yOf(points[i].odds));
    if (i < points.length - 1) d += " ";
  }
  return d;
}
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function r1(v) { return Math.round(v * 10) / 10; }

// 札が重ならないように上下へ逃がす（線から離れすぎない範囲で）
function deCollide(items, minGap, top, bottom) {
  for (let i = 1; i < items.length; i++) {
    if (items[i].y - items[i - 1].y < minGap) items[i].y = items[i - 1].y + minGap;
  }
  const over = items.length ? items[items.length - 1].y - bottom : 0;
  if (over > 0) for (const it of items) it.y -= over;
  for (const it of items) it.y = clamp(it.y, top, bottom);
}

// 濃い色の上は白、明るい色の上は墨（札の中の数字が必ず読めるように）
function chipInk(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.45 ? "#2B2013" : "#ffffff";
}

// オッズの目盛（1.5 / 2 / 3 / 5 / 10 …）— 対数めもりに合う段
const ODDS_LADDER = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150, 200, 300, 500, 1000];
function oddsTicks(lo, hi) {
  let t = ODDS_LADDER.filter(v => v >= lo && v <= hi);
  if (t.length < 2) t = [lo, hi];
  while (t.length > 7) t = t.filter((_, i) => i % 2 === 0 || i === t.length - 1);
  return t;
}
function fmtOddsTick(v) { return v >= 100 ? String(Math.round(v)) : (v >= 10 ? String(Math.round(v)) : String(v)); }
// 単勝オッズの書き方は JRA と同じで 小数1桁（100倍以上は整数）
function fmtOdds(v) { return v >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1); }
function fmtPct(r) {
  if (!Number.isFinite(r)) return "—";
  const p = Math.round(r * 100);
  return (p > 0 ? "+" : "") + p + "%";
}

// 横の目盛（発走まで何分）
//   ⚠ 目盛の間隔は「時間の長さ」だけで決めてはいけない。
//     30時間ぶんを描くと 3時間おきでも 11個並び、「30時間前」の文字どうしが重なって読めない
//     （実際に一度そうなった）。**横幅を見て、入る個数まで間引く**。
function timeTicks(xMin, plotW) {
  const span = Math.max(1, -xMin);
  const w = Number.isFinite(plotW) && plotW > 0 ? plotW : 320;
  const maxTicks = Math.max(2, Math.floor(w / 66)); // 1目盛あたり最低66px（「30時間前」が入る幅）
  const LADDER = [5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 2880];
  let stepMin = LADDER[LADDER.length - 1];
  for (const s of LADDER) { if (span / s <= maxTicks) { stepMin = s; break; } }
  const out = [{ m: 0, label: "発走" }];
  for (let m = stepMin; m <= span; m += stepMin) {
    out.push({ m: -m, label: m % 60 === 0 ? `${m / 60}時間前` : `${m}分前` });
  }
  return out;
}

function noDataJa(reason) {
  switch (reason) {
    case "no_snapshots": return "このレースのオッズの記録がありません。";
    case "no_signals_file": return "このレースのオッズの記録がありません。";
    case "signals_broken": return "オッズの記録ファイルが読めませんでした。";
    case "post_time_unknown": return "発走時刻が分からないので、動きを描けません。";
    case "no_odds_before_post": return "発走前のオッズが記録されていません。";
    case "not_enough_points": return "オッズの記録が1枚しかないので、動きを描けません。";
    case "bad_race_id": return "レース番号の形がちがいます。";
    case "no_race_id": return "レース番号がありません。";
    default: return "オッズの動きを描けませんでした。";
  }
}

function emptyCard(W, C, FONT, msg, notes) {
  const lines = wrapJa(msg, Math.floor((W - 24) / 13));
  const nl = [];
  for (const n of (notes || []).slice(0, 2)) nl.push(...wrapJa(n, Math.floor((W - 24) / 12)));
  const H = 28 + lines.length * 19 + (nl.length ? nl.length * 15 + 6 : 0) + 14;
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" font-family="${FONT}">`];
  p.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${C.surface}"/>`);
  lines.forEach((t, i) => p.push(`<text x="12" y="${26 + i * 19}" font-size="13" fill="${C.ink}">${esc(t)}</text>`));
  nl.forEach((t, i) => p.push(`<text x="12" y="${26 + lines.length * 19 + 12 + i * 15}" font-size="12" fill="${C.mute}">${esc(t)}</text>`));
  p.push("</svg>");
  return p.join("");
}

// ── 文字の小道具（日本語の幅をざっくり見て切る・折る）──────────
function chWidth(ch) { return /[\x00-\x7F｡-ﾟ]/.test(ch) ? 0.55 : 1; }
function cutJa(s, maxCells) {
  const str = String(s == null ? "" : s);
  let w = 0, out = "";
  for (const ch of str) {
    const cw = chWidth(ch);
    if (w + cw > maxCells) return out + "…";
    w += cw; out += ch;
  }
  return out;
}
function cut(s, maxCells) { return cutJa(s, maxCells); }
function wrapJa(s, maxCells) {
  const str = String(s == null ? "" : s);
  const lines = [];
  let w = 0, cur = "";
  for (const ch of str) {
    const cw = chWidth(ch);
    if (w + cw > maxCells && cur) { lines.push(cur); cur = ""; w = 0; }
    cur += ch; w += cw;
  }
  if (cur) lines.push(cur);
  return lines;
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

module.exports = {
  DEFAULTS,
  SIGNALS_DIR,
  RACES_DIR,
  // 純関数
  oddsMapFromSnapshot,
  toLateMoveSnapshots,
  postTimeForRace,
  buildOddsSeries,
  splitSegments,
  buildOddsChartSvg,
  // ファイルを読む（API 用）
  readOddsHistory,
  listRacesWithHistory,
};
