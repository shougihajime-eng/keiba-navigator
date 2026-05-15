"use strict";

/**
 * KEIBA NAVIGATOR — ランキング計算モジュール
 *
 * 役割:
 *   1) 過去の馬券記録 (bets) と features.json から
 *      「厩舎ベスト10 / 騎手ベスト10 / 注目馬ベスト10」を計算する
 *   2) データが少ない場合はベイジアン縮約 (prior k=20) で
 *      ノイズに引っ張られないランキングにする
 *   3) 「最近の調子」スコア = 直近4週間の的中率 / 通算的中率 の比
 *      → 上向きの厩舎・騎手を優先表示
 *
 * 公開 API:
 *   Rankings.compute(bets, features?, options?)
 *     -> { trainers: [...], jockeys: [...], horses: [...], generatedAt: ISO }
 *
 *   Rankings.format(top10) -> 表示用フォーマット
 */

(function (global) {
  const PRIOR_K = 20;                   // ベイジアン縮約の prior サンプル数
  const BASELINE_WIN_RATE = 0.075;      // 平均勝率 (8%弱・JRA 公式統計より)
  const BASELINE_HIT_RATE = 0.30;       // 平均的中率 (複勝相当)
  const TOP_N = 10;                     // 各カテゴリのトップ件数
  const RECENT_DAYS = 28;               // 「最近の調子」判定期間

  // ─── ヘルパー ───────────────────────────────────────────
  function daysAgo(iso) {
    if (!iso) return Infinity;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return Infinity;
    return (Date.now() - t) / (1000 * 60 * 60 * 24);
  }

  function isRealBet(b) {
    // 仮データ・エア馬券は学習対象外
    return b && !b.dummy && !b.is_dummy && b.type !== "air";
  }

  function isFinalized(b) {
    return b && (b.won === true || b.won === false || typeof b.won === "number");
  }

  function wonTrue(b) {
    return b.won === true || b.won === 1;
  }

  // ベイジアン縮約: rate_smoothed = (hits + prior * baseline) / (samples + prior)
  function shrunkRate(hits, samples, baseline = BASELINE_HIT_RATE, prior = PRIOR_K) {
    if (samples <= 0) return baseline;
    return (hits + prior * baseline) / (samples + prior);
  }

  // ─── 集計 ───────────────────────────────────────────────
  function aggregateBy(bets, keyFn) {
    const map = new Map();
    for (const b of bets) {
      if (!isRealBet(b) || !isFinalized(b)) continue;
      const key = keyFn(b);
      if (!key) continue;
      const slot = map.get(key) || {
        key, samples: 0, hits: 0,
        recent_samples: 0, recent_hits: 0,
        stakeSum: 0, payoutSum: 0,
        lastSeen: null,
      };
      slot.samples += 1;
      if (wonTrue(b)) slot.hits += 1;
      const isRecent = daysAgo(b.createdAt || b.created_at || b.date) <= RECENT_DAYS;
      if (isRecent) {
        slot.recent_samples += 1;
        if (wonTrue(b)) slot.recent_hits += 1;
      }
      if (typeof b.stake === "number" && b.stake > 0) slot.stakeSum += b.stake;
      if (typeof b.payout === "number" && b.payout > 0) slot.payoutSum += b.payout;
      if (b.createdAt || b.created_at || b.date) {
        const t = b.createdAt || b.created_at || b.date;
        if (!slot.lastSeen || t > slot.lastSeen) slot.lastSeen = t;
      }
      map.set(key, slot);
    }
    return Array.from(map.values());
  }

  function scoreEntry(e) {
    // 縮約済み的中率 (主スコア・全期間)
    const lifetimeRate = shrunkRate(e.hits, e.samples);
    // 最近4週間の縮約済み的中率
    const recentRate = shrunkRate(e.recent_hits, e.recent_samples, lifetimeRate, Math.max(5, e.recent_samples));
    // 調子 = 最近 / 通算 (1.0 = フラット・>1 = 上向き)
    const trend = lifetimeRate > 0 ? recentRate / lifetimeRate : 1;
    // 回収率 (払戻 / 賭金) ※サンプル少ない時は無視
    const recovery = e.stakeSum > 0 ? e.payoutSum / e.stakeSum : null;

    // 合成スコア: 縮約済み的中率 × 調子の補正 + 回収率ボーナス
    let score = lifetimeRate * 100;
    score *= Math.max(0.5, Math.min(1.5, trend));   // 調子は ±50% まで効かせる
    if (recovery != null) {
      score += (recovery - 1.0) * 10;  // 回収率 100% 超でボーナス・割れで減点
    }
    return { ...e, lifetimeRate, recentRate, trend, recovery, score };
  }

  // ─── 公開関数 ───────────────────────────────────────────
  function compute(bets, features, options = {}) {
    const topN = options.topN || TOP_N;
    const arr = Array.isArray(bets) ? bets : [];

    const trainers = aggregateBy(arr, (b) => b.trainer || b.trainerName)
      .map(scoreEntry)
      .filter(e => e.samples >= 3)             // 最低3戦
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);

    const jockeys = aggregateBy(arr, (b) => b.jockey || b.jockeyName)
      .map(scoreEntry)
      .filter(e => e.samples >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);

    const horses = aggregateBy(arr, (b) => b.horseName || b.horse_name || b.name)
      .map(scoreEntry)
      .filter(e => e.samples >= 2)             // 馬は2戦から評価
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);

    // features.json が読めるなら、aggregate_features (JV-Link 由来) の
    // 全国規模統計でも上書きランキングを作る
    let featureTrainers = [];
    let featureJockeys = [];
    if (features && typeof features === "object") {
      featureTrainers = extractFromFeatures(features, "trainerWinRate", "trainerInThreeRate", topN);
      featureJockeys  = extractFromFeatures(features, "jockeyWinRate",  "jockeyInThreeRate",  topN);
    }

    return {
      trainers, jockeys, horses,
      featureTrainers, featureJockeys,
      sampleCount: arr.filter(isRealBet).filter(isFinalized).length,
      generatedAt: new Date().toISOString(),
    };
  }

  // features.json (raceId → horseNum → {jockeyWinRate, trainerWinRate, ...})
  // から全国規模の騎手・調教師ランキングを抽出。
  // 名前情報は features.json には無いので race の horse 情報と組み合わせる必要があるが、
  // ここでは「集計の存在」を確認する用途に留める。
  function extractFromFeatures(features, mainKey, secKey, topN) {
    if (!features || typeof features !== "object") return [];
    const acc = new Map();
    for (const raceId of Object.keys(features)) {
      if (raceId.startsWith("_")) continue;
      const horsesObj = features[raceId];
      if (!horsesObj || typeof horsesObj !== "object") continue;
      for (const hk of Object.keys(horsesObj)) {
        const h = horsesObj[hk];
        const v = h && h[mainKey];
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        const key = h.name || h.label || `${raceId}#${hk}`;
        const slot = acc.get(key) || { key, samples: 0, sum: 0, sumSec: 0 };
        slot.samples += 1;
        slot.sum += v;
        if (typeof h[secKey] === "number") slot.sumSec += h[secKey];
        acc.set(key, slot);
      }
    }
    return Array.from(acc.values())
      .map(s => ({ ...s, avgRate: s.sum / s.samples, avgSec: s.sumSec / s.samples }))
      .sort((a, b) => b.avgRate - a.avgRate)
      .slice(0, topN);
  }

  // 表示用ラベル化
  function formatBadge(e, i) {
    if (i === 0) return "🥇";
    if (i === 1) return "🥈";
    if (i === 2) return "🥉";
    return `${i + 1}`;
  }

  function trendIcon(trend) {
    if (!Number.isFinite(trend)) return "—";
    if (trend >= 1.2) return "↑↑";    // 急上昇
    if (trend >= 1.05) return "↑";    // 上昇
    if (trend <= 0.8) return "↓↓";    // 急落
    if (trend <= 0.95) return "↓";    // 下降
    return "→";                        // 横ばい
  }

  function trendClass(trend) {
    if (!Number.isFinite(trend)) return "trend-flat";
    if (trend >= 1.2)  return "trend-up-fast";
    if (trend >= 1.05) return "trend-up";
    if (trend <= 0.8)  return "trend-down-fast";
    if (trend <= 0.95) return "trend-down";
    return "trend-flat";
  }

  global.Rankings = {
    compute,
    formatBadge,
    trendIcon,
    trendClass,
    _internal: { shrunkRate, scoreEntry, aggregateBy },
  };
})(typeof window !== "undefined" ? window : globalThis);
