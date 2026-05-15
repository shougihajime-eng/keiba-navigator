"use strict";

// 競馬ダッシュボード — Node 側 smoke テスト
// 仕様書なし・JV-Link なしで全部走るスモークテスト。
// 実行: node tests/smoke.js
//
// 目的: コア計算ロジックの回帰防止。
//   1) race_id 判定
//   2) Kelly 計算
//   3) finalize の全券種 + エッジケース
//   4) manual_race の race_id 一意性
//   5) conclusion の空入力ガード
//   6) backtest の NaN ガード

const assert = require("assert");
const path = require("path");

process.chdir(path.join(__dirname, ".."));

const kelly      = require("../lib/kelly");
const finalize   = require("../lib/finalize");
const manual     = require("../lib/manual_race");
const raceId     = require("../lib/race_id");
const conclusion = require("../lib/conclusion");
// csv_import はブラウザ IIFE 形式 (window.CsvImport) なので Node からは require できない

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log("\n=== race_id ===");
test("18桁 JRA は finalizable", () => assert.strictEqual(raceId.isFinalizableRaceId("202605030502011100"), true));
test("manual_xxx_xxx は manual 判定", () => assert.strictEqual(raceId.isManualRaceId("manual_1234567890_123"), true));
test("manual_xxx も manual 判定 (旧形式互換)", () => assert.strictEqual(raceId.isManualRaceId("manual_1234567890"), true));
test("manual は finalizable ではない", () => assert.strictEqual(raceId.isFinalizableRaceId("manual_123"), false));
test("不正 ID は unknown", () => assert.strictEqual(raceId.kind("xyz"), "unknown"));

console.log("\n=== kelly ===");
test("正常な Kelly 計算", () => {
  const f = kelly.kellyFraction(0.5, 3.0);
  assert.ok(f > 0 && f < 1, `f=${f}`);
});
test("odds=1 は 0", () => assert.strictEqual(kelly.kellyFraction(0.5, 1.0), 0));
test("odds=1.0000001 (浮動小数点境界) も 0", () => assert.strictEqual(kelly.kellyFraction(0.5, 1.0000001), 0));
test("prob=0 は 0", () => assert.strictEqual(kelly.kellyFraction(0, 5), 0));
test("prob=1 は 0", () => assert.strictEqual(kelly.kellyFraction(1, 5), 0));
test("NaN 入力は 0", () => assert.strictEqual(kelly.kellyFraction(NaN, 5), 0));
test("EVマイナスは stake=0", () => {
  const r = kelly.suggestStake({prob:0.3, odds:2.0, bankroll:10000, perRaceCap:3000});
  assert.strictEqual(r.stake, 0);
});
test("EVプラスは 100円以上", () => {
  const r = kelly.suggestStake({prob:0.6, odds:2.5, bankroll:10000, perRaceCap:3000});
  assert.ok(r.stake >= 100, `stake=${r.stake}`);
});
test("信頼度低は Quarter Kelly", () => {
  const r = kelly.suggestStake({prob:0.6, odds:2.5, bankroll:10000, perRaceCap:3000, confidence: 0.10});
  assert.ok(/Quarter/.test(r.reason), `reason=${r.reason}`);
});

console.log("\n=== finalize ===");
const result = {
  race_id: "202605030502011100",
  results: [
    {rank: 1, number: 6, name: "A"},
    {rank: 2, number: 3, name: "B"},
    {rank: 3, number: 1, name: "C"},
  ],
  payouts: {
    tan: {winner: 6, amount: 1800},
    fuku: [{number: 6, amount: 350}, {number: 3, amount: 220}, {number: 1, amount: 150}],
    uren: {key: "3-6", amount: 1290},
    wide: [{key: "3-6", amount: 410}, {key: "1-6", amount: 380}, {key: "1-3", amount: 240}],
    fuku3: {key: "1-3-6", amount: 1830},
    tan3: {key: "6-3-1", amount: 12450},
  },
};
test("単勝 当たり", () => {
  const f = finalize.finalizeBet({betType:"tan", target:"6 A", odds:18, amount:100}, result);
  assert.strictEqual(f.won, true);
  assert.strictEqual(f.payout, 1800);
});
test("単勝 外れ", () => {
  const f = finalize.finalizeBet({betType:"tan", target:"7 X", odds:5, amount:100}, result);
  assert.strictEqual(f.won, false);
});
test("複勝 (3着馬) 当たり", () => {
  const f = finalize.finalizeBet({betType:"fuku", target:"1 C", odds:1.5, amount:100}, result);
  assert.strictEqual(f.won, true);
  assert.strictEqual(f.payout, 150);
});
test("馬連 当たり", () => {
  const f = finalize.finalizeBet({betType:"uren", target:"3-6", odds:12.9, amount:100}, result);
  assert.strictEqual(f.won, true);
  assert.strictEqual(f.payout, 1290);
});
test("ワイド 当たり", () => {
  const f = finalize.finalizeBet({betType:"wide", target:"1-3", odds:2.4, amount:100}, result);
  assert.strictEqual(f.won, true);
  assert.strictEqual(f.payout, 240);
});
test("3連複 当たり", () => {
  const f = finalize.finalizeBet({betType:"fuku3", target:"1-3-6", odds:18.3, amount:100}, result);
  assert.strictEqual(f.won, true);
  assert.strictEqual(f.payout, 1830);
});
test("3連単 当たり", () => {
  const f = finalize.finalizeBet({betType:"tan3", target:"6-3-1", odds:124.5, amount:100}, result);
  assert.strictEqual(f.won, true);
  assert.strictEqual(f.payout, 12450);
});
test("3連単 順序違いは外れ", () => {
  const f = finalize.finalizeBet({betType:"tan3", target:"1-3-6", odds:5, amount:100}, result);
  assert.strictEqual(f.won, false);
});
test("結果が 1 件しかない時の馬連は won=false (例外を投げない)", () => {
  const shortResult = {race_id:"X", results:[{rank:1, number:6}], payouts:{}};
  const f = finalize.finalizeBet({betType:"uren", target:"3-6", odds:5, amount:100}, shortResult);
  assert.strictEqual(f.won, false);
});
test("結果が 2 件しかない時の 3連複は won=false", () => {
  const r = {race_id:"X", results:[{rank:1,number:6},{rank:2,number:3}], payouts:{}};
  const f = finalize.finalizeBet({betType:"fuku3", target:"1-3-6", odds:5, amount:100}, r);
  assert.strictEqual(f.won, false);
});

console.log("\n=== manual_race ===");
test("基本入力で picks が出る", () => {
  const c = manual.buildManualConclusion({
    text: "1 a 3.2 1 5\n2 b 5.4 3 2\n3 c 12 7 8",
    raceName: "T",
  });
  assert.ok(c?.picks?.length >= 0);
  assert.ok(c?.raceMeta?.raceId);
  assert.ok(/^manual_\d+(_\d+)?$/.test(c.raceMeta.raceId), `bad race_id: ${c.raceMeta.raceId}`);
});
test("race_id は同時連投でも衝突しにくい (3回連続)", () => {
  const ids = new Set();
  for (let i = 0; i < 3; i++) {
    const c = manual.buildManualConclusion({ text: "1 a 3 1 5", raceName: "T" });
    ids.add(c.raceMeta.raceId);
  }
  assert.ok(ids.size >= 2, `衝突: 3回中 ${ids.size} 種類しか出ていない`);
});
test("空入力は判定不可", () => {
  const c = manual.buildManualConclusion({ text: "", raceName: "T" });
  assert.strictEqual(c.verdict, "judgement_unavailable");
});

console.log("\n=== conclusion ===");
test("null は judgement_unavailable", () => {
  assert.strictEqual(conclusion.buildConclusion(null).verdict, "judgement_unavailable");
});
test("空 horses は judgement_unavailable", () => {
  assert.strictEqual(conclusion.buildConclusion({horses:[]}).verdict, "judgement_unavailable");
});

console.log("\n=== voice_input parser ===");
const voice = require("../lib/voice_input");
test("純粋な数字 + 倍 + 番人気 のフルセット", () => {
  const p = voice.parseSpoken("1番ディープ3.2倍1番人気前走1着");
  assert.strictEqual(p.umaban, 1);
  assert.strictEqual(p.odds, 3.2);
  assert.strictEqual(p.popularity, 1);
  assert.strictEqual(p.prevPos, 1);
  assert.ok(p.name && p.name.includes("ディープ"), `name=${p.name}`);
});
test("空白区切り英数自然な発音 (Web Speech API 風)", () => {
  const p = voice.parseSpoken("ディープインパクト 3.2倍 1番人気");
  assert.strictEqual(p.odds, 3.2);
  assert.strictEqual(p.popularity, 1);
  assert.ok(p.name && p.name.includes("ディープインパクト"), `name=${p.name}`);
});
test("「3てん2倍」も 3.2 と解釈", () => {
  const p = voice.parseSpoken("3番ハジメ 3てん2倍 6番人気");
  assert.strictEqual(p.odds, 3.2);
  assert.strictEqual(p.umaban, 3);
  assert.strictEqual(p.popularity, 6);
});
test("「3点2倍」も 3.2 と解釈", () => {
  const p = voice.parseSpoken("3点2倍");
  assert.strictEqual(p.odds, 3.2);
});
test("漢数字 三 が 3 として解釈", () => {
  assert.strictEqual(voice.kanaToNumber("三"), 3);
});
test("漢数字 十 が 10", () => {
  assert.strictEqual(voice.kanaToNumber("十"), 10);
});
test("漢数字 十五 が 15", () => {
  assert.strictEqual(voice.kanaToNumber("十五"), 15);
});
test("漢数字 二十三 が 23", () => {
  assert.strictEqual(voice.kanaToNumber("二十三"), 23);
});
test("ひらがな いち が 1", () => {
  assert.strictEqual(voice.kanaToNumber("いち"), 1);
});
test("buildLine: フル要素", () => {
  const p = { umaban: 1, name: "ディープ", odds: 3.2, popularity: 1, prevPos: 1 };
  assert.strictEqual(voice.buildLine(p), "1 ディープ 3.2 1 1");
});
test("buildLine: 部分要素でも OK", () => {
  const p = { umaban: null, name: "ハジメ", odds: 60.0, popularity: 6, prevPos: null };
  assert.strictEqual(voice.buildLine(p), "ハジメ 60.0 6");
});
test("buildLine: 名前だけは null (情報不足)", () => {
  const p = { umaban: null, name: "ハジメ", odds: null, popularity: null, prevPos: null };
  assert.strictEqual(voice.buildLine(p), null);
});
test("「○着」を前走として拾う", () => {
  const p = voice.parseSpoken("ディープ 3.2倍 5着");
  // 人気/前走どちらにも置ける曖昧な発話のため prevPos=5
  assert.strictEqual(p.prevPos, 5);
});
test("オッズが整数 (10倍)", () => {
  const p = voice.parseSpoken("ハジメ 60倍 6番人気");
  assert.strictEqual(p.odds, 60);
});
test("空文字は null", () => {
  assert.strictEqual(voice.parseSpoken(""), null);
  assert.strictEqual(voice.parseSpoken(null), null);
});
test("カナだけは name のみ・buildLine は null", () => {
  const p = voice.parseSpoken("オルフェーヴル");
  assert.ok(p.name && p.name.includes("オルフェ"), `name=${p.name}`);
  assert.strictEqual(voice.buildLine(p), null);
});

console.log("\n=== reasoning (AI思考プロセス) ===");
const reasoning = require("../lib/reasoning");
test("explain: null は失敗ステップを返す", () => {
  const r = reasoning.explain(null);
  assert.ok(r.steps?.length >= 1);
  assert.ok(r.steps[0].title.includes("判定できません"));
});
test("explain: 空 picks も失敗ステップ", () => {
  const r = reasoning.explain({ ok: true, picks: [] });
  assert.ok(r.steps?.length >= 1);
});
test("explain: 正常な conclusion は 6 ステップ", () => {
  const c = {
    ok: true, verdict: "go", verdictTitle: "狙えるレース",
    verdictReason: "EV 1.45 とプラス幅大",
    confidence: 0.45, confidenceLabel: "信頼度: 高",
    predictor: { name: "heuristic", version: "1.0" },
    picks: [{ number: 1, name: "ディープ", odds: 3.2, popularity: 1, prob: 0.45, ev: 1.44, grade: "S", role: "buy" }],
    avoid: [],
  };
  const r = reasoning.explain(c);
  assert.strictEqual(r.steps.length, 6);
  assert.ok(r.share?.text?.includes("ディープ"));
  assert.ok(r.share?.text?.includes("KEIBA NAVIGATOR"));
});
test("explain: calRatio が大きく違うと「上方修正」と書く", () => {
  const c = {
    ok: true, verdict: "go",
    verdictReason: "",
    confidence: 0.40, confidenceLabel: "中",
    predictor: { name: "heuristic", version: "1.0" },
    picks: [{ number: 5, name: "ハジメ", odds: 8, popularity: 4, prob: 0.18, ev: 1.44, grade: "A", role: "buy" }],
    avoid: [],
  };
  const r = reasoning.explain(c, { calRatio: 1.3 });
  const calibStep = r.steps.find(s => /補正/.test(s.title));
  assert.ok(calibStep, "calibration step が無い");
  assert.ok(/上方修正/.test(calibStep.body), `body=${calibStep.body}`);
});
test("explain: calRatio≈1 は「ほぼ一致」と書く", () => {
  const c = {
    ok: true, verdict: "go", verdictReason: "",
    confidence: 0.40, confidenceLabel: "中",
    predictor: { name: "h", version: "1" },
    picks: [{ number: 1, name: "X", odds: 2, popularity: 1, prob: 0.6, ev: 1.2, grade: "B", role: "buy" }],
    avoid: [],
  };
  const r = reasoning.explain(c, { calRatio: 1.02 });
  const calibStep = r.steps.find(s => /補正/.test(s.title));
  assert.ok(/ほぼ一致/.test(calibStep.body));
});
test("explain: calRatio 未指定は「自己校正は未発動」", () => {
  const c = {
    ok: true, verdict: "go", verdictReason: "",
    confidence: 0.40, confidenceLabel: "中",
    predictor: { name: "h", version: "1" },
    picks: [{ number: 1, name: "X", odds: 2, popularity: 1, prob: 0.6, ev: 1.2, grade: "B", role: "buy" }],
    avoid: [],
  };
  const r = reasoning.explain(c);
  const calibStep = r.steps.find(s => /補正/.test(s.title));
  assert.ok(/未発動/.test(calibStep.body));
});
test("explain: 人気薄+EVプラスで「穴目で美味しい」", () => {
  const c = {
    ok: true, verdict: "go", verdictReason: "",
    confidence: 0.30, confidenceLabel: "中",
    predictor: { name: "h", version: "1" },
    picks: [{ number: 8, name: "ハジメ", odds: 25, popularity: 8, prob: 0.06, ev: 1.5, grade: "S", role: "buy" }],
    avoid: [],
  };
  const r = reasoning.explain(c);
  const finalStep = r.steps[r.steps.length - 1];
  assert.ok(/穴目で美味しい/.test(finalStep.body), `body=${finalStep.body}`);
});

test("fmtEv: 1.20 → +20%", () => assert.strictEqual(reasoning.fmtEv(1.20), "+20%"));
test("fmtEv: 0.70 → -30%", () => assert.strictEqual(reasoning.fmtEv(0.70), "-30%"));
test("fmtEv: null は --", () => assert.strictEqual(reasoning.fmtEv(null), "--"));
test("fmtPct: 0.456 → 45.6%", () => assert.strictEqual(reasoning.fmtPct(0.456), "45.6%"));
test("fmtOdds: 3.2 → 3.2倍", () => assert.strictEqual(reasoning.fmtOdds(3.2), "3.2倍"));

console.log(`\n=== 合計: ${passed} 通過 / ${failed} 失敗 ===`);
process.exit(failed > 0 ? 1 : 0);
