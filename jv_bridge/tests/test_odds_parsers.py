# -*- coding: utf-8 -*-
"""O2 (馬連) / O3 (ワイド) / O4 (馬単) / O5 (3連複) / O6 (3連単) の
繰り返し領域パーサ parse_odds_element のテスト。"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from jv_bridge import jvdata_struct as struct_def


def _ascii(s: str) -> bytes:
    return s.encode("ascii")


def test_format_kumi_pair():
    assert struct_def._format_kumi("0306") == "3-6"


def test_format_kumi_triple():
    assert struct_def._format_kumi("010306") == "1-3-6"


def test_format_kumi_with_zero_pad():
    assert struct_def._format_kumi("030600") == "3-6"


def test_format_kumi_invalid_returns_raw():
    assert struct_def._format_kumi("") == ""
    assert struct_def._format_kumi("ABCD") == "ABCD"


# ── umaren / umatan (組番 4 + オッズ 6 + 人気 3) ──────────────

def test_parse_umaren_element_basic():
    # 組番 0306 (= 3-6), オッズ 000129 (= 12.9), 人気 005
    elem = _ascii("0306") + _ascii("000129") + _ascii("005")
    r = struct_def.parse_odds_element(elem, "umaren")
    assert r["key"] == "3-6"
    assert r["odds"] == 12.9
    assert r["popularity"] == 5


def test_parse_umaren_missing_odds():
    elem = _ascii("0306") + _ascii("ZZZZZZ") + _ascii("000")
    assert struct_def.parse_odds_element(elem, "umaren") is None


def test_parse_umatan_element_basic():
    # 組番 0603 (= 6-3 順固定), オッズ 001234 (= 123.4), 人気 010
    elem = _ascii("0603") + _ascii("001234") + _ascii("010")
    r = struct_def.parse_odds_element(elem, "umatan")
    assert r["key"] == "6-3"
    assert r["odds"] == 123.4
    assert r["popularity"] == 10


# ── wide (組番 4 + 最低 5 + 最高 5 + 人気 3) ────────────────

def test_parse_wide_element_basic():
    # 組番 0306, 最低 00041 (= 4.1), 最高 00082 (= 8.2), 人気 003
    elem = _ascii("0306") + _ascii("00041") + _ascii("00082") + _ascii("003")
    r = struct_def.parse_odds_element(elem, "wide")
    assert r["key"] == "3-6"
    assert r["odds_low"] == 4.1
    assert r["odds_high"] == 8.2
    assert r["popularity"] == 3


def test_parse_wide_both_missing():
    elem = _ascii("0306") + _ascii("ZZZZZ") + _ascii("ZZZZZ") + _ascii("000")
    assert struct_def.parse_odds_element(elem, "wide") is None


# ── sanren (組番 6 + オッズ 6 + 人気 3) ─────────────────────

def test_parse_sanren_element_basic():
    # 組番 010306 (= 1-3-6), オッズ 000183 (= 18.3), 人気 015
    elem = _ascii("010306") + _ascii("000183") + _ascii("015")
    r = struct_def.parse_odds_element(elem, "sanren")
    assert r["key"] == "1-3-6"
    assert r["odds"] == 18.3
    assert r["popularity"] == 15


# ── sanrentan (組番 6 + オッズ 7 + 人気 4) ──────────────────

def test_parse_sanrentan_element_basic():
    # 組番 060301 (= 6-3-1), オッズ 0001245 (= 124.5), 人気 0025
    elem = _ascii("060301") + _ascii("0001245") + _ascii("0025")
    r = struct_def.parse_odds_element(elem, "sanrentan")
    assert r["key"] == "6-3-1"
    assert r["odds"] == 124.5
    assert r["popularity"] == 25


def test_parse_sanrentan_missing():
    elem = _ascii("060301") + _ascii("ZZZZZZZ") + _ascii("0000")
    assert struct_def.parse_odds_element(elem, "sanrentan") is None


# ── 短いバッファ / 不正種別 ────────────────────────────────

def test_parse_odds_short_buffer_returns_none():
    assert struct_def.parse_odds_element(b"abc", "umaren") is None
    assert struct_def.parse_odds_element(b"", "sanrentan") is None


def test_parse_odds_unknown_kind_returns_none():
    elem = _ascii("0306") + _ascii("000129") + _ascii("005")
    assert struct_def.parse_odds_element(elem, "unknown_kind") is None
