# -*- coding: utf-8 -*-
"""
experiment_favlongshot.py — 総当たりで浮かんだ唯一の候補
「本命(オッズの安い馬)の複勝だけ買う」を、1つの仮説として厳しく調べる（本番未配線）

★なぜ別ファイルにするか
  総当たり(experiment_simple_rules.py・7,231通り)の生き残りは、ほぼ全部が
  「オッズの安い馬の複勝」だった。これは **人気馬・穴馬のゆがみ（favourite-longshot bias）**
  ＝世界中の競馬で100年前から何度も確かめられている、教科書に載っている現象と同じ形。
  つまり「7,231通り試して1つ当たった幻」ではなく、**外部の知識と一致する1つの仮説**として
  検定し直せる（＝多重比較の罰を受けずに済む唯一の道）。

★それでも疑ってかかる。調べること
  1. 単調か     … オッズが上がるほど回収率が下がるか（ガタガタなら偶然のデコボコ）
  2. 崖ではないか… 「2.0倍で切る」だけが良いのか、1.5〜3.0倍のどこで切っても良いのか
  3. 期間       … 前半4期間で決めて、後半2期間（見ていない）でも同じか
  4. 運の幅     … レース単位ブートストラップの95%の幅
  5. 大当たり   … いちばん大きい配当を抜いても残るか
  6. 天井       … そもそも100%に届きうるのか（＝儲かるのか）

★正直に書くこと
  ・オッズは「最終オッズ」＝締切後に確定する。実際に買うときは締切数分前の
    オッズを見るので、境目(2.0倍ちょうど付近)の馬は入れ替わりうる。
    → だから「切る場所を変えても結果が変わらないか」を必ず確かめる。
  ・ものさし(1番人気の複勝ベタ買い)も同じ最終オッズで1番人気を決めている＝同じ土俵。

使い方: python jv_bridge/experiment_favlongshot.py
"""
from __future__ import annotations

import io
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

os.environ["PYTHONIOENCODING"] = "utf-8"
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
BETS = CACHE / "value_ev_bets.json"
OUT = CACHE / "experiment_favlongshot.json"

YARDSTICK = 84.9
BOOT = 20000
SEED = 20260812
DISCOVERY = (1, 2, 3, 4)
CONFIRM = (5, 6)


def load_races():
    recs = json.loads(BETS.read_text(encoding="utf-8"))
    byrace = defaultdict(list)
    for r in recs:
        byrace[r["rid"]].append(r)
    races = []
    for rid in sorted(byrace):
        bets = byrace[rid]
        races.append({"rid": rid, "period": bets[0]["period"], "bets": bets})
    return races


def boot_ci(stake, pay, rng, b=BOOT):
    """レース単位ブートストラップ（1レース=1つのかたまりとして抜き差し）"""
    n = len(stake)
    if n == 0 or stake.sum() <= 0:
        return None, None
    out = np.empty(b, dtype=np.float64)
    CH = 2000
    for a in range(0, b, CH):
        e = min(a + CH, b)
        C = rng.multinomial(n, np.full(n, 1.0 / n), size=(e - a)).T.astype(np.float64)
        s = stake @ C
        p = pay @ C
        with np.errstate(divide="ignore", invalid="ignore"):
            out[a:e] = np.where(s > 0, p / s * 100.0, np.nan)
    return float(np.nanpercentile(out, 2.5)), float(np.nanpercentile(out, 97.5))


def series(races, pick, kind="fuku"):
    """pick(bets)->買う馬のリスト。レースごとの (賭け金, 払戻, 期間, 最大配当) を返す"""
    st, pa, pe = [], [], []
    mx = 0.0
    for R in races:
        hs = pick(R["bets"])
        if not hs:
            continue
        s = 100.0 * len(hs)
        p = sum(float(h[f"{kind}_pay"] or 0.0) for h in hs)
        for h in hs:
            mx = max(mx, float(h[f"{kind}_pay"] or 0.0))
        st.append(s)
        pa.append(p)
        pe.append(R["period"])
    return np.array(st), np.array(pa), np.array(pe), mx


def roi(st, pa):
    return float(pa.sum() / st.sum() * 100.0) if st.sum() > 0 else float("nan")


def evaluate(name, races, pick, rng, kind="fuku"):
    st, pa, pe, mx = series(races, pick, kind)
    if st.sum() <= 0:
        return None
    r = roi(st, pa)
    lo, hi = boot_ci(st, pa, rng)
    # 大当たり1本抜き
    drop = float((pa.sum() - mx) / max(st.sum() - 100, 1e-9) * 100.0)
    perp = {}
    for p in sorted(set(pe.tolist())):
        m = pe == p
        perp[int(p)] = round(roi(st[m], pa[m]), 1)
    dm = np.isin(pe, DISCOVERY)
    cm = np.isin(pe, CONFIRM)
    hits = int(sum(1 for x in pa if x > 0))
    return {
        "name": name, "bets": int(st.sum() / 100), "races": len(st),
        "roi": round(r, 2), "ci95": [round(lo, 2), round(hi, 2)],
        "hit_pct": round(hits / len(st) * 100, 1),
        "drop_top_hit_roi": round(drop, 2),
        "period_roi": perp,
        "periods_over_yardstick": sum(1 for v in perp.values() if v > YARDSTICK),
        "periods_total": len(perp),
        "discovery_roi": round(roi(st[dm], pa[dm]), 2) if st[dm].sum() > 0 else None,
        "discovery_bets": int(st[dm].sum() / 100),
        "confirm_roi": round(roi(st[cm], pa[cm]), 2) if st[cm].sum() > 0 else None,
        "confirm_bets": int(st[cm].sum() / 100),
        "gate2": bool(st.sum() / 100 >= 200),
        "gate3": bool(r > YARDSTICK),
        "gate4": bool(lo > YARDSTICK),
        "gate5": bool(drop > YARDSTICK),
        "gate6": bool(sum(1 for v in perp.values() if v > YARDSTICK) >= len(perp) - 1),
        "gate7": bool(st[cm].sum() / 100 >= 50 and roi(st[cm], pa[cm]) > YARDSTICK),
    }


def fav_under(cut):
    def f(bets):
        h = [b for b in bets if b.get("popularity") == 1 and b.get("odds") is not None
             and b["odds"] < cut]
        return h[:1]
    return f


def main() -> int:
    races = load_races()
    rng = np.random.default_rng(SEED)
    print(f"[info] {len(races)} レース（{races[0]['rid'][:8]} 〜 {races[-1]['rid'][:8]}）", flush=True)
    W = 100

    # ---------------------------------------------------------------
    # 1. 単調か（オッズが上がるほど回収率が下がるか）
    # ---------------------------------------------------------------
    print("\n" + "=" * W)
    print("① 1番人気の複勝を、その馬の単勝オッズで分けると（単調に下がるか？）")
    print("=" * W)
    bands = [(1.0, 1.6), (1.6, 2.0), (2.0, 2.5), (2.5, 3.0), (3.0, 4.0), (4.0, 99.0)]
    print(f"{'単勝オッズ':<12}{'件数':>7}{'複勝回収率':>11}{'95%の幅':>18}{'的中':>8}{'平均配当':>9}")
    print("-" * W)
    ladder = []
    for lo, hi in bands:
        pick = (lambda lo, hi: lambda bets: [b for b in bets if b.get("popularity") == 1
                                             and b.get("odds") is not None and lo <= b["odds"] < hi][:1])(lo, hi)
        st, pa, pe, _ = series(races, pick)
        if st.sum() <= 0:
            continue
        r = roi(st, pa)
        cl, ch = boot_ci(st, pa, rng, 4000)
        hits = int(sum(1 for x in pa if x > 0))
        ladder.append({"band": f"{lo:g}-{hi:g}", "n": len(st), "roi": round(r, 2),
                       "ci95": [round(cl, 1), round(ch, 1)],
                       "hit": round(hits / len(st) * 100, 1),
                       "avg_pay": round(float(pa.sum() / max(hits, 1)))})
        print(f"{f'{lo:g}〜{hi:g}倍':<12}{len(st):>7}{r:>10.1f}%{f'[{cl:.0f}〜{ch:.0f}]':>18}"
              f"{hits/len(st)*100:>7.1f}%{pa.sum()/max(hits,1):>8.0f}円")

    # 単調さの検定：1頭ごとの「回収(円)」を log(オッズ) に回帰した傾き
    xs, ys, rid_of = [], [], []
    for R in races:
        f = [b for b in R["bets"] if b.get("popularity") == 1 and b.get("odds") is not None]
        if not f:
            continue
        xs.append(np.log(f[0]["odds"]))
        ys.append(float(f[0]["fuku_pay"] or 0.0))
        rid_of.append(R["rid"])
    xs = np.array(xs)
    ys = np.array(ys)
    slope = float(np.polyfit(xs, ys, 1)[0])
    bs = []
    for _ in range(4000):
        idx = rng.integers(0, len(xs), len(xs))
        bs.append(float(np.polyfit(xs[idx], ys[idx], 1)[0]))
    bs = np.array(bs)
    slo, shi = float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))
    print(f"\n  傾き（オッズが e 倍になるごとの1点あたり回収の変化）= {slope:+.1f}円"
          f"  95%の幅 [{slo:+.1f} 〜 {shi:+.1f}]")
    print(f"  → {'オッズが上がるほど確実に損が増える＝単調（本物の形）' if shi < 0 else '0をまたぐ＝単調とは言えない'}")

    # ---------------------------------------------------------------
    # 2. 崖ではないか（切る場所を動かしても同じか）
    # ---------------------------------------------------------------
    print("\n" + "=" * W)
    print("② 切る場所を動かしてみる（1か所だけ良い＝崖 なら、それは偶然のデコボコ）")
    print("=" * W)
    print(f"{'単勝オッズ<':<12}{'件数':>7}{'回収率':>9}{'95%下限':>10}{'前半':>9}{'後半':>9}")
    print("-" * W)
    sweep = []
    for cut in [1.6, 1.8, 2.0, 2.2, 2.5, 2.8, 3.0, 3.5, 4.0]:
        e = evaluate(f"1番人気の複勝／単勝{cut}倍未満", races, fav_under(cut), rng)
        if not e:
            continue
        sweep.append({**e, "cut": cut})
        print(f"{f'{cut:g}倍未満':<12}{e['bets']:>7}{e['roi']:>8.1f}%{e['ci95'][0]:>9.1f}%"
              f"{(str(e['discovery_roi'])+'%'):>9}{(str(e['confirm_roi'])+'%'):>9}")

    # ---------------------------------------------------------------
    # 3. 主な候補を7つの関門にかける
    # ---------------------------------------------------------------
    print("\n" + "=" * W)
    print("③ 候補を関門にかける（ものさし = 1番人気の複勝ベタ買い 84.9%）")
    print("=" * W)
    cands = [
        ("A ものさし：1番人気の複勝を全部買う",
         lambda bets: [b for b in bets if b.get("popularity") == 1][:1], "fuku"),
        ("B 1番人気の複勝／単勝2.0倍未満のときだけ", fav_under(2.0), "fuku"),
        ("C 1番人気の複勝／単勝2.5倍未満のときだけ", fav_under(2.5), "fuku"),
        ("D 1番人気の複勝／単勝3.0倍未満のときだけ", fav_under(3.0), "fuku"),
        ("E 単勝2.0倍未満の馬の複勝（人気は問わない）",
         lambda bets: [b for b in bets if b.get("odds") is not None and b["odds"] < 2.0], "fuku"),
        ("F 単勝1.6倍未満の馬の複勝（人気は問わない）",
         lambda bets: [b for b in bets if b.get("odds") is not None and b["odds"] < 1.6], "fuku"),
        ("G 1番人気の単勝を全部買う",
         lambda bets: [b for b in bets if b.get("popularity") == 1][:1], "tan"),
        ("H 1番人気の単勝／単勝2.0倍未満のときだけ", fav_under(2.0), "tan"),
    ]
    results = []
    print(f"{'候補':<40}{'件数':>7}{'回収率':>9}{'95%の幅':>17}{'大当抜':>8}{'関門':>6}")
    print("-" * W)
    for nm, pk, kind in cands:
        e = evaluate(nm, races, pk, rng, kind)
        if not e:
            continue
        g = sum(1 for k in ("gate2", "gate3", "gate4", "gate5", "gate6", "gate7") if e[k])
        e["gates_passed"] = g
        e["all_gates"] = g == 6
        results.append(e)
        ci = f"[{e['ci95'][0]:.0f}〜{e['ci95'][1]:.0f}]"
        print(f"{nm[:40]:<40}{e['bets']:>7}{e['roi']:>8.1f}%{ci:>17}"
              f"{e['drop_top_hit_roi']:>7.1f}%{f'{g}/6':>6}")

    print("\n  ▼ くわしく（期間べつ・前半後半）")
    for e in results:
        pr = " ".join(f"{k}:{v}%" for k, v in e["period_roi"].items())
        print(f"  {e['name']}")
        print(f"     期間べつ {pr}")
        print(f"     前半4期間 {e['discovery_roi']}%(n={e['discovery_bets']}) → "
              f"後半2期間 {e['confirm_roi']}%(n={e['confirm_bets']})   関門 "
              f"2:{'○' if e['gate2'] else '×'} 3:{'○' if e['gate3'] else '×'} "
              f"4:{'○' if e['gate4'] else '×'} 5:{'○' if e['gate5'] else '×'} "
              f"6:{'○' if e['gate6'] else '×'} 7:{'○' if e['gate7'] else '×'}")

    # ---------------------------------------------------------------
    # 4. 天井（そもそも100%に届くのか）
    # ---------------------------------------------------------------
    print("\n" + "=" * W)
    print("④ 天井のしらべ：どんなに本命に絞っても100%に届かない理由")
    print("=" * W)
    allf = [b for R in races for b in R["bets"]
            if b.get("popularity") == 1 and b.get("odds") is not None]
    for lo, hi in [(1.0, 1.3), (1.3, 1.6), (1.6, 2.0)]:
        v = [b for b in allf if lo <= b["odds"] < hi]
        hitp = [float(b["fuku_pay"]) for b in v if (b["fuku_pay"] or 0) > 0]
        if not v:
            continue
        n100 = sum(1 for x in hitp if x <= 100)
        print(f"  単勝{lo:g}〜{hi:g}倍の1番人気 {len(v):>4}件： 的中 {len(hitp)/len(v)*100:.1f}% ／ "
              f"当たったときの平均配当 {np.mean(hitp):.0f}円 ／ "
              f"そのうち「100円ちょうど(元返し)」が {n100/max(1,len(hitp))*100:.0f}%")
    print("  ＝ 複勝の払戻には「100円より下は無い」という下限があるので、"
          "当たっても増えない当たりが積み上がる。")
    print("  ＝ 的中率をいくら上げても、控除率20%ぶんを取り返す配当がそこに無い。")

    # ---------------------------------------------------------------
    # 5. 見送りの効果（お金でいくら変わるか）
    # ---------------------------------------------------------------
    print("\n" + "=" * W)
    print("⑤「見送り」でお金はどう変わるか（1年ぶん・実データ 3,656レース）")
    print("=" * W)
    base = [e for e in results if e["name"].startswith("A ")][0]
    print(f"{'買い方':<44}{'買う回数':>9}{'使う額':>10}{'手元に残る':>11}{'損':>10}")
    print("-" * W)
    for e in results:
        if not e["name"][0] in "ABCDEF":
            continue
        inv = e["bets"] * 100
        ret = inv * e["roi"] / 100
        print(f"{e['name'][:44]:<44}{e['bets']:>9}{inv:>10,}{ret:>11,.0f}{ret-inv:>10,.0f}")
    print(f"{'（そもそも買わない）':<44}{0:>9}{0:>10,}{0:>11,}{0:>10,}")
    print(f"\n  ものさしの損 {base['bets']*100*(1-base['roi']/100):,.0f}円 → "
          f"いちばん絞った候補でも損は残る。損が減るのは「回収率が上がったから」より"
          f"「買う回数が減ったから」の割合が大きい。")

    payload = {
        "note": "オフライン実験・本番未配線。総当たりの唯一の候補（人気馬・穴馬のゆがみ）を1仮説として検定した。",
        "races": len(races), "yardstick": YARDSTICK, "bootstrap": BOOT, "seed": SEED,
        "ladder_fav_fuku_by_odds": ladder,
        "monotonic_slope_yen_per_log_odds": round(slope, 2),
        "monotonic_slope_ci95": [round(slo, 2), round(shi, 2)],
        "cut_sweep": sweep,
        "candidates": results,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[OK] {OUT.name} 保存（本番未配線）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
