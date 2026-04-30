# -*- coding: utf-8 -*-
"""
JV-Link bridge — JRA-VAN Data Lab. の COM コンポーネント (JVLink.ocx) を
Python 32bit + pywin32 から呼び出してレースデータを取得し、
../data/jv_cache/ 以下に JSON で保存する。

前提（このスクリプトが動くまでに必要なもの）:
  1. JRA-VAN Data Lab. を契約済み（月額2,090円）
  2. JV-Link をインストール済み（jra-van.jp/dlb/sdv/sdk.html）
  3. 32bit Python 3 がインストール済み（64bitでは JVLink.ocx をDispatchできない）
  4. pip install pywin32

使い方:
  > py -3.12-32 jv_bridge\jv_fetch.py --mode init
  > py -3.12-32 jv_bridge\jv_fetch.py --mode rt --dataspec 0B31 --raceid 2026YYYYMMDDJJRRRR

注意:
  JV-Data 各レコードの完全フィールド配置は「JVData仕様書」（developer.jra-van.jp で配布）
  を参照する必要があります。本スクリプトはレコード種別ID（先頭2バイト）と本文の
  生バイト列を保存するところまでを公式仕様に基づいて実装しており、各フィールドの
  個別パース（馬名・オッズ位置等）は仕様書取得後に拡張する設計です。
  推測でフィールドオフセットを書くことは禁止事項のため行いません。
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
        with open(out_path, "wb") as f:
            while True:
                # JVRead(buf, size, filename) → 1レコードを返す。バッファサイズは仕様上 256000 程度確保。
                buf_size = 256000
                buf = ""
                fname = ""
                rc, buf, fname = jv.JVRead(buf, buf_size, fname)
                if rc == 0:
                    break  # 全データ読み取り完了
                if rc == -1:
                    raise RuntimeError("JVRead error -1")
                if rc == -3:
                    # ファイル変わり目
                    continue
                # 通常データ（rc は読み取りバイト数）
                data = buf.encode("shift_jis", errors="replace") if isinstance(buf, str) else buf
                f.write(data)
                # レコード種別 = 先頭2バイトをUTF-8で
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

    args = parser.parse_args()
    if args.mode == "init":
        sys.exit(cmd_init(args))
    elif args.mode == "rt":
        sys.exit(cmd_rt(args))
    elif args.mode == "status":
        sys.exit(cmd_status(args))


if __name__ == "__main__":
    main()
