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

console.log("\n=== ocr.parseToLines ===");
const ocr = require("../lib/ocr");
test("空文字は []", () => {
  assert.deepStrictEqual(ocr.parseToLines(""), []);
  assert.deepStrictEqual(ocr.parseToLines(null), []);
});
test("「1 ディープ 3.2」は 1 行抽出", () => {
  const lines = ocr.parseToLines("1 ディープ 3.2");
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].includes("ディープ"));
  assert.ok(lines[0].includes("3.2"));
  assert.ok(lines[0].startsWith("1"));
});
test("複数行 (3 頭) を 3 行に", () => {
  const raw = "1 ディープ 3.2 1人気\n2 オルフェ 5.5 2人気\n3 キタサン 8.0";
  const lines = ocr.parseToLines(raw);
  assert.strictEqual(lines.length, 3);
});
test("ノイズ行(数字なし・カナ少ない)は除外", () => {
  const raw = "コーナー\n1 ディープ 3.2\n--\n3 キタサン 8.0";
  const lines = ocr.parseToLines(raw);
  assert.strictEqual(lines.length, 2);
});
test("「番人気」を popularity として拾う", () => {
  const lines = ocr.parseToLines("3 ハジメ 60.5 6番人気");
  assert.ok(lines[0].endsWith(" 6"), `line=${lines[0]}`);
});
test("馬番 > 30 は無視", () => {
  // 99 という大きな整数だけのケース: 馬番として拾わない
  const lines = ocr.parseToLines("99 ばかうま 3.2");
  // 99 は umaban に入らないが、3.2 と name はある → 採用される
  assert.strictEqual(lines.length, 1);
  // 馬番は採用されていない: 先頭が umaban の番号ではない
  assert.ok(!lines[0].startsWith("99 "));
});

console.log("\n=== help / KNHelp ===");
// help.js は IIFE で window がないと走らない部分があるが、
// FAQ 配列の妥当性チェックは内部状態として確認できる
// ファイル単体読み込みで構文エラーがないことだけ確認
test("help.js は構文エラーなく読み込める", () => {
  const fs = require("fs");
  const code = fs.readFileSync("lib/help.js", "utf8");
  new Function(code);  // SyntaxError があればここで throw
});

console.log("\n=== demo_races ===");
const demoRaces = require("../lib/demo_races");
test("DEMO_RACES は 5 件", () => assert.strictEqual(demoRaces.DEMO_RACES.length, 5));
test("各レースに必須フィールドがある", () => {
  for (const r of demoRaces.DEMO_RACES) {
    assert.ok(r.id && r.name && r.course && Array.isArray(r.horses), `incomplete: ${r.id}`);
    assert.ok(r.horses.length >= 4, `${r.id} has too few horses: ${r.horses.length}`);
  }
});
test("各馬に必須フィールドがある", () => {
  for (const r of demoRaces.DEMO_RACES) {
    for (const h of r.horses) {
      assert.ok(h.number > 0 && h.number <= 30, `${r.id}: bad umaban ${h.number}`);
      assert.ok(h.name && h.name.length > 0, `${r.id}: no name`);
      assert.ok(h.odds > 0, `${r.id} ${h.name}: bad odds ${h.odds}`);
      assert.ok(h.popularity > 0 && h.popularity <= 30, `${r.id} ${h.name}: bad popularity ${h.popularity}`);
    }
  }
});
test("toTextarea: 行数 == 頭数", () => {
  const r = demoRaces.DEMO_RACES[0];
  const lines = demoRaces.toTextarea(r).split("\n");
  assert.strictEqual(lines.length, r.horses.length);
});
test("toTextarea: フォーマット = '馬番 馬名 オッズ 人気 前走'", () => {
  const r = demoRaces.DEMO_RACES[0];
  const first = demoRaces.toTextarea(r).split("\n")[0];
  const parts = first.split(" ");
  assert.strictEqual(parts.length, 5);
  assert.ok(/^\d+$/.test(parts[0]), `umaban not int: ${parts[0]}`);
  assert.ok(/^\d+\.\d+$/.test(parts[2]), `odds not decimal: ${parts[2]}`);
});
test("toTextarea で出力された行が manual_race.parseLine と互換", () => {
  const r = demoRaces.DEMO_RACES[0];
  const line = demoRaces.toTextarea(r).split("\n")[0];
  const parsed = manual.parseLine(line);
  assert.ok(parsed && parsed.number != null, `couldn't parse umaban from: ${line}`);
  assert.ok(parsed.name === r.horses[0].name, `name mismatch: ${parsed.name} vs ${r.horses[0].name}`);
  assert.ok(parsed.win_odds === r.horses[0].odds, `odds mismatch: ${parsed.win_odds} vs ${r.horses[0].odds}`);
});

console.log("\n=== onboarding / animate / share_image / whatif / achievements 構文 ===");
test("onboarding.js 構文 OK", () => { new Function(require("fs").readFileSync("lib/onboarding.js", "utf8")); });
test("animate.js 構文 OK",     () => { new Function(require("fs").readFileSync("lib/animate.js", "utf8")); });
test("share_image.js 構文 OK", () => { new Function(require("fs").readFileSync("lib/share_image.js", "utf8")); });
test("whatif.js 構文 OK",      () => { new Function(require("fs").readFileSync("lib/whatif.js", "utf8")); });
test("achievements.js 構文 OK",() => { new Function(require("fs").readFileSync("lib/achievements.js", "utf8")); });
test("daily_brief.js 構文 OK", () => { new Function(require("fs").readFileSync("lib/daily_brief.js", "utf8")); });
test("ai_voice.js 構文 OK",    () => { new Function(require("fs").readFileSync("lib/ai_voice.js", "utf8")); });
test("glossary.js 構文 OK",    () => { new Function(require("fs").readFileSync("lib/glossary.js", "utf8")); });
test("tactile.js 構文 OK",     () => { new Function(require("fs").readFileSync("lib/tactile.js", "utf8")); });
test("sparkle.js 構文 OK",     () => { new Function(require("fs").readFileSync("lib/sparkle.js", "utf8")); });

// ─── Wave9 追加モジュール ─────────────────────────────────
console.log("\n=== Wave9: ensemble_v1 predictor ===");
const ensemble = require("../predictors/ensemble_v1");
test("ensemble_v1 が space 出力", () => assert.strictEqual(ensemble.name, "ensemble_v1"));
test("ensemble.predict が空 race で null", () => assert.strictEqual(ensemble.predict({ horses: [] }), null));
test("ensemble.predict で probs 合計 ≈ 1", () => {
  const race = {
    race_id: "test1", distance: 1600, course: "東京芝1600",
    horses: [
      { number: 1, name: "A", win_odds: 2.5, prev_finish: 1, weight: 56 },
      { number: 2, name: "B", win_odds: 6.0, prev_finish: 3, weight: 55 },
      { number: 3, name: "C", win_odds: 20.0, prev_finish: 8, weight: 54 },
    ],
  };
  const p = ensemble.predict(race);
  assert.ok(p, "prediction is null");
  const sum = p.horses.reduce((a, h) => a + h.prob, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-6, `sum=${sum}`);
});
test("ensemble.predict で 1着候補 = オッズ最小に近い", () => {
  const race = {
    race_id: "test2", distance: 1600,
    horses: [
      { number: 1, name: "A", win_odds: 1.8, prev_finish: 1, weight: 56 },
      { number: 2, name: "B", win_odds: 50, prev_finish: 10, weight: 56 },
      { number: 3, name: "C", win_odds: 30, prev_finish: 6, weight: 56 },
    ],
  };
  const p = ensemble.predict(race);
  const top = p.horses.slice().sort((a, b) => b.prob - a.prob)[0];
  assert.strictEqual(top.number, 1, `top=${top.number}`);
});
test("ensemble.predictPace で逃げ多→tempo>0", () => {
  const pace = ensemble.predictPace({ horses: [
    { number: 1, _jv: { runStyleId: 1 } },
    { number: 2, _jv: { runStyleId: 1 } },
    { number: 3, _jv: { runStyleId: 2 } },
    { number: 4, _jv: { runStyleId: 4 } },
  ] });
  assert.ok(pace.tempo > 0, `tempo=${pace.tempo}`);
});
test("ensemble.predictPace で差し追い込み多→tempo<0", () => {
  const pace = ensemble.predictPace({ horses: [
    { number: 1, _jv: { runStyleId: 3 } },
    { number: 2, _jv: { runStyleId: 3 } },
    { number: 3, _jv: { runStyleId: 4 } },
    { number: 4, _jv: { runStyleId: 4 } },
    { number: 5, _jv: { runStyleId: 4 } },
    { number: 6, _jv: { runStyleId: 2 } },
  ] });
  assert.ok(pace.tempo < 0, `tempo=${pace.tempo}`);
});

console.log("\n=== Wave9: track_bias ===");
const trackBias = require("../lib/track_bias");
test("track_bias の inferGoingId('良') == 0", () => assert.strictEqual(trackBias.inferGoingId("良"), 0));
test("track_bias の inferGoingId('稍重') == 1", () => assert.strictEqual(trackBias.inferGoingId("稍重"), 1));
test("track_bias の inferGoingId('重') == 2", () => assert.strictEqual(trackBias.inferGoingId("重"), 2));
test("track_bias.getVenueBias('新潟') は外差し馬場", () => {
  const v = trackBias.getVenueBias("新潟芝1600");
  assert.ok(v.frontBias < 0, `frontBias=${v.frontBias}`);
  assert.ok(v.railBias < 0, `railBias=${v.railBias}`);
});
test("track_bias.computeBiasAdjustment が finite", () => {
  const race = { course: "東京芝1600", going: "良", weather: "晴" };
  const horse = { number: 1, waku: 3, _jv: { runStyleId: 2 } };
  const adj = trackBias.computeBiasAdjustment(race, horse);
  assert.ok(Number.isFinite(adj.adjustment), `adj=${adj.adjustment}`);
});
test("track_bias.describeBias がフラット時に説明出す", () => {
  const note = trackBias.describeBias({ course: "東京芝1600", going: "良", weather: "晴" });
  assert.ok(typeof note === "string" && note.length > 0);
});
test("track_bias 重い馬場で内枠補正が正方向", () => {
  const race = { course: "東京芝1600", going: "重", weather: "雨" };
  const inner = trackBias.computeBiasAdjustment(race, { number: 1, waku: 1, _jv: { runStyleId: 2 } });
  const outer = trackBias.computeBiasAdjustment(race, { number: 14, waku: 8, _jv: { runStyleId: 2 } });
  assert.ok(inner.adjustment > outer.adjustment, `inner=${inner.adjustment} outer=${outer.adjustment}`);
});

console.log("\n=== Wave9: news_sentiment ===");
const newsSentiment = require("../lib/news_sentiment");
test("ポジ keyword で score 正", () => {
  const c = newsSentiment.classifyHeadline("ディープ復活、好走で重賞制覇");
  assert.ok(c.score > 0, `score=${c.score}`);
});
test("ネガ keyword で score 負", () => {
  const c = newsSentiment.classifyHeadline("◯◯号は故障で回避");
  assert.ok(c.score < 0, `score=${c.score}`);
});
test("無関係 keyword で score 0", () => {
  const c = newsSentiment.classifyHeadline("天気予報は晴れ");
  assert.strictEqual(c.score, 0);
});
test("annotateRaceWithNews が馬名マッチ", () => {
  const race = { horses: [{ number: 5, name: "ディープインパクト", jockey: null, trainer: null }] };
  const news = [{ title: "ディープインパクト 故障で回避", link: "x" }];
  const out = newsSentiment.annotateRaceWithNews(race, news);
  assert.ok(out.byHorseNumber[5], "no annotation");
  assert.ok(out.byHorseNumber[5].score < 0, `score=${out.byHorseNumber[5].score}`);
});
test("badge が warn を返す (score<=-0.8)", () => {
  const b = newsSentiment.badge({ score: -1.2 });
  assert.strictEqual(b.type, "warn");
});
test("badge が good を返す (score>=0.8)", () => {
  const b = newsSentiment.badge({ score: 1.1 });
  assert.strictEqual(b.type, "good");
});
test("badge が null (中立)", () => assert.strictEqual(newsSentiment.badge({ score: 0.3 }), null));

console.log("\n=== Wave9: win5_engine ===");
const win5engine = require("../lib/win5_engine");
test("buildWin5 が空配列で ok:false", () => {
  const w = win5engine.buildWin5([]);
  assert.strictEqual(w.ok, false);
});
test("buildWin5 が 5 レースで 3 戦略を出す", () => {
  // 簡易な race を 5 つ作成
  const makeRace = (idx) => ({
    race_id: `test_${idx}`, race_name: `R${idx}`, distance: 1600,
    horses: [
      { number: 1, win_odds: 2.5, prev_finish: 1, weight: 56 },
      { number: 2, win_odds: 5.0, prev_finish: 3, weight: 55 },
      { number: 3, win_odds: 8.0, prev_finish: 5, weight: 56 },
      { number: 4, win_odds: 15, prev_finish: 7, weight: 54 },
    ],
  });
  const races = [makeRace(1), makeRace(2), makeRace(3), makeRace(4), makeRace(5)];
  const w = win5engine.buildWin5(races);
  assert.strictEqual(w.ok, true, `not ok: ${w.note}`);
  assert.ok(w.strategies.safe.combo === 1, `safe=${w.strategies.safe.combo}`);
  assert.ok(w.strategies.mid.combo === 32, `mid=${w.strategies.mid.combo}`);
  assert.ok(w.strategies.wide.combo === 243, `wide=${w.strategies.wide.combo}`);
});
test("buildWin5 が推奨を返す", () => {
  const makeRace = (idx) => ({
    race_id: `t_${idx}`, race_name: `R${idx}`, distance: 1400,
    horses: [
      { number: 1, win_odds: 2.0, prev_finish: 1, weight: 56 },
      { number: 2, win_odds: 4.0, prev_finish: 2, weight: 56 },
      { number: 3, win_odds: 10, prev_finish: 6, weight: 56 },
    ],
  });
  const races = [makeRace(1), makeRace(2), makeRace(3), makeRace(4), makeRace(5)];
  const w = win5engine.buildWin5(races);
  assert.ok(["safe", "mid", "wide"].includes(w.recommended), `recommended=${w.recommended}`);
});

console.log("\n=== Wave9: 構文チェック ===");
test("all_races_view.js 構文 OK", () => { new Function(require("fs").readFileSync("lib/all_races_view.js", "utf8")); });
test("roi_dashboard.js 構文 OK", () => { new Function(require("fs").readFileSync("lib/roi_dashboard.js", "utf8")); });
test("ensemble_v1.js 構文 OK", () => { new Function(require("fs").readFileSync("predictors/ensemble_v1.js", "utf8")); });

// ─── QA2: 最終 QA 第 2 弾で追加された機能の回帰防止 ───────────
console.log("\n=== QA2: ensemble_v1.scoreCareerForm (新規 7 番目の弱学習器) ===");
const { _internal: ens } = require("../predictors/ensemble_v1");
test("scoreCareerForm: 全 null は 1.0 (中立)", () => {
  const s = ens.scoreCareerForm({});
  assert.strictEqual(s, 1.0);
});
test("scoreCareerForm: careerPrizeNorm が高い (1.5) と上方補正", () => {
  const s = ens.scoreCareerForm({ careerPrizeNorm: 1.5 });
  assert.ok(s > 1.2, `expected >1.2, got ${s}`);
});
test("scoreCareerForm: 新馬 (careerPrizeNorm=0) は減点", () => {
  const s = ens.scoreCareerForm({ careerPrizeNorm: 0 });
  assert.ok(s < 1.0, `expected <1.0, got ${s}`);
});
test("scoreCareerForm: 体重偏差が極端 (>1.5) なら軽い減点", () => {
  const s = ens.scoreCareerForm({ bodyWeightDeviation: 2.0 });
  assert.ok(s < 1.0 && s > 0.85, `expected 0.85-1.0, got ${s}`);
});
test("scoreCareerForm: 騎手複勝率 0.50 で上方補正", () => {
  const s = ens.scoreCareerForm({ jockeyInThreeRate: 0.50 });
  assert.ok(s > 1.0, `expected >1.0, got ${s}`);
});
test("scoreCareerForm: 騎手複勝率 0.15 で下方補正", () => {
  const s = ens.scoreCareerForm({ jockeyInThreeRate: 0.15 });
  assert.ok(s < 1.0, `expected <1.0, got ${s}`);
});
test("computeWeights: career が weights に含まれる", () => {
  const w = ens.computeWeights({ ratio: 0.5 });
  assert.ok(typeof w.career === "number" && w.career > 0, `career weight missing: ${w.career}`);
});

console.log("\n=== QA2: WIN5 配当定数の整合 ===");
const win5Client = require("fs").readFileSync("predictors/win5.js", "utf8");
test("predictors/win5.js PAYOUT_MID が 800 万円 (サーバ側 lib/win5_engine.js と一致)", () => {
  const m = win5Client.match(/PAYOUT_MID\s*=\s*(\d+)/);
  assert.ok(m, "PAYOUT_MID not found");
  assert.strictEqual(Number(m[1]), 8_000_000);
});

console.log("\n=== QA2: features.js に新規キーが揃っている ===");
const { extractFeatures, dataCompleteness } = require("../predictors/features");
test("extractFeatures: careerPrizeNorm / bodyWeightDeviation を返す", () => {
  const h = { _jv: { careerPrizeNorm: 0.7, bodyWeightDeviation: -0.2, jockeyInThreeRate: 0.35, trainerInThreeRate: 0.32 } };
  const f = extractFeatures(h);
  assert.strictEqual(f.careerPrizeNorm, 0.7);
  assert.strictEqual(f.bodyWeightDeviation, -0.2);
  assert.strictEqual(f.jockeyInThreeRate, 0.35);
  assert.strictEqual(f.trainerInThreeRate, 0.32);
});
test("dataCompleteness: 新規 4 キーがカウント対象", () => {
  const f = extractFeatures({ _jv: { careerPrizeNorm: 0.5, bodyWeightDeviation: 0, jockeyInThreeRate: 0.3, trainerInThreeRate: 0.3 } });
  const c = dataCompleteness(f);
  assert.ok(c.total >= 18, `expected total >= 18, got ${c.total}`);
  assert.ok(c.present >= 4, `expected present >= 4, got ${c.present}`);
});

console.log(`\n=== 合計: ${passed} 通過 / ${failed} 失敗 ===`);
process.exit(failed > 0 ? 1 : 0);
