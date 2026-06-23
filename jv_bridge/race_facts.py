# -*- coding: utf-8 -*-
"""
race_facts.py — 「人が見落としがちな硬い事実」を 1 箇所で定義する共有部品

表示(build_race_card.py)と採点(validate_signals.py)が必ず同じ定義の事実を使うように、
事実の抽出ロジックをここに集約する。予想には混ぜない・参考メモ/採点用の素材。

事実の種類:
  money_in    賢いお金が入った  (直前にオッズが15%以上下がった)   ※要オッズ履歴
  money_out   お金が抜けた      (直前にオッズが30%以上上がった)   ※要オッズ履歴
  scratch     取消・除外・中止  (ijyou_code 2/3/4)
  weight_up   馬体重が大きく増えた (前走比 +16〜+40kg)
  weight_down 馬体重が大きく減った (前走比 -16〜-40kg)
  blinker     ブリンカー着用
  rento       連闘            (前走から中6日以内)
  layoff      休み明け        (前走から90〜179日)
  long_layoff 長期休み明け    (前走から180日以上)
  dist_change 距離が前走と大きく変わった (±400m以上)
"""
from __future__ import annotations

import glob
import json
from datetime import date, datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
RACES = CACHE / "races"
SIGNALS = CACHE / "signals"

# 休み明け/距離変更は「その馬の本当の前走」が要る。今のデータは過去約8ヶ月ぶんしか無く、
# 間のレースが欠けていると“前走”を取り違える (実は3週間前なのに『112日ぶり』と誤判定) ため、
# 誤った事実を出さないよう当面オフにする。JRA-VANの馬毎レース記録(UM)を繋いだら True にする。
# (連闘=見つけた前走が7日以内、は欠損があっても誤検知しないので常に出す)
TRUST_FULL_HISTORY = False

# 表示の並び順 (重要度)
FACT_ORDER = {
    "money_in": 0, "scratch": 1, "rento": 2, "layoff": 3, "long_layoff": 3,
    "dist_change": 4, "weight_up": 5, "weight_down": 5, "money_out": 6, "blinker": 7,
}


def _load(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _days_between(a: str, b: str):
    """YYYYMMDD 文字列 a→b の日数。"""
    try:
        da = date(int(a[:4]), int(a[4:6]), int(a[6:8]))
        db = date(int(b[:4]), int(b[4:6]), int(b[6:8]))
        return (db - da).days
    except (ValueError, TypeError):
        return None


# 発走時刻のこの分数だけ前以降のスナップショットは「締切後の確定オッズ」とみなして外す。
# (締切ぎりぎりのスナップショットも確定オッズに置き換わっていることがあるので少し前で切る)
_PRECLOSE_MARGIN_MIN = 2
_JST = timezone(timedelta(hours=9))


def _hassou_dt(rid: str) -> datetime | None:
    """race_id 先頭8桁(YYYYMMDD) + races の hassou_time(HHMM) から発走時刻(JST)を作る。"""
    d8 = str(rid)[:8]
    if not (len(d8) == 8 and d8.isdigit()):
        return None
    race = _load(RACES / f"{rid}.json")
    ht = str((race or {}).get("hassou_time") or "").strip()
    if not (len(ht) == 4 and ht.isdigit()):
        return None
    try:
        return datetime(int(d8[:4]), int(d8[4:6]), int(d8[6:8]),
                        int(ht[:2]), int(ht[2:]), tzinfo=_JST)
    except ValueError:
        return None


def _snap_ts(snap: dict) -> datetime | None:
    ts = snap.get("ts")
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return None


def signal_odds_moves(rid: str) -> dict:
    """signals/<rid>.json から、発走前の最初の本物オッズと最後の本物オッズの変化率%を馬番ごとに。
    (マイナス=下がった=お金が入った)

    結果リーク対策: 締切後に取り込まれた「確定オッズ(SE win_odds)」を含むスナップショットを
    使うと、直前下落(money_in)の判定が結果リークで甘く出る。よって
      - 発走時刻(hassou_time)が分かるレースは、発走の約2分前より後のスナップショットを除外する。
      - 発走時刻が不明なレースは、確定オッズ(SE win_odds)と完全一致する最終スナップショットを
        フォールバックで除外する。
    発走前スナップショットが2個未満で変化率が作れないレースは「判定不能」(空dict)にする。"""
    hist = _load(SIGNALS / f"{rid}.json")
    if not isinstance(hist, list) or len(hist) < 2:
        return {}

    hassou = _hassou_dt(rid)
    snaps = list(hist)

    if hassou is not None:
        # 発走の約2分前より後のスナップショット(=締切後の確定オッズ)を除外する。
        cutoff = hassou - timedelta(minutes=_PRECLOSE_MARGIN_MIN)
        kept = []
        for snap in snaps:
            ts = _snap_ts(snap)
            # 時刻が読めないスナップショットは安全側に倒して残す (古い形式の保険)。
            if ts is None or ts < cutoff:
                kept.append(snap)
        snaps = kept
    else:
        # 発走時刻が不明: 確定オッズ(SE win_odds)と全頭一致する最終スナップショットを外す。
        race = _load(RACES / f"{rid}.json")
        se = {}
        for h in ((race or {}).get("horses") or []):
            n, o = h.get("number"), h.get("win_odds")
            if isinstance(n, int):
                try:
                    se[n] = round(float(o), 1) if o not in (None, 0) else None
                except (TypeError, ValueError):
                    se[n] = None
        while len(snaps) >= 2:
            tail = snaps[-1]
            tail_odds = {}
            for h in (tail.get("horses") or []):
                n, o = h.get("n"), h.get("o")
                if isinstance(n, int):
                    try:
                        tail_odds[n] = round(float(o), 1) if o not in (None, 0) else None
                    except (TypeError, ValueError):
                        tail_odds[n] = None
            common = [n for n in tail_odds if n in se
                      and tail_odds[n] is not None and se[n] is not None]
            if common and all(tail_odds[n] == se[n] for n in common):
                snaps = snaps[:-1]  # 確定オッズの最終スナップショットを外す
            else:
                break

    if len(snaps) < 2:
        return {}  # 発走前のスナップショットが足りない=判定不能

    first, last = {}, {}
    for snap in snaps:
        for h in (snap.get("horses") or []):
            n, o = h.get("n"), h.get("o")
            if not isinstance(n, int) or o in (None, 0):
                continue
            try:
                o = float(o)
            except (TypeError, ValueError):
                continue
            if o <= 0:
                continue
            first.setdefault(n, o)
            last[n] = o
    return {n: round((last[n] - o0) / o0 * 100, 1)
            for n, o0 in first.items() if last.get(n) and o0}


def build_prev_index() -> dict:
    """全 races を走査し、馬(血統番号)ごとに「走った過去レース」の一覧を作る。
    戻り値: {ketto_num: [ {"d": YYYYMMDD, "dist": int|None}, ... ] (日付昇順) }
    着順が付いた=実際に走ったレースのみ (取消等は除外)。"""
    idx: dict = {}
    for p in glob.glob(str(RACES / "*.json")):
        race = _load(Path(p))
        if not race:
            continue
        rid = str(race.get("race_id") or Path(p).stem)
        d8 = rid[:8]
        if not (len(d8) == 8 and d8.isdigit()):
            continue
        dist = _to_int(race.get("distance"))
        seen = set()
        for h in (race.get("horses") or []):
            k = h.get("ketto_num")
            if not k or k in seen:
                continue
            if _to_int(h.get("kakutei_jyuni")) is None:
                continue  # 走っていない (着順なし)
            seen.add(k)
            idx.setdefault(k, []).append({"d": d8, "dist": dist})
    for k in idx:
        idx[k].sort(key=lambda e: e["d"])
    return idx


def _prev_before(prev_index: dict, ketto, date8: str):
    """その馬の、当該レースより前の直近レースを返す。"""
    lst = prev_index.get(ketto)
    if not lst:
        return None
    prev = None
    for e in lst:
        if e["d"] < date8:
            prev = e
        else:
            break
    return prev


def facts_for_race(rid: str, horses_by_num: dict, cur_distance,
                   moves: dict | None = None,
                   prev_index: dict | None = None,
                   limit: int = 6) -> list:
    """1 レースぶんの事実メモを集める。horses_by_num: {馬番: 出走馬dict}。"""
    moves = moves or {}
    prev_index = prev_index or {}
    cur_distance = _to_int(cur_distance)
    date8 = str(rid)[:8]
    facts = []

    def add(n, name, kind, detail):
        facts.append({"number": n, "name": name, "kind": kind, "detail": detail})

    for n, h in horses_by_num.items():
        name = h.get("name")
        # 賢いお金の動き (オッズ履歴がある時だけ)
        mv = moves.get(n)
        if mv is not None and mv <= -15:
            add(n, name, "money_in", f"直前にオッズが{abs(mv):.0f}%下がった")
        elif mv is not None and mv >= 30:
            add(n, name, "money_out", f"直前にオッズが{mv:.0f}%上がった")
        # 取消・除外・中止
        ij = str(h.get("ijyou_code") or "").strip()
        if ij in ("2", "3", "4"):
            add(n, name, "scratch", {"2": "取消", "3": "除外", "4": "中止"}[ij])
        # 馬体重の大きな増減 (現実は最大40kg程度・それ超は壊れデータ)
        wd = h.get("weight_diff")
        if isinstance(wd, int) and 16 <= abs(wd) <= 40:
            add(n, name, "weight_up" if wd > 0 else "weight_down",
                f"馬体重{'+' if wd > 0 else ''}{wd}kg")
        # ブリンカー
        bl = h.get("blinker")
        if bl not in (None, "", "0", 0):
            add(n, name, "blinker", "ブリンカー着用")
        # 前走比の事実 (連闘/休み明け/距離変更)
        prev = _prev_before(prev_index, h.get("ketto_num"), date8) \
            if (h.get("ketto_num") and len(date8) == 8 and date8.isdigit()) else None
        if prev:
            days = _days_between(prev["d"], date8)
            # 連闘は欠損データでも誤検知しない (見つけた前走が7日以内=本物) ので常に出す。
            if days is not None and 0 <= days <= 7:
                add(n, name, "rento", f"連闘（中{max(days - 1, 0)}日）")
            # 休み明け/距離変更は“本当の前走”が要る。完全な馬毎レース記録を繋ぐまでは誤りになるので出さない。
            if TRUST_FULL_HISTORY and days is not None and days >= 0:
                if days >= 180:
                    add(n, name, "long_layoff", f"長期休み明け（{days}日ぶり）")
                elif days >= 90:
                    add(n, name, "layoff", f"休み明け（{days}日ぶり）")
            pd = prev.get("dist")
            if TRUST_FULL_HISTORY and cur_distance and isinstance(pd, int):
                dd = cur_distance - pd
                if abs(dd) >= 400:
                    add(n, name, "dist_change", f"距離{'+' if dd > 0 else ''}{dd}m（前走比）")

    facts.sort(key=lambda f: FACT_ORDER.get(f["kind"], 9))
    return facts[:limit]
