# -*- coding: utf-8 -*-
"""
JV-Data レコード構造定義 (骨組み)

★重要 (jv_bridge/SETUP.txt:82-87 と同じルール):
  ・フィールドの offset / length は JV-Data 仕様書 (JRA-VAN SDK 同梱) を見て
    1 つずつ転記すること。推測で値を入れない。
  ・仕様書のバージョンを下記の SPEC_VERSION に明記する。
  ・転記が完了したレコードは RECORD_COMPLETED の値を True に更新する。

仕様書入手元: https://developer.jra-van.jp/  (開発者登録は無料)
仕様書バージョン: TODO (SDK 入手後に記入)
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable, Dict, List

from . import io_helpers as io


SPEC_VERSION = "UNFILLED"  # SDK 入手後にバージョン番号を入れる


# ── Field 1 つ分の定義 ─────────────────────────────────────
@dataclass
class Field:
    name: str
    offset: int
    length: int
    convert: Callable[[bytes], Any]
    note: str = ""


# ── 共通変換子 (型ヒントは Field.convert に合わせる) ──────
def F_ascii(b: bytes) -> str:        return io.decode_ascii(b)
def F_sjis(b: bytes)  -> str:        return io.decode_sjis(b)
def F_int(b: bytes):                 return io.to_int(io.decode_ascii(b))
def F_dec1(b: bytes):                return io.to_decimal(io.decode_ascii(b), 1)
def F_dec2(b: bytes):                return io.to_decimal(io.decode_ascii(b), 2)


# ─── RA レコード (レース情報) ──────────────────────────────
# DataSpec: RACE / 0B11 (馬体重と一緒に来ることもある)
# 仕様書転記時に offset / length を埋めて、RECORD_COMPLETED["RA"] = True にする。
RA_FIELDS: List[Field] = [
    Field("record_id",  0, 2, F_ascii, "always 'RA'"),
    # TODO: 仕様書転記
    # Field("data_kbn",   ?, 1, F_ascii),
    # Field("year",       ?, 4, F_ascii),
    # Field("month_day",  ?, 4, F_ascii),
    # Field("jyo_code",   ?, 2, F_ascii, "場コード 01〜10"),
    # Field("kai_ji",     ?, 2, F_ascii, "開催回"),
    # Field("nichi_ji",   ?, 2, F_ascii, "開催日"),
    # Field("race_num",   ?, 2, F_ascii),
    # Field("race_name",  ?, 60, F_sjis),
    # Field("grade_code", ?, 1, F_ascii, "G1/G2/G3"),
    # Field("distance",   ?, 4, F_int),
    # Field("track_code", ?, 2, F_ascii, "芝/ダ/障"),
    # Field("going",      ?, 1, F_ascii, "馬場状態 1=良/2=稍/3=重/4=不"),
    # Field("weather",    ?, 1, F_ascii, "1=晴/2=曇/3=雨/..."),
    # Field("hassou_time", ?, 4, F_ascii, "発走時刻 HHMM"),
]


# ─── SE レコード (馬毎レース情報) ─────────────────────────
SE_FIELDS: List[Field] = [
    Field("record_id",  0, 2, F_ascii, "always 'SE'"),
    # TODO: 仕様書転記
    # Field("year",         ?, 4, F_ascii),
    # Field("month_day",    ?, 4, F_ascii),
    # Field("jyo_code",     ?, 2, F_ascii),
    # Field("kai_ji",       ?, 2, F_ascii),
    # Field("nichi_ji",     ?, 2, F_ascii),
    # Field("race_num",     ?, 2, F_ascii),
    # Field("frame_num",    ?, 1, F_int, "枠番"),
    # Field("horse_num",    ?, 2, F_int, "馬番"),
    # Field("horse_name",   ?, 36, F_sjis),
    # Field("sex_code",     ?, 1, F_ascii, "1=牡/2=牝/3=セ"),
    # Field("age",          ?, 2, F_int),
    # Field("burden_kg",    ?, 3, F_dec1, "斤量 e.g. '560' → 56.0"),
    # Field("jockey_name",  ?, 34, F_sjis),
    # Field("trainer_name", ?, 34, F_sjis),
    # Field("prev_finish",  ?, 2, F_int, "前走着順 (00 ならデータなし)"),
    # Field("popularity",   ?, 2, F_int),
    # Field("body_weight",  ?, 3, F_int, "馬体重 kg"),
    # Field("weight_diff",  ?, 3, F_int, "馬体重前走比 (符号付き)"),
]


# ─── O1 レコード (単勝・複勝・枠連オッズ) ─────────────────
# 単勝オッズは馬番ごとに繰り返し領域として並ぶため、固定 offset ではなく
# 「N 頭分のループ」として parse する必要がある。
# 後でこのモジュール内に parse_o1(buf) のような専用関数を追加する想定。
O1_FIELDS: List[Field] = [
    Field("record_id",  0, 2, F_ascii, "always 'O1'"),
    # TODO: 単勝・複勝・枠連の繰り返し領域は専用パーサに切り出す
]


# ─── HR レコード (払戻) ────────────────────────────────────
HR_FIELDS: List[Field] = [
    Field("record_id",  0, 2, F_ascii, "always 'HR'"),
    # TODO: 単勝/複勝/馬連/ワイド/三連複/三連単 等の繰り返し領域
]


# ─── レコード種別 ID → フィールド定義 の登録簿 ──────────
RECORD_REGISTRY: Dict[str, List[Field]] = {
    "RA": RA_FIELDS,
    "SE": SE_FIELDS,
    "O1": O1_FIELDS,
    "HR": HR_FIELDS,
}


# 仕様書からの転記が完了したレコードのみ True にする。
# False のレコードは parse.parse_record() が中身を空にして {"_status": "spec_pending"} を返す。
RECORD_COMPLETED: Dict[str, bool] = {
    "RA": False,
    "SE": False,
    "O1": False,
    "HR": False,
}


def known_records() -> List[str]:
    return list(RECORD_REGISTRY.keys())


def is_completed(record_id: str) -> bool:
    return bool(RECORD_COMPLETED.get(record_id, False))
