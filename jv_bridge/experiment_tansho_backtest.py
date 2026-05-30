#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
experiment_tansho_backtest.py - 世の中の成功例(単勝)を過去データで再計算する

作戦A: 実力派AI(nopop)の一番手を単勝で買う。オッズ帯/確信度でしぼる。
作戦B: 勝率を4乗 -> 期待値 = prob^4 * odds。期待値1位と2位の差が閾値以上の
       レースだけ、期待値1位の馬を単勝で買う (hiyameshi方式)。

買い単位 100円。的中(rank==1)なら払戻 = 単勝配当(tan_pay)。
オッズは予想ファイルの win_odds (本物の確定オッズ) を使用。

注意: 予想は最終モデルで一括生成されているため厳密には時系列リークあり。
「作戦の見込み」を見る一次調査。月別ばらつきも併記する。
"""
import json
import sys
from pathlib import Path
from collections import defaultdict

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "jv_cache"
PRED = DATA / "predictions"
RESULTS = DATA / "results"
UNIT = 100


def parse_result(res):
    """戻り値: win(勝ち馬番), tan_pay(単勝配当/100円), odds_map(馬番->確定単勝オッズ)"""
    win = None
    odds_map = {}
    for r in (res.get("results") or []):
        n = r.get("number")
        if n is None:
            continue
        try:
            n = int(n)
        except (TypeError, ValueError):
            continue
        od = r.get("win_odds")
        if od is not None:
            try:
                odds_map[n] = float(od)
            except (TypeError, ValueError):
                pass
        if r.get("rank") == 1:
            win = n
    tan = ((res.get("payouts") or {}).get("tan") or {})
    try:
        tan_pay = int(tan.get("amount") or 0)
    except (TypeError, ValueError):
        tan_pay = 0
    if not tan_pay and win is not None and win in odds_map:
        tan_pay = int(round(odds_map[win] * 100))
    return win, tan_pay, odds_map


def load_joined():
    races = []
    for pf in sorted(PRED.glob("*.json")):
        rid = pf.stem
        rfile = RESULTS / f"{rid}.json"
        if not rfile.exists():
            continue
        try:
            pred = json.loads(pf.read_text(encoding="utf-8"))
            res = json.loads(rfile.read_text(encoding="utf-8"))
        except Exception:
            continue
        win, tan_pay, odds_map = parse_result(res)
        if win is None:
            continue
        horses = []
        for h in pred.get("horses", []):
            n = h.get("number")
            if n is None:
                continue
            try:
                n = int(n)
            except (TypeError, ValueError):
                continue
            od = odds_map.get(n)
            if od is None or od <= 1.0:
                continue
            horses.append({
                "number": n,
                "win_prob": float(h.get("win_prob") or 0.0),
                "nopop_prob": float(h.get("nopop_prob") or 0.0),
                "odds": od,
            })
        if len(horses) < 2:
            continue
        races.append({"rid": rid, "date": rid[:8], "win": win,
                      "tan_pay": tan_pay, "horses": horses})
    return races


def summarize(bets):
    inv = sum(b[0] for b in bets)
    ret = sum(b[1] for b in bets)
    hits = sum(1 for b in bets if b[2])
    n = len(bets)
    bym = defaultdict(lambda: [0, 0])
    for b in bets:
        bym[b[4]][0] += b[0]
        bym[b[4]][1] += b[1]
    monthly = {}
    win_months = 0
    for m in sorted(bym):
        i, r = bym[m]
        mroi = (r / i * 100) if i else 0.0
        monthly[m] = round(mroi, 1)
        if mroi >= 100:
            win_months += 1
    return {
        "bets": n,
        "roi_pct": round(ret / inv * 100, 1) if inv else 0.0,
        "hit_pct": round(hits / n * 100, 1) if n else 0.0,
        "avg_odds": round(sum(b[3] for b in bets) / n, 1) if n else 0.0,
        "months": len(bym),
        "win_months": win_months,
        "monthly_roi": monthly,
    }


def strat_A(races, prob_key="nopop_prob", odds_min=0.0, conf_min=0.0):
    bets = []
    for race in races:
        top = max(race["horses"], key=lambda h: h[prob_key])
        if top[prob_key] < conf_min or top["odds"] < odds_min:
            continue
        hit = (top["number"] == race["win"])
        ret = race["tan_pay"] if hit else 0
        bets.append((UNIT, ret, hit, top["odds"], race["date"][:6]))
    return summarize(bets)


def strat_B(races, prob_key="win_prob", power=4, gap_min=0.4):
    bets = []
    for race in races:
        ranked = sorted(
            race["horses"],
            key=lambda h: ((h[prob_key] ** power) * h["odds"], h["number"]),
            reverse=True,
        )
        h1 = ranked[0]
        ev1 = (h1[prob_key] ** power) * h1["odds"]
        ev2 = (ranked[1][prob_key] ** power) * ranked[1]["odds"]
        if (ev1 - ev2) < gap_min:
            continue
        hit = (h1["number"] == race["win"])
        ret = race["tan_pay"] if hit else 0
        bets.append((UNIT, ret, hit, h1["odds"], race["date"][:6]))
    return summarize(bets)


def line(label, s):
    print(f"[{label}] 回収率 {s['roi_pct']}% / 的中 {s['hit_pct']}% / "
          f"買い {s['bets']}回 / 平均オッズ {s['avg_odds']} / "
          f"勝月 {s['win_months']}/{s['months']}")


def main():
    races = load_joined()
    print(f"=== つないだレース数: {len(races)} ===\n")

    print("########## 作戦A: 実力派AI(nopop)一番手を単勝 ##########")
    line("全レース", strat_A(races, "nopop_prob"))
    line("オッズ5倍以上", strat_A(races, "nopop_prob", odds_min=5.0))
    line("オッズ10倍以上", strat_A(races, "nopop_prob", odds_min=10.0))
    line("オッズ20倍以上", strat_A(races, "nopop_prob", odds_min=20.0))
    line("確信度20%以上", strat_A(races, "nopop_prob", conf_min=0.20))
    line("確信度20%+オッズ5倍以上", strat_A(races, "nopop_prob", conf_min=0.20, odds_min=5.0))

    print("\n##### 参考: 普通AI(win_prob)一番手を単勝 #####")
    line("全レース", strat_A(races, "win_prob"))
    line("オッズ10倍以上", strat_A(races, "win_prob", odds_min=10.0))

    print("\n########## 作戦B: 勝率4乗・期待値差でしぼる単勝 ##########")
    for pk in ["win_prob", "nopop_prob"]:
        name = "普通AI" if pk == "win_prob" else "実力派AI"
        print(f"--- {name}({pk}) を4乗 ---")
        for gap in [0.2, 0.3, 0.4, 0.5]:
            s = strat_B(races, pk, 4, gap)
            print(f"  期待値差{gap}以上: 回収率 {s['roi_pct']}% / 的中 {s['hit_pct']}% / "
                  f"買い {s['bets']}回 / 平均オッズ {s['avg_odds']} / 勝月 {s['win_months']}/{s['months']}")

    print("\n########## 注目候補の月別回収率 ##########")
    print("作戦A 全レース  :", strat_A(races, "nopop_prob")["monthly_roi"])
    print("作戦B 期待値差0.4:", strat_B(races, "win_prob", 4, 0.4)["monthly_roi"])


if __name__ == "__main__":
    main()
