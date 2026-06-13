# -*- coding: utf-8 -*-
"""
build_sire_map.py — 取得済みの生データから「馬→父(種牡馬)」マップ sire_map.json を作る (2026-06-13)

★読むだけ + sire_map.json を書くだけ。本番の races/predictions/features/model には触れない。

血統(BLOD)を取得すると SK(産駒マスタ: ketto_num + 父繁殖番号) / HN(繁殖馬マスタ) の生binが貯まる。
それらをパースして ketto_num -> father_num の対応表を作る。既存 horse_master.json も併合。

実行: <64bit python> jv_bridge/build_sire_map.py
"""
from __future__ import annotations
import io, json, os, sys
from pathlib import Path

os.environ["PYTHONIOENCODING"] = "utf-8"
for _a in ("stdout", "stderr"):
    _s = getattr(sys, _a, None)
    if _s and hasattr(_s, "buffer"):
        setattr(sys, _a, io.TextIOWrapper(_s.buffer, encoding="utf-8"))

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "jv_bridge"))
CACHE = ROOT / "data" / "jv_cache"
OUT = CACHE / "sire_map.json"

import parse  # noqa: E402


def main():
    # 血統系の生binを集める(BLOD取得物 + 既存rawも一応走査)
    bins = list(CACHE.glob("aggregate_*_BLOD/raw_*.bin")) + list(CACHE.glob("aggregate_*BLOD*/*.bin"))
    if not bins:
        # フォールバック: 全aggregateフォルダ + 直下rawから血統レコードを拾う
        bins = list(CACHE.glob("aggregate_*/raw_*.bin")) + list(CACHE.glob("raw_*.bin"))
    print(f"[info] 走査する生bin: {len(bins)} ファイル", flush=True)

    sire = {}     # ketto_num -> father_num
    counts = {}
    for b in bins:
        try:
            raw = b.read_bytes()
        except Exception:
            continue
        for rec in parse.parse_raw_file(raw):
            rid = rec.get("_record_id")
            if rid not in ("SK", "HN", "UM"):
                continue
            ketto = (rec.get("ketto_num") or "").strip()
            father = (rec.get("hansyoku_f_num") or "").strip()
            if ketto and father and father.strip("0"):
                if ketto not in sire:
                    sire[ketto] = father
                    counts[rid] = counts.get(rid, 0) + 1

    # 既存 horse_master.json の father も併合
    hm = CACHE / "horse_master.json"
    if hm.exists():
        try:
            d = json.loads(hm.read_text(encoding="utf-8"))
            for k, v in d.items():
                fa = (v.get("father_num") or "").strip() if isinstance(v, dict) else ""
                if k and fa and fa.strip("0") and k not in sire:
                    sire[k] = fa
        except Exception:
            pass

    OUT.write_text(json.dumps(sire, ensure_ascii=False), encoding="utf-8")
    print(f"[OK] {OUT.name} 保存: {len(sire)} 頭ぶんの父馬 (内訳 {counts})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
