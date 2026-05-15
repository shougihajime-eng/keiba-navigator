# -*- coding: utf-8 -*-
"""全 33 レコード種別の smoke テスト。

各レコード種別が:
  - RECORD_COMPLETED で True
  - 短いダミーバイト列でも parse_record が落ちずに _status='ok' を返す
  - 期待される主要フィールド (record_id) が含まれる
を確認する。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from jv_bridge import parse, jvdata_struct


# 期待される全レコード種別
ALL_RECORDS = [
    "RA", "SE",
    "O1", "O2", "O3", "O4", "O5", "O6",
    "HR",
    "JG", "TK", "HC", "WC", "WH", "WE", "YS", "UM",
    "KS", "CH", "AV", "RC",
    "BR", "BN", "HN", "SK", "HS", "HY",
    "JC", "TC", "CC", "DM", "BT", "CS",
]


@pytest.mark.parametrize("rid", ALL_RECORDS)
def test_record_is_completed(rid):
    """全レコードが RECORD_COMPLETED=True (仕様書転記済み)。"""
    assert jvdata_struct.is_completed(rid), f"{rid} が is_completed=False のまま"


@pytest.mark.parametrize("rid", ALL_RECORDS)
def test_record_in_registry(rid):
    """全レコードが RECORD_REGISTRY に登録されている。"""
    assert rid in jvdata_struct.RECORD_REGISTRY


@pytest.mark.parametrize("rid", ALL_RECORDS)
def test_parse_short_bytes_does_not_crash(rid):
    """短いバイト列 (50バイト) でも parse_record が例外を投げない。
    範囲外フィールドは None で埋まる。
    """
    sample = rid.encode("ascii") + b"\x00" * 50
    result = parse.parse_record(sample)
    assert result is not None
    assert result["_record_id"] == rid
    assert result["_status"] == "ok"


@pytest.mark.parametrize("rid", ALL_RECORDS)
def test_parse_long_bytes_does_not_crash(rid):
    """十分に長いバイト列 (10000バイト) でも parse できる。"""
    sample = rid.encode("ascii") + b"0" * 10000
    result = parse.parse_record(sample)
    assert result is not None
    assert result["_record_id"] == rid
    assert result["_status"] == "ok"


@pytest.mark.parametrize("rid", ALL_RECORDS)
def test_parse_has_data_kbn_field(rid):
    """全レコードの fields に data_kbn が含まれている (共通ヘッダ)。"""
    fields = jvdata_struct.RECORD_REGISTRY[rid]
    field_names = [f.name for f in fields]
    assert "data_kbn" in field_names, f"{rid}: data_kbn field 未定義"
    assert "make_date" in field_names, f"{rid}: make_date field 未定義"


def test_total_record_count():
    """対応レコード種別が想定通り 33 種類あること。"""
    assert len(jvdata_struct.RECORD_REGISTRY) == 33
    assert len(jvdata_struct.RECORD_COMPLETED) == 33


def test_spec_version_matches():
    """SPEC_VERSION が 4.9.0.1 (SDK 4.9.0.2 同梱の仕様書バージョン)。"""
    assert jvdata_struct.SPEC_VERSION == "4.9.0.1"
