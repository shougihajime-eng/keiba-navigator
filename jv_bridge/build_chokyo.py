# -*- coding: utf-8 -*-
r"""
build_chokyo.py — JV-Link の生データ (HC=坂路 / WC=ウッドチップ) から
                  「調教（追い切り）」の索引と分布表を作る。

■ なにをするファイルか（やさしい説明）
  競馬の予想で「今の調子」を見るには 追い切り（レース前の稽古）のタイムが要る。
  JRA-VAN の契約には元から入っているのに、このアプリは今まで一度も使っていなかった。
  このファイルは JV-Link がダウンロードした生データを読んで、
  「どの馬が・いつ・どこで・何秒で走ったか」を1つの索引にまとめる。

■ 出す物
  data/jv_cache/chokyo/index.json   … 直近のレースに出る馬ぶん（本番にも配る・軽い）
  data/jv_cache/chokyo_full.json    … 全馬ぶん（--full の時だけ・パソコンの中だけ）

  どちらにも「分布表(stats)」が入る。速い/遅いの判定はこの分布から出す。
  ⚠ 絶対値のしきい値（例:「53秒より速ければ good」）は 1つも書いていない。
     netkeiba と同じで「同じ条件の中で上位何%か」だけで決める。

■ 使い方
  py -3.12 jv_bridge/build_chokyo.py                 … 索引を作る
  py -3.12 jv_bridge/build_chokyo.py --full          … 全馬ぶんも書く
  py -3.12 jv_bridge/build_chokyo.py --raw-dir <dir> … 生データの場所を指定
  py -3.12 jv_bridge/build_chokyo.py --report        … 中身の要約だけ表示（書き出さない）

■ 生データの置き場所（重要）
  data/jv_cache/chokyo_raw/*.bin に置く。
  ⚠ aggregate_*/ の中に置きっぱなしにしない。build_all.py が毎朝そこを全部読むので、
     関係ない調教データまで読ませて遅くしてしまう（2026-06 に一度その事故があり、
     当時は生データを消して回避していた）。
  取り方:
     py -3.12-32 jv_bridge/jv_fetch.py aggregate --dataspec SLOP --fromtime 20250801000000 --option 1
     py -3.12-32 jv_bridge/jv_fetch.py aggregate --dataspec WOOD --fromtime 20250801000000 --option 1
  ⚠ JV-Link は同時に2つ動かせない。走らせる前に jv_fetch / collect_exotic が
     動いていないこと、fetch_diff.lock / near_post.lock が無いことを必ず確かめる。

■ 数字を作らないための約束
  ・測定不良 (0000 / 000) と 上限張り付き (9999 / 999) は None にする。埋めない。
  ・データ区分 "0" (提供ミスによる削除) のレコードは捨てる。
  ・つじつまの合わないタイム（累計が逆転している等）は捨てる。それらしい値に直さない。
  ・同じ条件のサンプルが少ない (既定 200本未満) 分布では順位を出さない。「分からない」と返す。

■ JRA-VAN の調教データに「入っていない」もの（作れないので出さない）
  ・乗り役（誰が乗ったか）      … SLOP/WOOD レコードに項目自体が無い
  ・併せ馬・馬なり/一杯 などの脚色 … 同上
  ・芝コース / ダートコース / プール / 角馬場 の調教 … JRA-VAN は坂路とウッドチップだけ
  netkeiba が出しているこれらは netkeiba 独自の取材データで、JRA-VAN には無い。

■ 仕様の出どころ
  JV-Data 仕様書 4.9.0.1 「２２．坂路調教」(60バイト) / 「３２．ウッドチップ調教」(105バイト)。
  位置は仕様書が1始まり、下の表は0始まり（Python 用に -1 してある）。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "data" / "jv_cache"
RACES_DIR = CACHE_DIR / "races"
OUT_DIR = CACHE_DIR / "chokyo"
OUT_INDEX = OUT_DIR / "index.json"
OUT_FULL = CACHE_DIR / "chokyo_full.json"
RAW_DIRS = [CACHE_DIR / "chokyo_raw"]

INDEX_VERSION = 1

# ── レコードの位置表（JV-Data 仕様書 4.9.0.1 から転記・0始まり） ──────────
#
# ⚠ jvdata_struct.py の WC_FIELDS は haron_4 までしか転記されていない
#    （3ハロン・2ハロン・1ハロンが抜けている）。ここでは仕様書どおり全部持つ。
# ⚠ jvdata_struct.py の HC のコメントは「1美浦/2栗東」と書いてあるが これは誤り。
#    仕様書は「0:美浦 1:栗東」。ここは仕様書に従う。

TRESEN = {"0": "美浦", "1": "栗東"}
WOOD_COURSE = {"0": "A", "1": "B", "2": "C", "3": "D", "4": "E"}
WOOD_AROUND = {"0": "右", "1": "左"}

# 坂路 HC = 60バイト
HC_HEAD = {
    "data_kbn":    (2, 1),
    "tresen_kbn":  (11, 1),
    "chokyo_date": (12, 8),
    "chokyo_time": (20, 4),
    "ketto_num":   (24, 10),
}
# ハロン数 -> (累計タイムの位置, その区間ラップの位置)。ラップが無いものは None。
HC_FURLONGS = {
    4: ((34, 4), (38, 3)),   # 800M〜0M   / ラップ 800-600
    3: ((41, 4), (45, 3)),   # 600M〜0M   / ラップ 600-400
    2: ((48, 4), (52, 3)),   # 400M〜0M   / ラップ 400-200
    1: (None,    (55, 3)),   # 1ハロンは累計が無くラップのみ (200-0)
}

# ウッドチップ WC = 105バイト
WC_HEAD = {
    "data_kbn":    (2, 1),
    "tresen_kbn":  (11, 1),
    "chokyo_date": (12, 8),
    "chokyo_time": (20, 4),
    "ketto_num":   (24, 10),
    "course":      (34, 1),
    "around":      (35, 1),
}
WC_FURLONGS = {
    10: ((37, 4), (41, 3)),
    9:  ((44, 4), (48, 3)),
    8:  ((51, 4), (55, 3)),
    7:  ((58, 4), (62, 3)),
    6:  ((65, 4), (69, 3)),
    5:  ((72, 4), (76, 3)),
    4:  ((79, 4), (83, 3)),
    3:  ((86, 4), (90, 3)),
    2:  ((93, 4), (97, 3)),
    1:  (None,    (100, 3)),
}

RECORD_LEN = {"HC": 60, "WC": 105}

# ── 壊れたデータをはじく条件 ────────────────────────────────
# ⚠ これは「速い/遅い」を決めるしきい値ではない。**読み取り事故で壊れた値**だけを
#    捨てるための枠。ここを狭くすると本物のデータが消える。
#
# 🚨 2026-08-12 の失敗と学び:
#    最初 上限を 1ハロン30秒にしたら 5,150本 も落ちた。中身を1本ずつ見たら
#    ぜんぶ「ダク・軽めのキャンター」の本物のデータだった（例: 坂路4ハロン126.4秒。
#    ラップ 34.3+31.5+30.8+29.8 が累計とぴったり合う＝壊れていない）。
#    ＝ 勝手に決めた「ありえない」の線が、実在する遅い調教を消していた。
#    → 上限を思い切り広げ、代わりに **足し算が合うか** で壊れを見分けることにした。
SANE_SEC_PER_FURLONG = (9.0, 90.0)   # 1ハロン(200m)あたり。競走馬が歩いてもこの範囲に入る
SANE_LAP = (8.0, 90.0)               # 各ラップ(200m)
LAP_SUM_TOLERANCE = 0.35             # 累計 と ラップの足し算 のズレの許容（0.1秒刻みの丸め分）

# 文字化けデータの目印。2026-05-25 に直した文字コードのバグの跡。
# JV-Link から受け取った文字列を latin-1 で戻すと 全角文字が全部 '?' に潰れ、
# 生データに '?@?@' が並ぶ。これが出たらそのファイルは使わない。
CORRUPT_MARK = b"\x3f\x40\x3f\x40"


# ── 小さな道具 ────────────────────────────────────────────

def _ascii(buf: bytes, pos: Tuple[int, int]) -> str:
    off, ln = pos
    if off < 0 or ln <= 0 or off + ln > len(buf):
        return ""
    return buf[off:off + ln].decode("ascii", errors="replace").strip()


def _time_value(raw: str, decimals: int = 1) -> Optional[float]:
    """JV-Data の固定小数を秒にする。

    '0532' -> 53.2 / '124' -> 12.4
    測定不良 ('0000' / '000') と 上限張り付き ('9999' / '999') は None。
    ⚠ ここで 0 を返してはいけない。0秒で走った事になってしまう。
    """
    if raw is None:
        return None
    t = raw.strip()
    if not t or not t.isdigit():
        return None
    n = int(t)
    if n == 0:
        return None                      # 測定不良
    if t == "9" * len(t):
        return None                      # 999.9秒以上 = 使えない
    return n / (10 ** decimals)


def _valid_date(s: str) -> bool:
    if not s or len(s) != 8 or not s.isdigit():
        return False
    try:
        datetime.strptime(s, "%Y%m%d")
    except ValueError:
        return False
    return True


STEP = 0.1   # JV-Data のタイムは 0.1秒 刻み。だから 0.1秒ごとに数え上げられる。


def build_cdf(vals: List[float]) -> Optional[Dict[str, Any]]:
    """タイムを 0.1秒 ごとに数え上げた表（累積度数）を作る。

    🚨 なぜ「パーセンタイル表(0%,1%,…,100%)」をやめたか（2026-08-12 の失敗）:
      最初は 101個の代表値を持って間を線形で割っていたが、
      タイムが 0.1秒刻みで **同じ値が何千本もある** ため、混んでいる所で
      最大 4.2ポイント もズレた（生データを数え直して発覚）。
      「上位3.0%」と言いながら本当は 上位7.2% ということが起きる＝嘘になる。
      → 0.1秒ごとの本数をそのまま持てば、順位は **数え上げそのもの＝誤差ゼロ**。
    """
    if not vals:
        return None
    lo = min(vals)
    hi = max(vals)
    nbin = int(round((hi - lo) / STEP)) + 1
    counts = [0] * nbin
    for v in vals:
        i = int(round((v - lo) / STEP))
        if i < 0:
            i = 0
        elif i >= nbin:
            i = nbin - 1
        counts[i] += 1
    # 累積にする（cum[i] = lo+i*STEP 以下の本数）
    run = 0
    cum = []
    for c in counts:
        run += c
        cum.append(run)
    return {"n": len(vals), "min": round(lo, 1), "step": STEP, "cum": cum}


def cdf_percent(m: Dict[str, Any], value: float) -> Optional[float]:
    """その値が上から何%か。0 に近いほど速い。数え上げなので誤差ゼロ。

    同じタイムが並ぶ時は その真ん中の順位で数える（統計のふつうのやり方）。
    """
    if not m or value is None:
        return None
    cum = m["cum"]
    n = m["n"]
    if n <= 0 or not cum:
        return None
    i = int(round((value - m["min"]) / m["step"]))
    if i < 0:
        return 0.0
    if i >= len(cum):
        return 100.0
    below = cum[i - 1] if i > 0 else 0     # このタイムより速い本数
    at_or_below = cum[i]                    # このタイム以下の本数
    eq = at_or_below - below                # 同じタイムの本数
    rank = below + eq / 2.0
    return round(100.0 * rank / n, 2)


def cdf_value_at(m: Dict[str, Any], percent: float) -> Optional[float]:
    """上位 percent% にあたるタイムを返す（表示用）。"""
    if not m:
        return None
    target = m["n"] * percent / 100.0
    for i, c in enumerate(m["cum"]):
        if c >= target:
            return round(m["min"] + i * m["step"], 1)
    return round(m["min"] + (len(m["cum"]) - 1) * m["step"], 1)


# ── 生データを読む ────────────────────────────────────────

def collect_raw_files(raw_dir: Optional[Path]) -> List[Path]:
    """調教の生データ (.bin) を集める。

    既定では chokyo_raw/ を見る。見つからなければ、jv_fetch がそのまま置いた
    aggregate_*_SLOP / aggregate_*_WOOD も拾う（引っ越し忘れの救済）。
    """
    if raw_dir is not None:
        return sorted(p for p in raw_dir.glob("*.bin"))
    out: List[Path] = []
    for d in RAW_DIRS:
        if d.is_dir():
            out.extend(sorted(d.glob("*.bin")))
    if out:
        return out
    for sub in sorted(CACHE_DIR.glob("aggregate_*")):
        if sub.is_dir() and (sub.name.endswith("_SLOP") or sub.name.endswith("_WOOD")):
            out.extend(sorted(sub.glob("raw_*.bin")))
    return out


def parse_hc(buf: bytes) -> Optional[Dict[str, Any]]:
    return _parse_common(buf, "HC", HC_HEAD, HC_FURLONGS)


def parse_wc(buf: bytes) -> Optional[Dict[str, Any]]:
    return _parse_common(buf, "WC", WC_HEAD, WC_FURLONGS)


def _parse_common(buf: bytes, rid: str, head: Dict[str, Tuple[int, int]],
                  furlongs: Dict[int, Any]) -> Optional[Dict[str, Any]]:
    """HC / WC の 1レコードを dict にする。おかしければ None。"""
    if not buf or len(buf) < RECORD_LEN[rid] - 2:   # CRLF は split 済みで無い
        return None

    if _ascii(buf, head["data_kbn"]) == "0":
        return None                                  # 提供ミスで削除されたレコード

    date = _ascii(buf, head["chokyo_date"])
    ketto = _ascii(buf, head["ketto_num"])
    if not _valid_date(date):
        return None
    if not ketto or len(ketto) != 10 or not ketto.isdigit():
        return None

    tresen_raw = _ascii(buf, head["tresen_kbn"])
    if tresen_raw not in TRESEN:
        return None

    hhmm = _ascii(buf, head["chokyo_time"])
    if not (len(hhmm) == 4 and hhmm.isdigit()):
        hhmm = None

    # 各ハロンの累計タイムとラップ
    cum: Dict[int, float] = {}
    lap: Dict[int, float] = {}
    for f, (cpos, lpos) in furlongs.items():
        if cpos is not None:
            v = _time_value(_ascii(buf, cpos), 1)
            if v is not None:
                cum[f] = v
        if lpos is not None:
            v = _time_value(_ascii(buf, lpos), 1)
            if v is not None:
                lap[f] = v

    if not cum:
        return None                                  # タイムが1つも読めない = 使えない

    max_f = max(cum.keys())
    total = cum[max_f]

    # ── つじつまチェック（直さない・捨てるだけ） ──
    # ① 物理的にありえない値か（ここは本当に広い枠。歩いていても通る）
    pace = total / max_f
    if not (SANE_SEC_PER_FURLONG[0] <= pace <= SANE_SEC_PER_FURLONG[1]):
        return None
    # ② 累計は 遠い地点ほど大きい（4ハロン合計 > 3ハロン合計 > 2ハロン合計）
    fs = sorted(cum.keys(), reverse=True)
    for a, b in zip(fs, fs[1:]):
        if cum[a] <= cum[b]:
            return None
    for f, v in list(lap.items()):
        if not (SANE_LAP[0] <= v <= SANE_LAP[1]):
            lap.pop(f)
    # ③ 足し算が合うか（これが壊れを見分ける本命）
    #    累計タイム(f) は ラップ(1..f) の合計と一致するはず。
    #    ラップが全部そろっている所だけ確かめる。合わなければ読み取り事故。
    for f in cum:
        if all(k in lap for k in range(1, f + 1)):
            if abs(cum[f] - sum(lap[k] for k in range(1, f + 1))) > LAP_SUM_TOLERANCE:
                return None

    rec: Dict[str, Any] = {
        "kind": "坂路" if rid == "HC" else "ウッド",
        "kindCode": "H" if rid == "HC" else "W",
        "tresen": TRESEN[tresen_raw],
        "tresenCode": tresen_raw,
        "date": date,
        "time": hhmm,
        "ketto": ketto,
        "furlongs": max_f,
        "meters": max_f * 200,
        "total": round(total, 1),
        "cum": {str(k): round(v, 1) for k, v in sorted(cum.items(), reverse=True)},
        "lap": {str(k): round(v, 1) for k, v in sorted(lap.items(), reverse=True)},
    }
    if rid == "WC":
        c = _ascii(buf, head["course"])
        a = _ascii(buf, head["around"])
        rec["course"] = WOOD_COURSE.get(c)
        rec["around"] = WOOD_AROUND.get(a)
    return rec


def read_all(raw_paths: List[Path], verbose: bool = True) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """生データを全部読んで、調教1本ずつのリストにする。"""
    seen = set()
    out: List[Dict[str, Any]] = []
    stat = {"files": 0, "bytes": 0, "records": 0, "hc": 0, "wc": 0,
            "dropped": 0, "dupes": 0, "corruptFiles": []}

    for p in raw_paths:
        try:
            raw = p.read_bytes()
        except OSError as e:
            print(f"[warn] 読めません: {p.name} ({e})", flush=True)
            continue

        # 2026-05-25 の文字化けバグの跡が無いか必ず見る
        if CORRUPT_MARK in raw:
            stat["corruptFiles"].append(p.name)
            print(f"[NG] 文字化けデータ (?@?@) を含む → 使いません: {p.name}", flush=True)
            continue

        stat["files"] += 1
        stat["bytes"] += len(raw)
        for chunk in raw.split(b"\r\n"):
            if len(chunk) < 30:
                continue
            rid = chunk[:2].decode("ascii", errors="replace")
            if rid == "HC":
                rec = parse_hc(chunk)
            elif rid == "WC":
                rec = parse_wc(chunk)
            else:
                continue
            stat["records"] += 1
            if rec is None:
                stat["dropped"] += 1
                continue
            key = (rec["kindCode"], rec["ketto"], rec["date"], rec["time"] or "")
            if key in seen:
                stat["dupes"] += 1
                continue
            seen.add(key)
            out.append(rec)
            stat["hc" if rid == "HC" else "wc"] += 1

        if verbose:
            print(f"  読了 {p.name}: 累計 {len(out):,} 本", flush=True)

    out.sort(key=lambda r: (r["ketto"], r["date"], r["time"] or ""))
    return out, stat


# ── 分布表（速い/遅いの物差し）を作る ──────────────────────

def group_key(rec: Dict[str, Any]) -> str:
    """同じ条件でくらべるための鍵。

    ⚠ 坂路と ウッド、美浦と栗東、距離（何ハロン走ったか）は
       タイムの意味がまったく違うので必ず分ける。
       ここを混ぜると「栗東の坂路が速い」みたいな当たり前の差を
       「この馬が速い」と誤読してしまう。
    """
    return f"{rec['kindCode']}|{rec['tresenCode']}|{rec['furlongs']}"


def group_label(key: str) -> str:
    kind, tresen, f = key.split("|")
    return (f"{TRESEN.get(tresen, tresen)} "
            f"{'坂路' if kind == 'H' else 'ウッド'} {int(f) * 200}m")


def build_stats(records: List[Dict[str, Any]], min_samples: int = 200) -> Dict[str, Any]:
    """条件ごとの分布表を作る。

    metrics（それぞれ別に順位を出す）:
      total … その日走った距離ぜんぶのタイム（例: 坂路4ハロン=800m）
      f4    … 上がり4ハロン（800m〜0m）の累計
      f3    … 上がり3ハロン（600m〜0m）の累計
      f1    … ラスト1ハロン（200m〜0m）のラップ
    ⚠ 坂路は 4ハロンで終わりなので total と f4 は同じ値になる（それで正しい）。
    """
    buckets: Dict[str, Dict[str, List[float]]] = {}
    for r in records:
        k = group_key(r)
        b = buckets.setdefault(k, {"total": [], "f4": [], "f3": [], "f1": []})
        b["total"].append(r["total"])
        v4 = r["cum"].get("4")
        if v4 is not None:
            b["f4"].append(v4)
        v3 = r["cum"].get("3")
        if v3 is not None:
            b["f3"].append(v3)
        v1 = r["lap"].get("1")
        if v1 is not None:
            b["f1"].append(v1)

    groups: Dict[str, Any] = {}
    for k, b in sorted(buckets.items()):
        g: Dict[str, Any] = {"label": group_label(k), "n": len(b["total"]), "metrics": {}}
        for m, vals in b.items():
            if len(vals) < min_samples:
                continue                       # 少なすぎる = 順位を出さない（正直に）
            cdf = build_cdf(vals)
            if cdf:
                g["metrics"][m] = cdf
        groups[k] = g
    return {"minSamples": min_samples, "groups": groups}


def percentile_of(stats: Dict[str, Any], key: str, metric: str, value: float) -> Optional[float]:
    """その値が分布の上から何%か（0 に近いほど速い）。
    JS 側 lib/chokyo.js の percentileOf と まったく同じ計算をする。"""
    g = (stats.get("groups") or {}).get(key)
    if not g:
        return None
    m = (g.get("metrics") or {}).get(metric)
    if not m:
        return None
    return cdf_percent(m, value)


# ── 索引を書く ───────────────────────────────────────────

def load_race_horses(days_back: int, days_ahead: int) -> Tuple[Dict[str, Dict[str, Any]], set]:
    """直近＋これからのレースの出走馬を集める（軽い索引に入れる馬を決めるため）。"""
    today = datetime.now().strftime("%Y%m%d")
    lo = (datetime.now() - timedelta(days=days_back)).strftime("%Y%m%d")
    hi = (datetime.now() + timedelta(days=days_ahead)).strftime("%Y%m%d")
    races: Dict[str, Dict[str, Any]] = {}
    kettos: set = set()
    if not RACES_DIR.is_dir():
        return races, kettos
    for p in RACES_DIR.glob("*.json"):
        rid = p.stem
        if len(rid) < 12 or not rid[:8].isdigit():
            continue
        date = rid[:8]
        if not (lo <= date <= hi):
            continue
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        entries = []
        for h in (d.get("horses") or []):
            k = h.get("ketto_num")
            if k and len(str(k)) == 10:
                e = {"number": h.get("number"), "ketto": str(k)}
                if h.get("name"):
                    e["name"] = h["name"]
                entries.append(e)
                kettos.add(str(k))
        if entries:
            races[rid] = {"date": date, "entries": entries}
    return races, kettos


# 軽い索引に残すタイム。ここだけあれば画面（4ハロン/3ハロン/ラスト1ハロン）は作れる。
LIGHT_CUM = ("4", "3")
LIGHT_LAP = ("4", "3", "2", "1")


def build_horses(records: List[Dict[str, Any]], keep: int,
                 only: Optional[set] = None, slim: bool = True) -> Dict[str, List[Dict[str, Any]]]:
    """馬ごとに、新しい順で最大 keep 本にまとめる。

    slim=True（軽い索引・本番に配る用）は、機械で復元できるものを落として小さくする:
      kind / tresen / meters は kindCode / tresenCode / furlongs から lib/chokyo.js が作れる。
      cum / lap も 4・3ハロンとラップ4本だけ残す（画面に出すのはここだけ）。
    slim=False（--full・研究用）は 10ハロンぶん全部そのまま残す。
    """
    by: Dict[str, List[Dict[str, Any]]] = {}
    for r in records:
        if only is not None and r["ketto"] not in only:
            continue
        by.setdefault(r["ketto"], []).append(r)
    out: Dict[str, List[Dict[str, Any]]] = {}
    for k, lst in by.items():
        lst.sort(key=lambda r: (r["date"], r["time"] or ""), reverse=True)
        rows = []
        for r in lst[:keep]:
            if slim:
                s: Dict[str, Any] = {
                    "date": r["date"], "kindCode": r["kindCode"], "tresenCode": r["tresenCode"],
                    "furlongs": r["furlongs"], "total": r["total"],
                    "cum": {f: r["cum"][f] for f in LIGHT_CUM if f in r["cum"]},
                    "lap": {f: r["lap"][f] for f in LIGHT_LAP if f in r["lap"]},
                }
            else:
                s = {
                    "date": r["date"], "kind": r["kind"], "kindCode": r["kindCode"],
                    "tresen": r["tresen"], "tresenCode": r["tresenCode"],
                    "furlongs": r["furlongs"], "meters": r["meters"],
                    "total": r["total"], "cum": r["cum"], "lap": r["lap"],
                }
                if r.get("time"):
                    s["time"] = r["time"]
                if r.get("around"):
                    s["around"] = r["around"]
            if r.get("course"):
                s["course"] = r["course"]
            rows.append(s)
        out[k] = rows
    return out


def meta_block(records: List[Dict[str, Any]], stat: Dict[str, Any], kind: str) -> Dict[str, Any]:
    dates = [r["date"] for r in records]
    return {
        "version": INDEX_VERSION,
        "kind": kind,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "JRA-VAN Data Lab. / JV-Link SLOP(坂路 HC) + WOOD(ウッドチップ WC)",
        "window": {"from": min(dates) if dates else None, "to": max(dates) if dates else None},
        "counts": {
            "sessions": len(records),
            "hanro": stat.get("hc", 0),
            "wood": stat.get("wc", 0),
            "horses": len({r["ketto"] for r in records}),
            "droppedBroken": stat.get("dropped", 0),
            "duplicates": stat.get("dupes", 0),
            "rawFiles": stat.get("files", 0),
        },
        # 作れないものは はっきり「無い」と書く（画面で嘘をつかないため）
        "notAvailable": [
            "乗り役（誰が乗ったか）",
            "併せ馬・馬なり/一杯などの脚色",
            "芝コース・ダートコース・プール・角馬場の調教",
        ],
        "notAvailableReason": (
            "JRA-VAN の調教データは 坂路(SLOP) と ウッドチップ(WOOD) の2種類だけで、"
            "レコードに乗り役や脚色の項目自体が無い。netkeiba のそれらは独自取材のデータ。"
        ),
        "caveat": (
            "分布は取り込んだ期間ぜんぶ（季節・馬場状態こみ）で作っている。"
            "雨あがりで全体が遅い日は、その日の中では相対的に速くても順位は下がる。"
        ),
    }


def write_json(path: Path, payload: Dict[str, Any]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    return path.stat().st_size


# ── 中身の要約（人が読んで確かめる用） ────────────────────

def report(records: List[Dict[str, Any]], stats: Dict[str, Any], stat: Dict[str, Any]) -> None:
    print("")
    print("=" * 62)
    print("取り込んだ調教データ")
    print("=" * 62)
    dates = sorted({r["date"] for r in records})
    print(f"  生データ      : {stat['files']} ファイル / {stat['bytes']/1e6:.1f} MB")
    print(f"  読んだ本数    : {stat['records']:,}")
    print(f"  使った本数    : {len(records):,}  (坂路 {stat['hc']:,} / ウッド {stat['wc']:,})")
    print(f"  捨てた本数    : 壊れ {stat['dropped']:,} / 重複 {stat['dupes']:,}")
    print(f"  馬の数        : {len({r['ketto'] for r in records}):,} 頭")
    print(f"  期間          : {dates[0] if dates else '-'} 〜 {dates[-1] if dates else '-'}"
          f"  ({len(dates)} 日)")
    if stat["corruptFiles"]:
        print(f"  ⚠ 文字化けで使わなかったファイル: {stat['corruptFiles']}")
    print("")
    print("条件ごとの分布（この中の順位で 速い/遅い を決める）")
    print(f"{'条件':<24}{'本数':>9}   {'最速':>7}{'上位5%':>9}{'中央':>8}{'下位20%':>9}{'最遅':>8}")
    print("-" * 78)
    for k, g in sorted(stats["groups"].items(), key=lambda kv: -kv[1]["n"]):
        m = g["metrics"].get("total")
        if not m:
            print(f"{g['label']:<24}{g['n']:>9}   （本数が少ないので順位は出さない）")
            continue
        v = lambda p: cdf_value_at(m, p)
        print(f"{g['label']:<24}{g['n']:>9,}   {v(0):>7.1f}{v(5):>9.1f}{v(50):>8.1f}"
              f"{v(80):>9.1f}{v(100):>8.1f}")
    print("")


def main() -> int:
    ap = argparse.ArgumentParser(description="JV-Link の調教データ (HC/WC) → 索引と分布表")
    ap.add_argument("--raw-dir", type=Path, default=None, help="生データ .bin の場所")
    ap.add_argument("--full", action="store_true", help="全馬ぶんの索引も書く（パソコンの中だけ）")
    ap.add_argument("--report", action="store_true", help="要約を出すだけで書き出さない")
    ap.add_argument("--keep", type=int, default=12, help="1頭あたり何本まで残すか（既定12）")
    ap.add_argument("--keep-full", type=int, default=20, help="--full 側で残す本数（既定20）")
    ap.add_argument("--days-back", type=int, default=10, help="何日前までのレースを索引に入れるか")
    ap.add_argument("--days-ahead", type=int, default=14, help="何日先までのレースを索引に入れるか")
    ap.add_argument("--min-samples", type=int, default=200, help="順位を出すのに必要な最低本数")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    raw_paths = collect_raw_files(args.raw_dir)
    if not raw_paths:
        print("[NG] 調教の生データ (.bin) が見つかりません。")
        print(f"     置き場所: {RAW_DIRS[0]}")
        print("     取り方  : py -3.12-32 jv_bridge/jv_fetch.py aggregate --dataspec SLOP "
              "--fromtime 20250801000000 --option 1")
        return 1

    print(f"[info] 生データ {len(raw_paths)} ファイルを読みます", flush=True)
    records, stat = read_all(raw_paths, verbose=not args.quiet)
    if not records:
        print("[NG] 使える調教データが1本もありませんでした。")
        return 2

    stats = build_stats(records, min_samples=args.min_samples)
    report(records, stats, stat)

    if args.report:
        print("[info] --report なので書き出しはしません")
        return 0

    # ── 軽い索引（本番にも配る） ──
    races, kettos = load_race_horses(args.days_back, args.days_ahead)
    if not kettos:
        print("[warn] 直近のレースが見つからないので、全馬ぶんを索引にします")
        horses = build_horses(records, args.keep)
        races = {}
    else:
        horses = build_horses(records, args.keep, only=kettos, slim=True)

    payload = meta_block(records, stat, "light")
    payload["races"] = races
    payload["horses"] = horses
    payload["stats"] = stats
    size = write_json(OUT_INDEX, payload)
    print(f"[OK] {OUT_INDEX.relative_to(ROOT)} を書きました "
          f"({size/1e6:.2f} MB / 馬 {len(horses):,}頭 / レース {len(races):,})")

    if args.full:
        full = meta_block(records, stat, "full")
        full["horses"] = build_horses(records, args.keep_full, slim=False)
        full["stats"] = stats
        fsize = write_json(OUT_FULL, full)
        print(f"[OK] {OUT_FULL.relative_to(ROOT)} を書きました "
              f"({fsize/1e6:.2f} MB / 馬 {len(full['horses']):,}頭)  ※パソコンの中だけ")

    return 0


if __name__ == "__main__":
    sys.exit(main())
