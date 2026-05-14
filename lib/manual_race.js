"use strict";

// ─────────────────────────────────────────────────────────────
// 手動レース入力 → buildConclusion 互換 race オブジェクト構築
//
// 無料路線の本命機能。JV-Link が無くても、ユーザーが JRA 公式の
// オッズ画面を見ながら最低限の値 (馬番・オッズ・前走着順) を入力すれば
// 期待値判定が実行できる。
// ─────────────────────────────────────────────────────────────

const { buildConclusion } = require("./conclusion");

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 1 行 = 1 頭。区切りは カンマ / タブ / 全角空白 / 半角空白(連続OK)
// 想定列順:
//   馬番 馬名 オッズ 人気? 前走着順? [騎手?] [調教師?]
//
// 数値の判定で 馬名 列の位置を自動推定する。
// 非数値トークンが複数あるとき:
//   - 1番目 → 馬名
//   - 2番目 → 騎手
//   - 3番目 → 調教師
function parseLine(line) {
  if (!line) return null;
  const cols = line
    .replace(/　/g, " ")
    .split(/[,\t\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (cols.length < 2) return null;

  // 数値列を抽出
  const numericIdxSet = new Set();
  cols.forEach((c, i) => { if (Number.isFinite(Number(c))) numericIdxSet.add(i); });

  // 非数値トークン (馬名・騎手・調教師の候補)
  const nonNumericIdxs = cols
    .map((c, i) => (!numericIdxSet.has(i) && c.length >= 1) ? i : -1)
    .filter(i => i >= 0);
  const name    = nonNumericIdxs[0] != null ? cols[nonNumericIdxs[0]] : null;
  const jockey  = nonNumericIdxs[1] != null ? cols[nonNumericIdxs[1]] : null;
  const trainer = nonNumericIdxs[2] != null ? cols[nonNumericIdxs[2]] : null;

  // 数値配列を作成 (元の配列は変更しない・splice の副作用を排除)
  let numVals = Array.from(numericIdxSet).sort((a, b) => a - b)
    .map(i => ({ idx: i, val: Number(cols[i]) }));
  if (numVals.length < 2) return null;

  // 馬番: 1〜30 の整数。最初に見つかったものを採用 (左から右に走査)
  const horseNumIdx = numVals.findIndex(v => Number.isInteger(v.val) && v.val >= 1 && v.val <= 30);
  if (horseNumIdx < 0) return null;
  const horseNum = numVals[horseNumIdx].val;
  numVals = numVals.filter((_, i) => i !== horseNumIdx);

  // オッズ: 残りの数値の中で最大値 (人気・前走は典型的に小さい数値で 1〜18 範囲)
  if (!numVals.length) {
    return { number: horseNum, name, win_odds: null, popularity: null, prev_finish: null, jockey, trainer };
  }
  let oddsIdx = 0;
  for (let i = 1; i < numVals.length; i++) {
    if (numVals[i].val > numVals[oddsIdx].val) oddsIdx = i;
  }
  const odds = numVals[oddsIdx].val;
  numVals = numVals.filter((_, i) => i !== oddsIdx);

  // 人気: 1〜30 の整数。次の整数候補を採用
  const popIdx = numVals.findIndex(v => Number.isInteger(v.val) && v.val >= 1 && v.val <= 30);
  let popularity = null;
  if (popIdx >= 0) {
    popularity = numVals[popIdx].val;
    numVals = numVals.filter((_, i) => i !== popIdx);
  }

  // 前走着順: 1〜18 の整数
  const prevIdx = numVals.findIndex(v => Number.isInteger(v.val) && v.val >= 1 && v.val <= 18);
  const prevFinish = prevIdx >= 0 ? numVals[prevIdx].val : null;

  return {
    number: horseNum,
    name: name,
    win_odds: odds,
    popularity: popularity,
    prev_finish: prevFinish,
    jockey: jockey,
    trainer: trainer,
  };
}

function parseTextInput(text) {
  if (!text || typeof text !== "string") return [];
  return text.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#") && !/^馬番|^番号|^[-–]+$/i.test(l)) // ヘッダー行を除外
    .map(parseLine)
    .filter(Boolean);
}

// 入力 (text / horses[]) から race オブジェクトを構築し、buildConclusion に渡す
function buildManualConclusion(input) {
  let horses;
  if (input && Array.isArray(input.horses)) {
    horses = input.horses.map(h => ({
      number: num(h.number),
      name: h.name || null,
      win_odds: num(h.odds ?? h.win_odds),
      popularity: num(h.popularity),
      prev_finish: num(h.prevFinish ?? h.prev_finish),
      weight: num(h.weight),
      sex_age: h.sex_age || null,
      jockey: h.jockey || null,
      trainer: h.trainer || null,
    })).filter(h => h.number !== null && h.win_odds !== null);
  } else if (input && typeof input.text === "string") {
    horses = parseTextInput(input.text);
  } else {
    horses = [];
  }

  if (!horses.length) {
    return {
      ok: false,
      verdict: "judgement_unavailable",
      verdictTitle: "入力不足",
      verdictReason: "馬番とオッズが含まれた行がありません。例: `1 ディープ 3.2 1 5`",
      reason: "入力が空、または形式が正しくありません",
      reasonList: [],
      picks: [], avoid: [], overpopular: [], undervalued: [],
      bets: { tan: null, fuku: null, uren: null },
      confidence: 0,
      raceMeta: { isDummy: false, dataSource: "manual", source: "manual" },
    };
  }

  // race_id: ミリ秒タイムスタンプ + ランダム接尾辞で衝突回避 (同一ミリ秒の連投対策)
  const suffix = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  const race = {
    race_id:   "manual_" + Date.now() + "_" + suffix,
    race_name: input.raceName || "手動入力レース",
    source:    "manual",
    is_dummy:  false,
    last_updated: new Date().toISOString(),
    horses,
  };

  const c = buildConclusion(race);
  // 手動入力であることを raceMeta に明示
  if (c?.raceMeta) {
    c.raceMeta.dataSource = "manual";
    c.raceMeta.source = "manual";
  }
  return c;
}

module.exports = { buildManualConclusion, parseTextInput, parseLine };
