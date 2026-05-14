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


def to_signed_int(s: str):
    """JV-Data の符号付き整数 (馬体重前走比など) を int に。

    JV-Data 仕様では符号付き数値は先頭 1 桁が '+'/'-'/' ' (空白=プラス) で、
    残りが数字。例: '+002' → 2, '-005' → -5, ' 003' → 3。
    全部空白や 'ZZZ' (データなし) は None。
    """
    if s is None:
        return None
    t = s.strip()
    if not t:
        return None
    # データなしマーカー (JV-Data では 'Z' で埋めることが多い)
    if set(t) <= {"Z", "9", "0"} and len(set(t)) == 1 and t[0] in ("Z", "9"):
        return None
    sign = 1
    head = t[0]
    if head in "+-":
        sign = -1 if head == "-" else 1
        t = t[1:]
    if not t.isdigit():
        return None
    return sign * int(t)


def decode_track_code(code: str):
    """track_code (2桁ASCII) → ('芝'|'ダート'|'障害', '右'|'左'|None) のタプル風 dict。

    JV-Data 仕様の track_code (主要値):
      10〜22: 芝コース (内回り・外回り・直線等のバリエーション)
      23〜29: ダートコース
      51〜59: 障害コース
    厳密な値割り当ては仕様書で確定するが、頭字は固定なのでここで安全マッピング。
    """
    if not code:
        return {"surface": None, "direction": None}
    c = code.strip()
    if not c.isdigit():
        return {"surface": None, "direction": None}
    n = int(c)
    if 10 <= n <= 22:
        surface = "芝"
    elif 23 <= n <= 29:
        surface = "ダート"
    elif 51 <= n <= 59:
        surface = "障害"
    else:
        surface = None
    return {"surface": surface, "direction": None, "raw": c}


GOING_MAP = {"1": "良", "2": "稍重", "3": "重", "4": "不良"}
WEATHER_MAP = {"1": "晴", "2": "曇", "3": "雨", "4": "小雨", "5": "雪", "6": "小雪"}
SEX_MAP = {"1": "牡", "2": "牝", "3": "セ"}


def decode_going(s: str):
    return GOING_MAP.get((s or "").strip())


def decode_weather(s: str):
    return WEATHER_MAP.get((s or "").strip())


def decode_sex(s: str):
    return SEX_MAP.get((s or "").strip())


def is_data_missing(s: str) -> bool:
    """JV-Data の '欠損' を示す埋め文字 ('Z' / 空白 / '0' のみ) を判定。"""
    if s is None:
        return True
    t = s.strip()
    if not t:
        return True
    return set(t) <= {"Z", "9", "0", "*"}
