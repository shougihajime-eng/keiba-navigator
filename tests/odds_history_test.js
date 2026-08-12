"use strict";
// ============================================================
// odds_history_test.js — 「オッズ推移グラフ」の機械けんさ
//   走らせ方:  node tests/odds_history_test.js
//
// ★何を見張るか（ここを外すと嘘のグラフが出る）
//   ①発走時刻を決め打ちしない（races の hassou_time が本物）
//   ②発走後のオッズを混ぜない（実際には買えない値段）
//   ③**無い所を線でつながない**（作り話をしない）
//   ④「直前5分」を勝手に名乗らない（研究では -15〜-10分だけ切り出すと符号が逆転する）
//   ⑤スマホ(390px)で読める（12px未満の文字を作らない・はみ出さない）
// ============================================================
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const OH = require("../lib/odds_history");
const LM = require("../lib/late_move");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e && e.message)); }
}

// 発走 2026-08-09 10:00 JST のニセ・レースを作る道具
const POST = LM.postTimeFromHassou("202608090101060100", "1000");
const snap = (min, odds, popu) => ({
  ts: new Date(POST + min * 60000).toISOString(),
  go: null, we: null,
  horses: Object.keys(odds).map(n => ({
    n: Number(n), o: odds[n],
    p: popu && popu[n] != null ? popu[n] : null,
  })),
});

console.log("\n=== odds_history: オッズ推移グラフ ===");

test("発走時刻は hassou_time から作る（10:00 JST = 01:00 UTC）", () => {
  assert.strictEqual(OH.postTimeForRace("202608090101060100", "1000"), Date.UTC(2026, 7, 9, 1, 0, 0, 0));
  assert.strictEqual(OH.postTimeForRace("202608090101060100", "9999"), null);
});

test("発走時刻が分からないときは描かない（推測しない）", () => {
  const r = OH.buildOddsSeries({ snapshots: [snap(-60, { 1: 5 }), snap(-30, { 1: 4 })], postAt: null });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "post_time_unknown");
});

test("発走後のオッズは系列に入らない（実際には買えない値段）", () => {
  const r = OH.buildOddsSeries({
    snapshots: [snap(-60, { 1: 5 }), snap(-10, { 1: 4 }), snap(+5, { 1: 3 })], postAt: POST,
  });
  assert.strictEqual(r.counts.prePost, 2);
  assert.strictEqual(r.counts.afterPost, 1);
  const h1 = r.horses.find(h => h.number === 1);
  assert.deepStrictEqual(h1.points.map(p => p.odds), [5, 4]); // 3 は入らない
  assert.strictEqual(h1.last.odds, 4);
});

test("オッズ 1.0 以下は欠測あつかい（late_move と同じ規則）", () => {
  const r = OH.buildOddsSeries({
    snapshots: [snap(-60, { 1: 5, 2: 1.0 }), snap(-30, { 1: 4, 2: 2.0 })], postAt: POST,
  });
  const h2 = r.horses.find(h => h.number === 2);
  assert.strictEqual(h2.points.length, 1, "1.0 は点にしない");
  assert.strictEqual(h2.points[0].odds, 2.0);
});

test("同じ馬が何回も入った壊れスナップでも、最後の本物を1つだけ採る", () => {
  // 実データに 99 枚ある形（null が並んだ最後に本物が1つ）
  const broken = {
    ts: new Date(POST - 30 * 60000).toISOString(),
    horses: [{ n: 1, o: null }, { n: 1, o: null }, { n: 1, o: 6.4 }],
  };
  const m = OH.oddsMapFromSnapshot(broken);
  assert.strictEqual(m.size, 1);
  assert.strictEqual(m.get(1).odds, 6.4);
});

test("欠測があるところで線が切れる（つないだ直線を描かない）", () => {
  const r = OH.buildOddsSeries({
    snapshots: [snap(-60, { 1: 5 }), snap(-40, { 2: 9 }), snap(-20, { 1: 4 })], postAt: POST,
  });
  const h1 = r.horses.find(h => h.number === 1);
  assert.strictEqual(h1.points.length, 2);
  assert.strictEqual(h1.missingCount, 1);
});

test("間が大きく空いたら線を切る（gapBreakMin）", () => {
  const pts = [{ minutesToPost: -400, odds: 5 }, { minutesToPost: -390, odds: 5 }, { minutesToPost: -60, odds: 4 }];
  assert.strictEqual(OH.splitSegments(pts, 120).length, 2, "330分の穴で切れる");
  assert.strictEqual(OH.splitSegments(pts, 600).length, 1);
});

test("「直前5分」は late_move の答えをそのまま使う（勝手に名乗らない）", () => {
  // 1時間おき＝起点が古すぎる → late_move は anchor_too_old で断る
  const hourly = OH.buildOddsSeries({
    snapshots: [snap(-120, { 1: 5 }), snap(-60, { 1: 5 }), snap(-1, { 1: 3 })], postAt: POST,
  });
  assert.strictEqual(hourly.summary.lateOk, false);
  assert.strictEqual(hourly.summary.lateReason, "anchor_too_old");
  assert.ok(hourly.notes.some(n => n.indexOf("直前5分") >= 0), "理由を日本語で出す");

  // 2分おき＝ちゃんと出せる
  const dense = OH.buildOddsSeries({
    snapshots: [snap(-30, { 1: 5, 2: 3 }), snap(-8, { 1: 5, 2: 3 }), snap(-4, { 1: 4.4, 2: 3.3 }), snap(-2, { 1: 4, 2: 3.6 })],
    postAt: POST,
  });
  assert.strictEqual(dense.summary.lateOk, true, "reason=" + dense.summary.lateReason);
  const b = dense.summary.late.byNumber[1];
  assert.ok(Math.abs(b.changeRate - (4 - 5) / 5) < 1e-12, "changeRate=" + b.changeRate);
});

test("「観測できた範囲の動き」と「直前5分」は別の場所に入っている（混ぜない）", () => {
  const r = OH.buildOddsSeries({
    snapshots: [snap(-120, { 1: 10 }), snap(-60, { 1: 5 }), snap(-1, { 1: 4 })], postAt: POST,
  });
  assert.ok(r.summary.observed.biggestDrop, "観測範囲はある");
  assert.strictEqual(r.summary.lateOk, false, "直前5分は別で、出せていない");
});

test("人気の上がり下がりを数える（プラス＝人気が上がった）", () => {
  const r = OH.buildOddsSeries({
    snapshots: [snap(-60, { 1: 5, 2: 4 }, { 1: 3, 2: 1 }), snap(-20, { 1: 3, 2: 6 }, { 1: 1, 2: 3 })],
    postAt: POST,
  });
  const mv = r.summary.popularityMoves;
  assert.strictEqual(mv.find(m => m.number === 1).delta, 2);   // 3番人気 → 1番人気
  assert.strictEqual(mv.find(m => m.number === 2).delta, -2);  // 1番人気 → 3番人気
});

test("濃く描くのは 上位6頭＋大きく動いた馬（色は8つまで・9色目を作らない）", () => {
  const odds = {}, popu = {};
  for (let n = 1; n <= 16; n++) { odds[n] = n * 2; popu[n] = n; }
  const later = {}; for (let n = 1; n <= 16; n++) later[n] = n * 2;
  later[15] = 4;   // 30倍 → 4倍 の大穴（上位人気ではないが大きく動いた）
  later[16] = 100; // 32倍 → 100倍
  const r = OH.buildOddsSeries({ snapshots: [snap(-60, odds, popu), snap(-20, later, popu)], postAt: POST });
  const hi = r.horses.filter(h => h.highlight);
  assert.ok(hi.length <= 8, "highlight=" + hi.length);
  assert.ok(hi.some(h => h.number === 1) && hi.some(h => h.number === 6), "上位人気が入る");
  assert.ok(hi.some(h => h.number === 15), "大きく動いた馬が入る");
  const slots = hi.map(h => h.colorSlot).sort((a, b) => a - b);
  assert.deepStrictEqual(slots, slots.map((_, i) => i), "色の枠は 0,1,2… と順番に配る");
});

// ── SVG ────────────────────────────────────────────────────
function svgChecks(svg, label) {
  assert.ok(/^<svg /.test(svg), label + ": <svg で始まる");
  assert.ok(svg.indexOf("NaN") < 0, label + ": NaN が出ていない");
  assert.ok(svg.indexOf("undefined") < 0, label + ": undefined が出ていない");
  const sizes = [...svg.matchAll(/font-size="([\d.]+)"/g)].map(m => Number(m[1]));
  assert.ok(sizes.length > 0, label + ": 文字がある");
  assert.ok(Math.min(...sizes) >= 12, label + ": 12px未満の文字が無い (最小 " + Math.min(...sizes) + ")");
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  assert.ok(vb, label + ": viewBox がある");
  const W = Number(vb[1]);
  for (const m of svg.matchAll(/<rect x="([-\d.]+)"[^>]*width="([\d.]+)"/g)) {
    assert.ok(Number(m[1]) + Number(m[2]) <= W + 0.51, label + ": 右にはみ出していない");
    assert.ok(Number(m[1]) >= -0.01, label + ": 左にはみ出していない");
  }
}

test("SVG: ふつうの形（12px未満なし・NaNなし・はみ出しなし）", () => {
  const r = OH.buildOddsSeries({
    snapshots: [snap(-180, { 1: 5, 2: 20, 3: 200 }), snap(-120, { 1: 4, 2: 22, 3: 150 }), snap(-30, { 1: 3, 2: 25, 3: 90 })],
    postAt: POST,
  });
  svgChecks(OH.buildOddsChartSvg(r, { width: 390 }), "390px");
  svgChecks(OH.buildOddsChartSvg(r, { width: 320 }), "320px");
  svgChecks(OH.buildOddsChartSvg(r, { width: 760 }), "760px");
});

test("SVG: 描けないときも「描けません」と出す（空を返さない）", () => {
  const svg = OH.buildOddsChartSvg({ ok: false, reason: "no_signals_file", notes: [] }, { width: 390 });
  svgChecks(svg, "データなし");
  assert.ok(svg.indexOf("記録がありません") > 0);
});

test("SVG: 馬名に < > があっても壊れない（エスケープ）", () => {
  const r = OH.buildOddsSeries({
    snapshots: [snap(-60, { 1: 5 }), snap(-20, { 1: 4 })], postAt: POST,
    horses: [{ number: 1, name: "<script>x</script>" }],
  });
  const svg = OH.buildOddsChartSvg(r, { width: 390 });
  assert.ok(svg.indexOf("<script>") < 0, "生のタグが出ていない");
  assert.ok(svg.indexOf("&lt;script&gt;") > 0);
});

test("SVG: 発走5分前の帯と、その中に何枚あるかを必ず書く", () => {
  const r = OH.buildOddsSeries({ snapshots: [snap(-60, { 1: 5 }), snap(-20, { 1: 4 })], postAt: POST });
  const svg = OH.buildOddsChartSvg(r, { width: 390 });
  assert.ok(svg.indexOf("発走5分前から") > 0);
  assert.ok(svg.indexOf("この中のオッズは無し") > 0, "無いときは無いと書く");
});

// ── 本物のデータで通す ───────────────────────────────────
console.log("\n--- 本物のデータ（data/jv_cache/signals）---");
const ids = OH.listRacesWithHistory();
if (!ids.length) {
  console.log("  （signals が無い環境なのでスキップ）");
} else {
  test("本物 " + ids.length + " レース全部：例外ゼロ・SVG も全部つくれる", () => {
    let ok = 0, ng = {};
    for (const id of ids) {
      const r = OH.readOddsHistory(id);
      if (r.ok) ok++; else ng[r.reason] = (ng[r.reason] || 0) + 1;
      svgChecks(OH.buildOddsChartSvg(r, { width: 390 }), id);
    }
    console.log("      → 描ける " + ok + " / " + ids.length + " レース　描けない内訳 " + JSON.stringify(ng));
    assert.ok(ok > 0);
  });

  test("本物：発走後のオッズを1点も混ぜていない", () => {
    for (const id of ids) {
      const r = OH.readOddsHistory(id);
      if (!r.ok) continue;
      for (const h of r.horses) for (const p of h.points) {
        assert.ok(p.minutesToPost < 0, id + " に発走後の点が混ざった: " + p.minutesToPost);
      }
    }
  });
}

console.log("\n=== 合計: " + pass + " 通過 / " + fail + " 失敗 ===");
process.exit(fail ? 1 : 0);
