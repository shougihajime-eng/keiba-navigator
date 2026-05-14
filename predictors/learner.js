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
    // currentLv は 1 始まり / LEVELS は 0-index
    // 例: currentLv=1 → LEVELS[1]=Lv2, currentLv=5 → undefined → null (= 最高到達)
    if (!Number.isFinite(currentLv) || currentLv < 1) return LEVELS[1] || null;
    if (currentLv >= LEVELS.length) return null;
    return LEVELS[currentLv] || null;
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

  // ─── グレード別の実績校正 (online calibration) ──────────────
  // 設計:
  //   グレード S/A/B/C/D 別に「予想EV」と「実績回収率」を比較。
  //   実績/予想 の比 (calibrationRatio) を計算し、UI 上の「補正後EV」として
  //   利用する。データが少ないグレードは比 = 1.0 (補正なし)。
  //
  //   信頼区間: サンプル数 n が少ないと比は noisy なので、
  //             n が小さいときは 1.0 へ収縮 (Bayesian shrinkage)。
  //             effectiveRatio = (n * ratio + k * 1.0) / (n + k), k=10
  //
  // これは「AIが自分の予測のズレを学習する」最初の一歩。
  // JV-Link 接続後は LightGBM モデル自体がこの校正を内包するため、
  // weights.lgbm が learner_state に入った時点でこの層は無効化できる。
  const GRADES = ["S", "A", "B", "C", "D"];
  const SHRINKAGE_K = 10;

  function gradeOf(bet) {
    if (bet?.grade && GRADES.includes(bet.grade)) return bet.grade;
    const ev = Number(bet?.ev);
    if (!Number.isFinite(ev)) return null;
    if (ev >= 1.30) return "S";
    if (ev >= 1.10) return "A";
    if (ev >= 1.00) return "B";
    if (ev >= 0.85) return "C";
    return "D";
  }

  // メモ化キャッシュ (bets の長さ + 末尾 ts をキーにしてヒット判定)
  let _calibCache = null;     // { key, value }
  let _backtestCache = null;  // { key, value }
  function _cacheKey(bets) {
    if (!Array.isArray(bets) || bets.length === 0) return "empty";
    const last = bets[bets.length - 1];
    // bets が in-place 変更されると length が同じでも結果が変わるので、
    // 末尾要素の ts と result.won を組み合わせて識別する
    return `${bets.length}|${last?.ts || ""}|${last?.result?.won ?? ""}|${last?.amount ?? ""}`;
  }

  function computeCalibration(bets) {
    const key = _cacheKey(bets);
    if (_calibCache && _calibCache.key === key) return _calibCache.value;
    const cleaned = (Array.isArray(bets) ? bets : []).filter(b => b && b.dataSource !== "dummy");
    const confirmed = cleaned.filter(b => b.result?.won === true || b.result?.won === false);
    const byGrade = {};
    for (const g of GRADES) byGrade[g] = { samples: 0, hits: 0, spent: 0, ret: 0, evSum: 0 };
    for (const b of confirmed) {
      const g = gradeOf(b); if (!g) continue;
      const slot = byGrade[g];
      slot.samples += 1;
      slot.hits    += b.result.won ? 1 : 0;
      slot.spent   += b.amount || 0;
      slot.ret     += b.result.won ? (b.result.payout || 0) : 0;
      // ev が NaN/null の bet は evSum に含めない (補助値 1.0 を入れていた旧設計は
      // expectedRate と actualRate の比率を歪めていた)。
      const evNum = Number(b.ev);
      if (Number.isFinite(evNum)) {
        slot.evSum += evNum;
        slot.evCount = (slot.evCount || 0) + 1;
      }
    }
    const out = {};
    for (const g of GRADES) {
      const s = byGrade[g];
      const evCount = s.evCount || 0;
      // 予想 EV 平均 (ev が記録された bet 数で割る)
      const expectedRate = evCount ? s.evSum / evCount : null;
      // 実績回収率
      const actualRate   = s.spent   ? s.ret / s.spent : null;
      const rawRatio     = (expectedRate && expectedRate > 0 && actualRate != null) ? actualRate / expectedRate : null;
      const eff = rawRatio != null
        ? (s.samples * rawRatio + SHRINKAGE_K * 1.0) / (s.samples + SHRINKAGE_K)
        : 1.0;
      out[g] = {
        samples: s.samples, hits: s.hits,
        spent: s.spent, returned: s.ret,
        expectedRate, actualRate,
        rawRatio,
        ratio: eff,                           // 実際に EV にかける倍率
        // UI 用: ★信頼度 (samples / 30 を 0..1 にクリップ)
        confidence: Math.min(1, s.samples / 30),
      };
    }
    _calibCache = { key, value: out };
    return out;
  }

  // 補正後 EV (UI 表示用)
  function calibratedEV(grade, ev, calibration) {
    if (!grade || ev == null || !calibration) return ev;
    const slot = calibration[grade];
    if (!slot || !Number.isFinite(slot.ratio)) return ev;
    return Number(ev) * slot.ratio;
  }

  // ─── Supabase 同期 ──────────────────────────────────────────
  async function cloudSync(supabase, userId, bets) {
    if (!supabase || !userId) return { ok: false, reason: "not_signed_in" };
    const stats = computeStats(bets);
    const calib = computeCalibration(bets);
    try {
      await supabase.from("learner_state").upsert({
        user_id:    userId,
        model_name: MODEL_NAME,
        // weights: グレード別校正の倍率 (実質的な学習結果)
        // JV-Link 接続後は ここに lgbm: { ... } も追加して LightGBM の重みを保存
        weights:    { calibration_by_grade: calib },
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

  // ─── バックテスト: 補正前 vs 補正後 の累積収支カーブ ──────────
  // 設計:
  //   各 bet を時系列順に並べ、その時点で「過去のbetだけ」から計算した
  //   calibration を適用したらどうなっていたかをシミュレーション。
  //   これは look-ahead バイアスを避けた正しいバックテスト。
  //
  // 出力: { raw: [{date, profit, cum}], calibrated: [...], meta: {...} }
  //
  //   raw:        ユーザーが実際に置いた全 bet の累積収支
  //   calibrated: 各時点で calibration を適用し、補正後EV<=1.0 の bet は
  //               「買わない」として除外した場合の累積収支
  //
  // calibrated の方が高ければ、AIの自己学習が実際に役立つことの根拠。
  function backtest(bets) {
    const key = _cacheKey(bets);
    if (_backtestCache && _backtestCache.key === key) return _backtestCache.value;
    const cleaned = (Array.isArray(bets) ? bets : [])
      .filter(b => b && b.dataSource !== "dummy")
      .filter(b => b.result?.won === true || b.result?.won === false)
      .sort((a, b) => {
        const ta = new Date(a.result.finishedAt || a.ts).getTime();
        const tb = new Date(b.result.finishedAt || b.ts).getTime();
        return ta - tb;
      });

    const raw = [];
    const calibrated = [];
    let rawCum = 0, calCum = 0;
    let calIncluded = 0, calSkipped = 0;
    const history = [];  // 過去 bet を rolling で蓄積

    for (const b of cleaned) {
      const date = b.result.finishedAt || b.ts;
      const profit = (b.result.won ? (b.result.payout || 0) : 0) - (b.amount || 0);
      rawCum += profit;
      raw.push({ date, profit, cum: rawCum });

      // この時点での calibration (過去 bet のみから計算 = 厳密な look-ahead 排除)
      const pastCalib = computeCalibration(history);
      const grade = gradeOf(b);
      const slot  = grade ? pastCalib[grade] : null;
      const ratio = (slot && Number.isFinite(slot.ratio)) ? slot.ratio : 1.0;
      const calibratedEv = Number.isFinite(Number(b.ev)) ? Number(b.ev) * ratio : null;

      // 補正後EV > 1.0 なら買う、それ以外はスキップ (AIが見送り判断)
      if (calibratedEv != null && calibratedEv > 1.0) {
        calCum += profit;
        calIncluded++;
        calibrated.push({ date, profit, cum: calCum, included: true, calibratedEv, grade });
      } else {
        calSkipped++;
        // スキップしても累積には載せる (ただし profit=0)
        calibrated.push({ date, profit: 0, cum: calCum, included: false, calibratedEv, grade });
      }

      history.push(b);
    }

    const totalRaw = rawCum;
    const totalCal = calCum;
    const advantage = totalCal - totalRaw;
    const samples = cleaned.length;

    const result = {
      raw,
      calibrated,
      meta: {
        samples,
        calibratedIncluded: calIncluded,
        calibratedSkipped:  calSkipped,
        rawFinal:    totalRaw,
        calFinal:    totalCal,
        advantage,
        verdict: samples < 10
          ? "サンプル数不足 (10件以上で精度が出ます)"
          : advantage > 0
            ? `補正後の方が ¥${Math.round(advantage).toLocaleString("ja-JP")} 多い (AI の学習が効いている)`
            : advantage < 0
              ? `補正後の方が ¥${Math.round(-advantage).toLocaleString("ja-JP")} 少ない (補正が過保守か、まだ学習不足)`
              : "差分なし",
      },
    };
    _backtestCache = { key, value: result };
    return result;
  }

  global.Learner = {
    LEVELS,
    levelMeta,
    computeStats,
    computeCalibration,
    calibratedEV,
    gradeOf,
    cloudSync,
    backtest,
  };
})(typeof window !== "undefined" ? window : globalThis);
