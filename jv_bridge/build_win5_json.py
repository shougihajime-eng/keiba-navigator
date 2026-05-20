# -*- coding: utf-8 -*-
"""
build_win5_json.py — WF レコード (重勝式・WIN5 払戻) を 1 開催日 1 ファイルに展開 (Wave31)

入力:
  WF レコード (7215 バイト) を含む raw_*.bin
出力:
  data/jv_cache/win5/<YYYYMMDD>.json
    {
      "date": "YYYY-MM-DD",
      "data_kbn": "...",
      "target_races": [
        {"jyo_code": "08", "kai_ji": "02", "nichi_ji": "08", "race_num": "10",
         "race_id": "20250518080208100"}, ...
      ],
      "sales_votes": 7091971,
      "kaeshi_flag": "1",
      "husei_flag": "0",
      "tekityu_nashi_flag": "0",
      "carryover_initial": 0,
      "carryover_balance": 0,
      "payouts": [
        {"kumi": "07-07-09-03-17", "kumi_raw": "0707090317",
         "amount": 3789600, "tickets": 131},
      ],
      "_meta": {...}
    }
"""
from __future__ import annotations

import io as _io
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

os.environ["PYTHONIOENCODING"] = "utf-8"
for _attr in ("stdout", "stderr"):
    _s = getattr(sys, _attr, None)
    if _s is None: continue
    try: _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE = ROOT / "data" / "jv_cache"
WIN5_DIR = CACHE / "win5"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.jvdata_struct import WF_TAISYO_LOOP, WF_PAYOUT_LOOP  # noqa: E402


def _to_int_safe(s):
    """空白埋めも 0 として扱う安全な int 変換。"""
    if not s: return 0
    try:
        s2 = (s.decode("ascii", errors="replace") if isinstance(s, (bytes, bytearray)) else str(s)).strip()
        if not s2: return 0
        return int(s2)
    except (ValueError, TypeError):
        return 0


def _to_str_safe(b):
    if isinstance(b, (bytes, bytearray)):
        try: return b.decode("ascii", errors="replace").strip()
        except Exception: return ""
    return str(b or "").strip()


def parse_wf_payouts(rec: bytes) -> List[Dict[str, Any]]:
    """WF レコードの 重勝式払戻情報 (243 通り × 29 bytes) をパース。
    空白埋めは除外し、有効な払戻のみ返す。"""
    out: List[Dict[str, Any]] = []
    base = WF_PAYOUT_LOOP["offset"]
    count = WF_PAYOUT_LOOP["count"]
    elem_len = WF_PAYOUT_LOOP["elem_len"]
    for i in range(count):
        ofs = base + i * elem_len
        if ofs + elem_len > len(rec):
            break
        kumi_raw = rec[ofs:ofs+10]
        amount_raw = rec[ofs+10:ofs+19]
        votes_raw = rec[ofs+19:ofs+29]
        # 全部空白 (or 全 0) なら飛ばす
        kumi_str = _to_str_safe(kumi_raw)
        amount = _to_int_safe(amount_raw)
        votes = _to_int_safe(votes_raw)
        if not kumi_str or amount == 0:
            continue
        # 組番フォーマット (10 桁 = 5 レース×2 桁): 0707090317 → 7-7-9-3-17
        if len(kumi_str) == 10 and kumi_str.isdigit():
            kumi_fmt = "-".join(str(int(kumi_str[i:i+2])) for i in range(0, 10, 2))
        else:
            kumi_fmt = kumi_str
        out.append({"kumi": kumi_fmt, "kumi_raw": kumi_str,
                    "amount": amount, "tickets": votes})
    return out


def parse_wf_target_races(rec: bytes, year: str, month_day: str) -> List[Dict[str, Any]]:
    """WF レコードの 対象レース 5 R 分 (8 bytes/R) をパース。race_id を組み立てる。"""
    out: List[Dict[str, Any]] = []
    base = WF_TAISYO_LOOP["offset"]
    count = WF_TAISYO_LOOP["count"]
    elem_len = WF_TAISYO_LOOP["elem_len"]
    for i in range(count):
        ofs = base + i * elem_len
        if ofs + elem_len > len(rec):
            break
        jyo = _to_str_safe(rec[ofs:ofs+2])
        kai = _to_str_safe(rec[ofs+2:ofs+4])
        nichi = _to_str_safe(rec[ofs+4:ofs+6])
        rnum = _to_str_safe(rec[ofs+6:ofs+8])
        if not all([jyo, kai, nichi, rnum]):
            continue
        # race_id: YYYYMMDDJJKKDNDRR00 (Wave17 統一形式の 18 桁)
        race_id = f"{year}{month_day}{jyo}{kai}{nichi}{rnum}00"
        out.append({
            "jyo_code": jyo, "kai_ji": kai, "nichi_ji": nichi, "race_num": rnum,
            "race_id": race_id,
        })
    return out


def build_from_wf_record(rec: bytes) -> Optional[Dict[str, Any]]:
    """単一の WF レコードから win5 json を組み立てる。"""
    if len(rec) < 167:
        return None
    if rec[0:2] != b"WF":
        return None
    data_kbn = _to_str_safe(rec[2:3])
    make_date = _to_str_safe(rec[3:11])
    year = _to_str_safe(rec[11:15])
    month_day = _to_str_safe(rec[15:19])
    if not year or not month_day or len(year) != 4 or len(month_day) != 4:
        return None
    date_iso = f"{year}-{month_day[:2]}-{month_day[2:]}"
    target_races = parse_wf_target_races(rec, year, month_day)
    sales_votes = _to_int_safe(rec[67:78])
    kaeshi = _to_str_safe(rec[133:134])
    husei = _to_str_safe(rec[134:135])
    tekityu_nashi = _to_str_safe(rec[135:136])
    co_init = _to_int_safe(rec[136:151])
    co_bal = _to_int_safe(rec[151:166])
    payouts = parse_wf_payouts(rec)
    return {
        "date": date_iso,
        "year": year, "month_day": month_day,
        "data_kbn": data_kbn,
        "make_date": make_date,
        "target_races": target_races,
        "sales_votes": sales_votes,
        "kaeshi_flag": kaeshi,
        "husei_flag": husei,
        "tekityu_nashi_flag": tekityu_nashi,
        "carryover_initial": co_init,
        "carryover_balance": co_bal,
        "payouts": payouts,
        "_meta": {
            "schema_version": "1",
            "record_id": "WF",
        },
    }


def write_win5_json(d: Dict[str, Any]) -> Optional[Path]:
    """win5/<YYYYMMDD>.json に保存。既存ファイルは data_kbn 優先度で merge。
    優先順位: data_kbn '7' (月曜成績) > '3' (払戻発表) > '2' (1R確定) > '1' (詳細発表) > 他
    """
    if not d or not d.get("year"): return None
    WIN5_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"{d['year']}{d['month_day']}.json"
    out = WIN5_DIR / fname
    priority = {"7": 5, "3": 4, "2": 3, "1": 2, "9": 1, "0": 0}
    if out.exists():
        try:
            old = json.loads(out.read_text(encoding="utf-8"))
            old_pr = priority.get(str(old.get("data_kbn")), 0)
            new_pr = priority.get(str(d.get("data_kbn")), 0)
            if new_pr < old_pr:
                return out  # 既存の方が新しい・上書きしない
        except Exception:
            pass
    out.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def find_wf_records(raw_bytes: bytes) -> List[bytes]:
    """raw bin から WF レコードを抽出 (CR/LF 区切り)。"""
    records = []
    # WF レコードは行頭から始まり 7215 バイト + CR/LF。
    # 単純に b'\nWF' を境に分割して 7215 バイト切り出し
    idx = 0
    n = len(raw_bytes)
    # 先頭が 'WF' で始まる場合もある
    if raw_bytes.startswith(b"WF"):
        if 7215 <= n:
            records.append(raw_bytes[:7215])
        idx = 7215
    while True:
        pos = raw_bytes.find(b"\nWF", idx)
        if pos < 0:
            break
        start = pos + 1
        end = start + 7215
        if end > n: break
        records.append(raw_bytes[start:end])
        idx = end
    return records


def build_all_wf(raw_files: List[Path]) -> int:
    """raw bin リストから WF を全部抽出 → 日別 json 化。"""
    total_records = 0
    written = 0
    for p in raw_files:
        try:
            data = p.read_bytes()
        except Exception:
            continue
        recs = find_wf_records(data)
        if not recs:
            continue
        total_records += len(recs)
        for rec in recs:
            d = build_from_wf_record(rec)
            if d and d.get("payouts"):
                out = write_win5_json(d)
                if out:
                    written += 1
    print(f"[build_win5_json] WF レコード総数 {total_records} / json 書き出し {written} 件", flush=True)
    return written


if __name__ == "__main__":
    import glob
    paths = []
    for root in glob.glob(str(CACHE / "aggregate_*")):
        if "_pre_fix" in root or "_quarantine" in root:
            continue
        for f in glob.glob(os.path.join(root, "raw_*.bin")):
            paths.append(Path(f))
    print(f"[build_win5_json] raw bin {len(paths)} 件をスキャン", flush=True)
    build_all_wf(paths)
