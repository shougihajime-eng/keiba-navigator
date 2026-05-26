# -*- coding: utf-8 -*-
"""
build_rankings.py — 過去全レースの着順から騎手・調教師ランキングを集計。

races/*.json の各馬 (jockey/trainer/kakutei_jyuni) を集計。
races は「同一馬3重複」既知バグがあるので馬番で重複除去してから数える。
出力: data/jv_cache/rankings.json  (/api/rankings が返す)
"""
from __future__ import annotations
import glob, json, os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RACES = ROOT / "data" / "jv_cache" / "races"
OUT = ROOT / "data" / "jv_cache" / "rankings.json"


def _completeness(h):
    return (h.get("win_odds") is not None) * 4 + (1 if (h.get("popularity") or 0) > 0 else 0) * 2 + (1 if h.get("kakutei_jyuni") else 0)


def _agg():
    jockey = defaultdict(lambda: {"starts": 0, "wins": 0, "in3": 0})
    trainer = defaultdict(lambda: {"starts": 0, "wins": 0, "in3": 0})
    for f in glob.glob(str(RACES / "*.json")):
        try:
            race = json.loads(Path(f).read_text(encoding="utf-8"))
        except Exception:
            continue
        # 馬番で重複除去 (最も情報の揃った1件)
        dedup = {}
        for h in race.get("horses") or []:
            n = h.get("number")
            if not isinstance(n, int):
                continue
            if n not in dedup or _completeness(h) > _completeness(dedup[n]):
                dedup[n] = h
        for h in dedup.values():
            fin = h.get("kakutei_jyuni")
            try:
                fin = int(fin)
            except (TypeError, ValueError):
                continue
            if fin < 1:
                continue
            for who, table in ((h.get("jockey"), jockey), (h.get("trainer"), trainer)):
                if not who or not str(who).strip():
                    continue
                t = table[str(who).strip()]
                t["starts"] += 1
                if fin == 1:
                    t["wins"] += 1
                if 1 <= fin <= 3:
                    t["in3"] += 1
    return jockey, trainer


def _rank(table, min_starts=30, top=12):
    rows = []
    for name, t in table.items():
        if t["starts"] < min_starts:
            continue
        rows.append({
            "name": name,
            "starts": t["starts"],
            "wins": t["wins"],
            "in3": t["in3"],
            "win_rate": round(t["wins"] / t["starts"] * 100, 1),
            "in3_rate": round(t["in3"] / t["starts"] * 100, 1),
        })
    rows.sort(key=lambda r: (-r["win_rate"], -r["starts"]))
    return rows[:top]


def main():
    jockey, trainer = _agg()
    out = {
        "ok": True,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "note": "過去データ全体の集計 (1着率順・30走以上)",
        "jockeys": _rank(jockey),
        "trainers": _rank(trainer),
        "jockey_total": len(jockey),
        "trainer_total": len(trainer),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"[OK] {OUT.name}: 騎手{len(out['jockeys'])}位 (全{len(jockey)}人) / 調教師{len(out['trainers'])}位 (全{len(trainer)}人)", flush=True)


if __name__ == "__main__":
    main()
