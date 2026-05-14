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
# parse.py 側の parse_loop / parse_win_odds_element と連携する。
O1_FIELDS: List[Field] = [
    Field("record_id",  0, 2, F_ascii, "always 'O1'"),
    # ヘッダ部の offset は仕様書転記時に埋める:
    # Field("year",        ?, 4, F_ascii),
    # Field("month_day",   ?, 4, F_ascii),
    # Field("jyo_code",    ?, 2, F_ascii),
    # Field("kai_ji",      ?, 2, F_ascii),
    # Field("nichi_ji",    ?, 2, F_ascii),
    # Field("race_num",    ?, 2, F_ascii),
    # Field("horse_count", ?, 2, F_int, "出走頭数 (繰り返し要素数)"),
    # Field("anno_kbn",    ?, 1, F_ascii),
]

# O1 単勝・複勝オッズ繰り返し領域の仕様 (仕様書転記時に offset / element_len を埋める):
#   element_len: 1 馬分の長さ (= 馬番2 + オッズ4 + 人気2 + ... )
#   offset:      ヘッダ末尾から始まる繰り返し領域の開始位置
#   count_field: 繰り返し回数を持つフィールド名 (出走頭数)
O1_WIN_LOOP = {
    "offset_field": None,        # TODO: 仕様書転記後にヘッダ長を埋める
    "element_len":  8,           # 馬番2 + オッズ4 + 人気2 (構造は確定)
    "count_field":  "horse_count",
    "element_parser": "parse_win_odds_element",
}


# ─── HR レコード (払戻) ────────────────────────────────────
# 払戻は券種ごとに繰り返し領域。HR_PAYOUT_LAYOUT で「どこから何件あるか」を表現。
# 仕様書転記時に offset を埋め、is_completed["HR"] = True にする。
HR_FIELDS: List[Field] = [
    Field("record_id",  0, 2, F_ascii, "always 'HR'"),
    # Field("year",       ?, 4, F_ascii),
    # Field("month_day",  ?, 4, F_ascii),
    # Field("jyo_code",   ?, 2, F_ascii),
    # Field("kai_ji",     ?, 2, F_ascii),
    # Field("nichi_ji",   ?, 2, F_ascii),
    # Field("race_num",   ?, 2, F_ascii),
    # Field("horse_count_actual", ?, 2, F_int, "確定出走頭数"),
    # Field("horse_count_remain", ?, 2, F_int, "残出走頭数 (除外考慮)"),
    # 着順情報 (1〜5着 までの馬番) と払戻が以下のループに続く
]

# HR 払戻の繰り返し領域の構造表。
#
# ★重要: 各券種の (count, key_len, amount_len, pop_len) の正確な値は仕様書 (JRA-VAN SDK) を
# 見て埋めること。下のテンプレートは「単勝 (key_len=2 = 馬番1個・amount は数値桁・pop=2桁)」
# のように構造的に確実な部分だけ初期値として置いている。それ以外 (馬連・ワイド・三連単) は
# None で残し、仕様書転記後に埋める設計。
# build_result_json.parse_hr_payouts は None / 未設定の券種を「空配列」として安全に扱う。
HR_PAYOUT_LAYOUT = {
    "tan":     {"count": 3, "key_len": 2, "amount_len": 9,  "pop_len": 2},
    "fuku":    {"count": 5, "key_len": 2, "amount_len": 9,  "pop_len": 2},
    # 以下は仕様書転記時に確定する。暫定でテストには使わない。
    "wakuren": None,
    "uren":    None,
    "wide":    None,
    "utan":    None,
    "fuku3":   None,
    "tan3":    None,
}


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
