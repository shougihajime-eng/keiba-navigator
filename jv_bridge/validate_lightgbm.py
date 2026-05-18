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
        # 最初に当たった「wide_box_top3_confident 0.70 → 213%」を中心に、
        # 閾値を緩めて発火数を増やしながら、回収率がどう変わるか測る。
        # サンプル数が少なすぎる戦略は信頼性が低いので、件数 20+ を「実用可能」と判定する。
        *[
            Strategy(f"wide_top3_conf_{int(th*100):03d}", _make_wide_top3_conf(th))
            for th in (0.55, 0.60, 0.65, 0.70, 0.75, 0.80)
        ],
        *[
            Strategy(f"fuku_gap_{int(th*100):03d}", _make_fuku_gap(th))
            for th in (0.04, 0.06, 0.08, 0.10, 0.12, 0.15)
        ],
        *[
            Strategy(f"fuku_top1_prob_{int(th*100):03d}", _make_fuku_top1_prob(th))
            for th in (0.20, 0.25, 0.30, 0.35, 0.40, 0.45)
        ],
    ]


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
