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
//   馬番, オッズ, 人気?, 前走着順?, 馬名?
//   または
//   馬番, 馬名, オッズ, 人気?, 前走着順?
//
// 数値の判定で 馬名 列の位置を自動推定する。
function parseLine(line) {
  if (!line) return null;
  const cols = line
    .replace(/　/g, " ")
    .split(/[,\t\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (cols.length < 2) return null;

  // 数値列を抽出
  const numericIdx = cols.map((c, i) => Number.isFinite(Number(c)) ? i : -1).filter(i => i >= 0);
  // 名前は数値以外のうち長さ2文字以上の最初のもの
  const nameIdx = cols.findIndex((c, i) => !numericIdx.includes(i) && c.length >= 1);
  const name = nameIdx >= 0 ? cols[nameIdx] : null;
  // 残った数値列のうち、先頭は 馬番、その次以降は値が大きい順に判別
  const numVals = numericIdx.map(i => ({ idx: i, val: Number(cols[i]) }));
  if (numVals.length < 2) return null;
  // 馬番: 1〜30 の整数
  const horseNumIdx = numVals.findIndex(v => Number.isInteger(v.val) && v.val >= 1 && v.val <= 30);
  const horseNum = horseNumIdx >= 0 ? numVals.splice(horseNumIdx, 1)[0].val : null;
  // オッズ: 残りの数値で値が一番大きいもの (人気・前走は典型的に小さい数値)
  numVals.sort((a, b) => b.val - a.val);
  const odds = numVals.length ? numVals.shift().val : null;
  // 人気: 1〜30 の整数
  const popIdx = numVals.findIndex(v => Number.isInteger(v.val) && v.val >= 1 && v.val <= 30);
  const popularity = popIdx >= 0 ? numVals.splice(popIdx, 1)[0].val : null;
  // 前走着順: 1〜18 の整数
  const prevIdx = numVals.findIndex(v => Number.isInteger(v.val) && v.val >= 1 && v.val <= 18);
  const prevFinish = prevIdx >= 0 ? numVals.splice(prevIdx, 1)[0].val : null;

  if (horseNum === null) return null;
  return {
    number: horseNum,
    name: name,
    win_odds: odds,
    popularity: popularity,
    prev_finish: prevFinish,
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

  const race = {
    race_id:   "manual_" + Date.now(),
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
