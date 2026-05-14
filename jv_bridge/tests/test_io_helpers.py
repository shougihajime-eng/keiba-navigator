# -*- coding: utf-8 -*-
"""io_helpers.py の単体テスト (仕様書なしで全部実行できる)。"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from jv_bridge import io_helpers as io


# ── 符号付き整数 (馬体重前走比など) ──────────────────────────

def test_to_signed_int_positive_with_plus():
    assert io.to_signed_int("+003") == 3

def test_to_signed_int_negative():
    assert io.to_signed_int("-005") == -5

def test_to_signed_int_zero():
    assert io.to_signed_int("+000") == 0

def test_to_signed_int_no_sign():
    # 先頭空白プラス扱いではなく、digits-only として扱う
    assert io.to_signed_int(" 003") == 3

def test_to_signed_int_blank_returns_none():
    assert io.to_signed_int("") is None
    assert io.to_signed_int("   ") is None
    assert io.to_signed_int(None) is None

def test_to_signed_int_z_filler_returns_none():
    # JV-Data の '欠損' は 'Z' で埋められることがある
    assert io.to_signed_int("ZZZ") is None
    assert io.to_signed_int("ZZZZ") is None

def test_to_signed_int_invalid_returns_none():
    assert io.to_signed_int("abc") is None
    assert io.to_signed_int("+ab") is None


# ── track_code → 芝/ダ/障 ─────────────────────────────────────

def test_decode_track_code_turf():
    r = io.decode_track_code("10")
    assert r["surface"] == "芝"
    r = io.decode_track_code("22")
    assert r["surface"] == "芝"

def test_decode_track_code_dirt():
    r = io.decode_track_code("23")
    assert r["surface"] == "ダート"
    r = io.decode_track_code("29")
    assert r["surface"] == "ダート"

def test_decode_track_code_obstacle():
    r = io.decode_track_code("51")
    assert r["surface"] == "障害"

def test_decode_track_code_invalid():
    assert io.decode_track_code("")["surface"] is None
    assert io.decode_track_code("XY")["surface"] is None
    assert io.decode_track_code("99")["surface"] is None


# ── going / weather / sex デコード ───────────────────────────

def test_decode_going_all_known_values():
    assert io.decode_going("1") == "良"
    assert io.decode_going("2") == "稍重"
    assert io.decode_going("3") == "重"
    assert io.decode_going("4") == "不良"
    assert io.decode_going("9") is None
    assert io.decode_going("") is None

def test_decode_weather_all_known_values():
    assert io.decode_weather("1") == "晴"
    assert io.decode_weather("3") == "雨"
    assert io.decode_weather("X") is None

def test_decode_sex_all_known_values():
    assert io.decode_sex("1") == "牡"
    assert io.decode_sex("2") == "牝"
    assert io.decode_sex("3") == "セ"


# ── データ欠損判定 ───────────────────────────────────────────

def test_is_data_missing_z_filler():
    assert io.is_data_missing("ZZZ") is True
    assert io.is_data_missing("ZZZZZZZ") is True
    assert io.is_data_missing("    ") is True
    assert io.is_data_missing("") is True

def test_is_data_missing_real_value():
    assert io.is_data_missing("0032") is False
    assert io.is_data_missing("1") is False
    assert io.is_data_missing("ABC") is False  # 文字列は欠損ではない


# ── 既存の to_decimal / to_int の境界 ─────────────────────────

def test_to_decimal_with_zero_decimals():
    assert io.to_decimal("100", 0) == 100.0

def test_to_decimal_zero_value():
    assert io.to_decimal("0000", 1) == 0.0

def test_slice_field_out_of_range():
    assert io.slice_field(b"abc", 1, 5) == b""  # 範囲外
    assert io.slice_field(b"abc", -1, 2) == b""  # 負 offset
    assert io.slice_field(b"abc", 0, 0) == b""   # ゼロ長
    assert io.slice_field(b"abcdef", 1, 3) == b"bcd"
