"use strict";
const { getPredictor } = require("../predictors");
const { augmentWithJvFeatures } = require("../predictors/jv_link_features");
const { isDummyRace } = require("./connection_status");
const { computeBiasAdjustment, describeBias } = require("./track_bias");

function isMissing(v) { return v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v)); }

const TH = {
  STRONG_BUY:    1.30,
  BUY:           1.00,
  WEAK:          0.70,
  OVERPOP_EV:    0.85,
  OVERPOP_RANK:  4,
  UNDERVAL_EV:   1.10,
  UNDERVAL_RANK: 6,
  RACE_GO:       1.30,
  RACE_PASS:     1.05,
  CONFIDENCE_GO: 0.30,
};

function emptyConclusion(reason) {
  return {
    ok: false, verdict: "judgement_unavailable",
    verdictTitle: "判断不可", verdictReason: reason,
    reason, reasonList: [],
    picks: [], avoid: [], overpopular: [], undervalued: [],
    bets: { tan: null, fuku: null, uren: null },
    confidence: 0, confidenceLabel: "データなし",
    predictor: null, completeness: null,
    raceMeta: null,
  };
}

// EVグレード: S = 1.30+, A = 1.10+, B = 1.00+, C = 0.85-1.00, D = -0.85
function evGrade(ev) {
  if (ev == null || !Number.isFinite(ev)) return null;
  if (ev >= 1.30) return "S";
  if (ev >= 1.10) return "A";
  if (ev >= 1.00) return "B";
  if (ev >= 0.85) return "C";
  return "D";
}

function mkPick(h, role) {
  const grade = evGrade(h.ev);
  let note;
  if      (role === "buy" && grade === "S") note = `S級 — 強い買い候補`;
  else if (role === "buy" && grade === "A") note = `A級 — 買い候補`;
  else if (role === "buy")                  note = `B級 — 小幅プラス候補`;
  else if (role === "avoid")                note = `D級 — 期待値マイナス`;
  else if (role === "overpopular")          note = `${h.popularity}番人気だが期待値マイナス — 過剰人気`;
  else if (role === "undervalued")          note = `${h.popularity}番人気で${grade}級 — 過小評価`;
  return {
    number: h.number, name: h.name,
    odds: h.odds, popularity: h.popularity,
    prob: h.prob, ev: h.ev, grade, role, note,
    jockey: h.jockey || null,
    trainer: h.trainer || null,
  };
}

function fmt(v) { return v == null ? "—" : Number(v).toFixed(1); }

function buildConclusion(race) {
  if (!race || !Array.isArray(race.horses) || race.horses.length === 0) {
    return emptyConclusion("出走馬データが未取得のため、判断できません。");
  }

  let enriched, prediction, biasInfo;
  try {
    enriched = augmentWithJvFeatures(race);
    const predictor = getPredictor();
    prediction = predictor.predict(enriched);
  } catch (e) {
    console.error("[conclusion] prediction failed:", e?.message || e);
    return emptyConclusion("予測計算で内部エラーが発生しました: " + (e?.message || "unknown"));
  }

  if (!prediction) return emptyConclusion("推定勝率が計算できませんでした(出走馬データが不足)。");

  // 馬場バイアス補正: 場・馬場・脚質・枠番から prob を補正し再正規化
  try { biasInfo = describeBias(enriched); } catch { biasInfo = "馬場バイアス計算失敗"; }
  const biasAdjusted = prediction.horses.map(p => {
    const horseObj = enriched.horses.find(h => h.number === p.number) || {};
    let adj;
    try { adj = computeBiasAdjustment(enriched, horseObj); }
    catch { adj = { adjustment: 1.0 }; }
    const adjVal = Number.isFinite(adj.adjustment) ? adj.adjustment : 1.0;
    const probIn = Number.isFinite(p.prob) ? p.prob : 0;
    return { ...p, _adj: adjVal, prob: probIn * adjVal };
  });
  // ガード: 全 prob が NaN/0 のときは prediction の素の値に戻す (NaN を返さない)
  const sumAdj = biasAdjusted.reduce((a, x) => a + (Number.isFinite(x.prob) ? x.prob : 0), 0);
  let adjustedHorses;
  if (sumAdj > 1e-9) {
    adjustedHorses = biasAdjusted.map(p => ({ ...p, prob: (Number.isFinite(p.prob) ? p.prob : 0) / sumAdj }));
  } else {
    // フォールバック: prediction の素の確率を使う
    adjustedHorses = prediction.horses.map(p => ({ ...p, _adj: 1.0 }));
  }

  const horsesWithEv = enriched.horses.map(h => {
    const pred = adjustedHorses.find(p => p.number === h.number);
    const probRaw = pred?.prob ?? null;
    const prob = Number.isFinite(probRaw) ? probRaw : null;
    const oddsRaw = isMissing(h.win_odds) ? null : Number(h.win_odds);
    const odds = Number.isFinite(oddsRaw) && oddsRaw > 0 ? oddsRaw : null;
    const ev = (prob !== null && odds !== null) ? prob * odds : null;
    const evSafe = Number.isFinite(ev) ? ev : null;
    const popRaw = isMissing(h.popularity) ? null : Number(h.popularity);
    return {
      number: h.number, name: h.name || null,
      odds, popularity: Number.isFinite(popRaw) ? popRaw : null,
      prob, ev: evSafe,
      sex_age: h.sex_age || null,
      jockey: h.jockey || null,
      trainer: h.trainer || null,
      _biasAdj: pred?._adj ?? null,
    };
  });

  const evHorses = horsesWithEv.filter(h => h.ev !== null);
  if (evHorses.length === 0) {
    return {
      ...emptyConclusion("オッズが未取得のため期待値を計算できません。"),
      confidence: prediction.confidence,
      predictor: { name: prediction.name, version: prediction.version },
    };
  }

  const sorted = [...evHorses].sort((a, b) => b.ev - a.ev);
  const buy   = sorted.filter(h => h.ev >= TH.BUY);
  const avoid = sorted.filter(h => h.ev < TH.WEAK);
  const overpopular = evHorses
    .filter(h => h.popularity !== null && h.popularity <= TH.OVERPOP_RANK && h.ev < TH.OVERPOP_EV)
    .sort((a, b) => a.ev - b.ev);
  const undervalued = evHorses
    .filter(h => h.popularity !== null && h.popularity >= TH.UNDERVAL_RANK && h.ev >= TH.UNDERVAL_EV)
    .sort((a, b) => b.ev - a.ev);

  const topEv = sorted[0]?.ev ?? 0;
  const conf = prediction.confidence;
  let verdict, verdictTitle, verdictReason;
  if (topEv < TH.RACE_PASS) {
    verdict = "pass"; verdictTitle = "見送り推奨";
    verdictReason = `最大EVが ${topEv.toFixed(2)} と低く、買う価値のある馬がいません。`;
  } else if (topEv >= TH.RACE_GO && conf >= TH.CONFIDENCE_GO) {
    verdict = "go"; verdictTitle = "狙えるレース";
    verdictReason = `${sorted[0].number} のEV ${topEv.toFixed(2)} はプラス幅が大きく、信頼度も十分。`;
  } else {
    verdict = "neutral";
    verdictTitle = topEv >= TH.STRONG_BUY ? "プラス馬あり (信頼度低)" : "普通";
    verdictReason = topEv >= TH.STRONG_BUY
      ? `EV ${topEv.toFixed(2)} とプラス幅は大きいが、データ不足で信頼度低。慎重に。`
      : `EV ${topEv.toFixed(2)} は小幅プラス。狙うなら少額で。`;
  }

  const confidenceLabel =
    conf < 0.20 ? "データ不足のため信頼度低"
    : conf < 0.35 ? "信頼度: 中"
    : "信頼度: 高";

  const reasonList = [];
  if (sorted[0]) {
    const s0 = sorted[0];
    const probPct = Number.isFinite(s0.prob) ? (s0.prob * 100).toFixed(1) : "—";
    const evStr   = Number.isFinite(s0.ev) ? s0.ev.toFixed(2) : "—";
    reasonList.push(`EV最大: ${s0.number} ${s0.name || ""} — 推定勝率 ${probPct}% × オッズ ${fmt(s0.odds)}倍 = EV ${evStr} (グレード ${evGrade(s0.ev)})`);
  }
  if (sorted[1]) {
    const evStr = Number.isFinite(sorted[1].ev) ? sorted[1].ev.toFixed(2) : "—";
    reasonList.push(`EV2位: ${sorted[1].number} ${sorted[1].name || ""} — EV ${evStr}`);
  }
  if (overpopular.length) reasonList.push(`過剰人気: ${overpopular.map(h => `${h.number}(${h.popularity}番人気・EV${h.ev.toFixed(2)})`).join("、")} — 市場の評価ほど期待値が伴っていません`);
  if (undervalued.length) reasonList.push(`過小評価: ${undervalued.map(h => `${h.number}(${h.popularity}番人気・EV${h.ev.toFixed(2)})`).join("、")} — 人気薄ですが推定勝率に対しオッズが付きすぎ`);
  reasonList.push(`使用モデル: ${prediction.name} v${prediction.version} / 信頼度 ${(conf*100).toFixed(0)}% (${confidenceLabel})`);
  reasonList.push("⚠ ヒューリスティックモデルの推定値です。JV-Link接続後に学習モデルへ差替予定。");

  const top3Buy = buy.slice(0, 3).map(h => mkPick(h, "buy"));
  const top3Avoid = avoid.slice(0, 3).map(h => mkPick(h, "avoid"));

  const topGrade = sorted[0] ? evGrade(sorted[0].ev) : null;

  // データソースを厳格に分類: dummy / jv_link
  const dummyFlag = isDummyRace(race);
  const dataSource = dummyFlag ? "dummy" : "jv_link";

  return {
    ok: true,
    verdict, verdictTitle, verdictReason,
    topGrade,
    confidence: conf,
    confidenceLabel,
    dataSource,                              // ★分離フラグ
    predictor: { name: prediction.name, version: prediction.version },
    completeness: prediction.completeness,
    picks: top3Buy,
    avoid: top3Avoid,
    overpopular: overpopular.slice(0, 3).map(h => mkPick(h, "overpopular")),
    undervalued: undervalued.slice(0, 3).map(h => mkPick(h, "undervalued")),
    reason: reasonList[0] || verdictReason,
    reasonList,
    bets: {
      tan:  top3Buy[0] ? `${top3Buy[0].number} ${top3Buy[0].name || ""}`.trim() : null,
      fuku: top3Buy.slice(0, 2).map(p => p.number).join(" / ") || null,
      uren: top3Buy.length >= 2 ? `${top3Buy[0].number} - ${top3Buy[1].number}` : null,
    },
    raceMeta: {
      raceName: race.race_name, source: race.source, lastUpdated: race.last_updated,
      isDummy: dummyFlag,
      dataSource,                            // ★同じ情報を raceMeta にも複製
      isG1: !!race.is_g1 || (typeof race.race_name === "string" && /G1|GⅠ|GI/.test(race.race_name)),
      raceId: race.race_id || null,
      going: race.going || null, weather: race.weather || null,
      distance: race.distance || null, course: race.course || null,
      goingBias: race.going_bias || null,    // 馬場バイアス (将来 JV-Link から取得)
      trackBiasNote: biasInfo,               // ★Wave9: 馬場バイアスの自然言語サマリ
      pacePrediction: prediction.pace || null, // ★Wave9: ペース予想 (ハイ/スロー/ミドル)
    },
  };
}

module.exports = { buildConclusion, evGrade };
