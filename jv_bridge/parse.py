# -*- coding: utf-8 -*-
"""
JV-Data レコード パーサ本体。

generic な「bytes → dict」変換だけを担当する。
レコード種別ごとの offset / length は jvdata_struct.py に集約。
"""

from __future__ import annotations
from typing import Any, Dict, List, Optional

from . import jvdata_struct as struct_def
from . import io_helpers as io


def detect_record_id(record_bytes: bytes) -> Optional[str]:
    """先頭 2 バイトを ASCII としてレコード種別 ID を返す。"""
    if record_bytes is None or len(record_bytes) < 2:
        return None
    try:
        rid = record_bytes[:2].decode("ascii")
    except UnicodeDecodeError:
        return None
    return rid if rid.isalnum() else None


def parse_record(record_bytes: bytes) -> Optional[Dict[str, Any]]:
    """1 レコードをパースして dict にする。

    - 未知のレコード種別 → None
    - 既知だが仕様書転記が未完 → {"_record_id": ..., "_status": "spec_pending"}
    - 仕様書転記済み         → 各フィールドを変換した dict
    """
    rec_id = detect_record_id(record_bytes)
    if not rec_id:
        return None
    fields = struct_def.RECORD_REGISTRY.get(rec_id)
    if fields is None:
        return None
    if not struct_def.is_completed(rec_id):
        return {"_record_id": rec_id, "_status": "spec_pending"}

    out: Dict[str, Any] = {"_record_id": rec_id, "_status": "ok"}
    for f in fields:
        chunk = io.slice_field(record_bytes, f.offset, f.length)
        if not chunk:
            out[f.name] = None
            continue
        try:
            out[f.name] = f.convert(chunk)
        except Exception:
            out[f.name] = None
    return out


def split_raw_file(raw: bytes) -> List[bytes]:
    """JV-Link が保存した raw .bin を 1 レコードずつに分解する。

    JV-Data 形式は仕様書上 CRLF 区切り。
    SDK サンプルでこの仮定が違っていたらここを修正する。
    """
    if not raw:
        return []
    parts = raw.split(b"\r\n")
    return [p for p in parts if p]


def parse_raw_file(raw: bytes) -> List[Dict[str, Any]]:
    """raw .bin → パース済みレコードのリスト。"""
    results: List[Dict[str, Any]] = []
    for rec in split_raw_file(raw):
        parsed = parse_record(rec)
        if parsed is not None:
            results.append(parsed)
    return results


def group_by_record_id(parsed: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """パース結果をレコード種別ごとに振り分ける。"""
    out: Dict[str, List[Dict[str, Any]]] = {}
    for p in parsed:
        rid = p.get("_record_id")
        if not rid:
            continue
        out.setdefault(rid, []).append(p)
    return out
