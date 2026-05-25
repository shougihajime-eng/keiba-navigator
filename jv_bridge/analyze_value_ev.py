# -*- coding: utf-8 -*-
"""
analyze_value_ev.py — value_ev_bets.json (ズルなし検証の per-bet キャッシュ) を
                      しらみつぶしにスライスし、回収率100%超のポケットを探す。
再学習不要・一瞬で多角的に分析する。
"""
from __future__ import annotations
import json, io, sys
from pathlib import Path
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CACHE = Path(__file__).resolve().parent.parent / "data" / "jv_cache"
recs = json.loads((CACHE / "value_ev_bets.json").read_text(encoding="utf-8"))
periods = sorted({r["period"] for r in recs})

# 各レースの nopop top1 馬番
best = {}
for r in recs:
    cur = best.get(r["rid"])
    if cur is None or r["p_nopop"] > cur[1]:
        best[r["rid"]] = (r["number"], r["p_nopop"])
top1 = {rid: num for rid, (num, _) in best.items()}


def roi(predicate, field="tan_pay"):
    by_p = {}
    inv = ret = bets = hits = 0
    for r in recs:
        if not predicate(r):
            continue
        pay = r[field]
        by_p.setdefault(r["period"], [0, 0])
        by_p[r["period"]][0] += 100
        by_p[r["period"]][1] += pay
        inv += 100; ret += pay; bets += 1
        if pay > 0: hits += 1
    prois = [round(v[1] / v[0] * 100, 1) for p, v in sorted(by_p.items()) if v[0]]
    return {
        "bets": bets, "hit_rate": round(hits / bets * 100, 1) if bets else None,
        "roi": round(ret / inv * 100, 2) if inv else None,
        "win_p": sum(1 for x in prois if x >= 100), "act_p": len(prois),
        "prois": prois,
    }


def show(title, rows):
    print(f"\n===== {title} =====")
    print(f"{'戦略':<46}{'回収率':>9}{'勝期間':>8}{'件数':>8}{'的中':>7}")
    print("-" * 86)
    for name, st in rows:
        if not st["bets"]:
            continue
        roi_s = f"{st['roi']:.1f}%" if st["roi"] is not None else "—"
        flag = " <<<" if (st["roi"] or 0) >= 100 and st["bets"] >= 80 else ""
        print(f"{name:<46}{roi_s:>9}{str(st['win_p'])+'/'+str(st['act_p']):>8}{st['bets']:>8}{(str(st['hit_rate'])+'%'):>7}{flag}")


# 1. 人気帯 × 単勝/複勝 (モデル top1 のみ)
rows = []
for lo, hi in [(1,1),(2,2),(3,3),(4,5),(6,9),(10,18),(2,4),(4,8)]:
    for field in ["tan_pay", "fuku_pay"]:
        bt = "単" if field=="tan_pay" else "複"
        rows.append((f"{bt}勝 モデルtop1 × 人気{lo}-{hi}",
                     (lambda lo,hi,f: lambda r: top1.get(r["rid"])==r["number"] and r["popularity"] and lo<=r["popularity"]<=hi)(lo,hi,field), ))
        rows[-1] = (rows[-1][0], roi(rows[-1][1], field))
show("人気帯 × モデルtop1 (単勝/複勝)", rows)

# 2. オッズ帯 × モデル top1
rows = []
for lo, hi in [(1.0,2.0),(2.0,3.5),(3.5,6.0),(6.0,10.0),(10.0,20.0),(20.0,50.0),(50.0,999.0)]:
    for field in ["tan_pay","fuku_pay"]:
        bt = "単" if field=="tan_pay" else "複"
        rows.append((f"{bt}勝 モデルtop1 × オッズ{lo:.0f}-{hi:.0f}倍", roi(
            (lambda lo,hi: lambda r: top1.get(r["rid"])==r["number"] and r["odds"] is not None and lo<=r["odds"]<hi)(lo,hi), field)))
show("オッズ帯 × モデルtop1 (単勝/複勝)", rows)

# 3. 市場との食い違い: モデルtop1 が 人気では mid 以下 (穴) = 価値あり?
rows = []
for popcut in [2,3,4,5,6]:
    rows.append((f"単勝 モデルtop1 かつ 人気>={popcut} (市場が軽視)", roi(
        (lambda pc: lambda r: top1.get(r["rid"])==r["number"] and r["popularity"] and r["popularity"]>=pc)(popcut))))
    rows.append((f"複勝 モデルtop1 かつ 人気>={popcut} (市場が軽視)", roi(
        (lambda pc: lambda r: top1.get(r["rid"])==r["number"] and r["popularity"] and r["popularity"]>=pc)(popcut), "fuku_pay")))
show("市場が軽視するモデル本命 (穴の価値)", rows)

# 4. EV 高 × 人気上位 (favorite で割安なものだけ)
rows = []
for th in [1.0,1.05,1.1,1.15,1.2]:
    for popmax in [1,2,3,4]:
        rows.append((f"単 EV>={th:.2f} 補正 × 人気<= {popmax}", roi(
            (lambda th,pm: lambda r: r["odds"] is not None and r["popularity"] and r["popularity"]<=pm and r["p_nopop"]*r["odds"]>=th)(th,popmax))))
show("人気上位の割安 (EV>=th & 人気<=N)", rows)

# 5. 生確率(補正前) top1 の確信度で絞る
rows = []
for conf in [0.15,0.20,0.25,0.30,0.35]:
    rows.append((f"単 モデルtop1 補正勝率>={conf:.2f}", roi(
        (lambda c: lambda r: top1.get(r["rid"])==r["number"] and r["p_nopop"]>=c)(conf))))
    rows.append((f"複 モデルtop1 補正勝率>={conf:.2f}", roi(
        (lambda c: lambda r: top1.get(r["rid"])==r["number"] and r["p_nopop"]>=c)(conf), "fuku_pay")))
show("モデルtop1 の確信度で絞る", rows)

print("\n[注] <<< は 回収率100%超 かつ 件数80以上 のポケット。期間別ROIも要確認。")
print("各期間数:", periods)
