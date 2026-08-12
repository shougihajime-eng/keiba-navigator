"use strict";
// 2026-08-12 新設: JRAが払戻率を上げる日。
//   ふつうの単勝・複勝は 払戻率80%（＝控除率20%）だが、
//   「JRAウルトラプレミアム」の日は **85%**（80% + 上乗せ5%）になる。
//   ＝予想の腕とは無関係に、控除が 20% → 15% に減る（4分の1が消える）。
//   これが このアプリで唯一「確実に・数字で・誰でも」得をする差。
//
// ⚠ 正直に: 85%でも100%ではない。回収率が 94.2% 未満の買い方は、この日でも負ける
//   （100 ÷ 1.0625 = 94.12）。「勝てる日」ではなく「負けが小さくなる日」。
// ⚠ 2026年の対象日は JRA がまだ公表していない（＝「該当なし」ではなく「未公表」）。

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "jv_cache", "jra_premium.json");

// ふつうの払戻率（JRA公式・2026-08 時点）
const NORMAL_PAYOUT = {
  単勝: 80, 複勝: 80, 枠連: 77.5, 馬連: 77.5, ワイド: 77.5,
  馬単: 75, 三連複: 75, 三連単: 72.5, WIN5: 70,
};

function readPremium() {
  try {
    if (!fs.existsSync(FILE)) return null;
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) { return null; }
}

/** YYYYMMDD（日本時間） */
function todayYmd(now) {
  const d = now ? new Date(now) : new Date();
  const jst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60000);
  return `${jst.getFullYear()}${String(jst.getMonth() + 1).padStart(2, "0")}${String(jst.getDate()).padStart(2, "0")}`;
}

/** その日ぜんぶが対象の日だけを新しい順に */
function wholeDayEntries(data) {
  const days = (data && data.days) || [];
  return days
    .filter((d) => d && d.coverage === "day" && d.date && Number(d.payoutPct) > 0)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/**
 * 画面に出す形にまとめる。嘘をつかないための決まり:
 *   ・これからの対象日が1件も無い時は null を返し、reason に「未公表」と書く
 *   ・「今日は該当なし」とは言わない（公表されていないだけかもしれない）
 */
function buildPremiumView(opts) {
  const o = opts || {};
  const data = o.data !== undefined ? o.data : readPremium();
  if (!data) return { ok: false, reason: "no_data" };

  const ymd = o.today || todayYmd(o.now);
  const all = wholeDayEntries(data);
  const upcoming = all.filter((d) => String(d.date) >= ymd)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const today = all.find((d) => String(d.date) === ymd) || null;
  const past = all.filter((d) => String(d.date) < ymd);

  // 「回収率が何%以上なら、この日だけは100%を超えるか」
  //   85%の日は もどりが 85/80 = 1.0625 倍になる → 100 / 1.0625 = 94.12%
  const boost = (p) => (Number(p) > 0 ? Number(p) / 80 : 1);
  const kindPct = (data.payoutByKind && data.payoutByKind.ultra && data.payoutByKind.ultra.payoutPct) || 85;
  const bestBoost = boost(kindPct);

  return {
    ok: true,
    todayDate: ymd,
    today,                                   // 今日が対象日ならその中身・でなければ null
    next: upcoming.find((d) => String(d.date) > ymd) || null,
    upcomingCount: upcoming.length,
    // これからの予定が無い理由（＝「該当なし」と言い切らない）
    reason: upcoming.length ? null : "not_published_yet",
    lastKnown: past[0] || null,              // 直近に実施された日（実在の証拠）
    pastCount: past.length,
    ultraCount: all.filter((d) => Number(d.payoutPct) >= 85).length,
    superCount: all.filter((d) => Number(d.payoutPct) === 80 && d.kind === "super").length,
    normalPayout: NORMAL_PAYOUT,
    payoutByKind: data.payoutByKind || null,
    alwaysOn: data.alwaysOn || [],           // JRAプラス10（いつでも効いている）
    // 85%の日は「回収率 何% 以上なら100%を超えるか」
    breakEvenRoiPct: Math.round((100 / bestBoost) * 10) / 10,
    boostRatio: Math.round(bestBoost * 10000) / 10000,
    fetchedAt: data.fetchedAt || null,
    sources: data.sources || null,
  };
}

module.exports = { readPremium, buildPremiumView, wholeDayEntries, todayYmd, NORMAL_PAYOUT };
