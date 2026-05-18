# -*- coding: utf-8 -*-
"""
aggregate_recommendations.py — 推奨買い目を集約して 1 つの JSON にする

戦略 fuku_top1_prob_020:
  - AI 本命の win_prob >= 0.20 のレースだけ
  - 過去 690 R で回収率 106.3% / 的中率 72.0% / 100 件発火
  - 買い方: 複勝 100 円

入力: data/jv_cache/predictions/<race_id>.json (3492 個)
入力: data/jv_cache/races/<race_id>.json (race name / course / 発走時刻のメタ)
出力: data/jv_cache/recommendations.json (集約・git push 対象)

使い方:
  py -3 jv_bridge\\aggregate_recommendations.py
  py -3 jv_bridge\\aggregate_recommendations.py --threshold 0.20 --recent-days 7

設計:
  - "today" = 今日の日付 (JST) のレース → アプリで「今日の推奨」として表示
  - "recent" = 直近 recent-days 日のレース (今日含む) → 「最近の推奨」
  - "stats" = 過去レースで実証した戦略パフォーマンス (backtest_result.json 由来)
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


def _load_backtest_stats() -> Optional[Dict[str, Any]]:
    if not BACKTEST_PATH.exists():
        return None
    try:
        bt = json.loads(BACKTEST_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None
    # fuku_top1_prob_020 戦略の統計を取り出す
    for s in (bt.get("strategies") or []):
        if s.get("name") == "fuku_top1_prob_020":
            return {
                "strategy_name": s.get("name"),
                "label": "AI 本命の確率 20% 以上で複勝 100 円",
                "test_races": bt.get("test_races"),
                "fired_count": s.get("bets"),
                "fired_rate_pct": round((s.get("bets") or 0) / max(1, bt.get("test_races") or 1) * 100, 1),
                "roi_pct": s.get("roi_pct"),
                "hit_rate_pct": round((s.get("hit_rate") or 0) * 100, 1),
                "invested": s.get("invested"),
                "returned": s.get("returned"),
                "profit": s.get("profit"),
                "max_payout": s.get("max_payout"),
            }
    return None


def collect(threshold: float, recent_days: int) -> Dict[str, Any]:
    """全 predictions/*.json を走査して、win_prob >= threshold の本命を抽出。"""
    if not PREDICTIONS_DIR.exists():
        return {
            "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "criteria": {"strategy": "fuku_top1_prob_020", "win_prob_min": threshold,
                         "bet_type": "複勝", "unit": 100},
            "stats": _load_backtest_stats(),
            "recommendations_today": [],
            "recommendations_recent": [],
            "count_today": 0, "count_recent": 0, "total_predictions": 0,
        }

    today = dt.datetime.now(JST).date()
    recent_threshold = today - dt.timedelta(days=recent_days)

    today_picks: List[Dict[str, Any]] = []
    recent_picks: List[Dict[str, Any]] = []
    total = 0
    fired = 0

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
        win_prob = top.get("win_prob")
        if win_prob is None or win_prob < threshold:
            continue
        fired += 1

        rid = pred.get("race_id") or p.stem
        race_date = _parse_race_date(rid)
        if race_date is None:
            continue
        meta = _load_race_meta(rid)
        item = {
            "race_id": rid,
            "race_name": meta.get("race_name") or None,
            "course": meta.get("course") or None,
            "distance": meta.get("distance"),
            "going": meta.get("going"),
            "weather": meta.get("weather"),
            "is_g1": meta.get("is_g1"),
            "hassou_time": meta.get("hassou_time"),
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
            "race_date": race_date.isoformat(),
            "predicted_at": pred.get("predicted_at"),
            "model_auc": pred.get("model_auc"),
        }
        if race_date == today:
            today_picks.append(item)
        if race_date >= recent_threshold:
            recent_picks.append(item)

    # 時系列順
    today_picks.sort(key=lambda x: (x.get("hassou_time") or "0000", x["race_id"]))
    recent_picks.sort(key=lambda x: x["race_id"], reverse=True)

    return {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "todayJst": today.isoformat(),
        "criteria": {
            "strategy": "fuku_top1_prob_020",
            "label": f"AI 本命の確率 {int(threshold*100)}% 以上で複勝 100 円",
            "win_prob_min": threshold,
            "bet_type": "複勝",
            "unit": 100,
        },
        "stats": _load_backtest_stats(),
        "recommendations_today": today_picks,
        "recommendations_recent": recent_picks[:50],   # 最大 50 件
        "count_today": len(today_picks),
        "count_recent": len(recent_picks),
        "total_predictions": total,
        "total_fired": fired,
    }


def main():
    ap = argparse.ArgumentParser(description="推奨買い目を集約")
    ap.add_argument("--threshold", type=float, default=0.20,
                    help="AI 本命の win_prob 閾値 (デフォルト 0.20)")
    ap.add_argument("--recent-days", type=int, default=14,
                    help="recent に含める日数 (デフォルト 14)")
    args = ap.parse_args()

    out = collect(args.threshold, args.recent_days)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[OK] 推奨集約完了:", flush=True)
    print(f"     今日 ({out.get('todayJst')}) の推奨レース: {out.get('count_today')} 件", flush=True)
    print(f"     直近 {args.recent_days} 日の推奨レース: {out.get('count_recent')} 件", flush=True)
    print(f"     検証期間の発火数: {out.get('total_fired')} / {out.get('total_predictions')} 件", flush=True)
    if out.get("stats"):
        st = out["stats"]
        print(f"     戦略実証成績: 回収率 {st.get('roi_pct')}% / 的中率 {st.get('hit_rate_pct')}% / {st.get('fired_count')} 件", flush=True)
    print(f"     → {OUT_PATH.relative_to(ROOT)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
