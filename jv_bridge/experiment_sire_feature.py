# -*- coding: utf-8 -*-
"""
experiment_sire_feature.py — 「血統(種牡馬=父の産駒成績)」が当てる力を上げるかのオフライン実験 (2026-06-13)

★本番の予想・特徴量・モデルには一切触れない。読むだけ + 実験結果jsonを書くだけ。

仮説: 父(種牡馬)の「その馬場(芝/ダート)での産駒の勝率」は、特に出走数の少ない若い馬で
      実力の手がかりになる。今の予想に入っていない新情報。

リークなし設計:
  ・各馬の父は sire_map.json (ketto_num -> father_num) から引く(取得済データで構築)。
  ・種牡馬成績は「当該レースより前」のレースだけで集計(時系列・未来を覗かない)。
  ・比較: A=ベース(value_ev_betsのleak-free p_nopop_raw) vs B=ベース+血統特徴 を
    time-split(過去で学習→未来でテスト)し、テスト期間AUCを比べる。

入力: data/jv_cache/value_ev_bets.json, data/jv_cache/sire_map.json, races/, results/
出力: data/jv_cache/experiment_sire.json + コンソール
実行: <64bit python> jv_bridge/experiment_sire_feature.py
"""
from __future__ import annotations
import io, json, os, sys
from collections import defaultdict
from pathlib import Path

os.environ["PYTHONIOENCODING"] = "utf-8"
for _a in ("stdout", "stderr"):
    _s = getattr(sys, _a, None)
    if _s and hasattr(_s, "buffer"):
        setattr(sys, _a, io.TextIOWrapper(_s.buffer, encoding="utf-8"))

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
RACES = CACHE / "races"
RESULTS = CACHE / "results"
BETS = CACHE / "value_ev_bets.json"
SIRE_MAP = CACHE / "sire_map.json"
OUT = CACHE / "experiment_sire.json"

MIN_SIRE_RUNS = 20   # 父の産駒成績が信頼できる最低出走数。未満は league 平均にフォールバック


def _load(p):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _winner(result):
    if not result:
        return None
    tan = (result.get("payouts") or {}).get("tan")
    if isinstance(tan, dict) and tan.get("winner") is not None:
        try:
            return int(tan["winner"])
        except (TypeError, ValueError):
            pass
    for r in (result.get("results") or []):
        if r.get("rank") == 1 and r.get("number") is not None:
            try:
                return int(r["number"])
            except (TypeError, ValueError):
                pass
    return None


def build_sire_feature(father_map):
    """各(rid,馬番)に『父のその馬場での事前産駒勝率』を付ける(リークなし)。"""
    files = sorted(RACES.glob("*.json"), key=lambda p: p.stem)  # rid先頭=日付=時系列
    sire_stat = defaultdict(lambda: [0, 0])   # (father, surface) -> [wins, runs]
    league = [0, 0]                            # 全体 [wins, runs] (フォールバック用)
    feat = {}                                  # (rid, number) -> 事前産駒勝率 or None
    for f in files:
        race = _load(f)
        if not race:
            continue
        rid = race.get("race_id") or f.stem
        surf = "dirt" if (race.get("surface") in ("ダート", "dirt") or race.get("is_dirt")) else "turf"
        res = _load(RESULTS / f"{rid}.json")
        win = _winner(res)
        horses = [h for h in (race.get("horses") or []) if isinstance(h.get("number"), int)]
        # まず事前値を記録(この時点の集計=過去のみ)
        for h in horses:
            ketto = h.get("ketto_num")
            fa = father_map.get(ketto) if ketto else None
            val = None
            if fa:
                w, n = sire_stat[(fa, surf)]
                if n >= MIN_SIRE_RUNS:
                    val = w / n
            feat[(rid, h["number"])] = val
        # 結果が出ているレースなら集計を更新(次走以降の過去として使う)
        if win is not None:
            for h in horses:
                ketto = h.get("ketto_num")
                fa = father_map.get(ketto) if ketto else None
                won = 1 if h["number"] == win else 0
                if fa:
                    sire_stat[(fa, surf)][0] += won
                    sire_stat[(fa, surf)][1] += 1
                league[0] += won; league[1] += 1
    league_rate = league[0] / league[1] if league[1] else 0.08
    return feat, league_rate


def _logit(p):
    p = min(max(float(p), 1e-6), 1 - 1e-6)
    return float(np.log(p / (1 - p)))


def main():
    if not BETS.exists():
        print("[error] value_ev_bets.json が無い。先に walk_forward_value_ev.py を。", flush=True)
        return 1
    if not SIRE_MAP.exists():
        print(f"[error] {SIRE_MAP.name} が無い。先に血統取得(父馬マップ生成)を実行してください。", flush=True)
        return 2
    recs = _load(BETS)
    father_map = _load(SIRE_MAP) or {}
    print(f"[info] per-bet {len(recs)}件 / 父馬マップ {len(father_map)}頭", flush=True)
    feat, league_rate = build_sire_feature(father_map)
    known = sum(1 for v in feat.values() if v is not None)
    print(f"[info] 父の産駒成績を出せた馬 {known}/{len(feat)} 頭 (league平均勝率={league_rate:.3f})", flush=True)
    if known < 1000:
        print("[warn] 父の成績を出せた馬が少なすぎる=父馬マップのカバーが不足。", flush=True)

    rows = []
    for r in recs:
        p = r.get("p_nopop_raw")
        if p is None:
            continue
        sire = feat.get((r["rid"], r["number"]))
        has = 1.0 if sire is not None else 0.0
        sval = sire if sire is not None else league_rate
        base = [_logit(p)]
        sire_feats = base + [sval, has, sval * has]
        rows.append((r["period"], base, sire_feats, r["won"]))

    periods = sorted({x[0] for x in rows})
    yT, sB, sP = [], [], []
    per = []
    for pd in periods:
        tr = [x for x in rows if x[0] < pd]; te = [x for x in rows if x[0] == pd]
        if len(tr) < 500 or len(te) < 100:
            continue
        Xb = np.array([x[1] for x in tr]); Xp = np.array([x[2] for x in tr]); y = np.array([x[3] for x in tr])
        Xbe = np.array([x[1] for x in te]); Xpe = np.array([x[2] for x in te]); ye = np.array([x[3] for x in te])
        if len(set(y)) < 2 or len(set(ye)) < 2:
            continue
        mb = LogisticRegression(max_iter=1000).fit(Xb, y)
        mp = LogisticRegression(max_iter=1000).fit(Xp, y)
        pb = mb.predict_proba(Xbe)[:, 1]; pp = mp.predict_proba(Xpe)[:, 1]
        ab = roc_auc_score(ye, pb); ap = roc_auc_score(ye, pp)
        yT.extend(ye.tolist()); sB.extend(pb.tolist()); sP.extend(pp.tolist())
        per.append({"period": pd, "auc_base": round(ab, 4), "auc_sire": round(ap, 4), "delta": round(ap - ab, 4)})
        print(f"  期間{pd}: AUC ベース {ab:.4f} → 血統込み {ap:.4f} (差 {ap-ab:+.4f})", flush=True)

    ob = roc_auc_score(yT, sB) if yT else None
    op = roc_auc_score(yT, sP) if yT else None
    n_up = sum(1 for d in per if d["delta"] > 0)
    print("\n=== 結論(リークなし) ===", flush=True)
    if ob is not None:
        print(f"全体 AUC: ベース {ob:.4f} → 血統込み {op:.4f} (差 {op-ob:+.4f}) / 上がった期間 {n_up}/{len(per)}", flush=True)
        if op - ob >= 0.003 and n_up >= len(per) * 0.6:
            v = "効果あり=血統は本物の上積み。次の非開催日に本番特徴量へ追加する価値あり。"
        elif op - ob > 0:
            v = "わずかに改善=単独では弱い。他と組み合わせる価値はあるが過信しない。"
        else:
            v = "効果なし=この血統特徴は当てる力を上げない。調教(追い切り)など別情報を検討。"
        print(f"判定: {v}", flush=True)
    else:
        v = "データ不足で判定不能"
        print(v, flush=True)

    OUT.write_text(json.dumps({
        "note": "オフライン実験・本番未配線", "father_horses": len(father_map),
        "sire_known": known, "overall_auc_base": ob, "overall_auc_sire": op,
        "overall_delta": (op - ob) if (ob and op) else None,
        "periods_up": n_up, "periods_total": len(per), "per_period": per, "verdict": v,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[OK] {OUT.name} 保存(本番未配線)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
