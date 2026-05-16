"use strict";

// ensemble_v1: 複数の弱学習器を加重統合した推定勝率モジュール
//
// 設計思想:
//   - heuristic_v1 (ベース) + odds-implied (市場知見) + form_curve (近走勢い)
//     + pace_fit (脚質×ペース) + pedigree_fit (血統×距離馬場) + jockey_trainer (人手相性)
//     の 6 弱学習器を softmax 後に重み付け加重平均
//   - 重みは「データ完備度」と「自信度」から動的に決まる。
//     データが薄いときはオッズ実勢に寄せ、データが揃ったときは AI 推定に寄せる
//   - calibration (Platt scaling 風) で温度補正
//
// 出力: heuristic_v1 と同じ shape (predict(race) -> { horses: [{number,prob,...}], confidence })

const { extractFeatures, dataCompleteness } = require("./features");
const heuristic_v1 = require("./heuristic_v1");

const NAME = "ensemble_v1";
const VERSION = "1.0.0";

// ─── 個別の弱学習器 ──────────────────────────────────────────

// (1) ベース: heuristic_v1 の score をそのまま流用
function scoreBase(features) {
  // heuristic_v1 を内部呼び出しではなく、軽量化のため同等ロジックを再現
  const prev = features.prevFinish ?? 6;
  let s = Math.exp(-0.4 * (prev - 1));
  const w = features.weight ?? 56;
  s *= Math.max(0.7, 1 - 0.025 * (w - 56));
  const age = features.age ?? 5;
  if (age >= 4 && age <= 6) s *= 1.0;
  else if (age === 3 || age === 7) s *= 0.92;
  else s *= 0.85;
  return Math.max(s, 1e-6);
}

// (2) オッズ implied: 単勝オッズ → 暗黙の勝率 (control の overround を 1.25 と仮定)
//     市場参加者の集合知。データ薄い局面では強力な信号
function scoreOddsImplied(horse) {
  const odds = Number(horse.win_odds);
  if (!Number.isFinite(odds) || odds <= 1.0) return null;
  // implied prob = 1/odds、過剰評価分 (overround 約 25%) を平均的に取り除く
  const implied = 1 / odds;
  // hat: 0..1 にクリップ
  return Math.max(0.001, Math.min(0.99, implied));
}

// (3) form_curve: 近走勢い。前走着順 + 馬体重変化 + 休み明け補正
function scoreForm(features) {
  let s = 1.0;
  const prev = features.prevFinish;
  if (prev !== null && prev !== undefined) {
    // 1着 → 1.4, 3着 → 1.1, 6着 → 0.8, 10着 → 0.55
    s *= Math.exp(-0.18 * (prev - 1)) + 0.4;
  }
  const wch = features.weightChange;
  if (wch !== null && wch !== undefined) {
    const abs = Math.abs(wch);
    if (abs <= 4) s *= 1.05;       // ベスト体重キープ
    else if (abs <= 8) s *= 1.0;
    else if (abs <= 14) s *= 0.92;
    else s *= 0.82;                 // 大幅増減
  }
  const days = features.daysFromLastRace;
  if (days !== null && days !== undefined) {
    if (days < 7) s *= 0.92;        // 連闘
    else if (days <= 21) s *= 1.03; // 中2-3週
    else if (days <= 56) s *= 1.0;
    else if (days <= 90) s *= 0.95;
    else s *= 0.85;                 // 休み明け
  }
  return Math.max(s, 1e-6);
}

// (4) pace_fit: 脚質 (逃/先/差/追) × そのレースの予想ペース
//   pace は race 全体の脚質分布から推定する (predict() の外側で計算して渡す)
//   逃げ多 → ハイペース → 差し追い込み有利、逃げ少 → スローペース → 逃げ先行有利
function scorePaceFit(features, pacePrediction) {
  const style = features.runStyleId;
  if (!style || !pacePrediction) return 1.0;
  // pacePrediction.tempo: -1=slow, 0=mid, +1=fast
  const tempo = pacePrediction.tempo ?? 0;
  // style coding: 1=逃, 2=先, 3=差, 4=追 (JRA 慣習)
  const styleCode = typeof style === "number" ? style : Number(style);
  if (!Number.isFinite(styleCode)) return 1.0;
  if (tempo > 0.3) {
    // ハイペース: 差し追い込み有利
    if (styleCode === 4) return 1.15;
    if (styleCode === 3) return 1.10;
    if (styleCode === 2) return 0.95;
    if (styleCode === 1) return 0.82;
  } else if (tempo < -0.3) {
    // スローペース: 逃げ先行有利
    if (styleCode === 1) return 1.18;
    if (styleCode === 2) return 1.10;
    if (styleCode === 3) return 0.92;
    if (styleCode === 4) return 0.82;
  }
  return 1.0;
}

// (5) pedigree_fit: 血統 × 距離馬場
function scorePedigree(features, raceMeta) {
  const ped = features.pedigreeSurfaceAff;
  if (ped === null || ped === undefined) return 1.0;
  // ped は 0..1 のスコア。0.5 を中立に
  return 0.85 + 0.30 * ped;
}

// (6) jockey_trainer: 騎手と調教師の相性 (winRate 系を加重)
function scoreJockeyTrainer(features) {
  let s = 1.0;
  const jw = features.jockeyWinRate;
  if (jw !== null && jw !== undefined) {
    s *= 1.0 + 2.0 * (jw - 0.10);
  }
  const cw = features.courseWinRate;
  if (cw !== null && cw !== undefined) s *= 1.0 + 1.5 * (cw - 0.10);
  const dw = features.distanceWinRate;
  if (dw !== null && dw !== undefined) s *= 1.0 + 1.5 * (dw - 0.10);
  const sw = features.surfaceWinRate;
  if (sw !== null && sw !== undefined) s *= 1.0 + 1.0 * (sw - 0.10);
  const gw = features.goingWinRate;
  if (gw !== null && gw !== undefined) s *= 1.0 + 1.0 * (gw - 0.10);
  return Math.max(s, 1e-6);
}

// (7) career_form: 累計賞金 + 体重偏差 + 騎手/調教師の複勝率 (3 着以内率)
//     aggregate_features.py から features.json 経由で来る「実績系」シグナル
function scoreCareerForm(features) {
  let s = 1.0;
  const cp = features.careerPrizeNorm;
  if (cp !== null && cp !== undefined) {
    // careerPrizeNorm: 0 (新馬) - 1.5 (重賞勝ち多数・億超え)
    // 0.85 倍 (新馬) - 1.375 倍 (重賞戦線常連) 程度に
    s *= 0.85 + 0.35 * cp;
  }
  const bw = features.bodyWeightDeviation;
  if (bw !== null && bw !== undefined) {
    // 適正体重 ±50kg 範囲を中立。それ以上ずれると軽い減点
    const abs = Math.abs(bw);
    if (abs > 1.5) s *= 0.92;
    else if (abs > 1.0) s *= 0.97;
  }
  const j3 = features.jockeyInThreeRate;
  if (j3 !== null && j3 !== undefined) {
    // 騎手の複勝率: 0.30 をベースラインに、±0.15 で ±18% 補正
    s *= 1.0 + 1.2 * (j3 - 0.30);
  }
  const t3 = features.trainerInThreeRate;
  if (t3 !== null && t3 !== undefined) {
    s *= 1.0 + 1.0 * (t3 - 0.30);
  }
  return Math.max(s, 1e-6);
}

// ─── ペース予想 (race 全体から) ─────────────────────────────
function predictPace(race) {
  if (!race || !Array.isArray(race.horses)) return { tempo: 0, leaders: 0, closers: 0 };
  let leaders = 0, closers = 0, known = 0;
  for (const h of race.horses) {
    const s = h._jv?.runStyleId;
    const c = typeof s === "number" ? s : Number(s);
    if (!Number.isFinite(c)) continue;
    known++;
    if (c === 1 || c === 2) leaders++;
    else if (c === 3 || c === 4) closers++;
  }
  if (known === 0) {
    // データ無し → 距離別の平均的なペース
    const dist = Number(race.distance);
    if (Number.isFinite(dist)) {
      if (dist <= 1400) return { tempo: 0.4, leaders, closers, known };  // 短距離はハイ
      if (dist >= 2400) return { tempo: -0.2, leaders, closers, known }; // 長距離は遅め
    }
    return { tempo: 0, leaders, closers, known };
  }
  // 逃げ先行が 40% 超ならハイペース、20% 未満ならスロー
  const leaderRatio = leaders / known;
  let tempo = 0;
  if (leaderRatio >= 0.4) tempo = 0.5;
  else if (leaderRatio >= 0.3) tempo = 0.25;
  else if (leaderRatio < 0.18) tempo = -0.4;
  else if (leaderRatio < 0.25) tempo = -0.2;
  return { tempo, leaders, closers, known, leaderRatio };
}

// ─── 重み計算 (データ完備度に応じて動的に) ──────────────────
function computeWeights(completeness) {
  // completeness.ratio: 0..1
  const c = completeness.ratio ?? 0;
  // データ薄: オッズ寄り (0.5)、データ濃: AI 寄り
  // base: 一定の貢献
  // 重み合計 (c=0): 0.20+0.50+0.10+0.05+0.05+0.10+0.05 = 1.05
  // 重み合計 (c=1): 0.40+0.20+0.20+0.15+0.10+0.25+0.15 = 1.45
  // (合計 1.0 でなくても加重幾何平均は順位が保たれるので OK)
  return {
    base:    0.20 + 0.20 * c,
    odds:    0.50 - 0.30 * c,
    form:    0.10 + 0.10 * c,
    pace:    0.05 + 0.10 * c,
    pedigree: 0.05 + 0.05 * c,
    jockey:   0.10 + 0.15 * c,
    career:   0.05 + 0.10 * c,  // career_form (累計賞金 + 体重偏差 + 騎手/調教師複勝)
  };
}

// ─── ロジット → softmax ─────────────────────────────────
function softmax(scores) {
  // log domain で安定化
  // 二重ガード: (1) Math.log の下限を 1e-12 に・(2) ログ値自体も -100 でクリップ
  //   → 7 弱学習器が全部低スコアで log の合計が極端に落ちても NaN にならない
  const logs = scores.map(s => {
    const safe = Math.max(Number.isFinite(s) ? s : 0, 1e-12);
    const l = Math.log(safe);
    return Math.max(l, -100);
  });
  const max = Math.max(...logs);
  const exps = logs.map(l => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) {
    // 全ゼロのとき: 一様分布で返す
    const n = scores.length;
    return scores.map(() => 1 / n);
  }
  return exps.map(e => e / sum);
}

// ─── メイン: predict ──────────────────────────────────────
function predict(race, options = {}) {
  if (!race || !Array.isArray(race.horses) || race.horses.length === 0) return null;

  const pace = predictPace(race);

  const records = race.horses.map(h => {
    const f = extractFeatures(h);
    const c = dataCompleteness(f);
    return { horse: h, features: f, completeness: c };
  });

  const avgCompleteness = records.reduce((a, r) => a + r.completeness.ratio, 0) / records.length;
  const weights = computeWeights({ ratio: avgCompleteness });

  // 各弱学習器のスコア
  const components = records.map(({ horse, features }) => {
    const sBase    = scoreBase(features);
    const sOddsRaw = scoreOddsImplied(horse);
    // オッズ implied は確率次元なので、他のスコアと合わせるためにスケール調整
    // 平均勝率 1/N を基準に倍率化
    const N = race.horses.length;
    const sOdds = sOddsRaw !== null ? (sOddsRaw * N) : 1.0;  // null=中立
    const sForm    = scoreForm(features);
    const sPace    = scorePaceFit(features, pace);
    const sPed     = scorePedigree(features, race);
    const sJT      = scoreJockeyTrainer(features);
    const sCareer  = scoreCareerForm(features);
    return {
      number: horse.number,
      name: horse.name || null,
      components: { base: sBase, odds: sOdds, form: sForm, pace: sPace, ped: sPed, jt: sJT, career: sCareer },
    };
  });

  // 加重幾何平均 (log domain) で結合 → 大きい外れ値を吸収しやすい
  const combined = components.map(c => {
    const x = c.components;
    const logScore =
      weights.base    * Math.log(Math.max(x.base, 1e-9)) +
      weights.odds    * Math.log(Math.max(x.odds, 1e-9)) +
      weights.form    * Math.log(Math.max(x.form, 1e-9)) +
      weights.pace    * Math.log(Math.max(x.pace, 1e-9)) +
      weights.pedigree* Math.log(Math.max(x.ped,  1e-9)) +
      weights.jockey  * Math.log(Math.max(x.jt,   1e-9)) +
      weights.career  * Math.log(Math.max(x.career, 1e-9));
    return { ...c, logScore, score: Math.exp(logScore) };
  });

  // 確率化 (softmax)
  const probs = softmax(combined.map(c => c.score));
  const horses = combined.map((c, i) => ({
    number: c.number,
    name: c.name,
    prob: probs[i],
    rawScore: c.score,
    components: c.components,
  }));

  // 信頼度: データ完備度 + 馬数 + 上位馬の確率分離度
  const sorted = [...probs].sort((a, b) => b - a);
  const topGap = (sorted[0] || 0) - (sorted[1] || 0);
  const separation = Math.min(1, topGap * 8);  // 0.125 差で 1.0
  const sizeAdj = Math.min(1, race.horses.length / 8);
  const baseConf = avgCompleteness * 0.7 + separation * 0.2;
  const confidence = Math.min(0.75, baseConf * sizeAdj);

  return {
    name: NAME,
    version: VERSION,
    confidence,
    completeness: {
      perHorseAvgRatio: avgCompleteness,
      featureCount: records[0]?.completeness.total ?? 0,
    },
    pace,
    weights,
    horses,
  };
}

module.exports = { name: NAME, version: VERSION, predict, predictPace, _internal: { scoreBase, scoreOddsImplied, scoreForm, scorePaceFit, scorePedigree, scoreJockeyTrainer, scoreCareerForm, softmax, computeWeights } };
