// ============================================================
// backtest-overlays.cjs — 「うまみ買い」の“本当の回収率”を正直に測る。
//
//   貯めた直前オッズ(exotic_odds/<raceid>/*.json の最終スナップ)と、
//   本物の結果(results/*.json の払戻)を突き合わせ、
//   overlay.js が選ぶ「うまみ(期待値≥しきい値)」を毎回買っていたら
//   回収率(ROI)が何%だったかを、控除込み・後出しなしで計算する。
//
//   ★これが「勝てるか」の唯一の正直な答え。100%超で初めて“勝ち”。
//   ★データが貯まるまで(KeibaExoticOdds が数週末ぶん集めるまで)は
//     「対象0レース」と出る。それが正常＝まだ判定できない、という正直な状態。
//
//   使い方: node scripts/backtest-overlays.cjs            (既定 期待値≥1.20)
//          node scripts/backtest-overlays.cjs --minev 1.3 --minprob 0.04
// ============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const O = require(path.join(__dirname, "..", "lib", "overlay.js"));

const ROOT = path.resolve(__dirname, "..");
const ODDS = path.join(ROOT, "data", "jv_cache", "exotic_odds");
const RES = path.join(ROOT, "data", "jv_cache", "results");

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
const norm = (k) => String(k).split("-").map(Number).sort((a, b) => a - b).join("-");

const args = process.argv.slice(2);
const num = (f, d) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; };
const MINEV = num("--minev", 1.20);
const MINPROB = num("--minprob", 0.03);

// results の払戻から「組合せ→払戻額(100円あたり)」を引く
function payoutLookup(res) {
  const P = (res && res.payouts) || {};
  return {
    umaren: (k) => (P.uren && norm(P.uren.key) === norm(k)) ? P.uren.amount : 0,
    wide: (k) => { const w = (P.wide || []).find(z => norm(z.key) === norm(k)); return w ? w.amount : 0; },
    sanren: (k) => (P.fuku3 && norm(P.fuku3.key) === norm(k)) ? P.fuku3.amount : 0,
  };
}

function latestSnap(raceDir) {
  const files = fs.readdirSync(raceDir).filter(f => f.endsWith(".json"));
  if (!files.length) return null;
  // ファイル名は unixtime。最大＝発走に一番近い最終オッズ。
  files.sort((a, b) => Number(a.replace(".json", "")) - Number(b.replace(".json", "")));
  return readJson(path.join(raceDir, files[files.length - 1]));
}

function main() {
  if (!fs.existsSync(ODDS)) { console.log("exotic_odds フォルダなし＝まだ収集前。"); return; }
  const raceDirs = fs.readdirSync(ODDS).filter(d => fs.statSync(path.join(ODDS, d)).isDirectory());
  const S = {
    umaren: { label: "馬連 うまみ", bets: 0, cost: 0, ret: 0, hits: 0 },
    wide: { label: "ワイド うまみ", bets: 0, cost: 0, ret: 0, hits: 0 },
    sanren: { label: "3連複 うまみ", bets: 0, cost: 0, ret: 0, hits: 0 },
  };
  const typeKey = { "馬連": "umaren", "ワイド": "wide", "3連複": "sanren" };
  let usedRaces = 0, noResult = 0;

  for (const rid of raceDirs) {
    const snap = latestSnap(path.join(ODDS, rid));
    if (!snap || !snap.odds || !snap.odds.tansho) continue;
    // 対応する結果(末尾00の18桁名)
    const res = readJson(path.join(RES, rid + "00.json")) || readJson(path.join(RES, rid + ".json"));
    if (!res || !res.payouts) { noResult++; continue; }
    const winProb = O.buildWinProb(snap.odds.tansho.items);
    const overlays = O.findOverlays(winProb, snap, { minEV: MINEV, minProb: MINPROB });
    if (!overlays.length) { usedRaces++; continue; }
    const pay = payoutLookup(res);
    for (const ov of overlays) {
      const tk = typeKey[ov.type]; if (!tk) continue;
      const s = S[tk];
      s.bets++; s.cost += 100;
      const amt = pay[tk](ov.key);
      if (amt > 0) { s.hits++; s.ret += amt; }
    }
    usedRaces++;
  }

  const pct = (x) => (x * 100).toFixed(1) + "%";
  console.log(`\n=== うまみ買い バックテスト (期待値≥${MINEV} / 最低確率${MINPROB}) ===`);
  console.log(`データのあるレース: ${usedRaces}  (結果待ち ${noResult})`);
  if (usedRaces < 30) {
    console.log(`\n⚠ まだレースが少なすぎて判定できません(信頼するには最低でも数百レース必要)。`);
    console.log(`  KeibaExoticOdds が毎週末オッズを貯めます。数週間後にまた実行してください。`);
  }
  console.log(`\n買い方            賭け数   的中率    回収率    収支`);
  let tb = 0, tc = 0, tr = 0;
  for (const s of Object.values(S)) {
    if (!s.bets) { console.log(`${s.label.padEnd(14)}   (なし)`); continue; }
    const roi = s.ret / s.cost, hit = s.hits / s.bets, pnl = s.ret - s.cost;
    tb += s.bets; tc += s.cost; tr += s.ret;
    console.log(`${s.label.padEnd(14)} ${String(s.bets).padStart(5)}  ${pct(hit).padStart(7)}  ${pct(roi).padStart(8)}  ${(pnl >= 0 ? "+" : "") + Math.round(pnl).toLocaleString()}円${roi >= 1 ? "  ★プラス" : ""}`);
  }
  if (tb) {
    const roi = tr / tc;
    console.log(`${"合計".padEnd(14)} ${String(tb).padStart(5)}  ${"".padStart(7)}  ${pct(roi).padStart(8)}  ${(tr - tc >= 0 ? "+" : "") + Math.round(tr - tc).toLocaleString()}円${roi >= 1 ? "  ★プラス!" : ""}`);
    console.log(`\n${roi >= 1 ? "→ プラスの兆し。次は資金管理(分数ケリー)と本番の出し方を詰める。" : "→ まだ控除の壁を越えていません。指数・しきい値・モデルを見直す材料にします。"}`);
  }
}

main();
