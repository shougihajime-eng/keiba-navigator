# -*- coding: utf-8 -*-
"""
build_all.py — aggregate_*/raw_*.bin から races/<id>.json と results/<id>.json を全部書き出す。

flow:
  1. data/jv_cache/aggregate_*_RACE/raw_*.bin を全部読む
  2. parse.parse_raw_file で record dict のリストにする
  3. RA / SE / O1 / HR を race_id でグルーピング
  4. build_race_json.merge() + .write() → races/<id>.json
  5. SE で着順が確定しているレースは build_result_json.from_se_list() + .write() → results/<id>.json
     HR があれば build_result_json.build() で payouts も合体

使い方:
  py -3.12-32 jv_bridge\build_all.py
  py -3.12-32 jv_bridge\build_all.py --raw-dir data/jv_cache/aggregate_20240101_RACE
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# ── jv_bridge package を import 可能にする ──────────────────
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from jv_bridge import parse  # noqa: E402
from jv_bridge import build_race_json  # noqa: E402
from jv_bridge import build_result_json  # noqa: E402


CACHE_DIR = ROOT / "data" / "jv_cache"
RACES_DIR = CACHE_DIR / "races"
RESULTS_DIR = CACHE_DIR / "results"


RACE_KEY_FIELDS = ("year", "month_day", "jyo_code", "kai_ji", "nichi_ji", "race_num")


def _race_id_of(rec: Dict[str, Any]) -> Optional[str]:
    """RA/SE/O1/HR 共通の race ID (16 桁) を組み立てる。
    年(4)+月日(4)+場(2)+回(2)+日次(2)+R(2)。
    """
    parts = []
    for k in RACE_KEY_FIELDS:
        v = rec.get(k)
        if v in (None, "", " "):
            return None
        parts.append(str(v).strip())
    rid = "".join(parts)
    if len(rid) != 16 or not rid.isdigit():
        return None
    return rid


def _collect_raw_files(raw_dir: Optional[Path]) -> List[Path]:
    """対象 .bin ファイルを集める。aggregate_*_<SPEC> 全種類。"""
    out: List[Path] = []
    if raw_dir is not None:
        out.extend(sorted(raw_dir.glob("raw_*.bin")))
    else:
        for sub in sorted(CACHE_DIR.glob("aggregate_*")):
            if sub.is_dir():
                out.extend(sorted(sub.glob("raw_*.bin")))
    return out


def parse_all(raw_paths: List[Path]) -> List[Dict[str, Any]]:
    """全 raw .bin をパースして 1 つのリストに連結。"""
    all_records: List[Dict[str, Any]] = []
    for p in raw_paths:
        try:
            raw = p.read_bytes()
        except Exception as e:
            print(f"  [warn] read {p.name}: {e}", flush=True)
            continue
        recs = parse.parse_raw_file(raw)
        print(f"  [info] {p.name}: {len(recs)} records", flush=True)
        all_records.extend(recs)
    return all_records


def group_by_race(records: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """race_id → {ra, se_list, o1, hr, dm_list, tk_list} に振り分け。

    SE/DM は同一 race に複数頭の繰り返しがあるためリスト。
    O1 / HR は通常 1 race に 1 件。
    """
    out: Dict[str, Dict[str, Any]] = {}
    for r in records:
        rid_full = _race_id_of(r)
        if not rid_full:
            continue
        slot = out.setdefault(rid_full, {
            "ra": None, "se_list": [], "o1": None, "hr": None,
            "dm_list": [], "tk_list": [],
        })
        rec_type = r.get("_record_id")
        if rec_type == "RA":
            slot["ra"] = r
        elif rec_type == "SE":
            slot["se_list"].append(r)
        elif rec_type == "O1":
            slot["o1"] = r
        elif rec_type == "HR":
            slot["hr"] = r
        elif rec_type == "DM":
            slot["dm_list"].append(r)
        elif rec_type == "TK":
            slot["tk_list"].append(r)
    return out


def index_horse_master(records: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """HN レコード群 → ketto_num → 馬データ dict のインデックス。"""
    out: Dict[str, Dict[str, Any]] = {}
    for r in records:
        if r.get("_record_id") != "HN":
            continue
        k = r.get("ketto_num") or ""
        k = k.strip() if isinstance(k, str) else ""
        if not k:
            continue
        out[k] = {
            "ketto_num":    k,
            "horse_name":   (r.get("horse_name") or "").strip(),
            "name_kana":    (r.get("name_kana") or "").strip(),
            "birth_year":   r.get("birth_year"),
            "sex_code":     r.get("sex_code"),
            "keiro":        r.get("keiro"),
            "father_num":   r.get("hansyoku_f_num"),
            "mother_num":   r.get("hansyoku_m_num"),
        }
    return out


def build_races(groups: Dict[str, Dict[str, Any]]) -> int:
    """races/<id>.json を書き出す。RA 必須。SE は 0 件でも書く (出走表未配信時)。"""
    RACES_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for rid, g in groups.items():
        ra = g.get("ra")
        if not ra:
            continue
        race_json = build_race_json.merge(ra, g.get("se_list") or [], g.get("o1"))
        path = build_race_json.write(race_json)
        if path:
            written += 1
    return written


def build_results(groups: Dict[str, Dict[str, Any]]) -> int:
    """results/<id>.json を書き出す。SE 確定着順または HR があるレースのみ。"""
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for rid, g in groups.items():
        ra = g.get("ra")
        se_list = g.get("se_list") or []
        hr = g.get("hr")

        # 着順が確定している SE が 1 件以上あるか
        has_finished = any(isinstance(s.get("kakutei_jyuni"), int) and s.get("kakutei_jyuni", 0) > 0
                           for s in se_list)
        if not has_finished and not hr:
            continue

        result_json = None
        if ra and has_finished:
            result_json = build_result_json.from_se_list(ra, se_list, hr)
        elif hr:
            result_json = build_result_json.build(hr, ra, se_list)

        if not result_json or not result_json.get("race_id"):
            continue
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        out = RESULTS_DIR / f"{result_json['race_id']}.json"
        out.write_text(json.dumps(result_json, ensure_ascii=False, indent=2), encoding="utf-8")
        written += 1
    return written


def main():
    ap = argparse.ArgumentParser(description="raw .bin → races/results JSON")
    ap.add_argument("--raw-dir", type=Path, default=None,
                    help="特定の aggregate ディレクトリだけ処理する場合")
    args = ap.parse_args()

    raw_paths = _collect_raw_files(args.raw_dir)
    if not raw_paths:
        print("[NG] raw .bin が見つかりません")
        return 1

    print(f"[info] {len(raw_paths)} ファイル処理開始", flush=True)
    records = parse_all(raw_paths)
    print(f"[info] パース済 total {len(records)} レコード", flush=True)

    # 種別ごとの count
    by_type: Dict[str, int] = {}
    for r in records:
        t = r.get("_record_id") or "?"
        by_type[t] = by_type.get(t, 0) + 1
    print(f"[info] 種別内訳: {dict(sorted(by_type.items(), key=lambda x: -x[1])[:15])}", flush=True)

    groups = group_by_race(records)
    print(f"[info] race 単位グルーピング: {len(groups)} race", flush=True)

    horse_master = index_horse_master(records)
    print(f"[info] HN 馬マスタ: {len(horse_master)} 頭", flush=True)
    if horse_master:
        hm_path = CACHE_DIR / "horse_master.json"
        hm_path.write_text(json.dumps(horse_master, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[OK] horse_master.json 書き出し ({hm_path.stat().st_size} bytes)", flush=True)

    nr = build_races(groups)
    print(f"[OK] races/ に {nr} 件書き出し", flush=True)

    nres = build_results(groups)
    print(f"[OK] results/ に {nres} 件書き出し", flush=True)

    # 種別別の race 数を表示
    has_dm = sum(1 for g in groups.values() if g.get("dm_list"))
    has_tk = sum(1 for g in groups.values() if g.get("tk_list"))
    has_se = sum(1 for g in groups.values() if g.get("se_list"))
    has_hr = sum(1 for g in groups.values() if g.get("hr"))
    print(f"[info] race ごとの付随データ: DM(AI予想)={has_dm} TK(特別登録)={has_tk} SE(出走馬)={has_se} HR(払戻)={has_hr}", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
