# -*- coding: utf-8 -*-
"""parse.py の generic ループパーサ (parse_loop / parse_win_odds_element) のテスト。"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from jv_bridge import parse


def test_parse_win_odds_single_horse():
    # 8 バイト = 馬番(2) + オッズ(4) + 人気(2)
    # 馬番 06 / オッズ 0032 (= 3.2) / 人気 03
    buf = b"06" + b"0032" + b"03"
    out = parse.parse_win_odds_element(buf)
    assert out["number"] == 6
    assert out["odds"] == 3.2
    assert out["popularity"] == 3


def test_parse_win_odds_missing_returns_no_odds():
    # オッズが Z 埋め (データ無し)
    buf = b"06" + b"ZZZZ" + b"03"
    out = parse.parse_win_odds_element(buf)
    assert out["number"] == 6
    assert out["odds"] is None
    assert out["popularity"] == 3


def test_parse_win_odds_invalid_horse_num_returns_none():
    # 馬番 00 は無効
    buf = b"00" + b"0032" + b"03"
    assert parse.parse_win_odds_element(buf) is None


def test_parse_win_odds_short_buffer_returns_none():
    assert parse.parse_win_odds_element(b"06") is None
    assert parse.parse_win_odds_element(b"") is None


def test_parse_loop_three_elements():
    # 馬番 1, 2, 3 のオッズが順に並ぶ 24 バイト
    buf = (
        b"01" + b"0015" + b"01" +  # 1 番: 1.5, 1 人気
        b"02" + b"0023" + b"02" +  # 2 番: 2.3, 2 人気
        b"03" + b"0048" + b"04"    # 3 番: 4.8, 4 人気
    )
    out = parse.parse_loop(buf, offset=0, element_len=8, count=3,
                           parse_element=parse.parse_win_odds_element)
    assert len(out) == 3
    assert out[0] == {"number": 1, "odds": 1.5, "popularity": 1}
    assert out[1] == {"number": 2, "odds": 2.3, "popularity": 2}
    assert out[2]["odds"] == 4.8


def test_parse_loop_out_of_range_returns_empty():
    # count を要素数より多く要求 → 空 (落とさない)
    short_buf = b"01" + b"0015" + b"01"  # 1 要素分しかない
    out = parse.parse_loop(short_buf, offset=0, element_len=8, count=10,
                           parse_element=parse.parse_win_odds_element)
    assert out == []


def test_parse_loop_invalid_args_returns_empty():
    assert parse.parse_loop(b"", 0, 8, 1, parse.parse_win_odds_element) == []
    assert parse.parse_loop(b"x" * 100, 0, 0, 1, parse.parse_win_odds_element) == []
    assert parse.parse_loop(b"x" * 100, 0, 8, 0, parse.parse_win_odds_element) == []
    assert parse.parse_loop(b"x" * 100, -1, 8, 1, parse.parse_win_odds_element) == []


def test_parse_loop_element_returning_none_is_skipped():
    # 馬番 00 (無効) と 06 (有効) が交互に並ぶ
    buf = (
        b"00" + b"0000" + b"00" +
        b"06" + b"0032" + b"03"
    )
    out = parse.parse_loop(buf, offset=0, element_len=8, count=2,
                           parse_element=parse.parse_win_odds_element)
    assert len(out) == 1
    assert out[0]["number"] == 6
