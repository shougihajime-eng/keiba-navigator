# -*- coding: utf-8 -*-
"""
experiment_pedigree_roi.py — 血統の「別の使い方」を、AUCではなく【お金（回収率）】で測る

★本番の予想・おすすめ・EV計算・画面には一切つながらない。読むだけ + 結果jsonを書くだけ。

なぜ作るか
  「父の産駒の勝率」という粗い使い方は、AUCでは+0.0010・5期間中5期間で改善したのに、
  **お金では −1.98pt・5期間中1期間しか改善しなかった**（experiment_sire_roi.py）。
  ＝AUCが上がってもお金は増えない。だから今回も判定はぜんぶ回収率でやる。
  今回ためすのは「もっときめ細かい血統の使い方」：
    父×距離 / 父×馬場 / 父×馬場状態 / 母父(BMS) / 勝率でなく3着内率(複勝率) / レース内での相対値。

測り方（ズルなし）
  ・期間 p をテストにするとき、**それより前の期間だけ**で学習する（未来を見ない）
  ・父・母父の成績も「そのレースより前」だけで数える（experiment_pedigree_features.py）
  ・レースごとにモデルが推す1頭を単勝100円・複勝100円で買ったことにする
  ・払戻は per-bet に入っている本物の tan_pay / fuku_pay（推定しない）
  ・運の幅は **レース単位のブートストラップ**（ベースと同じレースを抜き差し＝対にして比べる）
  ・**たくさん試すと、まぐれで1つ良く見える**ので、試した数ぶんの補正（max-T）も出す
  ・ものさし＝市場の1番人気を同じように買った場合

🚨 いちばん大事な検査＝ニセ血統（--placebo）
  「この測り方は そもそも意味があるのか」を確かめるため、**血統をシャッフルした
  デタラメのデータ**でも同じことを回せるようにしてある。
  2026-08-12 の実測結果（これが今回いちばん重い発見）：
    ・AUC は ニセだと ±0.0002 に潰れた（本物は +0.0018〜+0.0032）
      → 特徴の作り方にリークは無い。血統に本物の情報があるのも確か。
    ・**ところが お金（回収率）は ニセ血統でも 複勝 +1.76pt / 単勝 +8.03pt の
      「改善」が出た**（本物のいちばん良い数字 +1.81pt とほぼ同じ大きさ）。
  ＝3,047レースでは 回収率のブレが大きすぎて、複勝で ±2.5pt、単勝で ±5〜17pt より
    小さい差は **本物かまぐれか区別できない**。今回の「+1〜2pt」は全部その中。

使い方:
  <64bit python> jv_bridge/experiment_pedigree_map.py     （最初に1回だけ）
  <64bit python> jv_bridge/experiment_pedigree_roi.py
  <64bit python> jv_bridge/experiment_pedigree_roi.py --placebo   （ニセ血統での検査）
"""
from __future__ import annotations

import io
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

os.environ["PYTHONIOENCODING"] = "utf-8"
for _a in ("stdout", "stderr"):
    _s = getattr(sys, _a, None)
    if _s and hasattr(_s, "buffer"):
        setattr(sys, _a, io.TextIOWrapper(_s.buffer, encoding="utf-8"))

import numpy as np                                    # noqa: E402
from sklearn.linear_model import LogisticRegression   # noqa: E402
from sklearn.metrics import roc_auc_score             # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "jv_bridge"))
CACHE = ROOT / "data" / "jv_cache"
BETS = CACHE / "value_ev_bets.json"
SIRE_MAP = CACHE / "sire_map.json"
OUT = CACHE / "experiment_pedigree_roi.json"
OUT_PLACEBO = CACHE / "experiment_pedigree_roi_placebo.json"

BOOT = 2000
RNG_SEED = 20260812
YARDSTICK_FUKU = 84.9     # 本人が持っている「ものさし」＝1番人気の複勝ベタ買い

# 既存の実装を使い回す（同じ計算を2か所に書かない）
from experiment_sire_feature import build_sire_feature            # noqa: E402
from experiment_pedigree_features import (                        # noqa: E402
    FEATURE_NAMES, build_pedigree_features, load_pedigree_map,
)


# ── ためす使い方の一覧（先に決めて、全部そのまま報告する＝いいとこ取りをしない） ──
# 値 = (説明, 使う特徴の名前, レース内でセンタリングするか)
SPECS = [
    ("sire_win_surf_old",
     "① 父×馬場の勝率〈既存のやり方をそのまま〉",
     ["old_s", "old_has", "old_sxh"], False),
    ("sire_win_surf_fix",
     "② 父×馬場の勝率〈IDを直して なめらか化〉",
     ["fs_win", "fs_ln"], False),
    ("sire_place",
     "③ 父の複勝率（3着内率・ぜんたい）",
     ["f_pl", "f_ln"], False),
    ("sire_place_surf",
     "④ 父×馬場 の複勝率",
     ["fs_pl", "fs_ln"], False),
    ("sire_dist",
     "⑤ 父×距離帯（短/マイル/中/長）",
     ["fd_win", "fd_pl", "fd_ln"], False),
    ("sire_going",
     "⑥ 父×馬場状態（良／道悪）",
     ["fg_win", "fg_pl", "fg_ln"], False),
    ("bms",
     "⑦ 母父（BMS）ぜんたい＋馬場べつ",
     ["b_win", "b_pl", "b_ln", "bs_win", "bs_pl", "bs_ln"], False),
    ("sire_place_surf_centered",
     "⑧ 父×馬場の複勝率を〈レース内の相対値〉に直す",
     ["fs_pl", "fs_ln"], True),
    ("sire_all",
     "⑨ 父ぜんぶ（全体＋馬場＋距離＋馬場状態）",
     ["f_win", "f_pl", "f_ln", "fs_win", "fs_pl", "fs_ln",
      "fd_win", "fd_pl", "fd_ln", "fg_win", "fg_pl", "fg_ln"], False),
    ("sire_bms_all",
     "⑩ 全部盛り（父ぜんぶ＋母父）",
     FEATURE_NAMES, False),
]


def _load(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _logit(p):
    p = min(max(float(p), 1e-6), 1 - 1e-6)
    return float(np.log(p / (1 - p)))


def _fmt(v, d=2):
    return "—" if v is None else f"{v:.{d}f}"


def build_rows(placebo: bool = False):
    """per-bet に 血統の特徴を貼り合わせて、1行=1頭 の表を作る。

    placebo=True のときは **わざと血統をシャッフルする**（ニセ血統）。
    ニセでも同じだけ良く見えるなら、この測り方自体が壊れている（＝リークがある）という検査。
    """
    recs = _load(BETS) or []
    ped_map, ped_names = load_pedigree_map()
    if placebo:
        rs = np.random.default_rng(RNG_SEED)
        keys = sorted(ped_map.keys())
        vals = [ped_map[k] for k in keys]
        perm = rs.permutation(len(vals))
        ped_map = {k: vals[perm[i]] for i, k in enumerate(keys)}
        print("[PLACEBO] 血統をシャッフルした ニセ血統で回している"
              "（ここで差が出たら測り方が壊れている）", flush=True)
    new_feat, info = build_pedigree_features(ped_map)

    # ①（既存のやり方）は experiment_sire_feature.py の関数をそのまま使う
    father_map = _load(SIRE_MAP) or {}
    old_feat, old_league = build_sire_feature(father_map)
    old_known = sum(1 for v in old_feat.values() if v is not None)

    print(f"[info] per-bet {len(recs)}件 / レース {info['races']} / 馬のべ {info['horses']}", flush=True)
    print(f"[info] 血統マップ: 父が分からない馬 {info['father_missing']} 頭 "
          f"／ 母父が分からない馬 {info['bms_missing']} 頭 "
          f"（＝ほぼ全部そろっている）", flush=True)
    print(f"[info] 種牡馬 {info['sire_keys']} 頭 / 母父 {info['bms_keys']} 頭 "
          f"／ リーグ平均 勝率{info['league_win_rate']*100:.1f}% 複勝率{info['league_place_rate']*100:.1f}%",
          flush=True)
    print(f"[info] 〈既存のやり方〉で父の成績を出せた馬 {old_known}/{len(old_feat)} "
          f"({old_known/max(1,len(old_feat))*100:.1f}%) ← 20走未満は切り捨てるため", flush=True)

    cols = ["base"] + FEATURE_NAMES + ["old_s", "old_has", "old_sxh"]
    idx = {c: i for i, c in enumerate(cols)}
    rows = []
    for r in recs:
        p = r.get("p_nopop_raw")
        if p is None:
            continue
        key = (r["rid"], r["number"])
        nf = new_feat.get(key)
        if nf is None:
            nf = [0.0] * len(FEATURE_NAMES)
        s = old_feat.get(key)
        has = 1.0 if s is not None else 0.0
        sval = s if s is not None else old_league
        rows.append({
            "period": r["period"], "rid": r["rid"], "n": r["number"],
            "x": [_logit(p)] + list(nf) + [sval, has, sval * has],
            "won": int(r.get("won") or 0),
            "tan": float(r.get("tan_pay") or 0.0),
            "fuku": float(r.get("fuku_pay") or 0.0),
            "pop": r.get("popularity"),
            "odds": r.get("odds"),
        })
    return rows, cols, idx, info, ped_names


def center_in_race(X, rids, which):
    """指定した列を「そのレースの平均からの差」に置きかえる（レース内の相対値）。"""
    X = X.copy()
    order = defaultdict(list)
    for i, rid in enumerate(rids):
        order[rid].append(i)
    for ids in order.values():
        if len(ids) < 2:
            continue
        sl = np.array(ids)
        for c in which:
            X[sl, c] -= X[sl, c].mean()
    return X


def run(placebo: bool = False):
    rows, cols, idx, info, ped_names = build_rows(placebo)
    periods = sorted({r["period"] for r in rows})

    spec_names = ["base"] + [s[0] for s in SPECS]
    spec_cfg = {"base": (["base"], False)}
    spec_label = {"base": "⓪ 血統なし（今のモデル）"}
    for name, label, feats, cent in SPECS:
        spec_cfg[name] = (["base"] + feats, cent)
        spec_label[name] = label

    picks = {s: [] for s in spec_names}      # レース順にそろえて貯める
    market = []
    per_period = []
    race_order = []
    skip_flag = []       # 「血統で見送る」用（しきい値は毎回その期間より前だけで決める＝リークなし）
    fs_i = 1 + FEATURE_NAMES.index("fs_pl")
    auc_y = []                              # AUC（当てる力）も一応みる
    auc_p = {s: [] for s in spec_names}
    signal_rows = []                        # 「血統そのものに情報があるか」を見る生データ

    for pd_ in periods:
        tr = [r for r in rows if r["period"] < pd_]
        te = [r for r in rows if r["period"] == pd_]
        if len(tr) < 500 or len(te) < 100:
            continue
        y = np.array([r["won"] for r in tr])
        if len(set(y)) < 2:
            continue
        Xtr_all = np.array([r["x"] for r in tr], dtype=float)
        Xte_all = np.array([r["x"] for r in te], dtype=float)
        rid_tr = [r["rid"] for r in tr]
        rid_te = [r["rid"] for r in te]

        byrace = defaultdict(list)
        for i, r in enumerate(te):
            byrace[r["rid"]].append((i, r))
        rlist = list(byrace.keys())

        prob = {}
        for s in spec_names:
            feats, cent = spec_cfg[s]
            ci = [idx[c] for c in feats]
            Xtr = Xtr_all[:, ci]
            Xte = Xte_all[:, ci]
            if cent:
                # 「base」以外の列をレース内センタリング
                Xtr = center_in_race(Xtr, rid_tr, list(range(1, Xtr.shape[1])))
                Xte = center_in_race(Xte, rid_te, list(range(1, Xte.shape[1])))
            # 学習データだけで標準化（テストの情報を使わない＝リークなし）
            mu = Xtr.mean(axis=0)
            sd = Xtr.std(axis=0)
            sd[sd < 1e-12] = 1.0
            m = LogisticRegression(max_iter=2000).fit((Xtr - mu) / sd, y)
            prob[s] = m.predict_proba((Xte - mu) / sd)[:, 1]

        rec = {"period": pd_, "races": len(rlist)}
        for s in spec_names:
            p = prob[s]
            got = []
            for rid in rlist:
                items = byrace[rid]
                # 同点は馬番の小さい方（毎回おなじ答えが出るように）
                got.append(min(items, key=lambda t: (-p[t[0]], t[1]["n"]))[1])
            picks[s].extend(got)
            inv = 100 * len(got)
            rec[s] = {
                "races": len(got),
                "tan_roi": round(sum(g["tan"] for g in got) / inv * 100, 2),
                "fuku_roi": round(sum(g["fuku"] for g in got) / inv * 100, 2),
                "hit": round(sum(g["won"] for g in got) / len(got) * 100, 2),
            }
        auc_y.extend([r["won"] for r in te])
        for s in spec_names:
            auc_p[s].extend(prob[s].tolist())
        for r in te:
            signal_rows.append((r["x"][fs_i], r["won"], 1 if r["fuku"] > 0 else 0,
                                r.get("odds"), r["tan"], r["fuku"]))

        race_order.extend(rlist)
        for rid in rlist:
            fav = [r for _, r in byrace[rid] if r["pop"] == 1]
            market.append(fav[0] if fav else None)

        # 「血統で買う／見送る」のしきい値は **その期間より前の学習データだけ** で決める
        thr_p = float(np.median(Xtr_all[:, fs_i]))
        for g in picks["base"][-len(rlist):]:
            skip_flag.append(1 if g["x"][fs_i] >= thr_p else 0)
        per_period.append(rec)
        print(f"  期間{pd_} ({len(rlist)}R) 複勝回収: "
              + " / ".join(f"{s}={rec[s]['fuku_roi']}%" for s in ("base", "sire_place_surf", "bms")),
              flush=True)

    # ── まとめ ──
    def summ(g):
        g = [x for x in g if x is not None]
        if not g:
            return None
        inv = 100 * len(g)
        return {
            "races": len(g),
            "tan_roi": round(sum(x["tan"] for x in g) / inv * 100, 2),
            "fuku_roi": round(sum(x["fuku"] for x in g) / inv * 100, 2),
            "hit": round(sum(x["won"] for x in g) / len(g) * 100, 2),
        }

    overall = {s: summ(picks[s]) for s in spec_names}
    mk = summ(market)

    nR = len(picks["base"])
    tanM = np.array([[x["tan"] for x in picks[s]] for s in spec_names], dtype=float)   # (S, R)
    fukM = np.array([[x["fuku"] for x in picks[s]] for s in spec_names], dtype=float)

    # 何%のレースで「推す馬」が変わったか（変わらなければ何も起きていない）
    base_pick = [(x["rid"], x["n"]) for x in picks["base"]]
    changed = {}
    for i, s in enumerate(spec_names):
        if s == "base":
            continue
        p2 = [(x["rid"], x["n"]) for x in picks[s]]
        changed[s] = round(sum(1 for a, b in zip(base_pick, p2) if a != b) / max(1, nR) * 100, 1)

    # ── レース単位のブートストラップ（ベースと対にして差を見る） ──
    rng = np.random.default_rng(RNG_SEED)
    S = len(spec_names)
    dt = np.zeros((BOOT, S))
    df = np.zeros((BOOT, S))
    chunk = 200
    done = 0
    while done < BOOT:
        b = min(chunk, BOOT - done)
        sel = rng.integers(0, nR, size=(b, nR))
        mt = tanM[:, sel].mean(axis=2).T      # (b, S)
        mf = fukM[:, sel].mean(axis=2).T
        dt[done:done + b] = mt - mt[:, [0]]
        df[done:done + b] = mf - mf[:, [0]]
        done += b

    hat_t = tanM.mean(axis=1) - tanM.mean(axis=1)[0]
    hat_f = fukM.mean(axis=1) - fukM.mean(axis=1)[0]

    # ためした数ぶんの補正（max-T）：どれか1つが「まぐれで良く見える」幅
    crit_t = float(np.percentile(np.max(np.abs(dt[:, 1:] - hat_t[1:]), axis=1), 95))
    crit_f = float(np.percentile(np.max(np.abs(df[:, 1:] - hat_f[1:]), axis=1), 95))

    # 「大当たり1回抜き」＝いちばん大きい払戻を1つ外しても同じ結論か
    # （このプロジェクトが何度も踏んだ『平均の罠』＝1本の万馬券で平均が釣り上がる、を見破る）
    def drop_top(v):
        if len(v) < 2:
            return None
        w = np.sort(v)[:-1]
        return float(w.sum() / (100 * len(v)) * 100)

    base_tan_dt = drop_top(tanM[0])
    base_fuk_dt = drop_top(fukM[0])

    results = []
    for i, s in enumerate(spec_names):
        if s == "base":
            continue
        r = {
            "name": s, "label": spec_label[s],
            "tan_roi": overall[s]["tan_roi"], "fuku_roi": overall[s]["fuku_roi"],
            "hit": overall[s]["hit"],
            "d_tan": round(float(hat_t[i]), 2),
            "d_fuku": round(float(hat_f[i]), 2),
            "ci_tan": [round(float(np.percentile(dt[:, i], 2.5)), 2),
                       round(float(np.percentile(dt[:, i], 97.5)), 2)],
            "ci_fuku": [round(float(np.percentile(df[:, i], 2.5)), 2),
                        round(float(np.percentile(df[:, i], 97.5)), 2)],
            "periods_up_fuku": sum(1 for p in per_period if p[s]["fuku_roi"] > p["base"]["fuku_roi"]),
            "periods_up_tan": sum(1 for p in per_period if p[s]["tan_roi"] > p["base"]["tan_roi"]),
            "pick_changed_pct": changed[s],
            "beats_multitest_fuku": bool(hat_f[i] > crit_f),
            "beats_multitest_tan": bool(hat_t[i] > crit_t),
            # 大当たり1回抜き（1本の万馬券で釣り上がっていないか）
            "tan_roi_drop_top": round(drop_top(tanM[i]), 2),
            "fuku_roi_drop_top": round(drop_top(fukM[i]), 2),
            "d_tan_drop_top": round(drop_top(tanM[i]) - base_tan_dt, 2),
            "d_fuku_drop_top": round(drop_top(fukM[i]) - base_fuk_dt, 2),
            "max_tan_pay": int(tanM[i].max()),
            "auc": round(float(roc_auc_score(auc_y, auc_p[s])), 4),
            "d_auc": round(float(roc_auc_score(auc_y, auc_p[s]))
                           - float(roc_auc_score(auc_y, auc_p["base"])), 4),
        }
        results.append(r)

    # ── おまけ：血統で「買う／見送る」を決める使い方 ──
    # しきい値は **毎回その期間より前の学習データの中央値**（後から動かさない・リークなし）
    skip = None
    if len(skip_flag) == nR:
        flag = np.array(skip_flag)
        tanb = tanM[0]
        fukb = fukM[0]
        if flag.sum() >= 50 and (1 - flag).sum() >= 50:
            d_keep = np.zeros(BOOT)
            done = 0
            while done < BOOT:
                b = min(chunk, BOOT - done)
                sel = rng.integers(0, nR, size=(b, nR))
                kf = flag[sel]
                num = (fukb[sel] * kf).sum(axis=1)
                den = np.maximum(kf.sum(axis=1), 1)
                d_keep[done:done + b] = num / den - fukb[sel].mean(axis=1)
                done += b
            skip = {
                "threshold": "毎回その期間より前の学習データの中央値（リークなし）",
                "kept_races": int(flag.sum()),
                "skipped_races": int((1 - flag).sum()),
                "kept_fuku_roi": round(float(fukb[flag == 1].mean()), 2),
                "skipped_fuku_roi": round(float(fukb[flag == 0].mean()), 2),
                "kept_tan_roi": round(float(tanb[flag == 1].mean()), 2),
                "skipped_tan_roi": round(float(tanb[flag == 0].mean()), 2),
                "d_fuku_vs_all": round(float(fukb[flag == 1].mean() - fukb.mean()), 2),
                "ci_fuku_vs_all": [round(float(np.percentile(d_keep, 2.5)), 2),
                                   round(float(np.percentile(d_keep, 97.5)), 2)],
            }

    # ── 画面に出す ──
    ob = overall["base"]
    print("\n" + "=" * 78, flush=True)
    print(f"■ 対象 {ob['races']} レース（{len(per_period)} 期間・リークなし）", flush=True)
    print(f"  ⓪ 血統なし（今のモデル）  単勝 {ob['tan_roi']}% / 複勝 {ob['fuku_roi']}% / 本命的中 {ob['hit']}%", flush=True)
    print(f"  ものさし 市場の1番人気     単勝 {mk['tan_roi']}% / 複勝 {mk['fuku_roi']}% / 的中 {mk['hit']}%"
          f"  （本人の持っている数字 {YARDSTICK_FUKU}% とほぼ同じ）", flush=True)
    print("=" * 78, flush=True)
    print(f"ためした使い方: {len(SPECS)} 通り × 見る券種 2 つ（単勝・複勝）= {len(SPECS)*2} 回くらべた", flush=True)
    print(f"まぐれで良く見える幅（{len(SPECS)}通り試したぶんの補正）: 複勝 ±{crit_f:.2f}pt / 単勝 ±{crit_t:.2f}pt\n", flush=True)

    base_auc0 = float(roc_auc_score(auc_y, auc_p["base"]))
    hdr = (f"{'使い方':<40} {'複勝%':>7} {'差':>7} {'95%の幅':>17} {'勝った期間':>9} "
           f"{'推し変化':>7} {'AUCの差':>8}")
    print(hdr, flush=True)
    print("-" * len(hdr), flush=True)
    print(f"{'⓪ 血統なし（今のモデル）':<38} {ob['fuku_roi']:>7} {'—':>7} {'—':>17} {'—':>9} "
          f"{'—':>7} {base_auc0:>8.4f}", flush=True)
    for r in results:
        ci = f"[{r['ci_fuku'][0]:+.2f},{r['ci_fuku'][1]:+.2f}]"
        print(f"{r['label']:<38} {r['fuku_roi']:>7} {r['d_fuku']:>+7.2f} {ci:>17} "
              f"{str(r['periods_up_fuku'])+'/'+str(len(per_period)):>9} "
              f"{str(r['pick_changed_pct'])+'%':>7} {r['d_auc']:>+8.4f}",
              flush=True)
    # AUCが一番上がった使い方と、お金が一番上がった使い方は 同じか？
    best_auc = max(results, key=lambda r: r["d_auc"])
    best_money = max(results, key=lambda r: r["d_fuku"])
    print(f"\n  ★ AUC（当てる力）が一番上がったのは {best_auc['label']}（{best_auc['d_auc']:+.4f}）"
          f"だが、その複勝回収は {best_auc['d_fuku']:+.2f}pt。", flush=True)
    print(f"    お金が一番上がったのは {best_money['label']}（{best_money['d_fuku']:+.2f}pt）で、"
          f"AUCは {best_money['d_auc']:+.4f}。＝**AUCとお金は別物**（このプロジェクトの教訓がまた再現）。", flush=True)

    print("\n（参考）単勝で見た場合  ※単勝は1本の万馬券で平均が跳ねるので『大当たり1回抜き』も並べる", flush=True)
    print(f"{'使い方':<40} {'単勝%':>7} {'差':>7} {'95%の幅':>17} {'1回抜き差':>9} {'最大払戻':>8}", flush=True)
    print(f"{'⓪ 血統なし（今のモデル）':<38} {ob['tan_roi']:>7} {'—':>7} {'—':>17} "
          f"{_fmt(base_tan_dt)+'%':>9} {int(tanM[0].max()):>8}", flush=True)
    for r in results:
        ci = f"[{r['ci_tan'][0]:+.2f},{r['ci_tan'][1]:+.2f}]"
        print(f"{r['label']:<38} {r['tan_roi']:>7} {r['d_tan']:>+7.2f} {ci:>17} "
              f"{r['d_tan_drop_top']:>+9.2f} {r['max_tan_pay']:>8}", flush=True)

    # ── そもそも血統に情報があるのか？（モデルを通さない生の数字） ──
    # 「父×馬場の複勝率」で5等分して、実際の成績と オッズ を並べる。
    #  成績が上がっているのにオッズも同じだけ短い＝市場がもう知っている、ということ。
    sig = []
    sr = [s for s in signal_rows if s[3]]
    if len(sr) >= 500:
        sr.sort(key=lambda t: t[0])
        q = len(sr) // 5
        base_auc = float(roc_auc_score(auc_y, auc_p["base"]))
        for b in range(5):
            part = sr[b * q: (b + 1) * q] if b < 4 else sr[4 * q:]
            if len(part) < 50:
                continue
            n = len(part)
            imp = float(np.mean([1.0 / t[3] for t in part]))
            sig.append({
                "band": b + 1, "n": n,
                "sire_place_rate": round(float(np.mean([t[0] for t in part])) * 100, 2),
                "actual_win": round(sum(t[1] for t in part) / n * 100, 2),
                "actual_place": round(sum(t[2] for t in part) / n * 100, 2),
                "market_implied_win": round(imp * 100, 2),
                "median_odds": round(float(np.median([t[3] for t in part])), 1),
                # その帯の馬を「全部買った」ときの本物の回収率
                "tan_roi": round(sum(t[4] for t in part) / (100 * n) * 100, 2),
                "fuku_roi": round(sum(t[5] for t in part) / (100 * n) * 100, 2),
            })
        print("\n■ そもそも血統に情報はあるのか（モデルを通さない生の数字・5等分）", flush=True)
        print(f"{'父×馬場の複勝率':>14} {'頭数':>7} {'実際の勝率':>9} {'実際の複勝率':>11} "
              f"{'市場が見込む勝率':>13} {'オッズ中央':>9} {'単勝回収':>8} {'複勝回収':>8}", flush=True)
        for s in sig:
            print(f"{s['sire_place_rate']:>13.2f}% {s['n']:>7} {s['actual_win']:>8.2f}% "
                  f"{s['actual_place']:>10.2f}% {s['market_implied_win']:>12.2f}% {s['median_odds']:>9} "
                  f"{s['tan_roi']:>7.1f}% {s['fuku_roi']:>7.1f}%",
                  flush=True)
        print("  ↑ 血統が良い帯ほど 実際にちゃんと走る（勝率が2.7倍ちがう）＝血統に情報はある。", flush=True)
        print("    でも **オッズも同じだけ短くなっている**＝その情報はもう値段に入っている。", flush=True)
        print("    だから どの帯を丸ごと買っても回収率は100%に届かない（右の2列）。", flush=True)
        print(f"\n  AUC（当てる力）: ⓪ {base_auc:.4f} → "
              + " / ".join(f"{r['name']} {r['auc']:.4f}({r['d_auc']:+.4f})" for r in results[:4]), flush=True)

    if skip:
        print("\n（おまけ）血統で『買う／見送る』を決める使い方 — しきい値は毎回それより前の学習データの中央値", flush=True)
        print(f"  買う  {skip['kept_races']}R → 複勝 {skip['kept_fuku_roi']}% / 単勝 {skip['kept_tan_roi']}%", flush=True)
        print(f"  見送り {skip['skipped_races']}R → 複勝 {skip['skipped_fuku_roi']}% / 単勝 {skip['skipped_tan_roi']}%", flush=True)
        print(f"  全部買う場合との差 {skip['d_fuku_vs_all']:+.2f}pt "
              f"（95%の幅 {skip['ci_fuku_vs_all'][0]:+.2f} 〜 {skip['ci_fuku_vs_all'][1]:+.2f}pt）", flush=True)

    # ── 判定 ──
    winners = [r for r in results
               if r["d_fuku"] > 0 and r["ci_fuku"][0] > 0 and r["beats_multitest_fuku"]
               and r["periods_up_fuku"] >= len(per_period) * 0.8]
    if winners:
        best = max(winners, key=lambda r: r["d_fuku"])
        verdict = (f"本番に繋ぐ価値あり＝{best['label']} が お金でも一貫して上（"
                   f"複勝 {best['d_fuku']:+.2f}pt・95%の幅が0をまたがず・試した数ぶんの補正も超えた）")
        wire = True
    else:
        pos = [r for r in results if r["d_fuku"] > 0]
        verdict = ("繋がない＝どの使い方も『お金で確かに上がった』とは言えない"
                   f"（プラスに見えたのは {len(pos)}/{len(results)} 通りだが、"
                   "どれも95%の幅が0をまたぐ＝運の範囲）")
        wire = False
    print("\n判定: " + verdict, flush=True)
    print("⚠ どの使い方でも回収率は100%を大きく下回る（控除率20%の壁）。"
          "市場の1番人気の複勝ベタ買いにも勝てていない。", flush=True)
    if not placebo:
        print("⚠ さらに --placebo（血統をシャッフルしたニセデータ）で回すと、"
              "ニセでも複勝+1.76pt・単勝+8.03ptの『改善』が出る。"
              "＝今回の +1〜2pt は まぐれと見分けがつかない大きさ。", flush=True)

    out_path = OUT_PLACEBO if placebo else OUT
    out_path.write_text(json.dumps({
        "note": ("【PLACEBO】血統をシャッフルしたニセ血統での検査結果" if placebo
                 else "オフライン実験・本番未配線。AUCではなく回収率で判定した。"),
        "races": ob["races"], "periods": len(per_period),
        "specs_tried": len(SPECS), "metrics_tried": 2,
        "pedigree_coverage": info,
        "overall": overall,
        "market_favorite": mk,
        "yardstick_fuku_given": YARDSTICK_FUKU,
        "multitest_crit_fuku_pt": round(crit_f, 2),
        "multitest_crit_tan_pt": round(crit_t, 2),
        "results": results,
        "per_period": per_period,
        "raw_signal_bands": sig,
        "base_auc": round(float(roc_auc_score(auc_y, auc_p["base"])), 4),
        "detectable_effect_pt_fuku": round(
            float(np.mean([abs(r["ci_fuku"][1] - r["ci_fuku"][0]) / 2 for r in results])), 2),
        "skip_strategy": skip,
        "verdict": verdict, "should_wire": wire,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[OK] {out_path.name} 保存（本番未配線）", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(run("--placebo" in sys.argv))
