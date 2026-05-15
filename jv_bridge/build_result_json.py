# -*- coding: utf-8 -*-
"""
パース済 HR (払戻) レコードから、lib/finalize.js が読む results JSON を組み立てる。

期待スキーマ (lib/finalize.js の冒頭コメント参照):
{
  "race_id":   "...",
  "race_name": "...",
  "finishedAt": "ISO datetime",
  "results": [
    { "rank": 1, "number": 6, "name": "...", "tan_payout": 1800 }
  ],
  "payouts": {
    "tan":   { "winner": 6, "amount": 1800 },
    "fuku":  [{ "number": 6, "amount": 350 }, ...],
    "uren":  { "key": "3-6", "amount": 1290 },
    "wide":  [{ "key": "3-6", "amount": 410 }, ...],
    "fuku3": { "key": "1-3-6", "amount": 1830 },
    "tan3":  { "key": "6-3-1", "amount": 12450 }
  }
}

設計:
  HR レコードは「券種ごとの繰り返し領域」の組み合わせ。
  各券種の (count, key_len, amount_len, pop_len) は jvdata_struct.HR_PAYOUT_LAYOUT
  に定義済み。本モジュールはそれを元に「raw 値 → 内部 dict」を組み立てる層を提供する。
  bytes 切り出しの offset は仕様書転記時に payout_offsets を埋めれば動く。
"""

from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import io_helpers as io
from . import jvdata_struct


OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "jv_cache" / "results"


# ── 個別券種パーサ ────────────────────────────────────────

def _parse_horse_num_key(raw: str) -> Optional[str]:
    """組番 raw 文字列を '1-3-6' 形式に変換。
    例: '030600'(2桁ペア×3) → '3-6'、'010306'(2桁×3) → '1-3-6'。
    数字のみの 2 桁単位で分割する。
    """
    if not raw or not raw.strip():
        return None
    t = raw.strip()
    if not t.isdigit():
        return None
    if len(t) % 2 != 0:
        return None
    nums = []
    for i in range(0, len(t), 2):
        n = int(t[i:i + 2])
        if n == 0:
            continue
        nums.append(str(n))
    if not nums:
        return None
    return "-".join(nums)


def _parse_amount(raw: str) -> Optional[int]:
    """払戻金額。'0000001800' → 1800。データ無しは None。"""
    if not raw or io.is_data_missing(raw):
        return None
    n = io.to_int(raw)
    if n is None or n <= 0:
        return None
    return n


def parse_payout_block(buf: bytes, offset: int, count: int,
                       key_len: int, amount_len: int, pop_len: int) -> List[Dict[str, Any]]:
    """1 券種の繰り返し領域をパース。

    返り値:
        [{"key": "1-3-6", "amount": 12450, "popularity": 5}, ...]
        払戻金額が None (未確定・該当なし) の項目は除外する。
    """
    if not buf or offset < 0 or count <= 0:
        return []
    element_len = key_len + amount_len + pop_len
    end = offset + element_len * count
    if end > len(buf):
        return []
    out: List[Dict[str, Any]] = []
    for i in range(count):
        start = offset + i * element_len
        key_raw    = io.decode_ascii(buf[start: start + key_len])
        amount_raw = io.decode_ascii(buf[start + key_len: start + key_len + amount_len])
        pop_raw    = io.decode_ascii(buf[start + key_len + amount_len:
                                        start + key_len + amount_len + pop_len])

        key = _parse_horse_num_key(key_raw)
        amount = _parse_amount(amount_raw)
        if amount is None or key is None:
            continue
        pop = io.to_int(pop_raw)
        out.append({"key": key, "amount": amount, "popularity": pop})
    return out


def parse_hr_payouts(buf: bytes,
                     payout_offsets: Optional[Dict[str, int]] = None,
                     layout_override: Optional[Dict[str, Dict[str, int]]] = None
                     ) -> Dict[str, List[Dict[str, Any]]]:
    """HR レコード bytes から payouts dict を組み立て。

    通常は jvdata_struct.HR_PAYOUT_LAYOUT のデフォルト offset (仕様書 4.9.0.1 由来)
    を使う。テスト等で別の offset / レイアウトを使いたい場合は引数で上書き可能。

    payout_offsets: {"tan": 102, "fuku": 141, ...} 形式の上書きマップ (任意)
    layout_override: HR_PAYOUT_LAYOUT 自体の上書きマップ (任意)
    """
    out: Dict[str, List[Dict[str, Any]]] = {}
    base_layout = jvdata_struct.HR_PAYOUT_LAYOUT
    overrides = layout_override or {}
    offset_overrides = payout_offsets or {}
    for ticket, layout in base_layout.items():
        layout = overrides.get(ticket, layout)
        if layout is None:
            out[ticket] = []
            continue
        # offset は引数の payout_offsets が優先、無ければ layout["offset"] を使う
        off = offset_overrides.get(ticket, layout.get("offset"))
        if off is None or off < 0:
            out[ticket] = []
            continue
        out[ticket] = parse_payout_block(
            buf, off,
            layout["count"], layout["key_len"], layout["amount_len"], layout["pop_len"],
        )
    return out


# ── 内部 dict → finalize.js 形式 への成形 ─────────────────

def _shape_payouts(parsed: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    """parse_hr_payouts の返り値を lib/finalize.js が読む形に成形する。

    payouts スキーマ:
      tan:   {winner: number, amount: number}                      ← 単勝 1 つ目
      fuku:  [{number, amount}, ...]                                ← 複勝 全部
      uren:  {key: '3-6', amount}                                   ← 馬連 1 つ目
      wide:  [{key, amount}, ...]                                   ← ワイド 全部 (普通 3 つ)
      fuku3: {key: '1-3-6', amount}                                 ← 3連複 1 つ目
      tan3:  {key: '6-3-1', amount}                                 ← 3連単 1 つ目
    """
    out: Dict[str, Any] = {}

    # 単勝: 1着 (key=馬番1個) と金額。1 つ目だけ採用。
    tan_list = parsed.get("tan") or []
    if tan_list:
        first = tan_list[0]
        n = first["key"].split("-")[0]
        out["tan"] = {"winner": int(n) if n.isdigit() else None, "amount": first["amount"]}

    # 複勝: 3 着までの馬それぞれ。{number, amount} のリストにする。
    fuku_list = parsed.get("fuku") or []
    if fuku_list:
        out["fuku"] = [
            {"number": int(p["key"].split("-")[0]) if p["key"].split("-")[0].isdigit() else None,
             "amount": p["amount"]}
            for p in fuku_list
        ]

    # 馬連 (1 通り)
    uren_list = parsed.get("uren") or []
    if uren_list:
        out["uren"] = {"key": uren_list[0]["key"], "amount": uren_list[0]["amount"]}

    # ワイド (3 通り通常)
    wide_list = parsed.get("wide") or []
    if wide_list:
        out["wide"] = [{"key": w["key"], "amount": w["amount"]} for w in wide_list]

    # 馬単 (1 通り)
    utan_list = parsed.get("utan") or []
    if utan_list:
        out["utan"] = {"key": utan_list[0]["key"], "amount": utan_list[0]["amount"]}

    # 3 連複 (1 通り)
    fuku3_list = parsed.get("fuku3") or []
    if fuku3_list:
        out["fuku3"] = {"key": fuku3_list[0]["key"], "amount": fuku3_list[0]["amount"]}

    # 3 連単 (1 通り)
    tan3_list = parsed.get("tan3") or []
    if tan3_list:
        out["tan3"] = {"key": tan3_list[0]["key"], "amount": tan3_list[0]["amount"]}

    # 枠連 (1 通り) ※必要なら使う
    wakuren_list = parsed.get("wakuren") or []
    if wakuren_list:
        out["wakuren"] = {"key": wakuren_list[0]["key"], "amount": wakuren_list[0]["amount"]}

    return out


def _shape_results(parsed_results: List[Dict[str, Any]],
                   tan_payout: Optional[int]) -> List[Dict[str, Any]]:
    """着順 [{rank, number, name}, ...] と単勝払戻を結合して results 配列にする。"""
    out: List[Dict[str, Any]] = []
    for r in (parsed_results or []):
        item = {
            "rank":   r.get("rank"),
            "number": r.get("number"),
            "name":   r.get("name"),
        }
        if r.get("rank") == 1 and tan_payout is not None:
            item["tan_payout"] = tan_payout
        out.append(item)
    return out


# ── 公開 API ──────────────────────────────────────────────

def build(hr: Dict[str, Any],
          ra: Optional[Dict[str, Any]] = None,
          se_list: Optional[List[Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    """HR + (任意で) RA + SE[] → results JSON。

    HR dict は以下のいずれかの形を受け入れる:
      1) 既に解析済みで {payouts: {...}, results: [...]} を持つ dict
      2) 生 bytes を持つ dict ({"_raw": bytes, "_payout_offsets": {...}, "results": [...]})

    形 (2) の場合、payout_offsets を見て生 bytes を内部でパースする。
    """
    if not hr:
        return None

    # race_id の決定 (lib/race_id.js JRA_18DIGIT と完全一致させる)
    race_id = hr.get("race_id_18digit") or hr.get("race_id")
    if race_id and len(str(race_id)) == 16 and str(race_id).isdigit():
        race_id = str(race_id) + "00"
    if not race_id and ra is not None:
        parts = [str(ra.get(k) or "") for k in
                 ("year", "month_day", "jyo_code", "kai_ji", "nichi_ji", "race_num")]
        if all(parts):
            base = "".join(parts)
            if len(base) == 16 and base.isdigit():
                race_id = base + "00"
    if not race_id:
        return None

    # 形 (2) を形 (1) に変換
    payouts = hr.get("payouts")
    if payouts is None and isinstance(hr.get("_raw"), (bytes, bytearray)):
        offsets = hr.get("_payout_offsets") or {}
        parsed = parse_hr_payouts(hr["_raw"], offsets)
        payouts = _shape_payouts(parsed)
    payouts = payouts or {}

    # 着順と単勝払戻金の結合
    results_raw = hr.get("results") or []
    tan_amount = (payouts.get("tan") or {}).get("amount") if isinstance(payouts.get("tan"), dict) else None
    results = _shape_results(results_raw, tan_amount)

    return {
        "race_id":    race_id,
        "race_name":  (ra or {}).get("race_name"),
        "finishedAt": hr.get("finishedAt") or datetime.now(timezone.utc).isoformat(),
        "results":    results,
        "payouts":    payouts,
        "source":     "jv_link",
    }


def from_se_list(ra: Dict[str, Any],
                 se_list: List[Dict[str, Any]],
                 hr: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """SE レコード群から results 配列を組み立て、HR (オプション) で payouts を合体する。

    SE の `kakutei_jyuni` (確定着順) と `time` (走破タイム) と `horse_num` `horse_name` から
    results: [{rank, number, name, time}] を生成する。HR が無くても着順データが組める。

    Returns:
      lib/finalize.js 互換の results JSON dict。失敗時は None。
    """
    if not ra or not isinstance(se_list, list):
        return None
    race_id = None
    if ra:
        parts = [str(ra.get(k) or "") for k in
                 ("year","month_day","jyo_code","kai_ji","nichi_ji","race_num")]
        if all(parts):
            base = "".join(parts)
            if len(base) == 16 and base.isdigit():
                race_id = base + "00"   # 18 桁化 (lib/race_id.js JRA_18DIGIT と一致)
    if not race_id:
        return None

    # 着順順に並べる
    results_raw = []
    for se in se_list:
        rank = se.get("kakutei_jyuni")
        num  = se.get("horse_num")
        if not isinstance(rank, int) or rank <= 0:
            continue
        if not isinstance(num, int) or num <= 0:
            continue
        results_raw.append({
            "rank":   rank,
            "number": num,
            "name":   se.get("horse_name"),
            "time":   se.get("time"),
            "jockey": se.get("jockey_name"),
            "popularity": se.get("popularity"),
            "win_odds":   se.get("win_odds"),
        })
    results_raw.sort(key=lambda r: r["rank"])

    # HR がある場合は payouts も組み立て
    payouts: Dict[str, Any] = {}
    if hr:
        # HR が build() を通って payouts 既に整形済みならそれを使う。
        # 生 dict (parse_hr_payouts の戻り値形式) なら _shape_payouts に渡す。
        if hr.get("payouts"):
            payouts = hr["payouts"]
        elif isinstance(hr.get("_raw"), (bytes, bytearray)):
            parsed = parse_hr_payouts(hr["_raw"])
            payouts = _shape_payouts(parsed)

    # 単勝払戻を 1 着馬に attach
    tan_amount = (payouts.get("tan") or {}).get("amount") if isinstance(payouts.get("tan"), dict) else None
    if tan_amount is not None:
        for r in results_raw:
            if r["rank"] == 1:
                r["tan_payout"] = tan_amount
                break

    return {
        "race_id":    race_id,
        "race_name":  ra.get("race_name"),
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "results":    results_raw,
        "payouts":    payouts,
        "source":     "jv_link",
    }


def write(results_json: Dict[str, Any]) -> Optional[Path]:
    if not results_json or not results_json.get("race_id"):
        return None
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{results_json['race_id']}.json"
    out.write_text(json.dumps(results_json, ensure_ascii=False, indent=2), encoding="utf-8")
    return out
