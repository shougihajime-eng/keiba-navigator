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


def compute_yardstick(from_ymd: str, to_ymd: str) -> Dict[str, Any]:
    """ものさし＝「何も考えずに買う」いちばん単純な買い方の成績。

    なぜ要るか（2026-08-12）:
      画面には戦略の回収率だけが並んでいて、**比べる基準が無かった**。
      79.9% と出ていても、それが良いのか悪いのか誰にも分からない。
      実測すると「1番人気の複勝をベタ買い」だけで 83.2% ある。
      つまり多くの戦略は **いちばん単純な買い方に負けている**。
      それを隠さないために、同じ期間・同じレースで測って必ず並べて出す。

    ⚠ 数字は results/*.json の本物の払戻から数える（推定しない）。
    ⚠ 戦略が賭けた期間と同じ範囲で測る（別の期間と比べたら意味がない）。
    """
    out: Dict[str, Any] = {"from": from_ymd, "to": to_ymd, "races": 0, "rules": {}}
    fav_rows = []   # 1番人気ごとの {ymd, 単勝オッズ, 複勝払戻}（あとで帯べつに切る）
    acc = {
        "fav_fuku": {"label": "1番人気の複勝をベタ買い", "inv": 0, "pay": 0, "hit": 0},
        "fav_tan": {"label": "1番人気の単勝をベタ買い", "inv": 0, "pay": 0, "hit": 0},
    }
    for f in sorted(RESULTS_DIR.glob("*.json")):
        ymd = f.name[:8]
        if ymd < from_ymd or ymd > to_ymd:
            continue
        try:
            j = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        rows = j.get("results") or []
        pay = j.get("payouts") or {}
        fav = next((h for h in rows if h.get("popularity") == 1 and h.get("number")), None)
        if not fav:
            continue
        num = int(fav["number"])
        out["races"] += 1
        try:
            _odds = float(fav.get("win_odds")) if fav.get("win_odds") is not None else None
        except Exception:
            _odds = None
        fav_rows.append({"ymd": ymd, "odds": _odds, "fuku": _payout_fuku(pay, num)})
        # 複勝
        fp = _payout_fuku(pay, num)
        acc["fav_fuku"]["inv"] += 100
        acc["fav_fuku"]["pay"] += fp
        if fp > 0:
            acc["fav_fuku"]["hit"] += 1
        # 単勝
        # ⚠ tan は配列ではなく {"winner": 11, "amount": 490} の辞書
        #   （fuku だけが配列）。ここを配列だと思って回すと、キーの文字列を
        #   .get しようとして落ちる（実際に落ちた）。
        tp = 0
        tan = pay.get("tan")
        if isinstance(tan, dict) and int(tan.get("winner") or 0) == num:
            tp = int(tan.get("amount") or 0)
        acc["fav_tan"]["inv"] += 100
        acc["fav_tan"]["pay"] += tp
        if tp > 0:
            acc["fav_tan"]["hit"] += 1

    for k, a in acc.items():
        if a["inv"] <= 0:
            continue
        n = a["inv"] // 100
        out["rules"][k] = {
            "label": a["label"],
            "bets": n,
            "roi_pct": round(a["pay"] / a["inv"] * 100, 2),
            "hit_rate_pct": round(a["hit"] / n * 100, 2) if n else None,
            "profit_jpy": a["pay"] - a["inv"],
        }

    # ─── 2026-08-12: 「もし買うなら、いちばん損が小さい買い方」 ───────────
    #   7,231通りの総当たりで唯一 生き残ったのが **オッズの安い1番人気の複勝**。
    #   にせデータ(プラセボ)では合格ゼロ、多重比較の補正(SPA)後も p=0.0013。
    #   しかも100年前から知られている「人気馬は割安・大穴は割高」そのもので、
    #   データを掘って出た偶然ではない。
    #   ⚠ それでも **どれも100%未満**＝長く続ければ必ず負ける。
    #      「おすすめ」ではなく「買うなら これが一番マシ」として出す。
    #   ⚠ 締切後の確定オッズで切っているので、実際は境目の馬が入れ替わる。
    #      切る場所を動かしても なだらかに変わるだけなので致命的ではない（実測）。
    # ⚠ 帯は **全期間** で数える。戦略が賭けた期間（645レース）だと
    #   1.6倍未満が57件しかなく、「少なすぎて分からない」ものを見せてしまう。
    #   ものさし本体は「戦略と同じ期間」で測る（くらべる相手だから）が、
    #   帯は「どの買い方が一番マシか」を知るためなので、多いほうがよい。
    fav_all = []
    for f in sorted(RESULTS_DIR.glob("*.json")):
        try:
            j = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        rows = j.get("results") or []
        pay = j.get("payouts") or {}
        fav = next((h for h in rows if h.get("popularity") == 1 and h.get("number")), None)
        if not fav:
            continue
        try:
            o = float(fav.get("win_odds")) if fav.get("win_odds") is not None else None
        except Exception:
            o = None
        fav_all.append({"ymd": f.name[:8], "odds": o, "fuku": _payout_fuku(pay, int(fav["number"]))})
    fav_rows = fav_all
    if fav_all:
        out["bands_from"] = min(r["ymd"] for r in fav_all)
        out["bands_to"] = max(r["ymd"] for r in fav_all)
        _bi = 100 * len(fav_all)
        _bp = sum(r["fuku"] for r in fav_all)
        out["bands_base_roi_pct"] = round(_bp / _bi * 100, 2)   # 全期間のベタ買い（帯の比較相手）
        out["bands_base_bets"] = len(fav_all)

    bands = []
    for cut in (1.6, 2.0, 2.5, 3.0):
        by_month = {}
        inv = pay = hit = 0
        for row in fav_rows:
            if row["odds"] is None or row["odds"] >= cut:
                continue
            inv += 100
            pay += row["fuku"]
            if row["fuku"] > 0:
                hit += 1
            m = row["ymd"][:6]
            b = by_month.setdefault(m, [0, 0])
            b[0] += 100
            b[1] += row["fuku"]
        if inv < 100:
            continue
        n = inv // 100
        base = out.get("bands_base_roi_pct")
        months = [(v[1] / v[0] * 100) for v in by_month.values() if v[0] >= 2000]  # 20レース以上の月だけ
        above = sum(1 for r in months if base is not None and r > base)
        bands.append({
            "cut": cut,
            "label": f"1番人気の複勝を「単勝{cut}倍未満」のときだけ",
            "bets": n,
            "roi_pct": round(pay / inv * 100, 2),
            "hit_rate_pct": round(hit / n * 100, 2),
            "profit_jpy": pay - inv,
            "months_above_base": above,
            "months_total": len(months),
        })
    out["bands"] = bands
    # 85%の日（もどり85/80=1.0625倍）に乗せたらどうなるか。画面で計算させない。
    for b in bands:
        b["roi_pct_on_85day"] = round(b["roi_pct"] * 85 / 80, 2)
    return out


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
    # ものさし＝同じ期間を「何も考えず買った」場合。戦略が賭けた日の範囲で測る。
    # ⚠ 項目名は race_date（date ではない）。無ければ race_id の先頭8桁から取る。
    #   ここを間違えると「日付ゼロ件」になって ものさしが黙って消える（実際に一度そうなった）。
    def _ymd_of(e):
        # ⚠ race_date は "2026-06-13" のハイフン入り。数字だけ残してから8桁にする。
        #   ここを [:8] で切ると "2026-06-" になり、レースが1件も当たらず
        #   ものさしが黙って消える（実際に一度そうなった）。
        raw = str(e.get("race_date") or e.get("date") or "")
        d = "".join(ch for ch in raw if ch.isdigit())[:8]
        if len(d) == 8:
            return d
        rid = "".join(ch for ch in str(e.get("race_id") or "") if ch.isdigit())
        return rid[:8] if len(rid) >= 8 else ""
    dates = sorted({d for d in (_ymd_of(e) for e in log["entries"]) if d})
    yard = None
    if dates:
        try:
            yard = compute_yardstick(dates[0], dates[-1])
        except Exception as ex:
            print(f"[warn] ものさしの計算に失敗: {ex}")

    stats_doc = {
        "computed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "total_entries": len(log["entries"]),
        "resolved_entries": sum(1 for e in log["entries"] if e.get("result") is not None),
        "by_strategy": out,
        # 2026-08-12 追加: 比べる基準が無いと 79.9% が良いのか悪いのか分からない。
        "yardstick": yard,
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
