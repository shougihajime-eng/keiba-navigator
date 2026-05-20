# -*- coding: utf-8 -*-
"""
strategy_live_log.py — V-STACK 等の戦略を本番運用で日次記録 (Wave31-E)

毎日 (race_day_pipeline.py の最後で) 実行:
  1. recommendations.json から「今日 fire した戦略 + 馬 + odds」を読む
  2. data/jv_cache/strategy_live_log.json に追記 (key=race_id+strategy+date)
  3. 過去の log の「結果未確定エントリ」について results/<race_id>.json を見て確定
  4. 戦略ごとの 実運用 ROI / 連敗 / ドローダウン を集計

【目的】
backtest_result.json の「過去レースで再評価した ROI」と、本番運用で
実際に的中したかは別物。本番運用ログを継続記録することで、本物の
「実 ROI」を追跡できる。

出力:
  data/jv_cache/strategy_live_log.json (蓄積データ)
  data/jv_cache/strategy_live_stats.json (戦略別 実 ROI / 連敗 / DD)

使い方:
  py -3.12 jv_bridge\\strategy_live_log.py
  py -3.12 jv_bridge\\strategy_live_log.py --recompute  # 過去ログを再評価
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
RESULTS_DIR = CACHE / "results"
RECOMMENDATIONS_PATH = CACHE / "recommendations.json"
LOG_PATH = CACHE / "strategy_live_log.json"
STATS_PATH = CACHE / "strategy_live_stats.json"


def _load_log() -> Dict[str, Any]:
    if not LOG_PATH.exists():
        return {"entries": [], "last_updated": None}
    try:
        return json.loads(LOG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"entries": [], "last_updated": None}


def _save_log(log: Dict[str, Any]):
    LOG_PATH.write_text(json.dumps(log, ensure_ascii=False, indent=2), encoding="utf-8")


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
    if nums == sorted([a, b]):
        return int(uren.get("amount") or 0)
    return 0


def _payout_tan3(payouts: Dict[str, Any], a: int, b: int, c: int) -> int:
    tan3 = (payouts or {}).get("tan3")
    if not isinstance(tan3, dict):
        return 0
    key = tan3.get("key") or ""
    nums = [int(x) for x in key.split("-") if x.isdigit()]
    if nums == [a, b, c]:
        return int(tan3.get("amount") or 0)
    return 0


def _compute_result(entry: Dict[str, Any], payouts: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """戦略エントリと payouts から (invest, payout, hit) を返す
    エントリ構造: {race_id, strategy, horse_number, horse_number_2, horse_number_3, bet_type, unit}
    """
    bet_type = entry.get("bet_type") or ""
    n1 = entry.get("horse_number")
    n2 = entry.get("horse_number_2")
    n3 = entry.get("horse_number_3")
    unit = entry.get("unit") or 100

    if "複勝" in bet_type and "馬連" in bet_type:  # V-DOUBLE
        if n1 is None or n2 is None: return None
        return {
            "invest": unit,
            "payout": _payout_fuku(payouts, int(n1)) + _payout_uren(payouts, int(n1), int(n2)),
        }
    elif "複勝" in bet_type and "Stacking" not in bet_type and "馬連" not in bet_type:
        if n1 is None: return None
        return {"invest": unit, "payout": _payout_fuku(payouts, int(n1))}
    elif "Stacking 複勝" in bet_type:
        if n1 is None: return None
        return {"invest": unit, "payout": _payout_fuku(payouts, int(n1))}
    elif "馬連" in bet_type:
        if n1 is None or n2 is None: return None
        return {"invest": unit, "payout": _payout_uren(payouts, int(n1), int(n2))}
    elif "3 連単" in bet_type or "3連単" in bet_type:
        if None in (n1, n2, n3): return None
        return {"invest": unit, "payout": _payout_tan3(payouts, int(n1), int(n2), int(n3))}
    return None


def append_today():
    """recommendations.json から今日の発火戦略を読み出して log に追記"""
    if not RECOMMENDATIONS_PATH.exists():
        print("recommendations.json なし")
        return 0
    try:
        rec = json.loads(RECOMMENDATIONS_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"rec 読込失敗: {e}")
        return 1

    log = _load_log()
    existing_keys = {f"{e['race_id']}::{e['strategy']}" for e in log["entries"]}
    today_picks = rec.get("recommendations_today") or []
    appended = 0
    for item in today_picks:
        rid = item.get("race_id")
        if not rid: continue
        strategies = item.get("strategies") or []
        horse = item.get("horse") or {}
        top3 = item.get("top3") or []
        for s in strategies:
            key = f"{rid}::{s}"
            if key in existing_keys: continue
            # 戦略の bet_type / unit を取得
            stats = rec.get("stats") or {}
            sd = stats.get(s) or {}
            bet_type = sd.get("bet_type") or ""
            unit = sd.get("unit") or 100
            n1 = horse.get("number")
            n2 = top3[1].get("number") if len(top3) >= 2 else None
            n3 = top3[2].get("number") if len(top3) >= 3 else None
            log["entries"].append({
                "race_id": rid,
                "strategy": s,
                "logged_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "race_date": item.get("race_date"),
                "horse_number": n1, "horse_number_2": n2, "horse_number_3": n3,
                "horse_name": horse.get("name"),
                "bet_type": bet_type,
                "unit": unit,
                "result": None,
                "payout": None,
            })
            appended += 1
            existing_keys.add(key)
    log["last_updated"] = dt.datetime.now(dt.timezone.utc).isoformat()
    _save_log(log)
    print(f"[append] {appended} 新規 / 合計 {len(log['entries'])} エントリ")
    return appended


def resolve_pending():
    """log の result == None なエントリについて、results JSON から確定処理"""
    log = _load_log()
    resolved = 0
    for entry in log["entries"]:
        if entry.get("result") is not None: continue
        rid = entry.get("race_id")
        result_path = RESULTS_DIR / f"{rid}.json"
        if not result_path.exists(): continue
        try:
            result_data = json.loads(result_path.read_text(encoding="utf-8"))
        except Exception: continue
        payouts = result_data.get("payouts") or {}
        if not payouts: continue
        res = _compute_result(entry, payouts)
        if res is None: continue
        entry["result"] = "hit" if res["payout"] > 0 else "miss"
        entry["payout"] = res["payout"]
        entry["invest"] = res["invest"]
        entry["resolved_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        resolved += 1
    _save_log(log)
    print(f"[resolve] {resolved} 件確定")
    return resolved


def compute_stats():
    """戦略別の実 ROI / 連敗 / DD を集計"""
    log = _load_log()
    by_strat: Dict[str, Dict[str, Any]] = {}
    for entry in log["entries"]:
        if entry.get("result") is None: continue  # pending スキップ
        s = entry.get("strategy")
        if s not in by_strat:
            by_strat[s] = {"bets": 0, "invest": 0, "payout": 0, "hits": 0, "history": []}
        by_strat[s]["bets"] += 1
        by_strat[s]["invest"] += entry.get("invest") or 0
        by_strat[s]["payout"] += entry.get("payout") or 0
        if entry.get("result") == "hit":
            by_strat[s]["hits"] += 1
        by_strat[s]["history"].append((entry.get("invest") or 0, entry.get("payout") or 0))

    out = {}
    for s, st in by_strat.items():
        # 連敗 + DD
        cur_loss = 0
        max_loss = 0
        cum = 0
        peak = 0
        max_dd = 0
        for inv, pay in st["history"]:
            cum += (pay - inv)
            if cum > peak: peak = cum
            dd = peak - cum
            if dd > max_dd: max_dd = dd
            if pay < inv:
                cur_loss += 1
                if cur_loss > max_loss: max_loss = cur_loss
            else:
                cur_loss = 0
        out[s] = {
            "bets": st["bets"],
            "invest_jpy": st["invest"],
            "payout_jpy": st["payout"],
            "profit_jpy": st["payout"] - st["invest"],
            "roi_pct": round(st["payout"] / st["invest"] * 100, 2) if st["invest"] > 0 else None,
            "hit_rate_pct": round(st["hits"] / st["bets"] * 100, 2) if st["bets"] > 0 else None,
            "max_losing_streak": max_loss,
            "max_drawdown_jpy": max_dd,
        }
    stats_doc = {
        "computed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "total_entries": len(log["entries"]),
        "resolved_entries": sum(1 for e in log["entries"] if e.get("result") is not None),
        "by_strategy": out,
    }
    STATS_PATH.write_text(json.dumps(stats_doc, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[stats] 戦略別実 ROI を {STATS_PATH.name} に保存")
    for s, r in out.items():
        roi = f"{r['roi_pct']}%" if r['roi_pct'] is not None else "—"
        print(f"  {s}: {r['bets']} 件・ROI {roi}・連敗 {r['max_losing_streak']}")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-append", action="store_true")
    args = parser.parse_args(argv)

    if not args.skip_append:
        append_today()
    resolve_pending()
    compute_stats()
    return 0


if __name__ == "__main__":
    sys.exit(main())
