"use strict";
// ============================================================
// late_move.js — 「発走 直前5分の オッズの動き」を測る（純関数だけ・画面は触らない）
//
// ★なぜ作るか
//   世界最大級の研究（Hanyu et al. 2025 / JRA-VAN 89万件 / 2004-2023）で、
//   **発走直前5分のオッズ変化率**が、単独の説明変数としていちばん強かった
//   （係数 -0.3386、標準誤差 0.0392）。
//   係数がマイナス＝「直前5分でオッズが下がった（＝お金が入って人気が上がった）馬ほど、
//   実際のリターンが高い」という向き。
//
// 🚨 いちばん大事な落とし穴（ここを外すと結論がひっくり返る）
//   同じ研究で、**-15分〜-10分“だけ”を切り出すと符号が逆転する（+0.3674）**。
//   つまり「発走前の動き」をひとまとめにしてはいけない。
//   **必ず「直前5分」だけを切り出す**。このファイルはその境目(-5分)を絶対にまたがない。
//   （比較用に「それより前」と「-15〜-10分だけ」も別々に返す）
//
//   もうひとつ：売上の**中央値46.8%が直前5分に入る**。
//   つまり締切前に見えているオッズは最終的な資金の半分しか反映していない。
//   だから「発走後のオッズ」を最終オッズとして使うと、実際には買えない値段で
//   検証したことになる（＝回収率が下駄を履く）。
//
// ★このファイルがしないこと（正直に）
//   ・ファイルを読まない・書かない（純関数）。スナップと発走時刻は呼ぶ側が渡す。
//   ・「いくら賭けるか」「買うべきか」は決めない。数字を作るだけ。
//   ・**研究の式そのものは再現していない**（論文の変数の作り方までは確認できていない＝未確認）。
//     そこで、生の材料（前の値・後の値・変化率・対数変化・正規化した推定確率）を
//     全部そのまま返す。どの式を使うかは呼ぶ側が決められる。
//
// ★使い方
//   const LM = require("./late_move");
//   const postAt = LM.postTimeFromHassou("2026080901010601", "1000"); // 発走時刻(JST) → epoch ms
//   ⚠ 発走時刻は **そのときの races/*.json の hassou_time を毎回読み直す**こと。
//      スナップの中の postAt は「取った時点で分かっていた発走時刻」なので、
//      発走時刻変更(TC)があった日はズレる（実際に、あとから races/*.json が
//      作り直されて数レース分の発走時刻が動いたのを確認している）。
//   const r = LM.computeLateMove({ snapshots, postAt, kind: "tansho" });
//   r.late.byKey["7"].changeRate   // 直前5分での単勝オッズの変化率（マイナス＝人気が上がった）
//
//   // 「最終オッズ」を読むときは必ずこれを使う（発走後のスナップを拾わない）
//   const last = LM.pickLastPrePost(snapshots, postAt);
// ============================================================

// ── 既定値 ────────────────────────────────────────────────
const DEFAULTS = {
  lateMinutes: 5,          // 「直前◯分」（研究どおり 5）
  cutoffMinutes: 0,        // 発走の◯分前を締切とみなす（0＝発走時刻ちょうどまで買えた扱い）
  anchorToleranceMin: 5,   // 直前5分の“開始点”が、-5分からどれだけ古くてよいか
  earlyFromMinutes: 35,    // 「それより前」の窓の始まり
  wideUse: "mid",          // ワイドは下限〜上限の幅があるので、どれを値段とみなすか
};

const MS_PER_MIN = 60000;

// ── 発走時刻を作る（純粋な計算・タイムゾーンに左右されない）────────
// raceId の先頭8桁 YYYYMMDD ＋ hassou_time "HHMM"（JST）→ epoch ms
// 🚨 発走時刻は races/*.json の hassou_time が本物。
//    「9:50から25分おき」のような決め打ちは絶対にしない（過去にそれで失敗している）。
function postTimeFromHassou(raceIdOrYmd, hassouHHMM) {
  const s = String(raceIdOrYmd || "");
  const ymd = s.slice(0, 8);
  const hhmm = String(hassouHHMM == null ? "" : hassouHHMM).trim();
  if (!/^\d{8}$/.test(ymd) || !/^\d{4}$/.test(hhmm)) return null;
  const y = Number(ymd.slice(0, 4));
  const mo = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const hh = Number(hhmm.slice(0, 2));
  const mi = Number(hhmm.slice(2, 4));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59) return null;
  // JST(+09:00) の壁時計時刻 → UTC の瞬間
  return Date.UTC(y, mo - 1, d, hh, mi, 0, 0) - 9 * 60 * MS_PER_MIN;
}

// ISO文字列 / Date / epoch ms のどれでも受ける
function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

// スナップを取った時刻。fetchedAt（UTCのISO）が正。無ければ呼ぶ側の fallback（ファイル名の unixtime 等）。
function snapshotTimeMs(snap, fallbackMs) {
  const t = toMs(snap && snap.fetchedAt);
  if (t != null) return t;
  return toMs(fallbackMs);
}

// 発走まであと何分か。**マイナス＝まだ発走前**（＝買える時刻）。
function minutesToPost(snap, postAtMs, fallbackMs) {
  const p = toMs(postAtMs);
  const t = snapshotTimeMs(snap, fallbackMs);
  if (p == null || t == null) return null;
  return (t - p) / MS_PER_MIN;
}

// ── JRAが「その値段を出した時刻」──────────────────────────────
//   スナップには JRA側の発表時刻 happyo_time ("MMDDHHMM"・JST) が入っている。
//   実測（1,154枚）では **こちらが取った時刻の中央値1.0分前**に出された値段だった
//   （25%点1.0分・75%点1.0分・最大5.0分）。
//   つまり「発走2分前に取った値段」は、実際には**約3分前の値段**。
//   これは JRA の配信のしくみ上どうにもならないので、隠さずそのまま返す。
function publishedMinutesToPost(snap, postAtMs, kind) {
  const p = toMs(postAtMs);
  if (p == null || !snap) return null;
  const k = kind || "tansho";
  const raw = (snap.odds && snap.odds[k] && snap.odds[k].happyo_time) || snap.happyoTime;
  const s = String(raw == null ? "" : raw).trim();
  if (!/^\d{8}$/.test(s)) return null;
  const mo = Number(s.slice(0, 2)), d = Number(s.slice(2, 4));
  const hh = Number(s.slice(4, 6)), mi = Number(s.slice(6, 8));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59) return null;
  // 年が入っていないので、発走時刻の年を借りる（年またぎは前後1年を試して近い方）
  const postJst = new Date(p + 9 * 60 * MS_PER_MIN);
  const y0 = postJst.getUTCFullYear();
  let best = null;
  for (const y of [y0 - 1, y0, y0 + 1]) {
    const t = Date.UTC(y, mo - 1, d, hh, mi, 0, 0) - 9 * 60 * MS_PER_MIN;
    if (best == null || Math.abs(t - p) < Math.abs(best - p)) best = t;
  }
  if (Math.abs(best - p) > 2 * 24 * 60 * MS_PER_MIN) return null; // 2日以上ズレ＝読めていない
  return (best - p) / MS_PER_MIN;
}

// ── スナップの一覧に「発走まで何分か」を付けて、古い順に並べる ──────
//   入力は 生のスナップ配列 でも {snapshot, ms} の配列でもよい。
function annotate(snapshots, postAt) {
  const p = toMs(postAt);
  const out = [];
  for (const raw of snapshots || []) {
    const snap = raw && raw.snapshot ? raw.snapshot : raw;
    if (!snap || typeof snap !== "object") continue;
    const ms = snapshotTimeMs(snap, raw && raw.ms);
    if (ms == null) continue;
    const m = p == null ? null : (ms - p) / MS_PER_MIN;
    out.push({
      snapshot: snap,
      ms,
      minutesToPost: m,
      // 発走前＝買えた時刻。発走時刻が分からないときは null（嘘をつかない）。
      beforePost: m == null ? null : m < 0,
    });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

// ── ★ 最終オッズを読むときは必ずこれ ────────────────────────
//   「いちばん新しい .json」を最終オッズとして読むと、発走後のスナップを掴む。
//   （実測：貯めた433レースのうち114レース＝26.3%がそれだった）
//   cutoffMinutes を 1 にすると「発走1分前までに取れた物」しか採らない（より厳しい）。
function pickLastPrePost(snapshots, postAt, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const rows = annotate(snapshots, postAt);
  if (!rows.length) return null;
  const p = toMs(postAt);
  if (p == null) {
    // 発走時刻が分からない＝前後の判定ができない。いちばん新しい物を返すが、
    // 呼ぶ側が気づけるように印を付ける。
    const last = rows[rows.length - 1];
    return { snapshot: last.snapshot, ms: last.ms, minutesToPost: null, beforePost: null,
             postTimeKnown: false };
  }
  const limit = -Math.abs(Number(o.cutoffMinutes) || 0);
  let best = null;
  for (const r of rows) if (r.minutesToPost <= limit) best = r; // 古い順なので最後に残るのが最新
  if (!best) return null;
  return { snapshot: best.snapshot, ms: best.ms, minutesToPost: best.minutesToPost,
           beforePost: true, postTimeKnown: true };
}

// ── 1枚のスナップから「組番/馬番 → 値段」を作る ────────────────
//   kind: tansho(単勝) / umaren(馬連) / wide(ワイド) / umatan(馬単) /
//         sanren(3連複) / sanrentan(3連単)
//   ワイドは下限〜上限の幅があるので mid(真ん中) / low / high を選べる（既定 mid）。
function priceMap(snap, kind, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const out = new Map();
  const block = snap && snap.odds && snap.odds[kind];
  const items = block && Array.isArray(block.items) ? block.items : null;
  if (!items) return out;
  for (const it of items) {
    if (!it) continue;
    const key = it.key != null ? String(it.key) : (it.number != null ? String(it.number) : null);
    if (key == null) continue;
    let v;
    if (it.odds != null) {
      v = Number(it.odds);
    } else if (it.odds_low != null || it.odds_high != null) {
      const lo = Number(it.odds_low);
      const hi = Number(it.odds_high);
      if (o.wideUse === "low") v = lo;
      else if (o.wideUse === "high") v = hi;
      else v = (Number.isFinite(lo) && Number.isFinite(hi)) ? (lo + hi) / 2 : (Number.isFinite(lo) ? lo : hi);
    } else {
      continue;
    }
    // オッズ1.0以下は「まだ値が付いていない/欠測」。混ぜると変化率が壊れるので捨てる。
    if (!Number.isFinite(v) || v <= 1.0) continue;
    out.set(key, v);
  }
  return out;
}

// ── 2枚のスナップの差 ＝ 動き ────────────────────────────────
//   changeRate     … (後 - 前) / 前     マイナス＝オッズが下がった＝お金が入った
//   logChange      … ln(後 / 前)         （倍率で見たいとき。研究の式は未確認なので両方出す）
//   impliedFrom/To … 1/オッズ（控除込みの“ざっくり確率”）
//   impliedNorm*   … 同じ組番だけで合計1に直した確率。市場全体のドリフトを消せる。
function moveBetween(fromSnap, toSnap, kind, opts) {
  const a = priceMap(fromSnap, kind, opts);
  const b = priceMap(toSnap, kind, opts);
  const byKey = {};
  // 両方に出てくる組番だけを使う（片方しか無い＝比べられない）
  const keys = [];
  for (const k of a.keys()) if (b.has(k)) keys.push(k);

  let sumA = 0, sumB = 0;
  for (const k of keys) { sumA += 1 / a.get(k); sumB += 1 / b.get(k); }

  let n = 0, absSum = 0;
  let biggestDrop = null, biggestRise = null;
  for (const k of keys) {
    const from = a.get(k);
    const to = b.get(k);
    const changeRate = (to - from) / from;
    const iFrom = 1 / from;
    const iTo = 1 / to;
    const nFrom = sumA > 0 ? iFrom / sumA : null;
    const nTo = sumB > 0 ? iTo / sumB : null;
    byKey[k] = {
      from, to,
      changeRate,
      logChange: Math.log(to / from),
      impliedFrom: iFrom,
      impliedTo: iTo,
      impliedChangeRate: (iTo - iFrom) / iFrom,
      impliedNormFrom: nFrom,
      impliedNormTo: nTo,
      impliedNormChangeRate: (nFrom && nTo) ? (nTo - nFrom) / nFrom : null,
    };
    n += 1;
    absSum += Math.abs(changeRate);
    if (!biggestDrop || changeRate < biggestDrop.changeRate) biggestDrop = { key: k, changeRate };
    if (!biggestRise || changeRate > biggestRise.changeRate) biggestRise = { key: k, changeRate };
  }
  return {
    byKey,
    summary: {
      n,
      meanAbsChangeRate: n ? absSum / n : null,
      biggestDrop, biggestRise,
      // 合計1/オッズ＝「胴元の取り分込みの合計」。大きく動いたら市場の状態が変わったサイン。
      bookFrom: sumA || null,
      bookTo: sumB || null,
    },
  };
}

// ── 窓の端になるスナップを選ぶ小道具 ──────────────────────────
function lastAtOrBefore(rows, minutes) {
  let best = null;
  for (const r of rows) if (r.minutesToPost != null && r.minutesToPost <= minutes) best = r;
  return best;
}
function firstInRange(rows, lo, hi) { // lo <= m <= hi
  for (const r of rows) if (r.minutesToPost != null && r.minutesToPost >= lo && r.minutesToPost <= hi) return r;
  return null;
}

function windowResult(fromRow, toRow, kind, opts, reasonIfBad) {
  if (!fromRow || !toRow || fromRow.ms === toRow.ms) {
    return { ok: false, reason: reasonIfBad, from: null, to: null, spanMin: null, byKey: {}, summary: null };
  }
  const mv = moveBetween(fromRow.snapshot, toRow.snapshot, kind, opts);
  const pm = (row) => publishedMinutesToPost(row.snapshot, toMs(opts && opts.postAt), kind);
  return {
    ok: mv.summary.n > 0,
    reason: mv.summary.n > 0 ? null : "no_common_keys",
    // publishedMinutesToPost = JRAがその値段を出した時刻（実測でだいたい1分前）。
    from: { minutesToPost: fromRow.minutesToPost, ms: fromRow.ms, publishedMinutesToPost: pm(fromRow) },
    to: { minutesToPost: toRow.minutesToPost, ms: toRow.ms, publishedMinutesToPost: pm(toRow) },
    spanMin: (toRow.ms - fromRow.ms) / MS_PER_MIN,
    byKey: mv.byKey,
    summary: mv.summary,
  };
}

// ============================================================
// 本体
// ============================================================
//  返り値
//   late    … 直前5分の動き（研究のいちばん強い変数）
//   early   … それより前（-35分〜-5分）の動き ※lateと絶対に混ぜない
//   mid1510 … -15分〜-10分“だけ”（研究で符号が反転する帯・診断用）
//   lastPrePost … 実際に買えた最後のオッズのスナップ
function computeLateMove(params) {
  const p = params || {};
  const o = Object.assign({}, DEFAULTS, p);
  const kind = p.kind || "tansho";
  const postAtMs = toMs(p.postAt);
  const rows = annotate(p.snapshots, postAtMs);

  const counts = { total: rows.length, before: 0, after: 0, unknown: 0 };
  for (const r of rows) {
    if (r.beforePost === true) counts.before += 1;
    else if (r.beforePost === false) counts.after += 1;
    else counts.unknown += 1;
  }

  const base = {
    ok: false, reason: null, kind, postAtMs, counts,
    lastPrePost: null, late: null, early: null, mid1510: null,
    options: { lateMinutes: o.lateMinutes, cutoffMinutes: o.cutoffMinutes,
               anchorToleranceMin: o.anchorToleranceMin, earlyFromMinutes: o.earlyFromMinutes,
               wideUse: o.wideUse },
  };
  if (postAtMs == null) return Object.assign(base, { reason: "post_time_unknown" });
  if (rows.length < 2) return Object.assign(base, { reason: "not_enough_snapshots" });

  const late = -Math.abs(o.lateMinutes);            // 例 -5
  const cut = -Math.abs(o.cutoffMinutes || 0);      // 例 0
  const tol = Math.abs(o.anchorToleranceMin);

  // 直前5分の「終わり」＝実際に買えた最後のスナップ
  const toRow = lastAtOrBefore(rows, cut);
  base.lastPrePost = toRow
    ? { minutesToPost: toRow.minutesToPost, ms: toRow.ms, snapshot: toRow.snapshot }
    : null;
  if (!toRow) return Object.assign(base, { reason: "no_pre_post_snapshot" });

  // 直前5分の「始まり」＝-5分 以前でいちばん新しいスナップ
  const fromRow = lastAtOrBefore(rows, late);

  let lateRes;
  if (!fromRow) {
    lateRes = { ok: false, reason: "no_anchor_before_late_window", from: null, to: null,
                spanMin: null, byKey: {}, summary: null };
  } else if (fromRow.minutesToPost < late - tol) {
    // 例：直前5分の基準点が -34分 しかない＝“直前5分の動き”とは呼べない。
    // ここで正直に落とさないと、早い時間帯の動き（研究では符号が逆）が混ざってしまう。
    lateRes = { ok: false, reason: "anchor_too_old",
                from: { minutesToPost: fromRow.minutesToPost, ms: fromRow.ms },
                to: { minutesToPost: toRow.minutesToPost, ms: toRow.ms },
                spanMin: (toRow.ms - fromRow.ms) / MS_PER_MIN, byKey: {}, summary: null };
  } else if (toRow.minutesToPost <= late) {
    // 直前5分の“中”に1枚も無い（最後の1枚が -7分 など）
    lateRes = { ok: false, reason: "no_snapshot_inside_late_window",
                from: { minutesToPost: fromRow.minutesToPost, ms: fromRow.ms },
                to: { minutesToPost: toRow.minutesToPost, ms: toRow.ms },
                spanMin: (toRow.ms - fromRow.ms) / MS_PER_MIN, byKey: {}, summary: null };
  } else {
    lateRes = windowResult(fromRow, toRow, kind, o, "not_enough_snapshots");
  }
  base.late = lateRes;

  // それより前（-35分 〜 -5分）。終わりは late の始まりと同じ点＝窓が重ならない。
  const earlyFrom = firstInRange(rows, -Math.abs(o.earlyFromMinutes), late);
  base.early = windowResult(earlyFrom, fromRow, kind, o, "not_enough_snapshots");

  // -15分〜-10分 だけ（研究で符号が反転する帯）。診断用。
  const m15 = lastAtOrBefore(rows, -15);
  let m10 = null;
  for (const r of rows) if (r.minutesToPost != null && r.minutesToPost <= -10 && r.minutesToPost > -15) m10 = r;
  base.mid1510 = (m15 && m15.minutesToPost >= -20)
    ? windowResult(m15, m10, kind, o, "no_snapshot_in_15_10")
    : { ok: false, reason: "no_snapshot_in_15_10", from: null, to: null, spanMin: null, byKey: {}, summary: null };

  base.ok = !!(base.late && base.late.ok);
  base.reason = base.ok ? null : (base.late ? base.late.reason : "unknown");
  return base;
}

module.exports = {
  DEFAULTS,
  postTimeFromHassou,
  snapshotTimeMs,
  minutesToPost,
  publishedMinutesToPost,
  annotate,
  pickLastPrePost,
  priceMap,
  moveBetween,
  computeLateMove,
};
