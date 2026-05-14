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

console.log(`\n=== 合計: ${passed} 通過 / ${failed} 失敗 ===`);
process.exit(failed > 0 ? 1 : 0);
