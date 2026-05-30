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


# ─── ステップ 4.4: aggregate_features_v2.py (leak-free 版) ─────
def run_aggregate_features_v2() -> int:
    """Wave17: 時系列リーク排除版の features.json を生成。
    旧 aggregate_features.py を上書きする。"""
    log_line("[step4.4] aggregate_features_v2.py (leak-free 集計)")
    py = python_exe()
    return run_subprocess(
        [py, str(JV_BRIDGE / "aggregate_features_v2.py")],
        "aggregate_features_v2", timeout=300,
    )


# ─── ステップ 4.5: train_lightgbm.py (LightGBM 訓練・64bit) ─────
def run_train_lightgbm() -> int:
    log_line("[step4.5] train_lightgbm.py (primary モデル: 人気込)")
    py64 = python_exe_64()
    if not py64:
        log_line("  64bit Python 未検出・LightGBM 訓練をスキップ")
        return 0
    return run_subprocess(
        [py64, str(JV_BRIDGE / "train_lightgbm.py"), "--min-races", "20"],
        "train_lightgbm primary", timeout=900,
    )


# ─── ステップ 4.55: train_lightgbm.py --no-pop (実力派モデル) ────
def run_train_lightgbm_nopop() -> int:
    """Wave18: 人気を見ない実力派モデル (value pick 用)"""
    log_line("[step4.55] train_lightgbm.py --no-pop (secondary: 実力派モデル)")
    py64 = python_exe_64()
    if not py64:
        log_line("  64bit Python 未検出・nopop モデル訓練をスキップ")
        return 0
    return run_subprocess(
        [py64, str(JV_BRIDGE / "train_lightgbm.py"), "--no-pop", "--min-races", "20"],
        "train_lightgbm nopop", timeout=900,
    )


# ─── ステップ 4.7: predict_lightgbm.py (全レースの LGBM 推論) ─────
def run_predict_lightgbm() -> int:
    """Wave19: 全 races/*.json に対して LightGBM 推論 →
    data/jv_cache/predictions/<id>.json を生成。
    primary + nopop の 2 モデルで推論し value_signal を計算。"""
    log_line("[step4.7] predict_lightgbm.py --all-races (LGBM 推論)")
    py64 = python_exe_64()
    if not py64:
        log_line("  64bit Python 未検出・LGBM 推論をスキップ")
        return 0
    return run_subprocess(
        [py64, str(JV_BRIDGE / "predict_lightgbm.py"), "--all-races"],
        "predict_lightgbm", timeout=600,
    )


# ─── ステップ 4.75: aggregate_recommendations.py (推奨買い目集約) ─
def run_aggregate_recommendations() -> int:
    """Wave19: 100% 越え戦略 fuku_top1_prob_020 の条件を満たすレースを
    recommendations.json に集約。git push で本番反映 → 画面の推奨セクションに表示。"""
    log_line("[step4.75] aggregate_recommendations.py (推奨買い目を集約)")
    py64 = python_exe_64()
    if not py64:
        py64 = python_exe()
    # --recent-days 60: 直近 2 ヶ月分のレースを「過去ログ」として表示
    # (短すぎると平日に画面が寂しくなる・長すぎると古い予想が UI を埋める)
    return run_subprocess(
        [py64, str(JV_BRIDGE / "aggregate_recommendations.py"), "--recent-days", "60"],
        "aggregate_recommendations", timeout=120,
    )


# ─── ステップ 4.76: validate_lightgbm.py (回収率実証を更新) ─────
def run_validate_lightgbm() -> int:
    """Wave19: 学習データが増えるたびに backtest_result.json を更新。"""
    log_line("[step4.76] validate_lightgbm.py (回収率実証)")
    py64 = python_exe_64()
    if not py64:
        log_line("  64bit Python 未検出・回収率実証をスキップ")
        return 0
    return run_subprocess(
        [py64, str(JV_BRIDGE / "validate_lightgbm.py"), "--test-ratio", "0.2"],
        "validate_lightgbm", timeout=600,
    )


# ─── ステップ 4.8: precompute_predictions.js (全レース予想を事前計算) ─────
def run_precompute_predictions() -> int:
    """Node.js で全レースの buildConclusion を 1 回回して
    data/jv_cache/predictions.json に書き出す。
    /api/races と /api/race はこのファイルを最優先で読む → スマホ開いた瞬間に応答。
    Node が無い環境では skip (動かない場合は warn だけ)。
    """
    log_line("[step4.8] precompute_predictions.js (全レース予想を事前計算)")
    node_exe = None
    for cand in ("node", "node.exe"):
        rc = subprocess.run(["where", cand], capture_output=True, text=True)
        if rc.returncode == 0 and rc.stdout.strip():
            node_exe = cand
            break
    if not node_exe:
        log_line("  Node.js 未検出・事前計算をスキップ (apt install nodejs 推奨)")
        return 0
    return run_subprocess(
        [node_exe, str(SCRIPTS / "precompute_predictions.js")],
        "precompute_predictions", timeout=300,
    )


# ─── ステップ 4.9: 実験室 (自己成長する実験モード) を更新 ─────────
def run_walk_forward_value_ev() -> int:
    """リークなし(各期間を過去だけで学習)の per-bet キャッシュ value_ev_bets.json を再生成。
    実験室の正直な採点の土台。64bit Python + LightGBM 必須・数分かかる。"""
    log_line("[step4.9] walk_forward_value_ev.py (リークなし採点データを再生成)")
    py64 = python_exe_64()
    if not py64:
        log_line("  64bit Python 未検出・実験室データ更新をスキップ (前回の値を維持)")
        return 0
    return run_subprocess(
        [py64, str(JV_BRIDGE / "walk_forward_value_ev.py")],
        "walk_forward_value_ev", timeout=1200,
    )


def run_experiment_engine() -> int:
    """value_ev_bets.json を 12 作戦で紙上ベット採点 → experiment_status.json /
    experiment_history.json を更新 (= 実験室が育つ)。軽い処理。"""
    log_line("[step4.95] experiment_engine.py (実験室を再採点・成長ログ追記)")
    py = python_exe_64() or python_exe()
    return run_subprocess(
        [py, str(JV_BRIDGE / "experiment_engine.py")],
        "experiment_engine", timeout=180,
    )


# ─── ステップ 5: git commit + push ──────────────────────────
def git_commit_push() -> int:
    """訓練済モデル + 集計済特徴量を git に乗せて Vercel へ反映する。

    .gitignore で以下のみ例外的に追跡:
      data/jv_cache/model_lgbm.json
      data/jv_cache/model_lgbm_meta.json
      data/jv_cache/features.json
      data/jv_cache/horse_master.json
    """
    log_line("[step5] git commit + push (モデル + 特徴量を本番反映)")

    # まず差分があるか確認
    try:
        r = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=30,
        )
        if r.returncode != 0:
            log_line(f"  git status 失敗 (rc={r.returncode})・スキップ")
            return r.returncode
        changes = [ln for ln in (r.stdout or "").splitlines() if ln.strip()]
        if not changes:
            log_line("  変更なし・commit/push スキップ")
            return 0
        log_line(f"  変更 {len(changes)} 件検出")
    except Exception as e:
        log_line(f"  git status 例外: {e}")
        return -1

    # 自動コミット対象を明示的に add (誤って秘匿ファイル等を巻き込まないよう)
    targets = [
        "data/jv_cache/model_lgbm.json",
        "data/jv_cache/model_lgbm_meta.json",
        "data/jv_cache/features.json",
        "data/jv_cache/horse_master.json",
        "data/jv_cache/predictions.json",  # ★Wave14: 事前計算予想 (スマホ瞬時応答用)
        # ★Wave18-19: LightGBM 実力派モデル + 推奨買い目 + 回収率実証
        "data/jv_cache/model_lgbm_nopop.json",
        "data/jv_cache/model_lgbm_nopop_meta.json",
        "data/jv_cache/recommendations.json",
        "data/jv_cache/backtest_result.json",
        # ★2026-05-30: 自己成長する実験モード(実験室) の成績表 + 成長ログ
        "data/jv_cache/experiment_status.json",
        "data/jv_cache/experiment_history.json",
    ]
    add_args = ["git", "add"] + [t for t in targets if (ROOT / t).exists()]
    if len(add_args) == 2:
        log_line("  対象ファイルが存在せず・スキップ")
        return 0
    rc_add = run_subprocess(add_args, "git add", timeout=30)
    if rc_add != 0:
        return rc_add

    # diff --cached --quiet → 差分があれば exit 1
    diff = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=str(ROOT), timeout=30,
    )
    if diff.returncode == 0:
        log_line("  staged 差分なし・commit/push スキップ")
        return 0

    ts = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    msg = f"chore(auto): race_day_pipeline 更新 ({ts})"
    rc_commit = run_subprocess(
        ["git", "commit", "-m", msg],
        "git commit", timeout=60,
    )
    if rc_commit != 0:
        return rc_commit

    rc_push = run_subprocess(
        ["git", "push", "origin", "main"],
        "git push", timeout=120,
    )
    if rc_push == 0:
        log_line("  ✓ Vercel への反映が始まりました (数十秒で本番更新)")
    return rc_push


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
    ap.add_argument("--skip-features-v2", action="store_true",
                    help="aggregate_features_v2.py (leak-free) をスキップ")
    ap.add_argument("--skip-train", action="store_true",
                    help="LightGBM 訓練をスキップ")
    ap.add_argument("--skip-train-nopop", action="store_true",
                    help="LightGBM nopop (実力派) 訓練をスキップ")
    ap.add_argument("--skip-precompute", action="store_true",
                    help="全レース予想の事前計算 (Node) をスキップ")
    ap.add_argument("--skip-lgbm-predict", action="store_true",
                    help="predict_lightgbm (全レース推論) をスキップ")
    ap.add_argument("--skip-recommend", action="store_true",
                    help="aggregate_recommendations をスキップ")
    ap.add_argument("--skip-validate", action="store_true",
                    help="validate_lightgbm (回収率実証) をスキップ")
    ap.add_argument("--skip-experiment", action="store_true",
                    help="実験室 (walk_forward_value_ev + experiment_engine) の更新をスキップ")
    args = ap.parse_args()

    log_line("=== race_day_pipeline 開始 ===")
    log_line(f"  cwd: {ROOT}")
    log_line(f"  log: {LOG_DIR / ('race_day_' + dt.date.today().isoformat() + '.log')}")

    overall = 0
    timed_out = False  # ★Wave16-QA: タイムアウト時は部分データを push しない
    if not args.skip_refresh:
        rc = refresh_tomorrow_races()
        if rc == -2: timed_out = True
        if rc != 0: overall |= 0x01
    if not args.skip_rt:
        rc = run_fetch_tomorrow()
        if rc == -2: timed_out = True
        if rc != 0 and rc != 2: overall |= 0x02   # rc=2 は一部失敗 (warn 扱い)
    if not args.skip_build:
        rc = run_build_all()
        if rc == -2: timed_out = True
        if rc != 0: overall |= 0x04
    if not args.skip_features:
        rc = run_aggregate_features()
        if rc == -2: timed_out = True
        if rc != 0: overall |= 0x08
    # ★Wave17: leak-free 版の集計 (旧 features.json を上書き)
    if not getattr(args, "skip_features_v2", False):
        rc = run_aggregate_features_v2()
        if rc == -2: timed_out = True
        if rc != 0: overall |= 0x10
    # LightGBM 訓練 (64bit Python があれば・データ少ない時はスキップ動作)
    if not getattr(args, "skip_train", False):
        rc = run_train_lightgbm()
        if rc == -2: timed_out = True
        if rc != 0: overall |= 0x20
    # ★Wave18: 人気を見ない実力派モデル
    if not getattr(args, "skip_train_nopop", False):
        rc = run_train_lightgbm_nopop()
        if rc == -2: timed_out = True
        if rc != 0: overall |= 0x200
    # ★Wave19: 全レースの LGBM 推論 (predictions/<id>.json)
    if not getattr(args, "skip_lgbm_predict", False):
        rc = run_predict_lightgbm()
        if rc == -2: timed_out = True
        if rc != 0: overall |= 0x400
    # ★Wave19: 推奨買い目を集約 (100% 越え戦略 fuku_top1_prob_020)
    if not getattr(args, "skip_recommend", False):
        rc = run_aggregate_recommendations()
        if rc == -2: timed_out = True
        if rc != 0: overall |= 0x800
    # ★Wave33-2: 戦略ライブログ自動 (発火戦略を毎日 log + 過去の結果照合)
    try:
        py64 = python_exe_64()
        log_line("[step4.85] strategy_live_log.py (実運用 log + 結果照合)")
        rc = run_subprocess(
            [py64, str(JV_BRIDGE / "strategy_live_log.py")],
            "strategy_live_log", timeout=120,
        )
        if rc == -2: timed_out = True
    except Exception as e:
        log_line(f"  strategy_live_log 失敗 (継続): {e}")
    # ★Wave19: 回収率実証 (backtest_result.json 更新)
    if not getattr(args, "skip_validate", False):
        rc = run_validate_lightgbm()
        if rc == -2: timed_out = True
        if rc != 0: overall |= 0x1000
    # ★Wave14: 全レース予想の事前計算 (スマホ瞬時応答用)
    if not getattr(args, "skip_precompute", False):
        rc = run_precompute_predictions()
        if rc == -2: timed_out = True
        if rc != 0: overall |= 0x40
    # ★2026-05-30: 実験室 (自己成長する実験モード) を更新
    #   リークなし再学習 (重い・数分) → 12 作戦を紙上ベット採点 → experiment_status.json
    #   これで「使うほど成長する」が自動で回る。Supabase 非依存 (git push のみ)。
    if not getattr(args, "skip_experiment", False):
        rc = run_walk_forward_value_ev()
        if rc == -2: timed_out = True
        if rc != 0: overall |= 0x2000
        # 採点は土台データが無くても前回値で動くので、再学習が失敗しても採点は試みる
        rc = run_experiment_engine()
        if rc == -2: timed_out = True
        if rc != 0: overall |= 0x4000

    # ★Wave16-QA: 途中タイムアウトがあった場合、部分データを push せず次回再取得に任せる
    if timed_out:
        log_line("!! どこかのステップがタイムアウト → 不整合データの本番反映を避けるため git push スキップ")
        overall |= 0x100
    else:
        rc = git_commit_push()
        if rc != 0: overall |= 0x10

    log_line(f"=== race_day_pipeline 終了 (overall={overall:#x}, timed_out={timed_out}) ===")
    return overall


if __name__ == "__main__":
    sys.exit(main())
