# -*- coding: utf-8 -*-
"""
experiment_sire_roi.py — 血統を足すと「お金が増えるか」を測る（AUCではなく回収率）

★なぜ作るか
  experiment_sire_feature.py は AUC（当てる力）で測って +0.0010・5期間中5期間で改善と出た。
  でもこのプロジェクトは **「AUCが上がってもROIは上がらない」を何度も見ている**：
    ・Wave25 で Optuna が valid AUC を +1.16% 上げたのに、Walk-forward で全戦略100%割れ
    ・Wave26-B/27 も AUC ではなく実 ROI で選び直して初めて本物が見つかった
  だから **本番に繋ぐかどうかは、回収率で決める**。

★測り方（リークなし・ズルなし）
  ・各期間 p を test にし、**それより前の期間だけ**で学習する（未来を見ない）
  ・レースごとに「モデルがいちばん推す馬」を1頭選び、単勝100円・複勝100円を買ったことにする
  ・払戻は per-bet に入っている本物の tan_pay / fuku_pay を使う（推定しない）
  ・ものさしとして **市場の1番人気を同じように買った場合** も並べる
  ・運の幅は **レース単位のブートストラップ**（同じレースの馬はまとめて抜き差し）で出す
    ＝1頭ずつ抜き差しすると「同じレースの中で相関している」のを無視して幅が狭く出る

★このファイルがしないこと
  ・本番に繋がない（結果を出すだけ）
  ・良い数字が出た期間だけを拾わない（全期間を必ず出す）

使い方: python jv_bridge/experiment_sire_roi.py   （64bit Python／sklearn が要る）
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
SIRE_MAP = CACHE / "sire_map.json"
OUT = CACHE / "experiment_sire_roi.json"

BOOT = 2000          # ブートストラップの回数
RNG_SEED = 20260812  # 毎回同じ答えが出るように固定


def _load(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _logit(p):
    p = min(max(float(p), 1e-6), 1 - 1e-6)
    return float(np.log(p / (1 - p)))


def main() -> int:
    if not BETS.exists() or not SIRE_MAP.exists():
        print("[error] value_ev_bets.json か sire_map.json が無い", flush=True)
        return 1

    # 血統の特徴は experiment_sire_feature.py と**まったく同じ関数**を使う。
    # 🚨 ここで作り直すと「同じはず」の実装が2つになり、必ずズレる（過去に踏んだ罠）。
    sys.path.insert(0, str(ROOT / "jv_bridge"))
    from experiment_sire_feature import build_sire_feature  # noqa: E402

    recs = _load(BETS) or []
    father_map = _load(SIRE_MAP) or {}
    feat, league_rate = build_sire_feature(father_map)
    known = sum(1 for v in feat.values() if v is not None)
    print(f"[info] per-bet {len(recs)}件 / 父馬マップ {len(father_map)}頭 "
          f"/ 父の成績を出せた馬 {known}/{len(feat)} ({known/max(1,len(feat))*100:.1f}%)", flush=True)

    rows = []
    for r in recs:
        p = r.get("p_nopop_raw")
        if p is None:
            continue
        s = feat.get((r["rid"], r["number"]))
        has = 1.0 if s is not None else 0.0
        sval = s if s is not None else league_rate
        rows.append({
            "period": r["period"], "rid": r["rid"], "n": r["number"],
            "base": [_logit(p)],
            "sire": [_logit(p), sval, has, sval * has],
            "won": int(r.get("won") or 0),
            "tan": float(r.get("tan_pay") or 0.0),
            "fuku": float(r.get("fuku_pay") or 0.0),
            "pop": r.get("popularity"),
        })

    periods = sorted({x["period"] for x in rows})
    # レースごとの結果を貯める（あとでブートストラップに使う）
    picks = {"base": [], "sire": [], "market": []}
    per_period = []

    for pd_ in periods:
        tr = [x for x in rows if x["period"] < pd_]
        te = [x for x in rows if x["period"] == pd_]
        if len(tr) < 500 or len(te) < 100:
            continue
        y = np.array([x["won"] for x in tr])
        if len(set(y)) < 2:
            continue
        mb = LogisticRegression(max_iter=1000).fit(np.array([x["base"] for x in tr]), y)
        ms = LogisticRegression(max_iter=1000).fit(np.array([x["sire"] for x in tr]), y)
        pb = mb.predict_proba(np.array([x["base"] for x in te]))[:, 1]
        ps = ms.predict_proba(np.array([x["sire"] for x in te]))[:, 1]

        byrace = defaultdict(list)
        for i, x in enumerate(te):
            byrace[x["rid"]].append((i, x))

        got = {"base": [], "sire": [], "market": []}
        for rid, items in byrace.items():
            # モデルが推す1頭（同点は馬番の小さい方＝毎回同じ答えになるように）
            ib = min(items, key=lambda t: (-pb[t[0]], t[1]["n"]))[1]
            iss = min(items, key=lambda t: (-ps[t[0]], t[1]["n"]))[1]
            fav = [x for _, x in items if x["pop"] == 1]
            got["base"].append(ib)
            got["sire"].append(iss)
            if fav:
                got["market"].append(fav[0])

        rec = {"period": pd_, "races": len(byrace)}
        for k in ("base", "sire", "market"):
            g = got[k]
            inv = 100 * len(g)
            rec[k] = {
                "races": len(g),
                "tan_roi": round(sum(x["tan"] for x in g) / inv * 100, 2) if inv else None,
                "fuku_roi": round(sum(x["fuku"] for x in g) / inv * 100, 2) if inv else None,
                "hit": round(sum(x["won"] for x in g) / len(g) * 100, 2) if g else None,
            }
            picks[k].extend(g)
        per_period.append(rec)
        print(f"  期間{pd_} ({rec['races']}R): "
              f"本命的中 ベース {rec['base']['hit']}% → 血統 {rec['sire']['hit']}% (市場1番人気 {rec['market']['hit']}%) ／ "
              f"単勝回収 ベース {rec['base']['tan_roi']}% → 血統 {rec['sire']['tan_roi']}% (市場 {rec['market']['tan_roi']}%)",
              flush=True)

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

    # 「血統ありのほうが単勝の回収が高い」が運かどうか＝差のブートストラップ
    rng = np.random.default_rng(RNG_SEED)
    tb = np.array([x["tan"] for x in picks["base"]], dtype=float)
    ts = np.array([x["tan"] for x in picks["sire"]], dtype=float)
    diff_ci = None
    if len(tb) == len(ts) and len(tb) > 50:
        idx = np.arange(len(tb))
        d = []
        for _ in range(BOOT):
            s = rng.choice(idx, size=len(idx), replace=True)   # レース単位（1レース=1点）
            d.append((ts[s].mean() - tb[s].mean()) / 100 * 100)
        d = np.array(d)
        diff_ci = [round(float(np.percentile(d, 2.5)), 2), round(float(np.percentile(d, 97.5)), 2)]

    ob, os_, om = summ(picks["base"]), summ(picks["sire"]), summ(picks["market"])
    n_up_hit = sum(1 for r in per_period if (r["sire"]["hit"] or 0) > (r["base"]["hit"] or 0))
    n_up_roi = sum(1 for r in per_period if (r["sire"]["tan_roi"] or 0) > (r["base"]["tan_roi"] or 0))

    print("\n=== 結論（リークなし・お金で測った） ===", flush=True)
    print(f"  対象 {ob['races']} レース（{len(per_period)} 期間）", flush=True)
    print(f"  本命的中率   ベース {ob['hit']}%  → 血統 {os_['hit']}%   （市場1番人気 {om['hit']}%）", flush=True)
    print(f"  単勝の回収率 ベース {ob['tan_roi']}% → 血統 {os_['tan_roi']}%  （市場1番人気 {om['tan_roi']}%）", flush=True)
    print(f"  複勝の回収率 ベース {ob['fuku_roi']}% → 血統 {os_['fuku_roi']}%  （市場1番人気 {om['fuku_roi']}%）", flush=True)
    print(f"  上がった期間: 的中 {n_up_hit}/{len(per_period)} ／ 単勝回収 {n_up_roi}/{len(per_period)}", flush=True)
    if diff_ci:
        print(f"  単勝回収の差（血統 − ベース）の95%の幅: {diff_ci[0]:+.2f}pt 〜 {diff_ci[1]:+.2f}pt", flush=True)

    # 判定：AUCではなく「お金」と「運の幅」で決める
    d_roi = (os_["tan_roi"] - ob["tan_roi"]) if (ob and os_) else 0.0
    crosses_zero = (diff_ci is None) or (diff_ci[0] <= 0 <= diff_ci[1])
    if d_roi > 0 and not crosses_zero and n_up_roi >= len(per_period) * 0.8:
        verdict = "本番に繋ぐ価値あり＝お金でも一貫して上がっている"
        wire = True
    elif d_roi > 0:
        verdict = ("繋がない＝お金では差が運の幅に埋もれている"
                   f"（差 {d_roi:+.2f}pt・95%の幅が0をまたぐ:{crosses_zero}・上がった期間 {n_up_roi}/{len(per_period)}）")
        wire = False
    else:
        verdict = f"繋がない＝お金ではむしろ下がっている（差 {d_roi:+.2f}pt）"
        wire = False
    print(f"\n判定: {verdict}", flush=True)
    print("⚠ どちらでも、回収率は100%を大きく下回る（控除率20%の壁）。"
          "血統は『勝てるようになる』ものではない。", flush=True)

    OUT.write_text(json.dumps({
        "note": "オフライン実験・本番未配線。AUCではなく回収率で判定した。",
        "sire_known_pct": round(known / max(1, len(feat)) * 100, 1),
        "periods": per_period,
        "overall": {"base": ob, "sire": os_, "market_favorite": om},
        "tan_roi_diff_pct_point": round(d_roi, 2),
        "tan_roi_diff_ci95": diff_ci,
        "periods_up_hit": n_up_hit, "periods_up_roi": n_up_roi, "periods_total": len(per_period),
        "verdict": verdict, "should_wire": wire,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[OK] {OUT.name} 保存（本番未配線）", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
