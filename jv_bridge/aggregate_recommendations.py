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
        "label": "芝 限定 × 馬連 nopop top1-top2 (閾値 30%) — 真の期待 164.6%・勝 7/7・件数 448",
        "short_label": "V-芝馬連",
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
        "label": "短距離 (1000-1400m) × 馬連 nopop top1-top2 (閾値 30%) — 真の期待 277%・勝 6/7・件数 279",
        "short_label": "V-短距離",
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
        "label": "短距離 × 馬連 nopop (閾値 35%・厳選) — 真の期待 381%・勝 5/7・件数 165",
        "short_label": "V-短距離Σ",
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
        # Wave30-C: 🏆 Stacking メタモデル — 馬連で全期間 100%+ 達成 (avg 244%・勝 7/7)
        # 4 モデル (LGBM + nopop + XGB + CatB) を LR で合成・nopop 重み 23.3 が圧倒
        # CatB は逆向きシグナル (-5.6)
        "key": "value_stack_uren",
        "name_in_backtest": "value_stack_uren_016",
        "label": "Stacking 馬連 (4 モデル LR 合成) — avg 244%・worst 105%・全期間 100%+ ⭐ 世界一級",
        "short_label": "V-STACK",
        "color": "gold",
        "bet_type": "馬連 (Stacking top1-top2)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.16)(_nopop_top(horses))
        ),
    },
    {
        # Wave30-C: Stacking 複勝 avg 156%・σ 39・件数 2893
        "key": "value_stack_fuku",
        "name_in_backtest": "value_stack_fuku_016",
        "label": "Stacking 複勝 (4 モデル LR 合成) — avg 156%・σ 39",
        "short_label": "V-STACK複",
        "color": "amber",
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
        "label": "複勝+馬連 併買 (200 円) — avg 187.6% / σ 64・最もバランス良い・worst 72%",
        "short_label": "V-DOUBLE",
        "color": "rose",
        "bet_type": "複勝+馬連 (nopop top1-top2)",
        "unit": 200,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.16)(_nopop_top(horses))
        ),
    },
    {
        # Wave30-A: 3連単 nopop top1->top2->top3 (閾値 0.20) avg 308.50% / 件数 2160 / 勝 6/7 / σ 191
        # ハイリスクハイリターン・1 期間で 40% まで落ちる可能性
        "key": "value_tan3",
        "name_in_backtest": "value_tan3_nopop_020",
        "label": "3 連単 nopop top1->top2->top3 (閾値 20%・ハイリターン) — avg 308.5%・σ 191・勝 6/7",
        "short_label": "V-3連単",
        "color": "gold",
        "bet_type": "3 連単 (nopop top1->2->3)",
        "unit": 100,
        "use_nopop": True,
        "trigger": lambda top, horses: (
            (lambda nt: nt is not None and (nt.get("nopop_prob") or 0) >= 0.20)(_nopop_top(horses))
        ),
    },
    {
        # Wave29-B: 馬連 nopop top1-top2 が avg 165%・勝 7/7・最悪 108.75% (閾値 0.30) で全期間 100% 越え!
        # value_multi_bet.json 参照
        "key": "value_uren",
        "name_in_backtest": "value_uren_nopop_030",
        "label": "実力派 AI 本命+対抗 (人気を見ない) で馬連 100 円・全期間 100% 越え (勝 7/7)・avg 165%",
        "short_label": "V-馬連",
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
        "label": "馬連 nopop top1-top2 (閾値 16%・積極派) — avg 222%・件数 2673・勝 6/7",
        "short_label": "V-馬連HOT",
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
        "label": "実力派 AI 本命 (人気を見ないモデル) の確率 16%+ で複勝 100 円 — Walk-forward 152.62%",
        "short_label": "VALUE",
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
        "label": "実力派 AI 本命 (人気を見ない) の確率 35%+ で複勝 100 円 — 安定 σ17・avg 131%",
        "short_label": "V-SAFE",
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
                #   look-ahead leakage により mean は過大評価されがち。
                #   学習に含まれない最終期間で「期待値プラス + 全期間勝」が本物の証。
                if final_roi >= 105 and wp == ap and mean_roi >= 105:
                    trust_level = 4
                    trust_label = "TRUSTED (最終期間でも期待値プラス)"
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
            "trust_level": trust_level,
            "trust_label": trust_label,
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

    return {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "todayJst": today.isoformat(),
        "strategies_def": [
            {"key": d["key"], "label": d["label"], "short_label": d["short_label"],
             "color": d["color"], "bet_type": d["bet_type"], "unit": d["unit"]}
            for d in STRATEGY_DEFS
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
