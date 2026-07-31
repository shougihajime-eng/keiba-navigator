# -*- coding: utf-8 -*-
"""
aggregate_features_v2.py — 時系列リーク排除版の特徴量集計

旧 aggregate_features.py は「全レース通算」で勝率を計算するため、
train 期間と test 期間の両方の結果が混ざる look-ahead leakage が発生していた
(初代モデル AUC=0.955 は完全に leakage 由来)。

このバージョンは、各 (race_id, horse_num) について
「当該レース直前までに観測された情報だけ」で特徴量を計算する。
時系列で race_id 昇順に走査し、対象レースの特徴量を出した後で
そのレースの結果を「過去」に追加する設計。

新たに追加した馬個別の過去成績:
  horseAvgLast3F:      直近 5 走の上がり 3F 中央値
  horseAvgPos4c:       直近 5 走の 4 コーナー通過順平均
  horseRunStyleMode:   直近 5 走の脚質最頻 (1-5)
  horsePrevFinish:     直前 1 走の確定着順
  horseDaysSinceLast:  直前 1 走からの経過日数
  horseAvgFinish:      直近 5 走の着順平均

使い方:
  py -3 jv_bridge\\aggregate_features_v2.py
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# 🚨 2026-07-31 修正: Windows の既定 cp932 では、フォルダ名の絵文字 (７📦そのほか の 📦)
#   を print() できず UnicodeEncodeError で即落ちする。
#   集計とファイル書き出しは終わっているのに、最後の「[write] <パス>」を表示する所だけで
#   落ちて exit=1 になり、KeibaGapFill-0800 が毎日「失敗(0x18)」と報告していた
#   (2026-07-19 のフォルダ移動以降ずっと)。
#   → race_day_pipeline.py と同じやり方で標準出力を UTF-8 に作り直す。
#   ※集計の中身・数字には一切さわらない (表示の文字コードだけ)。
for _stream_name in ("stdout", "stderr"):
    _stream = getattr(sys, _stream_name, None)
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE = ROOT / "data" / "jv_cache"
RACES_DIR = CACHE / "races"
RESULTS_DIR = CACHE / "results"
FEATURES_PATH = CACHE / "features.json"

JOCKEY_BASELINE_WIN = 0.075
JOCKEY_BASELINE_IN3 = 0.30
TRAINER_BASELINE_WIN = 0.075
TRAINER_BASELINE_IN3 = 0.30
HORSE_BASELINE_WIN = 0.10
HORSE_BASELINE_IN3 = 0.30
SHRINKAGE_K = 20


def _parse_race_date(race_id: str) -> Optional[dt.date]:
    """race_id 18 桁の先頭 8 文字 (YYYYMMDD) から日付。"""
    if not race_id or len(race_id) < 8 or not race_id[:8].isdigit():
        return None
    try:
        return dt.date(int(race_id[:4]), int(race_id[4:6]), int(race_id[6:8]))
    except ValueError:
        return None


def _course_short(race: Dict[str, Any]) -> str:
    c = race.get("course") or ""
    return c[:2] if c else ""


def _shrunk_rate(wins: int, samples: int, baseline: float, k: int = SHRINKAGE_K) -> float:
    if samples <= 0:
        return baseline
    return (wins + k * baseline) / (samples + k)


def load_all() -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    races = []
    results = {}
    if not RACES_DIR.exists():
        return [], {}
    for p in sorted(RACES_DIR.glob("*.json")):
        try:
            races.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            continue
    for p in sorted(RESULTS_DIR.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            rid = data.get("race_id") or p.stem
            results[rid] = data
        except Exception:
            continue
    return races, results


def _winners_in_three(result: Dict[str, Any]) -> Tuple[Dict[int, bool], Dict[int, bool]]:
    won_map, in3_map = {}, {}
    for r in (result.get("results") or []):
        num = r.get("number")
        rank = r.get("rank")
        if isinstance(num, int) and isinstance(rank, int):
            won_map[num] = (rank == 1)
            in3_map[num] = (rank <= 3)
    return won_map, in3_map


def build_features() -> Dict[str, Any]:
    races, results = load_all()
    if not races:
        return {"_meta": {"empty": True, "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat()}}

    # race_id 昇順 = 時系列昇順 (race_id は YYYYMMDD で始まる)
    races_sorted = sorted(races, key=lambda r: r.get("race_id") or "")

    # 時系列で観測された past records (累積カウンタ・過去履歴)
    jockey_acc: Dict[str, Dict[str, int]] = defaultdict(lambda: {"s": 0, "w": 0, "i": 0})
    trainer_acc: Dict[str, Dict[str, int]] = defaultdict(lambda: {"s": 0, "w": 0, "i": 0})
    horse_acc: Dict[str, Dict[str, int]] = defaultdict(lambda: {"s": 0, "w": 0, "i": 0})
    horse_prize_acc: Dict[str, int] = defaultdict(int)  # 馬名 → 過去レースの honsyokin 累計 (百円単位)

    # (jockey, course/distance/surface/going) 別の累積 - 主要 4 種類のみ
    jockey_course_acc: Dict[Tuple[str, str], Dict[str, int]] = defaultdict(lambda: {"s": 0, "w": 0})
    jockey_distance_acc: Dict[Tuple[str, int], Dict[str, int]] = defaultdict(lambda: {"s": 0, "w": 0})
    jockey_surface_acc: Dict[Tuple[str, str], Dict[str, int]] = defaultdict(lambda: {"s": 0, "w": 0})
    jockey_going_acc: Dict[Tuple[str, str], Dict[str, int]] = defaultdict(lambda: {"s": 0, "w": 0})

    # 馬個別の直近 N 走 ring buffer
    horse_recent: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    LAST_N = 5

    out: Dict[str, Dict[str, Dict[str, Any]]] = {}
    n_processed = 0
    n_with_result = 0

    for race in races_sorted:
        race_id = race.get("race_id")
        if not race_id:
            continue
        race_date = _parse_race_date(race_id)
        course = _course_short(race)
        distance = race.get("distance")
        surface = race.get("surface")
        going = race.get("going")

        per_horse: Dict[str, Dict[str, Any]] = {}

        for h in (race.get("horses") or []):
            num = h.get("number")
            if not isinstance(num, int):
                continue
            nm = h.get("name")
            j = h.get("jockey")
            tr = h.get("trainer")

            feat: Dict[str, Any] = {}

            # 騎手通算 (当該レース直前まで・ベイジアン縮約)
            if j:
                ja = jockey_acc[j]
                feat["jockeyWinRate"] = round(_shrunk_rate(ja["w"], ja["s"], JOCKEY_BASELINE_WIN), 4)
                feat["jockeyInThreeRate"] = round(_shrunk_rate(ja["i"], ja["s"], JOCKEY_BASELINE_IN3), 4)
                feat["jockeySamples"] = ja["s"]
                # 場・距離・芝ダ・馬場別
                if course:
                    jc = jockey_course_acc[(j, course)]
                    feat["courseWinRate"] = round(_shrunk_rate(jc["w"], jc["s"], JOCKEY_BASELINE_WIN), 4)
                if isinstance(distance, int) and distance > 0:
                    jd = jockey_distance_acc[(j, distance)]
                    feat["distanceWinRate"] = round(_shrunk_rate(jd["w"], jd["s"], JOCKEY_BASELINE_WIN), 4)
                if surface:
                    js = jockey_surface_acc[(j, surface)]
                    feat["surfaceWinRate"] = round(_shrunk_rate(js["w"], js["s"], JOCKEY_BASELINE_WIN), 4)
                if going:
                    jg = jockey_going_acc[(j, going)]
                    feat["goingWinRate"] = round(_shrunk_rate(jg["w"], jg["s"], JOCKEY_BASELINE_WIN), 4)

            # 調教師通算
            if tr:
                ta = trainer_acc[tr]
                feat["trainerWinRate"] = round(_shrunk_rate(ta["w"], ta["s"], TRAINER_BASELINE_WIN), 4)
                feat["trainerInThreeRate"] = round(_shrunk_rate(ta["i"], ta["s"], TRAINER_BASELINE_IN3), 4)
                feat["trainerSamples"] = ta["s"]

            # 馬個別 — 当該レース直前までの通算
            if nm:
                ha = horse_acc[nm]
                feat["horseStarts"] = ha["s"]
                feat["horseWinRate"] = round(_shrunk_rate(ha["w"], ha["s"], HORSE_BASELINE_WIN), 4)
                feat["horseIn3Rate"] = round(_shrunk_rate(ha["i"], ha["s"], HORSE_BASELINE_IN3), 4)

                # 直近 5 走の集計
                recent = horse_recent[nm][-LAST_N:]
                if recent:
                    l3s = [r["haron_l3"] for r in recent if r.get("haron_l3")]
                    if l3s:
                        feat["horseAvgLast3F"] = round(sum(l3s) / len(l3s), 2)
                    p4s = [r["jyuni_4c"] for r in recent if r.get("jyuni_4c")]
                    if p4s:
                        feat["horseAvgPos4c"] = round(sum(p4s) / len(p4s), 2)
                    ks = [int(r["kyakusitu"]) for r in recent
                          if r.get("kyakusitu") and str(r["kyakusitu"]).isdigit()]
                    if ks:
                        most = Counter(ks).most_common(1)[0][0]
                        feat["horseRunStyleMode"] = most
                    finishes = [r["kakutei_jyuni"] for r in recent
                                if isinstance(r.get("kakutei_jyuni"), int) and r["kakutei_jyuni"] > 0]
                    if finishes:
                        feat["horseAvgFinish"] = round(sum(finishes) / len(finishes), 2)
                    # 直前 1 走
                    prev = recent[-1]
                    if isinstance(prev.get("kakutei_jyuni"), int) and prev["kakutei_jyuni"] > 0:
                        feat["horsePrevFinish"] = prev["kakutei_jyuni"]
                    if race_date and prev.get("date"):
                        try:
                            days = (race_date - prev["date"]).days
                            if days >= 0:
                                feat["horseDaysSinceLast"] = days
                        except Exception:
                            pass

            # SE 由来の馬体重 (発走前に判明する情報 ≒ leakage なし)
            if isinstance(h.get("weight_diff"), (int, float)):
                feat["weightChange"] = h["weight_diff"]
            if isinstance(h.get("body_weight"), (int, float)):
                feat["bodyWeight"] = h["body_weight"]
                feat["bodyWeightDeviation"] = round((h["body_weight"] - 470) / 30, 3)
            # 累計獲得本賞金 (過去レースの honsyokin の累計のみ・当該レース honsyokin は除外)
            # SE.honsyokin は「当該レースで獲得した賞金」なので学習時は別管理する
            if nm:
                cum = horse_prize_acc.get(nm, 0)
                if cum > 0:
                    yen = cum * 100  # 百円単位 → 円
                    feat["careerPrizeJpy"] = yen
                    feat["careerPrizeNorm"] = round(min(1.5, math.log10(max(1, yen / 1e7) + 1) / 2), 4)

            if feat:
                per_horse[str(num)] = feat

        if per_horse:
            out[race_id] = per_horse
        n_processed += 1

        # === 当該レース完了後、結果を「過去」に追加 (leak 排除のため後追加) ===
        result = results.get(race_id)
        if not result:
            continue
        won_map, in3_map = _winners_in_three(result)
        n_with_result += 1

        for h in (race.get("horses") or []):
            num = h.get("number")
            if not isinstance(num, int):
                continue
            won = bool(won_map.get(num, False))
            in3 = bool(in3_map.get(num, False))
            j, tr, nm = h.get("jockey"), h.get("trainer"), h.get("name")

            if j:
                jockey_acc[j]["s"] += 1
                if won: jockey_acc[j]["w"] += 1
                if in3: jockey_acc[j]["i"] += 1
                if course:
                    jockey_course_acc[(j, course)]["s"] += 1
                    if won: jockey_course_acc[(j, course)]["w"] += 1
                if isinstance(distance, int) and distance > 0:
                    jockey_distance_acc[(j, distance)]["s"] += 1
                    if won: jockey_distance_acc[(j, distance)]["w"] += 1
                if surface:
                    jockey_surface_acc[(j, surface)]["s"] += 1
                    if won: jockey_surface_acc[(j, surface)]["w"] += 1
                if going:
                    jockey_going_acc[(j, going)]["s"] += 1
                    if won: jockey_going_acc[(j, going)]["w"] += 1
            if tr:
                trainer_acc[tr]["s"] += 1
                if won: trainer_acc[tr]["w"] += 1
                if in3: trainer_acc[tr]["i"] += 1
            if nm:
                horse_acc[nm]["s"] += 1
                if won: horse_acc[nm]["w"] += 1
                if in3: horse_acc[nm]["i"] += 1
                # 賞金累積 (当該レース honsyokin を「過去」に追加)
                if isinstance(h.get("honsyokin"), (int, float)) and h["honsyokin"] > 0:
                    horse_prize_acc[nm] += int(h["honsyokin"])
                # ring buffer
                horse_recent[nm].append({
                    "race_id": race_id,
                    "date": race_date,
                    "haron_l3": h.get("haron_l3"),
                    "jyuni_4c": h.get("jyuni_4c"),
                    "kyakusitu": h.get("kyakusitu"),
                    "kakutei_jyuni": h.get("kakutei_jyuni"),
                })
                if len(horse_recent[nm]) > LAST_N * 2:
                    horse_recent[nm] = horse_recent[nm][-LAST_N:]

    out["_meta"] = {
        "version": "v2_leak_free",
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "racesProcessed": n_processed,
        "racesWithResult": n_with_result,
        "uniqueJockeys": len(jockey_acc),
        "uniqueTrainers": len(trainer_acc),
        "uniqueHorses": len(horse_acc),
    }
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="時系列リーク排除版 features.json 生成")
    ap.add_argument("--out", default=str(FEATURES_PATH))
    args = ap.parse_args()
    features = build_features()
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(features, ensure_ascii=False, indent=2), encoding="utf-8")
    meta = features.get("_meta") or {}
    print(f"[ok] features v2 生成完了: races={meta.get('racesProcessed')} "
          f"with_result={meta.get('racesWithResult')} "
          f"jockeys={meta.get('uniqueJockeys')} trainers={meta.get('uniqueTrainers')} "
          f"horses={meta.get('uniqueHorses')}", flush=True)
    print(f"[write] {out_path} ({out_path.stat().st_size:,} bytes)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
