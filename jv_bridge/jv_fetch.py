# -*- coding: utf-8 -*-
r"""
JV-Link bridge — JRA-VAN Data Lab. の COM コンポーネント (JVLink.ocx) を
Python 32bit + pywin32 から呼び出してレースデータを取得し、
../data/jv_cache/ 以下に JSON で保存する。

前提（このスクリプトが動くまでに必要なもの）:
  1. JRA-VAN Data Lab. を契約済み（月額2,090円・無料体験含む）
  2. JV-Link をインストール済み（jra-van.jp/dlb/sdv/sdk.html）
  3. 32bit Python 3 がインストール済み（64bitでは JVLink.ocx をDispatchできない）
  4. pip install pywin32

使い方:
  > py -3.12-32 jv_bridge\jv_fetch.py init
  > py -3.12-32 jv_bridge\jv_fetch.py rt --dataspec 0B31 --raceid 2026YYYYMMDDJJRRRR
  > py -3.12-32 jv_bridge\jv_fetch.py aggregate --dataspec RACE --fromtime 20260510000000

注意:
  JV-Data 各レコードの完全フィールド配置は SDK 4.9.0.2 同梱の C# 構造体から
  jvdata_struct.py に転記済み。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import traceback
from pathlib import Path

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "jv_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
STATUS_PATH = CACHE_DIR / "_status.json"


def write_status(state: str, **extra) -> None:
    payload = {
        "state": state,
        "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        **extra,
    }
    STATUS_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def require_pywin32():
    try:
        import win32com.client  # noqa: F401
        return True
    except ImportError:
        return False


def require_32bit():
    # JV-Link は 32bit COM のため、64bit Python からは Dispatch に失敗する。
    is_32 = sys.maxsize <= 2**32
    return is_32


def init_jvlink(sid: str = "UNKNOWN"):
    """JVInit を呼び出して JV-Link を初期化する。"""
    import win32com.client as win32
    jv = win32.Dispatch("JVDTLab.JVLink")
    rc = jv.JVInit(sid)
    if rc != 0:
        raise RuntimeError(f"JVInit failed rc={rc}")
    return jv


def _coerce_jv_buf(buf) -> bytes:
    """JVGets / JVRead が返すバッファを SJIS バイト列 (bytes) に統一する。

    2026-05-25 根本修正の経緯:
      JV-Link は馬名・騎手名などを SJIS (cp932) で送ってくる。これを Python 側で
      どう受け取るかで、過去 2 度バグった。
        - ❌ shift_jis encode: 一度誤デコードされた str を再 encode できず `?` 化
        - ❌ latin-1 encode (2026-05-19 の "修正"): pywin32 は BSTR を **システム ANSI
             コードページ (日本語 Windows では cp932)** で Unicode str にデコードして渡す。
             つまり buf は「コンフェルマ」のような正しい全角文字を含む str。これを
             latin-1 で encode すると U+00FF を超える文字 (全角かな等) が全部 `?` (0x3F)
             に置換され、馬名が `??????` に潰れていた (5/22 以降のデータ破損の真因)。
      ✅ 正しい復元:
        - JVGets はバイト配列 (memoryview/bytes) をそのまま返す → そのまま bytes 化が最善
        - JVRead が str を返す場合は、デコードに使われた cp932 で encode し直すと原 SJIS
          バイト列が無損失で戻る (diag_read.py で「コンフェルマ」「ミサビスケッツ」復元を確認)
    """
    if buf is None:
        return b""
    if isinstance(buf, (bytes, bytearray)):
        return bytes(buf)
    if isinstance(buf, memoryview):
        return buf.tobytes()
    if isinstance(buf, str):
        # pywin32 が ANSI codepage (cp932) でデコード済みの str。同じ cp932 で戻す。
        return buf.encode("cp932", errors="replace")
    # SafeArray / tuple of ints など
    try:
        return bytes(buf)
    except Exception:
        return b""


def jv_read(jv, buf_size: int = 256000):
    """1 レコードを JVRead で読み込み (rc, data_bytes, fname) を返す。

    JVRead は JV-Link 標準の読み出し API で、レコード末尾の CRLF を保ったまま返すため、
    parse.parse_raw_file の区切り処理がそのまま使える (本コードで数ヶ月の実績あり)。
    唯一のバグは「受け取った str をどの文字コードで bytes に戻すか」だった
    (_coerce_jv_buf 参照: latin-1 では日本語が全部 `?` に潰れていた → cp932 が正解)。

    なお JVGets (バイト配列版) は各レコード末尾に余分な NUL を付けて返す版があり、
    parse_raw_file のレコード境界判定を壊す (2026-05-25 検証済) ため使わない。

    戻り値タプルは JV-Link のバージョン差で
      (rc, buf, fname)            … 3-tuple
      (rc, buf, size_out, fname)  … 4-tuple
    のどちらかになるため両方を吸収する。
    """
    result = jv.JVRead("", buf_size, "")
    if not isinstance(result, tuple):
        return (int(result or 0), b"", "")
    if len(result) == 3:
        rc, buf, fname = result
    elif len(result) == 4:
        rc, buf, _size_out, fname = result
    else:
        raise RuntimeError(f"JVRead returned unexpected tuple of length {len(result)}: {result!r}")
    return (int(rc or 0), _coerce_jv_buf(buf), fname or "")


def cmd_init(args) -> int:
    if not require_pywin32():
        write_status("missing_pywin32", error="pywin32 が見つかりません。`pip install pywin32` を実行してください。")
        print("[NG] pywin32 が見つかりません。32bit Python で `pip install pywin32` してください。")
        return 2
    if not require_32bit():
        write_status("wrong_arch", error="JV-Link は 32bit COM のため、32bit Python が必要です。")
        print("[NG] このPythonは 64bit です。32bit Python (例: py -3.12-32) で実行してください。")
        return 2
    try:
        jv = init_jvlink(args.sid)
        write_status("ready", sid=args.sid, message="JVInit OK")
        print("[OK] JVInit 成功")
        try:
            jv.JVClose()
        except Exception:
            pass
        return 0
    except Exception as e:
        write_status("init_failed", error=str(e), trace=traceback.format_exc())
        print(f"[NG] JVInit に失敗: {e}")
        print("    - JV-Link が未インストール")
        print("    - JRA-VAN Data Lab. が未契約")
        print("    - JV-Link 利用キーが未設定")
        print("    のいずれかが考えられます。jv_bridge/SETUP.txt を参照してください。")
        return 3


def cmd_rt(args) -> int:
    """JVRTOpen でリアルタイム系（オッズ・馬体重等）を取得する。"""
    if not (require_pywin32() and require_32bit()):
        return cmd_init(args)
    try:
        jv = init_jvlink(args.sid)
        rc = jv.JVRTOpen(args.dataspec, args.raceid)
        if rc != 0:
            raise RuntimeError(f"JVRTOpen failed rc={rc}")

        out_path = CACHE_DIR / f"raw_{args.dataspec}_{args.raceid}_{int(dt.datetime.now().timestamp())}.bin"
        records = []
        import time as _time
        with open(out_path, "wb") as f:
            while True:
                rc, data, _fname = jv_read(jv)
                if rc == 0:
                    break  # 全データ読み取り完了 (EOF)
                if rc == -1:
                    # ファイル切り替わり (続行・JV-Link 仕様書 p.56)
                    continue
                if rc == -3:
                    # ファイルダウンロード中。待機して再試行
                    _time.sleep(0.5)
                    continue
                if rc < 0:
                    print(f"[err] JVRead rc={rc}")
                    break
                if not data:
                    continue
                f.write(data)
                rec_type = data[:2].decode("ascii", errors="replace") if len(data) >= 2 else ""
                records.append({"recordType": rec_type, "size": len(data)})

        try: jv.JVClose()
        except Exception: pass

        meta = {
            "ok": True,
            "mode": "rt",
            "dataspec": args.dataspec,
            "raceid": args.raceid,
            "rawFile": str(out_path.name),
            "recordCount": len(records),
            "recordsHead": records[:50],
            "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "note": "本ファイルはレコード種別までを抽出しています。各フィールドの完全パースには JVData 仕様書が必要です。",
        }
        meta_path = CACHE_DIR / f"meta_{args.dataspec}_{args.raceid}.json"
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        write_status("ready", lastFetch=meta)
        print(f"[OK] 取得完了。{len(records)} レコード保存 → {out_path.name}")
        return 0
    except Exception as e:
        write_status("rt_failed", error=str(e), trace=traceback.format_exc())
        print(f"[NG] JVRTOpen 取得失敗: {e}")
        return 4


def cmd_status(args) -> int:
    if STATUS_PATH.exists():
        print(STATUS_PATH.read_text(encoding="utf-8"))
    else:
        print('{"state":"never_run","note":"jv_fetch.py がまだ一度も実行されていません"}')
    return 0


def cmd_watch(args) -> int:
    """発走前後で取得頻度を変えながら継続的にRT取得する。
    フェーズ:
      idle:       30分間隔
      t-60min:    5分間隔
      t-30min:    2分間隔
      t-10min:    30秒間隔 (最重要監視)
      t+5min:     30秒間隔(直後の確定オッズと結果)
      after t+15: 通常 idle に戻る

    Ctrl+C で停止。
    """
    if not (require_pywin32() and require_32bit()):
        return cmd_init(args)
    import time
    try:
        race_dt = dt.datetime.fromisoformat(args.startat) if args.startat else None
    except Exception:
        print(f"[NG] --startat は ISO 形式 (例: 2026-05-01T15:40:00+09:00) で指定してください")
        return 5

    print(f"[INFO] watch モード開始。race={args.raceid} startat={args.startat}")
    print(f"       Ctrl+C で停止。データは ../data/jv_cache/ に保存されます。")

    try:
        while True:
            now = dt.datetime.now(dt.timezone.utc)
            if race_dt is not None:
                # race_dt と now の差(秒)
                delta = (race_dt - now).total_seconds()
            else:
                delta = None

            # 取得実行 (RTオッズ + 馬体重等)
            try:
                cmd_rt(args)
            except Exception as e:
                print(f"[WARN] RT取得失敗: {e}")

            # 次回までの待機時間決定
            if delta is None:
                wait = 30 * 60
                phase = "idle (発走時刻不明)"
            elif delta > 60 * 60:
                wait = 30 * 60; phase = "idle"
            elif delta > 30 * 60:
                wait = 5 * 60;  phase = "t-60min"
            elif delta > 10 * 60:
                wait = 2 * 60;  phase = "t-30min"
            elif delta > -15 * 60:
                wait = 30;       phase = "t-10min/直後"
            else:
                print(f"[INFO] 発走から15分以上経過 → watch 終了")
                return 0
            print(f"[{phase}] 残り {int(delta) if delta else '?'} 秒  次回まで {wait} 秒")
            time.sleep(wait)
    except KeyboardInterrupt:
        print("\n[STOP] watch モード停止")
        return 0


def cmd_aggregate(args) -> int:
    """G1過去10年集計用にJVOpenで蓄積系データを取得する。
    DataSpec 'RACE' で一定期間分のRACEデータを取得。
    結果を ../data/jv_cache/aggregate_<from>-<to>/ に保存。
    バイナリ完全パースは仕様書取得後に実装(現状は raw + recordType のみ)。
    """
    if not (require_pywin32() and require_32bit()):
        return cmd_init(args)
    try:
        jv = init_jvlink(args.sid)
        # JVOpen(dataspec, fromtime, option, readcount*, downloadcount*, lastfiletimestamp*)
        # 戻り値は (rc, readcount, downloadcount, lastfiletimestamp) の 4-tuple
        opt = int(args.option) if isinstance(args.option, str) else args.option
        rc, readcount, downloadcount, lastfiletime = jv.JVOpen(
            args.dataspec, args.fromtime, opt, 0, 0, ""
        )
        # 2026-05-23 修正: rc=-1 は「該当データなし」を意味する正常終了
        # (5/22 12:32 から自動取得が壊れた根本原因: rc=-1 を fatal error 扱いしていたため
        #  fromtime が直近で「もう取得済」になると毎時失敗続きになっていた)
        if rc == -1:
            print(f"[info] JVOpen rc=-1 (該当データなし・正常終了)")
            write_status("aggregate_no_data", fromtime=args.fromtime, dataspec=args.dataspec)
            return 0  # exit 0 で「データなし正常」を伝える
        if rc < 0:
            # その他の負値は本物のエラー
            raise RuntimeError(f"JVOpen failed rc={rc}")
        print(f"[info] JVOpen OK rc={rc} readcount={readcount} downloadcount={downloadcount}")
        if downloadcount and downloadcount > 0:
            print(f"[info] {downloadcount} ファイルのダウンロードが必要。完了まで待機します...")
            # JVStatus でダウンロード進捗を監視
            import time
            while True:
                try:
                    stat = jv.JVStatus()
                except Exception:
                    break
                if stat is None: break
                # JVStatus: ダウンロード完了 = downloadcount に達した時
                if stat >= downloadcount:
                    print(f"[info] ダウンロード完了 ({stat}/{downloadcount})")
                    break
                if stat < 0:
                    print(f"[warn] JVStatus={stat} (エラー扱いの可能性)")
                    break
                print(f"  ダウンロード進捗: {stat}/{downloadcount}")
                time.sleep(2)
        agg_dir = CACHE_DIR / f"aggregate_{args.fromtime[:8]}_{args.dataspec}"
        agg_dir.mkdir(parents=True, exist_ok=True)
        out_path = agg_dir / f"raw_{int(dt.datetime.now().timestamp())}.bin"
        records = []
        import time as _time
        file_switches = 0
        wait_retries = 0
        with open(out_path, "wb") as f:
            while True:
                rc, data, _fname = jv_read(jv)
                if rc == 0:
                    # 全ファイル読み込み終了 (EOF・正常完了)
                    break
                if rc == -1:
                    # -1: ファイル切り替わり (JV-Link 仕様書 p.56)
                    # → エラーではない。バッファは空。次のファイル読み出しに続行する。
                    # ❌ 以前は break していたが、これだと 1 ファイル目で止まる重大バグだった
                    file_switches += 1
                    continue
                if rc == -3:
                    # -3: ファイルダウンロード中。少し待って再試行
                    wait_retries += 1
                    if wait_retries > 600:  # 最大 10 分まで待機
                        print("[warn] JVRead rc=-3 が 10 分続いた → 中断")
                        break
                    _time.sleep(1)
                    continue
                if rc < 0:
                    # その他のエラー (-201/-202/-203/-402/-403/-502/-503 など)
                    print(f"[err] JVRead rc={rc} → 中断")
                    break
                # rc > 0 = 読み込んだバイト数
                if not data:
                    continue
                f.write(data)
                rec_type = data[:2].decode("ascii", errors="replace") if len(data) >= 2 else ""
                records.append({"recordType": rec_type, "size": len(data)})
                # 進捗ログ (10000 件ごと)
                if len(records) % 10000 == 0:
                    print(f"  [info] JVRead 進捗: {len(records)} records / file_switches={file_switches}", flush=True)
        print(f"[info] file_switches={file_switches} 回 / wait_retries={wait_retries} 回")

        try: jv.JVClose()
        except Exception: pass

        meta = {
            "ok": True,
            "mode": "aggregate",
            "dataspec": args.dataspec,
            "fromtime": args.fromtime,
            "rawFile": str(out_path.relative_to(CACHE_DIR)),
            "recordCount": len(records),
            "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "note": "完全パースはJVData仕様書取得後。",
        }
        meta_path = agg_dir / "meta.json"
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        write_status("ready", lastAggregate=meta)
        print(f"[OK] 集計取得完了。{len(records)} レコード → {out_path.name}")
        return 0
    except Exception as e:
        write_status("aggregate_failed", error=str(e), trace=traceback.format_exc())
        print(f"[NG] JVOpen aggregate 失敗: {e}")
        return 6


def main():
    parser = argparse.ArgumentParser(description="JV-Link bridge for 競馬ダッシュボード")
    sub = parser.add_subparsers(dest="mode", required=True)

    p_init = sub.add_parser("init", help="JV-Link を初期化（接続テスト）")
    p_init.add_argument("--sid", default="UNKNOWN")

    p_rt = sub.add_parser("rt", help="リアルタイム系データを取得")
    p_rt.add_argument("--sid", default="UNKNOWN")
    p_rt.add_argument("--dataspec", default="0B31", help="例: 0B31=単複オッズ")
    p_rt.add_argument("--raceid", required=True, help="例: 2026YYYYMMDDJJRRRR の18桁")

    sub.add_parser("status", help="現在のステータスを表示")

    p_watch = sub.add_parser("watch", help="発走前後で頻度を変えながら継続的に取得")
    p_watch.add_argument("--sid", default="UNKNOWN")
    p_watch.add_argument("--dataspec", default="0B31")
    p_watch.add_argument("--raceid", required=True)
    p_watch.add_argument("--startat", help="ISO datetime (例: 2026-05-01T15:40:00+09:00)")

    p_agg = sub.add_parser("aggregate", help="蓄積系データ(過去成績/血統等)を一括取得")
    p_agg.add_argument("--sid", default="UNKNOWN")
    p_agg.add_argument("--dataspec", default="RACE", help="例: RACE/UMA/SE/HR")
    p_agg.add_argument("--fromtime", required=True, help="例: 20140101000000 (10年前)")
    p_agg.add_argument("--option", default="1", help="1=今回 2=今回+前回 3=ダイアログあり 4=セットアップ")

    args = parser.parse_args()
    if args.mode == "init":      sys.exit(cmd_init(args))
    elif args.mode == "rt":      sys.exit(cmd_rt(args))
    elif args.mode == "watch":   sys.exit(cmd_watch(args))
    elif args.mode == "aggregate": sys.exit(cmd_aggregate(args))
    elif args.mode == "status":  sys.exit(cmd_status(args))


if __name__ == "__main__":
    main()
