# -*- coding: utf-8 -*-
r"""
probe_history.py — 「JRA-VAN のサーバーに、いつからのデータが残っているか」を
                   実際に聞いて測る道具。データは1バイトもダウンロードしない。

■ なにをするファイルか（やさしい説明）
  JV-Link には「JVOpen」という“注文”の窓口がある。
  ここに「この種類のデータを、この日から下さい」と頼むと、
  ダウンロードを始める前に「該当は○ファイルです」という返事だけ先に返ってくる。

  この道具は その返事だけ受け取って、すぐ JVClose（注文の取り消し）をする。
  ＝ 何ギガも落とさずに「どこまで昔まで遡れるか」だけが分かる。

  ⚠ JVRead（実際の読み出し）は一度も呼ばない。だから数秒で終わる。

■ 使い方
  py -3.12-32 jv_bridge/probe_history.py --dataspec RACE --option 1 \
      --fromtime 20140101000000-20150101000000

  複数まとめて（JVInit は1回だけ・1件ずつ JVOpen/JVClose する）:
  py -3.12-32 jv_bridge/probe_history.py --dataspec RACE --option 1 \
      --windows 2014 2015 2016 2017

  --windows に西暦を並べると「その年の1年ぶん」の窓を自動で作る。

■ 出す物
  1行1件の JSON を標準出力に出すだけ。ファイルは書かない（副作用ゼロ）。
  {"dataspec":"RACE","option":1,"fromtime":"...","rc":0,"readcount":123,...}

■ 戻り値(rc)の読み方（JV-Link インターフェース仕様書 3.コード表）
    0     正常（readcount = 該当ファイル数）
   -1     該当データ無し（＝その期間はサーバーに無い）
   -111   dataspec が不正
   -112   fromtime（開始時刻）が不正
   -113   fromtime（終了時刻）が不正
   -115   option が不正
   -116   dataspec と option の組み合わせが不正
   -201   JVInit が呼ばれていない
   -202   前回の JVClose 漏れ（オープンしっぱなし）
   -301   認証エラー（利用キー）
   -305   利用規約に同意していない
   -501   セットアップでスタートキット(CD/DVD-ROM)が無効
          ※CD/DVDの配布は2022年3月に終了済み
   -504   サーバーメンテナンス中

■ 安全のための約束
  ・JVRead を呼ばない（＝大量ダウンロードが起きない）
  ・1件ごとに必ず JVClose する（＝JV-Link を掴みっぱなしにしない）
  ・途中で落ちても finally で JVClose を試みる
  ・option=3/4 は「セットアップの選択ダイアログ」が出て止まることがある。
    この道具から呼ぶときは必ず外側で時間制限をかけて実行すること。
"""

from __future__ import annotations

import argparse
import json
import sys


def is_32bit() -> bool:
    return sys.maxsize <= 2**32


def make_window(year: int) -> str:
    """西暦 → その年まるごとの窓 'YYYY0101000000-YYYY1231235959'"""
    return f"{year}0101000000-{year}1231235959"


def probe_one(jv, dataspec: str, fromtime: str, option: int) -> dict:
    """JVOpen を1回だけ呼んで、返事をもらって、すぐ閉じる。"""
    out = {
        "dataspec": dataspec,
        "option": option,
        "fromtime": fromtime,
        "rc": None,
        "readcount": None,
        "downloadcount": None,
        "lastfiletimestamp": None,
        "error": None,
    }
    opened = False
    try:
        rc, readcount, downloadcount, lastfiletime = jv.JVOpen(
            dataspec, fromtime, option, 0, 0, ""
        )
        out["rc"] = int(rc)
        out["readcount"] = int(readcount) if readcount is not None else None
        out["downloadcount"] = int(downloadcount) if downloadcount is not None else None
        out["lastfiletimestamp"] = str(lastfiletime) if lastfiletime else ""
        # rc>=0 のときだけ「開いた」＝閉じる義務がある。
        # rc<0 でも念のため閉じる（-202 の再発を防ぐ）。
        opened = True
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"
    finally:
        if opened or out["error"]:
            try:
                jv.JVClose()
            except Exception:  # noqa: BLE001
                pass
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description="JVOpen だけで『どこまで遡れるか』を測る（ダウンロードしない）"
    )
    ap.add_argument("--sid", default="UNKNOWN")
    ap.add_argument("--dataspec", default="RACE")
    ap.add_argument("--option", type=int, default=1)
    ap.add_argument("--fromtime", nargs="*", default=[],
                    help="例: 20140101000000 または 20140101000000-20150101000000（複数可）")
    ap.add_argument("--windows", nargs="*", type=int,
                    help="西暦を並べる。例: --windows 2014 2016 2018（その年1年ぶんの窓になる）")
    args = ap.parse_args()

    if not is_32bit():
        print(json.dumps({"fatal": "64bit Python では JV-Link を呼べません。py -3.12-32 で実行してください。"},
                         ensure_ascii=False))
        return 2
    try:
        import win32com.client as win32
    except ImportError:
        print(json.dumps({"fatal": "pywin32 が入っていません。"}, ensure_ascii=False))
        return 2

    targets: list[str] = []
    if args.windows:
        targets.extend(make_window(y) for y in args.windows)
    if args.fromtime:
        targets.extend(args.fromtime)
    if not targets:
        print(json.dumps({"fatal": "--fromtime か --windows のどちらかを指定してください。"},
                         ensure_ascii=False))
        return 2

    jv = win32.Dispatch("JVDTLab.JVLink")
    rc = jv.JVInit(args.sid)
    if rc != 0:
        print(json.dumps({"fatal": f"JVInit failed rc={rc}"}, ensure_ascii=False))
        return 3

    try:
        for ft in targets:
            res = probe_one(jv, args.dataspec, ft, args.option)
            print(json.dumps(res, ensure_ascii=False), flush=True)
    finally:
        # 念のためもう一度。掴みっぱなしを絶対に残さない。
        try:
            jv.JVClose()
        except Exception:  # noqa: BLE001
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
