# -*- coding: utf-8 -*-
"""
archive_signals.py — 「硬い事実」を時間を追って貯める箱

毎時取得 (fetch_diff_hourly.ps1) の build_all 直後に呼ばれる想定。
直近で更新された races/<id>.json から、レースごとに
  時刻つきスナップショット (オッズ・人気・取消区分・馬体重・ブリンカー・馬場・天気)
を data/jv_cache/signals/<raceId>.json に追記する。

なぜ作るか:
  競馬のオッズ(人気)は公開情報をほぼ織り込んでいるので、ニュースや騎手コメントを
  そのまま予想に足しても効きにくい (このアプリ自身がデータで証明済)。
  ただし「賢いお金の動き(短時間のオッズ急落)」「取消」「馬体重の大きな増減」
  「装備変更(ブリンカー初装着など)」のような“事実の変化”は、人が見落としがちで
  効く可能性がある。だが過去ログが無いと検証できない。
  → そこで「今から日付つきで生ログを貯める箱」を用意する。10年データ収集と同じ
     “育つ”作戦。効くか効かないかの採点は後日 validate_signals.py で
     リークなし(未来をのぞき見しない)で行う。

正直方針:
  ここでは一切「判断」しない。事実をそのまま残すだけ。
  予想には混ぜない。検証で効くと分かったものだけ、後で採用する。

スナップショットのキーは短縮形 (ファイルを小さく保つため):
  レース: ts(時刻) / go(馬場) / we(天気)
  各馬:   n(馬番) / o(単勝オッズ) / p(人気) / ij(異常区分) / bw(馬体重) /
          wd(馬体重増減) / bl(ブリンカー)
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone, date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
RACES = CACHE / "races"
SIGNALS = CACHE / "signals"

# 「開催日が今日前後のレース」だけスナップショットを取る。
# 箱の目的は“発走前のオッズ変化を当日に貯める”ことなので、昔の確定レースは対象外。
# (古いレースを再 build_all したときに全件再保存して git を汚さないようにする狙い)
PAST_DAYS = 1     # 今日より何日前まで対象にするか (発走直後の確定も拾う)
FUTURE_DAYS = 2   # 今日より何日後まで対象にするか (前日の前売りオッズも拾う)
# 1 レースあたりのスナップショット上限 (1 開催日で十分収まる)。
MAX_SNAPSHOTS = 300


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _horse_snapshot(h: dict) -> dict:
    """1 頭分の硬い事実を短縮キーで取り出す。"""
    return {
        "n":  h.get("number"),
        "o":  h.get("win_odds"),
        "p":  h.get("popularity"),
        "ij": h.get("ijyou_code"),
        "bw": h.get("body_weight"),
        "wd": h.get("weight_diff"),
        "bl": h.get("blinker"),
    }


def build_snapshot(race: dict) -> dict | None:
    """races/<id>.json 1 件から、時刻つきスナップショットを作る。

    出走表が未配信の「空のレース枠」(馬番 0・全頭 null) はまだ事実が無いので保存しない。
    馬番 > 0 の実エントリが 1 頭でもある時だけスナップショットを作る。
    """
    horses = race.get("horses")
    if not isinstance(horses, list) or not horses:
        return None
    real = [h for h in horses
            if isinstance(h.get("number"), int) and h.get("number") > 0]
    if not real:
        return None
    return {
        "ts": _now_iso(),
        "go": race.get("going"),
        "we": race.get("weather"),
        "horses": [_horse_snapshot(h) for h in real],
    }


def _core(snap: dict) -> str:
    """変化判定用に、時刻を除いた中身を文字列化する。"""
    if not snap:
        return ""
    payload = {"go": snap.get("go"), "we": snap.get("we"), "horses": snap.get("horses")}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def append_snapshot(race_id: str, snap: dict) -> str:
    """signals/<raceId>.json に追記する。直前と中身が同じなら追記しない。

    戻り値: "appended" / "unchanged" / "skip"
    """
    if not race_id or not snap:
        return "skip"
    SIGNALS.mkdir(parents=True, exist_ok=True)
    out = SIGNALS / f"{race_id}.json"
    existing = _load(out)
    history = existing if isinstance(existing, list) else []
    # 直前スナップショットと中身が同じ (オッズも馬場も動いていない) なら追記しない。
    if history and _core(history[-1]) == _core(snap):
        return "unchanged"
    history.append(snap)
    if len(history) > MAX_SNAPSHOTS:
        history = history[-MAX_SNAPSHOTS:]
    out.write_text(json.dumps(history, ensure_ascii=False), encoding="utf-8")
    return "appended"


def _race_date(race_id: str) -> date | None:
    """race_id 先頭 8 桁 (YYYYMMDD) を日付にする。"""
    if not race_id or len(race_id) < 8 or not race_id[:8].isdigit():
        return None
    try:
        return date(int(race_id[:4]), int(race_id[4:6]), int(race_id[6:8]))
    except ValueError:
        return None


def _in_window(race_id: str, today: date) -> bool:
    """開催日が今日前後 (PAST_DAYS〜FUTURE_DAYS) の範囲なら True。"""
    d = _race_date(race_id)
    if d is None:
        return False
    return (today - timedelta(days=PAST_DAYS)) <= d <= (today + timedelta(days=FUTURE_DAYS))


def run(all_races: bool = False) -> dict:
    """開催日が今日前後の races をスキャンしてスナップショットを貯める。"""
    counts = {"appended": 0, "unchanged": 0, "skip": 0, "scanned": 0}
    if not RACES.exists():
        return counts
    today = datetime.now().date()
    for p in glob.glob(str(RACES / "*.json")):
        rid_from_name = Path(p).stem
        if not all_races and not _in_window(rid_from_name, today):
            continue
        counts["scanned"] += 1
        race = _load(Path(p))
        if not race:
            counts["skip"] += 1
            continue
        rid = race.get("race_id") or Path(p).stem
        snap = build_snapshot(race)
        if not snap:
            counts["skip"] += 1
            continue
        counts[append_snapshot(rid, snap)] += 1
    return counts


def _selftest() -> int:
    """合成データで append / 変化判定 / 上限を確認する (ファイルは書かない)。"""
    import tempfile

    global SIGNALS
    ok = True
    with tempfile.TemporaryDirectory() as td:
        SIGNALS = Path(td) / "signals"
        race = {"race_id": "TESTRACE0001", "going": "良", "weather": "晴",
                "horses": [{"number": 1, "win_odds": 3.2, "popularity": 1,
                            "ijyou_code": None, "body_weight": 480,
                            "weight_diff": 4, "blinker": None}]}
        s1 = build_snapshot(race)
        r1 = append_snapshot("TESTRACE0001", s1)
        ok &= (r1 == "appended")
        # 中身が同じ → unchanged
        s2 = build_snapshot(race)
        r2 = append_snapshot("TESTRACE0001", s2)
        ok &= (r2 == "unchanged")
        # オッズが動いた → appended
        race["horses"][0]["win_odds"] = 2.4
        s3 = build_snapshot(race)
        r3 = append_snapshot("TESTRACE0001", s3)
        ok &= (r3 == "appended")
        hist = _load(SIGNALS / "TESTRACE0001.json")
        ok &= (isinstance(hist, list) and len(hist) == 2)
        # 空出走表 → None
        ok &= (build_snapshot({"race_id": "X", "horses": []}) is None)
        # 馬番 0 だけの空シェル (出走表未配信) → None
        ok &= (build_snapshot({"race_id": "X", "horses": [
            {"number": 0, "win_odds": None}]}) is None)
    print("[selftest]", "OK" if ok else "FAILED")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="硬い事実シグナルを日付つきで貯める箱")
    ap.add_argument("--all", action="store_true",
                    help="直近更新だけでなく全 races をスナップショットする (バックフィル用)")
    ap.add_argument("--selftest", action="store_true", help="合成データで自己テスト")
    args = ap.parse_args()
    if args.selftest:
        return _selftest()
    counts = run(all_races=args.all)
    print(f"[archive_signals] scanned={counts['scanned']} "
          f"appended={counts['appended']} unchanged={counts['unchanged']} "
          f"skip={counts['skip']}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
