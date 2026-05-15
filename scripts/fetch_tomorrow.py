"""
明日 (data/jv_cache/tomorrow_races.json に保存済み) のレース全件について
複数の dataspec (オッズ・馬体重・払戻 etc.) を順次取得する。

土曜・日曜の朝にダブルクリックで実行する想定。
Python 32bit + JV-Link インストール済 + 利用キー設定済が前提。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "jv_bridge" / "jv_fetch.py"
TOMORROW_JSON = ROOT / "data" / "jv_cache" / "tomorrow_races.json"

# JVRTOpen の dataspec 一覧 (リアルタイム系):
#   0B11: 馬体重
#   0B12: 払戻
#   0B14: 単複枠連
#   0B15: 馬連
#   0B16: ワイド
#   0B17: 馬単
#   0B20: 3連複
#   0B30: 3連単
#   0B31: 単複オッズ速報
DEFAULT_DATASPECS = [
    "0B31",  # 単複オッズ速報 (最優先)
    "0B14",  # 単複枠連 (確定後)
    "0B15",  # 馬連
    "0B16",  # ワイド
    "0B17",  # 馬単
    "0B20",  # 3連複
    "0B30",  # 3連単
    "0B11",  # 馬体重
    "0B12",  # 払戻 (発走後)
]


def main() -> int:
    ap = argparse.ArgumentParser(description="明日のレースの全 dataspec を順次取得")
    ap.add_argument("--dataspec", action="append", default=None,
                    help="取得する dataspec (複数指定可・デフォルトで主要 9 種)")
    ap.add_argument("--max-races", type=int, default=None,
                    help="先頭 N レースだけ取得 (デバッグ用)")
    args = ap.parse_args()

    if not TOMORROW_JSON.exists():
        print(f"[NG] {TOMORROW_JSON} が見つかりません。")
        print("     先に jv_fetch.py aggregate --dataspec RACE で明日のレース一覧を取得してください。")
        return 1

    with TOMORROW_JSON.open("r", encoding="utf-8") as f:
        data = json.load(f)

    race_ids = data.get("race_ids") or []
    if args.max_races:
        race_ids = race_ids[:args.max_races]
    date = data.get("date", "?")
    dataspecs = args.dataspec if args.dataspec else DEFAULT_DATASPECS

    print(f"日付: {date} / レース {len(race_ids)} 件 / dataspec {len(dataspecs)} 種類")
    print(f"開催場: {data.get('venues', [])}")
    print(f"dataspec: {dataspecs}")
    print(f"合計呼び出し数: {len(race_ids) * len(dataspecs)} 回")
    print()

    py = sys.executable
    total_ok = 0
    total_ng = 0
    summary: dict[str, dict[str, int]] = {ds: {"ok": 0, "ng": 0} for ds in dataspecs}

    for i, rid in enumerate(race_ids, 1):
        for ds in dataspecs:
            label = f"[{i}/{len(race_ids)} ds={ds}] race={rid}"
            print(label, end=" -> ", flush=True)
            try:
                result = subprocess.run(
                    [py, str(SCRIPT), "rt", "--dataspec", ds, "--raceid", rid],
                    capture_output=True, text=True, encoding="cp932", errors="replace",
                    timeout=60,
                )
                if result.returncode == 0:
                    print("OK")
                    total_ok += 1
                    summary[ds]["ok"] += 1
                else:
                    print(f"NG (exit={result.returncode})")
                    total_ng += 1
                    summary[ds]["ng"] += 1
            except subprocess.TimeoutExpired:
                print("NG (timeout)")
                total_ng += 1
                summary[ds]["ng"] += 1

    print()
    print("===== dataspec 別サマリー =====")
    for ds in dataspecs:
        s = summary[ds]
        print(f"  {ds}: OK={s['ok']} / NG={s['ng']}")
    print()
    print(f"===== 合計: 成功 {total_ok} / 失敗 {total_ng} =====")
    return 0 if total_ng == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
