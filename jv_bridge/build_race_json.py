# -*- coding: utf-8 -*-
"""
パース済 RA + SE[] + O1 レコードから、フロントが期待する race JSON を組み立てる。

出力スキーマは lib/conclusion.js / predictors/features.js / lib/jv_cache.js が
読む形式に合わせる。配置先は data/jv_cache/races/<raceId>.json。
"""

from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import io_helpers as io


OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "jv_cache" / "races"

# ── 表記辞書 (公開情報のみ・推測なし) ───────────────────
JYO_NAMES = {
    "01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京",
    "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉",
}
SEX_LABELS    = {"1": "牡", "2": "牝", "3": "セ"}
GOING_LABELS  = {"1": "良", "2": "稍重", "3": "重", "4": "不良"}
WEATHER_LABELS = {"1": "晴", "2": "曇", "3": "雨", "4": "小雨", "5": "雪", "6": "小雪"}

# 芝/ダート → 文字短縮 (UI 表示用)
SURFACE_SHORT = {"芝": "芝", "ダート": "ダ", "障害": "障"}


def _build_race_id(ra: Dict[str, Any]) -> Optional[str]:
    """JRA 18 桁レース ID = 年(4) + 月日(4) + 場(2) + 回(2) + 日次(2) + R(2)"""
    parts = []
    for k in ("year", "month_day", "jyo_code", "kai_ji", "nichi_ji", "race_num"):
        v = ra.get(k)
        if v in (None, ""):
            return None
        parts.append(str(v))
    return "".join(parts)


def _sex_age(se: Dict[str, Any]) -> Optional[str]:
    label = SEX_LABELS.get(str(se.get("sex_code") or "").strip())
    age = se.get("age")
    if label is None or age is None:
        return None
    return f"{label}{age}"


def _surface_from_ra(ra: Dict[str, Any]) -> Optional[str]:
    """RA レコードから芝/ダ/障の文字列を返す。
    track_code を見て io_helpers.decode_track_code で判定する。
    """
    code = ra.get("track_code")
    if code:
        result = io.decode_track_code(str(code))
        return result.get("surface")
    return None


def _course_label(ra: Dict[str, Any]) -> Optional[str]:
    """場名 + 芝/ダ + 距離 e.g. '東京芝1600'。"""
    jyo = JYO_NAMES.get(str(ra.get("jyo_code") or "").strip())
    if not jyo:
        return None
    surface = _surface_from_ra(ra)
    surface_short = SURFACE_SHORT.get(surface) if surface else None
    distance = ra.get("distance")
    if surface_short and distance:
        return f"{jyo}{surface_short}{distance}"
    if distance:
        return f"{jyo}{distance}"
    return jyo


def merge(ra: Dict[str, Any], se_list: List[Dict[str, Any]], o1: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """RA / SE[] / O1 を 1 つの race JSON にマージする。"""
    horses: List[Dict[str, Any]] = []
    odds_table = (o1 or {}).get("win_odds_by_horse") or {}

    for se in se_list:
        num = se.get("horse_num")
        horses.append({
            "number":      num,
            "frame":       se.get("frame_num"),
            "name":        se.get("horse_name"),
            "sex_age":     _sex_age(se),
            "weight":      se.get("burden_kg"),
            "body_weight": se.get("body_weight"),
            "weight_diff": se.get("weight_diff"),
            "jockey":      se.get("jockey_name"),
            "trainer":     se.get("trainer_name"),
            "prev_finish": se.get("prev_finish"),
            "popularity":  se.get("popularity"),
            "win_odds":    odds_table.get(str(num)) if num is not None else None,
        })

    surface = _surface_from_ra(ra)
    return {
        "race_id":       _build_race_id(ra),
        "race_name":     ra.get("race_name"),
        "course":        _course_label(ra),
        "surface":       surface,
        "distance":      ra.get("distance"),
        "going":         GOING_LABELS.get(str(ra.get("going") or "").strip()),
        "weather":       WEATHER_LABELS.get(str(ra.get("weather") or "").strip()),
        "is_g1":         (str(ra.get("grade_code") or "").strip() == "1"),
        "source":        "jv_link",
        "is_dummy":      False,
        "last_updated":  datetime.now(timezone.utc).isoformat(),
        "horses":        horses,
    }


def write(race_json: Dict[str, Any]) -> Optional[Path]:
    """race JSON を data/jv_cache/races/<raceId>.json に保存する。"""
    if not race_json or not race_json.get("race_id"):
        return None
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{race_json['race_id']}.json"
    out.write_text(json.dumps(race_json, ensure_ascii=False, indent=2), encoding="utf-8")
    return out
