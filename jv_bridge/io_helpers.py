# -*- coding: utf-8 -*-
"""
JV-Link バイナリ → Python 値 への共通変換ユーティリティ。

純 Python のみ (pywin32 / Windows 依存なし) なので、Mac / Linux でも import 可能。
パーサ本体 (parse.py) と、フィールド定義テーブル (jvdata_struct.py) から使う。
"""

from __future__ import annotations


def decode_sjis(b: bytes) -> str:
    """Shift-JIS バイト列を文字列に。
    不正バイトは ? に置換し、全角空白 / NULL / 前後空白を取り除く。
    """
    if b is None:
        return ""
    s = b.decode("shift_jis", errors="replace")
    return s.replace("　", " ").rstrip("\x00").strip()


def decode_ascii(b: bytes) -> str:
    """ASCII バイト列 (数字や場コード等) を文字列に。"""
    if b is None:
        return ""
    s = b.decode("ascii", errors="replace")
    return s.rstrip("\x00").strip()


def to_int(s: str):
    """数字だけの文字列を int に。失敗時は None。"""
    if s is None:
        return None
    t = s.strip()
    if not t:
        return None
    sign = 1
    if t[0] in "+-":
        sign = -1 if t[0] == "-" else 1
        t = t[1:]
    if not t.isdigit():
        return None
    return sign * int(t)


def to_decimal(s: str, decimals: int):
    """JV-Data 形式の固定小数 (例: '0032' を decimals=1 で 3.2) を float に。"""
    n = to_int(s)
    if n is None:
        return None
    if decimals <= 0:
        return float(n)
    return n / (10 ** decimals)


def slice_field(buf: bytes, offset: int, length: int) -> bytes:
    """範囲外なら空 bytes を返す (パーサが None を返せるように)。"""
    if offset < 0 or length <= 0 or offset + length > len(buf):
        return b""
    return buf[offset:offset + length]
