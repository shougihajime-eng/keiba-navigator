// ============================================================
// keiba_learn_weekly.cjs — 「アプリが失敗から学ぶ」ための毎週の答え合わせ
//
//   これまでの問題: モデル(AI)は毎週学習し直していたのに、
//   「どの買い方が損しているか」を誰も見ておらず、
//   14 の買い方が全部 100% 割れなのに 1 つも止まっていなかった
//   (175 連敗した買い方が出続けていた)。
//
//   このスクリプトが毎週やること:
//     ① うまみ買い(馬連/ワイド/3連複)の本当の回収率を測る
//        - 大当たり 1 回を抜いた回収率も出す(まぐれ判定)
//        - ブートストラップ 95% 信頼区間(運の幅)
//     ② 実運用ログ(strategy_live_stats.json)の 14 戦略の成績を読む
//     ③ 「出してよい買い方 / 止める買い方」を自動で決めて
//        data/jv_cache/umami_status.json に書く
//     ④ はじめさん向けのやさしい日本語レポートを書く
//
//   ★合格の条件(全部満たしたものだけ「出してよい」)
//     - 賭け数 150 点以上            … 少なすぎる成績は運
//     - 回収率 100% 以上             … 控除の壁を越えている
//     - 大当たり 1 回を抜いても 100%  … 1 回のまぐれで稼いでいない
//     - 95% の幅の下限も 100% 超      … ★2026-08-11 追加。ここが本丸。
//
//   ⚠ 2026-08-11 追記(この日の深い検証で判明・判定を厳しくした):
//     最初は上の 3 つだけで「馬連 133.3% = 出してよい」と判定していたが、
//     360 レース・29,334 通りで厳しく検証したところ:
//       ・95% の幅が 65.8〜210% で 100% をまたぐ = 勝ち負けを区別できない
//       ・オッズの 26% が「発走より後」のもので、実際に買える時刻に直すと
//         121% → 約 100.7% まで落ちる
//       ・しきい値を過去成績で選び直す運用は実際にやると 94.2% で負ける
//       ・EV が高いほど良い、という坂になっていない(1.20〜1.50 の帯だけ ROI 57%)
//     「モデルに予想力があること自体」は確か(p=0.004)だが、その大きさは
//     控除率をちょうど打ち消す程度で、「もうかる」はまだ言えない(p=0.25〜0.32)。
//     → 3 条件だけで「出してよい」と出すのは、消したはずの「いいとこ取り」と同じ。
//     → 幅の下限も 100% を超えるまでは「△ まだ分からない(見送り)」にする。
//
//   使い方: node scripts/keiba_learn_weekly.cjs
// ============================================================
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const O = require(path.join(ROOT, "lib", "overlay.js"));
const ODDS = path.join(ROOT, "data", "jv_cache", "exotic_odds");
const RES = path.join(ROOT, "data", "jv_cache", "results");
const LIVE = path.join(ROOT, "data", "jv_cache", "strategy_live_stats.json");
const OUT_JSON = path.join(ROOT, "data", "jv_cache", "umami_status.json");
const REPORT = "C:\\Users\\shoug\\はじめアプリ\\競馬の学習けっか（毎週）.txt";

const MIN_BETS = 150;

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
const norm = (k) => String(k).split("-").map(Number).sort((a, b) => a - b).join("-");

function payoutLookup(res) {
  const P = (res && res.payouts) || {};
  return {
    umaren: (k) => (P.uren && norm(P.uren.key) === norm(k)) ? P.uren.amount : 0,
    wide: (k) => { const w = (P.wide || []).find(z => norm(z.key) === norm(k)); return w ? w.amount : 0; },
    sanren: (k) => (P.fuku3 && norm(P.fuku3.key) === norm(k)) ? P.fuku3.amount : 0,
  };
}
function latestSnap(d) {
  let f;
  try { f = fs.readdirSync(d).filter(x => x.endsWith(".json")); } catch { return null; }
  if (!f.length) return null;
  f.sort((a, b) => Number(a.replace(".json", "")) - Number(b.replace(".json", "")));
  return readJson(path.join(d, f[f.length - 1]));
}
// 決まった順番の乱数 = 毎回おなじ答えが出る(再現できる)
function bootstrapCI(arr, n = 20000) {
  if (!arr.length) return [0, 0];
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const out = new Array(n);
  const L = arr.length;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < L; j++) s += arr[(rnd() * L) | 0];
    out[i] = s / (L * 100);
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(n * 0.025)], out[Math.floor(n * 0.975)]];
}

function analyzeUmami(minEV, minProb) {
  const typeKey = { "馬連": "umaren", "ワイド": "wide", "3連複": "sanren" };
  const bets = { umaren: [], wide: [], sanren: [] };
  const days = { umaren: new Set(), wide: new Set(), sanren: new Set() };
  let races = 0, waiting = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(ODDS).filter(d => { try { return fs.statSync(path.join(ODDS, d)).isDirectory(); } catch { return false; } }); } catch { return null; }
  for (const rid of dirs) {
    const snap = latestSnap(path.join(ODDS, rid));
    if (!snap || !snap.odds || !snap.odds.tansho) continue;
    const res = readJson(path.join(RES, rid + "00.json")) || readJson(path.join(RES, rid + ".json"));
    if (!res || !res.payouts) { waiting++; continue; }
    races++;
    const winProb = O.buildWinProb(snap.odds.tansho.items);
    const ovs = O.findOverlays(winProb, snap, { minEV, minProb });
    if (!ovs.length) continue;
    const pay = payoutLookup(res);
    for (const ov of ovs) {
      const tk = typeKey[ov.type];
      if (!tk) continue;
      bets[tk].push(pay[tk](ov.key));
      days[tk].add(rid.slice(0, 8));
    }
  }
  const LBL = { umaren: "馬連", wide: "ワイド", sanren: "3連複" };
  const result = {};
  for (const k of Object.keys(bets)) {
    const a = bets[k];
    const cost = a.length * 100;
    const ret = a.reduce((x, y) => x + y, 0);
    const hits = a.filter(x => x > 0).sort((x, y) => y - x);
    const roi = cost ? ret / cost * 100 : 0;
    const top = hits[0] || 0;
    const roiNoTop = cost ? (ret - top) / cost * 100 : 0;
    const ci = bootstrapCI(a);
    const proven = ci[0] > 1;   // 95% の幅の下限も 100% 超 = 運では説明しにくい
    // 3 条件までは通ったが幅が 100% をまたぐもの = 「有望だが まだ分からない」
    const promising = a.length >= MIN_BETS && roi >= 100 && roiNoTop >= 100;
    const allow = promising && proven;   // ★ここを厳しくした (2026-08-11)
    result[k] = {
      label: LBL[k], bets: a.length, hits: hits.length, cost, ret,
      profit: ret - cost,
      roi_pct: +roi.toFixed(1),
      roi_without_top_hit_pct: +roiNoTop.toFixed(1),
      biggest_hit: top,
      ci95_low_pct: +(ci[0] * 100).toFixed(0),
      ci95_high_pct: +(ci[1] * 100).toFixed(0),
      race_days: days[k].size,
      proven,
      promising,
      allow,
      state: allow ? "ok" : promising ? "unknown" : "ng",
      reason: a.length < MIN_BETS ? `賭け数が${a.length}点で少なすぎる(${MIN_BETS}点必要)`
        : roi < 100 ? `回収率が${roi.toFixed(1)}%で負けている`
          : roiNoTop < 100 ? `大当たり1回を抜くと${roiNoTop.toFixed(1)}%=まぐれ頼み`
            : !proven ? `回収率は${roi.toFixed(1)}%だが、運の幅が${(ci[0]*100).toFixed(0)}%〜${(ci[1]*100).toFixed(0)}%で100%をまたぐ＝まだ勝ち負けを区別できない`
              : `合格(回収率${roi.toFixed(1)}%・大当たり抜き${roiNoTop.toFixed(1)}%・運の幅の下も${(ci[0]*100).toFixed(0)}%)`,
    };
  }
  return { races, waiting, minEV, minProb, byType: result };
}

function analyzeLive() {
  const d = readJson(LIVE);
  if (!d || !d.by_strategy) return null;
  const rows = Object.entries(d.by_strategy).map(([k, v]) => ({
    key: k, bets: v.bets, roi_pct: v.roi_pct, profit: v.profit_jpy,
    streak: v.max_losing_streak,
    allow: v.bets >= MIN_BETS && v.roi_pct >= 100,
  })).sort((a, b) => a.roi_pct - b.roi_pct);
  const totalCost = Object.values(d.by_strategy).reduce((s, v) => s + v.invest_jpy, 0);
  const totalRet = Object.values(d.by_strategy).reduce((s, v) => s + v.payout_jpy, 0);
  return { computed_at: d.computed_at, resolved: d.resolved_entries, rows, totalCost, totalRet };
}

function jstStamp() {
  const n = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${n.getUTCFullYear()}-${p(n.getUTCMonth() + 1)}-${p(n.getUTCDate())} ${p(n.getUTCHours())}:${p(n.getUTCMinutes())}`;
}

function main() {
  const um = analyzeUmami(1.20, 0.03);
  const live = analyzeLive();
  const stamp = jstStamp();

  const status = {
    checked_at: stamp,
    min_bets_required: MIN_BETS,
    umami: um,
    allowed_bet_types: um ? Object.entries(um.byType).filter(([, v]) => v.allow).map(([k]) => k) : [],
    live_losing_strategies: live ? live.rows.filter(r => !r.allow).map(r => r.key) : [],
    live_allowed_strategies: live ? live.rows.filter(r => r.allow).map(r => r.key) : [],
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(status, null, 2), "utf8");

  // ---- はじめさん向けレポート ----
  const L = [];
  L.push("競馬アプリ　毎週の学習けっか");
  L.push("しらべた日時: " + stamp);
  L.push("");
  L.push("このファイルは、アプリが自分の成績を毎週たしかめて");
  L.push("「勝てている買い方」と「損している買い方」を分けた結果です。");
  L.push("");
  L.push("==================================================");
  L.push("１．うまみ買い（安く買える穴をさがす買い方）");
  L.push("==================================================");
  if (!um) {
    L.push("データがまだありません。");
  } else {
    L.push(`しらべたレース: ${um.races} 　（結果まち ${um.waiting}）`);
    L.push("");
    for (const k of ["umaren", "sanren", "wide"]) {
      const v = um.byType[k];
      if (!v || !v.bets) continue;
      L.push(`【${v.label}】`);
      L.push(`　賭けた数 ${v.bets}点 ／ 当たり ${v.hits}回 ／ 開催 ${v.race_days}日`);
      L.push(`　回収率 ${v.roi_pct}%　（収支 ${v.profit >= 0 ? "+" : ""}${v.profit.toLocaleString()}円）`);
      L.push(`　いちばん大きい当たり ${v.biggest_hit.toLocaleString()}円 を1回抜くと → ${v.roi_without_top_hit_pct}%`);
      L.push(`　運の幅（95%）: ${v.ci95_low_pct}% 〜 ${v.ci95_high_pct}%`);
      const mark = v.allow ? "◯ 出してよい" : v.promising ? "△ まだ分からない（見送り）" : "✕ 止める";
      L.push(`　判定: ${mark} … ${v.reason}`);
      if (v.proven) L.push("　★運の幅の下も100%超え＝本物の可能性が高い");
      L.push("");
    }
  }
  L.push("==================================================");
  L.push("２．いま出している買い方（実際の成績）");
  L.push("==================================================");
  if (!live) {
    L.push("実運用の記録がありません。");
  } else {
    L.push(`確定した記録 ${live.resolved} 件`);
    L.push(`ぜんぶ足すと 賭け ${live.totalCost.toLocaleString()}円 → もどり ${live.totalRet.toLocaleString()}円 ＝ ${(live.totalRet - live.totalCost).toLocaleString()}円`);
    L.push("");
    L.push("わるい順:");
    for (const r of live.rows) {
      L.push(`　${r.allow ? "◯" : "✕"} ${r.key.padEnd(24)} 回収率 ${String(r.roi_pct).padStart(6)}%　${r.bets}回　${r.profit >= 0 ? "+" : ""}${r.profit.toLocaleString()}円　最大${r.streak}連敗`);
    }
    L.push("");
    const ng = live.rows.filter(r => !r.allow).length;
    L.push(`→ ${ng} 個の買い方が合格していません。これらは画面で「止める」あつかいにします。`);
  }
  L.push("");
  L.push("==================================================");
  L.push("３．正直なこと");
  L.push("==================================================");
  L.push("・競馬は賭けたお金の 20% が自動で引かれます（3連系は 25%）。");
  L.push("　だから「ふつうに買えば必ず負ける」のがスタート地点です。");
  L.push("・いま 100% を超えている買い方があっても、回数が少ないうちは");
  L.push("　運の可能性が残ります。回数が増えるほど本物かどうか分かります。");
  L.push("・このファイルは毎週 月曜の朝に自動で作り直されます。");
  fs.writeFileSync(REPORT, L.join("\r\n"), "utf8");

  console.log(L.join("\n"));
  console.log("");
  console.log("[OK] " + OUT_JSON);
  console.log("[OK] " + REPORT);
}

main();
