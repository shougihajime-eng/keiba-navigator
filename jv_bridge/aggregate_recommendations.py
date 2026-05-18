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

STRATEGY_DEFS = [
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


def _load_walk_forward() -> Dict[str, Dict[str, Any]]:
    """Walk-forward 検証結果を {strategy_name: stats} で返す。"""
    out: Dict[str, Dict[str, Any]] = {}
    if not WALK_FORWARD_PATH.exists():
        return out
    try:
        wf = json.loads(WALK_FORWARD_PATH.read_text(encoding="utf-8"))
    except Exception:
        return out
    for s in (wf.get("strategies") or []):
        out[s.get("name")] = s
    return out


def _load_backtest_stats_all() -> Dict[str, Dict[str, Any]]:
    """戦略ごとの実証統計を {key: {...}} で返す。
    Walk-forward 検証があればその安定性データも含める。"""
    out: Dict[str, Dict[str, Any]] = {}
    if not BACKTEST_PATH.exists():
        return out
    try:
        bt = json.loads(BACKTEST_PATH.read_text(encoding="utf-8"))
    except Exception:
        return out
    test_races = bt.get("test_races")
    by_name = {s.get("name"): s for s in (bt.get("strategies") or [])}
    wf_by_name = _load_walk_forward()

    for defn in STRATEGY_DEFS:
        s = by_name.get(defn["name_in_backtest"])
        if not s:
            continue
        wf = wf_by_name.get(defn["name_in_backtest"])
        # Walk-forward 信頼性指標 (★ 数で表示する用)
        # 4/4 期間勝 + σ<10 = ★★★★ TRUSTED
        # 3-4/4 + σ<15        = ★★★ STABLE
        # 2/4                = ★★ MIXED
        # 0-1/4               = ★ RISKY
        trust_level = None
        trust_label = None
        if wf:
            wp = wf.get("win_periods") or 0
            ap = wf.get("active_periods") or 1
            sigma = wf.get("roi_std") or 99
            mean_roi = wf.get("mean_roi_pct") or 0
            if wp == ap and sigma < 10 and mean_roi >= 105:
                trust_level = 4
                trust_label = "TRUSTED"
            elif wp >= ap - 1 and sigma < 15 and mean_roi >= 100:
                trust_level = 3
                trust_label = "STABLE"
            elif wp >= ap // 2 and mean_roi >= 100:
                trust_level = 2
                trust_label = "MIXED"
            else:
                trust_level = 1
                trust_label = "RISKY"

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
        top = horses[0]
        triggered = _trigger_strategies(top, horses)
        if not triggered:
            continue
        for k in triggered:
            fired_by_key[k] = fired_by_key.get(k, 0) + 1

        rid = pred.get("race_id") or p.stem
        race_date = _parse_race_date(rid)
        if race_date is None:
            continue
        meta = _load_race_meta(rid)
        # 推奨買い目: トップ 3 頭の情報も含める (ワイド戦略向け)
        top3_info = [
            {"number": h.get("number"), "name": h.get("name"),
             "win_prob": h.get("win_prob"), "odds": h.get("odds"),
             "popularity": h.get("popularity")}
            for h in horses[:3]
        ]
        item = {
            "race_id": rid,
            "race_name": meta.get("race_name") or None,
            "course": meta.get("course") or None,
            "distance": meta.get("distance"),
            "going": meta.get("going"),
            "weather": meta.get("weather"),
            "is_g1": meta.get("is_g1"),
            "hassou_time": meta.get("hassou_time"),
            "strategies": triggered,        # ["best", "safe"] 等
            "horse": {
                "number": top.get("number"),
                "name": top.get("name"),
                "win_prob": top.get("win_prob"),
                "nopop_prob": top.get("nopop_prob"),
                "value_signal": top.get("value_signal"),
                "odds": top.get("odds"),
                "popularity": top.get("popularity"),
                "ev": top.get("ev"),
                "rank_nopop": top.get("rank_nopop"),
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
        "count_today": len(today_picks),
        "count_recent": len(recent_picks),
        "total_predictions": total,
        "fired_by_key": fired_by_key,
    }


def main():
    ap = argparse.ArgumentParser(description="推奨買い目を集約 (Wave19.3: 3 戦略マルチアサイン)")
    ap.add_argument("--recent-days", type=int, default=14,
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
