# -*- coding: utf-8 -*-
"""合成バイナリで E2E 動作確認 (仕様書なしで全部走る)。

目的: JRA-VAN の月額契約をする前に、「仕様書が来てフィールドを埋めた瞬間に
全部繋がる」ことを保証する。

カバーするフロー:
  1. 単勝オッズ繰り返し領域 (O1) を bytes 化 → parse_loop で復元
  2. 復元結果 + 合成 RA + 合成 SE で race JSON を組み立て
  3. 合成 HR の raw bytes + payout_offsets で results JSON を組み立て
  4. races/*.json + results/*.json を aggregate_features に食わせて features.json を生成
  5. features.json を読み込んで JS 側 augmentWithJvFeatures が読める形か検証
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from jv_bridge import parse, aggregate_features as agg
from jv_bridge import build_result_json as br


# ── 合成バイナリ生成 ───────────────────────────────────────

def make_win_odds_buf(odds_table):
    """{馬番: (オッズ×10, 人気)} → 単勝オッズの繰り返し領域 bytes"""
    out = b""
    for num, (odds_x10, pop) in odds_table.items():
        out += f"{num:02d}".encode("ascii")
        out += f"{odds_x10:04d}".encode("ascii")
        out += f"{pop:02d}".encode("ascii")
    return out


def make_single_payout(num, amount, pop, key_len=2, amount_len=9, pop_len=2):
    """1 件の払戻ブロック bytes (key + amount + popularity)"""
    return (
        f"{num:0{key_len}d}".encode("ascii") +
        f"{amount:0{amount_len}d}".encode("ascii") +
        f"{pop:0{pop_len}d}".encode("ascii")
    )


# ── 1: 単勝オッズ繰り返し復元 ─────────────────────────────

def test_synthetic_win_odds_roundtrip():
    buf = make_win_odds_buf({1: (15, 1), 2: (23, 2), 3: (48, 4), 4: (99, 6)})
    out = parse.parse_loop(buf, offset=0, element_len=8, count=4,
                           parse_element=parse.parse_win_odds_element)
    assert len(out) == 4
    by_num = {o["number"]: o for o in out}
    assert by_num[1]["odds"] == 1.5
    assert by_num[3]["odds"] == 4.8
    assert by_num[4]["popularity"] == 6


# ── 2: HR 払戻 (単勝) 復元 ─────────────────────────────────

def test_synthetic_hr_payout_single_win():
    # 単勝 1 通り (13 バイト): 馬番 06 / 払戻 1800 / 人気 03
    buf = make_single_payout(6, 1800, 3)
    out = br.parse_payout_block(buf, 0, count=1, key_len=2, amount_len=9, pop_len=2)
    assert len(out) == 1
    assert out[0]["amount"] == 1800
    assert out[0]["key"] == "6"


# ── 3: HR の確実な券種 (単勝/複勝) を offset テーブル経由で復元 ──

def test_synthetic_hr_tan_fuku_via_layout():
    """単勝・複勝は構造が確実 (key_len=2)。offset テーブルから組み立てる。

    HR_PAYOUT_LAYOUT は単勝 count=3 / 複勝 count=5 を想定するので、
    同着が無い時は残り枠を 0 埋め (馬番=0) で渡す。
    馬連・ワイド・三連単などは仕様書転記後に HR_PAYOUT_LAYOUT に追記して
    動くようになる。本テストではそれらが空配列で返ることも確認する。
    """
    # 単勝 (key_len=2 / amount_len=9 / pop_len=2 / count=3) = 13 × 3 = 39 バイト
    tan_real = make_single_payout(6, 1800, 3)
    tan_zero = b"00" + b"000000000" + b"00"   # 13 バイトの 0 埋め
    tan = tan_real + tan_zero + tan_zero      # 1 件のみ有効

    # 複勝 (count=5) = 13 × 5 = 65 バイト
    fuku_real = (make_single_payout(6, 350, 3) +
                 make_single_payout(3, 220, 2) +
                 make_single_payout(4, 180, 5))
    fuku = fuku_real + tan_zero + tan_zero    # 3 件のみ有効

    buf = tan + fuku
    offsets = {"tan": 0, "fuku": len(tan)}
    parsed = br.parse_hr_payouts(buf, offsets)

    # 単勝は 1 件だけ (残り 2 枠は amount=0 でスキップ)
    assert len(parsed["tan"]) == 1
    assert parsed["tan"][0]["amount"] == 1800
    assert parsed["tan"][0]["key"] == "6"

    # 複勝 3 件
    assert len(parsed["fuku"]) == 3
    by_num = {int(p["key"]): p["amount"] for p in parsed["fuku"]}
    assert by_num[6] == 350
    assert by_num[3] == 220
    assert by_num[4] == 180

    # 馬連・三連単などはレイアウト未確定 → 空配列で返る (落とさない)
    assert parsed["uren"] == []
    assert parsed["tan3"] == []


def test_synthetic_hr_tan3_via_layout_override():
    """3 連単 (key_len=8, amount_len=10, pop_len=3) のパースは layout_override で先取り可能。

    仕様書転記時に HR_PAYOUT_LAYOUT["tan3"] が確定する前でも、上書きを渡せば動く。
    """
    # 3 連単 1 通り = key 8 + amount 10 + pop 3 = 21 バイト
    # 組番 '00060301' (=00,06,03,01 → 6,3,1) / 払戻 0000012450 (=12450) / 人気 025
    tan3 = b"00060301" + b"0000012450" + b"025"
    buf = tan3 + b"\x00" * 100

    offsets = {"tan3": 0}
    override = {"tan3": {"count": 1, "key_len": 8, "amount_len": 10, "pop_len": 3}}
    parsed = br.parse_hr_payouts(buf, offsets, layout_override=override)
    assert len(parsed["tan3"]) == 1
    assert parsed["tan3"][0]["key"] == "6-3-1"
    assert parsed["tan3"][0]["amount"] == 12450


# ── 4: 集計 → features.json → JS 形式 ──────────────────────

def test_synthetic_e2e_pipeline_to_features_json(tmp_path, monkeypatch):
    """合成 race JSON + result JSON から features.json を作る一気通貫テスト。

    JV-Link の仕様書転記が完了して RA/SE/HR から build_race_json.py /
    build_result_json.py が書き出した形を、ここでは直接 JSON で再現する。
    """
    cache = tmp_path / "jv_cache"
    races_dir = cache / "races"
    results_dir = cache / "results"
    races_dir.mkdir(parents=True)
    results_dir.mkdir(parents=True)
    feats_path = cache / "features.json"

    # 5 レース全部で「ルメール+国枝」が 1 着・「武豊+藤原」が 4 着
    # race_id は本番の 18 桁形式 (lib/race_id.js JRA_18DIGIT 互換)
    for i in range(5):
        rid = f"2026050305020{i+1:03d}00"
        race = {
            "race_id": rid,
            "race_name": f"テスト{i+1}R",
            "course": "東京芝1600",
            "surface": "芝",
            "distance": 1600,
            "going": "良",
            "horses": [
                {"number": 1, "name": f"H{i}_1", "jockey": "ルメール", "trainer": "国枝",
                 "weight_diff": 2, "popularity": 1},
                {"number": 2, "name": f"H{i}_2", "jockey": "武豊",     "trainer": "藤原",
                 "weight_diff": -4, "popularity": 5},
                {"number": 3, "name": f"H{i}_3", "jockey": "川田",     "trainer": "矢作",
                 "weight_diff": 0, "popularity": 2},
                {"number": 4, "name": f"H{i}_4", "jockey": "戸崎",     "trainer": "鹿戸",
                 "weight_diff": 6, "popularity": 8},
            ],
        }
        (races_dir / f"{rid}.json").write_text(json.dumps(race, ensure_ascii=False), encoding="utf-8")

        result = {
            "race_id": rid,
            "results": [
                {"rank": 1, "number": 1, "name": f"H{i}_1"},
                {"rank": 2, "number": 3, "name": f"H{i}_3"},
                {"rank": 3, "number": 4, "name": f"H{i}_4"},
                {"rank": 4, "number": 2, "name": f"H{i}_2"},
            ],
            "payouts": {
                "tan":  {"winner": 1, "amount": 250},
                "fuku": [{"number": 1, "amount": 110}],
                "uren": {"key": "1-3", "amount": 380},
            },
        }
        (results_dir / f"{rid}.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")

    monkeypatch.setattr(agg, "CACHE_DIR", cache)
    monkeypatch.setattr(agg, "RACES_DIR", races_dir)
    monkeypatch.setattr(agg, "RESULTS_DIR", results_dir)
    monkeypatch.setattr(agg, "FEATURES_PATH", feats_path)
    monkeypatch.setattr(sys, "argv", ["aggregate_features.py"])

    rc = agg.main()
    assert rc == 0
    assert feats_path.exists()

    data = json.loads(feats_path.read_text(encoding="utf-8"))
    # ルメールは 5/5 勝 (大サンプル相当ではないが縮約後でも武豊より高い)
    race_id = "202605030502000100"
    assert race_id in data
    h1 = data[race_id]["1"]   # ルメール+国枝
    h2 = data[race_id]["2"]   # 武豊+藤原
    assert h1["jockeyWinRate"] > h2["jockeyWinRate"]
    assert h1["trainerWinRate"] > h2["trainerWinRate"]
    # 馬体重前走比が透過されている (合成 race の weight_diff: 2)
    assert h1.get("weightChange") == 2
    # surface 別勝率も乗っている
    assert "surfaceWinRate" in h1
