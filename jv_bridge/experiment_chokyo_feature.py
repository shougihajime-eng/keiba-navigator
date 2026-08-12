# -*- coding: utf-8 -*-
"""
experiment_chokyo_feature.py — 調教（追い切り）から「予想に足せる特徴」を作る（オフライン実験用）

★このファイルの役割
  data/jv_cache/chokyo_full.json（build_chokyo.py が作る調教の索引）と
  data/jv_cache/races/*.json（出走表）を突き合わせて、
  「1頭ぶんの調教の様子」を数字にする。**本番には一切つながない**。

★リークを作らないための決め事（守らないと嘘の good が出る）
  1. そのレースの **前日までの調教だけ** を見る（当日・翌日以降は使わない）。
  2. タイムの速い/遅いは「同じ条件（坂路/ウッド × 美浦/栗東 × ハロン数）の中での偏差」で見るが、
     その **ものさし（平均と散らばり）も、そのレースより前の調教だけ** から作る（expanding）。
     ＝ 未来の調教タイムでものさしを作らない。
  3. 前走からの間隔も **そのレースより前の出走記録だけ** から出す。
  4. 調教データが無い馬は「弱い」ではなく **中立**（全部 0 ＋ hasData=0）にする。
     ＝ 特徴量は全部 hasData を掛けてあるので、無い馬は 1つも点が動かない。

★JRA-VAN に無いので作らないもの（netkeiba のあれは独自取材）
  乗り役 / 併せ馬 / 脚色（一杯・馬なり）/ 外厩 / 芝コース・プールの調教

使い方（単体でも動く。中身の下見用）:
  python jv_bridge/experiment_chokyo_feature.py
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
RACES_DIR = CACHE / "races"
CHOKYO_FULL = CACHE / "chokyo_full.json"
BETS = CACHE / "value_ev_bets.json"

MIN_REF_SAMPLES = 200   # ものさし（分布）を出すのに要る最低本数。足りなければ「分からない」
LOOKBACK_DAYS = 60      # 何日前までの調教を見るか
Z_CLIP = 3.0            # 偏差の上限（外れ値でモデルが暴れないように）


def _d(s: str) -> Optional[date]:
    """'20260731' → date。読めなければ None（それらしい日付を作らない）。"""
    if not s or len(s) != 8 or not s.isdigit():
        return None
    try:
        return date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    except ValueError:
        return None


def _group_key(sess: Dict[str, Any]) -> Optional[str]:
    """同じ条件どうしを比べるための組（坂路/ウッド × 美浦/栗東 × ハロン数）。"""
    k = sess.get("kindCode")
    t = sess.get("tresenCode")
    f = sess.get("furlongs")
    if k is None or t is None or f is None:
        return None
    return f"{k}|{t}|{f}"


class _RefDist:
    """expanding（過去だけ）の平均・散らばりを持つ、条件べつのものさし。"""

    def __init__(self) -> None:
        self.n: Dict[str, int] = defaultdict(int)
        self.s: Dict[str, float] = defaultdict(float)
        self.ss: Dict[str, float] = defaultdict(float)

    def add(self, g: str, v: float) -> None:
        self.n[g] += 1
        self.s[g] += v
        self.ss[g] += v * v

    def z_faster(self, g: str, v: float) -> Optional[float]:
        """速いほど大きい値を返す（タイムは小さいほど速いので符号を反転）。
        サンプルが足りない条件は None（＝分からない。0で埋めない）。"""
        n = self.n.get(g, 0)
        if n < MIN_REF_SAMPLES:
            return None
        mean = self.s[g] / n
        var = self.ss[g] / n - mean * mean
        if var <= 1e-9:
            return None
        z = (mean - v) / math.sqrt(var)     # 速い(小さい)ほどプラス
        return max(-Z_CLIP, min(Z_CLIP, z))


def _load_race_horses() -> Tuple[Dict[Tuple[str, int], str], Dict[str, List[date]]]:
    """出走表を全部読んで
       ①(レースID, 馬番) → 血統登録番号
       ②血統登録番号 → その馬が走った日の一覧（前走からの間隔を出すため）
       を作る。"""
    num2ket: Dict[Tuple[str, int], str] = {}
    horse_dates: Dict[str, List[date]] = defaultdict(list)
    for p in RACES_DIR.glob("*.json"):
        rid = p.stem
        rd = _d(rid[:8])
        if rd is None:
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        for h in data.get("horses") or []:
            k = (h.get("ketto_num") or "").strip()
            n = h.get("number")
            if not k or not isinstance(n, int):
                continue
            num2ket[(rid, n)] = k
            horse_dates[k].append(rd)
    for k in horse_dates:
        horse_dates[k].sort()
    return num2ket, horse_dates


def _prev_race_date(dates: List[date], today: date) -> Optional[date]:
    """その日より前で いちばん近い出走日（無ければ None）。"""
    prev = None
    for d0 in dates:
        if d0 < today:
            prev = d0
        else:
            break
    return prev


def build_chokyo_features(rows: List[Dict[str, Any]]) -> Tuple[Dict[Tuple[str, int], Dict[str, Any]], Dict[str, Any]]:
    """rows = value_ev_bets.json の中身（rid と number があればよい）。
    返り値: {(rid, number): 特徴の辞書}, 覆い率などの情報

    ⚠ 特徴は「そのレースの前日まで」の調教だけで作る（リークなし）。"""
    if not CHOKYO_FULL.exists():
        raise SystemExit(f"[error] {CHOKYO_FULL} が無い。先に build_chokyo.py --full を走らせる")

    chokyo = json.loads(CHOKYO_FULL.read_text(encoding="utf-8")).get("horses") or {}
    num2ket, horse_dates = _load_race_horses()

    # 馬ごとの調教を「日付の新しい順」に並べておく（日付が読めない物は捨てる）
    sess_by_horse: Dict[str, List[Tuple[date, Dict[str, Any]]]] = {}
    all_sess: List[Tuple[date, str, float]] = []      # (日付, 条件, タイム) ものさし作り用
    for ket, sessions in chokyo.items():
        keep: List[Tuple[date, Dict[str, Any]]] = []
        for s in sessions:
            sd = _d(s.get("date") or "")
            tot = s.get("total")
            if sd is None or not isinstance(tot, (int, float)):
                continue
            keep.append((sd, s))
            g = _group_key(s)
            if g:
                all_sess.append((sd, g, float(tot)))
        keep.sort(key=lambda t: t[0], reverse=True)
        sess_by_horse[ket] = keep
    all_sess.sort(key=lambda t: t[0])

    # レース日ごとにまとめて処理する（ものさしを日付順に育てるため）
    by_date: Dict[date, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        rd = _d(str(r.get("rid", ""))[:8])
        if rd is None:
            continue
        by_date[rd].append(r)

    ref = _RefDist()
    si = 0
    feat: Dict[Tuple[str, int], Dict[str, Any]] = {}
    stat = {"rows": 0, "linked": 0, "hasData": 0, "zKnown": 0, "hasLayoff": 0}

    for rd in sorted(by_date.keys()):
        # このレース日より前の調教だけ ものさしに足す（未来を見ない）
        while si < len(all_sess) and all_sess[si][0] < rd:
            _, g, v = all_sess[si]
            ref.add(g, v)
            si += 1

        lo = rd - timedelta(days=LOOKBACK_DAYS)
        for r in by_date[rd]:
            rid = str(r["rid"])
            num = int(r["number"])
            stat["rows"] += 1
            ket = num2ket.get((rid, num))
            f: Dict[str, Any] = {
                "hasData": 0, "n14": 0, "n30": 0, "n60": 0,
                "daysBefore": None, "lastHanro": None, "lastKurita": None,
                "zLast": None, "zBest30": None,
                "layoffDays": None,
            }
            if not ket:
                feat[(rid, num)] = f
                continue
            stat["linked"] += 1

            # ── 前走からの間隔（過去の出走だけ見る） ──
            pv = _prev_race_date(horse_dates.get(ket) or [], rd)
            if pv is not None:
                f["layoffDays"] = (rd - pv).days
                stat["hasLayoff"] += 1

            # ── 調教（そのレースの前日まで・60日以内） ──
            recent = [(sd, s) for sd, s in sess_by_horse.get(ket, []) if lo <= sd < rd]
            if not recent:
                feat[(rid, num)] = f
                continue
            stat["hasData"] += 1
            f["hasData"] = 1
            f["n60"] = len(recent)
            f["n30"] = sum(1 for sd, _ in recent if (rd - sd).days <= 30)
            f["n14"] = sum(1 for sd, _ in recent if (rd - sd).days <= 14)

            lsd, lss = recent[0]           # いちばん新しい追い切り
            f["daysBefore"] = (rd - lsd).days
            f["lastHanro"] = 1 if lss.get("kindCode") == "H" else 0
            f["lastKurita"] = 1 if str(lss.get("tresenCode")) == "1" else 0

            g = _group_key(lss)
            if g:
                z = ref.z_faster(g, float(lss["total"]))
                if z is not None:
                    f["zLast"] = z

            zs = []
            for sd, s in recent:
                if (rd - sd).days > 30:
                    continue
                gg = _group_key(s)
                if not gg:
                    continue
                zz = ref.z_faster(gg, float(s["total"]))
                if zz is not None:
                    zs.append(zz)
            if zs:
                f["zBest30"] = max(zs)
            if f["zLast"] is not None or f["zBest30"] is not None:
                stat["zKnown"] += 1

            feat[(rid, num)] = f

    return feat, stat


# ── モデルに入れる形（数字の並び）に直す ───────────────────────────
# 🚨 全部 hasData を掛ける ＝ 調教データが無い馬は 1つも点が動かない（中立）

def vec_counts(f: Dict[str, Any]) -> List[float]:
    """① 本数（仕上がり）"""
    h = float(f["hasData"])
    return [h,
            f["n14"] / 5.0 * h,
            f["n30"] / 8.0 * h,
            f["n60"] / 12.0 * h]


def vec_days(f: Dict[str, Any]) -> List[float]:
    """② 最終追いからの間隔"""
    h = float(f["hasData"])
    db = f["daysBefore"]
    v = 0.0 if db is None else max(-2.0, min(2.0, (db - 7.0) / 7.0))
    near = 1.0 if (db is not None and db <= 4) else 0.0
    return [h, v * h, near * h]


def vec_kind(f: Dict[str, Any]) -> List[float]:
    """③ 坂路かウッドか / 栗東か美浦か"""
    h = float(f["hasData"])
    hanro = 0.0 if f["lastHanro"] is None else float(f["lastHanro"])
    kur = 0.0 if f["lastKurita"] is None else float(f["lastKurita"])
    return [h, hanro * h, kur * h]


def vec_time(f: Dict[str, Any]) -> List[float]:
    """④ タイムの偏差（同じ条件の中で速いか）"""
    zl = f["zLast"]
    zb = f["zBest30"]
    known = 1.0 if (zl is not None or zb is not None) else 0.0
    return [known,
            (zl or 0.0),
            (zb or 0.0)]


def vec_layoff(f: Dict[str, Any]) -> List[float]:
    """⑤ 休み明け × 調教本数（休み明けでもよく乗れているか）"""
    h = float(f["hasData"])
    lo = f["layoffDays"]
    known = 1.0 if lo is not None else 0.0
    isrest = 1.0 if (lo is not None and lo >= 90) else 0.0
    n30 = f["n30"] / 8.0
    return [known, isrest, isrest * n30 * h, (0.0 if lo is None else min(lo, 200) / 100.0)]


def main() -> int:
    rows = json.loads(BETS.read_text(encoding="utf-8"))
    feat, stat = build_chokyo_features(rows)
    n = max(1, stat["rows"])
    print("=== 調教データの覆い率（下見） ===")
    print(f"  対象 {stat['rows']:,} 頭ぶん")
    print(f"  出走表と血統番号でつながった: {stat['linked']:,} ({stat['linked']/n*100:.1f}%)")
    print(f"  レース前60日に追い切りがある: {stat['hasData']:,} ({stat['hasData']/n*100:.1f}%)")
    print(f"  タイムの速い遅いを出せた   : {stat['zKnown']:,} ({stat['zKnown']/n*100:.1f}%)")
    print(f"  前走が分かる（間隔が出せる）: {stat['hasLayoff']:,} ({stat['hasLayoff']/n*100:.1f}%)")

    # 期間ごとの覆い率（古い期間ほど薄いはず＝正直に出す）
    from collections import Counter
    per_tot: Counter = Counter()
    per_has: Counter = Counter()
    for r in rows:
        f = feat.get((str(r["rid"]), int(r["number"])))
        if f is None:
            continue
        per_tot[r["period"]] += 1
        per_has[r["period"]] += f["hasData"]
    print("\n  期間べつの『追い切りが見つかった率』")
    for p in sorted(per_tot):
        print(f"    期間{p}: {per_has[p]:,}/{per_tot[p]:,} = {per_has[p]/max(1,per_tot[p])*100:.1f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
