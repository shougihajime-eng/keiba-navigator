# -*- coding: utf-8 -*-
r"""
collect_exotic_odds.py — レース直前の「連系・3連系オッズ」を時刻つきで貯める。

★なぜ作るか（はじめさんの「絶対勝てる」挑戦の土台）:
  競馬で実際に勝って大きな税金でもめた人たち(大阪の会社員の馬券裁判 など)は、
  「単勝プールから作った“本当の強さ”と、馬連/ワイド/3連複プールの“値段(オッズ)”を
   ソフトで毎レース見比べ、割安な組合せ(うまみ)だけを大量に買う」やり方だった。
  そのためには 「発走直前の 馬連/ワイド/3連複 オッズ」 を貯めておく必要がある。
  当アプリは単勝オッズ(O1)しか取っていなかったので、ここで O2/O3/O5(/O4/O6) を集める。

  ※これは“データを貯める”だけ。お金は賭けない・予想も変えない。
   貯まったオッズで後日「うまみ買い」の本当の回収率を正直に検証する(別スクリプト)。

使い方:
  # 1レース(発走直前)を1回だけ取る（動作確認・最終オッズの保存に）
  > py -3.12-32 jv_bridge\collect_exotic_odds.py --raceid 2026062810020205
  # 今日の“まもなく発走(既定35分以内)”のレースをまとめて取る（スケジューラから定期実行）
  > py -3.12-32 jv_bridge\collect_exotic_odds.py --auto

  dataspec 0B30 = 速報オッズ(全賭式) を1回叩けば O1〜O6 が全部来る。
  保存先: data/jv_cache/exotic_odds/<raceid>/<unixtime>.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

# 同じ jv_bridge の COM ラッパ・パーサを再利用（重複実装しない＝バグ源を増やさない）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from jv_bridge.jv_fetch import init_jvlink, jv_read, require_pywin32, require_32bit  # noqa: E402
from jv_bridge import jvdata_struct as st  # noqa: E402
from jv_bridge import io_helpers as io  # noqa: E402

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "jv_cache"
RACES_DIR = CACHE_DIR / "races"
OUT_DIR = CACHE_DIR / "exotic_odds"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# 取りたい券種（record_id → わかりやすい名前）。馬単/3連単も来れば貯めるが主役は馬連/ワイド/3連複。
# O1(単勝)も必須＝「うまみ発見」は単勝プール由来の本当の強さが土台なので一緒に貯める。
WANT = {"O2": "umaren", "O3": "wide", "O4": "umatan", "O5": "sanren", "O6": "sanrentan"}


def _parse_odds_record(data: bytes) -> tuple[str, dict]:
    """1レコード(bytes)を見て record_id を判定し、組番→オッズの一覧に変換して返す。
    返り値: (record_id, {"happyo_time":..., "horse_count":..., "items":[...]})
    対象外レコードなら ("", None)。
    """
    if not data or len(data) < 40:
        return "", None
    rid = data[:2].decode("ascii", errors="replace")
    # O1(単勝)= うまみ計算の土台。馬番→単勝オッズ/人気の表にして返す。
    if rid == "O1":
        from jv_bridge.parse import build_o1_win_tables
        try:
            t = build_o1_win_tables(data)
        except Exception:
            return rid, None
        win = t.get("win_odds_by_horse") or {}
        if not win:
            return rid, None
        items = [{"number": int(n), "odds": v,
                  "popularity": (t.get("popularity_by_horse") or {}).get(n)}
                 for n, v in win.items() if v]
        happyo = data[27:35].decode("ascii", errors="replace").strip()
        return rid, {"happyo_time": happyo, "data_kbn": data[2:3].decode("ascii", errors="replace"),
                     "kind": "tansho", "items": items}
    if rid not in WANT:
        return rid, None
    loop = st.ODDS_LOOPS.get(rid)
    if not loop:
        return rid, None
    kind = loop["type"]
    off, elen, maxc = loop["offset"], loop["element_len"], loop["max_count"]
    items = []
    for i in range(maxc):
        s = off + i * elen
        e = s + elen
        if e > len(data):
            break
        el = data[s:e]
        parsed = st.parse_odds_element(el, kind)
        if parsed:
            items.append(parsed)
    # ヘッダから発表時刻と頭数を拾う（中間/前日最終/最終/確定 の区別や時刻記録に使う）
    happyo = data[27:35].decode("ascii", errors="replace").strip()
    try:
        hcount = io.to_int(data[37:39].decode("ascii", errors="replace"))
    except Exception:
        hcount = None
    data_kbn = data[2:3].decode("ascii", errors="replace")
    return rid, {"happyo_time": happyo, "data_kbn": data_kbn, "horse_count": hcount, "items": items}


def collect_one(jv, raceid: str) -> dict | None:
    """1レースの全賭式オッズ(0B30)を取得→パース→時刻つきで保存。保存した dict を返す。"""
    rid16 = raceid[:16] if (len(raceid) == 18 and raceid.endswith("00")) else raceid
    rc = jv.JVRTOpen("0B30", rid16)
    if rc != 0:
        print(f"[NG] {rid16} JVRTOpen rc={rc}（まだ発売前/対象外の可能性）")
        return None
    bytype: dict = {}
    while True:
        rc, data, _fname = jv_read(jv)
        if rc == 0:
            break
        if rc == -1:
            continue
        if rc == -3:
            time.sleep(0.4)
            continue
        if rc < 0:
            print(f"[err] JVRead rc={rc}")
            break
        if not data:
            continue
        rid, parsed = _parse_odds_record(data)
        if parsed and parsed["items"]:
            name = "tansho" if rid == "O1" else WANT.get(rid)
            if name:
                bytype[name] = parsed
    try:
        jv.JVClose()
    except Exception:
        pass
    if not bytype:
        print(f"[--] {rid16} 連系オッズなし（発売前など）")
        return None
    now = dt.datetime.now(dt.timezone.utc)
    snap = {
        "raceid": rid16,
        "fetchedAt": now.isoformat(),
        "odds": bytype,  # {umaren:{items:[{key,odds,popularity}]}, wide:{items:[{key,odds_low,odds_high,...}]}, sanren:{...}}
    }
    rdir = OUT_DIR / rid16
    rdir.mkdir(parents=True, exist_ok=True)
    (rdir / f"{int(now.timestamp())}.json").write_text(
        json.dumps(snap, ensure_ascii=False), encoding="utf-8")
    counts = {k: len(v["items"]) for k, v in bytype.items()}
    print(f"[OK] {rid16} 保存 {counts}")
    return snap


def _today_upcoming(window_min: int) -> list[str]:
    """races/*.json から「今からwindow_min分以内に発走」のレースIDを集める。"""
    if not RACES_DIR.exists():
        return []
    now = dt.datetime.now(dt.timezone.utc)
    today = now.astimezone(dt.timezone(dt.timedelta(hours=9))).strftime("%Y%m%d")  # JSTの今日
    JST = dt.timezone(dt.timedelta(hours=9))
    out = []
    for f in RACES_DIR.glob(f"{today}*.json"):
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        rid = str(r.get("race_id") or f.stem)
        hhmm = str(r.get("hassou_time") or "").strip()  # "0950" = 09:50 JST
        if len(hhmm) != 4 or not hhmm.isdigit():
            continue
        try:
            stt = dt.datetime.strptime(today + hhmm, "%Y%m%d%H%M").replace(tzinfo=JST)
        except Exception:
            continue
        mins = (stt - now).total_seconds() / 60.0
        # 発走の window_min分前 〜 発走5分後 まで（直前オッズ＝勝者たちが見ていた値）
        if -5 <= mins <= window_min:
            out.append(rid)
    return out


def main():
    ap = argparse.ArgumentParser(description="直前の連系・3連系オッズを貯める")
    ap.add_argument("--sid", default="UNKNOWN")
    ap.add_argument("--raceid", help="16桁(または末尾00の18桁)。1レースだけ取る")
    ap.add_argument("--auto", action="store_true", help="今日のまもなく発走のレースをまとめて取る")
    ap.add_argument("--window", type=int, default=35, help="--auto で「発走何分前から取るか」(既定35)")
    args = ap.parse_args()

    if not (require_pywin32() and require_32bit()):
        print("[NG] 32bit Python + pywin32 が必要です（例: py -3.12-32）。")
        sys.exit(2)

    targets = []
    if args.raceid:
        targets = [args.raceid]
    elif args.auto:
        targets = _today_upcoming(args.window)
        print(f"[INFO] まもなく発走 {len(targets)} レースを収集（{args.window}分前から）")
    else:
        print("[NG] --raceid か --auto を指定してください。")
        sys.exit(1)

    if not targets:
        print("[--] 対象レースなし（発走時刻が先 or 今日レースなし）。")
        sys.exit(0)

    try:
        jv = init_jvlink(args.sid)
    except Exception as e:
        print(f"[NG] JVInit 失敗: {e}")
        sys.exit(3)

    ok = 0
    for rid in targets:
        try:
            if collect_one(jv, rid):
                ok += 1
        except Exception as e:
            print(f"[err] {rid}: {e}")
        # JVRTOpen は1レースごとに開き直す必要があるため、毎回 init し直す版にしたいが、
        # 多くの環境で同一 jv で連続 JVRTOpen 可。失敗が続く場合は init を毎回に変える。
    print(f"[DONE] {ok}/{len(targets)} レース保存")
    sys.exit(0)


if __name__ == "__main__":
    main()
