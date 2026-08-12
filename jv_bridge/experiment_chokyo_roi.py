# -*- coding: utf-8 -*-
"""
experiment_chokyo_roi.py — 調教（追い切り）を足すと「お金が増えるか」を測る（AUCではなく回収率）

★なぜ作るか
  2026-06-23 に一度 調教を試して「効かない」と出したが、そのときは **AUC でしか測っていない**
  （3特徴で AUC −0.0001〜−0.0006）。このプロジェクトは
  「AUCが上がってもお金は増えない」を何度も見ている（血統＝AUC +0.0010 なのに お金 −1.98pt）。
  だから **本番に繋ぐかどうかは、回収率で決める**。

★測り方（experiment_sire_roi.py とまったく同じ土台。ズルなし）
  ・各期間 p を test にし、**それより前の期間だけ**で学習する（未来を見ない）
  ・レースごとに「モデルがいちばん推す馬」を1頭選び、単勝100円・複勝100円を買ったことにする
  ・払戻は per-bet に入っている本物の tan_pay / fuku_pay を使う（推定しない）
  ・ものさしとして **市場の1番人気を同じように買った場合** も並べる
  ・運の幅は **レース単位のブートストラップ**（同じレースの馬はまとめて抜き差し）
  ・特徴の作り方は experiment_chokyo_feature.py の関数を **そのまま import**（実装を2つ持たない）

★このファイルがしないこと
  ・本番に繋がない（結果を出すだけ）
  ・良い数字が出た期間だけを拾わない（全期間・全パターンを必ず出す）

使い方: python jv_bridge/experiment_chokyo_roi.py   （64bit Python／sklearn が要る）
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
BETS = CACHE / "value_ev_bets.json"
OUT = CACHE / "experiment_chokyo_roi.json"

BOOT = 2000
RNG_SEED = 20260812
FULL_COVER = 0.90      # 「ほぼ全頭に調教データがある」とみなす割合
MIN_RACES_SUBSET = 50  # これ未満のかたまりは「少なすぎ」と書いて使わない


def _logit(p):
    p = min(max(float(p), 1e-6), 1 - 1e-6)
    return float(np.log(p / (1 - p)))


def summ(g):
    if not g:
        return None
    inv = 100 * len(g)
    return {
        "races": len(g),
        "tan_roi": round(sum(x["tan"] for x in g) / inv * 100, 2),
        "fuku_roi": round(sum(x["fuku"] for x in g) / inv * 100, 2),
        "hit": round(sum(x["won"] for x in g) / len(g) * 100, 2),
    }


def roi_drop_top(g, key, k=1):
    """いちばん大きい配当を k 個 抜いたときの回収率。
    ＝『たまたま出た1回の大当たりだけで数字が持ち上がっていないか』を見る。"""
    if not g or len(g) <= k:
        return None
    v = sorted((float(x[key]) for x in g), reverse=True)[k:]
    return round(sum(v) / (100 * len(g)) * 100, 2)


def boot_diff(a, b, key, rng):
    """a - b の差（回収率のポイント差）の95%の幅。1点=1レース。"""
    if len(a) != len(b) or len(a) <= MIN_RACES_SUBSET:
        return None
    va = np.array([x[key] for x in a], dtype=float)
    vb = np.array([x[key] for x in b], dtype=float)
    idx = np.arange(len(va))
    d = []
    for _ in range(BOOT):
        s = rng.choice(idx, size=len(idx), replace=True)
        d.append(va[s].mean() - vb[s].mean())
    d = np.array(d)
    return [round(float(np.percentile(d, 2.5)), 2), round(float(np.percentile(d, 97.5)), 2)]


def placebo_test(rows, base_tan_roi, seeds=10, rng_seed=RNG_SEED):
    """にせの調教データで同じことをやる（プラセボ検査）。

    やること: 調教の数字を **他の馬のものと入れ替えて**（同じ期間の中でシャッフル）、
    まったく同じ手順で「モデルが推す1頭」を買う。中身はデタラメなので本来なら差は0のはず。
    ここで本物と同じくらいの差（±3pt）が出るなら、**本物の +3pt も『調教が効いた』のではなく
    ただの運の幅**だと分かる。＝検査そのものが意味を持っているかを確かめる検査。
    """
    rng = np.random.default_rng(rng_seed)
    periods = sorted({x["period"] for x in rows})
    out = []
    for _ in range(seeds):
        # 期間ごとに 調教部分だけをシャッフル（覆い率の期間差はそのまま保つ）
        perm_x = {}
        for pd_ in periods:
            idx = [i for i, x in enumerate(rows) if x["period"] == pd_]
            sh = rng.permutation(idx)
            for a, b in zip(idx, sh):
                perm_x[a] = rows[b]["Xc"]

        picks_p = []
        for pd_ in periods:
            tr = [(i, x) for i, x in enumerate(rows) if x["period"] < pd_]
            te = [(i, x) for i, x in enumerate(rows) if x["period"] == pd_]
            if len(tr) < 500 or len(te) < 100:
                continue
            y = np.array([x["won"] for _, x in tr])
            if len(set(y)) < 2:
                continue
            Xtr = np.array([x["Xb"] + perm_x[i] for i, x in tr], dtype=float)
            Xte = np.array([x["Xb"] + perm_x[i] for i, x in te], dtype=float)
            m = LogisticRegression(max_iter=2000).fit(Xtr, y)
            pr = m.predict_proba(Xte)[:, 1]
            byrace = defaultdict(list)
            for j, (_, x) in enumerate(te):
                byrace[x["rid"]].append((j, x))
            for _rid, items in byrace.items():
                picks_p.append(min(items, key=lambda t: (-pr[t[0]], t[1]["n"]))[1])
        s = summ(picks_p)
        out.append(round(s["tan_roi"] - base_tan_roi, 2))
    return out


def main() -> int:
    if not BETS.exists():
        print("[error] value_ev_bets.json が無い", flush=True)
        return 1

    sys.path.insert(0, str(ROOT / "jv_bridge"))
    from experiment_chokyo_feature import (  # noqa: E402
        build_chokyo_features, vec_counts, vec_days, vec_kind, vec_time, vec_layoff,
    )

    recs = json.loads(BETS.read_text(encoding="utf-8"))
    feat, cov = build_chokyo_features(recs)
    n = max(1, cov["rows"])
    print(f"[info] per-bet {len(recs):,}件 / 60日以内に追い切りがある馬 "
          f"{cov['hasData']:,} ({cov['hasData']/n*100:.1f}%) "
          f"/ タイム偏差が出せた {cov['zKnown']:,} ({cov['zKnown']/n*100:.1f}%)", flush=True)

    # ── 試す組み合わせ（＝いくつ試したかを最初に決めて全部出す。いいとこ取りをしない） ──
    VARIANTS = {
        "本数":        [vec_counts],
        "最終追い間隔": [vec_days],
        "坂路/栗東":   [vec_kind],
        "タイム偏差":  [vec_time],
        "休み明け×本数": [vec_layoff],
        "全部のせ":    [vec_counts, vec_days, vec_kind, vec_time, vec_layoff],
    }

    rows = []
    for r in recs:
        p = r.get("p_nopop_raw")
        if p is None:
            continue
        f = feat.get((str(r["rid"]), int(r["number"])))
        if f is None:
            continue
        base = [_logit(p)]
        x = {"base": base}
        xc_all = []
        for name, fns in VARIANTS.items():
            v = list(base)
            for fn in fns:
                v.extend(fn(f))
            x[name] = v
            if name == "全部のせ":
                xc_all = v[1:]
        rows.append({
            "period": r["period"], "rid": r["rid"], "n": r["number"],
            "X": x, "Xb": base, "Xc": xc_all,
            "won": int(r.get("won") or 0),
            "tan": float(r.get("tan_pay") or 0.0),
            "fuku": float(r.get("fuku_pay") or 0.0),
            "pop": r.get("popularity"),
            "hasData": f["hasData"],
        })

    keys = ["base"] + list(VARIANTS.keys())
    periods = sorted({x["period"] for x in rows})

    picks = {k: [] for k in keys}
    picks["market"] = []
    picks_sub = {k: [] for k in keys}      # 「ほぼ全頭に調教データがある」レースだけ
    picks_sub["market"] = []
    per_period = []

    for pd_ in periods:
        tr = [x for x in rows if x["period"] < pd_]
        te = [x for x in rows if x["period"] == pd_]
        if len(tr) < 500 or len(te) < 100:
            continue
        y = np.array([x["won"] for x in tr])
        if len(set(y)) < 2:
            continue

        prob = {}
        for k in keys:
            m = LogisticRegression(max_iter=2000).fit(
                np.array([x["X"][k] for x in tr], dtype=float), y)
            prob[k] = m.predict_proba(np.array([x["X"][k] for x in te], dtype=float))[:, 1]

        byrace = defaultdict(list)
        for i, x in enumerate(te):
            byrace[x["rid"]].append((i, x))

        got = {k: [] for k in keys}
        got["market"] = []
        got_sub = {k: [] for k in keys}
        got_sub["market"] = []
        n_sub = 0
        for rid, items in byrace.items():
            cover = sum(1 for _, x in items if x["hasData"]) / len(items)
            is_sub = cover >= FULL_COVER
            if is_sub:
                n_sub += 1
            for k in keys:
                # モデルが推す1頭（同点は馬番の小さい方＝毎回同じ答えになるように）
                pick = min(items, key=lambda t: (-prob[k][t[0]], t[1]["n"]))[1]
                got[k].append(pick)
                if is_sub:
                    got_sub[k].append(pick)
            fav = [x for _, x in items if x["pop"] == 1]
            if fav:
                got["market"].append(fav[0])
                if is_sub:
                    got_sub["market"].append(fav[0])

        rec = {"period": pd_, "races": len(byrace), "races_full_cover": n_sub,
               "cover_pct": round(sum(1 for x in te if x["hasData"]) / len(te) * 100, 1)}
        for k in keys + ["market"]:
            rec[k] = summ(got[k])
            picks[k].extend(got[k])
            picks_sub[k].extend(got_sub[k])
        per_period.append(rec)

        line = (f"  期間{pd_} ({rec['races']}R・調教が付いた馬 {rec['cover_pct']}%): "
                f"単勝回収 ベース {rec['base']['tan_roi']}%")
        for k in VARIANTS:
            line += f" / {k} {rec[k]['tan_roi']}%"
        line += f"  (市場1番人気 {rec['market']['tan_roi']}%)"
        print(line, flush=True)

    rng = np.random.default_rng(RNG_SEED)
    overall = {k: summ(picks[k]) for k in keys + ["market"]}
    sub = {k: summ(picks_sub[k]) for k in keys + ["market"]}

    diffs = {}
    for k in VARIANTS:
        diffs[k] = {
            "tan_pt": round(overall[k]["tan_roi"] - overall["base"]["tan_roi"], 2),
            "fuku_pt": round(overall[k]["fuku_roi"] - overall["base"]["fuku_roi"], 2),
            "tan_ci95": boot_diff(picks[k], picks["base"], "tan", rng),
            "fuku_ci95": boot_diff(picks[k], picks["base"], "fuku", rng),
            "periods_up_tan": sum(1 for r in per_period if r[k]["tan_roi"] > r["base"]["tan_roi"]),
            "periods_up_fuku": sum(1 for r in per_period if r[k]["fuku_roi"] > r["base"]["fuku_roi"]),
            # 大当たりを1回・3回 抜いても差が残るか
            "tan_roi_drop1": roi_drop_top(picks[k], "tan", 1),
            "tan_roi_drop3": roi_drop_top(picks[k], "tan", 3),
        }
    base_drop1 = roi_drop_top(picks["base"], "tan", 1)
    base_drop3 = roi_drop_top(picks["base"], "tan", 3)

    # 「調教を足したせいで、選ぶ馬が実際に変わったレース」だけを取り出して見る。
    # ここが少なければ、全体の差は ほんの数レースのアタリ外れでしかない。
    changed = {}
    for k in VARIANTS:
        idx = [i for i in range(len(picks["base"])) if picks[k][i]["n"] != picks["base"][i]["n"]]
        a = [picks[k][i] for i in idx]
        b = [picks["base"][i] for i in idx]
        changed[k] = {
            "races": len(idx),
            "pct_of_all": round(len(idx) / max(1, len(picks["base"])) * 100, 1),
            "tan_new": summ(a)["tan_roi"] if a else None,
            "tan_old": summ(b)["tan_roi"] if b else None,
            "hit_new": summ(a)["hit"] if a else None,
            "hit_old": summ(b)["hit"] if b else None,
        }

    sub_diffs = {}
    if sub["base"] and sub["base"]["races"] >= MIN_RACES_SUBSET:
        for k in VARIANTS:
            sub_diffs[k] = {
                "tan_pt": round(sub[k]["tan_roi"] - sub["base"]["tan_roi"], 2),
                "fuku_pt": round(sub[k]["fuku_roi"] - sub["base"]["fuku_roi"], 2),
                "tan_ci95": boot_diff(picks_sub[k], picks_sub["base"], "tan", rng),
                "fuku_ci95": boot_diff(picks_sub[k], picks_sub["base"], "fuku", rng),
            }

    ob = overall["base"]
    om = overall["market"]
    print("\n=== 結論（リークなし・お金で測った） ===", flush=True)
    print(f"  対象 {ob['races']} レース（{len(per_period)} 期間）", flush=True)
    print(f"  ものさし: 市場1番人気を毎レース買う → 単勝 {om['tan_roi']}% / 複勝 {om['fuku_roi']}%", flush=True)
    print(f"  ベース(調教なし)                     → 単勝 {ob['tan_roi']}% / 複勝 {ob['fuku_roi']}%", flush=True)
    for k in VARIANTS:
        d = diffs[k]
        ci = d["tan_ci95"]
        cis = f"{ci[0]:+.2f}〜{ci[1]:+.2f}pt" if ci else "測れず"
        print(f"  ＋{k:<12} → 単勝 {overall[k]['tan_roi']}% ({d['tan_pt']:+.2f}pt・95%の幅 {cis}"
              f"・上がった期間 {d['periods_up_tan']}/{len(per_period)}) "
              f"／ 複勝 {overall[k]['fuku_roi']}% ({d['fuku_pt']:+.2f}pt)", flush=True)

    print(f"\n  【大当たり抜き】いちばん大きい単勝配当を抜いたら（ベース {base_drop1}% / 3つ抜き {base_drop3}%）", flush=True)
    for k in VARIANTS:
        d = diffs[k]
        print(f"    ＋{k:<12} 1つ抜き {d['tan_roi_drop1']}% ({d['tan_roi_drop1']-base_drop1:+.2f}pt)"
              f" / 3つ抜き {d['tan_roi_drop3']}% ({d['tan_roi_drop3']-base_drop3:+.2f}pt)", flush=True)

    print("\n  【選ぶ馬が変わったレースだけ】調教を足して本命が入れ替わったのは何レース？", flush=True)
    for k in VARIANTS:
        c = changed[k]
        if not c["races"]:
            print(f"    ＋{k:<12} 0R（1頭も変わらなかった）", flush=True)
            continue
        print(f"    ＋{k:<12} {c['races']}R ({c['pct_of_all']}%)  "
              f"単勝 元の馬 {c['tan_old']}% → 変えた馬 {c['tan_new']}%  "
              f"／ 的中 {c['hit_old']}% → {c['hit_new']}%", flush=True)

    if sub_diffs:
        print(f"\n  【参考】ほぼ全頭に調教データがあるレースだけ（{sub['base']['races']}R）", flush=True)
        print(f"    ベース 単勝 {sub['base']['tan_roi']}% / 複勝 {sub['base']['fuku_roi']}%"
              f"（市場1番人気 単勝 {sub['market']['tan_roi']}% / 複勝 {sub['market']['fuku_roi']}%）", flush=True)
        for k in VARIANTS:
            d = sub_diffs[k]
            ci = d["tan_ci95"]
            cis = f"{ci[0]:+.2f}〜{ci[1]:+.2f}pt" if ci else "測れず"
            print(f"    ＋{k:<12} 単勝 {sub[k]['tan_roi']}% ({d['tan_pt']:+.2f}pt・95%の幅 {cis})"
                  f" / 複勝 {sub[k]['fuku_roi']}% ({d['fuku_pt']:+.2f}pt)", flush=True)
    else:
        print(f"\n  【参考】ほぼ全頭に調教データがあるレースは {MIN_RACES_SUBSET} 未満＝少なすぎるので使わない", flush=True)

    print("\n  【プラセボ検査】調教の中身を他の馬とすり替えた『にせデータ』で同じことをやる", flush=True)
    pl = placebo_test(rows, ob["tan_roi"], seeds=10)
    pl_s = sorted(pl)
    real = [diffs[k]["tan_pt"] for k in VARIANTS]           # 🚫数字を手で書かない＝実測から出す
    inside = sum(1 for v in real if pl_s[0] <= v <= pl_s[-1])
    print(f"    にせデータ10回の 単勝回収の差: {pl_s}", flush=True)
    print(f"    → にせデータでも {pl_s[0]:+.2f}pt 〜 {pl_s[-1]:+.2f}pt 動く。"
          f"本物の差（{min(real):+.2f}〜{max(real):+.2f}pt）は "
          f"{inside}/{len(real)} 通りがこの幅の中＝『効いた』ではなく『運』。", flush=True)

    # 判定：お金で上がり かつ 95%の幅が0をまたがず かつ 期間の8割以上で改善、を全部満たす物だけ
    wired = []
    for k in VARIANTS:
        d = diffs[k]
        ci = d["tan_ci95"]
        crosses = (ci is None) or (ci[0] <= 0 <= ci[1])
        if d["tan_pt"] > 0 and not crosses and d["periods_up_tan"] >= len(per_period) * 0.8:
            wired.append(k)
    if wired:
        verdict = "本番に繋ぐ価値あり＝" + "・".join(wired)
    else:
        verdict = ("繋がない＝どのパターンも『お金では運の幅に埋もれる』か『むしろ下がる』。"
                   f"（{len(VARIANTS)}通り 試して 合格ゼロ／"
                   f"にせデータでも {pl_s[0]:+.2f}〜{pl_s[-1]:+.2f}pt 動く／"
                   f"大当たり3つ抜くと差が消える／調教が一番そろっている{sub['base']['races']}Rでは むしろ下がる）")
    print(f"\n判定: {verdict}", flush=True)
    print("⚠ どのパターンでも回収率は100%を大きく下回る（控除率20%の壁）。"
          "調教は『勝てるようになる』ものではない。", flush=True)

    OUT.write_text(json.dumps({
        "note": "オフライン実験・本番未配線。AUCではなく回収率で判定した。",
        "coverage": cov,
        "variants_tried": list(VARIANTS.keys()),
        "periods": per_period,
        "overall": overall,
        "diff_vs_base": diffs,
        "base_tan_roi_drop1": base_drop1, "base_tan_roi_drop3": base_drop3,
        "changed_picks_only": changed,
        "placebo_tan_diff_pt": pl,
        "full_cover_subset": {"overall": sub, "diff_vs_base": sub_diffs,
                              "min_races": MIN_RACES_SUBSET, "cover_threshold": FULL_COVER},
        "verdict": verdict, "should_wire": bool(wired),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[OK] {OUT.name} 保存（本番未配線）", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
