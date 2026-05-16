# -*- coding: utf-8 -*-
"""
ProgramData/JRA-VAN/Data Lab/data 配下の .jvd ファイルを zlib 解凍し、
data/jv_cache/aggregate_<yyyy>_<type>/raw_offline_<ts>.bin に書き出す。

.jvd ファイル形式:
  - 先頭 10 byte: 圧縮前サイズ (ASCII 数字 + 空白パディング・例: "    513888")
  - 11 byte 目以降: zlib deflate 圧縮データ (展開後は CRLF 区切りの JV-Data レコード)

JV-Link aggregate コマンドが「セットアップ済」フラグで JVRead を空返ししてくる
状況を回避するため、ローカルキャッシュ済 .jvd を直接展開して取り込む。
"""

from __future__ import annotations
import sys
import os
import zlib
import time
from pathlib import Path
from collections import defaultdict

JVD_DIR = Path(r"C:\ProgramData\JRA-VAN\Data Lab\data")
OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "jv_cache" / "aggregate_20140101_RACE"


def main() -> int:
    if not JVD_DIR.exists():
        print(f"[NG] {JVD_DIR} が見つかりません")
        return 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    files = sorted(JVD_DIR.glob("*.jvd"))
    print(f"[info] {len(files)} 件の .jvd を展開します")

    # ファイル種別 (先頭4文字) ごとに 1 つの raw に書き出す
    type_writers = {}
    type_counts = defaultdict(int)
    type_bytes = defaultdict(int)
    skipped = 0
    ts = int(time.time())

    for f in files:
        fname = f.name
        head = fname[:4]  # 例: "RAVM" "SEVM" "HRVM" "O1VM" ...
        try:
            data = f.read_bytes()
            if len(data) < 11:
                skipped += 1
                continue
            # 先頭 10 byte = 圧縮前サイズ (ASCII 数字 + 空白パディング)
            # 11 byte 目以降 = zlib deflate 圧縮データ
            payload = data[10:]
            decompressed = zlib.decompress(payload)
        except Exception as e:
            print(f"  [skip] {fname}: {e}")
            skipped += 1
            continue

        if head not in type_writers:
            outp = OUT_DIR / f"raw_offline_{head}_{ts}.bin"
            type_writers[head] = open(outp, "wb")
        type_writers[head].write(decompressed)
        type_counts[head] += 1
        type_bytes[head] += len(decompressed)

    for w in type_writers.values():
        w.close()

    print(f"[OK] 展開完了 (skip: {skipped} files)")
    print(f"     種別ごとの統計:")
    for head, cnt in sorted(type_counts.items(), key=lambda kv: -kv[1]):
        mb = type_bytes[head] / 1024 / 1024
        print(f"       {head}: {cnt:4d} files -> {mb:7.1f} MB")
    print(f"     出力先: {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
