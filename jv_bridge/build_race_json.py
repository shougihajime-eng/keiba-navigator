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


def _going_from_ra(ra: Dict[str, Any], surface: Optional[str]) -> Optional[str]:
    """track_code から芝/ダを判別して going_shiba / going_dirt を選ぶ。
    芝→ going_shiba、ダート→ going_dirt、障害→ going_shiba をデフォルト。
    """
    if surface == "ダート":
        code = ra.get("going_dirt")
    else:
        code = ra.get("going_shiba")
    if not code:
        # legacy フィールド名のフォールバック
        code = ra.get("going")
    return GOING_LABELS.get(str(code or "").strip())


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


def _weight_diff(se: Dict[str, Any]):
    """SE レコードの weight_diff_sign + weight_diff_value を符号付き整数に統合。
    新スキーマでは符号と値が別フィールド。旧スキーマ (weight_diff 一体) もサポート。
    """
    # 旧スキーマ (test fixture など)
    if "weight_diff" in se:
        v = se.get("weight_diff")
        if isinstance(v, (int, float)):
            return v
    sign = (se.get("weight_diff_sign") or "").strip()
    val  = se.get("weight_diff_value")
    if val is None or not isinstance(val, (int, float)):
        return None
    if sign == "-":
        return -int(val)
    return int(val)


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
            "weight_diff": _weight_diff(se),
            "jockey":      se.get("jockey_name"),
            "trainer":     se.get("trainer_name"),
            # JV-Data の SE には「前走着順」は無い (kakutei_jyuni は当該レースの着順)
            # 前走情報は別レコード (UM/HN/UH 等) から取得する。現状は None。
            "prev_finish": None,
            "popularity":  se.get("popularity"),
            "win_odds":    odds_table.get(str(num)) if num is not None
                            else (se.get("win_odds") if se.get("win_odds") else None),
            # SE が確定済みなら kakutei_jyuni / time が入る (結果データとしても利用可)
            "kakutei_jyuni": se.get("kakutei_jyuni"),
            "ijyou_code":    se.get("ijyou_code"),
        })

    surface = _surface_from_ra(ra)
    return {
        "race_id":       _build_race_id(ra),
        "race_name":     ra.get("race_name"),
        "course":        _course_label(ra),
        "surface":       surface,
        "distance":      ra.get("distance"),
        "going":         _going_from_ra(ra, surface),
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
