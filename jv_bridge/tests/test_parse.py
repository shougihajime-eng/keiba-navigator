# -*- coding: utf-8 -*-
"""
JV-Data パーサ smoke テスト。

仕様書からフィールドオフセットが転記済 (RECORD_COMPLETED[rid] == True) で、
fixtures/<rid>/sample_<rid>.bin が存在する場合だけ実行される。
それ以外は skip (緑のまま) なので、骨組み状態でも CI を壊さない。
"""

from __future__ import annotations
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from jv_bridge import parse, jvdata_struct, io_helpers

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"


def _fixture(rec_id: str) -> bytes:
    p = FIXTURES_DIR / rec_id / f"sample_{rec_id}.bin"
    if not p.exists():
        pytest.skip(f"fixture missing: {p}")
    return p.read_bytes()


def _need_spec(rec_id: str) -> None:
    if not jvdata_struct.is_completed(rec_id):
        pytest.skip(f"{rec_id} fields not yet transcribed from spec")


# ── 仕様書転記が不要なテスト (常に走る) ────────────────────

def test_io_decode_sjis_basic():
    assert io_helpers.decode_sjis(b"ABC") == "ABC"
    assert io_helpers.decode_sjis(b"") == ""
    assert io_helpers.decode_sjis(b"\x82\xa0") == "あ"  # 'あ' in SJIS


def test_io_to_int():
    assert io_helpers.to_int("00123") == 123
    assert io_helpers.to_int("") is None
    assert io_helpers.to_int("abc") is None
    assert io_helpers.to_int("-5") == -5


def test_io_to_decimal_odds():
    # JV-Data の単勝オッズ表現 '0032' (4桁・小数点なし) → 3.2
    assert io_helpers.to_decimal("0032", 1) == 3.2
    assert io_helpers.to_decimal("9999", 1) == 999.9
    assert io_helpers.to_decimal("", 1) is None


def test_detect_known_record_ids():
    assert parse.detect_record_id(b"RA12345") == "RA"
    assert parse.detect_record_id(b"SExyz")   == "SE"
    assert parse.detect_record_id(b"")        is None
    assert parse.detect_record_id(b"\x00\x01\x02") is None


def test_parse_record_spec_pending(monkeypatch):
    # 仕様書転記が未完だった場合の挙動: 一時的に RA を False にして確認
    monkeypatch.setitem(jvdata_struct.RECORD_COMPLETED, "RA", False)
    res = parse.parse_record(b"RA" + b"x" * 100)
    assert res is not None
    assert res["_record_id"] == "RA"
    assert res["_status"] == "spec_pending"


def test_parse_record_unknown_id():
    # 未登録のレコード種別 → None
    assert parse.parse_record(b"ZZ" + b"x" * 50) is None


def test_parse_record_ok_after_transcription():
    """RECORD_COMPLETED["RA"]=True 状態で、短い bytes でも落ちずに _status='ok'。
    範囲外フィールドは None になる (slice_field の保護動作)。
    """
    assert jvdata_struct.is_completed("RA") is True
    # RA は 1272 バイトが正規だが、100 バイトしか渡さなくても落ちない
    res = parse.parse_record(b"RA" + b"\x00" * 100)
    assert res is not None
    assert res["_record_id"] == "RA"
    assert res["_status"] == "ok"
    # 100 バイトだと race_name (offset 32, len 60) は範囲内なので何か入る
    # 一方 grade_code (offset 614) は範囲外で None
    assert "grade_code" in res
    assert res["grade_code"] is None


def test_parse_record_se_ok():
    """SE も同様に _status='ok' (RECORD_COMPLETED["SE"]=True)。"""
    assert jvdata_struct.is_completed("SE") is True
    res = parse.parse_record(b"SE" + b"\x00" * 50)
    assert res is not None
    assert res["_record_id"] == "SE"
    assert res["_status"] == "ok"


def test_record_layouts_are_complete():
    """全レコード種別の RECORD_COMPLETED が True (仕様書転記済み)。"""
    for rid in ["RA", "SE", "O1", "HR"]:
        assert jvdata_struct.is_completed(rid), f"{rid} の RECORD_COMPLETED が False"


# ── 仕様書転記後に有効化されるテスト (RECORD_COMPLETED 切替で起動) ──

@pytest.mark.parametrize("rec_id", ["RA", "SE", "O1", "HR"])
def test_first_byte_is_record_id(rec_id):
    raw = _fixture(rec_id)
    records = parse.split_raw_file(raw)
    assert len(records) > 0, f"split_raw_file returned 0 records for {rec_id}"
    assert parse.detect_record_id(records[0]) == rec_id


def test_ra_parses_to_race_name_and_distance():
    _need_spec("RA")
    raw = _fixture("RA")
    parsed = parse.parse_record(parse.split_raw_file(raw)[0])
    assert parsed["_status"] == "ok"
    assert isinstance(parsed.get("race_name"), str) and parsed["race_name"]
    assert isinstance(parsed.get("distance"), int) and parsed["distance"] > 0


def test_se_parses_to_horse_number_and_name():
    _need_spec("SE")
    raw = _fixture("SE")
    parsed = parse.parse_record(parse.split_raw_file(raw)[0])
    assert parsed["_status"] == "ok"
    n = parsed.get("horse_num")
    assert isinstance(n, int) and 1 <= n <= 30
    assert isinstance(parsed.get("horse_name"), str) and parsed["horse_name"]
