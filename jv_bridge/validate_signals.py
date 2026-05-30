# -*- coding: utf-8 -*-
"""
validate_signals.py — 硬い事実シグナルの「採点役」

archive_signals.py が貯めた signals/<raceId>.json と、確定結果 results/<raceId>.json を
突き合わせ、「ある事実(賢いお金の動き/取消/馬体重増減/装備変更)が出た馬は、
実際に 3着内/1着 に来やすかったか」を、全体の平均(ベースレート)と比べて採点する。

リークなし(未来をのぞき見しない)の理由:
  - 事実はすべて“レース前”に判る情報 (オッズ変化は発走前のスナップショット同士の比較・
    馬体重/装備/取消も発走前に確定)。それを“後で起きた結果”と突き合わせるだけなので、
    未来の情報で事実を選んではいない = 正当なバックテスト。
  - 結果で事実を選り好みしない (全種類を機械的に集計する)。

正直方針:
  - サンプルが少ないうちは「データ不足・あと何R必要」と正直に出す (偶然を実力と誤認しない)。
  - 数ヶ月貯まって、ある事実がベースレートを十分上回ったときだけ「効きそう」と判定。
    そこで初めて予想への採用を検討する。

出力: data/jv_cache/signals_validation.json + 標準出力サマリ
"""
from __future__ import annotations

import glob
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
RACES = CACHE / "races"
RESULTS = CACHE / "results"
SIGNALS = CACHE / "signals"
OUT = CACHE / "signals_validation.json"

# この件数を超えるまでは「効く/効かない」を判定しない (偶然を排除)。
MIN_SAMPLE = 30

KIND_LABEL = {
    "money_in":   "賢いお金が入った(オッズ急落)",
    "money_out":  "お金が抜けた(オッズ急騰)",
    "scratch":    "取消・除外",
    "weight_up":  "馬体重が大きく増えた",
    "weight_down":"馬体重が大きく減った",
    "blinker":    "ブリンカー着用",
}


def _load(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _odds_moves(hist) -> dict:
    """signals 履歴から、最初の本物オッズと最新オッズの変化率%を馬番ごとに。"""
    if not isinstance(hist, list) or len(hist) < 2:
        return {}
    first, last = {}, {}
    for snap in hist:
        for h in (snap.get("horses") or []):
            n, o = h.get("n"), h.get("o")
            if not isinstance(n, int) or o in (None, 0):
                continue
            try:
                o = float(o)
            except (TypeError, ValueError):
                continue
            if o <= 0:
                continue
            first.setdefault(n, o)
            last[n] = o
    return {n: (last[n] - o0) / o0 * 100
            for n, o0 in first.items() if last.get(n) and o0}


def _race_horses(rid: str) -> dict:
    """races/<rid>.json を馬番→horse に (重複は最初の1件)。"""
    race = _load(RACES / f"{rid}.json")
    by_num = {}
    for h in ((race or {}).get("horses") or []):
        n = h.get("number")
        if isinstance(n, int) and n not in by_num:
            by_num[n] = h
    return by_num


def _facts_for_race(rid: str) -> dict:
    """馬番 → その馬に付いた事実 kind の集合。"""
    moves = _odds_moves(_load(SIGNALS / f"{rid}.json"))
    horses = _race_horses(rid)
    out: dict = {}
    for n, h in horses.items():
        kinds = set()
        mv = moves.get(n)
        if mv is not None and mv <= -15:
            kinds.add("money_in")
        elif mv is not None and mv >= 30:
            kinds.add("money_out")
        ij = str(h.get("ijyou_code") or "").strip()
        if ij in ("2", "3", "4"):
            kinds.add("scratch")
        wd = h.get("weight_diff")
        if isinstance(wd, int) and 16 <= abs(wd) <= 40:
            kinds.add("weight_up" if wd > 0 else "weight_down")
        bl = h.get("blinker")
        if bl not in (None, "", "0", 0):
            kinds.add("blinker")
        if kinds:
            out[n] = kinds
    return out


def _finishes(rid: str) -> dict:
    """results/<rid>.json → 馬番:着順。取消等で着順が無い馬は入らない。"""
    result = _load(RESULTS / f"{rid}.json")
    out = {}
    for r in ((result or {}).get("results") or []):
        n, rank = r.get("number"), r.get("rank")
        try:
            out[int(n)] = int(rank)
        except (TypeError, ValueError):
            continue
    return out


def run() -> dict:
    # 集計器: kind -> {"n":, "top3":, "win":}
    per_kind = {k: {"n": 0, "top3": 0, "win": 0} for k in KIND_LABEL}
    base = {"n": 0, "top3": 0, "win": 0}
    races_used = 0

    for sp in glob.glob(str(SIGNALS / "*.json")):
        rid = Path(sp).stem
        finishes = _finishes(rid)
        if not finishes:
            continue  # 確定結果が無いレースは採点できない
        races_used += 1
        facts = _facts_for_race(rid)
        for n, rank in finishes.items():
            in3 = 1 if 1 <= rank <= 3 else 0
            win = 1 if rank == 1 else 0
            base["n"] += 1
            base["top3"] += in3
            base["win"] += win
            for k in facts.get(n, ()):
                per_kind[k]["n"] += 1
                per_kind[k]["top3"] += in3
                per_kind[k]["win"] += win

    def rate(a, b):
        return round(a / b, 4) if b else None

    base_top3 = rate(base["top3"], base["n"])
    base_win = rate(base["win"], base["n"])
    findings = []
    for k, c in per_kind.items():
        t3 = rate(c["top3"], c["n"])
        w = rate(c["win"], c["n"])
        if c["n"] < MIN_SAMPLE:
            verdict = f"データ不足 (あと {MIN_SAMPLE - c['n']} 頭ぶん必要)"
        elif base_top3 is not None and t3 is not None and t3 >= base_top3 + 0.05:
            verdict = "効きそう (3着内率がベースを上回る)"
        elif base_top3 is not None and t3 is not None and t3 <= base_top3 - 0.05:
            verdict = "むしろ不利"
        else:
            verdict = "差が無い (効かない)"
        findings.append({
            "kind": k, "label": KIND_LABEL[k], "n": c["n"],
            "top3_rate": t3, "win_rate": w, "verdict": verdict,
        })

    report = {
        "races_scored": races_used,
        "base_top3_rate": base_top3,
        "base_win_rate": base_win,
        "base_n": base["n"],
        "min_sample": MIN_SAMPLE,
        "findings": findings,
        "honest_note": ("事実シグナルはまだ予想に混ぜていません。"
                        "十分なサンプルで効くと確認できたものだけ後で採用します。"),
    }
    return report


def main() -> int:
    report = run()
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[validate_signals] 採点したレース数 = {report['races_scored']} / "
          f"全体3着内率 = {report['base_top3_rate']} (n={report['base_n']})", flush=True)
    for f in report["findings"]:
        print(f"  - {f['label']}: n={f['n']} 3着内率={f['top3_rate']} → {f['verdict']}",
              flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
