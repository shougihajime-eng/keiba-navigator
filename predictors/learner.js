"use strict";

/**
 * KEIBA NAVIGATOR — オンライン学習モジュール (ブラウザ実行)
 *
 * 役割:
 *   1) 馬券記録 (確定済) から AI の「育成レベル(★1-5)」を計算
 *   2) 学習指標 (件数・的中率・回収率・Brierスコア) を継続更新
 *   3) Supabase `keiba.learner_state` に同期 (ログイン時)
 *
 * 設計:
 *   - 仮データ(dummy)起源の bet は学習対象外
 *   - JV-Link 接続後は LightGBM/DL の重みを weights.lgbm / weights.dl に保存
 *     → 同じスキーマで本格学習に無停止移行
 *
 * 公開 API:
 *   Learner.computeStats(bets)            -> { samples, hits, recovery, brier, level, levelName }
 *   Learner.levelMeta(level)              -> { name, sub, requiredSamples }
 *   Learner.cloudSync(supabase, userId)   -> Promise<void>  (任意)
 */

(function (global) {
  const MODEL_NAME = "heuristic_v1";

  // ─── レベル定義 ──────────────────────────────────────────
  // レベルは「学習データの量」と「回収率」の二軸で評価。
  // ★5 は 500件以上 + 回収率 100% 超を要件にする (簡単には到達しない)。
  const LEVELS = [
    { lv: 1, name: "ひよこ AI",      sub: "まだ学習開始前",          minSamples: 0,    minRecovery: 0    },
    { lv: 2, name: "見習い AI",      sub: "基礎学習中",              minSamples: 10,   minRecovery: 0    },
    { lv: 3, name: "中堅 AI",        sub: "傾向を掴みつつある",      minSamples: 30,   minRecovery: 0    },
    { lv: 4, name: "上級 AI",        sub: "回収率の検証段階",        minSamples: 100,  minRecovery: 0.85 },
    { lv: 5, name: "世界クラス AI",  sub: "回収率100%超を維持中",    minSamples: 500,  minRecovery: 1.00 },
  ];

  function levelFromStats(samples, recovery) {
    let chosen = LEVELS[0];
    for (const lv of LEVELS) {
      const okSamples  = samples  >= lv.minSamples;
      const okRecovery = recovery == null ? lv.minRecovery <= 0 : recovery >= lv.minRecovery;
      if (okSamples && okRecovery) chosen = lv;
    }
    return chosen;
  }

  function levelMeta(lv) { return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, lv - 1))]; }

  function nextLevelTarget(currentLv) {
    const next = LEVELS[currentLv]; // 配列は 0-index, currentLv は 1始まり
    return next || null;
  }

  // ─── 統計計算 (dummy 起源は除外) ──────────────────────────
  function computeStats(bets) {
    const cleaned = (Array.isArray(bets) ? bets : []).filter(b => b && b.dataSource !== "dummy");
    const confirmed = cleaned.filter(b => b.result?.won === true || b.result?.won === false);
    const wins = confirmed.filter(b => b.result.won);
    const totalSpent  = confirmed.reduce((a, b) => a + (b.amount || 0), 0);
    const totalReturn = wins.reduce((a, b) => a + (b.result.payout || 0), 0);

    // Brier スコア: 推定勝率 prob と実結果 (won=1, lost=0) の二乗誤差平均
    // (低いほど予測が正確。確定 bet で prob が記録されていれば計算)
    const probSamples = confirmed.filter(b => typeof b.prob === "number");
    const brier = probSamples.length
      ? probSamples.reduce((a, b) => a + Math.pow(b.prob - (b.result.won ? 1 : 0), 2), 0) / probSamples.length
      : null;

    const samples  = confirmed.length;
    const hitRate  = samples ? wins.length / samples : null;
    const recovery = totalSpent ? totalReturn / totalSpent : null;
    const lvObj    = levelFromStats(samples, recovery);
    const next     = nextLevelTarget(lvObj.lv);

    return {
      samples,
      pending: cleaned.length - samples,
      hits: wins.length,
      hitRate,
      recovery,
      brier,
      level: lvObj.lv,
      levelName: lvObj.name,
      levelSub:  lvObj.sub,
      progress: progressToNext(samples, recovery, lvObj, next),
      nextLevel: next,
    };
  }

  function progressToNext(samples, recovery, current, next) {
    if (!next) return { pct: 100, hint: "最高レベル到達" };
    const sampleProgress = Math.min(1, samples / Math.max(1, next.minSamples));
    const recReq = next.minRecovery || 0;
    const recProgress = recReq <= 0 ? 1 : Math.min(1, (recovery ?? 0) / recReq);
    const pct = Math.round(Math.min(sampleProgress, recProgress) * 100);
    let hint = "";
    if (samples < next.minSamples) {
      hint = `あと ${next.minSamples - samples} 件記録すると Lv${next.lv} に到達`;
    } else if (recReq > 0 && (recovery ?? 0) < recReq) {
      hint = `Lv${next.lv} 到達には回収率 ${Math.round(recReq * 100)}% 以上が必要`;
    } else {
      hint = "次のレベルが近い";
    }
    return { pct, hint };
  }

  // ─── Supabase 同期 ──────────────────────────────────────────
  async function cloudSync(supabase, userId, bets) {
    if (!supabase || !userId) return { ok: false, reason: "not_signed_in" };
    const stats = computeStats(bets);
    try {
      await supabase.from("learner_state").upsert({
        user_id:    userId,
        model_name: MODEL_NAME,
        weights:    {},  // 現状 heuristic は固定重み。学習モデル差替後にここを更新
        metrics: {
          samples:  stats.samples,
          hits:     stats.hits,
          hit_rate: stats.hitRate,
          recovery: stats.recovery,
          brier:    stats.brier,
        },
        history: [],
        level: stats.level,
        updated_at: new Date().toISOString(),
      });
      return { ok: true };
    } catch (e) {
      console.warn("[learner] cloud sync failed", e);
      return { ok: false, reason: String(e.message || e) };
    }
  }

  global.Learner = {
    LEVELS,
    levelMeta,
    computeStats,
    cloudSync,
  };
})(typeof window !== "undefined" ? window : globalThis);
