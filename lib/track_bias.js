"use strict";

// 馬場バイアス計算: 天気と going (馬場状態) から「逃げ有利度」「内枠有利度」を推定し、
// 各馬の (枠番・脚質) に補正を返す。
//
// 出典: JRA 一般的な傾向 + 過去レース観察則。学習データが溜まれば features.json 経由で
//       場別係数に置き換える。

// going: 0=良, 1=稍重, 2=重, 3=不良 (JV-Link コード)
// surface: "芝"/"ダート"/"障害"

function inferGoingId(going) {
  if (typeof going === "number") return going;
  if (!going) return 0;
  const s = String(going);
  if (/良|good/i.test(s)) return 0;
  if (/稍/.test(s)) return 1;
  if (/重|heavy/i.test(s)) return 2;
  if (/不良|sloppy/i.test(s)) return 3;
  return 0;
}

function weatherWetness(weather) {
  if (!weather) return 0;
  const s = String(weather);
  if (/雨|rain/.test(s)) return 1.0;
  if (/小雨|drizzle/.test(s)) return 0.6;
  if (/曇|cloud/.test(s)) return 0.2;
  return 0;
}

// 場別 (1=札幌〜10=小倉) のクセ。値は経験則のラフ係数 (-1..+1)
// frontBias: 正値=逃げ先行有利、railBias: 正値=内枠有利
const VENUE_BIAS = {
  "01": { frontBias: 0.0, railBias: 0.10, name: "札幌" },
  "02": { frontBias: 0.0, railBias: 0.10, name: "函館" },
  "03": { frontBias: 0.1, railBias: 0.15, name: "福島" },
  "04": { frontBias: -0.1, railBias: -0.10, name: "新潟" }, // 外差し新潟
  "05": { frontBias: -0.05, railBias: 0.05, name: "東京" },
  "06": { frontBias: 0.05, railBias: 0.10, name: "中山" },
  "07": { frontBias: 0.05, railBias: 0.05, name: "中京" },
  "08": { frontBias: 0.0, railBias: 0.05, name: "京都" },
  "09": { frontBias: 0.10, railBias: 0.15, name: "阪神" },
  "10": { frontBias: 0.05, railBias: 0.10, name: "小倉" },
};

function getVenueBias(course, raceId) {
  // course 文字列から場名を引く
  if (typeof course === "string") {
    for (const k of Object.keys(VENUE_BIAS)) {
      if (course.includes(VENUE_BIAS[k].name)) return { ...VENUE_BIAS[k], code: k };
    }
  }
  // raceId 17桁形式の場合は 11-12 桁目が場コード
  if (typeof raceId === "string" && raceId.length >= 12) {
    const c = raceId.slice(10, 12);
    if (VENUE_BIAS[c]) return { ...VENUE_BIAS[c], code: c };
  }
  return { frontBias: 0, railBias: 0, name: "?", code: null };
}

// 計算: race と horse から (脚質補正, 枠番補正) を返す
function computeBiasAdjustment(race, horse) {
  const goingId = inferGoingId(race.going);
  const wetness = weatherWetness(race.weather);
  const venue = getVenueBias(race.course || "", race.race_id || "");

  // 馬場が重くなるほど内枠有利・差し有利が強まる
  const goingFront = goingId === 0 ? 0 : goingId * -0.05;  // 重いほど逃げ不利
  const goingRail  = goingId * 0.06;                       // 重いほど内枠有利

  const frontBias = (venue.frontBias || 0) + goingFront + wetness * -0.05;
  const railBias  = (venue.railBias  || 0) + goingRail;

  // 脚質補正
  const runStyle = horse._jv?.runStyleId;
  const styleCode = typeof runStyle === "number" ? runStyle : Number(runStyle);
  let styleAdj = 1.0;
  if (Number.isFinite(styleCode)) {
    if (styleCode === 1) styleAdj = 1.0 + frontBias * 0.8;       // 逃げ
    else if (styleCode === 2) styleAdj = 1.0 + frontBias * 0.4;  // 先行
    else if (styleCode === 3) styleAdj = 1.0 - frontBias * 0.4;  // 差し
    else if (styleCode === 4) styleAdj = 1.0 - frontBias * 0.7;  // 追込
  }

  // 枠番補正 (1-8)
  const waku = Number(horse.waku || horse.frame);
  let frameAdj = 1.0;
  if (Number.isFinite(waku) && waku >= 1 && waku <= 8) {
    // 内 (1-2) vs 外 (7-8) で +/-
    if (waku <= 2) frameAdj = 1.0 + railBias * 0.6;
    else if (waku === 3 || waku === 4) frameAdj = 1.0 + railBias * 0.3;
    else if (waku === 5 || waku === 6) frameAdj = 1.0;
    else frameAdj = 1.0 - railBias * 0.4;
  }

  const totalAdj = styleAdj * frameAdj;
  return {
    adjustment: totalAdj,
    styleAdj,
    frameAdj,
    meta: { goingId, wetness, venue, frontBias, railBias },
  };
}

function describeBias(race) {
  const goingId = inferGoingId(race.going);
  const venue = getVenueBias(race.course || "", race.race_id || "");
  const wetness = weatherWetness(race.weather);
  const parts = [];
  if (venue.name && venue.name !== "?") {
    if (venue.frontBias > 0.05) parts.push(`${venue.name}は逃げ先行有利傾向`);
    else if (venue.frontBias < -0.05) parts.push(`${venue.name}は差し有利傾向`);
    if (venue.railBias > 0.05) parts.push(`内枠有利`);
    else if (venue.railBias < -0.05) parts.push(`外差し馬場`);
  }
  if (goingId >= 2) parts.push("馬場が重い→内枠+差し有利");
  else if (goingId === 1) parts.push("稍重→やや内枠有利");
  if (wetness > 0.5) parts.push("雨の影響");
  return parts.length ? parts.join(" / ") : "馬場バイアスはフラット";
}

module.exports = { computeBiasAdjustment, describeBias, getVenueBias, inferGoingId, _internal: { weatherWetness } };
