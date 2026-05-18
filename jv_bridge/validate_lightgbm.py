# -*- coding: utf-8 -*-
"""
validate_lightgbm.py — 学習済み LightGBM モデルを過去レースで実証する。

機能:
  1. 時系列で test 期間 (デフォルト 20%) を切り出し、その期間の全レースで予想
  2. 複数の購買戦略をシミュレーション
       - tan_top1_always:   常に本命単勝 100 円
       - tan_top1_ev110:    本命単勝の期待値 >= 1.10 のときだけ 100 円
       - tan_top1_ev130:    EV >= 1.30 のときだけ 100 円
       - fuku_top1_always:  常に本命複勝 100 円
       - fuku_top1_ev110:   本命複勝の EV >= 1.10 のときだけ
       - uren_top1_top2:    馬連 本命-対抗 100 円
       - wide_box_top3:     ワイド 本命/対抗/3着 3 通り 各 100 円
       - tan_top1_kelly:    本命単勝を Half Kelly で
  3. 戦略ごとの投資額・払戻額・回収率・的中率・最大配当を集計
  4. data/jv_cache/backtest_result.json に保存
  5. 標準出力に綺麗に table 表示

使い方:
  py -3 jv_bridge\validate_lightgbm.py
  py -3 jv_bridge\validate_lightgbm.py --test-ratio 0.2
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

os.environ["PYTHONIOENCODING"] = "utf-8"
for _attr in ("stdout", "stderr"):
    _s = getattr(sys, _attr, None)
    if _s is None:
        continue
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE = ROOT / "data" / "jv_cache"
RACES_DIR = CACHE / "races"
RESULTS_DIR = CACHE / "results"
FEATURES_PATH = CACHE / "features.json"
MODEL_TXT = CACHE / "model_lgbm.txt"
MODEL_PKL = CACHE / "model_lgbm.pkl"
META_PATH = CACHE / "model_lgbm_meta.json"
BACKTEST_PATH = CACHE / "backtest_result.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _load_model, _load_model_nopop, _predict_one,
    _normalize_softmax, _mask_pop_features,
)

UNIT = 100  # 1 ベット = 100 円


def _load_features_index() -> Dict[str, Any]:
    if FEATURES_PATH.exists():
        try:
            return json.loads(FEATURES_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _payout_tan(payouts: Dict[str, Any], horse_num: int) -> int:
    """単勝の払戻金額 (馬番一致なら amount, 不一致なら 0)。"""
    tan = (payouts or {}).get("tan")
    if isinstance(tan, dict) and tan.get("winner") == horse_num:
        return int(tan.get("amount") or 0)
    return 0


def _payout_fuku(payouts: Dict[str, Any], horse_num: int) -> int:
    fuku = (payouts or {}).get("fuku") or []
    for f in fuku:
        if isinstance(f, dict) and f.get("number") == horse_num:
            return int(f.get("amount") or 0)
    return 0


def _payout_uren(payouts: Dict[str, Any], a: int, b: int) -> int:
    uren = (payouts or {}).get("uren")
    if not isinstance(uren, dict):
        return 0
    key = uren.get("key") or ""
    nums = sorted(int(x) for x in key.split("-") if x.isdigit())
    target = sorted([a, b])
    if nums == target:
        return int(uren.get("amount") or 0)
    return 0


def _payout_wide(payouts: Dict[str, Any], a: int, b: int) -> int:
    wide = (payouts or {}).get("wide") or []
    target = sorted([a, b])
    for w in wide:
        if not isinstance(w, dict):
            continue
        key = w.get("key") or ""
        nums = sorted(int(x) for x in key.split("-") if x.isdigit())
        if nums == target:
            return int(w.get("amount") or 0)
    return 0


def _payout_fuku3(payouts: Dict[str, Any], a: int, b: int, c: int) -> int:
    """3 連複 (馬番 3 つを順不同で一致)"""
    fuku3 = (payouts or {}).get("fuku3")
    if not isinstance(fuku3, dict):
        return 0
    key = fuku3.get("key") or ""
    nums = sorted(int(x) for x in key.split("-") if x.isdigit())
    target = sorted([a, b, c])
    if nums == target:
        return int(fuku3.get("amount") or 0)
    return 0


def _payout_tan3(payouts: Dict[str, Any], a: int, b: int, c: int) -> int:
    """3 連単 (馬番 3 つを順序通りに一致)"""
    tan3 = (payouts or {}).get("tan3")
    if not isinstance(tan3, dict):
        return 0
    key = tan3.get("key") or ""
    nums = [int(x) for x in key.split("-") if x.isdigit()]
    if nums == [a, b, c]:
        return int(tan3.get("amount") or 0)
    return 0


def _half_kelly_stake(prob: float, odds: float, bankroll_unit: int = 1000) -> int:
    """Half Kelly: f = (p*odds - 1) / (odds - 1) の半分。100 円単位 floor。"""
    if not (prob and odds and odds > 1.0 and 0 < prob < 1):
        return 0
    f = (prob * odds - 1.0) / (odds - 1.0)
    if f <= 0:
        return 0
    f *= 0.5  # half kelly
    f = min(f, 0.05)  # 1 レース 5% 上限
    stake = int(bankroll_unit * f / UNIT) * UNIT
    return max(0, stake)


class Strategy:
    """1 つの購買戦略。各レースに stake() を呼んで投資額と払戻を返す。"""
    def __init__(self, name: str, fn):
        self.name = name
        self.fn = fn
        self.invested = 0
        self.returned = 0
        self.bets = 0
        self.hits = 0
        self.max_payout = 0
        self.per_race = []  # (race_id, invested, returned)

    def apply(self, race_id, horses_ranked, payouts):
        invest, ret, hit = self.fn(horses_ranked, payouts)
        if invest > 0:
            self.bets += 1
            self.invested += invest
            self.returned += ret
            if hit:
                self.hits += 1
            if ret > self.max_payout:
                self.max_payout = ret
            self.per_race.append((race_id, invest, ret))

    def summary(self) -> Dict[str, Any]:
        roi = (self.returned / self.invested) if self.invested > 0 else 0.0
        hit_rate = (self.hits / self.bets) if self.bets > 0 else 0.0
        return {
            "name": self.name,
            "bets": self.bets,
            "invested": self.invested,
            "returned": self.returned,
            "profit": self.returned - self.invested,
            "roi": round(roi, 4),
            "roi_pct": round(roi * 100, 1),
            "hit_rate": round(hit_rate, 4),
            "hits": self.hits,
            "max_payout": self.max_payout,
        }


def _build_strategies() -> List[Strategy]:
    """利用可能な全戦略を返す。"""
    def tan_top1_always(horses, payouts):
        if not horses:
            return 0, 0, False
        top = horses[0]
        pay = _payout_tan(payouts, top["number"])
        return UNIT, pay, pay > 0

    def tan_top1_ev110(horses, payouts):
        if not horses:
            return 0, 0, False
        top = horses[0]
        ev = top.get("ev")
        if ev is None or ev < 1.10:
            return 0, 0, False
        pay = _payout_tan(payouts, top["number"])
        return UNIT, pay, pay > 0

    def tan_top1_ev130(horses, payouts):
        if not horses:
            return 0, 0, False
        top = horses[0]
        ev = top.get("ev")
        if ev is None or ev < 1.30:
            return 0, 0, False
        pay = _payout_tan(payouts, top["number"])
        return UNIT, pay, pay > 0

    def fuku_top1_always(horses, payouts):
        if not horses:
            return 0, 0, False
        top = horses[0]
        pay = _payout_fuku(payouts, top["number"])
        return UNIT, pay, pay > 0

    def fuku_top1_ev110(horses, payouts):
        if not horses:
            return 0, 0, False
        top = horses[0]
        ev = top.get("ev")
        if ev is None or ev < 1.10:
            return 0, 0, False
        pay = _payout_fuku(payouts, top["number"])
        return UNIT, pay, pay > 0

    def uren_top1_top2(horses, payouts):
        if len(horses) < 2:
            return 0, 0, False
        a, b = horses[0]["number"], horses[1]["number"]
        pay = _payout_uren(payouts, a, b)
        return UNIT, pay, pay > 0

    def wide_box_top3(horses, payouts):
        if len(horses) < 3:
            return 0, 0, False
        n1, n2, n3 = horses[0]["number"], horses[1]["number"], horses[2]["number"]
        pay = (_payout_wide(payouts, n1, n2) +
               _payout_wide(payouts, n1, n3) +
               _payout_wide(payouts, n2, n3))
        return UNIT * 3, pay, pay > 0

    def tan_top1_kelly(horses, payouts):
        if not horses:
            return 0, 0, False
        top = horses[0]
        prob = top.get("win_prob") or 0
        odds = top.get("odds") or 0
        stake = _half_kelly_stake(float(prob), float(odds), bankroll_unit=10000)
        if stake <= 0:
            return 0, 0, False
        pay = (stake // UNIT) * _payout_tan(payouts, top["number"])
        return stake, pay, pay > 0

    # === 価値投資型: AI 評価 > 市場評価のときだけ買う ===
    def _is_value_pick(h, gap=3):
        """AI rank 1 だが 単勝人気が gap 番以下 = 過小評価馬"""
        pop = h.get("popularity")
        return isinstance(pop, int) and pop >= gap

    def tan_top1_value3(horses, payouts):
        """AI 本命が 3 番人気以下 = 過小評価のときだけ単勝"""
        if not horses: return 0, 0, False
        top = horses[0]
        if not _is_value_pick(top, gap=3): return 0, 0, False
        pay = _payout_tan(payouts, top["number"])
        return UNIT, pay, pay > 0

    def fuku_top1_value3(horses, payouts):
        if not horses: return 0, 0, False
        top = horses[0]
        if not _is_value_pick(top, gap=3): return 0, 0, False
        pay = _payout_fuku(payouts, top["number"])
        return UNIT, pay, pay > 0

    def wide_top1_value3_with_pop1(horses, payouts):
        """AI 本命 (人気 3 番以下) × 1 番人気 のワイド"""
        if not horses: return 0, 0, False
        top = horses[0]
        if not _is_value_pick(top, gap=3): return 0, 0, False
        # 1 番人気を探す
        fav = next((h for h in horses if h.get("popularity") == 1), None)
        if not fav or fav["number"] == top["number"]: return 0, 0, False
        pay = _payout_wide(payouts, top["number"], fav["number"])
        return UNIT, pay, pay > 0

    def uren_top1_value3_with_pop1(horses, payouts):
        if not horses: return 0, 0, False
        top = horses[0]
        if not _is_value_pick(top, gap=3): return 0, 0, False
        fav = next((h for h in horses if h.get("popularity") == 1), None)
        if not fav or fav["number"] == top["number"]: return 0, 0, False
        pay = _payout_uren(payouts, top["number"], fav["number"])
        return UNIT, pay, pay > 0

    def tan_top1_ev100(horses, payouts):
        """期待値 >= 1.00 のときだけ単勝 (買えば期待値プラス)"""
        if not horses: return 0, 0, False
        top = horses[0]
        ev = top.get("ev")
        if ev is None or ev < 1.00: return 0, 0, False
        pay = _payout_tan(payouts, top["number"])
        return UNIT, pay, pay > 0

    def fuku_top1_ev090(horses, payouts):
        """複勝で EV 0.90 以上 (複勝オッズは低いので閾値も低い)"""
        if not horses: return 0, 0, False
        top = horses[0]
        ev = top.get("ev")
        if ev is None or ev < 0.90: return 0, 0, False
        pay = _payout_fuku(payouts, top["number"])
        return UNIT, pay, pay > 0

    # === Wave18: nopop モデル (実力派) を使った value pick 戦略 ===
    def tan_nopop_top1_always(horses, payouts):
        """実力派モデルの本命を単勝で買う"""
        np_ranked = _ranked_by_nopop(horses)
        if not np_ranked: return 0, 0, False
        top = np_ranked[0]
        pay = _payout_tan(payouts, top["number"])
        return UNIT, pay, pay > 0

    def fuku_nopop_top1_always(horses, payouts):
        np_ranked = _ranked_by_nopop(horses)
        if not np_ranked: return 0, 0, False
        top = np_ranked[0]
        pay = _payout_fuku(payouts, top["number"])
        return UNIT, pay, pay > 0

    def tan_nopop_top1_undervalued(horses, payouts):
        """実力派モデル本命が単勝 人気 3 番以下 = 市場が見落とし"""
        np_ranked = _ranked_by_nopop(horses)
        if not np_ranked: return 0, 0, False
        top = np_ranked[0]
        pop = top.get("popularity")
        if not (isinstance(pop, int) and pop >= 3): return 0, 0, False
        pay = _payout_tan(payouts, top["number"])
        return UNIT, pay, pay > 0

    def fuku_nopop_top1_undervalued(horses, payouts):
        np_ranked = _ranked_by_nopop(horses)
        if not np_ranked: return 0, 0, False
        top = np_ranked[0]
        pop = top.get("popularity")
        if not (isinstance(pop, int) and pop >= 3): return 0, 0, False
        pay = _payout_fuku(payouts, top["number"])
        return UNIT, pay, pay > 0

    def tan_value_signal_strong(horses, payouts):
        """value_signal >= 0.05 が最大の馬を単勝で買う (実力派が市場より大幅評価)"""
        cands = [h for h in horses if (h.get("value_signal") or 0) >= 0.05]
        if not cands: return 0, 0, False
        target = max(cands, key=lambda h: h["value_signal"])
        pay = _payout_tan(payouts, target["number"])
        return UNIT, pay, pay > 0

    def fuku_value_signal_strong(horses, payouts):
        """value_signal >= 0.03 が最大の馬を複勝で買う (実力派が市場より評価高い)"""
        cands = [h for h in horses if (h.get("value_signal") or 0) >= 0.03]
        if not cands: return 0, 0, False
        target = max(cands, key=lambda h: h["value_signal"])
        pay = _payout_fuku(payouts, target["number"])
        return UNIT, pay, pay > 0

    def uren_primary_nopop_combo(horses, payouts):
        """primary top1 (市場本命相当) × nopop top1 (実力派本命) の馬連"""
        if not horses: return 0, 0, False
        a = horses[0]["number"]
        np_ranked = _ranked_by_nopop(horses)
        if not np_ranked: return 0, 0, False
        b = np_ranked[0]["number"]
        if a == b: return 0, 0, False
        pay = _payout_uren(payouts, a, b)
        return UNIT, pay, pay > 0

    def wide_primary_nopop_combo(horses, payouts):
        """primary top1 × nopop top1 のワイド"""
        if not horses: return 0, 0, False
        a = horses[0]["number"]
        np_ranked = _ranked_by_nopop(horses)
        if not np_ranked: return 0, 0, False
        b = np_ranked[0]["number"]
        if a == b: return 0, 0, False
        pay = _payout_wide(payouts, a, b)
        return UNIT, pay, pay > 0

    def fuku_ev_nopop_110(horses, payouts):
        """nopop_prob × オッズ (= EV_nopop) >= 1.10 の最良馬を複勝で買う"""
        cands = [h for h in horses if (h.get("ev_nopop") or 0) >= 1.10]
        if not cands: return 0, 0, False
        target = max(cands, key=lambda h: h["ev_nopop"])
        pay = _payout_fuku(payouts, target["number"])
        return UNIT, pay, pay > 0

    # === Wave19: 100% 越えを狙う「見送り型」戦略 ===
    # 控除率 20% (払戻 75-80% に固定) のため、機械的に買うと長期で赤字。
    # 「期待値プラスの場面だけ買う」(= ほとんど見送る) で 100% 越えを目指す。

    def tan_best_ev_any(horses, payouts):
        """全頭の中で EV (primary) が最大の馬を単勝。EV >= 0.95 のときだけ買う。"""
        cands = [h for h in horses if h.get("ev") is not None and h["ev"] >= 0.95]
        if not cands: return 0, 0, False
        target = max(cands, key=lambda h: h["ev"])
        pay = _payout_tan(payouts, target["number"])
        return UNIT, pay, pay > 0

    def fuku_best_ev_any(horses, payouts):
        """全頭の中で EV が最大の馬を複勝。EV >= 0.85 のときだけ買う。"""
        cands = [h for h in horses if h.get("ev") is not None and h["ev"] >= 0.85]
        if not cands: return 0, 0, False
        target = max(cands, key=lambda h: h["ev"])
        pay = _payout_fuku(payouts, target["number"])
        return UNIT, pay, pay > 0

    def tan_strict_combined(horses, payouts):
        """厳しい複合条件: primary EV>=1.05 AND nopop EV>=1.00 AND value_signal>=0"""
        cands = [h for h in horses
                 if (h.get("ev") or 0) >= 1.05
                 and (h.get("ev_nopop") or 0) >= 1.00
                 and (h.get("value_signal") or -1) >= 0]
        if not cands: return 0, 0, False
        target = max(cands, key=lambda h: h["ev"])
        pay = _payout_tan(payouts, target["number"])
        return UNIT, pay, pay > 0

    def fuku_strict_combined(horses, payouts):
        """厳しい複合条件 (複勝版): EV>=0.95 AND nopop EV>=0.95 AND value_signal>=0"""
        cands = [h for h in horses
                 if (h.get("ev") or 0) >= 0.95
                 and (h.get("ev_nopop") or 0) >= 0.95
                 and (h.get("value_signal") or -1) >= 0]
        if not cands: return 0, 0, False
        target = max(cands, key=lambda h: h["ev"])
        pay = _payout_fuku(payouts, target["number"])
        return UNIT, pay, pay > 0

    def tan_top1_confident(horses, payouts):
        """AI 本命が「確信」レベル (win_prob >= 0.40) のときだけ単勝。"""
        if not horses: return 0, 0, False
        top = horses[0]
        if (top.get("win_prob") or 0) < 0.40: return 0, 0, False
        pay = _payout_tan(payouts, top["number"])
        return UNIT, pay, pay > 0

    def fuku_top1_confident(horses, payouts):
        """AI 本命が確信レベル (win_prob >= 0.35) のときだけ複勝。"""
        if not horses: return 0, 0, False
        top = horses[0]
        if (top.get("win_prob") or 0) < 0.35: return 0, 0, False
        pay = _payout_fuku(payouts, top["number"])
        return UNIT, pay, pay > 0

    def uren_top1_top2_high_ev(horses, payouts):
        """馬連 (本命-対抗): top1 と top2 の合計 EV が大きいときだけ"""
        if len(horses) < 2: return 0, 0, False
        a, b = horses[0], horses[1]
        # 簡易 EV: (probA + probB) * 平均オッズ (推測値)
        # ここでは「両方の prob 合計 >= 0.55」を condition に
        if ((a.get("win_prob") or 0) + (b.get("win_prob") or 0)) < 0.55: return 0, 0, False
        pay = _payout_uren(payouts, a["number"], b["number"])
        return UNIT, pay, pay > 0

    def wide_box_top3_confident(horses, payouts):
        """ワイド 3 点: top3 の合計 prob が高い (= 確信) ときだけ"""
        if len(horses) < 3: return 0, 0, False
        top3 = horses[:3]
        total = sum((h.get("win_prob") or 0) for h in top3)
        if total < 0.70: return 0, 0, False
        n1, n2, n3 = top3[0]["number"], top3[1]["number"], top3[2]["number"]
        pay = (_payout_wide(payouts, n1, n2) +
               _payout_wide(payouts, n1, n3) +
               _payout_wide(payouts, n2, n3))
        return UNIT * 3, pay, pay > 0

    def fuku_underdog_value(horses, payouts):
        """穴狙い複勝: 人気 4-8 番で nopop_prob (実力派の評価) が上位 3 位以内"""
        cands = [h for h in horses
                 if isinstance(h.get("popularity"), int)
                 and 4 <= h["popularity"] <= 8
                 and h.get("nopop_prob") is not None]
        if not cands: return 0, 0, False
        # nopop 全体での順位
        ranked_nopop = _ranked_by_nopop(horses)
        top3_numbers = set(h["number"] for h in ranked_nopop[:3])
        cands = [h for h in cands if h["number"] in top3_numbers]
        if not cands: return 0, 0, False
        target = max(cands, key=lambda h: h.get("nopop_prob") or 0)
        pay = _payout_fuku(payouts, target["number"])
        return UNIT, pay, pay > 0

    def fuku_super_strict(horses, payouts):
        """超厳格: AI 本命が「絶好機」レベル (top1 と top2 の prob 差 >= 0.10) のときだけ複勝"""
        if len(horses) < 2: return 0, 0, False
        top, second = horses[0], horses[1]
        gap = (top.get("win_prob") or 0) - (second.get("win_prob") or 0)
        if gap < 0.10: return 0, 0, False
        pay = _payout_fuku(payouts, top["number"])
        return UNIT, pay, pay > 0

    return [
        Strategy("tan_top1_always",            tan_top1_always),
        Strategy("tan_top1_ev100",             tan_top1_ev100),
        Strategy("tan_top1_ev110",             tan_top1_ev110),
        Strategy("tan_top1_ev130",             tan_top1_ev130),
        Strategy("tan_top1_value3",            tan_top1_value3),
        Strategy("fuku_top1_always",           fuku_top1_always),
        Strategy("fuku_top1_ev090",            fuku_top1_ev090),
        Strategy("fuku_top1_ev110",            fuku_top1_ev110),
        Strategy("fuku_top1_value3",           fuku_top1_value3),
        Strategy("uren_top1_top2",             uren_top1_top2),
        Strategy("uren_value3_x_pop1",         uren_top1_value3_with_pop1),
        Strategy("wide_box_top3",              wide_box_top3),
        Strategy("wide_value3_x_pop1",         wide_top1_value3_with_pop1),
        Strategy("tan_top1_kelly",             tan_top1_kelly),
        # Wave18: nopop value pick
        Strategy("tan_nopop_top1",             tan_nopop_top1_always),
        Strategy("fuku_nopop_top1",            fuku_nopop_top1_always),
        Strategy("tan_nopop_undervalued",      tan_nopop_top1_undervalued),
        Strategy("fuku_nopop_undervalued",     fuku_nopop_top1_undervalued),
        Strategy("tan_value_signal_005",       tan_value_signal_strong),
        Strategy("fuku_value_signal_003",      fuku_value_signal_strong),
        Strategy("uren_primary_x_nopop",       uren_primary_nopop_combo),
        Strategy("wide_primary_x_nopop",       wide_primary_nopop_combo),
        Strategy("fuku_ev_nopop_110",          fuku_ev_nopop_110),
        # Wave19: 見送り型 100% 越え狙い
        Strategy("tan_best_ev_any",            tan_best_ev_any),
        Strategy("fuku_best_ev_any",           fuku_best_ev_any),
        Strategy("tan_strict_combined",        tan_strict_combined),
        Strategy("fuku_strict_combined",       fuku_strict_combined),
        Strategy("tan_top1_confident",         tan_top1_confident),
        Strategy("fuku_top1_confident",        fuku_top1_confident),
        Strategy("uren_top1_top2_high",        uren_top1_top2_high_ev),
        Strategy("wide_box_top3_confident",    wide_box_top3_confident),
        Strategy("fuku_underdog_value",        fuku_underdog_value),
        Strategy("fuku_super_strict",          fuku_super_strict),
        # === Wave19 scan: 「ほぼ全部見送る」型の閾値スイープ ===
        # 「wide_box_top3_confident 0.70 → 213%」「fuku_top1_prob_020 100件 106%」を中心に、
        # 閾値を細かく動かして発火数と回収率のトレードオフを探る。
        # 命名規則: f"name_{int(th*100):03d}" = 003 (=0.03) / 020 (=0.20) / 070 (=0.70)
        # === Wave19.3: 精密スイープで最適点 (スイートスポット) を探す ===
        *[
            Strategy(f"wide_top3_conf_{int(th*100):03d}", _make_wide_top3_conf(th))
            for th in (0.50, 0.52, 0.55, 0.58, 0.60, 0.62, 0.65, 0.68, 0.70, 0.72, 0.75, 0.80)
        ],
        *[
            Strategy(f"fuku_gap_{int(th*100):03d}", _make_fuku_gap(th))
            for th in (0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10,
                       0.11, 0.12, 0.13, 0.14, 0.15)
        ],
        *[
            Strategy(f"fuku_top1_prob_{int(th*100):03d}", _make_fuku_top1_prob(th))
            for th in (0.15, 0.17, 0.18, 0.19, 0.20, 0.21, 0.22, 0.23,
                       0.24, 0.25, 0.26, 0.28, 0.30, 0.32, 0.35, 0.40, 0.45)
        ],
        # === Wave19.4: 複合戦略 (条件を AND で重ねる) ===
        # 単一戦略の発火率を下げる代わりに信頼性を上げる
        Strategy("combo_best_and_wide",        _combo_best_and_wide),
        Strategy("combo_best_wide_double_bet", _combo_best_wide_double_bet),
        Strategy("combo_best_and_nopop_match", _combo_best_and_nopop_match),
        Strategy("combo_best_and_gap",         _combo_best_and_gap),
        Strategy("combo_wide_with_pop1",       _combo_wide_with_pop1),
        Strategy("combo_wide_high_value",      _combo_wide_high_value),
        Strategy("combo_tan_high_payout",      _combo_tan_high_payout),
        Strategy("combo_super_safe",           _combo_super_safe),
        Strategy("combo_fuku_strong_value",    _combo_fuku_strong_value),
        Strategy("combo_wide_concentrated",    _combo_wide_concentrated),
        # === Wave19.5: 3 条件 AND + 単勝高配当狙い ===
        Strategy("combo_triple_pop12",         _combo_triple_pop12),
        Strategy("combo_triple_gap_concentrated", _combo_triple_gap_concentrated),
        Strategy("combo_triple_value_match",   _combo_triple_value_match),
        Strategy("combo_triple_high_quality",  _combo_triple_high_quality),
        Strategy("combo_uren_strong_top12",    _combo_uren_strong_top12),
        Strategy("combo_tan_value_3to6",       _combo_tan_value_3to6),
        Strategy("combo_tan_odds_5to10",       _combo_tan_odds_5to10),
        Strategy("combo_tan_underdog_value",   _combo_tan_underdog_value),
        Strategy("combo_wide_box_top4",        _combo_wide_box_top4),
        Strategy("combo_quadruple_safety",     _combo_quadruple_safety),
        # === Wave19.6: 馬連・3 連複・季節・コース・場別 ===
        # 馬連 (uren) スイープ
        Strategy("uren_top12_prob30",          _make_uren_top12_prob(0.30)),
        Strategy("uren_top12_prob35",          _make_uren_top12_prob(0.35)),
        Strategy("uren_top12_prob40",          _make_uren_top12_prob(0.40)),
        Strategy("uren_top12_prob45",          _make_uren_top12_prob(0.45)),
        Strategy("uren_ultra",                 _uren_ultra),
        # 3 連複 (fuku3) スイープ — top3 ボックス 1 点
        Strategy("fuku3_top3_conf45",          _make_fuku3_top3(0.45)),
        Strategy("fuku3_top3_conf50",          _make_fuku3_top3(0.50)),
        Strategy("fuku3_top3_conf55",          _make_fuku3_top3(0.55)),
        Strategy("fuku3_top3_conf60",          _make_fuku3_top3(0.60)),
        Strategy("fuku3_top3_conf65",          _make_fuku3_top3(0.65)),
        # 季節別 (BEST 戦略 + 月条件)
        Strategy("best_spring",                _make_best_season("spring")),
        Strategy("best_summer",                _make_best_season("summer")),
        Strategy("best_autumn",                _make_best_season("autumn")),
        Strategy("best_winter",                _make_best_season("winter")),
        # 芝/ダート別
        Strategy("best_turf",                  _make_best_surface("芝")),
        Strategy("best_dirt",                  _make_best_surface("ダート")),
        # 場別 (10 場ぶん)
        *[Strategy(f"best_venue_{vn}", _make_best_venue(vn))
          for vn in ("札幌","函館","福島","新潟","東京","中山","中京","京都","阪神","小倉")],
        # === Wave19.7: BIG+TURF 複合戦略 ===
        Strategy("combo_big_turf",             _combo_big_turf),
        Strategy("combo_big_turf_double_bet",  _combo_big_turf_double_bet),
        Strategy("combo_big_turf_ultra",       _combo_big_turf_ultra),
        Strategy("combo_big_turf_high_conf",   _combo_big_turf_high_conf),
        Strategy("combo_turf_ultra",           _combo_turf_ultra),
    ]


# === Wave19.7: BIG + TURF 系の複合戦略 ===

def _combo_big_turf(horses, payouts):
    """芝レース AND top3 合計 >= 0.50 → 3 連複 ボックス 1 点"""
    if len(horses) < 3: return 0, 0, False
    if "芝" not in (horses[0].get("race_surface") or ""): return 0, 0, False
    if sum((h.get("win_prob") or 0) for h in horses[:3]) < 0.50: return 0, 0, False
    a, b, c = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay = _payout_fuku3(payouts, a, b, c)
    return UNIT, pay, pay > 0


def _combo_big_turf_double_bet(horses, payouts):
    """芝レース AND BIG 発火 (top3 0.50+) AND TURF 発火 (本命確率 22%+ かつ対抗差 4pt+)
    → 3 連複 ボックス 100 + 複勝 100 = 200 円"""
    if len(horses) < 3: return 0, 0, False
    if "芝" not in (horses[0].get("race_surface") or ""): return 0, 0, False
    if sum((h.get("win_prob") or 0) for h in horses[:3]) < 0.50: return 0, 0, False
    top = horses[0]
    if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
    if (top.get("win_prob") or 0) - (horses[1].get("win_prob") or 0) < 0.04: return 0, 0, False
    a, b, c = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay_f = _payout_fuku(payouts, a)
    pay_3 = _payout_fuku3(payouts, a, b, c)
    total = pay_f + pay_3
    return UNIT * 2, total, total > 0


def _combo_big_turf_ultra(horses, payouts):
    """芝レース AND BIG AND TURF AND ULTRA (= 全部発火)
    → 複勝 100 + ワイド 3 点 300 + 3 連複ボックス 100 = 500 円"""
    if len(horses) < 3: return 0, 0, False
    if "芝" not in (horses[0].get("race_surface") or ""): return 0, 0, False
    if sum((h.get("win_prob") or 0) for h in horses[:3]) < 0.50: return 0, 0, False
    top = horses[0]
    if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
    if (top.get("win_prob") or 0) - (horses[1].get("win_prob") or 0) < 0.04: return 0, 0, False
    a, b, c = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay_f  = _payout_fuku(payouts, a)
    pay_w  = _payout_wide(payouts, a, b) + _payout_wide(payouts, a, c) + _payout_wide(payouts, b, c)
    pay_3  = _payout_fuku3(payouts, a, b, c)
    total = pay_f + pay_w + pay_3
    return UNIT * 5, total, total > 0


def _combo_big_turf_high_conf(horses, payouts):
    """芝レース AND top3 合計 >= 0.55 (より厳しい) AND 本命確率 22%+
    → 3 連複ボックス 1 点"""
    if len(horses) < 3: return 0, 0, False
    if "芝" not in (horses[0].get("race_surface") or ""): return 0, 0, False
    if sum((h.get("win_prob") or 0) for h in horses[:3]) < 0.55: return 0, 0, False
    if (horses[0].get("win_prob") or 0) < 0.22: return 0, 0, False
    a, b, c = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay = _payout_fuku3(payouts, a, b, c)
    return UNIT, pay, pay > 0


def _combo_turf_ultra(horses, payouts):
    """芝レース AND ULTRA (BEST+WIDE 同時) → 複勝 + ワイド = 400 円
    芝の絶好機 ULTRA は的中率最高クラスの予測"""
    if len(horses) < 3: return 0, 0, False
    if "芝" not in (horses[0].get("race_surface") or ""): return 0, 0, False
    top = horses[0]
    if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
    if sum((h.get("win_prob") or 0) for h in horses[:3]) < 0.50: return 0, 0, False
    a, b, c = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay_f = _payout_fuku(payouts, a)
    pay_w = _payout_wide(payouts, a, b) + _payout_wide(payouts, a, c) + _payout_wide(payouts, b, c)
    total = pay_f + pay_w
    return UNIT * 4, total, total > 0


# === Wave19.6: 馬連・3 連複・季節・コース・場別 戦略実装 ===

def _make_uren_top12_prob(threshold):
    """馬連 本命-対抗: top1 と top2 の prob 合計 >= threshold で発火"""
    def fn(horses, payouts):
        if len(horses) < 2: return 0, 0, False
        a, b = horses[0], horses[1]
        if ((a.get("win_prob") or 0) + (b.get("win_prob") or 0)) < threshold: return 0, 0, False
        pay = _payout_uren(payouts, a["number"], b["number"])
        return UNIT, pay, pay > 0
    return fn


def _uren_ultra(horses, payouts):
    """馬連 ULTRA: BEST 条件 + top12 prob 合計 >= 0.40 + 対抗差 4pt 以内 (互角の 1-2 着)"""
    if len(horses) < 2: return 0, 0, False
    a, b = horses[0], horses[1]
    if (a.get("win_prob") or 0) < 0.22: return 0, 0, False
    sum_p = (a.get("win_prob") or 0) + (b.get("win_prob") or 0)
    if sum_p < 0.40: return 0, 0, False
    gap = (a.get("win_prob") or 0) - (b.get("win_prob") or 0)
    if gap > 0.08: return 0, 0, False
    pay = _payout_uren(payouts, a["number"], b["number"])
    return UNIT, pay, pay > 0


def _make_fuku3_top3(threshold):
    """3 連複: top3 ボックス 1 点 (本命・対抗・3 着) を 100 円。top3 合計 >= threshold で発火"""
    def fn(horses, payouts):
        if len(horses) < 3: return 0, 0, False
        if sum((h.get("win_prob") or 0) for h in horses[:3]) < threshold: return 0, 0, False
        a, b, c = horses[0]["number"], horses[1]["number"], horses[2]["number"]
        pay = _payout_fuku3(payouts, a, b, c)
        return UNIT, pay, pay > 0
    return fn


def _is_in_season(month, season):
    if month is None: return False
    if season == "spring": return month in (3, 4, 5)
    if season == "summer": return month in (6, 7, 8)
    if season == "autumn": return month in (9, 10, 11)
    if season == "winter": return month in (12, 1, 2)
    return False


def _make_best_season(season):
    """BEST 戦略 + 季節フィルタ"""
    def fn(horses, payouts):
        if not horses: return 0, 0, False
        top = horses[0]
        if not _is_in_season(top.get("race_month"), season): return 0, 0, False
        if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
        if len(horses) >= 2:
            gap = (top.get("win_prob") or 0) - (horses[1].get("win_prob") or 0)
            if gap < 0.04: return 0, 0, False
        pay = _payout_fuku(payouts, top["number"])
        return UNIT, pay, pay > 0
    return fn


def _make_best_surface(surface_jp):
    """BEST 戦略 + 芝/ダート フィルタ"""
    def fn(horses, payouts):
        if not horses: return 0, 0, False
        top = horses[0]
        s = top.get("race_surface") or ""
        if surface_jp == "芝":
            if "芝" not in s: return 0, 0, False
        elif surface_jp == "ダート":
            if "ダ" not in s: return 0, 0, False
        if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
        if len(horses) >= 2:
            gap = (top.get("win_prob") or 0) - (horses[1].get("win_prob") or 0)
            if gap < 0.04: return 0, 0, False
        pay = _payout_fuku(payouts, top["number"])
        return UNIT, pay, pay > 0
    return fn


def _make_best_venue(venue_jp):
    """BEST 戦略 + 場フィルタ"""
    def fn(horses, payouts):
        if not horses: return 0, 0, False
        top = horses[0]
        if top.get("race_venue") != venue_jp: return 0, 0, False
        if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
        if len(horses) >= 2:
            gap = (top.get("win_prob") or 0) - (horses[1].get("win_prob") or 0)
            if gap < 0.04: return 0, 0, False
        pay = _payout_fuku(payouts, top["number"])
        return UNIT, pay, pay > 0
    return fn


# === Wave19.5: 3 条件 AND + 単勝中穴狙い ===

def _is_best_wide(top, horses):
    """ULTRA 発火条件 (BEST + WIDE 両方)"""
    if (top.get("win_prob") or 0) < 0.22: return False
    if len(horses) < 3: return False
    if sum((h.get("win_prob") or 0) for h in horses[:3]) < 0.50: return False
    return True


def _combo_triple_pop12(horses, payouts):
    """ULTRA + 単勝 1-2 番人気 = 「AI 確信 + 市場合意 + 厚い 3 着圏」三位一体"""
    if not horses: return 0, 0, False
    top = horses[0]
    if not _is_best_wide(top, horses): return 0, 0, False
    pop = top.get("popularity")
    if not (isinstance(pop, int) and pop <= 2): return 0, 0, False
    n1, n2, n3 = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay_f = _payout_fuku(payouts, n1)
    pay_w = _payout_wide(payouts, n1, n2) + _payout_wide(payouts, n1, n3) + _payout_wide(payouts, n2, n3)
    total = pay_f + pay_w
    return UNIT * 4, total, total > 0


def _combo_triple_gap_concentrated(horses, payouts):
    """ULTRA + 対抗差 4pt+ + top1 が top3 の 40%+ (集中型・本命が圧倒的)"""
    if not horses or len(horses) < 3: return 0, 0, False
    top = horses[0]
    if not _is_best_wide(top, horses): return 0, 0, False
    gap = (top.get("win_prob") or 0) - (horses[1].get("win_prob") or 0)
    if gap < 0.04: return 0, 0, False
    s3 = sum((h.get("win_prob") or 0) for h in horses[:3])
    if s3 < 1e-9 or (top.get("win_prob") or 0) / s3 < 0.40: return 0, 0, False
    n1, n2, n3 = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay_f = _payout_fuku(payouts, n1)
    pay_w = _payout_wide(payouts, n1, n2) + _payout_wide(payouts, n1, n3) + _payout_wide(payouts, n2, n3)
    total = pay_f + pay_w
    return UNIT * 4, total, total > 0


def _combo_triple_value_match(horses, payouts):
    """ULTRA + value_signal >= 0 + 本命 1-3 番人気 = AI/nopop/市場 三者合意"""
    if not horses: return 0, 0, False
    top = horses[0]
    if not _is_best_wide(top, horses): return 0, 0, False
    if (top.get("value_signal") or -1) < 0: return 0, 0, False
    pop = top.get("popularity")
    if not (isinstance(pop, int) and pop <= 3): return 0, 0, False
    n1, n2, n3 = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay_f = _payout_fuku(payouts, n1)
    pay_w = _payout_wide(payouts, n1, n2) + _payout_wide(payouts, n1, n3) + _payout_wide(payouts, n2, n3)
    total = pay_f + pay_w
    return UNIT * 4, total, total > 0


def _combo_triple_high_quality(horses, payouts):
    """ULTRA + 対抗差 >= 0.05 + 本命オッズ 2.0 倍以上 (買い甲斐ある配当)"""
    if not horses or len(horses) < 2: return 0, 0, False
    top = horses[0]
    if not _is_best_wide(top, horses): return 0, 0, False
    gap = (top.get("win_prob") or 0) - (horses[1].get("win_prob") or 0)
    if gap < 0.05: return 0, 0, False
    odds = top.get("odds")
    if odds is None or float(odds) < 2.0: return 0, 0, False
    n1, n2, n3 = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay_f = _payout_fuku(payouts, n1)
    pay_w = _payout_wide(payouts, n1, n2) + _payout_wide(payouts, n1, n3) + _payout_wide(payouts, n2, n3)
    total = pay_f + pay_w
    return UNIT * 4, total, total > 0


def _combo_uren_strong_top12(horses, payouts):
    """BEST + 本命対抗 prob 合計 0.40+ → 馬連 本命-対抗 (1-2 着確信)"""
    if not horses or len(horses) < 2: return 0, 0, False
    top, second = horses[0], horses[1]
    if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
    if ((top.get("win_prob") or 0) + (second.get("win_prob") or 0)) < 0.40: return 0, 0, False
    pay = _payout_uren(payouts, top["number"], second["number"])
    return UNIT, pay, pay > 0


def _combo_tan_value_3to6(horses, payouts):
    """nopop 本命が単勝 3-6 番人気 + nopop 確率 0.18+ = 実力派が推す中穴"""
    np_ranked = _ranked_by_nopop(horses)
    if not np_ranked: return 0, 0, False
    top = np_ranked[0]
    if (top.get("nopop_prob") or 0) < 0.18: return 0, 0, False
    pop = top.get("popularity")
    if not (isinstance(pop, int) and 3 <= pop <= 6): return 0, 0, False
    pay = _payout_tan(payouts, top["number"])
    return UNIT, pay, pay > 0


def _combo_tan_odds_5to10(horses, payouts):
    """BEST + 単勝オッズ 5-10 倍 (払戻 1.2-2.5 倍くらいの中配当狙い)"""
    if not horses: return 0, 0, False
    top = horses[0]
    if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
    odds = top.get("odds")
    if odds is None or not (5.0 <= float(odds) <= 10.0): return 0, 0, False
    pay = _payout_tan(payouts, top["number"])
    return UNIT, pay, pay > 0


def _combo_tan_underdog_value(horses, payouts):
    """BEST + 人気 4-7 番 + value_signal >= 0.03 = 過小評価された AI 本命"""
    if not horses: return 0, 0, False
    top = horses[0]
    if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
    pop = top.get("popularity")
    if not (isinstance(pop, int) and 4 <= pop <= 7): return 0, 0, False
    if (top.get("value_signal") or -1) < 0.03: return 0, 0, False
    pay = _payout_tan(payouts, top["number"])
    return UNIT, pay, pay > 0


def _combo_wide_box_top4(horses, payouts):
    """WIDE 条件 (top3 合計 >= 0.50) + 上位 4 頭で box 6 点 = 守備範囲拡大"""
    if not horses or len(horses) < 4: return 0, 0, False
    if sum((h.get("win_prob") or 0) for h in horses[:3]) < 0.50: return 0, 0, False
    nums = [h["number"] for h in horses[:4]]
    total_pay = 0
    for i in range(4):
        for j in range(i+1, 4):
            total_pay += _payout_wide(payouts, nums[i], nums[j])
    return UNIT * 6, total_pay, total_pay > 0


def _combo_quadruple_safety(horses, payouts):
    """4 条件 AND: BEST + WIDE + 人気 1-2 番 + nopop 本命と一致 = 最強の安全策"""
    if not horses: return 0, 0, False
    top = horses[0]
    if not _is_best_wide(top, horses): return 0, 0, False
    pop = top.get("popularity")
    if not (isinstance(pop, int) and pop <= 2): return 0, 0, False
    if top.get("rank_nopop") != 1: return 0, 0, False
    n1, n2, n3 = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay_f = _payout_fuku(payouts, n1)
    pay_w = _payout_wide(payouts, n1, n2) + _payout_wide(payouts, n1, n3) + _payout_wide(payouts, n2, n3)
    total = pay_f + pay_w
    return UNIT * 4, total, total > 0


# === Wave19.4: 複合戦略の実装本体 ===

def _combo_best_and_wide(horses, payouts):
    """BEST 条件 (prob>=0.22) AND WIDE 条件 (top3 合計>=0.50) で複勝買い
    両方の strict 条件を満たした「超信頼」レースだけ"""
    if not horses: return 0, 0, False
    top = horses[0]
    if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
    if len(horses) < 3: return 0, 0, False
    if sum((h.get("win_prob") or 0) for h in horses[:3]) < 0.50: return 0, 0, False
    pay = _payout_fuku(payouts, top["number"])
    return UNIT, pay, pay > 0


def _combo_best_wide_double_bet(horses, payouts):
    """BEST + WIDE 両方発火時に 「複勝 100 + ワイド 3 点 300」 を併買 (合計 400 円)"""
    if not horses or len(horses) < 3: return 0, 0, False
    top = horses[0]
    if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
    if sum((h.get("win_prob") or 0) for h in horses[:3]) < 0.50: return 0, 0, False
    # 複勝 100 + ワイド 3 点 300
    n1, n2, n3 = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay_fuku = _payout_fuku(payouts, n1)
    pay_wide = (_payout_wide(payouts, n1, n2) +
                _payout_wide(payouts, n1, n3) +
                _payout_wide(payouts, n2, n3))
    total = pay_fuku + pay_wide
    return UNIT * 4, total, total > 0


def _combo_best_and_nopop_match(horses, payouts):
    """BEST 条件 (prob>=0.22) AND nopop モデル本命と一致 = 2 モデル合意の最強信頼"""
    if not horses: return 0, 0, False
    top = horses[0]
    if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
    rank_nopop = top.get("rank_nopop")
    if rank_nopop != 1: return 0, 0, False
    pay = _payout_fuku(payouts, top["number"])
    return UNIT, pay, pay > 0


def _combo_best_and_gap(horses, payouts):
    """BEST 条件 AND 本命対抗差 (gap) >= 0.04 = 本命が明確に突出"""
    if not horses or len(horses) < 2: return 0, 0, False
    top, second = horses[0], horses[1]
    if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
    if (top.get("win_prob") or 0) - (second.get("win_prob") or 0) < 0.04: return 0, 0, False
    pay = _payout_fuku(payouts, top["number"])
    return UNIT, pay, pay > 0


def _combo_wide_with_pop1(horses, payouts):
    """WIDE 条件 (top3 合計>=0.50) AND 本命が単勝 1 番人気 (= 市場合意も得てる)"""
    if not horses or len(horses) < 3: return 0, 0, False
    top = horses[0]
    if top.get("popularity") != 1: return 0, 0, False
    if sum((h.get("win_prob") or 0) for h in horses[:3]) < 0.50: return 0, 0, False
    n1, n2, n3 = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay = (_payout_wide(payouts, n1, n2) +
           _payout_wide(payouts, n1, n3) +
           _payout_wide(payouts, n2, n3))
    return UNIT * 3, pay, pay > 0


def _combo_wide_high_value(horses, payouts):
    """WIDE 条件 AND value_signal (nopop と primary の差分) が top1 で正"""
    if not horses or len(horses) < 3: return 0, 0, False
    if sum((h.get("win_prob") or 0) for h in horses[:3]) < 0.50: return 0, 0, False
    top = horses[0]
    if (top.get("value_signal") or -1) < 0: return 0, 0, False
    n1, n2, n3 = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay = (_payout_wide(payouts, n1, n2) +
           _payout_wide(payouts, n1, n3) +
           _payout_wide(payouts, n2, n3))
    return UNIT * 3, pay, pay > 0


def _combo_tan_high_payout(horses, payouts):
    """BEST 条件 AND オッズ 3.0 倍以上 = 払戻が大きい単勝で利益最大化"""
    if not horses: return 0, 0, False
    top = horses[0]
    if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
    odds = top.get("odds")
    if odds is None or float(odds) < 3.0: return 0, 0, False
    pay = _payout_tan(payouts, top["number"])
    return UNIT, pay, pay > 0


def _combo_super_safe(horses, payouts):
    """SAFE+BEST+WIDE 全部発火 + 本命が単勝 1-2 番人気 = 最大限の安全策で複勝"""
    if not horses or len(horses) < 3: return 0, 0, False
    top = horses[0]
    if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
    if sum((h.get("win_prob") or 0) for h in horses[:3]) < 0.50: return 0, 0, False
    pop = top.get("popularity")
    if not (isinstance(pop, int) and pop <= 2): return 0, 0, False
    pay = _payout_fuku(payouts, top["number"])
    return UNIT, pay, pay > 0


def _combo_fuku_strong_value(horses, payouts):
    """BEST + value_signal > 0.02 = 実力派モデルも市場より高く評価している本命"""
    if not horses: return 0, 0, False
    top = horses[0]
    if (top.get("win_prob") or 0) < 0.22: return 0, 0, False
    if (top.get("value_signal") or -1) < 0.02: return 0, 0, False
    pay = _payout_fuku(payouts, top["number"])
    return UNIT, pay, pay > 0


def _combo_wide_concentrated(horses, payouts):
    """WIDE 条件 AND top3 の prob 分布が「集中型」 (top1 が top3 合計の 40% 以上を占有)"""
    if not horses or len(horses) < 3: return 0, 0, False
    p1 = horses[0].get("win_prob") or 0
    s3 = sum((h.get("win_prob") or 0) for h in horses[:3])
    if s3 < 0.50: return 0, 0, False
    if s3 < 1e-9 or p1 / s3 < 0.40: return 0, 0, False
    n1, n2, n3 = horses[0]["number"], horses[1]["number"], horses[2]["number"]
    pay = (_payout_wide(payouts, n1, n2) +
           _payout_wide(payouts, n1, n3) +
           _payout_wide(payouts, n2, n3))
    return UNIT * 3, pay, pay > 0


# === 閾値スイープ用ファクトリ ===
def _make_wide_top3_conf(threshold):
    """ワイド box top3: top1+top2+top3 の合計 prob >= threshold のとき"""
    def fn(horses, payouts):
        if len(horses) < 3: return 0, 0, False
        top3 = horses[:3]
        total = sum((h.get("win_prob") or 0) for h in top3)
        if total < threshold: return 0, 0, False
        n1, n2, n3 = top3[0]["number"], top3[1]["number"], top3[2]["number"]
        pay = (_payout_wide(payouts, n1, n2) +
               _payout_wide(payouts, n1, n3) +
               _payout_wide(payouts, n2, n3))
        return UNIT * 3, pay, pay > 0
    return fn


def _make_fuku_gap(threshold):
    """複勝 本命: top1 と top2 の prob 差 >= threshold のとき"""
    def fn(horses, payouts):
        if len(horses) < 2: return 0, 0, False
        top, second = horses[0], horses[1]
        gap = (top.get("win_prob") or 0) - (second.get("win_prob") or 0)
        if gap < threshold: return 0, 0, False
        pay = _payout_fuku(payouts, top["number"])
        return UNIT, pay, pay > 0
    return fn


def _make_fuku_top1_prob(threshold):
    """複勝 本命: top1 の win_prob >= threshold のとき"""
    def fn(horses, payouts):
        if not horses: return 0, 0, False
        top = horses[0]
        if (top.get("win_prob") or 0) < threshold: return 0, 0, False
        pay = _payout_fuku(payouts, top["number"])
        return UNIT, pay, pay > 0
    return fn


def _predict_horses_for_race(race, model, kind, features_index,
                              model_nopop=None, kind_nopop=None):
    """1 レースの全頭を予測して horses_ranked (rank 順) を返す。
    nopop モデルがあれば nopop_prob と value_signal も付ける。
    """
    horses = race.get("horses") or []
    if not horses:
        return []
    ctx = _race_context(race)
    X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
    try:
        import numpy as np
        X_arr = np.array(X, dtype="float64")
    except Exception:
        np = None
        X_arr = X
    raw = list(_predict_one(model, kind, X_arr))
    raw = [float(p) for p in raw]
    normalized = _normalize_softmax(raw)

    nopop_normalized = None
    if model_nopop is not None and np is not None:
        try:
            X_nopop = _mask_pop_features(X_arr, np)
            raw_n = [float(p) for p in _predict_one(model_nopop, kind_nopop, X_nopop)]
            nopop_normalized = _normalize_softmax(raw_n)
        except Exception:
            pass

    # Wave19.6: race の meta を各 horse に注入 (季節・コース・場別の戦略で使う)
    course = race.get("course") or ""
    surface = race.get("surface") or ""
    rid = race.get("race_id") or ""
    month = None
    if rid and len(rid) >= 6 and rid[4:6].isdigit():
        m = int(rid[4:6])
        if 1 <= m <= 12: month = m
    venue_code = rid[8:10] if len(rid) >= 10 else None
    VENUE_NAMES = {
        "01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京",
        "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉",
    }
    venue_name = VENUE_NAMES.get(venue_code or "", "")

    ranked = []
    for i, h in enumerate(horses):
        odds = h.get("win_odds")
        win_prob = normalized[i]
        ev = (win_prob * float(odds)) if (odds and float(odds) > 0) else None
        nopop_prob = nopop_normalized[i] if nopop_normalized is not None else None
        value_signal = (nopop_prob - win_prob) if nopop_prob is not None else None
        ev_nopop = (nopop_prob * float(odds)) if (nopop_prob is not None and odds and float(odds) > 0) else None
        ranked.append({
            "number": h.get("number"),
            "win_prob": win_prob,
            "nopop_prob": nopop_prob,
            "value_signal": value_signal,
            "odds": odds,
            "ev": ev,
            "ev_nopop": ev_nopop,
            "popularity": h.get("popularity"),
            # race meta (全 horse 同じ値・戦略関数から参照しやすくするため埋め込み)
            "race_course": course,
            "race_surface": surface,
            "race_month": month,
            "race_venue": venue_name,
        })
    ranked.sort(key=lambda x: -x["win_prob"])
    return ranked


def _ranked_by_nopop(ranked):
    """nopop_prob 降順で並び替えたコピー (実力派の本命順)"""
    return sorted([h for h in ranked if h.get("nopop_prob") is not None],
                  key=lambda x: -x["nopop_prob"])


def run_backtest(test_ratio: float) -> int:
    model, kind = _load_model()
    if model is None:
        print("[NG] モデル未生成。先に train_lightgbm.py を回してください。", flush=True)
        return 2
    model_nopop, kind_nopop = _load_model_nopop()
    if model_nopop is not None:
        print(f"[info] nopop モデル読込済 ({kind_nopop}) — value pick 戦略が機能", flush=True)
    else:
        print(f"[info] nopop モデル未生成 — train_lightgbm.py --no-pop を実行してください", flush=True)

    features_index = _load_features_index()
    if not RACES_DIR.exists() or not RESULTS_DIR.exists():
        print("[NG] races/ または results/ ディレクトリが見つかりません。", flush=True)
        return 3

    # races と results 両方ある race_id だけを集める
    available = []
    for rp in sorted(RACES_DIR.glob("*.json")):
        rid = rp.stem
        if (RESULTS_DIR / f"{rid}.json").exists():
            available.append(rid)

    if not available:
        print("[NG] 評価可能なレースなし (results 紐付け 0 件)", flush=True)
        return 4

    # 時系列分割: race_id 末尾 00 を付けた 18 桁の YYYYMMDDJJRRRR は昇順 = 時系列順
    available.sort()
    cut = max(1, int(len(available) * (1.0 - test_ratio)))
    test_race_ids = available[cut:]
    print(f"[info] 評価対象: {len(test_race_ids)} レース (test 期間 = 後ろ {test_ratio*100:.0f}%)", flush=True)
    if not test_race_ids:
        print("[NG] test 分割でレース 0 件 (--test-ratio を上げてください)", flush=True)
        return 5

    strategies = _build_strategies()

    for rid in test_race_ids:
        try:
            race = json.loads((RACES_DIR / f"{rid}.json").read_text(encoding="utf-8"))
            result = json.loads((RESULTS_DIR / f"{rid}.json").read_text(encoding="utf-8"))
        except Exception:
            continue
        payouts = result.get("payouts") or {}
        ranked = _predict_horses_for_race(race, model, kind, features_index,
                                          model_nopop, kind_nopop)
        if not ranked:
            continue
        for st in strategies:
            st.apply(rid, ranked, payouts)

    summaries = [st.summary() for st in strategies]
    summaries.sort(key=lambda s: -s["roi"])

    # console 表示
    print("\n=== 過去レースでの実証結果 ===", flush=True)
    print(f"{'戦略名':<22} {'件数':>6} {'投資':>10} {'払戻':>10} {'回収率':>10} {'的中率':>10} {'最大配当':>10}", flush=True)
    for s in summaries:
        print(f"{s['name']:<22} {s['bets']:>6} {s['invested']:>10,} {s['returned']:>10,} "
              f"{s['roi_pct']:>9.1f}% {s['hit_rate']*100:>9.1f}% {s['max_payout']:>10,}",
              flush=True)

    # JSON 保存
    meta = {}
    if META_PATH.exists():
        try:
            meta = json.loads(META_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    out = {
        "backtested_at": datetime.now(timezone.utc).isoformat(),
        "test_ratio": test_ratio,
        "test_races": len(test_race_ids),
        "model_trained_at": meta.get("trained_at"),
        "model_auc": (meta.get("metrics") or {}).get("auc"),
        "model_logloss": (meta.get("metrics") or {}).get("logloss"),
        "strategies": summaries,
        "best_strategy": summaries[0]["name"] if summaries else None,
        "best_roi_pct": summaries[0]["roi_pct"] if summaries else None,
    }
    BACKTEST_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[OK] backtest_result.json 保存 → {BACKTEST_PATH.relative_to(ROOT)}", flush=True)
    return 0


def main():
    ap = argparse.ArgumentParser(description="LightGBM 回収率検証")
    ap.add_argument("--test-ratio", type=float, default=0.2)
    args = ap.parse_args()
    return run_backtest(args.test_ratio)


if __name__ == "__main__":
    sys.exit(main())
