# -*- coding: utf-8 -*-
"""
JV-Data レコード構造定義

★転記元: JRA-VAN Data Lab. SDK Ver4.9.0.2 (JVDTLABSDK4902.zip)
   `JV-Data構造体/C#版/JVData_Struct.cs` から各レコードの SetDataB() 中の
   `MidB2S(ref bBuff, 1-origin offset, length)` をそのまま転記。
   C# の 1-origin offset を Python の 0-origin に変換 (`-1`) して保持。

SPEC_VERSION: "4.9.0.1" (SDK 4.9.0.2 同梱の JV-Data仕様書 4.9.0.1)

レコードレイアウト概要:
  RA (レース情報):       1272 バイト  → grade/distance/track_code/weather/going 等
  SE (馬毎レース情報):    555 バイト  → 馬番/馬名/騎手/調教師/馬体重/着順/単勝オッズ
  O1 (単複枠オッズ):      962 バイト  → ヘッダ + 単勝28馬ループ + 複勝28馬 + 枠連36
  HR (払戻):              719 バイト  → 単/複/枠連/馬連/ワイド/馬単/3連複/3連単
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable, Dict, List

from . import io_helpers as io


SPEC_VERSION = "4.9.0.1"  # SDK Ver4.9.0.2 同梱の JV-Data 仕様書バージョン


# ── Field 1 つ分の定義 ─────────────────────────────────────
@dataclass
class Field:
    name: str
    offset: int          # 0-origin
    length: int
    convert: Callable[[bytes], Any]
    note: str = ""


# ── 共通変換子 ─────────────────────────────────────────────
def F_ascii(b: bytes) -> str:        return io.decode_ascii(b)
def F_sjis(b: bytes)  -> str:        return io.decode_sjis(b)
def F_int(b: bytes):                 return io.to_int(io.decode_ascii(b))
def F_dec1(b: bytes):                return io.to_decimal(io.decode_ascii(b), 1)
def F_dec2(b: bytes):                return io.to_decimal(io.decode_ascii(b), 2)
def F_signed_int(b: bytes):          return io.to_signed_int(io.decode_ascii(b))


# ─── RA レコード (レース情報) 1272 バイト ──────────────────
# DataSpec: RACE / 0B11 など。
# C# JV_RA_RACE.SetDataB() を offset(1-origin) → Python offset(0-origin) で転記。
RA_FIELDS: List[Field] = [
    # RECORD_ID (1-11)
    Field("record_id",   0, 2,  F_ascii, "レコード種別 'RA'"),
    Field("data_kbn",    2, 1,  F_ascii, "データ区分"),
    Field("make_date",   3, 8,  F_ascii, "作成年月日 YYYYMMDD"),
    # RACE_ID (12-27)
    Field("year",       11, 4,  F_ascii, "開催年"),
    Field("month_day",  15, 4,  F_ascii, "開催月日 MMDD"),
    Field("jyo_code",   19, 2,  F_ascii, "競馬場コード 01〜10"),
    Field("kai_ji",     21, 2,  F_ascii, "開催回"),
    Field("nichi_ji",   23, 2,  F_ascii, "開催日"),
    Field("race_num",   25, 2,  F_ascii, "レース番号"),
    # RACE_INFO (28-614)
    Field("youbi_code", 27, 1,  F_ascii, "曜日コード"),
    Field("toku_num",   28, 4,  F_ascii, "特別競走番号"),
    Field("race_name",  32, 60, F_sjis,  "競走名本題"),
    Field("race_name_short", 572, 20, F_sjis, "競走名略称10字"),
    Field("race_name_ryakusyo6", 592, 12, F_sjis, "競走名略称6字"),
    Field("race_name_ryakusyo3", 604, 6,  F_sjis, "競走名略称3字"),
    Field("race_kubun", 610, 1,  F_ascii, "競走名区分"),
    Field("nkai",       611, 3,  F_ascii, "重賞回次"),
    # GradeCD 等 (615 以降)
    Field("grade_code", 614, 1,  F_ascii, "G1/G2/G3 グレードコード"),
    Field("grade_code_before", 615, 1, F_ascii, "変更前グレードコード"),
    # 距離・トラック (698-)
    Field("distance",   697, 4,  F_int,   "距離"),
    Field("distance_before", 701, 4, F_int, "変更前距離"),
    Field("track_code", 705, 2,  F_ascii, "トラックコード 10-22芝/23-29ダ/51-59障"),
    Field("track_code_before", 707, 2, F_ascii),
    Field("course_kubun", 709, 2, F_ascii, "コース区分"),
    # 発走時刻 (874-)
    Field("hassou_time", 873, 4, F_ascii, "発走時刻 HHMM"),
    Field("toroku_tosu", 881, 2, F_int,   "登録頭数"),
    Field("syusso_tosu", 883, 2, F_int,   "出走頭数"),
    Field("nyusen_tosu", 885, 2, F_int,   "入線頭数"),
    # 天候・馬場 TENKO_BABA_INFO (888-890)
    Field("weather",    887, 1, F_ascii, "天候コード 1晴/2曇/3雨/..."),
    Field("going_shiba",888, 1, F_ascii, "芝馬場状態 1良/2稍/3重/4不"),
    Field("going_dirt", 889, 1, F_ascii, "ダート馬場状態"),
    Field("record_up_kubun", 1269, 1, F_ascii, "レコード更新区分"),
]


# ─── SE レコード (馬毎レース情報) 555 バイト ─────────────
# C# JV_SE_RACE_UMA.SetDataB() より転記。
SE_FIELDS: List[Field] = [
    # RECORD_ID
    Field("record_id",   0, 2,  F_ascii, "レコード種別 'SE'"),
    Field("data_kbn",    2, 1,  F_ascii),
    Field("make_date",   3, 8,  F_ascii),
    # RACE_ID
    Field("year",       11, 4,  F_ascii),
    Field("month_day",  15, 4,  F_ascii),
    Field("jyo_code",   19, 2,  F_ascii),
    Field("kai_ji",     21, 2,  F_ascii),
    Field("nichi_ji",   23, 2,  F_ascii),
    Field("race_num",   25, 2,  F_ascii),
    # 馬情報
    Field("frame_num",  27, 1,  F_int,   "枠番 1-8"),
    Field("horse_num",  28, 2,  F_int,   "馬番 1-30"),
    Field("ketto_num",  30, 10, F_ascii, "血統登録番号"),
    Field("horse_name", 40, 36, F_sjis,  "馬名"),
    Field("uma_kigo",   76, 2,  F_ascii, "馬記号コード"),
    Field("sex_code",   78, 1,  F_ascii, "性別 1牡/2牝/3セ"),
    Field("hinsyu",     79, 1,  F_ascii, "品種"),
    Field("keiro",      80, 2,  F_ascii, "毛色"),
    Field("age",        82, 2,  F_int,   "馬齢"),
    Field("tozai_code", 84, 1,  F_ascii, "東西所属"),
    Field("chokyosi_code", 85, 5, F_ascii, "調教師コード"),
    Field("trainer_name",  90, 8, F_sjis, "調教師名略称8字"),
    Field("banusi_code",   98, 6, F_ascii, "馬主コード"),
    Field("banusi_name",  104, 64, F_sjis, "馬主名"),
    # Futan (斤量)
    Field("burden_kg",  288, 3, F_dec1, "斤量 例 '560' → 56.0"),
    Field("burden_kg_before", 291, 3, F_dec1),
    Field("blinker",    294, 1, F_ascii),
    # 騎手
    Field("kisyu_code", 296, 5, F_ascii, "騎手コード"),
    Field("kisyu_code_before", 301, 5, F_ascii),
    Field("jockey_name", 306, 8, F_sjis, "騎手名略称8字"),
    Field("jockey_name_before", 314, 8, F_sjis),
    Field("minarai",    322, 1, F_ascii, "騎手見習"),
    Field("minarai_before", 323, 1, F_ascii),
    # 馬体重
    Field("body_weight",       324, 3, F_int,   "馬体重 kg"),
    Field("weight_diff_sign",  327, 1, F_ascii, "増減符号 + or -"),
    Field("weight_diff_value", 328, 3, F_int,   "増減差 絶対値"),
    # 異常区分・着順
    Field("ijyou_code",     331, 1, F_ascii, "1正常/2取消/3除外/4中止/5失格/..."),
    Field("nyusen_jyuni",   332, 2, F_int,   "入線順位"),
    Field("kakutei_jyuni",  334, 2, F_int,   "確定着順 (前走でなく当該レース)"),
    Field("dochaku_kubun",  336, 1, F_ascii),
    Field("dochaku_tosu",   337, 1, F_int),
    Field("time",           338, 4, F_ascii, "走破タイム MSSS (分秒.S)"),
    # 着差・コーナー
    Field("chakusa_cd",     342, 3, F_ascii),
    Field("chakusa_cd_p",   345, 3, F_ascii),
    Field("chakusa_cd_pp",  348, 3, F_ascii),
    Field("jyuni_1c",       351, 2, F_int),
    Field("jyuni_2c",       353, 2, F_int),
    Field("jyuni_3c",       355, 2, F_int),
    Field("jyuni_4c",       357, 2, F_int),
    # 単勝オッズ (SE では確定後の最終オッズ)
    Field("win_odds",       359, 4, F_dec1, "単勝オッズ (最終確定)"),
    Field("popularity",     363, 2, F_int,  "単勝人気順"),
    Field("honsyokin",      365, 8, F_int,  "獲得本賞金 (百円)"),
    # 後3F/4F
    Field("haron_l4",       387, 3, F_dec1, "後4ハロンタイム"),
    Field("haron_l3",       390, 3, F_dec1, "後3ハロンタイム"),
    # マイニング予想 (DataLab 独自項目)
    Field("dm_kubun",       536, 1, F_ascii),
    Field("dm_time",        537, 5, F_ascii),
    Field("dm_jyuni",       550, 2, F_int,  "マイニング予想順位"),
    Field("kyakusitu",      552, 1, F_ascii, "脚質判定 1逃/2先/3差/4追/5マ"),
]


# ─── O1 レコード (単・複・枠連オッズ) 962 バイト ──────────
# JV_O1_ODDS_TANFUKUWAKU の構造に従う。
O1_FIELDS: List[Field] = [
    Field("record_id",   0, 2,  F_ascii, "'O1'"),
    Field("data_kbn",    2, 1,  F_ascii),
    Field("make_date",   3, 8,  F_ascii),
    Field("year",       11, 4,  F_ascii),
    Field("month_day",  15, 4,  F_ascii),
    Field("jyo_code",   19, 2,  F_ascii),
    Field("kai_ji",     21, 2,  F_ascii),
    Field("nichi_ji",   23, 2,  F_ascii),
    Field("race_num",   25, 2,  F_ascii),
    Field("happyo_time",27, 8,  F_ascii, "発表月日時分 MDHM"),
    Field("toroku_tosu",35, 2,  F_int,   "登録頭数"),
    Field("horse_count",37, 2,  F_int,   "出走頭数 (単勝オッズ繰り返し数)"),
    Field("tansyo_flag",39, 1,  F_ascii, "発売フラグ 単勝"),
    Field("fukusyo_flag", 40, 1, F_ascii),
    Field("wakuren_flag", 41, 1, F_ascii),
    Field("fuku_chaku_key", 42, 1, F_ascii),
]


# O1 単勝オッズ繰り返し領域:
#   1 馬分 = 馬番(2) + オッズ(4) + 人気(2) = 8 バイト × 最大 28 頭
#   先頭 offset = 43 (= 44 1-origin → 43 0-origin)
O1_WIN_LOOP = {
    "offset":         43,
    "element_len":    8,
    "max_count":      28,
    "count_field":    "horse_count",
    "element_parser": "parse_win_odds_element",
}

# O1 複勝オッズ繰り返し領域:
#   1 馬分 = 馬番(2) + 最低オッズ(4) + 最高オッズ(4) + 人気(2) = 12 バイト × 28
#   先頭 offset = 267 (= 268 1-origin → 267 0-origin)
O1_PLACE_LOOP = {
    "offset":      267,
    "element_len": 12,
    "max_count":   28,
}

# O1 枠連オッズ繰り返し領域:
#   1 組 = 組番(2) + オッズ(5) + 人気(2) = 9 バイト × 36
#   先頭 offset = 603
O1_WAKU_LOOP = {
    "offset":      603,
    "element_len": 9,
    "max_count":   36,
}


# ─── HR レコード (払戻) 719 バイト ─────────────────────────
HR_FIELDS: List[Field] = [
    Field("record_id",   0, 2,  F_ascii, "'HR'"),
    Field("data_kbn",    2, 1,  F_ascii),
    Field("make_date",   3, 8,  F_ascii),
    Field("year",       11, 4,  F_ascii),
    Field("month_day",  15, 4,  F_ascii),
    Field("jyo_code",   19, 2,  F_ascii),
    Field("kai_ji",     21, 2,  F_ascii),
    Field("nichi_ji",   23, 2,  F_ascii),
    Field("race_num",   25, 2,  F_ascii),
    Field("toroku_tosu",27, 2,  F_int,   "登録頭数"),
    Field("syusso_tosu",29, 2,  F_int,   "出走頭数"),
]


# HR 払戻の繰り返し領域 (offsets は 0-origin; SDK SetDataB() の 1-origin から -1):
#   tan:    offset=102, count=3, key_len=2, amount_len=9, pop_len=2  (PAY_INFO1 ×3 @103)
#   fuku:   offset=141, count=5, key_len=2, amount_len=9, pop_len=2  (PAY_INFO1 ×5 @142)
#   wakuren:offset=206, count=3, key_len=2, amount_len=9, pop_len=2  (PAY_INFO1 ×3 @207)
#   uren:   offset=245, count=3, key_len=4, amount_len=9, pop_len=3  (PAY_INFO2 ×3 @246)
#   wide:   offset=293, count=7, key_len=4, amount_len=9, pop_len=3  (PAY_INFO2 ×7 @294)
#   utan:   offset=453, count=6, key_len=4, amount_len=9, pop_len=3  (PAY_INFO2 ×6 @454)
#   fuku3:  offset=549, count=3, key_len=6, amount_len=9, pop_len=3  (PAY_INFO3 ×3 @550)
#   tan3:   offset=603, count=6, key_len=6, amount_len=9, pop_len=4  (PAY_INFO4 ×6 @604)
HR_PAYOUT_LAYOUT = {
    "tan":     {"offset": 102, "count": 3, "key_len": 2, "amount_len": 9,  "pop_len": 2},
    "fuku":    {"offset": 141, "count": 5, "key_len": 2, "amount_len": 9,  "pop_len": 2},
    "wakuren": {"offset": 206, "count": 3, "key_len": 2, "amount_len": 9,  "pop_len": 2},
    "uren":    {"offset": 245, "count": 3, "key_len": 4, "amount_len": 9,  "pop_len": 3},
    "wide":    {"offset": 293, "count": 7, "key_len": 4, "amount_len": 9,  "pop_len": 3},
    "utan":    {"offset": 453, "count": 6, "key_len": 4, "amount_len": 9,  "pop_len": 3},
    "fuku3":   {"offset": 549, "count": 3, "key_len": 6, "amount_len": 9,  "pop_len": 3},
    "tan3":    {"offset": 603, "count": 6, "key_len": 6, "amount_len": 9,  "pop_len": 4},
}


# ─── TK レコード (特別登録馬) 21657 バイト ────────────────
# SDK JV_TK_TOKUUMA より転記。レース前の登録馬一覧 (最大 300 頭/レース)。
# ヘッダ部分のみ Field 定義。300 頭の TOKUUMA_INFO ループは TK_TOKUUMA_LOOP 経由で parse。
TK_FIELDS: List[Field] = [
    Field("record_id",   0, 2,  F_ascii, "'TK'"),
    Field("data_kbn",    2, 1,  F_ascii),
    Field("make_date",   3, 8,  F_ascii),
    Field("year",       11, 4,  F_ascii),
    Field("month_day",  15, 4,  F_ascii),
    Field("jyo_code",   19, 2,  F_ascii),
    Field("kai_ji",     21, 2,  F_ascii),
    Field("nichi_ji",   23, 2,  F_ascii),
    Field("race_num",   25, 2,  F_ascii),
    # RACE_INFO の主要部分のみ抽出 (offset は RA と同じ)
    Field("race_name",  32, 60, F_sjis,  "競走名本題"),
    Field("race_name_short", 572, 20, F_sjis, "競走名略称10字"),
    Field("grade_code", 614, 1,  F_ascii),
    Field("distance",   636, 4,  F_int,   "距離"),
    Field("track_code", 640, 2,  F_ascii),
    Field("course_kbn", 642, 2,  F_ascii),
    Field("handi_date", 644, 8,  F_ascii, "ハンデ発表日"),
    Field("toroku_tosu",652, 3,  F_int,   "登録頭数 (TOKUUMA_INFO ループ回数の上限)"),
]

# TK の繰り返し領域: 300 頭分の TOKUUMA_INFO (70 バイト × 300 = 21000 バイト)
# offset = 656 - 1 = 655 (0-origin), element_len = 70
TK_TOKUUMA_LOOP = {
    "offset":      655,
    "element_len": 70,
    "max_count":   300,
    "count_field": "toroku_tosu",
}


# ─── HC レコード (ハロンタイム速報・坂路調教) 60 バイト ────
# SDK JV_HC_HANRO より転記。馬体重ではなく「坂路調教でのハロンタイム」。
HC_FIELDS: List[Field] = [
    Field("record_id",   0, 2,  F_ascii, "'HC'"),
    Field("data_kbn",    2, 1,  F_ascii),
    Field("make_date",   3, 8,  F_ascii),
    Field("tresen_kbn", 11, 1,  F_ascii, "トレセン区分 1美浦/2栗東"),
    Field("chokyo_date",12, 8,  F_ascii, "調教年月日 YYYYMMDD"),
    Field("chokyo_time",20, 4,  F_ascii, "調教時刻 HHMM"),
    Field("ketto_num",  24, 10, F_ascii, "血統登録番号"),
    Field("haron_4",    34, 4,  F_dec1,  "4ハロンタイム合計"),
    Field("lap_4",      38, 3,  F_dec1,  "ラップ800-600m"),
    Field("haron_3",    41, 4,  F_dec1,  "3ハロンタイム合計"),
    Field("lap_3",      45, 3,  F_dec1,  "ラップ600-400m"),
    Field("haron_2",    48, 4,  F_dec1,  "2ハロンタイム合計"),
    Field("lap_2",      52, 3,  F_dec1,  "ラップ400-200m"),
    Field("lap_1",      55, 3,  F_dec1,  "ラップ200-0m"),
]


# ─── WC レコード (ウッドチップ調教) 105 バイト ────────────
# SDK JV_WC_WOOD より転記。最長 2000m 〜 各ハロンのタイム。
WC_FIELDS: List[Field] = [
    Field("record_id",   0, 2,  F_ascii, "'WC'"),
    Field("data_kbn",    2, 1,  F_ascii),
    Field("make_date",   3, 8,  F_ascii),
    Field("tresen_kbn", 11, 1,  F_ascii),
    Field("chokyo_date",12, 8,  F_ascii),
    Field("chokyo_time",20, 4,  F_ascii),
    Field("ketto_num",  24, 10, F_ascii),
    Field("course",     34, 1,  F_ascii, "コース"),
    Field("baba_around",35, 1,  F_ascii, "馬場周り"),
    Field("haron_10",   37, 4,  F_dec1,  "10ハロンタイム"),
    Field("lap_10",     41, 3,  F_dec1),
    Field("haron_9",    44, 4,  F_dec1),
    Field("lap_9",      48, 3,  F_dec1),
    Field("haron_8",    51, 4,  F_dec1),
    Field("lap_8",      55, 3,  F_dec1),
    Field("haron_7",    58, 4,  F_dec1),
    Field("lap_7",      62, 3,  F_dec1),
    Field("haron_6",    65, 4,  F_dec1),
    Field("lap_6",      69, 3,  F_dec1),
    Field("haron_5",    72, 4,  F_dec1),
    Field("lap_5",      76, 3,  F_dec1),
    Field("haron_4",    79, 4,  F_dec1),
]


# ─── YS レコード (年間スケジュール・重賞日程) 382 バイト ──
# SDK JV_YS_SCHEDULE より転記。各日に最大 3 つの重賞 (JYUSYO_INFO×3) を持つ。
# ヘッダ部分のみ。重賞情報の繰り返し領域は YS_JYUSYO_LOOP で対応。
YS_FIELDS: List[Field] = [
    Field("record_id",   0, 2,  F_ascii, "'YS'"),
    Field("data_kbn",    2, 1,  F_ascii),
    Field("make_date",   3, 8,  F_ascii),
    # RACE_ID2 (14 バイト・raceNum 無し)
    Field("year",       11, 4,  F_ascii),
    Field("month_day",  15, 4,  F_ascii),
    Field("jyo_code",   19, 2,  F_ascii),
    Field("kai_ji",     21, 2,  F_ascii),
    Field("nichi_ji",   23, 2,  F_ascii),
    Field("youbi_code", 25, 1,  F_ascii, "曜日コード"),
]

# YS の繰り返し領域: 3 つの重賞案内 (JYUSYO_INFO × 3 / 各 118 バイト)
# offset = 27 - 1 = 26
YS_JYUSYO_LOOP = {
    "offset":      26,
    "element_len": 118,
    "max_count":   3,
}


# ─── JG レコード (除外馬・出走取消馬) 80 バイト ────────────
# SDK JV_JG_JOGAIBA より転記。明日のレース前に「除外された馬」のリスト。
JG_FIELDS: List[Field] = [
    Field("record_id",     0, 2,  F_ascii, "'JG'"),
    Field("data_kbn",      2, 1,  F_ascii),
    Field("make_date",     3, 8,  F_ascii),
    Field("year",         11, 4,  F_ascii),
    Field("month_day",    15, 4,  F_ascii),
    Field("jyo_code",     19, 2,  F_ascii),
    Field("kai_ji",       21, 2,  F_ascii),
    Field("nichi_ji",     23, 2,  F_ascii),
    Field("race_num",     25, 2,  F_ascii),
    Field("ketto_num",    27, 10, F_ascii, "血統登録番号"),
    Field("horse_name",   37, 36, F_sjis,  "馬名"),
    Field("tohyo_jun",    73, 3,  F_int,   "出馬投票受付順番"),
    Field("shusso_kbn",   76, 1,  F_ascii, "出走区分"),
    Field("jogai_jotai",  77, 1,  F_ascii, "除外状態区分"),
]


# ─── レコード種別 ID → フィールド定義 の登録簿 ──────────
RECORD_REGISTRY: Dict[str, List[Field]] = {
    "RA": RA_FIELDS,
    "SE": SE_FIELDS,
    "O1": O1_FIELDS,
    "HR": HR_FIELDS,
    "JG": JG_FIELDS,
    "TK": TK_FIELDS,
    "HC": HC_FIELDS,
    "WC": WC_FIELDS,
    "YS": YS_FIELDS,
}


# 仕様書 4.9.0.1 から SDK C# 構造体経由で正式転記済み (2026-05-15)
RECORD_COMPLETED: Dict[str, bool] = {
    "RA": True,
    "SE": True,
    "O1": True,
    "HR": True,
    "JG": True,
    "TK": True,
    "HC": True,
    "WC": True,
    "YS": True,
}


# TOKUUMA_INFO (TK レコードの繰り返し要素・1頭分 70 バイト)
# parse.py の parse_loop で利用される。
TOKUUMA_INFO_FIELDS: List[Field] = [
    Field("num",                0, 3,  F_int,   "連番"),
    Field("ketto_num",          3, 10, F_ascii, "血統登録番号"),
    Field("horse_name",        13, 36, F_sjis,  "馬名"),
    Field("uma_kigo",          49, 2,  F_ascii),
    Field("sex_code",          51, 1,  F_ascii, "1牡/2牝/3セ"),
    Field("tozai_code",        52, 1,  F_ascii, "調教師東西所属"),
    Field("chokyosi_code",     53, 5,  F_ascii),
    Field("trainer_name",      58, 8,  F_sjis,  "調教師名略称8字"),
    Field("burden_kg",         66, 3,  F_dec1,  "斤量"),
    Field("koryu",             69, 1,  F_ascii, "交流区分"),
]


def parse_tokuuma_element(elem: bytes) -> Dict[str, Any]:
    """TOKUUMA_INFO 1 要素 (70 バイト) を dict に。空馬番なら None を返す。"""
    from . import io_helpers as io
    if not elem or len(elem) < 13:
        return None
    out = {}
    for f in TOKUUMA_INFO_FIELDS:
        chunk = io.slice_field(elem, f.offset, f.length)
        out[f.name] = f.convert(chunk) if chunk else None
    # num が無効・空なら未登録枠とみなして None
    if not out.get("num"):
        return None
    return out


def known_records() -> List[str]:
    return list(RECORD_REGISTRY.keys())


def is_completed(record_id: str) -> bool:
    return bool(RECORD_COMPLETED.get(record_id, False))
