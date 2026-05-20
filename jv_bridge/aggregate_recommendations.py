# -*- coding: utf-8 -*-
"""
aggregate_recommendations.py — 推奨買い目を集約して 1 つの JSON にする

戦略マルチアサイン (Wave19.3 で 0.01 刻み精密スイープから最適点を発見):
  - SAFE:     fuku_top1_prob_020 (確率 20%+) — 100 件 106.3% 安全多発火
  - BEST:     fuku_top1_prob_022 (確率 22%+) — 65 件 112.2% 真のスイートスポット (高 ROI)
  - WIDE:     wide_top3_conf_050 (top3 合計 50%+) — 49 件 132% ワイド 3 点
  各レースで条件を満たした戦略にバッジを付与し、ベスト戦略を「★ 推奨買い方」として表示。

入力: data/jv_cache/predictions/<race_id>.json (3492 個)
入力: data/jv_cache/races/<race_id>.json (race name / course / 発走時刻のメタ)
入力: data/jv_cache/backtest_result.json (戦略パフォーマンス参照)
出力: data/jv_cache/recommendations.json (集約・git push 対象)

使い方:
  py -3 jv_bridge\\aggregate_recommendations.py
  py -3 jv_bridge\\aggregate_recommendations.py --recent-days 7

設計:
  - "today" = 今日の日付 (JST) のレース → アプリで「今日の推奨」として表示
  - "recent" = 直近 recent-days 日のレース → 「最近の推奨」
  - "stats" = 戦略ごとの実証成績 (backtest_result.json 由来)
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

os.environ["PYTHONIOENCODING"] = "utf-8"
for _attr in ("stdout", "stderr"):
    _s = getattr(sys, _attr, None)
    if _s is None: continue
    try: _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE = ROOT / "data" / "jv_cache"
RACES_DIR = CACHE / "races"
PREDICTIONS_DIR = CACHE / "predictions"
BACKTEST_PATH = CACHE / "backtest_result.json"
WALK_FORWARD_PATH = CACHE / "walk_forward_result.json"
OUT_PATH = CACHE / "recommendations.json"

JST = dt.timezone(dt.timedelta(hours=9))


def _parse_race_date(race_id: str) -> Optional[dt.date]:
    if not race_id or len(race_id) < 8 or not race_id[:8].isdigit():
        return None
    try:
        return dt.date(int(race_id[:4]), int(race_id[4:6]), int(race_id[6:8]))
    except ValueError:
        return None


def _load_race_meta(race_id: str) -> Dict[str, Any]:
    p = RACES_DIR / f"{race_id}.json"
    if not p.exists():
        return {}
    try:
        race = json.loads(p.read_text(encoding="utf-8"))
        return {
            "race_name": race.get("race_name"),
            "course": race.get("course"),
            "distance": race.get("distance"),
            "going": race.get("going"),
            "weather": race.get("weather"),
            "is_g1": race.get("is_g1"),
            "hassou_time": race.get("hassou_time"),
        }
    except Exception:
        return {}


# Wave19.6: 5 戦略マルチアサイン (馬連・3 連複・芝限定を追加発見)
# 過去 690 R で 100% 越え + 件数 20+ のものから階層化
def _is_surface_turf(horses):
    if not horses: return False
    s = horses[0].get("race_surface") or ""
    return "芝" in s

def _nopop_top(horses):
    """rank_nopop == 1 の馬を返す (= nopop モデルの本命)"""
    for h in horses:
        if h.get("rank_nopop") == 1:
            return h
    return None

def _race_surface(horses):
    if not horses: return ""
    return (horses[0].get("race_surface") or "")


def _race_distance(horses):
    if not horses: return 0
    try:
        return int(horses[0].get("race_distance") or 0)
    except (TypeError, ValueError):
        return 0


STRATEGY_DEFS = [
    {
        # Wave29: 芝 + 馬連 nopop 閾値 0.30 → final 164.6% / 勝 7/7 / 件数 448
        # 全期間 (period 1〜7) すべて 100%+ かつ pure test (look-ahead 無し最終期間) 164.6%
        # → 真に世界一級・最も信頼できる戦略
        "key": "value_uren_turf",
        "name_in_backtest": "value_uren_turf_030",
        "label": "芝コース・馬連 (人気を見ない AI が選ぶ 1-2着候補で勝負)",
        "short_label": "芝の馬連",
        "color": "emerald",
        "bet_type": "馬連 (芝・nopop top1-top2)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            "芝" in _race_surface(horses) and
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.30)(_nopop_top(horses))
        ),
    },
    {
        # Wave29: 短距離 1000-1400m + 馬連 nopop 閾値 0.30 → final 277% / 勝 6/7 / 件数 279
        # 短距離はペースが安定 + 騎手の腕が出やすい → nopop モデルが市場を凌駕する領域
        "key": "value_uren_short",
        "name_in_backtest": "value_uren_short_030",
        "label": "短距離 (1000-1400m)・馬連 (人気無視 AI で 1-2 着候補・実力派が勝ちやすい)",
        "short_label": "短距離・実力派",
        "color": "violet",
        "bet_type": "馬連 (短距離・nopop top1-top2)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            1000 <= _race_distance(horses) <= 1400 and
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.30)(_nopop_top(horses))
        ),
    },
    {
        # Wave29: 短距離 + 馬連 nopop 閾値 0.35 (厳選) → final 381% / 勝 5/7 / 件数 165
        # ハイリスクハイリターン (件数少ない・全期間で勝つわけではない・ただしハマる時の爆発力)
        "key": "value_uren_short_ultra",
        "name_in_backtest": "value_uren_short_ultra_035",
        "label": "短距離・馬連 (厳選版・自信ある時だけ買う)",
        "short_label": "短距離・厳選",
        "color": "gold",
        "bet_type": "馬連 (短距離・厳選・nopop)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            1000 <= _race_distance(horses) <= 1400 and
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.35)(_nopop_top(horses))
        ),
    },
    {
        # Wave30-X4: ⚠ Stacking は真の期間別再学習で馬連 77.47% / 勝 0/3 = 期待値マイナス確定
        # 旧主張「avg 244%・全期間 100%+」は look-ahead 由来の偽値
        "key": "value_stack_uren",
        "name_in_backtest": "value_stack_uren_016",
        "label": "合成 AI 馬連 (4 つの AI を組合せ・しかし厳しい検証で損が確定)",
        "short_label": "合成AI馬連",
        "color": "rose",
        "bet_type": "馬連 (Stacking top1-top2)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.16)(_nopop_top(horses))
        ),
    },
    {
        # Wave30-X4: ⚠ Stacking 複勝も真の期間別再学習で 83.74% / 勝 0/3 = 期待値マイナス
        "key": "value_stack_fuku",
        "name_in_backtest": "value_stack_fuku_016",
        "label": "合成 AI 複勝 (4 つの AI を組合せ・しかし厳しい検証で損が確定)",
        "short_label": "合成AI複勝",
        "color": "rose",
        "bet_type": "複勝 (Stacking top1)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.16)(_nopop_top(horses))
        ),
    },
    {
        # Wave30-B: V-DOUBLE 複勝+馬連 併買 (閾値 0.16) avg 187.6% / σ 64.34 / 勝 6/7
        # 馬連単体 (σ 92) より安定 + 複勝の確実性で σ を半分に
        "key": "value_double",
        "name_in_backtest": "value_double_nopop_016",
        "label": "複勝と馬連を両方買う (200 円・厳しい検証で損が確定)",
        "short_label": "両買い",
        "color": "rose",
        "bet_type": "複勝+馬連 (nopop top1-top2)",
        "unit": 200,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.16)(_nopop_top(horses))
        ),
    },
    {
        # Wave30-X2: 真の Walk-forward で発見!
        #   3連単 nopop top1->top2->top3 (閾値 0.30) overall 229.5% / 勝 3/6 / 件数 365 ⭐ leak-free TRUSTED
        #   旧 0.20 (avg 308% と謳ってた) は実は look-ahead 由来。真の WF では 73.4% で大負け
        "key": "value_tan3",
        "name_in_backtest": "value_tan3_nopop_030",
        "label": "金の3連単 (人気を見ない AI の 1着→2着→3着・自信あるとき限定で1点 100円)",
        "short_label": "金の3連単",
        "color": "gold",
        "bet_type": "3 連単 (nopop top1->2->3)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.30)(_nopop_top(horses))
        ),
    },
    {
        # Wave30-X3: V-3連単 長距離 (2100m+) × 閾値 0.25 — filter sweep で overall 731% / 勝 6/6 / 件数 170
        # ⚠ filter sweep ベース (predict cache は単一モデル・残存 leak あり) → 真の WF 未検証
        "key": "value_tan3_long",
        "name_in_backtest": "value_tan3_dist_long_025",
        "label": "長距離 (2100m+)・3連単 (まだ厳しい検証は未完了・参考)",
        "short_label": "長距離3連単",
        "color": "violet",
        "bet_type": "3 連単 (長距離・nopop top1->2->3)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            _race_distance(horses) >= 2100 and
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.25)(_nopop_top(horses))
        ),
    },
    {
        # Wave30-X3: V-3連単 ダート中距離 (1500-2000m) × 閾値 0.30 — filter sweep で overall 488% / 勝 6/6 / 件数 258
        "key": "value_tan3_dirt_mid",
        "name_in_backtest": "value_tan3_dirt_mid_030",
        "label": "ダート中距離・3連単 (まだ厳しい検証は未完了・参考)",
        "short_label": "ダート3連単",
        "color": "amber",
        "bet_type": "3 連単 (ダ中・nopop top1->2->3)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            "ダ" in _race_surface(horses) and
            1500 <= _race_distance(horses) <= 2000 and
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.30)(_nopop_top(horses))
        ),
    },
    {
        # Wave29-B: 馬連 nopop top1-top2 が avg 165%・勝 7/7・最悪 108.75% (閾値 0.30) で全期間 100% 越え!
        # value_multi_bet.json 参照
        "key": "value_uren",
        "name_in_backtest": "value_uren_nopop_030",
        "label": "実力派 AI の馬連 (人気を見ない・全部のレース版)",
        "short_label": "馬連 (実力派)",
        "color": "rose",
        "bet_type": "馬連 (nopop top1-top2)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.30)(_nopop_top(horses))
        ),
    },
    {
        # Wave29-B: 馬連 nopop top1-top2 閾値 0.16 で avg 222%・件数 2673 (積極派)
        "key": "value_uren_hot",
        "name_in_backtest": "value_uren_nopop_016",
        "label": "馬連 ねらい多め (基準を緩めて毎レース買う・厳しい検証で損確定)",
        "short_label": "馬連ねらい多め",
        "color": "violet",
        "bet_type": "馬連 (nopop top1-top2)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.16)(_nopop_top(horses))
        ),
    },
    {
        # Wave27 強化: 複勝 nopop top1 avg 152.62% / 勝 6/7 / 件数 2673 (閾値 0.16)
        "key": "value_invest",
        "name_in_backtest": "value_invest_nopop_016",
        "label": "実力派 AI 本命の複勝 (基準ゆるめ・厳しい検証で損確定)",
        "short_label": "複勝 (実力派)",
        "color": "rose",
        "bet_type": "複勝 (nopop top1)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.16)(_nopop_top(horses))
        ),
    },
    {
        # Wave27: 安定派 — 閾値 0.35 で avg 130.89% / σ 17.26 / 勝 6/7 / 件数 574
        "key": "value_safe",
        "name_in_backtest": "value_invest_nopop_035",
        "label": "実力派 AI 本命の複勝 (厳しめ・厳しい検証では損)",
        "short_label": "複勝・厳選",
        "color": "emerald",
        "bet_type": "複勝 (nopop top1・厳選)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.35)(_nopop_top(horses))
        ),
    },
    {
        "key": "big",
        "name_in_backtest": "fuku3_top3_conf50",
        "label": "AI 上位 3 頭の合計確率 50%+ で「3 連複 ボックス 1 点」(100 円)",
        "short_label": "BIG",
        "color": "violet",
        "bet_type": "3連複ボックス",
        "unit": 100,
        "trigger": lambda top, horses: (
            len(horses) >= 3 and
            sum((h.get("win_prob") or 0) for h in horses[:3]) >= 0.50
        ),
    },
    {
        "key": "turf",
        "name_in_backtest": "best_turf",
        "label": "芝レース で BEST 条件 (本命確率 22%+ かつ 対抗差 4pt+) → 複勝 100 円",
        "short_label": "TURF",
        "color": "emerald",
        "bet_type": "複勝",
        "unit": 100,
        "trigger": lambda top, horses: (
            _is_surface_turf(horses) and
            (top.get("win_prob") or 0) >= 0.22 and
            len(horses) >= 2 and
            ((top.get("win_prob") or 0) - (horses[1].get("win_prob") or 0)) >= 0.04
        ),
    },
    {
        "key": "ultra",
        "name_in_backtest": "combo_best_wide_double_bet",
        "label": "BEST+WIDE 両方発火時に「複勝 100 + ワイド 3 点 300」併買 (400 円)",
        "short_label": "ULTRA",
        "color": "gold",
        "bet_type": "複勝+ワイド3点",
        "unit": 400,
        "trigger": lambda top, horses: (
            (top.get("win_prob") or 0) >= 0.22 and
            len(horses) >= 3 and
            sum((h.get("win_prob") or 0) for h in horses[:3]) >= 0.50
        ),
    },
    {
        "key": "best",
        "name_in_backtest": "combo_best_and_gap",
        "label": "AI 本命確率 22%+ かつ 対抗との差 4pt+ で複勝 100 円",
        "short_label": "BEST",
        "color": "go",
        "bet_type": "複勝",
        "unit": 100,
        "trigger": lambda top, horses: (
            (top.get("win_prob") or 0) >= 0.22 and
            len(horses) >= 2 and
            ((top.get("win_prob") or 0) - (horses[1].get("win_prob") or 0)) >= 0.04
        ),
    },
    {
        "key": "safe",
        "name_in_backtest": "fuku_top1_prob_020",
        "label": "AI 本命確率 20%+ で複勝 100 円 (発火多め・安定)",
        "short_label": "SAFE",
        "color": "turf",
        "bet_type": "複勝",
        "unit": 100,
        "trigger": lambda top, horses: (top.get("win_prob") or 0) >= 0.20,
    },
]


# Wave28: value_multi_bet.json / value_threshold_sweep.json から final_period_roi を取り出す
# walk_forward_result.json には value_invest 系の戦略が含まれない場合があるため、これらも統合する
VALUE_MULTI_BET_PATH = CACHE / "value_multi_bet.json"
VALUE_THRESHOLD_SWEEP_PATH = CACHE / "value_threshold_sweep.json"
VALUE_UREN_FILTER_PATH = CACHE / "value_uren_filter_sweep.json"
VALUE_TAN3_FILTER_PATH = CACHE / "value_tan3_filter_sweep.json"  # Wave30-X3: 3連単 フィルタ別
WALK_FORWARD_V2_PATH = CACHE / "walk_forward_v2_result.json"  # Wave30: 期間別再学習 (真の look-ahead 無し)
WALK_FORWARD_STACK_PURE_PATH = CACHE / "walk_forward_stacking_pure.json"  # Wave30-X4: Stacking 期間別再学習
RISK_ANALYSIS_PATH = CACHE / "strategy_risk_analysis.json"      # Wave31-C: Kelly + ドローダウン

RISK_NAME_TO_BACKTEST = {
    "V-複勝 (閾値 0.16)": "value_invest_nopop_016",
    "V-馬連 (閾値 0.16)": "value_uren_nopop_016",
    "V-馬連 厳選 (閾値 0.30)": "value_uren_nopop_030",
    "V-3連単 (閾値 0.20)": "value_tan3_nopop_020",
    "V-DOUBLE 複勝+馬連 (閾値 0.16)": "value_double_nopop_016",
}


def _load_risk_analysis() -> Dict[str, Dict[str, Any]]:
    """strategy_risk_analysis.json から Kelly + ドローダウン情報"""
    out: Dict[str, Dict[str, Any]] = {}
    if not RISK_ANALYSIS_PATH.exists():
        return out
    try:
        ra = json.loads(RISK_ANALYSIS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return out
    for risk_name, by_per in (ra.get("strategies") or {}).items():
        backtest_name = RISK_NAME_TO_BACKTEST.get(risk_name)
        if not backtest_name:
            continue
        r = by_per.get("16_periods") or by_per.get("8_periods")
        if not r:
            continue
        kelly = r.get("kelly") or {}
        dd = r.get("drawdown") or {}
        out[backtest_name] = {
            "kelly_full": kelly.get("kelly_full"),
            "kelly_half_pct": round((kelly.get("kelly_half") or 0) * 100, 1),
            "kelly_quarter_pct": round((kelly.get("kelly_quarter") or 0) * 100, 1),
            "kelly_advice": kelly.get("advice"),
            "max_losing_streak": dd.get("max_losing_streak"),
            "max_drawdown_jpy": dd.get("max_drawdown_jpy"),
            "max_winning_streak": dd.get("max_winning_streak"),
            "total_bets_16p": dd.get("total_bets"),
        }
    return out


def _load_value_multi_bet_stats() -> Dict[str, Dict[str, Any]]:
    """value_multi_bet.json から各戦略のスナップショットを取り出す。
    キーは "value_uren_nopop_030" 等のフォーマットで walk_forward 互換にする。"""
    out: Dict[str, Dict[str, Any]] = {}
    if not VALUE_MULTI_BET_PATH.exists():
        return out
    try:
        d = json.loads(VALUE_MULTI_BET_PATH.read_text(encoding="utf-8"))
    except Exception:
        return out
    # bet type ラベルから「value_<type>_nopop_<th>」形式へ正規化
    label_to_prefix = {
        "複勝 nopop top1": "value_invest_nopop",
        "馬連 nopop top1-top2": "value_uren_nopop",
        "ワイド 3点 nopop top123": "value_wide_nopop",
        "3連複 ボックス nopop top123": "value_fuku3_nopop",
        "3連単 nopop top1->2->3": "value_tan3_nopop",
    }
    for label, items in (d.get("results") or {}).items():
        prefix = label_to_prefix.get(label)
        if not prefix:
            continue
        # items は dict (キー "th_0.16" 等) or list の可能性
        if isinstance(items, dict):
            iterable = items.values()
        elif isinstance(items, list):
            iterable = items
        else:
            continue
        for r in iterable:
            if not isinstance(r, dict):
                continue
            th = r.get("threshold")
            if th is None:
                continue
            key = f"{prefix}_{int(round(th * 100)):03d}"
            pr = r.get("period_rois") or []
            valid_pr = [x for x in pr if x is not None]
            final_roi = valid_pr[-1] if valid_pr else None
            entry = dict(r)
            entry["name"] = key
            if final_roi is not None:
                entry["final_period_roi"] = round(final_roi, 2)
            out[key] = entry
    return out


def _kelly_from_wf(wf: Dict[str, Any], unit_bet: int = 100) -> Optional[Dict[str, Any]]:
    """walk_forward_v2 由来の (leak-free) 統計から真の Kelly 比率を算出 (Wave32)。

    Kelly 公式: f* = (b*p - q) / b
      where:
        b = (平均払戻 / 1単位投資額) - 1  (= 純益倍率)
        p = 的中率
        q = 1 - p

    Returns: { kelly_full, kelly_half, kelly_quarter, advice, hit_rate, avg_payout, edge_pct } | None
    """
    if not wf or not wf.get("leakage_free"):
        return None
    bets = wf.get("total_bets") or 0
    hits = wf.get("total_hits") or 0
    if bets < 30 or hits < 1:
        # サンプル不足 (30 件未満 or 0 hit) は信頼できない
        return None
    overall_roi = wf.get("overall_roi_pct")
    if overall_roi is None or overall_roi <= 100:
        # 期待値マイナス領域は Kelly = 0 (賭けない)
        return {"kelly_full": 0.0, "kelly_half": 0.0, "kelly_quarter": 0.0,
                "advice": "期待値マイナス・賭けない", "hit_rate": hits / bets,
                "avg_payout": (wf.get("total_returned") or 0) / hits if hits else 0,
                "edge_pct": round(overall_roi - 100, 2) if overall_roi else None}
    total_ret = wf.get("total_returned") or 0
    avg_payout = total_ret / hits if hits > 0 else 0
    p = hits / bets
    if avg_payout <= unit_bet:
        # 平均払戻が投資額以下 = 損失確定領域
        return {"kelly_full": 0.0, "kelly_half": 0.0, "kelly_quarter": 0.0,
                "advice": "平均払戻が投資額以下", "hit_rate": p, "avg_payout": avg_payout,
                "edge_pct": round(overall_roi - 100, 2)}
    b = (avg_payout / unit_bet) - 1
    q = 1 - p
    kelly_f = max(0.0, (b * p - q) / b)
    # 推奨は Half Kelly (破産確率半減・実運用標準)
    kelly_half = kelly_f / 2
    kelly_quarter = kelly_f / 4
    edge_pct = round(overall_roi - 100, 2)
    bankroll_yen = 30000  # デフォルト ¥3 万円 bankroll
    half_yen = int(bankroll_yen * kelly_half)
    advice = f"bankroll ¥{bankroll_yen:,} なら Half Kelly = 1 R あたり ¥{half_yen:,} (期待 +{edge_pct}%)"
    return {
        "kelly_full": round(kelly_f, 4),
        "kelly_half": round(kelly_half, 4),
        "kelly_quarter": round(kelly_quarter, 4),
        "kelly_half_pct": round(kelly_half * 100, 2),
        "kelly_quarter_pct": round(kelly_quarter * 100, 2),
        "advice": advice,
        "hit_rate": round(p, 4),
        "avg_payout": round(avg_payout, 1),
        "edge_pct": edge_pct,
        "unit_bet": unit_bet,
        "bankroll_yen": bankroll_yen,
        "half_kelly_yen": half_yen,
        "leakage_free": True,
    }


def _load_walk_forward_stacking_pure_stats() -> Dict[str, Dict[str, Any]]:
    """walk_forward_stacking_pure.json (Wave30-X4: Stacking の真の期間別再学習) を統合。
    各 period で LGBM primary + nopop + XGB + CatB + LR の 5 モデルを再学習。
    結果は fuku_summary / uren_summary に格納。"""
    out: Dict[str, Dict[str, Any]] = {}
    if not WALK_FORWARD_STACK_PURE_PATH.exists():
        return out
    try:
        d = json.loads(WALK_FORWARD_STACK_PURE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return out
    th = d.get("threshold", 0.16)
    th_str = f"{int(round(th * 100)):03d}"
    for kind, name_suffix in [("fuku", "fuku"), ("uren", "uren")]:
        summary = d.get(f"{kind}_summary") or {}
        if not summary:
            continue
        rois = summary.get("rois") or []
        valid = [r for r in rois if r is not None]
        # Stacking pure は「期間別再学習」なので全期間が pure test = overall = mean
        overall_roi = round(sum(valid) / len(valid), 2) if valid else None
        key = f"value_stack_{name_suffix}_{th_str}"
        out[key] = {
            "name": key,
            "mean_roi_pct": summary.get("mean_roi_pct"),
            "worst_roi_pct": summary.get("worst_roi_pct"),
            "best_roi_pct": summary.get("best_roi_pct"),
            "final_period_roi": rois[-1] if rois else None,
            "overall_roi_pct": overall_roi,
            "roi_std": summary.get("roi_std"),
            "win_periods": summary.get("win_periods"),
            "active_periods": summary.get("active_periods"),
            "total_bets": None,
            "total_hits": None,
            "period_rois": rois,
            "leakage_free": True,  # Wave30-X4: 5 モデル全部期間別再学習で真の leak-free
        }
    return out


def _load_walk_forward_v2_stats() -> Dict[str, Dict[str, Any]]:
    """walk_forward_v2_result.json (期間別再学習・真の look-ahead 無し) を統合。
    Wave30: これが「真の Walk-forward」。他の walk_forward_*.json には残存 leakage がある。
    各 period で nopop モデルを再学習しているため、すべての期間が pure test。
    `overall_roi_pct` (全期間の総合 ROI) と `win_periods` を信頼判定の核に。"""
    out: Dict[str, Dict[str, Any]] = {}
    if not WALK_FORWARD_V2_PATH.exists():
        return out
    try:
        d = json.loads(WALK_FORWARD_V2_PATH.read_text(encoding="utf-8"))
    except Exception:
        return out
    for s in (d.get("strategies") or []):
        if not isinstance(s, dict):
            continue
        name = s.get("name")
        if not name:
            continue
        # walk_forward 互換形式に変換
        entry = {
            "name": name,
            "mean_roi_pct": s.get("mean_roi_pct"),
            "worst_roi_pct": s.get("worst_roi_pct"),
            "best_roi_pct": s.get("best_roi_pct"),
            "final_period_roi": s.get("final_period_roi"),
            "overall_roi_pct": s.get("overall_roi_pct"),  # Wave30: これが真の期待 ROI
            "roi_std": s.get("roi_std"),
            "win_periods": s.get("win_periods"),
            "active_periods": s.get("active_periods"),
            "total_bets": s.get("total_bets"),
            "total_hits": s.get("total_hits"),
            "total_invested": s.get("total_invested"),    # Wave32: Kelly 計算で必要
            "total_returned": s.get("total_returned"),    # Wave32: Kelly 計算で必要
            "hit_rate": s.get("hit_rate"),
            "period_rois": s.get("period_rois"),
            "period_bets": s.get("period_bets"),
            "leakage_free": True,  # 真の Walk-forward 由来
        }
        out[name] = entry
    return out


def _load_value_uren_filter_stats() -> Dict[str, Dict[str, Any]]:
    """value_uren_filter_sweep.json (V-馬連 を G1/芝/距離別 で絞った結果) を統合。
    Wave29: 「芝 + 0.30 → final 164.6% 勝 7/7」など真の TRUSTED 領域を発見。"""
    out: Dict[str, Dict[str, Any]] = {}
    if not VALUE_UREN_FILTER_PATH.exists():
        return out
    try:
        d = json.loads(VALUE_UREN_FILTER_PATH.read_text(encoding="utf-8"))
    except Exception:
        return out
    # フィルタ名 → name_in_backtest プレフィックス
    filter_to_key = {
        "turf":      "value_uren_turf",
        "dist_short": "value_uren_short",
        "g1":        "value_uren_g1",
        "graded":    "value_uren_graded",
        "kyoto":     "value_uren_kyoto",
    }
    for r in d.get("results") or []:
        if not isinstance(r, dict):
            continue
        f = r.get("filter")
        th = r.get("threshold")
        if not f or th is None:
            continue
        # 短距離厳選 (th=0.35) は別キー
        if f == "dist_short" and abs(th - 0.35) < 0.001:
            key = "value_uren_short_ultra_035"
        else:
            prefix = filter_to_key.get(f)
            if not prefix:
                continue
            key = f"{prefix}_{int(round(th * 100)):03d}"
        # mean_roi_pct を mean_period_roi_pct から (キー名統一)
        entry = {
            "name": key,
            "mean_roi_pct": r.get("mean_period_roi_pct"),
            "worst_roi_pct": r.get("worst_period_roi_pct"),
            "best_roi_pct": r.get("best_period_roi_pct"),
            "final_period_roi": r.get("final_period_roi_pct"),
            "final_period_bets": r.get("final_period_bets"),
            "roi_std": r.get("roi_std"),
            "win_periods": r.get("win_periods"),
            "active_periods": r.get("active_periods"),
            "total_bets": r.get("total_bets"),
            "total_hits": None,
            "period_rois": r.get("period_rois"),
            "period_bets": r.get("period_bets"),
        }
        out[key] = entry
    return out


def _load_value_threshold_sweep_stats() -> Dict[str, Dict[str, Any]]:
    """value_threshold_sweep.json (複勝 nopop 単独・閾値細かいスイープ) を統合。
    Wave28: V-SAFE (閾値 0.35) など、value_multi_bet にない閾値もカバーする。"""
    out: Dict[str, Dict[str, Any]] = {}
    if not VALUE_THRESHOLD_SWEEP_PATH.exists():
        return out
    try:
        d = json.loads(VALUE_THRESHOLD_SWEEP_PATH.read_text(encoding="utf-8"))
    except Exception:
        return out
    prefix = "value_invest_nopop"
    for r in d.get("results") or []:
        if not isinstance(r, dict):
            continue
        th = r.get("threshold")
        if th is None or r.get("total_bets", 0) == 0:
            continue
        key = f"{prefix}_{int(round(th * 100)):03d}"
        pr = r.get("period_rois") or []
        valid_pr = [x for x in pr if x is not None]
        final_roi = valid_pr[-1] if valid_pr else None
        entry = dict(r)
        entry["name"] = key
        if final_roi is not None:
            entry["final_period_roi"] = round(final_roi, 2)
        out[key] = entry
    return out


def _load_walk_forward() -> Dict[str, Dict[str, Any]]:
    """Walk-forward 検証結果を {strategy_name: stats} で返す。
    Wave28: value_multi_bet.json / value_threshold_sweep.json も統合 +
            既存 entries に final_period_roi (= 最終期間 ROI = pure test) を補完。"""
    out: Dict[str, Dict[str, Any]] = {}
    if WALK_FORWARD_PATH.exists():
        try:
            wf = json.loads(WALK_FORWARD_PATH.read_text(encoding="utf-8"))
            for s in (wf.get("strategies") or []):
                if not isinstance(s, dict):
                    continue
                pr = s.get("period_rois") or []
                if "final_period_roi" not in s and pr:
                    valid_pr = [x for x in pr if x is not None]
                    if valid_pr:
                        s["final_period_roi"] = round(valid_pr[-1], 2)
                out[s.get("name")] = s
        except Exception:
            pass
    # value_threshold_sweep.json を統合 (これで閾値 0.35 などもカバー)
    for k, v in _load_value_threshold_sweep_stats().items():
        out[k] = v
    # value_multi_bet.json を統合 (馬連・ワイド・3連複・3連単 + 複勝の細かい閾値)
    for k, v in _load_value_multi_bet_stats().items():
        out[k] = v
    # value_uren_filter_sweep.json を統合 (Wave29: G1/芝/距離別 で final ROI 高い領域)
    for k, v in _load_value_uren_filter_stats().items():
        out[k] = v
    # Wave30: walk_forward_v2 (期間別再学習・真の look-ahead 無し) を「最優先」マージ
    # これがある戦略は他の sweep 結果より信頼できる (上書きしてよい)
    for k, v in _load_walk_forward_v2_stats().items():
        out[k] = v
    # Wave30-X4: Stacking の真の期間別再学習 (5 モデル) も leak-free として統合
    for k, v in _load_walk_forward_stacking_pure_stats().items():
        out[k] = v
    return out


def _load_backtest_stats_all() -> Dict[str, Dict[str, Any]]:
    """戦略ごとの実証統計を {key: {...}} で返す。
    Walk-forward 検証があればその安定性データも含める。"""
    out: Dict[str, Dict[str, Any]] = {}
    bt = {}
    if BACKTEST_PATH.exists():
        try:
            bt = json.loads(BACKTEST_PATH.read_text(encoding="utf-8"))
        except Exception:
            bt = {}
    test_races = bt.get("test_races")
    by_name = {s.get("name"): s for s in (bt.get("strategies") or [])}
    wf_by_name = _load_walk_forward()
    risk_by_name = _load_risk_analysis()  # Wave31-C

    for defn in STRATEGY_DEFS:
        s = by_name.get(defn["name_in_backtest"])
        wf = wf_by_name.get(defn["name_in_backtest"])
        # Wave28: backtest に無くても walk_forward / value_multi_bet に存在すれば stats を作る
        if not s and not wf:
            continue
        if not s:
            # walk_forward 由来の擬似 stats を作る (mean_roi を採用)
            s = {
                "name": defn["name_in_backtest"],
                "bets": wf.get("total_bets"),
                "roi_pct": wf.get("mean_roi_pct"),
                "hit_rate": (wf.get("total_hits") or 0) / max(1, wf.get("total_bets") or 1)
                            if wf.get("total_hits") is not None else None,
                "invested": None, "returned": None, "profit": None, "max_payout": None,
            }
        # Wave28: Walk-forward 信頼性指標 (look-ahead leakage を考慮して厳格化)
        #   walk_forward_validate.py は全データの前 80% で学習した 1 モデルを全期間に適用しているため、
        #   最終期間 (period N-1) 以外は train データに含まれる。
        #   **真に学習に含まれない pure test は final_period_roi のみ**。
        #   trust_label の判定では final_period_roi >= 100 を必須条件とする。
        trust_level = None
        trust_label = None
        if wf:
            wp = wf.get("win_periods") or 0
            ap = wf.get("active_periods") or 1
            sigma = wf.get("roi_std") or 99
            mean_roi = wf.get("mean_roi_pct") or 0
            final_roi = wf.get("final_period_roi")  # Wave28: pure test ROI
            # final_roi が無い (古い結果) 場合は mean だけで判定 (旧仕様)
            if final_roi is None:
                if wp == ap and sigma < 15 and mean_roi >= 105:
                    trust_level = 4
                    trust_label = "TRUSTED (look-ahead 未補正)"
                elif wp >= ap * 0.8 and sigma < 20 and mean_roi >= 100:
                    trust_level = 3
                    trust_label = "STABLE (look-ahead 未補正)"
                elif wp >= ap // 2 and mean_roi >= 100:
                    trust_level = 2
                    trust_label = "MIXED (look-ahead 未補正)"
                else:
                    trust_level = 1
                    trust_label = "RISKY"
            else:
                # Wave28: 最終期間 ROI (pure test) を信頼判定の核に据える
                # Wave30: walk_forward_v2 (期間別再学習) が利用可能なら overall_roi_pct を優先
                #   これが「真の look-ahead 完全排除」した期待 ROI。
                if wf.get("leakage_free") and wf.get("overall_roi_pct") is not None:
                    leak_free_roi = wf.get("overall_roi_pct")
                    # Wave30-X2: overall ROI を最優先 (勝期間は副次・件数ペナルティなし)
                    # 真の WF で 130%+ 出てる戦略は控除率突破確定 → TRUSTED
                    if leak_free_roi >= 130 and wp >= ap // 2:
                        trust_level = 4
                        trust_label = "TRUSTED (真の WF で控除率を大幅突破)"
                    elif leak_free_roi >= 110 and wp >= ap // 2:
                        trust_level = 3
                        trust_label = "STABLE (真の WF で期待値+)"
                    elif leak_free_roi >= 95:
                        trust_level = 2
                        trust_label = "MIXED (真の WF で控除率周辺)"
                    else:
                        trust_level = 1
                        trust_label = "RISKY (真の WF で期待値マイナス)"
                elif final_roi >= 105 and wp == ap and mean_roi >= 105:
                    trust_level = 4
                    trust_label = "TRUSTED (最終期間でも期待値プラス・但し未検証)"
                elif final_roi >= 100 and wp >= ap * 0.8 and mean_roi >= 100:
                    trust_level = 3
                    trust_label = "STABLE (最終期間で 100%+)"
                elif final_roi >= 95 and wp >= ap // 2 and mean_roi >= 100:
                    trust_level = 2
                    trust_label = "MIXED (最終期間 ぎりぎり)"
                else:
                    trust_level = 1
                    trust_label = "RISKY (最終期間で 100% 割れ)"

        out[defn["key"]] = {
            "strategy_key": defn["key"],
            "strategy_name": defn["name_in_backtest"],
            "label": defn["label"],
            "short_label": defn["short_label"],
            "color": defn["color"],
            "bet_type": defn["bet_type"],
            "unit": defn["unit"],
            "test_races": test_races,
            "fired_count": s.get("bets"),
            "fired_rate_pct": round((s.get("bets") or 0) / max(1, test_races or 1) * 100, 1),
            "roi_pct": s.get("roi_pct"),
            "hit_rate_pct": round((s.get("hit_rate") or 0) * 100, 1),
            "invested": s.get("invested"),
            "returned": s.get("returned"),
            "profit": s.get("profit"),
            "max_payout": s.get("max_payout"),
            "walk_forward": wf,        # 期間別 ROI 配列 / 統計
            "final_period_roi": (wf or {}).get("final_period_roi"),  # Wave28: pure test ROI を直接 UI へ
            "overall_roi_pct_v2": (wf or {}).get("overall_roi_pct"),  # Wave30: 真の look-ahead 無し ROI
            "leakage_free": bool((wf or {}).get("leakage_free")),
            "kelly_true": _kelly_from_wf(wf, unit_bet=defn.get("unit", 100)),  # Wave32: 真の Kelly
            "trust_level": trust_level,
            "trust_label": trust_label,
            # Wave31-C: Kelly criterion + ドローダウン
            "risk": risk_by_name.get(defn["name_in_backtest"]),
        }
    return out


def _trigger_strategies(top: Dict[str, Any], horses: List[Dict[str, Any]]) -> List[str]:
    """各レースで発火する戦略キーの一覧を返す。"""
    keys = []
    for defn in STRATEGY_DEFS:
        try:
            if defn["trigger"](top, horses):
                keys.append(defn["key"])
        except Exception:
            continue
    return keys


def collect(recent_days: int) -> Dict[str, Any]:
    """全 predictions/*.json を走査して、各戦略のトリガー条件を満たす本命を抽出。
    1 レースで複数戦略が発火することもある (BEST と SAFE は重なる)。"""
    stats_by_key = _load_backtest_stats_all()

    if not PREDICTIONS_DIR.exists():
        return {
            "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "stats": stats_by_key,
            "recommendations_today": [],
            "recommendations_recent": [],
            "count_today": 0, "count_recent": 0, "total_predictions": 0,
        }

    today = dt.datetime.now(JST).date()
    recent_threshold = today - dt.timedelta(days=recent_days)

    today_picks: List[Dict[str, Any]] = []
    recent_picks: List[Dict[str, Any]] = []
    total = 0
    fired_by_key: Dict[str, int] = {k: 0 for k in (d["key"] for d in STRATEGY_DEFS)}

    for p in sorted(PREDICTIONS_DIR.glob("*.json")):
        total += 1
        try:
            pred = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not pred.get("ok"):
            continue
        horses = pred.get("horses") or []
        if not horses:
            continue
        rid = pred.get("race_id") or p.stem
        race_date = _parse_race_date(rid)
        if race_date is None:
            continue
        meta = _load_race_meta(rid)
        # Wave29: race_distance / is_g1 を horse に注入 (V-芝馬連・V-短距離 trigger 用)
        # 既存 predictions json には race_distance が無いので、race ファイルから補完
        if meta.get("distance") is not None or meta.get("is_g1"):
            for h in horses:
                if h.get("race_distance") is None and meta.get("distance"):
                    h["race_distance"] = meta.get("distance")
                if "race_is_g1" not in h:
                    h["race_is_g1"] = bool(meta.get("is_g1"))
        top = horses[0]
        triggered = _trigger_strategies(top, horses)
        if not triggered:
            continue
        for k in triggered:
            fired_by_key[k] = fired_by_key.get(k, 0) + 1
        # 推奨買い目: トップ 3 頭の情報も含める (ワイド戦略向け)
        top3_info = [
            {"number": h.get("number"), "name": h.get("name"),
             "win_prob": h.get("win_prob"), "odds": h.get("odds"),
             "popularity": h.get("popularity")}
            for h in horses[:3]
        ]
        # Wave27: value_invest 戦略が発火している場合は use_horse を nopop_top にスワップ
        #   STRATEGY_DEFS の use_nopop=True 戦略があれば、その馬を horse として記録する
        use_horse = top
        if any(d.get("use_nopop") and d["key"] in triggered for d in STRATEGY_DEFS):
            nt = _nopop_top(horses)
            if nt is not None:
                use_horse = nt
        item = {
            "race_id": rid,
            "race_name": meta.get("race_name") or None,
            "course": meta.get("course") or None,
            "distance": meta.get("distance"),
            "going": meta.get("going"),
            "weather": meta.get("weather"),
            "is_g1": meta.get("is_g1"),
            "hassou_time": meta.get("hassou_time"),
            "strategies": triggered,        # ["value_invest", "best", "safe"] 等
            "horse": {
                "number": use_horse.get("number"),
                "name": use_horse.get("name"),
                "win_prob": use_horse.get("win_prob"),
                "nopop_prob": use_horse.get("nopop_prob"),
                "value_signal": use_horse.get("value_signal"),
                "odds": use_horse.get("odds"),
                "popularity": use_horse.get("popularity"),
                "ev": use_horse.get("ev"),
                "rank_nopop": use_horse.get("rank_nopop"),
            },
            "top3": top3_info,
            "top3_prob_sum": sum((h.get("win_prob") or 0) for h in horses[:3]),
            "race_date": race_date.isoformat(),
            "predicted_at": pred.get("predicted_at"),
            "model_auc": pred.get("model_auc"),
        }
        if race_date == today:
            today_picks.append(item)
        if race_date >= recent_threshold:
            recent_picks.append(item)

    today_picks.sort(key=lambda x: (x.get("hassou_time") or "0000", x["race_id"]))
    recent_picks.sort(key=lambda x: x["race_id"], reverse=True)

    # Wave28: 今日 0 件・直近 N 日 0 件のときは「最新 fired pick 20 件」を fallback として返す
    # → ユーザーが「VALUE 152% 戦略」をタップしても 0 件で看板倒れにならないように
    fallback_picks: List[Dict[str, Any]] = []
    if len(recent_picks) == 0:
        all_fired: List[Dict[str, Any]] = []
        for p in sorted(PREDICTIONS_DIR.glob("*.json"), reverse=True):
            try:
                pred = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not pred.get("ok"):
                continue
            horses = pred.get("horses") or []
            if not horses:
                continue
            rid = pred.get("race_id") or p.stem
            race_date = _parse_race_date(rid)
            if race_date is None:
                continue
            meta = _load_race_meta(rid)
            # Wave29: race_distance / is_g1 を horse に注入
            if meta.get("distance") is not None or meta.get("is_g1"):
                for h in horses:
                    if h.get("race_distance") is None and meta.get("distance"):
                        h["race_distance"] = meta.get("distance")
                    if "race_is_g1" not in h:
                        h["race_is_g1"] = bool(meta.get("is_g1"))
            top = horses[0]
            triggered = _trigger_strategies(top, horses)
            if not triggered:
                continue
            top3_info = [
                {"number": h.get("number"), "name": h.get("name"),
                 "win_prob": h.get("win_prob"), "odds": h.get("odds"),
                 "popularity": h.get("popularity")}
                for h in horses[:3]
            ]
            use_horse = top
            if any(d.get("use_nopop") and d["key"] in triggered for d in STRATEGY_DEFS):
                nt = _nopop_top(horses)
                if nt is not None:
                    use_horse = nt
            all_fired.append({
                "race_id": rid,
                "race_name": meta.get("race_name") or None,
                "course": meta.get("course") or None,
                "distance": meta.get("distance"),
                "going": meta.get("going"),
                "weather": meta.get("weather"),
                "is_g1": meta.get("is_g1"),
                "hassou_time": meta.get("hassou_time"),
                "strategies": triggered,
                "horse": {
                    "number": use_horse.get("number"),
                    "name": use_horse.get("name"),
                    "win_prob": use_horse.get("win_prob"),
                    "nopop_prob": use_horse.get("nopop_prob"),
                    "value_signal": use_horse.get("value_signal"),
                    "odds": use_horse.get("odds"),
                    "popularity": use_horse.get("popularity"),
                    "ev": use_horse.get("ev"),
                    "rank_nopop": use_horse.get("rank_nopop"),
                },
                "top3": top3_info,
                "top3_prob_sum": sum((h.get("win_prob") or 0) for h in horses[:3]),
                "race_date": race_date.isoformat(),
                "predicted_at": pred.get("predicted_at"),
                "model_auc": pred.get("model_auc"),
                "is_fallback": True,
            })
            if len(all_fired) >= 20:
                break
        all_fired.sort(key=lambda x: x["race_id"], reverse=True)
        fallback_picks = all_fired

    # Wave35-B: 戦略を「真値 ROI 降順」でソート (leak-free TRUSTED 最優先)
    # 信頼性 (leakage_free + trust_level + 真値 ROI) でランク付け
    def _strategy_priority(d):
        s = stats_by_key.get(d["key"]) or {}
        # 真の Walk-forward ROI を優先 (leak-free)
        true_roi = s.get("overall_roi_pct_v2") if s.get("leakage_free") else None
        # leak-free が無い場合は final_period_roi (look-ahead 無し最終期間)
        if true_roi is None:
            true_roi = s.get("final_period_roi")
        # それも無い場合は roi_pct (旧基準・leak 由来の可能性)
        if true_roi is None:
            true_roi = s.get("roi_pct") or 0
        trust_lvl = s.get("trust_level") or 0
        is_leak_free = bool(s.get("leakage_free"))
        # スコア: leak_free + 真値 ROI + trust_level の総合
        score = (10000 if is_leak_free else 0) + (true_roi or 0) + trust_lvl * 100
        return -score  # 降順

    sorted_defs = sorted(STRATEGY_DEFS, key=_strategy_priority)

    return {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "todayJst": today.isoformat(),
        "strategies_def": [
            {"key": d["key"], "label": d["label"], "short_label": d["short_label"],
             "color": d["color"], "bet_type": d["bet_type"], "unit": d["unit"]}
            for d in sorted_defs
        ],
        "stats": stats_by_key,
        "recommendations_today": today_picks,
        "recommendations_recent": recent_picks[:50],
        "recommendations_fallback": fallback_picks,
        "count_today": len(today_picks),
        "count_recent": len(recent_picks),
        "count_fallback": len(fallback_picks),
        "total_predictions": total,
        "fired_by_key": fired_by_key,
    }


def main():
    ap = argparse.ArgumentParser(description="推奨買い目を集約 (Wave19.3: 3 戦略マルチアサイン)")
    ap.add_argument("--recent-days", type=int, default=30,
                    help="recent に含める日数 (デフォルト 14)")
    args = ap.parse_args()

    out = collect(args.recent_days)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[OK] 推奨集約完了:", flush=True)
    print(f"     今日 ({out.get('todayJst')}) の推奨レース: {out.get('count_today')} 件", flush=True)
    print(f"     直近 {args.recent_days} 日の推奨レース: {out.get('count_recent')} 件", flush=True)
    print(f"     検証期間の発火数 (戦略別):", flush=True)
    for k, v in (out.get("fired_by_key") or {}).items():
        st = (out.get("stats") or {}).get(k)
        if st:
            print(f"       {k:<6}: 集約 {v:>4} 件 / 検証 {st.get('fired_count')} 件 / 回収率 {st.get('roi_pct')}% / 的中率 {st.get('hit_rate_pct')}%", flush=True)
        else:
            print(f"       {k:<6}: 集約 {v:>4} 件", flush=True)
    print(f"     → {OUT_PATH.relative_to(ROOT)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
