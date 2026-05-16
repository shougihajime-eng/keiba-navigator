# -*- coding: utf-8 -*-
"""
race_day_pipeline.py — 土日朝の自動取得パイプライン

走る順番:
  1. tomorrow_races.json をその場で生成 (aggregate RACE で当日/明日の RA を取り直す)
  2. fetch_tomorrow.py を実行 (全 dataspec の RT 取得)
  3. build_all.py を実行 (raw.bin → races/results JSON)
  4. aggregate_features.py を実行 (features.json 更新)
  5. (任意) git add data/jv_cache/{races,results,features.json,horse_master.json}
     + commit + push origin main

Windows タスクスケジューラから 1 日 4 回呼び出される想定:
  - 08:30  ... 朝の出走表
  - 11:00  ... 直前オッズ
  - 13:30  ... 発走直後オッズ
  - 16:00  ... 確定オッズ + 払戻
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import List, Optional


ROOT = Path(__file__).resolve().parent.parent
JV_BRIDGE = ROOT / "jv_bridge"
SCRIPTS = ROOT / "scripts"
DATA_DIR = ROOT / "data" / "jv_cache"
LOG_DIR = ROOT / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)


# Windows のデフォルト cp932 では U+FFFD などを print() できず即落ちする。
# サブプロセス出力に化け文字が混ざっても止まらないよう UTF-8 へ強制再構成する。
for _stream_name in ("stdout", "stderr"):
    _stream = getattr(sys, _stream_name, None)
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def log_line(msg: str) -> None:
    """ログ + コンソール出力。"""
    ts = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    # cp932 等の素朴な stdout で化け文字が来た場合に sys.exit させない最終ガード
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        try:
            sys.stdout.write(line.encode("utf-8", "replace").decode("utf-8", "replace") + "\n")
            sys.stdout.flush()
        except Exception:
            pass
    log_path = LOG_DIR / f"race_day_{dt.date.today().isoformat()}.log"
    try:
        with log_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def python_exe() -> str:
    """32bit Python のフルパス (JV-Link COM 用)。"""
    cand = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Python" / "Python312-32" / "python.exe"
    if cand.exists():
        return str(cand)
    return sys.executable  # フォールバック


def python_exe_64() -> Optional[str]:
    """64bit Python のフルパス (LightGBM 訓練用)。無ければ None。"""
    cand = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Python" / "Python312-64" / "python.exe"
    if cand.exists():
        return str(cand)
    return None


def run_subprocess(args: List[str], label: str, timeout: int = 600) -> int:
    """サブプロセス実行 + ログ。"""
    log_line(f"--- {label} 開始: {' '.join(args)} ---")
    try:
        r = subprocess.run(
            args, cwd=str(ROOT),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout,
        )
        if r.stdout:
            for ln in r.stdout.splitlines()[-30:]:
                log_line(f"  | {ln}")
        if r.returncode != 0 and r.stderr:
            for ln in r.stderr.splitlines()[-10:]:
                log_line(f"  E {ln}")
        log_line(f"--- {label} 終了 (exit={r.returncode}) ---")
        return r.returncode
    except subprocess.TimeoutExpired:
        log_line(f"!! {label} タイムアウト ({timeout}s)")
        return -2
    except Exception as e:
        log_line(f"!! {label} 例外: {e}")
        return -1


# ─── ステップ 1: tomorrow_races.json を最新化 ─────────────────
def refresh_tomorrow_races() -> int:
    """aggregate RACE で当日 + 翌日の RA レコードを取得し、
    18 桁レース ID を tomorrow_races.json に保存する。
    """
    log_line("[step1] tomorrow_races.json を最新化")
    py = python_exe()
    # 過去 14 日分を fromtime にして当日と翌日の RA を確実に取り直す
    fromtime = (dt.date.today() - dt.timedelta(days=14)).strftime("%Y%m%d") + "000000"
    rc = run_subprocess(
        [py, str(JV_BRIDGE / "jv_fetch.py"), "aggregate",
         "--dataspec", "RACE", "--fromtime", fromtime, "--option", "1"],
        "aggregate RACE", timeout=900,
    )
    if rc != 0:
        log_line(f"  aggregate RACE 失敗 (rc={rc})・既存 tomorrow_races.json を使う")
        return rc

    # raw.bin を読み、当日 or 翌日の RA から race_id を抽出
    try:
        sys.path.insert(0, str(ROOT))
        from jv_bridge import parse  # noqa: E402

        today = dt.date.today()
        tomorrow = today + dt.timedelta(days=1)
        targets = {today.strftime("%Y%m%d"), tomorrow.strftime("%Y%m%d")}

        race_ids = set()
        venues = set()
        for sub in sorted(DATA_DIR.glob("aggregate_*_RACE")):
            for binf in sorted(sub.glob("raw_*.bin")):
                raw = binf.read_bytes()
                recs = parse.parse_raw_file(raw)
                for r in recs:
                    if r.get("_record_id") != "RA":
                        continue
                    year = r.get("year") or ""
                    md = r.get("month_day") or ""
                    if f"{year}{md}" not in targets:
                        continue
                    rid_parts = [r.get(k) for k in ("year", "month_day", "jyo_code", "kai_ji", "nichi_ji", "race_num")]
                    if not all(rid_parts):
                        continue
                    rid = "".join(str(x).strip() for x in rid_parts)
                    if len(rid) == 16:
                        # tomorrow_races.json は 18 桁形式 (末尾 00 パディング)
                        race_ids.add(rid + "00")
                        venues.add(r.get("jyo_code"))

        if race_ids:
            target_date = tomorrow.strftime("%Y%m%d") if any(tomorrow.strftime("%Y%m%d") in rid[:8] for rid in race_ids) else today.strftime("%Y%m%d")
            out = {
                "date": target_date,
                "fetched_at": dt.datetime.now().astimezone().isoformat(),
                "race_ids": sorted(race_ids),
                "venues": sorted(venues),
            }
            path = DATA_DIR / "tomorrow_races.json"
            path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
            log_line(f"  tomorrow_races.json: {len(race_ids)} レース ({', '.join(sorted(venues))})")
            return 0
        else:
            log_line(f"  当日/翌日の RA レコードが見つからず・既存ファイルを維持")
            return 0
    except Exception as e:
        log_line(f"  tomorrow_races 再構築失敗: {e}")
        return -1


# ─── ステップ 2: fetch_tomorrow.py 実行 ──────────────────────
def run_fetch_tomorrow() -> int:
    log_line("[step2] fetch_tomorrow.py (全 dataspec の RT 取得)")
    py = python_exe()
    return run_subprocess(
        [py, str(SCRIPTS / "fetch_tomorrow.py")],
        "fetch_tomorrow", timeout=3600,
    )


# ─── ステップ 3: build_all.py 実行 ──────────────────────────
def run_build_all() -> int:
    log_line("[step3] build_all.py (raw.bin → races/results JSON)")
    py = python_exe()
    return run_subprocess(
        [py, str(JV_BRIDGE / "build_all.py")],
        "build_all", timeout=600,
    )


# ─── ステップ 4: aggregate_features.py 実行 ──────────────────
def run_aggregate_features() -> int:
    log_line("[step4] aggregate_features.py (features.json 更新)")
    py = python_exe()
    return run_subprocess(
        [py, str(JV_BRIDGE / "aggregate_features.py")],
        "aggregate_features", timeout=300,
    )


# ─── ステップ 4.5: train_lightgbm.py (LightGBM 訓練・64bit) ─────
def run_train_lightgbm() -> int:
    log_line("[step4.5] train_lightgbm.py (LightGBM モデル再訓練)")
    py64 = python_exe_64()
    if not py64:
        log_line("  64bit Python 未検出・LightGBM 訓練をスキップ")
        return 0
    return run_subprocess(
        [py64, str(JV_BRIDGE / "train_lightgbm.py"), "--min-races", "20"],
        "train_lightgbm", timeout=900,
    )


# ─── ステップ 5: git commit + push ──────────────────────────
def git_commit_push() -> int:
    log_line("[step5] git commit + push (races/results/features の変更)")
    # 注意: .gitignore で data/jv_cache/* は無視されているはずなので、
    # ここで commit されるのは「他の場所で変更があった場合のみ」。
    # 通常はこのステップで commit 対象は無く、何もしない。
    rc1 = run_subprocess(["git", "status", "--short"], "git status", timeout=30)
    return rc1


# ─── オーケストレータ ──────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="土日朝の race-day パイプライン")
    ap.add_argument("--skip-refresh", action="store_true",
                    help="tomorrow_races.json の最新化をスキップ")
    ap.add_argument("--skip-rt", action="store_true",
                    help="fetch_tomorrow (RT 取得) をスキップ")
    ap.add_argument("--skip-build", action="store_true",
                    help="build_all.py をスキップ")
    ap.add_argument("--skip-features", action="store_true",
                    help="aggregate_features.py をスキップ")
    ap.add_argument("--skip-train", action="store_true",
                    help="LightGBM 訓練をスキップ")
    args = ap.parse_args()

    log_line("=== race_day_pipeline 開始 ===")
    log_line(f"  cwd: {ROOT}")
    log_line(f"  log: {LOG_DIR / ('race_day_' + dt.date.today().isoformat() + '.log')}")

    overall = 0
    if not args.skip_refresh:
        rc = refresh_tomorrow_races()
        if rc != 0: overall |= 0x01
    if not args.skip_rt:
        rc = run_fetch_tomorrow()
        if rc != 0 and rc != 2: overall |= 0x02   # rc=2 は一部失敗 (warn 扱い)
    if not args.skip_build:
        rc = run_build_all()
        if rc != 0: overall |= 0x04
    if not args.skip_features:
        rc = run_aggregate_features()
        if rc != 0: overall |= 0x08
    # LightGBM 訓練 (64bit Python があれば・データ少ない時はスキップ動作)
    if not getattr(args, "skip_train", False):
        rc = run_train_lightgbm()
        if rc != 0: overall |= 0x20
    rc = git_commit_push()
    if rc != 0: overall |= 0x10

    log_line(f"=== race_day_pipeline 終了 (overall={overall:#x}) ===")
    return overall


if __name__ == "__main__":
    sys.exit(main())
