# -*- coding: utf-8 -*-
"""build_result_json.py のテスト (仕様書なしで全部走る)。"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from jv_bridge import build_result_json as br


# ── 内部ヘルパ ────────────────────────────────────────────

def test_parse_horse_num_key_pair():
    assert br._parse_horse_num_key("0306") == "3-6"

def test_parse_horse_num_key_triple():
    assert br._parse_horse_num_key("010306") == "1-3-6"

def test_parse_horse_num_key_with_zero_pad():
    # 00 のスロットは無視 (出走頭数 < 上限のとき)
    assert br._parse_horse_num_key("030600") == "3-6"

def test_parse_horse_num_key_invalid_returns_none():
    assert br._parse_horse_num_key("") is None
    assert br._parse_horse_num_key("ABC") is None
    assert br._parse_horse_num_key("12345") is None  # 奇数桁


def test_parse_amount_zero_is_none():
    assert br._parse_amount("0000000000") is None

def test_parse_amount_real_value():
    assert br._parse_amount("0000001800") == 1800
    assert br._parse_amount("0000012450") == 12450


# ── parse_payout_block 単体 ──────────────────────────────

def test_parse_payout_block_single_win():
    # 単勝 1 通り = 馬番(2) + 払戻(9) + 人気(2) = 13 バイト
    # 馬番 06, 払戻 0000001800, 人気 03
    buf = b"06" + b"000001800" + b"03"  # 計 13 バイト
    out = br.parse_payout_block(buf, 0, count=1, key_len=2, amount_len=9, pop_len=2)
    assert len(out) == 1
    assert out[0]["key"] == "6"
    assert out[0]["amount"] == 1800
    assert out[0]["popularity"] == 3

def test_parse_payout_block_empty_when_amount_zero():
    # 払戻 0 は該当無しとして除外
    buf = b"06" + b"000000000" + b"03"
    out = br.parse_payout_block(buf, 0, count=1, key_len=2, amount_len=9, pop_len=2)
    assert out == []

def test_parse_payout_block_out_of_range():
    # 短いバッファは空を返す (落とさない)
    out = br.parse_payout_block(b"abc", 0, count=10, key_len=2, amount_len=9, pop_len=2)
    assert out == []


# ── build (組み立て) ────────────────────────────────────

def test_build_from_already_parsed_payouts():
    """payouts が既に dict 形式で来た場合: そのまま透過。"""
    hr = {
        "race_id_18digit": "202605030502011100",
        "_status": "ok",
        "payouts": {
            "tan": {"winner": 6, "amount": 1800},
            "fuku": [{"number": 6, "amount": 350}, {"number": 3, "amount": 220}],
        },
        "results": [
            {"rank": 1, "number": 6, "name": "Hayate"},
            {"rank": 2, "number": 3, "name": "Subaru"},
        ],
    }
    out = br.build(hr, ra={"race_name": "テストS"})
    assert out["race_id"] == "202605030502011100"
    assert out["race_name"] == "テストS"
    # 単勝払戻が 1 着馬に attach されている
    assert out["results"][0]["tan_payout"] == 1800
    # 2 着馬には付かない
    assert "tan_payout" not in out["results"][1]
    assert out["payouts"]["tan"]["amount"] == 1800

def test_build_returns_none_when_no_race_id():
    hr = {"results": []}
    out = br.build(hr)
    assert out is None

def test_build_from_raw_bytes_with_offsets():
    """raw bytes 経由のフォーマット (_raw + _payout_offsets) で payouts を組み立て。"""
    # 単勝 1 通り (offset=0, 13 バイト): 馬番 06 / 払戻 1800 / 人気 03
    tan_block = b"06" + b"000001800" + b"03"
    # 残りは適当にゼロ埋め
    buf = tan_block + b"\x00" * 200

    hr = {
        "race_id_18digit": "202605030502011100",
        "_raw": buf,
        "_payout_offsets": {"tan": 0},  # 単勝だけパースする
        "results": [{"rank": 1, "number": 6, "name": "Hayate"}],
    }
    out = br.build(hr)
    assert out is not None
    assert out["payouts"]["tan"]["amount"] == 1800
    assert out["payouts"]["tan"]["winner"] == 6
    assert out["results"][0]["tan_payout"] == 1800

def test_build_race_id_from_ra_fallback():
    """HR に race_id が無くても RA から組み立てる。"""
    hr = {
        "_status": "ok",
        "results": [],
        "payouts": {},
    }
    ra = {
        "year": "2026", "month_day": "0503", "jyo_code": "05",
        "kai_ji": "02", "nichi_ji": "01", "race_num": "11",
        "race_name": "サンプル",
    }
    out = br.build(hr, ra=ra)
    assert out is not None
    assert out["race_id"] == "202605030502011100"
