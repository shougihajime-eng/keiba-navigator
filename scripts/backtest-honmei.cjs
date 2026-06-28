// ============================================================
// 本命(いちばん勝ちそうな馬)の「当たり具合」を過去の本物の結果で測る。
//
// ★2026-06-28 正直化に合わせた恒久ツール。アプリは「儲け」ではなく
//   「いちばん勝ちそうな本命を当てる予想」を主役にしたので、評価指標も
//   「単勝的中率(本命が1着)」「複勝率(本命が3着内)」で測る。
//
// 比較対象:
//   ① モデル本命   = buildConclusion の picks[0](市場アンカー+較正+モデルtilt)
//   ② 市場一番人気 = 確定オッズが最も低い馬(=人気1番。集合知の素の力)
//   この2つの的中率を比べ、モデルのtiltが「市場一番人気より当てているか」を確かめる。
//   ＝tiltが当てていなければ素直に市場一番人気に寄せた方が正直で良い。
//
// データの作り方(重要):
//   過去レースファイル(races/)は事前オッズが null のことが多い。
//   結果ファイル(results/)には確定オッズ・着順・人気がある。
//   → races の各馬に results の確定オッズ(win_odds)を差し込んでから予測する。
//     (アプリは締切直前のほぼ確定オッズで動く＝この入力は実態に近い。
//      モデル本命と市場一番人気の両方が同じオッズを使うので比較は公平。)
//
// 使い方: node scripts/backtest-honmei.cjs            (全期間)
//        node scripts/backtest-honmei.cjs --last 1500 (直近1500レースだけ)
//        KEIBA_MODEL_BETA=0.15 node scripts/backtest-honmei.cjs (設定を変えて試す)
// ============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const { buildConclusion } = require(path.join(__dirname, "..", "lib", "conclusion.js"));

const ROOT = path.resolve(__dirname, "..");
const RACES = path.join(ROOT, "data", "jv_cache", "races");
const RESULTS = path.join(ROOT, "data", "jv_cache", "results");

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

function main() {
  const args = process.argv.slice(2);
  const lastIdx = args.indexOf("--last");
  const lastN = lastIdx >= 0 ? Number(args[lastIdx + 1]) : null;

  let resFiles = fs.readdirSync(RESULTS).filter(f => f.endsWith(".json")).sort();
  if (Number.isFinite(lastN) && lastN > 0) resFiles = resFiles.slice(-lastN);

  let used = 0, skipped = 0;
  // 集計箱
  const mk = () => ({ win: 0, place: 0, n: 0 });
  const model = mk();      // モデル本命
  const market = mk();     // 市場一番人気
  let sameAsMarket = 0;    // モデル本命=市場一番人気だった回数
  let modelWinWhenDiffer = 0, marketWinWhenDiffer = 0, differN = 0; // 意見が割れた時どちらが当たったか
  // 較正チェック: モデル本命の予想勝率の合計 vs 実際の勝ち数
  let probSum = 0;

  for (const f of resFiles) {
    const res = readJson(path.join(RESULTS, f));
    const race = readJson(path.join(RACES, f));
    if (!res || !Array.isArray(res.results) || !race || !Array.isArray(race.horses)) { skipped++; continue; }

    // 着順・確定オッズを馬番でひく
    const rankByNum = {}, oddsByNum = {};
    for (const r of res.results) {
      const n = Number(r.number), rank = Number(r.rank), o = Number(r.win_odds);
      if (Number.isFinite(n) && Number.isFinite(rank) && rank >= 1) rankByNum[n] = rank;
      if (Number.isFinite(n) && Number.isFinite(o) && o > 1) oddsByNum[n] = o;
    }
    const oddsCount = Object.keys(oddsByNum).length;
    if (oddsCount < 2 || Object.keys(rankByNum).length < 2) { skipped++; continue; }

    // races の馬に確定オッズを差し込む(事前オッズが無い過去レース対策)
    const horses = race.horses.map(h => ({
      ...h,
      win_odds: Number.isFinite(oddsByNum[h.number]) ? oddsByNum[h.number] : (Number.isFinite(Number(h.win_odds)) ? Number(h.win_odds) : null),
    }));
    const injected = { ...race, horses, is_dummy: false };

    let c;
    try { c = buildConclusion(injected); } catch { skipped++; continue; }
    const honmei = c && Array.isArray(c.picks) && c.picks[0] ? c.picks[0] : null;
    if (!honmei || honmei.number == null) { skipped++; continue; }

    // 市場一番人気 = 確定オッズ最少の馬
    let favNum = null, favOdds = Infinity;
    for (const [n, o] of Object.entries(oddsByNum)) { if (o < favOdds) { favOdds = o; favNum = Number(n); } }
    if (favNum == null) { skipped++; continue; }

    const hRank = rankByNum[honmei.number];
    const fRank = rankByNum[favNum];
    if (hRank == null || fRank == null) { skipped++; continue; }

    used++;
    // モデル本命
    model.n++; if (hRank === 1) model.win++; if (hRank <= 3) model.place++;
    if (Number.isFinite(honmei.prob)) probSum += honmei.prob;
    // 市場一番人気
    market.n++; if (fRank === 1) market.win++; if (fRank <= 3) market.place++;

    if (honmei.number === favNum) sameAsMarket++;
    else {
      differN++;
      if (hRank === 1) modelWinWhenDiffer++;
      if (fRank === 1) marketWinWhenDiffer++;
    }
  }

  const pct = (a, b) => b > 0 ? (100 * a / b).toFixed(1) + "%" : "—";
  console.log(`\n=== 本命の当たり具合バックテスト ===`);
  console.log(`BETA=${process.env.KEIBA_MODEL_BETA ?? "(既定)"} ODDS_CAP=${process.env.KEIBA_ODDS_CAP ?? "(既定)"} EDGE_CAP=${process.env.KEIBA_EDGE_CAP ?? "(既定)"}`);
  console.log(`対象: ${used} レース (スキップ ${skipped})`);
  console.log(`\n               単勝的中(1着)   複勝(3着内)`);
  console.log(`モデル本命     ${pct(model.win, model.n).padStart(8)}      ${pct(model.place, model.n).padStart(8)}   (${model.win}/${model.n})`);
  console.log(`市場一番人気   ${pct(market.win, market.n).padStart(8)}      ${pct(market.place, market.n).padStart(8)}   (${market.win}/${market.n})`);
  console.log(`\nモデル本命=市場一番人気: ${pct(sameAsMarket, used)} (${sameAsMarket}/${used})`);
  console.log(`意見が割れたレース: ${differN}件 → そのうち`);
  console.log(`  モデル本命が1着: ${pct(modelWinWhenDiffer, differN)} (${modelWinWhenDiffer}/${differN})`);
  console.log(`  市場一番人気が1着: ${pct(marketWinWhenDiffer, differN)} (${marketWinWhenDiffer}/${differN})`);
  console.log(`\n較正チェック: モデル本命の予想勝率 平均 ${pct(probSum, model.n)} vs 実際の単勝的中 ${pct(model.win, model.n)}`);
  console.log(`  (この2つが近いほど「勝率○○%」表示が正直＝信用できる)`);

  // 判定材料(改善があったかの目安)
  const modelWin = model.n ? model.win / model.n : 0;
  const mktWin = market.n ? market.win / market.n : 0;
  console.log(`\n要約: モデル本命は市場一番人気より単勝的中が ${((modelWin - mktWin) * 100).toFixed(2)}pt ${modelWin >= mktWin ? "高い(良い)" : "低い(=tiltが当てを下げている疑い)"}`);
}

main();
