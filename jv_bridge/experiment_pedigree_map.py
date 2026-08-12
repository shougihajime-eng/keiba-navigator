# -*- coding: utf-8 -*-
"""
experiment_pedigree_map.py — 実験用の血統マップを作る（父 と 母父＝BMS）

★これは実験専用。本番の予想・EV計算・画面には一切つながらない。
   本番が使う sire_map.json は **書き換えない**（別ファイルに出す）。

なぜ作るか
  ①「母父（BMS）」が既存の sire_map.json に入っていない。
  ② 既存 build_sire_map.py の繁殖登録番号の直し方が **まちがっている疑い** があるので、
     実データで確かめて、正しい形の父マップも作る。

🚨 実データで確かめた事実（2026-08-12・11,508頭で照合・食い違い0）
  繁殖登録番号には 8桁の古い形と 10桁の新しい形がある。
  正しい対応は「**あたま3文字のうしろに 00 を入れる**」：
      11202242（8桁） → 112 + 00 + 02242 = 1120002242（10桁）
  ところが build_sire_map.py は「**うしろに 00 を足す**」（→ 1120224200）。
  これだと SK（産駒マスタ・8桁）から取った父と、UM（競走馬マスタ・10桁）から取った父が
  **同じ馬なのに別のIDになる**＝1頭の種牡馬の成績が2つに割れて薄くなる。
  （BLOD/BLDN の SK と DIFN の UM が両方あるので、実際に割れている）

3代血統の並び（SK も UM も同じ）
  0:父 1:母 2:父父 3:父母 **4:母父(BMS)** 5:母母 …（14頭ぶん）
  ＝ UM は名前も入っているので目で確かめられる。実測でも
    ドリームジャーニー→父父ステイゴールド／母父Danehill と正しく並んでいた。

出力: data/jv_cache/experiment_pedigree_map.json
      {"ketto": {"f": 父ID10桁, "b": 母父ID10桁}, ...} ＋ 名前の辞書
実行: <64bit python> jv_bridge/experiment_pedigree_map.py
"""
from __future__ import annotations

import io
import json
import os
import sys
from collections import Counter
from pathlib import Path

os.environ["PYTHONIOENCODING"] = "utf-8"
for _a in ("stdout", "stderr"):
    _s = getattr(sys, _a, None)
    if _s and hasattr(_s, "buffer"):
        setattr(sys, _a, io.TextIOWrapper(_s.buffer, encoding="utf-8"))

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
CACHE = ROOT / "data" / "jv_cache"
RACES = CACHE / "races"
OUT = CACHE / "experiment_pedigree_map.json"

from jv_bridge import parse  # noqa: E402


# ── 繁殖登録番号を10桁の正しい形にそろえる ───────────────────
def to10(v: str) -> str:
    """8桁の古い形を10桁の新しい形にそろえる（あたま3文字のうしろに 00 を入れる）。"""
    v = (v or "").strip()
    if not v.isdigit():
        return ""
    if len(v) == 8:
        v = v[:3] + "00" + v[3:]
    if len(v) != 10:
        return ""
    return v if v.strip("0") else ""


def _ped_from_sk(rec: bytes):
    """SK(産駒マスタ) → (血統登録番号, 父, 母父)。新旧2形式に対応。"""
    n = len(rec)
    if n >= 200:
        off, ln = 66, 10          # 新形式
    elif n >= 170:
        off, ln = 64, 8           # 旧形式
    else:
        return None
    ketto = rec[11:21].decode("ascii", "replace").strip()
    if not ketto.isdigit():
        return None
    def g(i):
        return to10(rec[off + i * ln: off + (i + 1) * ln].decode("ascii", "replace"))
    return ketto, g(0), g(4)


def _ped_from_um(rec: bytes):
    """UM(競走馬マスタ) → (血統登録番号, 父, 母父, 父の名前, 母父の名前)。
    3代血統は offset 204 から「繁殖登録番号10桁 + 馬名36桁」= 46バイト × 14。"""
    if len(rec) < 1400:
        return None
    ketto = rec[11:21].decode("ascii", "replace").strip()
    if not ketto.isdigit():
        return None
    def g(i):
        base = 204 + i * 46
        num = to10(rec[base:base + 10].decode("ascii", "replace"))
        nm = rec[base + 10:base + 46].decode("cp932", "replace").strip()
        return num, nm
    f, fn = g(0)
    b, bn = g(4)
    return ketto, f, b, fn, bn


def _ped_from_hn(rec: bytes):
    """HN(繁殖馬マスタ・新形式249バイトのみ) → (血統登録番号, 父)。母父は入っていない。
    ⚠ 旧形式(243)は父の位置が特定できず、当てるとゴミが100%取れるので読まない
      （build_sire_map.py と同じ判断）。"""
    if len(rec) < 246:
        return None
    ketto = rec[29:39].decode("ascii", "replace").strip()
    if not ketto.isdigit() or not ketto.strip("0"):
        return None
    return ketto, to10(rec[229:239].decode("ascii", "replace"))


def _bins():
    seen, out = set(), []
    for p in sorted((CACHE / "kettou_raw").glob("*.bin")):
        rp = p.resolve()
        if rp not in seen:
            seen.add(rp)
            out.append(p)
    for spec in ("BLOD", "BLDN", "DIFF", "DIFN"):
        for p in sorted(CACHE.glob(f"aggregate_*{spec}/*.bin")):
            rp = p.resolve()
            if rp not in seen:
                seen.add(rp)
                out.append(p)
    return out


def build_map():
    """{ketto: {"f":父, "b":母父}} と 名前辞書 を返す。UM を最優先（10桁の本物＋名前つき）。"""
    ped: dict[str, dict] = {}
    names: dict[str, str] = {}
    src = Counter()
    bins = _bins()
    print(f"[info] 走査する生bin: {len(bins)} ファイル", flush=True)

    # 1回目: UM（いちばん信頼できる。10桁そのまま＋名前が入っている）
    for b in bins:
        try:
            raw = b.read_bytes()
        except Exception:
            continue
        for rec in parse.split_raw_file(raw):
            if rec[:2] != b"UM":
                continue
            r = _ped_from_um(rec)
            if not r:
                continue
            ketto, f, bm, fn, bn = r
            if not (f or bm):
                continue
            ped.setdefault(ketto, {"f": f, "b": bm})
            src["UM"] += 1
            if f and fn:
                names.setdefault(f, fn)
            if bm and bn:
                names.setdefault(bm, bn)
        del raw

    # 2回目: SK（産駒マスタ。UM に無い馬を埋める）
    for b in bins:
        try:
            raw = b.read_bytes()
        except Exception:
            continue
        for rec in parse.split_raw_file(raw):
            if rec[:2] != b"SK":
                continue
            r = _ped_from_sk(rec)
            if not r:
                continue
            ketto, f, bm = r
            if not (f or bm):
                continue
            cur = ped.get(ketto)
            if cur is None:
                ped[ketto] = {"f": f, "b": bm}
                src["SK"] += 1
            else:
                if not cur.get("f") and f:
                    cur["f"] = f
                if not cur.get("b") and bm:
                    cur["b"] = bm
        del raw

    # 3回目: HN（父だけ。まだ父が空の馬を埋める）
    for b in bins:
        try:
            raw = b.read_bytes()
        except Exception:
            continue
        for rec in parse.split_raw_file(raw):
            if rec[:2] != b"HN":
                continue
            r = _ped_from_hn(rec)
            if not r:
                continue
            ketto, f = r
            if not f:
                continue
            cur = ped.get(ketto)
            if cur is None:
                ped[ketto] = {"f": f, "b": ""}
                src["HN"] += 1
            elif not cur.get("f"):
                cur["f"] = f
        del raw
    return ped, names, src


def _race_horses():
    """races/*.json に出てくる馬の血統登録番号を集める（カバー率をはかる用）。"""
    out = set()
    for p in RACES.glob("*.json"):
        try:
            r = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        for h in (r.get("horses") or []):
            k = h.get("ketto_num")
            if k:
                out.add(k)
    return out


def main() -> int:
    ped, names, src = build_map()
    print(f"[info] 血統を取れた馬 {len(ped)} 頭（もと {dict(src)}）", flush=True)

    horses = _race_horses()
    hf = sum(1 for k in horses if ped.get(k, {}).get("f"))
    hb = sum(1 for k in horses if ped.get(k, {}).get("b"))
    print(f"[info] レースに出た馬 {len(horses)} 頭のうち "
          f"父が分かる {hf} ({hf/max(1,len(horses))*100:.1f}%) / "
          f"母父が分かる {hb} ({hb/max(1,len(horses))*100:.1f}%)", flush=True)

    # 既存 sire_map.json と比べる（IDの直し方の違いがどれくらい影響しているか）
    sm_path = CACHE / "sire_map.json"
    if sm_path.exists():
        sm = json.loads(sm_path.read_text(encoding="utf-8"))
        old_ids = {v for v in sm.values() if v}
        new_ids = {d["f"] for d in ped.values() if d.get("f")}
        # 「うしろに00」形＝末尾00 かつ 4〜5文字目が00でない
        tail00 = {v for v in old_ids if v.endswith("00") and v[3:5] != "00"}
        print(f"[info] 既存 sire_map の父ID {len(old_ids)} 種類 / "
              f"うち『うしろに00』形 {len(tail00)} 種類（＝別IDに割れていた分）", flush=True)
        print(f"[info] 直した父ID {len(new_ids)} 種類", flush=True)

    OUT.write_text(json.dumps({
        "note": "実験専用。本番は sire_map.json を使う（こちらは書き換えない）。",
        "id_fix": "8桁→10桁は『あたま3文字のうしろに00を入れる』（実データ11,508頭で照合・食い違い0）",
        "pedigree": ped,
        "names": names,
    }, ensure_ascii=False), encoding="utf-8")
    print(f"[OK] {OUT.name} 保存（本番未配線）", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
