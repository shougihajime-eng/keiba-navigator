# -*- coding: utf-8 -*-
"""
experiment_pace_feature.py — 「展開(レースの逃げ・先行馬の数)」が当てる力を上げるかのオフライン実験 (2026-06-13)

★本番の予想には一切触れない。読むだけ・新しいjsonを書くだけ。今日のレースに影響ゼロ。

仮説: 今の予想は「各馬の強さ」は見ているが「レースがどう流れるか(展開)」を見ていない。
      逃げ・先行馬が多い→ハイペース→差し追込が有利、少ない→スローで前が残る。
      この race-shape を足すと、リークなしで AUC(当てる力)が上がるのでは?

やり方(全部リークなし):
  1. 各馬の「脚質」を ketto_num で過去レースから作る(その馬がそのレースに来るまでの最頻脚質)。
     ※当該レースの kyakusitu は結果(=未来情報)なので使わない。過去走だけ。
  2. レースごとに n_front=逃げ/先行馬の数、front_ratio=n_front/出走頭数 を計算。
  3. 比較する2モデルを time-split(過去で学習→未来でテスト)で当てる:
       A: ベース = モデルの勝率(value_ev_bets の leak-free な p_nopop_raw)だけ
       B: ベース + 展開特徴(自分が前か/展開の速さ/その掛け算)
     → テスト期間の AUC を A と B で比べる。上がれば展開は本物の上積み。
出力: data/jv_cache/experiment_pace.json + コンソール
実行: <64bit python> jv_bridge/experiment_pace_feature.py
"""
from __future__ import annotations

import io
import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

os.environ["PYTHONIOENCODING"] = "utf-8"
for _attr in ("stdout", "stderr"):
    _s = getattr(sys, _attr, None)
    if _s and hasattr(_s, "buffer"):
        setattr(sys, _attr, io.TextIOWrapper(_s.buffer, encoding="utf-8"))

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
RACES = CACHE / "races"
BETS = CACHE / "value_ev_bets.json"
OUT = CACHE / "experiment_pace.json"

FRONT_STYLES = {1, 2}     # 1=逃げ 2=先行
CLOSER_STYLES = {3, 4}    # 3=差し 4=追込


def _load(p):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def build_prior_style():
    """ketto_num で過去走を繋ぎ、各(race_id, 馬番)の『そのレースまでの最頻脚質』を返す。
    当該レースの脚質は使わない=リークなし。"""
    # (date, rid) 昇順で処理するため、全レースを date でソート
    files = sorted(RACES.glob("*.json"), key=lambda p: p.stem)  # rid 先頭8桁=日付なので文字列順=時系列
    hist = defaultdict(list)                 # ketto_num -> [過去の kyakusitu(int)...]
    prior = {}                               # (rid, number) -> 最頻脚質 or None
    pace = {}                                # rid -> {"n_front":, "field":}
    for f in files:
        race = _load(f)
        if not race:
            continue
        rid = race.get("race_id") or f.stem
        horses = [h for h in (race.get("horses") or []) if isinstance(h.get("number"), int)]
        n_front = 0
        field = 0
        for h in horses:
            field += 1
            ketto = h.get("ketto_num")
            past = hist.get(ketto) if ketto else None
            mode = None
            if past:
                mode = Counter(past).most_common(1)[0][0]
            prior[(rid, h["number"])] = mode
            if mode in FRONT_STYLES:
                n_front += 1
        pace[rid] = {"n_front": n_front, "field": field}
        # この後で履歴に当該レースの脚質を追加(次走以降の過去として使う)
        for h in horses:
            ketto = h.get("ketto_num")
            ks = h.get("kyakusitu")
            try:
                ks = int(ks)
            except (TypeError, ValueError):
                ks = None
            if ketto and ks in (1, 2, 3, 4):
                hist[ketto].append(ks)
    return prior, pace


def _logit(p):
    p = min(max(float(p), 1e-6), 1 - 1e-6)
    return float(np.log(p / (1 - p)))


def main():
    if not BETS.exists():
        print(f"[error] {BETS} が無い。先に walk_forward_value_ev.py を実行。", flush=True)
        return 1
    recs = _load(BETS)
    print(f"[info] leak-free per-bet {len(recs)} 件を読み込み。各馬の脚質を過去走から構築中...", flush=True)
    prior, pace = build_prior_style()
    known = sum(1 for v in prior.values() if v is not None)
    print(f"[info] 脚質を作れた馬 {known}/{len(prior)} 頭ぶん", flush=True)

    rows = []  # (period, [base_feats], [pace_feats], y)
    matched = 0
    for r in recs:
        rid, num = r["rid"], r["number"]
        p = r.get("p_nopop_raw")
        if p is None:
            continue
        pc = pace.get(rid)
        if not pc or pc["field"] <= 0:
            continue
        my_style = prior.get((rid, num))
        is_front = 1.0 if my_style in FRONT_STYLES else 0.0
        is_closer = 1.0 if my_style in CLOSER_STYLES else 0.0
        front_ratio = pc["n_front"] / pc["field"]
        base = [_logit(p)]
        pace_feats = base + [is_front, front_ratio, is_front * front_ratio, is_closer * front_ratio]
        rows.append((r["period"], base, pace_feats, r["won"]))
        matched += 1
    print(f"[info] 学習に使える行 {matched} 件", flush=True)

    periods = sorted({row[0] for row in rows})
    # time-split: テスト期間 p は「それより前の期間」で学習
    auc_base_all, auc_pace_all = [], []
    yT, sB, sP = [], [], []
    per_period = []
    for p in periods:
        train = [row for row in rows if row[0] < p]
        test = [row for row in rows if row[0] == p]
        if len(train) < 500 or len(test) < 100:
            continue
        Xb_tr = np.array([row[1] for row in train]); Xp_tr = np.array([row[2] for row in train])
        y_tr = np.array([row[3] for row in train])
        Xb_te = np.array([row[1] for row in test]); Xp_te = np.array([row[2] for row in test])
        y_te = np.array([row[3] for row in test])
        if len(set(y_tr)) < 2 or len(set(y_te)) < 2:
            continue
        mb = LogisticRegression(max_iter=1000).fit(Xb_tr, y_tr)
        mp = LogisticRegression(max_iter=1000).fit(Xp_tr, y_tr)
        pb = mb.predict_proba(Xb_te)[:, 1]
        pp = mp.predict_proba(Xp_te)[:, 1]
        ab = roc_auc_score(y_te, pb); ap = roc_auc_score(y_te, pp)
        auc_base_all.append(ab); auc_pace_all.append(ap)
        yT.extend(y_te.tolist()); sB.extend(pb.tolist()); sP.extend(pp.tolist())
        per_period.append({"period": p, "n_test": len(test),
                           "auc_base": round(ab, 4), "auc_pace": round(ap, 4),
                           "delta": round(ap - ab, 4)})
        print(f"  期間{p}: AUC ベース {ab:.4f} → 展開込み {ap:.4f} (差 {ap-ab:+.4f}) / test {len(test)}", flush=True)

    overall_base = roc_auc_score(yT, sB) if yT else None
    overall_pace = roc_auc_score(yT, sP) if yT else None
    mean_delta = (sum(a - b for a, b in zip(auc_pace_all, auc_base_all)) / len(auc_base_all)) if auc_base_all else None
    n_up = sum(1 for d in (per_period) if d["delta"] > 0)

    print("\n=== 結論(リークなし・テスト期間まとめ) ===", flush=True)
    print(f"全体 AUC: ベース {overall_base:.4f} → 展開込み {overall_pace:.4f} (差 {overall_pace-overall_base:+.4f})", flush=True)
    print(f"期間別の平均差: {mean_delta:+.4f} / 上がった期間 {n_up}/{len(per_period)}", flush=True)
    if overall_pace - overall_base >= 0.003 and n_up >= len(per_period) * 0.6:
        verdict = "効果あり=展開は本物の上積み。次の非開催日に本番の特徴量へ正式追加する価値あり。"
    elif overall_pace - overall_base > 0:
        verdict = "わずかに改善=微妙。単独では弱い。他の特徴と組み合わせる価値はあるが過信しない。"
    else:
        verdict = "効果なし=この作り方の展開特徴は当てる力を上げない。別の情報(条件別成績/血統/調教)を検討。"
    print(f"判定: {verdict}", flush=True)

    OUT.write_text(json.dumps({
        "evaluated_at_note": "オフライン実験・本番未配線",
        "method": "ketto_num で過去走から脚質を構築(リークなし)→展開特徴→time-split で AUC 比較",
        "overall_auc_base": overall_base, "overall_auc_pace": overall_pace,
        "overall_delta": (overall_pace - overall_base) if (overall_base and overall_pace) else None,
        "mean_period_delta": mean_delta, "periods_up": n_up, "periods_total": len(per_period),
        "per_period": per_period, "verdict": verdict,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[OK] {OUT.name} 保存(本番未配線)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
