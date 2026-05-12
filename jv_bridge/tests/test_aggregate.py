# -*- coding: utf-8 -*-
"""
aggregate_features.py の smoke テスト。

仕様書転記前 (fixtures に実データが無い段階) でも:
  - クラッシュしないこと
  - 空入力 → 空 features.json を吐けること
  - 騎手・調教師の集計ロジックがベイジアン縮約後に妥当な値を返すこと
を保証する。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from jv_bridge import aggregate_features as agg


# ── 1. ベイジアン縮約 ────────────────────────────────────────

def test_stats_bucket_empty_returns_baseline():
    b = agg.StatsBucket()
    # sample=0 → ベースライン (=0.10) が返る
    assert b.rate() == pytest.approx(0.10, abs=1e-9)


def test_stats_bucket_small_sample_shrunk_to_baseline():
    b = agg.StatsBucket()
    # 5 戦 5 勝でも、k=20 のベイジアン縮約で 0.5 にはならず、もっと低い値になる
    for _ in range(5):
        b.add(True)
    rate = b.rate()
    assert 0.10 < rate < 0.50, f"shrinkage が効いていない: {rate}"


def test_stats_bucket_large_sample_converges_to_raw():
    b = agg.StatsBucket()
    # 500 戦 100 勝 (raw=0.20) → 縮約後もほぼ 0.20 に収束する
    for _ in range(100): b.add(True)
    for _ in range(400): b.add(False)
    rate = b.rate()
    assert abs(rate - 0.20) < 0.01, f"大サンプルなのに縮約しすぎ: {rate}"


# ── 2. 横断集計 (合成データ) ─────────────────────────────────

def _mk_race(race_id: str, horses: list) -> dict:
    return {
        "race_id": race_id,
        "course": "東京",
        "distance": 1600,
        "surface": "芝",
        "going": "良",
        "horses": horses,
    }

def _mk_result(race_id: str, results: list) -> dict:
    return {"race_id": race_id, "results": results}


def test_aggregate_basic_jockey_win_rate(tmp_path, monkeypatch):
    """3 レース全部で同じ騎手が勝てば、その騎手の勝率は高く出る。"""
    # 一時 cache ディレクトリを差し替え
    cache = tmp_path / "jv_cache"
    races_dir = cache / "races"
    results_dir = cache / "results"
    races_dir.mkdir(parents=True)
    results_dir.mkdir(parents=True)

    for i in range(3):
        rid = f"R{i:02d}"
        race = _mk_race(rid, [
            {"number": 1, "name": f"horse_{i}_1", "jockey": "ルメール", "trainer": "国枝"},
            {"number": 2, "name": f"horse_{i}_2", "jockey": "武豊",   "trainer": "藤原"},
            {"number": 3, "name": f"horse_{i}_3", "jockey": "川田",   "trainer": "矢作"},
        ])
        (races_dir / f"{rid}.json").write_text(json.dumps(race, ensure_ascii=False), encoding="utf-8")
        result = _mk_result(rid, [
            {"rank": 1, "number": 1}, {"rank": 2, "number": 2}, {"rank": 3, "number": 3},
        ])
        (results_dir / f"{rid}.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")

    monkeypatch.setattr(agg, "CACHE_DIR", cache)
    monkeypatch.setattr(agg, "RACES_DIR", races_dir)
    monkeypatch.setattr(agg, "RESULTS_DIR", results_dir)

    races = agg.load_all_races()
    assert len(races) == 3
    stats = agg.aggregate(races)
    assert stats["_meta"]["resultsMatched"] == 3
    # ルメールの勝率は他の騎手より高い
    rate_lemaire = stats["jockey"]["ルメール"].rate()
    rate_take    = stats["jockey"]["武豊"].rate()
    assert rate_lemaire > rate_take


def test_aggregate_handles_missing_results_gracefully(tmp_path, monkeypatch):
    """結果データが無いレースはスキップされる (KeyError 等を投げない)。"""
    cache = tmp_path / "jv_cache"
    races_dir = cache / "races"
    results_dir = cache / "results"
    races_dir.mkdir(parents=True)
    results_dir.mkdir(parents=True)

    (races_dir / "R01.json").write_text(json.dumps(_mk_race("R01", [
        {"number": 1, "jockey": "X", "trainer": "Y"},
    ]), ensure_ascii=False), encoding="utf-8")
    # results は意図的に書かない

    monkeypatch.setattr(agg, "CACHE_DIR", cache)
    monkeypatch.setattr(agg, "RACES_DIR", races_dir)
    monkeypatch.setattr(agg, "RESULTS_DIR", results_dir)

    races = agg.load_all_races()
    stats = agg.aggregate(races)
    assert stats["_meta"]["resultsMatched"] == 0
    assert stats["_meta"]["uniqueJockeys"] == 0  # 集計対象から外れる


def test_build_features_json_shape(tmp_path, monkeypatch):
    """build_features_json の出力が predictors/jv_link_features.js が期待する形か。"""
    cache = tmp_path / "jv_cache"
    races_dir = cache / "races"
    results_dir = cache / "results"
    races_dir.mkdir(parents=True)
    results_dir.mkdir(parents=True)

    race = _mk_race("R01", [
        {"number": 1, "name": "Hayate",  "jockey": "ルメール", "trainer": "国枝"},
        {"number": 2, "name": "Subaru", "jockey": "武豊",     "trainer": "藤原"},
    ])
    (races_dir / "R01.json").write_text(json.dumps(race, ensure_ascii=False), encoding="utf-8")
    result = _mk_result("R01", [
        {"rank": 1, "number": 1}, {"rank": 2, "number": 2},
    ])
    (results_dir / "R01.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")

    monkeypatch.setattr(agg, "CACHE_DIR", cache)
    monkeypatch.setattr(agg, "RACES_DIR", races_dir)
    monkeypatch.setattr(agg, "RESULTS_DIR", results_dir)

    races = agg.load_all_races()
    stats = agg.aggregate(races)
    feats = agg.build_features_json(races, stats)

    # 形式: {raceId: {horseNumber(str): {jockeyWinRate, ...}}}
    assert "R01" in feats
    assert "1" in feats["R01"]
    h1 = feats["R01"]["1"]
    assert "jockeyWinRate" in h1
    assert isinstance(h1["jockeyWinRate"], float)
    assert 0 <= h1["jockeyWinRate"] <= 1


def test_main_empty_cache_writes_empty_features(tmp_path, monkeypatch):
    """data/jv_cache/races/ が空でも features.json を空オブジェクトで作る。"""
    cache = tmp_path / "jv_cache"
    cache.mkdir(parents=True)
    feats_path = cache / "features.json"

    monkeypatch.setattr(agg, "CACHE_DIR", cache)
    monkeypatch.setattr(agg, "RACES_DIR", cache / "races")
    monkeypatch.setattr(agg, "RESULTS_DIR", cache / "results")
    monkeypatch.setattr(agg, "FEATURES_PATH", feats_path)
    # CLI フラグを sys.argv 経由で渡す
    monkeypatch.setattr(sys, "argv", ["aggregate_features.py"])

    rc = agg.main()
    assert rc == 0
    assert feats_path.exists()
    data = json.loads(feats_path.read_text(encoding="utf-8"))
    assert data.get("_meta", {}).get("empty") is True
