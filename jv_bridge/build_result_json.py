# -*- coding: utf-8 -*-
"""
パース済 HR (払戻) レコードから、lib/finalize.js が読む results JSON を組み立てる。

期待スキーマ (lib/finalize.js の冒頭コメント参照):
{
  "race_id":   "...",
  "race_name": "...",
  "finishedAt": "ISO datetime",
  "results": [
    { "rank": 1, "number": 6, "name": "...", "tan_payout": 1800 }
  ],
  "payouts": {
    "tan":   { "winner": 6, "amount": 1800 },
    "fuku":  [{ "number": 6, "amount": 350 }, ...],
    "uren":  { "key": "3-6", "amount": 1290 },
    "wide":  [{ "key": "3-6", "amount": 410 }, ...],
    "fuku3": { "key": "1-3-6", "amount": 1830 },
    "tan3":  { "key": "6-3-1", "amount": 12450 }
  }
}
"""

from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "jv_cache" / "results"


def build(hr: Dict[str, Any], ra: Optional[Dict[str, Any]] = None, se_list: Optional[List[Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    """HR + (任意で) RA + SE[] → results JSON。

    HR レコードの payouts 領域は仕様書転記が必須。
    現状は骨組みのみ。仕様書転記後にここを実装する。
    """
    if not hr or hr.get("_status") != "ok":
        return None

    race_id = hr.get("race_id_18digit")
    if not race_id and ra is not None:
        parts = [str(ra.get(k) or "") for k in ("year", "month_day", "jyo_code", "kai_ji", "nichi_ji", "race_num")]
        if all(parts):
            race_id = "".join(parts)
    if not race_id:
        return None

    return {
        "race_id":    race_id,
        "race_name":  (ra or {}).get("race_name"),
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        # TODO: 仕様書転記後に着順・払戻を組み立てる
        "results":    hr.get("results") or [],
        "payouts":    hr.get("payouts") or {},
        "source":     "jv_link",
    }


def write(results_json: Dict[str, Any]) -> Optional[Path]:
    if not results_json or not results_json.get("race_id"):
        return None
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{results_json['race_id']}.json"
    out.write_text(json.dumps(results_json, ensure_ascii=False, indent=2), encoding="utf-8")
    return out
