# -*- coding: utf-8 -*-
r"""
import_history.py — 過去10年ぶんのセットアップデータを「毎朝の取り込みを壊さずに」JSON にする。

━━ なぜ別のスクリプトなのか (ここを読まずに触らないこと) ━━━━━━━━━━━━━━

毎朝の build_all.py は `data/jv_cache/aggregate_*/raw_*.bin` を**自動で全部**拾う。
過去10年のセットアップデータ (JV-Link は 1 回の取得を **1 個の巨大な .bin** にまとめる)
をそこに置くと、次の3つが同時に起きる:

  ① 翌朝の build_all.py が 10 年ぶんの展開を始める。
     しかも build_all.py は **32bit Python** で動く (race_day_pipeline.py: python_exe())。
     32bit のメモリ上限は約 2GB。10 年ぶんのレコードは実測換算で 2GB を超える → MemoryError。
  ② その後も毎朝ダメ。差分ビルドは「dirty なレースを含む古いファイルも道連れで読む」作りで、
     10 年ファイルは**今日のレースも含む**ので毎回 道連れになる → 毎朝 数GB を読む。
  ③ races/ が 4,380 → 約 40,000 に増えると features.json が 42MB → 約 380MB になる。
     features.json は **git に載せて Vercel に配っている**。GitHub は 100MB を超えるファイルを
     受け付けない → **毎朝の git push が落ちて本番が更新されなくなる**。

だから「取る」と「取り込む」を分ける。血統の kettou_raw/ と同じ考え方:

    取得   setup_fetch.ps1 -OutDir history_raw   → data/jv_cache/history_raw/raw_*.bin
    取込   このスクリプト                        → data/jv_cache/history/races|results/*.json

`history/` は build_all.py の索引にも入らないし、毎朝のどの処理からも読まれない。
学習で使うときだけ `aggregate_features_v2.py --extra-races-dir` で明示的に足す。

━━ メモリを使い切らない工夫 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

数GBの .bin を丸ごと parse するとメモリが足りない。そこで2回に分ける:

  Pass 1 (仕分け): .bin を少しずつ読み、レコードを **年月 (YYYYMM)** ごとの小さな
                   部品ファイルに振り分ける。1 レースの全レコードは必ず同じ日付なので、
                   年月で切っても 1 レースが分断されることは絶対にない。
  Pass 2 (組立):   部品を 1 個ずつ読んで races/results JSON を書く。1 部品は数十MB。

━━ 上書きしない ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

本番の races/ results/ に既にあるレースは **絶対に書き換えない**。
本番側には毎時オッズなど、セットアップデータには無い情報が入っているため。

使い方:
  py -3.12-64 jv_bridge/import_history.py            # 仕分け + 組立
  py -3.12-64 jv_bridge/import_history.py --split-only
  py -3.12-64 jv_bridge/import_history.py --build-only
  py -3.12-64 jv_bridge/import_history.py --dry-run  # 書かずに件数だけ数える
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from jv_bridge import build_all  # noqa: E402
from jv_bridge import build_race_json  # noqa: E402
from jv_bridge import build_result_json  # noqa: E402
from jv_bridge import parse  # noqa: E402

CACHE = ROOT / "data" / "jv_cache"
RAW_DIR = CACHE / "history_raw"          # 取得した生データ (build_all.py からは見えない)
PARTS_DIR = CACHE / "history_raw" / "_parts"   # 年月ごとの部品 (作業用・あとで消せる)
OUT_ROOT = CACHE / "history"
OUT_RACES = OUT_ROOT / "races"
OUT_RESULTS = OUT_ROOT / "results"

LIVE_RACES = CACHE / "races"
LIVE_RESULTS = CACHE / "results"

# races/results を作るのに要るレコードだけを通す。
# (この 6 種は共通ヘッダの 11〜14 バイト目が「開催年」で揃っている＝年月で仕分けできる)
WANT_TYPES = {b"RA", b"SE", b"O1", b"HR", b"DM", b"TK"}

# 中央競馬 (JRA) の競馬場コードは 01〜10。
# セットアップデータには地方競馬 (30〜) も混ざっていて、そちらは払戻(HR)も
# コース名も入らない。手元の races/ は全部 JRA なので、そろえるため既定で JRA だけ入れる。
JRA_JYO = {b"01", b"02", b"03", b"04", b"05", b"06", b"07", b"08", b"09", b"10"}

CHUNK = 32 * 1024 * 1024  # 32MB ずつ読む


def _log(msg: str) -> None:
    print(msg, flush=True)


# ─────────────────────────────── Pass 1: 仕分け ───────────────────────────────

def split_by_month(raw_paths: List[Path], parts_dir: Path, jra_only: bool = True) -> Dict[str, int]:
    """巨大な .bin を年月 (YYYYMM) ごとの部品ファイルに切り分ける。

    ⚠ ここでは parse しない (遅い・メモリを食う)。
      レコード種別 = 先頭2バイト / 開催年月 = 11〜16 バイト目 を直接見るだけ。
    """
    parts_dir.mkdir(parents=True, exist_ok=True)
    handles: Dict[str, Any] = {}
    counts: Counter = Counter()
    skipped = 0
    dropped_nar = 0

    def _want(ln: bytes) -> bool:
        nonlocal dropped_nar
        if jra_only and ln[19:21] not in JRA_JYO:
            dropped_nar += 1
            return False
        return True
    try:
        for path in raw_paths:
            size = path.stat().st_size
            _log(f"  [split] {path.name} ({size/1e9:.2f}GB) を仕分け中...")
            done = 0
            tail = b""
            with path.open("rb") as f:
                while True:
                    chunk = f.read(CHUNK)
                    if not chunk:
                        break
                    done += len(chunk)
                    buf = tail + chunk
                    lines = buf.split(b"\r\n")
                    tail = lines.pop()  # 最後は途中で切れている可能性がある
                    for ln in lines:
                        if len(ln) < 17:
                            continue
                        if ln[:2] not in WANT_TYPES:
                            continue
                        if not _want(ln):
                            continue
                        ym = ln[11:17]
                        if not ym.isdigit():
                            skipped += 1
                            continue
                        key = ym.decode("ascii")
                        h = handles.get(key)
                        if h is None:
                            h = (parts_dir / f"part_{key}.bin").open("wb")
                            handles[key] = h
                        h.write(ln)
                        h.write(b"\r\n")
                        counts[key] += 1
                    if done % (512 * 1024 * 1024) < CHUNK:
                        _log(f"    ... {done/1e9:.2f}GB / {size/1e9:.2f}GB")
            if tail:
                ln = tail
                if len(ln) >= 21 and ln[:2] in WANT_TYPES and _want(ln) and ln[11:17].isdigit():
                    key = ln[11:17].decode("ascii")
                    h = handles.get(key)
                    if h is None:
                        h = (parts_dir / f"part_{key}.bin").open("wb")
                        handles[key] = h
                    h.write(ln)
                    h.write(b"\r\n")
                    counts[key] += 1
    finally:
        for h in handles.values():
            try:
                h.close()
            except Exception:
                pass
    if skipped:
        _log(f"  [split] 年月が読めず捨てたレコード: {skipped} 件")
    if dropped_nar:
        _log(f"  [split] 中央競馬(JRA)ではないので外したレコード: {dropped_nar:,} 件")
    return dict(counts)


# ─────────────────────────────── Pass 2: 組立 ───────────────────────────────

def _existing_ids(d: Path) -> Set[str]:
    if not d.exists():
        return set()
    return {p.stem for p in d.glob("*.json")}


def build_from_parts(parts: List[Path], dry_run: bool, overwrite_history: bool) -> Dict[str, int]:
    """部品を 1 個ずつ読んで history/races・history/results を書く。"""
    live_races = _existing_ids(LIVE_RACES)
    live_results = _existing_ids(LIVE_RESULTS)
    _log(f"  [build] 本番に既にあるレース: races={len(live_races)} results={len(live_results)} (これらは触らない)")

    if not dry_run:
        OUT_RACES.mkdir(parents=True, exist_ok=True)
        OUT_RESULTS.mkdir(parents=True, exist_ok=True)

    stat = Counter()
    for i, part in enumerate(parts, 1):
        raw = part.read_bytes()
        recs = parse.parse_raw_file(raw)
        del raw
        groups = build_all.group_by_race(recs)
        del recs

        wrote_r = wrote_res = skip_r = skip_res = 0
        for rid, g in groups.items():
            ra = g.get("ra")
            se_list = g.get("se_list") or []
            hr = g.get("hr")

            # ---- races ----
            if ra:
                if rid in live_races:
                    skip_r += 1
                else:
                    tgt = OUT_RACES / f"{rid}.json"
                    if tgt.exists() and not overwrite_history:
                        skip_r += 1
                    elif not dry_run:
                        rj = build_race_json.merge(ra, se_list, g.get("o1"))
                        if rj.get("race_id"):
                            tgt.write_text(json.dumps(rj, ensure_ascii=False, indent=2), encoding="utf-8")
                            wrote_r += 1
                    else:
                        wrote_r += 1

            # ---- results ----
            has_finished = any(isinstance(s.get("kakutei_jyuni"), int) and s.get("kakutei_jyuni", 0) > 0
                               for s in se_list)
            if has_finished or hr:
                if rid in live_results:
                    skip_res += 1
                else:
                    tgt = OUT_RESULTS / f"{rid}.json"
                    if tgt.exists() and not overwrite_history:
                        skip_res += 1
                    elif not dry_run:
                        if ra and has_finished:
                            rj = build_result_json.from_se_list(ra, se_list, hr)
                        elif hr:
                            rj = build_result_json.build(hr, ra, se_list)
                        else:
                            rj = None
                        if rj and rj.get("race_id"):
                            tgt.write_text(json.dumps(rj, ensure_ascii=False, indent=2), encoding="utf-8")
                            wrote_res += 1
                    else:
                        wrote_res += 1

        stat["races_written"] += wrote_r
        stat["results_written"] += wrote_res
        stat["races_skipped"] += skip_r
        stat["results_skipped"] += skip_res
        stat["groups"] += len(groups)
        _log(f"  [{i}/{len(parts)}] {part.stem}: race={len(groups)} 書いた(出走表 {wrote_r} / 結果 {wrote_res}) "
             f"飛ばした({skip_r}/{skip_res})")
        del groups
    return dict(stat)


# ─────────────────────────────── main ───────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="過去データ (セットアップ) を history/ に取り込む")
    ap.add_argument("--raw-dir", type=Path, default=RAW_DIR)
    ap.add_argument("--split-only", action="store_true")
    ap.add_argument("--build-only", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="書かずに数えるだけ")
    ap.add_argument("--overwrite-history", action="store_true",
                    help="history/ に既にある JSON も書き直す (本番 races/ は常に触らない)")
    ap.add_argument("--keep-parts", action="store_true", help="作業用の部品ファイルを消さない")
    ap.add_argument("--include-nar", action="store_true",
                    help="地方競馬 (競馬場コード 11 以上) も入れる。既定は中央(JRA)だけ。")
    args = ap.parse_args()

    t0 = time.time()
    raw_dir: Path = args.raw_dir
    parts_dir = raw_dir / "_parts"

    # 安全確認: 生データが本番の取り込み対象に紛れ込んでいないか
    if raw_dir.name.startswith("aggregate_") or raw_dir.parent == CACHE and raw_dir.name == "":
        _log("[NG] 生データを aggregate_* に置いてはいけません (毎朝の build_all.py が拾ってしまう)")
        return 2

    if not args.build_only:
        raws = sorted(raw_dir.glob("raw_*.bin"))
        if not raws:
            _log(f"[NG] {raw_dir} に raw_*.bin がありません")
            return 1
        total = sum(p.stat().st_size for p in raws)
        _log(f"[step1] 仕分け: {len(raws)} ファイル / {total/1e9:.2f}GB")
        if parts_dir.exists():
            shutil.rmtree(parts_dir)
        counts = split_by_month(raws, parts_dir, jra_only=not args.include_nar)
        _log(f"[OK] 仕分け完了: {len(counts)} か月ぶん / {sum(counts.values()):,} レコード "
             f"({time.time()-t0:.0f}秒)")

    if args.split_only:
        return 0

    parts = sorted(parts_dir.glob("part_*.bin"))
    if not parts:
        _log(f"[NG] {parts_dir} に部品がありません (先に --split-only を実行)")
        return 1
    _log(f"[step2] 組立: {len(parts)} 部品 / {sum(p.stat().st_size for p in parts)/1e9:.2f}GB")
    stat = build_from_parts(parts, dry_run=args.dry_run, overwrite_history=args.overwrite_history)

    _log("")
    _log("=== 取り込み結果 ===")
    _log(f"  見つけたレース(のべ)      : {stat.get('groups', 0):,}")
    _log(f"  history/races に書いた    : {stat.get('races_written', 0):,}")
    _log(f"  history/results に書いた  : {stat.get('results_written', 0):,}")
    _log(f"  既にあるので飛ばした      : races {stat.get('races_skipped', 0):,} / "
         f"results {stat.get('results_skipped', 0):,}")
    if not args.dry_run:
        _log(f"  実ファイル数: history/races={len(list(OUT_RACES.glob('*.json'))):,} "
             f"history/results={len(list(OUT_RESULTS.glob('*.json'))):,}")
    if not args.keep_parts and not args.dry_run:
        shutil.rmtree(parts_dir, ignore_errors=True)
        _log("  作業用の部品ファイルは削除しました (--keep-parts で残せます)")
    _log(f"[info] 所要 {time.time()-t0:.0f} 秒")
    return 0


if __name__ == "__main__":
    sys.exit(main())
