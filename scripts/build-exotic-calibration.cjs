// ============================================================
// build-exotic-calibration.cjs
//   過去の全レースの「本物の着順」を使って、
//   ① ディスカウントHarville の指数(LAM=2着, TAU=3着)を実データで較正し、
//   ② 連系・3連系の予想確率→実測的中率 のビン表(exotic_calibration.json)を作る。
//
//   目的: 画面に出す「ワイド/3連複の的中率」を“本物の数字”にする(楽観バイアス除去)。
//   土台確率 = 市場de-vig(確定オッズ 1/odds をレース内で正規化)= アプリのβ=0と同じ。
//
//   使い方: node scripts/build-exotic-calibration.cjs
//
// 🆕 2026-08-12 追加: overlay(うまみ買い)用の較正カーブ
//   これまでの wide/trio 表は「本命-対抗のワイド」「上位3頭BOXの3連複」だけを
//   数えて作ったもの＝**1レース1標本**。lib/conclusion.js が画面に出す的中率には
//   これで正しいが、lib/overlay.js は **全組合せ**(馬連の全ペア・ワイドの全ペア・
//   3連複の全3頭)を1点ずつ評価するので、標本のとり方が違って使えない。
//   しかも馬連の表はそもそも存在せず、overlay は較正なしの生Harvilleで
//   期待値(ev)を出していた。
//   → out.overlay.{umaren,wide,trio} に「全組合せ」で作ったカーブを別立てで持つ。
//     既存の out.wide / out.trio は形も作り方も一切変えない(conclusion.js は無傷)。
//
// 🚨 Benter の警告(脚注3)への対応:
//   「Harville の偏り」と「穴馬バイアス」は互いに打ち消し合うので、片方だけを
//   式で綺麗に直すと もう片方が露出して悪化しうる。
//   → ここでは式を触らず、市場de-vig勝率という同じ入口から出した確率を
//     そのまま実測へ写す。＝2つの偏りの“差し引き後”を丸ごと補正するので
//     「片方だけ直す」ことにならない。
//
// 🚨 数字の作り方(自分に甘くしない):
//   全データで作った表を全データで採点したら、当たり前に「ぴったり」になる(循環)。
//   なので **時系列で前75%だけで表を作り、後ろ25%(未来)で採点** した値も必ず出す。
//   報告に使ってよいのはこの「未来ぶんの数字」だけ。
// ============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const E = require(path.join(__dirname, "..", "lib", "exotic.js"));

const ROOT = path.resolve(__dirname, "..");
const RESULTS = path.join(ROOT, "data", "jv_cache", "results");
const OUT = path.join(ROOT, "data", "jv_cache", "exotic_calibration.json");

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
const sortKey = (...ns) => ns.slice().sort((a, b) => a - b).join("-");

// 全レースを「市場de-vig勝率 + 実着順」に変換して配列で持つ(指数スイープで何度も使う)
// id は 18桁(先頭が年月日)なので、id 昇順 = 時系列順になる。
function loadRaces() {
  const files = fs.readdirSync(RESULTS).filter(f => f.endsWith(".json")).sort();
  const races = [];
  for (const f of files) {
    const res = readJson(path.join(RESULTS, f));
    if (!res || !Array.isArray(res.results)) continue;
    const odds = {}; const finishers = [];
    for (const r of res.results) {
      const n = Number(r.number), rank = Number(r.rank), o = Number(r.win_odds);
      if (Number.isFinite(n) && Number.isFinite(o) && o > 1) odds[n] = o;
      if (Number.isFinite(n) && Number.isFinite(rank) && rank >= 1) finishers.push({ n, rank });
    }
    const nums = Object.keys(odds).map(Number);
    if (nums.length < 6) continue;
    let sum = 0; for (const n of nums) sum += 1 / odds[n];
    if (!(sum > 0)) continue;
    const probMap = {};
    for (const n of nums) probMap[n] = (1 / odds[n]) / sum;
    finishers.sort((a, b) => a.rank - b.rank);
    const r1 = finishers[0]?.n, r2 = finishers[1]?.n, r3 = finishers[2]?.n;
    if (r1 == null || r2 == null || r3 == null) continue;
    races.push({ id: f.replace(/\.json$/, ""), probMap, top3: new Set([r1, r2, r3]), r1, r2 });
  }
  races.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // 時系列順
  return races;
}

// 指定の指数で、主要戦略の「平均予想 vs 実測」を出す(較正のズレを測る)
function evalDiscount(races, lam, tau) {
  E.setDiscount(lam, tau);
  let n = 0;
  let pw = 0, hw = 0;   // ワイド 本命-対抗
  let pt = 0, ht = 0;   // 3連複 上位3頭BOX
  let pq = 0, hq = 0;   // 馬連 本命-対抗
  for (const R of races) {
    const rk = E.rankByProb(R.probMap);
    const a = rk[0], b = rk[1], c = rk[2];
    if (a == null || b == null || c == null) continue;
    n++;
    pw += E.pWide(R.probMap, a, b);   if (R.top3.has(a) && R.top3.has(b)) hw++;
    pt += E.pTrio(R.probMap, a, b, c); if (R.top3.has(a) && R.top3.has(b) && R.top3.has(c)) ht++;
    pq += E.pQuinella(R.probMap, a, b);
    if ((R.r1 === a && R.r2 === b) || (R.r1 === b && R.r2 === a)) hq++;
  }
  const err = Math.abs(pw / n - hw / n) + Math.abs(pt / n - ht / n) + Math.abs(pq / n - hq / n);
  return { n, wide: [pw / n, hw / n], trio: [pt / n, ht / n], uren: [pq / n, hq / n], err };
}

// 予想確率→実測のビン表を作る(単調・予想を実測へ写像)
function buildBins(samples, edges) {
  // samples: [{p, hit}]; edges: 区切り(昇順) 例 [0.1,0.2,...]
  const bins = [];
  let lo = 0;
  for (const hi of edges) {
    const inB = samples.filter(s => s.p > lo && s.p <= hi);
    if (inB.length >= 30) {
      const rate = inB.reduce((a, s) => a + (s.hit ? 1 : 0), 0) / inB.length;
      bins.push({ pMax: hi, rate, nn: inB.length });
    }
    lo = hi;
  }
  // 最後(上限超え)
  const inB = samples.filter(s => s.p > lo);
  if (inB.length >= 30) {
    const rate = inB.reduce((a, s) => a + (s.hit ? 1 : 0), 0) / inB.length;
    bins.push({ pMax: 1.0, rate, nn: inB.length });
  }
  return bins;
}

// ============================================================
// ここから overlay(全組合せ)用の較正カーブづくり
// ============================================================

// ── ① 速い版と遅い版が本当に同じかを機械で確かめる ──────────
//   lib/exotic.js には ctx 付きの高速版がある。式は同じはずだが、
//   「同じはず」を信じない。実データで突き合わせて、違ったら止める。
function assertFastMatchesSlow(races) {
  let checked = 0, worst = 0;
  for (let i = 0; i < races.length; i += Math.max(1, Math.floor(races.length / 60))) {
    const R = races[i];
    const ctx = E.makeCtx(R.probMap);
    const nums = Object.keys(R.probMap).map(Number);
    for (let a = 0; a < Math.min(nums.length, 6); a++) {
      for (let b = a + 1; b < Math.min(nums.length, 7); b++) {
        const pairs = [
          [E.pQuinella(R.probMap, nums[a], nums[b]), E.ctxQuinella(ctx, nums[a], nums[b])],
          [E.pWide(R.probMap, nums[a], nums[b]), E.ctxWide(ctx, nums[a], nums[b])],
        ];
        for (let c = b + 1; c < Math.min(nums.length, 8); c++) {
          pairs.push([E.pTrio(R.probMap, nums[a], nums[b], nums[c]),
                      E.ctxTrio(ctx, nums[a], nums[b], nums[c])]);
        }
        for (const [slow, fast] of pairs) {
          const d = Math.abs(slow - fast) / Math.max(1e-12, Math.abs(slow));
          if (d > worst) worst = d;
          checked++;
        }
      }
    }
  }
  console.log(`[自己照合] 高速版 vs 元の式: ${checked} 通りを比較・最大相対差 ${worst.toExponential(2)}`);
  if (!(worst < 1e-9)) {
    throw new Error(`高速版が元の式と一致しません (最大相対差 ${worst})。較正表は作りません。`);
  }
}

// ── ② 全組合せの標本を集める ────────────────────────────
//   kind: "umaren" 馬連(全ペア) / "wide" ワイド(全ペア) / "trio" 3連複(全3頭)
//   返り値: [{p, hit, r}] r=レース番号(時系列の分割に使う)
function collectSamples(races, kind) {
  const out = [];
  for (let r = 0; r < races.length; r++) {
    const R = races[r];
    const ctx = E.makeCtx(R.probMap);
    const nums = Object.keys(R.probMap).map(Number).sort((x, y) => x - y);
    if (kind === "trio") {
      for (let i = 0; i < nums.length; i++)
        for (let j = i + 1; j < nums.length; j++)
          for (let k = j + 1; k < nums.length; k++) {
            const a = nums[i], b = nums[j], c = nums[k];
            out.push({
              p: E.ctxTrio(ctx, a, b, c),
              hit: R.top3.has(a) && R.top3.has(b) && R.top3.has(c),
              r,
            });
          }
    } else {
      for (let i = 0; i < nums.length; i++)
        for (let j = i + 1; j < nums.length; j++) {
          const a = nums[i], b = nums[j];
          if (kind === "umaren") {
            out.push({
              p: E.ctxQuinella(ctx, a, b),
              hit: (R.r1 === a && R.r2 === b) || (R.r1 === b && R.r2 === a),
              r,
            });
          } else {
            out.push({
              p: E.ctxWide(ctx, a, b),
              hit: R.top3.has(a) && R.top3.has(b),
              r,
            });
          }
        }
    }
  }
  return out;
}

// ── ③ 単調(下がらない)にならす = PAVA(隣り合う逆転をならす) ──
//   実測は標本のブレでガタつく。ガタついたまま使うと
//   「確率が上がったのに当たる率が下がる」おかしなカーブになる。
//   件数で重みをつけて、逆転しているところだけプールして平均する。
function pava(points) {
  const st = [];
  for (const pt of points) {
    st.push({ y: pt.rate, w: pt.nn, items: [pt] });
    while (st.length > 1 && st[st.length - 2].y > st[st.length - 1].y + 1e-15) {
      const b2 = st.pop(), b1 = st.pop();
      const w = b1.w + b2.w;
      st.push({ y: (b1.y * b1.w + b2.y * b2.w) / w, w, items: b1.items.concat(b2.items) });
    }
  }
  const out = [];
  for (const blk of st) for (const it of blk.items) out.push({ ...it, rate: blk.y });
  return out;
}

// ── ④ 標本 → カーブ(節点の並び) ─────────────────────────
//   各ビンの「平均予想 pMid」と「実測的中率 rate」を節点にする。
//   pMax は昔ながらの段階ルックアップ用にも残す(既存 calExotic と同じ形)。
function buildCurve(samples, edges, minN) {
  const bins = [];
  let lo = 0;
  const push = (arr, hi) => {
    if (!arr.length) return;
    const nn = arr.length;
    const sp = arr.reduce((a, s) => a + s.p, 0);
    const hits = arr.reduce((a, s) => a + (s.hit ? 1 : 0), 0);
    bins.push({ pMax: hi, pMid: sp / nn, rate: hits / nn, nn, hits });
  };
  for (const hi of edges) { push(samples.filter(s => s.p > lo && s.p <= hi), hi); lo = hi; }
  push(samples.filter(s => s.p > lo), 1.0);

  // 件数が足りないビンは右隣に合体(端のブレで暴れないように)
  const merged = [];
  for (const b of bins) {
    if (merged.length && merged[merged.length - 1].nn < minN) {
      const prev = merged.pop();
      const nn = prev.nn + b.nn, hits = prev.hits + b.hits;
      merged.push({
        pMax: b.pMax, nn, hits, rate: hits / nn,
        pMid: (prev.pMid * prev.nn + b.pMid * b.nn) / nn,
      });
    } else merged.push({ ...b });
  }
  while (merged.length > 1 && merged[merged.length - 1].nn < minN) {
    const b = merged.pop(), prev = merged.pop();
    const nn = prev.nn + b.nn, hits = prev.hits + b.hits;
    merged.push({ pMax: b.pMax, nn, hits, rate: hits / nn,
                  pMid: (prev.pMid * prev.nn + b.pMid * b.nn) / nn });
  }
  return pava(merged).map(b => ({
    pMax: b.pMax, pMid: r6(b.pMid), rate: r6(b.rate), nn: b.nn,
  }));
}
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// ── ⑤ 採点: モデルの言う確率と実際の当たり方がどれだけ合うか ──
//   minP: overlay が実際に見る帯だけを見る(既定 0.03 未満は買い候補にならない)
function score(samples, curve, minP) {
  const use = samples.filter(s => s.p >= minP);
  const n = use.length;
  if (!n) return null;
  const val = (s) => (curve ? E.applyCurve(s.p, curve) : s.p);
  let sumP = 0, hits = 0, ll = 0, brier = 0;
  for (const s of use) {
    const v = Math.min(1 - 1e-9, Math.max(1e-9, val(s)));
    sumP += v;
    if (s.hit) hits++;
    ll += s.hit ? -Math.log(v) : -Math.log(1 - v);
    brier += (v - (s.hit ? 1 : 0)) ** 2;
  }
  // ビン別のズレ(加重平均) = ECE
  const eEdges = [0.04, 0.05, 0.07, 0.10, 0.14, 0.20, 0.30, 1.0];
  let lo = minP, ece = 0, eceRel = 0, worst = 0, worstLabel = "";
  for (const hi of eEdges) {
    const arr = use.filter(s => s.p > lo && s.p <= hi);
    lo = hi;
    if (arr.length < 100) continue;
    const mp = arr.reduce((a, s) => a + val(s), 0) / arr.length;
    const ac = arr.reduce((a, s) => a + (s.hit ? 1 : 0), 0) / arr.length;
    const w = arr.length / n;
    ece += w * Math.abs(mp - ac);
    eceRel += w * (ac > 0 ? Math.abs(mp / ac - 1) : 0);
    const rel = ac > 0 ? Math.abs(mp / ac - 1) : 0;
    if (rel > worst) { worst = rel; worstLabel = `~${hi}`; }
  }
  return {
    n, hits,
    expected: sumP,
    biasPct: hits > 0 ? (sumP / hits - 1) * 100 : null,   // +なら「言うほど当たっていない」
    ecePt: ece * 100,        // ビン別ズレの加重平均 (パーセントポイント)
    eceRelPct: eceRel * 100, // 同じものを「何%ずれているか」で
    worstBinRelPct: worst * 100, worstBin: worstLabel,
    logLoss: ll / n, brier: brier / n,
  };
}

function fmtScore(s) {
  if (!s) return "(標本なし)";
  return `合計ズレ ${s.biasPct >= 0 ? "+" : ""}${s.biasPct.toFixed(2)}% / `
       + `ビン別ズレ ${s.eceRelPct.toFixed(2)}% (${s.ecePt.toFixed(3)}pt) / `
       + `最悪ビン ${s.worstBinRelPct.toFixed(1)}% (${s.worstBin}) / `
       + `logloss ${s.logLoss.toFixed(5)}`;
}

// 券種ごとのビンの切り方 (実データの分布を見て決めた)
const CURVE_SPEC = {
  umaren: { edges: [0.002, 0.005, 0.01, 0.02, 0.03, 0.05, 0.07, 0.10, 0.14, 0.20, 0.28, 0.40], minN: 400, minP: 0.03 },
  wide:   { edges: [0.005, 0.01, 0.02, 0.04, 0.07, 0.10, 0.15, 0.20, 0.28, 0.38, 0.50, 0.62], minN: 400, minP: 0.03 },
  trio:   { edges: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.035, 0.06, 0.10, 0.16, 0.25], minN: 400, minP: 0.03 },
};

// 「全体倍率」= overlay が見る帯(p>=minP)で 実際の当たり本数 ÷ モデルの言う本数。
//   これが 0.95 なら「モデルは 5% 多く言っている」ということ。
function globalMultiplier(samples, minP) {
  const use = samples.filter(s => s.p >= minP);
  if (!use.length) return { k: 1, n: 0, expected: 0, hits: 0 };
  const expected = use.reduce((a, s) => a + s.p, 0);
  const hits = use.reduce((a, s) => a + (s.hit ? 1 : 0), 0);
  return { k: expected > 0 ? hits / expected : 1, n: use.length, expected, hits };
}
// applyCurve は節点1つでも「その倍率をかける」だけになるので、全体倍率はこう表せる
const multiplierCurve = (k) => [{ pMid: 0.1, rate: r6(0.1 * k) }];

const _mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const _sd = a => { const m = _mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };

// 時系列 walk-forward で「較正した方が本当に良くなるか」を測る。
//   後半50%を FOLDS 等分し、各回とも「それより前だけ」で較正を作って未来を採点する。
//   ⚠ 全データで作った表を全データで採点したら当たり前に合う(循環)。それは使わない。
function walkForwardCompare(samples, spec, folds = 10) {
  const rows = { none: [], mult: [], curve: [] };
  for (let f = 0; f < folds; f++) {
    const a = Math.floor(RACE_COUNT * (0.5 + (0.5 / folds) * f));
    const b = Math.floor(RACE_COUNT * (0.5 + (0.5 / folds) * (f + 1)));
    const train = samples.filter(s => s.r < a);
    const test = samples.filter(s => s.r >= a && s.r < b);
    if (!test.length) continue;
    const k = globalMultiplier(train, spec.minP).k;
    const cands = {
      none: score(test, null, spec.minP),
      mult: score(test, multiplierCurve(k), spec.minP),
      curve: score(test, buildCurve(train, spec.edges, spec.minN), spec.minP),
    };
    for (const key of Object.keys(rows)) if (cands[key]) rows[key].push(cands[key]);
  }
  const summarize = (arr) => arr.length ? {
    folds: arr.length,
    biasAbsPct: r6(_mean(arr.map(s => Math.abs(s.biasPct)))),
    eceRelPct: r6(_mean(arr.map(s => s.eceRelPct))),
    logLoss: r6(_mean(arr.map(s => s.logLoss))),
  } : null;
  // なし との対比較 (折り返しごとの差 → 平均 ± 標準誤差 → t)
  const paired = (key) => {
    const A = rows.none, Bv = rows[key];
    if (A.length !== Bv.length || !A.length) return null;
    const dB = A.map((s, i) => Math.abs(s.biasPct) - Math.abs(Bv[i].biasPct));
    const dE = A.map((s, i) => s.eceRelPct - Bv[i].eceRelPct);
    const seB = _sd(dB) / Math.sqrt(dB.length), seE = _sd(dE) / Math.sqrt(dE.length);
    return {
      biasImprovePt: r6(_mean(dB)), biasT: r6(seB > 0 ? _mean(dB) / seB : 0),
      eceImprovePt: r6(_mean(dE)), eceT: r6(seE > 0 ? _mean(dE) / seE : 0),
    };
  };
  return {
    none: summarize(rows.none), mult: summarize(rows.mult), curve: summarize(rows.curve),
    multVsNone: paired("mult"), curveVsNone: paired("curve"),
  };
}
let RACE_COUNT = 0;

// 採用の決まり (甘くしない・データが増えたら自動で判定し直される):
//   ① ズレの合計が小さくなること
//   ② ビン別のズレも小さくなること (ここが悪化するなら形を歪めているだけ)
//   ③ ②の改善が偶然でないこと (t >= 1.5)
function decide(cmp) {
  const cands = [];
  for (const key of ["mult", "curve"]) {
    const v = cmp[key === "mult" ? "multVsNone" : "curveVsNone"];
    if (!v) continue;
    const ok = v.biasImprovePt > 0 && v.eceImprovePt > 0 && v.eceT >= 1.5;
    cands.push({ key, ok, v });
  }
  const passed = cands.filter(c => c.ok);
  if (!passed.length) {
    const why = cands.map(c => `${c.key}: ズレ改善 ${c.v.biasImprovePt.toFixed(2)}pt / `
      + `ビン別改善 ${c.v.eceImprovePt.toFixed(2)}pt (t=${c.v.eceT.toFixed(2)})`).join(" ／ ");
    return { apply: false, method: "none", reason: `未来ぶんの採点で良くならなかったので較正しない (${why})` };
  }
  // 通ったものの中では「ビン別ズレの改善が大きい方」を採る
  passed.sort((a, b) => b.v.eceImprovePt - a.v.eceImprovePt);
  return { apply: true, method: passed[0].key, evidence: passed[0].v };
}

function buildOverlaySection(races) {
  RACE_COUNT = races.length;
  const out = {};
  console.log(`\n=== overlay(うまみ買い)用の較正カーブ ===`);
  console.log(`期間: ${races[0].id.slice(0, 8)} 〜 ${races[races.length - 1].id.slice(0, 8)} / ${races.length} レース`);
  console.log(`判定のしかた: 後半50%を10等分し、毎回「それより前だけ」で較正を作って未来を採点 (循環を避ける)`);

  for (const kind of ["umaren", "wide", "trio"]) {
    const spec = CURVE_SPEC[kind];
    const t0 = Date.now();
    const samples = collectSamples(races, kind);
    const label = { umaren: "馬連", wide: "ワイド", trio: "3連複" }[kind];
    console.log(`\n── ${label} ── 全組合せ ${samples.length.toLocaleString()} 点 (${((Date.now() - t0) / 1000).toFixed(1)}秒)`);

    const cmp = walkForwardCompare(samples, spec, 10);
    const d = decide(cmp);
    const show = (n, s) => s && console.log(`    ${n.padEnd(10)} 合計ズレ ${s.biasAbsPct.toFixed(2)}% / `
      + `ビン別ズレ ${s.eceRelPct.toFixed(2)}% / logloss ${s.logLoss.toFixed(5)}`);
    console.log(`  [未来ぶんで採点 p>=${spec.minP} ・ ${cmp.none.folds}回の平均]`);
    show("較正なし", cmp.none); show("全体倍率", cmp.mult); show("カーブ", cmp.curve);
    if (cmp.multVsNone) console.log(`    全体倍率 vs なし: 合計ズレ ${cmp.multVsNone.biasImprovePt >= 0 ? "-" : "+"}`
      + `${Math.abs(cmp.multVsNone.biasImprovePt).toFixed(2)}pt / ビン別ズレ ${cmp.multVsNone.eceImprovePt >= 0 ? "-" : "+"}`
      + `${Math.abs(cmp.multVsNone.eceImprovePt).toFixed(2)}pt (t=${cmp.multVsNone.eceT.toFixed(2)})`);
    if (cmp.curveVsNone) console.log(`    カーブ   vs なし: 合計ズレ ${cmp.curveVsNone.biasImprovePt >= 0 ? "-" : "+"}`
      + `${Math.abs(cmp.curveVsNone.biasImprovePt).toFixed(2)}pt / ビン別ズレ ${cmp.curveVsNone.eceImprovePt >= 0 ? "-" : "+"}`
      + `${Math.abs(cmp.curveVsNone.eceImprovePt).toFixed(2)}pt (t=${cmp.curveVsNone.eceT.toFixed(2)})`);

    // 本番に載せる表は全レースで作る (やり方は上の判定で選ばれたもの)
    const gm = globalMultiplier(samples, spec.minP);
    const diagBins = buildCurve(samples, spec.edges, spec.minN);
    let bins = null;
    if (d.apply) bins = (d.method === "mult") ? multiplierCurve(gm.k) : diagBins;

    if (d.apply) {
      console.log(`  ✅ 採用: ${d.method === "mult" ? `全体倍率 ${gm.k.toFixed(4)} 倍` : `カーブ ${diagBins.length}段`}`);
      if (d.method === "mult") {
        console.log(`     (p>=${spec.minP} の ${gm.n.toLocaleString()} 点: モデルは ${gm.expected.toFixed(0)} 本 当たると言い、`
          + `実際は ${gm.hits} 本 = ${((gm.expected / gm.hits - 1) * 100).toFixed(2)}% 多く言っていた)`);
      }
    } else {
      console.log(`  ⛔ 較正しない: ${d.reason}`);
    }
    console.log(`  [参考: 全 ${races.length} レースのビン別]`);
    for (const b of diagBins) {
      if (b.pMax < spec.minP) continue;
      console.log(`    ~${(b.pMax * 100).toFixed(1)}%: 予想平均 ${(b.pMid * 100).toFixed(3)}% → 実測 ${(b.rate * 100).toFixed(3)}% `
        + `(倍率 ${(b.rate / b.pMid).toFixed(3)} / ${b.nn.toLocaleString()}件)`);
    }

    out[kind] = {
      sampleSpace: kind === "trio" ? "レース内の全3頭の組合せ" : "レース内の全ペア",
      races: races.length,
      samples: samples.length,
      minP: spec.minP,
      applied: d.apply,
      method: d.apply ? (d.method === "mult" ? "全体倍率" : "ビン別カーブ") : "なし",
      reason: d.apply ? undefined : d.reason,
      multiplier: d.apply && d.method === "mult" ? r6(gm.k) : undefined,
      validation: {
        method: "時系列 walk-forward 10回 (毎回それより前だけで較正を作り、未来を採点)",
        rangeMinP: spec.minP,
        none: cmp.none, multiplier: cmp.mult, curve: cmp.curve,
        multVsNone: cmp.multVsNone, curveVsNone: cmp.curveVsNone,
      },
      bins,                 // null なら較正しない (lib/exotic.js は生の値をそのまま使う)
      diagnosticBins: diagBins,  // 参考。採用していなくても中身が見えるように残す
    };
  }
  return out;
}

function main() {
  const races = loadRaces();
  console.log(`較正対象 ${races.length} レース\n`);

  // ── ① 指数スイープ(LAM 2着, TAU 3着) ──
  const lamGrid = [0.55, 0.62, 0.70, 0.76, 0.85, 0.92, 1.0];
  const tauGrid = [0.45, 0.55, 0.62, 0.70, 0.80, 0.90, 1.0];
  let best = null;
  console.log("=== 指数スイープ(平均予想→実測のズレ最小を探す) ===");
  for (const lam of lamGrid) {
    for (const tau of tauGrid) {
      const r = evalDiscount(races, lam, tau);
      if (!best || r.err < best.err) best = { lam, tau, ...r };
    }
  }
  console.log(`素のHarville(1.0,1.0):`);
  { const r = evalDiscount(races, 1.0, 1.0);
    console.log(`  ワイド 予想${(r.wide[0]*100).toFixed(1)}% 実${(r.wide[1]*100).toFixed(1)}% / 3連複 予想${(r.trio[0]*100).toFixed(1)}% 実${(r.trio[1]*100).toFixed(1)}% / 馬連 予想${(r.uren[0]*100).toFixed(1)}% 実${(r.uren[1]*100).toFixed(1)}% / ズレ計${(r.err*100).toFixed(1)}pt`); }
  console.log(`★最良 LAM=${best.lam} TAU=${best.tau}:`);
  console.log(`  ワイド 予想${(best.wide[0]*100).toFixed(1)}% 実${(best.wide[1]*100).toFixed(1)}% / 3連複 予想${(best.trio[0]*100).toFixed(1)}% 実${(best.trio[1]*100).toFixed(1)}% / 馬連 予想${(best.uren[0]*100).toFixed(1)}% 実${(best.uren[1]*100).toFixed(1)}% / ズレ計${(best.err*100).toFixed(1)}pt\n`);

  // ── ② 最良指数でビン表を作る ──
  E.setDiscount(best.lam, best.tau);
  const wideS = [], trioS = [], placeS = [];
  for (const R of races) {
    const rk = E.rankByProb(R.probMap);
    const a = rk[0], b = rk[1], c = rk[2];
    if (a == null || b == null || c == null) continue;
    wideS.push({ p: E.pWide(R.probMap, a, b), hit: R.top3.has(a) && R.top3.has(b) });
    trioS.push({ p: E.pTrio(R.probMap, a, b, c), hit: R.top3.has(a) && R.top3.has(b) && R.top3.has(c) });
    // 本命の複勝(3着内)も Harville 由来で較正(参考・既存 place_calibration と別系統)
    placeS.push({ p: E.pTop3(R.probMap, a), hit: R.top3.has(a) });
  }
  const wideBins = buildBins(wideS, [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
  const trioBins = buildBins(trioS, [0.05, 0.08, 0.12, 0.18, 0.25, 0.35]);

  console.log("=== ワイド較正表(本命-対抗・conclusion.js 用) ===");
  for (const b of wideBins) console.log(`  ~${(b.pMax*100).toFixed(0)}%: 実${(b.rate*100).toFixed(1)}% (${b.nn}件)`);
  console.log("=== 3連複較正表(上位3頭BOX・conclusion.js 用) ===");
  for (const b of trioBins) console.log(`  ~${(b.pMax*100).toFixed(0)}%: 実${(b.rate*100).toFixed(1)}% (${b.nn}件)`);

  // ── ③ overlay(全組合せ)用のカーブ ──
  //    ⚠ 上の setDiscount(best) のあとに作ること (makeCtx は今の指数を焼き込む)
  assertFastMatchesSlow(races);
  const overlay = buildOverlaySection(races);

  const out = {
    generatedAt: new Date().toISOString(),
    races: races.length,
    discount: { lam: best.lam, tau: best.tau },
    note: "ディスカウントHarville。wide=本命-対抗ワイド, trio=上位3頭BOX 3連複。p(予想確率)→rate(実測的中率)。",
    wide: wideBins,
    trio: trioBins,
    overlay: {
      note: "lib/overlay.js 用。全組合せを1点ずつ数えて作ったカーブ。"
          + "bins は pMid(その帯の平均予想確率)→rate(実測的中率) の節点で、"
          + "lib/exotic.js の applyCurve が直線でつないで使う。"
          + "上の wide/trio(1レース1標本)とは標本のとり方が違うので混ぜないこと。",
      usage: "EX.pQuinellaCal(winProb,a,b) / EX.pWideCal(winProb,a,b) / EX.pTrioCal(winProb,a,b,c)",
      ...overlay,
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n保存: ${OUT}`);
}

// 中身を検証スクリプトから使い回せるように公開する
// (較正のやり方を選ぶときに、同じ関数で採点しないと比べたことにならない)
module.exports = {
  loadRaces, collectSamples, buildCurve, score, fmtScore,
  pava, assertFastMatchesSlow, buildOverlaySection, CURVE_SPEC, main,
};

if (require.main === module) main();
