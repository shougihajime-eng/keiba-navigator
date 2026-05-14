# -*- coding: utf-8 -*-
"""
aggregate_features.py — JV-Link データ集計バッチ
=================================================

役割:
    過去レース (RA + SE + HR) を横断走査して、AI が必要とする特徴量を集計し、
    data/jv_cache/features.json に書き出す。

    出力フォーマットは predictors/jv_link_features.js (line 13) が期待する形:
        {
          "<raceId>": {
            "<horseNumber>": {
              "jockeyWinRate":   0.18,
              "trainerWinRate":  0.12,
              "courseWinRate":   0.15,
              "distanceWinRate": 0.21,
              "surfaceWinRate":  0.17,
              "goingWinRate":    0.14,
              "weightChange":    -2,
              "daysFromLastRace": 28,
              "last3F":          34.2,
              "bestTime":        93.7,
              "pedigreeSurfaceAff": 0.78,
              "trainingScore":   0.5
            }
          }
        }

    オプション: Supabase 集計テーブル (keiba.jockey_stats 等) にも UPSERT する。
    Supabase 反映には service_role キーが必要 (環境変数 SUPABASE_SERVICE_ROLE_KEY)。

設計上の前提 (今後の transcription 完了を待たずに動く骨組み):
    ・jvdata_struct.py の RECORD_COMPLETED が全部 False のうちは、
      パース済データが空っぽなので features.json も空オブジェクトを出して終わる。
    ・仕様書転記 (RA/SE/HR の offset) が完了すれば、即この集計が走る。
    ・既存の build_race_json.py / build_result_json.py が出力した JSON 形式
      (data/jv_cache/races/*.json, data/jv_cache/results/*.json) を入力に使う。

使い方:
    py -3 jv_bridge\aggregate_features.py
    py -3 jv_bridge\aggregate_features.py --push-supabase   (Supabase へも反映)

注意 (JRA-VAN 規約):
    集計結果 (勝率・回数のような数値) のみを出力する。
    馬名・騎手名は集計のキーとして使うが、
    生のレースデータ (タイム・払戻等の元値) を公開リポジトリに含めない。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = REPO_ROOT / "data" / "jv_cache"
RACES_DIR = CACHE_DIR / "races"
RESULTS_DIR = CACHE_DIR / "results"
FEATURES_PATH = CACHE_DIR / "features.json"

DEFAULT_BASELINE_WIN_RATE = 0.10
MIN_SAMPLES_FOR_RATE = 5           # この数未満ではベースラインに収縮させる
SHRINKAGE_K = 20                    # ベイジアン縮約の強さ


# ── 1. 入力ファイル読み込み ───────────────────────────────────

def load_race(path: Path) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_all_races() -> List[Dict[str, Any]]:
    if not RACES_DIR.exists():
        return []
    out = []
    for p in sorted(RACES_DIR.glob("*.json")):
        r = load_race(p)
        if r:
            if isinstance(r, list):
                out.extend(r)
            else:
                out.append(r)
    return out


def load_result(race_id: str) -> Optional[Dict[str, Any]]:
    p = RESULTS_DIR / f"{race_id}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


# ── 2. 1 件のレース結果から「誰が勝ったか」を読む ─────────────

def winners_of(result: Dict[str, Any]) -> Dict[int, bool]:
    """馬番 → True/False (1着なら True)"""
    out: Dict[int, bool] = {}
    for r in (result.get("results") or []):
        num = r.get("number")
        rank = r.get("rank")
        if isinstance(num, int) and isinstance(rank, int):
            out[num] = (rank == 1)
    return out


def in_three_of(result: Dict[str, Any]) -> Dict[int, bool]:
    """馬番 → True/False (3着以内なら True)"""
    out: Dict[int, bool] = {}
    for r in (result.get("results") or []):
        num = r.get("number")
        rank = r.get("rank")
        if isinstance(num, int) and isinstance(rank, int):
            out[num] = (rank <= 3)
    return out


# ── 3. 集計バケット ─────────────────────────────────────────

class StatsBucket:
    """samples / wins を貯めて、ベイジアン縮約後の勝率を返す。"""
    __slots__ = ("samples", "wins")

    def __init__(self):
        self.samples = 0
        self.wins = 0

    def add(self, won: bool):
        self.samples += 1
        if won:
            self.wins += 1

    def rate(self, baseline: float = DEFAULT_BASELINE_WIN_RATE,
             k: int = SHRINKAGE_K) -> float:
        """サンプル数が少ない時はベースラインに縮約 (ゼロ除算を避ける)。"""
        if self.samples <= 0:
            return baseline
        # raw = wins / samples
        # smoothed = (samples * raw + k * baseline) / (samples + k)
        #         = (wins + k * baseline) / (samples + k)
        return (self.wins + k * baseline) / (self.samples + k)


# ── 4. 横断集計 ─────────────────────────────────────────────

def _course_short(race: Dict[str, Any]) -> str:
    """course 文字列から場名 2 文字を抜き出す。
    'East京芝1600' のような形式の先頭 2 文字 (= '東京' / '中山' 等) を返す。
    """
    c = race.get("course") or ""
    if not c:
        return ""
    return c[:2]


def aggregate(races: List[Dict[str, Any]]) -> Dict[str, Any]:
    """races 配列を全部読んで、各種勝率・複勝率を集計する。"""
    jockey: Dict[str, StatsBucket] = defaultdict(StatsBucket)
    trainer: Dict[str, StatsBucket] = defaultdict(StatsBucket)
    jockey_course: Dict[Tuple[str, str], StatsBucket] = defaultdict(StatsBucket)
    jockey_distance: Dict[Tuple[str, int], StatsBucket] = defaultdict(StatsBucket)
    jockey_surface: Dict[Tuple[str, str], StatsBucket] = defaultdict(StatsBucket)
    jockey_going: Dict[Tuple[str, str], StatsBucket] = defaultdict(StatsBucket)
    jockey_in_three: Dict[str, StatsBucket] = defaultdict(StatsBucket)     # 騎手の複勝率
    trainer_in_three: Dict[str, StatsBucket] = defaultdict(StatsBucket)    # 調教師の複勝率
    popularity_band: Dict[str, StatsBucket] = defaultdict(StatsBucket)     # 人気区分別
    horse_career: Dict[str, Dict[str, Any]] = {}

    n_races_with_result = 0

    for race in races:
        race_id = race.get("race_id") or race.get("raceId")
        if not race_id:
            continue
        result = load_result(race_id)
        if not result:
            continue
        won_map = winners_of(result)
        in3_map = in_three_of(result)
        if not won_map:
            continue
        n_races_with_result += 1

        course = _course_short(race)
        distance = race.get("distance")
        # build_race_json が出す surface ('芝'/'ダート'/'障害') を優先、無ければ legacy key
        surface = race.get("surface") or race.get("course_surface")
        going = race.get("going")

        for h in (race.get("horses") or []):
            num = h.get("number")
            if not isinstance(num, int):
                continue
            won = bool(won_map.get(num, False))
            in3 = bool(in3_map.get(num, False))
            j = h.get("jockey")
            tr = h.get("trainer")
            nm = h.get("name")
            pop = h.get("popularity")

            if j:
                jockey[j].add(won)
                jockey_in_three[j].add(in3)
                if course:    jockey_course[(j, course)].add(won)
                if isinstance(distance, int): jockey_distance[(j, distance)].add(won)
                if surface:   jockey_surface[(j, surface)].add(won)
                if going:     jockey_going[(j, going)].add(won)
            if tr:
                trainer[tr].add(won)
                trainer_in_three[tr].add(in3)
            if isinstance(pop, int):
                band = _popularity_band(pop)
                if band:
                    popularity_band[band].add(won)
            if nm:
                hc = horse_career.setdefault(nm, {"starts": 0, "wins": 0, "in_three": 0})
                hc["starts"] += 1
                if won: hc["wins"] += 1
                if in3: hc["in_three"] += 1

    return {
        "_meta": {
            "racesAnalyzed":     len(races),
            "resultsMatched":    n_races_with_result,
            "uniqueJockeys":     len(jockey),
            "uniqueTrainers":    len(trainer),
            "uniqueHorses":      len(horse_career),
            "popularityBands":   sorted(popularity_band.keys()),
            "generatedAt":       dt.datetime.now(dt.timezone.utc).isoformat(),
        },
        "jockey": jockey,
        "trainer": trainer,
        "jockey_course": jockey_course,
        "jockey_distance": jockey_distance,
        "jockey_surface": jockey_surface,
        "jockey_going": jockey_going,
        "jockey_in_three": jockey_in_three,
        "trainer_in_three": trainer_in_three,
        "popularity_band": popularity_band,
        "horse_career": horse_career,
    }


def _popularity_band(p: int) -> str:
    if p == 1: return "fav1"
    if p == 2: return "fav2"
    if p == 3: return "fav3"
    if p <= 5: return "fav4-5"
    if p <= 9: return "mid6-9"
    return "long10+"


# ── 5. 集計結果から features.json を組み立てる ───────────────

def build_features_json(races: List[Dict[str, Any]], stats: Dict[str, Any]) -> Dict[str, Any]:
    """各 (raceId, horseNumber) → 特徴量辞書 を組み立てる。

    JS 側 (predictors/heuristic_v1.js) が期待する key にそろえる:
        jockeyWinRate, trainerWinRate, courseWinRate, distanceWinRate,
        surfaceWinRate, goingWinRate, weightChange, daysFromLastRace,
        last3F, bestTime, pedigreeSurfaceAff, trainingScore
    複勝率: jockeyInThreeRate, trainerInThreeRate
    """
    out: Dict[str, Dict[str, Dict[str, Any]]] = {}
    jockey = stats["jockey"]
    trainer = stats["trainer"]
    jockey_course = stats["jockey_course"]
    jockey_distance = stats["jockey_distance"]
    jockey_surface = stats["jockey_surface"]
    jockey_going = stats["jockey_going"]
    jockey_in_three = stats.get("jockey_in_three", {})
    trainer_in_three = stats.get("trainer_in_three", {})

    for race in races:
        race_id = race.get("race_id") or race.get("raceId")
        if not race_id:
            continue
        course = (race.get("course") or "")[:2]
        distance = race.get("distance")
        surface = race.get("surface")
        going = race.get("going")

        per_horse: Dict[str, Dict[str, Any]] = {}
        for h in (race.get("horses") or []):
            num = h.get("number")
            if not isinstance(num, int):
                continue
            j = h.get("jockey")
            tr = h.get("trainer")

            feat: Dict[str, Any] = {}
            if j and j in jockey:
                feat["jockeyWinRate"] = round(jockey[j].rate(), 4)
            if j and j in jockey_in_three:
                # 複勝のベースラインは 0.30 (3着以内に入る確率の概算)
                feat["jockeyInThreeRate"] = round(jockey_in_three[j].rate(baseline=0.30), 4)
            if tr and tr in trainer:
                feat["trainerWinRate"] = round(trainer[tr].rate(), 4)
            if tr and tr in trainer_in_three:
                feat["trainerInThreeRate"] = round(trainer_in_three[tr].rate(baseline=0.30), 4)
            if j and course and (j, course) in jockey_course:
                feat["courseWinRate"] = round(jockey_course[(j, course)].rate(), 4)
            if j and isinstance(distance, int) and (j, distance) in jockey_distance:
                feat["distanceWinRate"] = round(jockey_distance[(j, distance)].rate(), 4)
            if j and surface and (j, surface) in jockey_surface:
                feat["surfaceWinRate"] = round(jockey_surface[(j, surface)].rate(), 4)
            if j and going and (j, going) in jockey_going:
                feat["goingWinRate"] = round(jockey_going[(j, going)].rate(), 4)

            # weightChange (馬体重前走比)、daysFromLastRace は SE 個別フィールドから取れる
            if isinstance(h.get("weight_diff"), (int, float)):
                feat["weightChange"] = h["weight_diff"]
            # daysFromLastRace / last3F / bestTime / pedigreeSurfaceAff / trainingScore
            # は仕様書転記後に SE / UM レコードから抽出する (現状未実装)

            if feat:
                per_horse[str(num)] = feat
        if per_horse:
            out[race_id] = per_horse
    return out


# ── 6. (任意) Supabase 集計テーブルに UPSERT ─────────────────

def push_to_supabase(stats: Dict[str, Any]) -> int:
    """SUPABASE_SERVICE_ROLE_KEY 必須。インポート失敗時は 0 を返してスキップ。"""
    try:
        from supabase import create_client            # type: ignore
    except ImportError:
        print("[skip] supabase-py 未導入。 pip install supabase でインストールしてください。")
        return 0
    url = os.environ.get("SUPABASE_URL", "https://eqkaaohdbqefuszxwqzr.supabase.co")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        print("[skip] SUPABASE_SERVICE_ROLE_KEY が未設定。Supabase 反映をスキップします。")
        return 0
    client = create_client(url, key)
    n = 0

    # jockey_stats (全場合算行のみ。場・距離別は省略 — 必要になったら拡張)
    rows = []
    for name, bucket in stats["jockey"].items():
        rows.append({
            "jockey_name": name,
            "course_code": None, "distance": None, "surface": None,
            "samples": bucket.samples,
            "wins":    bucket.wins,
        })
    if rows:
        client.schema("keiba").table("jockey_stats").upsert(rows).execute()
        n += len(rows)

    rows = []
    for name, bucket in stats["trainer"].items():
        rows.append({
            "trainer_name": name,
            "course_code": None, "distance": None, "surface": None,
            "samples": bucket.samples,
            "wins":    bucket.wins,
        })
    if rows:
        client.schema("keiba").table("trainer_stats").upsert(rows).execute()
        n += len(rows)

    rows = []
    for name, hc in stats["horse_career"].items():
        rows.append({
            "horse_name":     name,
            "total_starts":   hc["starts"],
            "total_wins":     hc["wins"],
            "total_in_three": hc.get("in_three", 0),
        })
    if rows:
        client.schema("keiba").table("horse_career").upsert(rows).execute()
        n += len(rows)

    # aggregate_meta
    today = dt.date.today().isoformat()
    client.schema("keiba").table("aggregate_meta").upsert([
        {"key": "jockey_stats",  "last_run_at": dt.datetime.now(dt.timezone.utc).isoformat(),
         "source_from": None, "source_to": today, "row_count": len(stats["jockey"])},
        {"key": "trainer_stats", "last_run_at": dt.datetime.now(dt.timezone.utc).isoformat(),
         "source_from": None, "source_to": today, "row_count": len(stats["trainer"])},
        {"key": "horse_career",  "last_run_at": dt.datetime.now(dt.timezone.utc).isoformat(),
         "source_from": None, "source_to": today, "row_count": len(stats["horse_career"])},
    ]).execute()
    return n


# ── 7. CLI ───────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="JV-Link データ集計バッチ")
    ap.add_argument("--push-supabase", action="store_true",
                    help="Supabase 集計テーブルにも反映 (SUPABASE_SERVICE_ROLE_KEY 必須)")
    ap.add_argument("--dry-run", action="store_true", help="features.json を書かずに集計件数だけ表示")
    args = ap.parse_args()

    races = load_all_races()
    if not races:
        print("[info] data/jv_cache/races/ にレースデータがありません。")
        print("       JV-Link aggregate モードで過去レースを取得してから再実行してください。")
        # 空でも features.json は出しておく (JS 側で読み込みエラーを起こさないため)
        if not args.dry_run:
            FEATURES_PATH.parent.mkdir(parents=True, exist_ok=True)
            FEATURES_PATH.write_text(json.dumps(
                {"_meta": {"empty": True, "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat()}},
                ensure_ascii=False, indent=2,
            ), encoding="utf-8")
        return 0

    stats = aggregate(races)
    feats = build_features_json(races, stats)
    out = {
        "_meta": stats["_meta"],
        **feats,
    }
    print(f"[ok] レース {stats['_meta']['racesAnalyzed']} 件 / 結果突合 {stats['_meta']['resultsMatched']} 件")
    print(f"     騎手 {stats['_meta']['uniqueJockeys']}人 / 調教師 {stats['_meta']['uniqueTrainers']}人 / 馬 {stats['_meta']['uniqueHorses']}頭")

    if not args.dry_run:
        FEATURES_PATH.parent.mkdir(parents=True, exist_ok=True)
        FEATURES_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[write] {FEATURES_PATH} ({FEATURES_PATH.stat().st_size:,} bytes)")

    if args.push_supabase:
        n = push_to_supabase(stats)
        print(f"[supabase] {n} 行 UPSERT")

    return 0


if __name__ == "__main__":
    sys.exit(main())
