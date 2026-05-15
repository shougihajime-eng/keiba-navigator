"""
明日 (data/jv_cache/tomorrow_races.json に保存済み) のレース全件について
JVRTOpen で単複オッズ速報 (0B31) を取得する。

土曜の朝にダブルクリックで実行する想定。Python 32bit + JV-Link インストール済 + 利用キー設定済が前提。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "jv_bridge" / "jv_fetch.py"
TOMORROW_JSON = ROOT / "data" / "jv_cache" / "tomorrow_races.json"


def main() -> int:
    if not TOMORROW_JSON.exists():
        print(f"[NG] {TOMORROW_JSON} が見つかりません。")
        print("     先に jv_fetch.py aggregate --dataspec RACE で明日のレース一覧を取得してください。")
        return 1

    with TOMORROW_JSON.open("r", encoding="utf-8") as f:
        data = json.load(f)

    race_ids = data.get("race_ids") or []
    date = data.get("date", "?")
    print(f"明日 {date} のレース {len(race_ids)} 件のオッズを取得します")
    print(f"開催場: {data.get('venues', [])}")
    print()

    py = sys.executable
    ok_count = 0
    ng_count = 0
    for i, rid in enumerate(race_ids, 1):
        print(f"[{i}/{len(race_ids)}] race_id={rid} -> ", end="", flush=True)
        try:
            result = subprocess.run(
                [py, str(SCRIPT), "rt", "--dataspec", "0B31", "--raceid", rid],
                capture_output=True, text=True, encoding="cp932", errors="replace",
                timeout=60,
            )
            if result.returncode == 0:
                print("OK")
                ok_count += 1
            else:
                print(f"NG (exit={result.returncode})")
                ng_count += 1
        except subprocess.TimeoutExpired:
            print("NG (timeout 60s)")
            ng_count += 1

    print()
    print(f"完了: 成功 {ok_count} 件 / 失敗 {ng_count} 件")
    return 0 if ng_count == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
