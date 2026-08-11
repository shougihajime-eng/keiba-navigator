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

──────────────────────────────────────────────────────────────
🚨 2026-08-12 大改修（なぜ直したか）
──────────────────────────────────────────────────────────────
  【欠陥1】貯めた 433 レースのうち **114 レース(26.3%) は「いちばん新しいスナップ」が
    発走時刻より後**だった。読み手(overlay/backtest/毎週の学習)はみんな
    「いちばん新しい .json」を最終オッズとして読むので、
    **実際には買えない“発走後のオッズ”で検証していた**＝回収率が下駄を履く。
    （実測：うまみ買いの回収率 121% が、買える時刻のオッズに直すと約100.7%）

  【直し方】
    ① 発走**後**に取ったスナップは、レースのフォルダ直下ではなく
       `exotic_odds/<raceid>/after/<unixtime>.json` に置く。
       → 読み手はどこも `readdirSync(dir).filter(f => f.endsWith(".json"))` なので
         サブフォルダは自動的に無視される＝**直下の最新＝必ず発走前の最後の1枚**になる。
         （読み手のコードを1行も触らずに直る。過去のファイルも動かさない＝壊さない）
    ② どのスナップにも **発走前か後かの印** を書き込む
       （postAt / minutesToPost / beforePost / slot / schemaVersion）。
       既存のキー(raceid / fetchedAt / odds)はそのまま＝**後方互換**。
    ③ 発走直前の1枚を必ず残すため、**「時間帯(スロット)ごとに1枚ずつ」**取りに行く。
       15分おきでは直前5分をまたぐので、呼び出し側は2分おきにする（collect_exotic.ps1）。

  【欠陥2】「直前5分の動き」を測れる形で貯まっていなかった。
    世界最大級の研究(Hanyu et al. 2025・JRA-VAN 89万件)では
    **発走直前5分のオッズ変化率**が単独で最強の説明変数（係数 -0.3386, SE 0.0392）。
    ⚠ ただし **-15〜-10分“だけ”を切り出すと符号が反転する(+0.3674)** ので、
      「直前5分」と「それより前」を混ぜてはいけない。
    → 下の SLOTS は -5分の境目でスロットを割り、
      **-5分の直前(t6)** と **直前5分の中(t4/t2/t1)** の両方に必ず1枚ずつ残す設計。
      計算そのものは `lib/late_move.js`（純関数）が行う。

使い方:
  # 1レース(発走直前)を1回だけ取る（動作確認・最終オッズの保存に）
  > py -3.12-32 jv_bridge\collect_exotic_odds.py --raceid 2026062810020205
  # 今日の“まもなく発走”のレースをまとめて取る（スケジューラから2分おきに実行）
  > py -3.12-32 jv_bridge\collect_exotic_odds.py --auto
  # 今どのスロットが埋まっているか見るだけ（JV-Link を叩かない）
  > py -3.12   jv_bridge\collect_exotic_odds.py --status
  # 過去ぶんの「発走後スナップ」を after/ へ引っ越す（既定は下見だけ）
  > py -3.12   jv_bridge\collect_exotic_odds.py --migrate-after
  > py -3.12   jv_bridge\collect_exotic_odds.py --migrate-after --apply

  dataspec 0B30 = 速報オッズ(全賭式) を1回叩けば O1〜O6 が全部来る。
  保存先: data/jv_cache/exotic_odds/<raceid>/<unixtime>.json        （発走前）
          data/jv_cache/exotic_odds/<raceid>/after/<unixtime>.json  （発走後・参考）
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

# 同じ jv_bridge の COM ラッパ・パーサを再利用（重複実装しない＝バグ源を増やさない）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from jv_bridge import jvdata_struct as st  # noqa: E402
from jv_bridge import io_helpers as io  # noqa: E402

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "jv_cache"
RACES_DIR = CACHE_DIR / "races"
OUT_DIR = CACHE_DIR / "exotic_odds"
AFTER_SUBDIR = "after"          # 発走後のスナップを隔離する場所（読み手から見えなくなる）
SCHEMA_VERSION = 2

JST = dt.timezone(dt.timedelta(hours=9))

# 取りたい券種（record_id → わかりやすい名前）。馬単/3連単も来れば貯めるが主役は馬連/ワイド/3連複。
# O1(単勝)も必須＝「うまみ発見」は単勝プール由来の本当の強さが土台なので一緒に貯める。
WANT = {"O2": "umaren", "O3": "wide", "O4": "umatan", "O5": "sanren", "O6": "sanrentan"}

# ── 時間帯(スロット)の定義 ────────────────────────────────────────
#   値は「発走まで あと何分」＝マイナスが発走前・プラスが発走後。
#   [lo, hi) の半開区間。1スロットにつき1枚だけ取る＝JV-Link を無駄に叩かない。
#   🚨 -5.0 をまたぐスロットを作らないこと（直前5分と、それより前が混ざると
#      研究で言う符号の反転〔-15〜-10分だけだと +0.3674〕を再現できなくなる）。
SLOTS = [
    ("t30", -35.0, -22.0),   # 早い時間の基準点
    ("t20", -22.0, -16.0),
    ("t15", -16.0, -11.0),   # 研究が「ここだけ見ると符号が逆」と言う帯
    ("t10", -11.0, -7.0),
    ("t6",  -7.0,  -5.0),    # ★直前5分の“開始点”になる基準スナップ
    ("t4",  -5.0,  -3.0),    # ★ここから直前5分
    ("t2",  -3.0,  -1.0),    # ★
    ("t1",  -1.0,   0.0),    # ★いちばん大事＝実際に買える最後の値段
    ("post", 0.0,   5.0),    # 発走後（after/ に隔離。参考用）
]
LATE_BOUNDARY_MIN = -5.0     # これより発走側＝「直前5分」
WINDOW_BEFORE_DEFAULT = 35   # 発走何分前から見に行くか
WINDOW_AFTER_DEFAULT = 5     # 発走何分後まで見に行くか

# ── 他の JV-Link 使用者と譲り合うための鍵 ───────────────────────
#   near_post_odds.ps1 / fetch_diff_hourly.ps1 と同じ場所・同じ書式(中身=PID)。
MY_LOCK = CACHE_DIR / "exotic_odds.lock"
OTHER_LOCKS = [
    (CACHE_DIR / "fetch_diff.lock", 25),   # (パス, これより古い鍵は無効とみなす分)
    (CACHE_DIR / "near_post.lock", 20),
]


# ============================================================
# 小さな道具
# ============================================================
def _log(msg: str) -> None:
    """ログはASCIIだけ（PowerShell 5.1 の Add-Content が日本語を文字化けさせるため）。"""
    print(msg, flush=True)


def slot_of(minutes_to_post: float | None) -> str | None:
    """発走まで何分か → スロット名。窓の外なら None。"""
    if minutes_to_post is None:
        return None
    for name, lo, hi in SLOTS:
        if lo <= minutes_to_post < hi:
            return name
    return None


def _read_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _race_json_for(rid16: str):
    """raceid(16桁) から races/*.json を探す（保存名は末尾00の18桁が正）。"""
    for name in (rid16 + "00.json", rid16 + ".json"):
        p = RACES_DIR / name
        if p.exists():
            d = _read_json(p)
            if d is not None:
                return d
    return None


def post_datetime(rid16: str, race: dict | None) -> dt.datetime | None:
    """発走時刻(JST)を返す。分からなければ None。

    🚨 発走時刻は races/*.json の `hassou_time`("HHMM") が本物。
       「9:50から25分おき」のような決め打ちは絶対にしない（過去にそれで失敗している）。
       日付は raceid の先頭8桁(YYYYMMDD)＝そのレースの開催日を使う。
    """
    hhmm = str((race or {}).get("hassou_time") or "").strip()
    if len(hhmm) != 4 or not hhmm.isdigit():
        return None
    ymd = rid16[:8]
    if len(ymd) != 8 or not ymd.isdigit():
        return None
    try:
        return dt.datetime.strptime(ymd + hhmm, "%Y%m%d%H%M").replace(tzinfo=JST)
    except Exception:
        return None


def minutes_to_post(when: dt.datetime, post: dt.datetime | None) -> float | None:
    """when(いつ取ったか) から見て、発走まであと何分か。マイナス＝まだ発走前。"""
    if post is None:
        return None
    return (when - post).total_seconds() / 60.0


def existing_slots(rid16: str, post: dt.datetime | None) -> dict:
    """すでに貯まっているスナップを見て、どのスロットが埋まっているかを返す。

    ファイル名(unixtime)だけで判定するので、印(メタ)が入っていない**昔のファイルでも効く**。
    """
    filled: dict[str, int] = {}
    rdir = OUT_DIR / rid16
    for d in (rdir, rdir / AFTER_SUBDIR):
        if not d.is_dir():
            continue
        for f in d.iterdir():
            if f.suffix != ".json" or not f.stem.isdigit():
                continue
            ts = int(f.stem)
            m = minutes_to_post(dt.datetime.fromtimestamp(ts, dt.timezone.utc), post)
            s = slot_of(m)
            if s:
                filled[s] = filled.get(s, 0) + 1
    return filled


# ── 鍵（他の JV-Link 使用者と譲り合う） ──────────────────────────
def _lock_busy(path: Path, max_age_min: float) -> bool:
    """その鍵は今“生きている”か。古い鍵・死んだPIDの鍵は無効(=空いている)とみなす。"""
    try:
        if not path.exists():
            return False
        age_min = (time.time() - path.stat().st_mtime) / 60.0
        if age_min > max_age_min:
            return False
        txt = path.read_text(encoding="utf-8", errors="ignore").strip()
        if txt.isdigit():
            pid = int(txt)
            if pid == os.getpid():
                return False
            return _pid_alive(pid)
        return True
    except Exception:
        return False


def _pid_alive(pid: int) -> bool:
    try:
        import ctypes
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        ctypes.windll.kernel32.CloseHandle(h)
        return True
    except Exception:
        # 判定できないときは「生きている」と考えて譲る（安全側）
        return True


def _others_busy() -> str | None:
    for p, age in OTHER_LOCKS:
        if _lock_busy(p, age):
            return p.name
    return None


def _take_my_lock() -> None:
    try:
        MY_LOCK.parent.mkdir(parents=True, exist_ok=True)
        MY_LOCK.write_text(str(os.getpid()), encoding="ascii")
    except Exception:
        pass


def _release_my_lock() -> None:
    try:
        MY_LOCK.unlink()
    except Exception:
        pass


# ============================================================
# オッズのパース（元のまま）
# ============================================================
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


# ============================================================
# 1レース取得
# ============================================================
def collect_one(jv, raceid: str, post: dt.datetime | None = None,
                legacy_layout: bool = False) -> dict | None:
    """1レースの全賭式オッズ(0B30)を取得→パース→時刻と『発走前/後』の印つきで保存。"""
    from jv_bridge.jv_fetch import jv_read  # 遅延 import（--status では COM を触らない）

    rid16 = raceid[:16] if (len(raceid) == 18 and raceid.endswith("00")) else raceid
    rc = jv.JVRTOpen("0B30", rid16)
    if rc != 0:
        _log(f"[NG] {rid16} JVRTOpen rc={rc} (not on sale yet / out of scope)")
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
            _log(f"[err] JVRead rc={rc}")
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
        _log(f"[--] {rid16} no exotic odds (not on sale yet)")
        return None

    now = dt.datetime.now(dt.timezone.utc)
    mtp = minutes_to_post(now, post)
    before = None if mtp is None else (mtp < 0.0)
    slot = slot_of(mtp)

    snap = {
        # ── 既存キー（読み手が使っている。絶対に変えない）─────────
        "raceid": rid16,
        "fetchedAt": now.isoformat(),
        "odds": bytype,  # {umaren:{items:[{key,odds,popularity}]}, wide:{items:[{key,odds_low,odds_high,...}]}, ...}
        # ── 2026-08-12 追加（発走前か後かの印。足すだけ＝後方互換）──
        "schemaVersion": SCHEMA_VERSION,
        "postAt": post.isoformat() if post else None,
        "hassouTime": post.strftime("%H%M") if post else None,
        "minutesToPost": (None if mtp is None else round(mtp, 3)),  # マイナス＝発走前
        "beforePost": before,          # True=買えた時刻 / False=発走後 / None=発走時刻不明
        "slot": slot,
        "happyoTime": (bytype.get("tansho") or {}).get("happyo_time"),  # JRAが出した時刻(MMDDHHMM/JST)
    }

    rdir = OUT_DIR / rid16
    # 🚨 発走後のスナップだけ after/ に隔離する。
    #    読み手は全員「直下の *.json のいちばん新しい物」を最終オッズとして読むので、
    #    ここを分けるだけで“買えない値段で検証する”事故が構造的に起きなくなる。
    if before is False and not legacy_layout:
        rdir = rdir / AFTER_SUBDIR
    rdir.mkdir(parents=True, exist_ok=True)
    (rdir / f"{int(now.timestamp())}.json").write_text(
        json.dumps(snap, ensure_ascii=False), encoding="utf-8")

    counts = {k: len(v["items"]) for k, v in bytype.items()}
    where = "after/" if (before is False and not legacy_layout) else ""
    mtxt = "post-time-unknown" if mtp is None else f"{mtp:+.1f}min"
    _log(f"[OK] {rid16} saved {where} slot={slot} {mtxt} {counts}")
    return snap


# ============================================================
# 今日の対象レースを選ぶ
# ============================================================
def _today_targets(window_before: int, window_after: int, now: dt.datetime,
                   want_after: bool = True) -> list[dict]:
    """races/*.json から「窓の中にいて、いまのスロットがまだ埋まっていない」レースを集める。

    返り値は「発走に近い順」（＝途中で打ち切られても大事な直前ぶんは取れている）。
    """
    if not RACES_DIR.exists():
        return []
    today = now.astimezone(JST).strftime("%Y%m%d")
    out = []
    for f in sorted(RACES_DIR.glob(f"{today}*.json")):
        r = _read_json(f)
        if not r:
            continue
        rid = str(r.get("race_id") or f.stem)
        rid16 = rid[:16] if (len(rid) == 18 and rid.endswith("00")) else rid
        post = post_datetime(rid16, r)
        if post is None:
            continue
        mtp = minutes_to_post(now, post)
        if mtp is None or mtp < -window_before or mtp > window_after:
            continue
        slot = slot_of(mtp)
        if slot is None:
            continue
        if slot == "post" and not want_after:
            continue
        filled = existing_slots(rid16, post)
        if filled.get(slot):
            continue  # このスロットはもう1枚ある＝叩かない
        out.append({"raceid": rid16, "post": post, "minutes": mtp, "slot": slot,
                    "filled": sorted(filled.keys())})
    out.sort(key=lambda x: abs(x["minutes"]))
    return out


# ============================================================
# --status : いま何が貯まっているかを見るだけ（JV-Link を触らない）
# ============================================================
def cmd_status(date_str: str | None) -> int:
    now = dt.datetime.now(dt.timezone.utc)
    day = date_str or now.astimezone(JST).strftime("%Y%m%d")
    files = sorted(RACES_DIR.glob(f"{day}*.json"))
    if not files:
        _log(f"[--] no races for {day}")
        return 0
    want = [n for n, lo, hi in SLOTS if n != "post"]
    _log(f"[STATUS] {day}  slots: {' '.join(want)}")
    n_ok = 0
    for f in files:
        r = _read_json(f)
        if not r:
            continue
        rid = str(r.get("race_id") or f.stem)
        rid16 = rid[:16] if (len(rid) == 18 and rid.endswith("00")) else rid
        post = post_datetime(rid16, r)
        if post is None:
            _log(f"  {rid16}  post-time UNKNOWN")
            continue
        filled = existing_slots(rid16, post)
        marks = "".join("o" if filled.get(s) else "." for s in want)
        has_late = any(filled.get(s) for s in ("t4", "t2", "t1"))
        has_base = bool(filled.get("t6")) or bool(filled.get("t10"))
        ok = has_late and has_base
        n_ok += 1 if ok else 0
        _log(f"  {rid16} {post.strftime('%H:%M')} [{marks}] "
             f"{'LATE5-OK' if ok else 'late5-missing'} after={filled.get('post', 0)}")
    _log(f"[STATUS] races ready for the 5-minute measure: {n_ok}/{len(files)}")
    return 0


# ============================================================
# --migrate-after : 過去ぶんの「発走後スナップ」を after/ へ引っ越す
#                   既定は下見だけ（--apply で実行）
# ============================================================
def cmd_migrate_after(apply: bool) -> int:
    if not OUT_DIR.exists():
        _log("[--] no exotic_odds dir")
        return 0
    moved = 0
    races_touched = 0
    races_would_lose_all = 0
    total_races = 0
    for rdir in sorted(OUT_DIR.iterdir()):
        if not rdir.is_dir():
            continue
        rid16 = rdir.name
        total_races += 1
        post = post_datetime(rid16, _race_json_for(rid16))
        if post is None:
            continue
        after_files = []
        before_files = []
        for f in rdir.iterdir():
            if f.suffix != ".json" or not f.stem.isdigit():
                continue
            m = minutes_to_post(dt.datetime.fromtimestamp(int(f.stem), dt.timezone.utc), post)
            (after_files if (m is not None and m >= 0) else before_files).append(f)
        if not after_files:
            continue
        races_touched += 1
        if not before_files:
            # 発走前の1枚も無いレース＝動かすと読み手から見えなくなる。安全のため触らない。
            races_would_lose_all += 1
            _log(f"  [skip] {rid16} has ONLY post-time snaps ({len(after_files)}) - left as is")
            continue
        for f in after_files:
            moved += 1
            if apply:
                dst_dir = rdir / AFTER_SUBDIR
                dst_dir.mkdir(parents=True, exist_ok=True)
                f.replace(dst_dir / f.name)
    verb = "moved" if apply else "would move"
    _log(f"[MIGRATE] races={total_races} affected={races_touched} "
         f"{verb}={moved} skipped(only-post-snaps)={races_would_lose_all}")
    if not apply:
        _log("[MIGRATE] dry run. add --apply to actually move files.")
    return 0


# ============================================================
def main():
    ap = argparse.ArgumentParser(description="collect pre-race exotic odds with a before/after-post mark")
    ap.add_argument("--sid", default="UNKNOWN")
    ap.add_argument("--raceid", help="16 digits (or 18 ending with 00). fetch just one race")
    ap.add_argument("--auto", action="store_true", help="fetch today's races that are near post time")
    ap.add_argument("--window", type=int, default=WINDOW_BEFORE_DEFAULT,
                    help=f"--auto: minutes before post to start (default {WINDOW_BEFORE_DEFAULT})")
    ap.add_argument("--after", type=int, default=WINDOW_AFTER_DEFAULT,
                    help=f"--auto: minutes after post to stop (default {WINDOW_AFTER_DEFAULT})")
    ap.add_argument("--no-after", action="store_true",
                    help="do not fetch anything after post time at all")
    ap.add_argument("--max-races", type=int, default=6, help="cap races per run (default 6)")
    ap.add_argument("--wait-lock", type=int, default=30,
                    help="seconds to wait for another JV-Link user (default 30)")
    ap.add_argument("--legacy-layout", action="store_true",
                    help="save post-time snaps in the race dir like before (NOT recommended)")
    ap.add_argument("--status", action="store_true", help="show what is stored (no JV-Link)")
    ap.add_argument("--date", help="--status: YYYYMMDD (default today JST)")
    ap.add_argument("--migrate-after", action="store_true",
                    help="move already-stored post-time snaps into after/ (dry run)")
    ap.add_argument("--apply", action="store_true", help="--migrate-after: really move the files")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # ── JV-Link を使わないコマンドは先に処理（32bit も pywin32 も要らない）──
    if args.status:
        sys.exit(cmd_status(args.date))
    if args.migrate_after:
        sys.exit(cmd_migrate_after(args.apply))

    from jv_bridge.jv_fetch import init_jvlink, require_pywin32, require_32bit
    if not (require_pywin32() and require_32bit()):
        _log("[NG] needs 32-bit Python + pywin32 (e.g. py -3.12-32).")
        sys.exit(2)

    # ── 自分の二重起動を止める ────────────────────────────────
    if _lock_busy(MY_LOCK, 12):
        _log("[--] another collect_exotic run is active - exit")
        sys.exit(0)

    now = dt.datetime.now(dt.timezone.utc)
    targets: list[dict] = []
    if args.raceid:
        rid = args.raceid
        rid16 = rid[:16] if (len(rid) == 18 and rid.endswith("00")) else rid
        targets = [{"raceid": rid16, "post": post_datetime(rid16, _race_json_for(rid16)),
                    "minutes": 0.0, "slot": None, "filled": []}]
    elif args.auto:
        targets = _today_targets(args.window, args.after, now,
                                 want_after=(not args.no_after))
        _log(f"[INFO] near-post races needing a snapshot: {len(targets)} "
             f"(window -{args.window}min .. +{args.after}min)")
        for t in targets:
            _log(f"       {t['raceid']} {t['minutes']:+.1f}min slot={t['slot']} have={','.join(t['filled']) or '-'}")
    else:
        _log("[NG] give --raceid or --auto (or --status / --migrate-after).")
        sys.exit(1)

    if not targets:
        _log("[--] nothing to do.")
        sys.exit(0)

    # ── 他の JV-Link 使用者に譲る。ただし“直前5分”だけは譲りきらない ──
    #    （直前の1枚を落とすと、この仕組みを作った意味がなくなるため）
    critical = any((t["minutes"] is not None and t["minutes"] >= LATE_BOUNDARY_MIN and t["minutes"] < 0)
                   for t in targets) or bool(args.raceid)
    waited = 0
    while True:
        busy = _others_busy()
        if not busy:
            break
        if waited >= args.wait_lock:
            if critical:
                _log(f"[warn] {busy} still busy after {waited}s but a race is inside the last 5 min - going anyway")
                break
            _log(f"[--] {busy} is using JV-Link - skip this run (back in a couple of minutes)")
            sys.exit(0)
        time.sleep(5)
        waited += 5
    if waited:
        _log(f"[INFO] waited {waited}s for another JV-Link user")

    _take_my_lock()
    ok = 0
    tried = 0
    try:
        try:
            jv = init_jvlink(args.sid)
        except Exception as e:
            _log(f"[NG] JVInit failed: {e}")
            sys.exit(3)

        for t in targets[: max(1, args.max_races)]:
            tried += 1
            try:
                if collect_one(jv, t["raceid"], t["post"], legacy_layout=args.legacy_layout):
                    ok += 1
            except Exception as e:
                _log(f"[err] {t['raceid']}: {e}")
    finally:
        _release_my_lock()

    _log(f"[DONE] saved {ok}/{tried} races")
    sys.exit(0)


if __name__ == "__main__":
    main()
