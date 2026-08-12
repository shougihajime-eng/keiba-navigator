# -*- coding: utf-8 -*-
"""
build_sire_map.py — 取得済みの生データから「馬→父(種牡馬)」マップ sire_map.json を作る (2026-06-13)

★読むだけ + sire_map.json を書くだけ。本番の races/predictions/features/model には触れない。

血統(BLOD)を取得すると SK(産駒マスタ: ketto_num + 父繁殖番号) / HN(繁殖馬マスタ) の生binが貯まる。
それらをパースして ketto_num -> father_num の対応表を作る。既存 horse_master.json も併合。

実行: <64bit python> jv_bridge/build_sire_map.py
"""
from __future__ import annotations
import io, json, os, sys
from pathlib import Path

os.environ["PYTHONIOENCODING"] = "utf-8"
for _a in ("stdout", "stderr"):
    _s = getattr(sys, _a, None)
    if _s and hasattr(_s, "buffer"):
        setattr(sys, _a, io.TextIOWrapper(_s.buffer, encoding="utf-8"))

ROOT = Path(__file__).resolve().parent.parent
# parse.py は「from . import jvdata_struct」という書き方(パッケージ内の相対読み込み)を
# しているので、jv_bridge フォルダを直接 sys.path に足して "import parse" とすると
# ImportError になる。プロジェクトの1つ上を通して パッケージとして読み込むのが正解。
sys.path.insert(0, str(ROOT))
CACHE = ROOT / "data" / "jv_cache"
OUT = CACHE / "sire_map.json"

from jv_bridge import parse  # noqa: E402


def _norm_hansyoku(v: str) -> str:
    """繁殖登録番号を10桁の形にそろえる。

    古い形式は8桁、新しい形式は10桁（8桁のうしろに "00" が付いた形）。
    HN(繁殖馬マスタ)の番号は実測で全部10桁・末尾"00"だったので、
    8桁で来たものは "00" を足して10桁にそろえる。
    """
    v = (v or "").strip()
    if not v.isdigit():
        return ""
    if len(v) == 8:
        v = v + "00"
    return v if v.strip("0") else ""


def _sk_father(rec: bytes):
    """SK(産駒マスタ)の生レコードから (血統登録番号, 父の繁殖登録番号) を取り出す。

    ⚠ SK には新旧2つの形式がある（JV-Data仕様書の改訂履歴に
      「生産者コード 6→8バイト、3代血統 繁殖登録番号 8→10バイト」とある）。
        旧: 本体176バイト / 3代血統は 8桁 × 14 で offset 64 から
        新: 本体206バイト / 3代血統は10桁 × 14 で offset 66 から
      3代血統の並びは 父・母・父父・父母・母父・母母・… なので、先頭が父。

    2026-08-12 実測：いま JRA-VAN が配っているセットアップデータは【旧形式(176)】。
    どちらが来ても読めるように、レコードの長さで判定する。
    ⚠ jvdata_struct.py の SK_FIELDS には父の項目が定義されておらず、
      そのため今まで SK からは1頭も父を取れていなかった（この関数はその穴埋め）。
    """
    n = len(rec)
    if n >= 200:          # 新形式
        off, ln = 66, 10
    elif n >= 170:        # 旧形式
        off, ln = 64, 8
    else:
        return None, None
    ketto = rec[11:21].decode("ascii", "replace").strip()
    father = rec[off:off + ln].decode("ascii", "replace").strip()
    if not ketto.isdigit():
        return None, None
    return ketto, _norm_hansyoku(father)


def _hn_father(rec: bytes):
    """HN(繁殖馬マスタ)の生レコードから (血統登録番号, 父の繁殖登録番号) を取り出す。

    ⚠ HN にも新旧2形式がある（繁殖登録番号 8→10バイト）。
        新: 本体249バイト → 血統登録番号 offset 29 / 父 offset 229（どちらも10桁）
        旧: 本体243バイト → ずれる。実測したところ旧の父の位置は特定できず、
            しかも新の位置(229)を旧レコードに当てると
            「10桁の数字に見えるゴミ」が100%の確率で取れてしまう（＝一番危ない）。
    そこで【旧形式は読まない】。旧形式に載っている馬は SK(産駒マスタ)側で
    ほぼ100%カバーできている（実測: 2014〜2022年生まれ 97〜100%）ので実害は無い。
    """
    if len(rec) < 246:          # 旧形式 → 触らない
        return None, None
    ketto = rec[29:39].decode("ascii", "replace").strip()
    father = rec[229:239].decode("ascii", "replace").strip()
    if not ketto.isdigit() or not ketto.strip("0"):
        return None, None
    return ketto, _norm_hansyoku(father)


def _um_father(rec: bytes):
    """UM(競走馬マスタ)の生レコードから (血統登録番号, 父の繁殖登録番号) を取り出す。

    新形式(本体1607バイト)は <3代血統情報> が offset 204 から
    「繁殖登録番号10桁 + 馬名36桁」= 46バイト × 14 で並ぶ。先頭が父。
    """
    if len(rec) < 1400:
        return None, None
    ketto = rec[11:21].decode("ascii", "replace").strip()
    father = rec[204:214].decode("ascii", "replace").strip()
    if not ketto.isdigit() or not ketto.strip("0"):
        return None, None
    return ketto, _norm_hansyoku(father)


def main():
    # 血統系の生binを集める(BLOD取得物 + 既存rawも一応走査)
    bins = list(CACHE.glob("aggregate_*_BLOD/raw_*.bin")) + list(CACHE.glob("aggregate_*BLOD*/*.bin"))
    if not bins:
        # フォールバック: 全aggregateフォルダ + 直下rawから血統レコードを拾う
        bins = list(CACHE.glob("aggregate_*/raw_*.bin")) + list(CACHE.glob("raw_*.bin"))
    print(f"[info] 走査する生bin: {len(bins)} ファイル", flush=True)

    sire = {}     # ketto_num -> father_num
    counts = {}
    for b in bins:
        try:
            raw = b.read_bytes()
        except Exception:
            continue
        # ⚠ 血統の3レコードは、どれも jvdata_struct.py に「父」の項目が
        #    定義されていない（＝既存パーサでは1頭も取れない）。さらに新旧2形式が
        #    混在していて、旧形式に新形式の位置を当てると
        #    「数字に見えるゴミ」が取れてしまう。だから生バイトから読む。
        readers = {b"SK": _sk_father, b"HN": _hn_father, b"UM": _um_father}
        for rec_bytes in parse.split_raw_file(raw):
            fn = readers.get(rec_bytes[:2])
            if fn is None:
                continue
            ketto, father = fn(rec_bytes)
            if ketto and father and ketto not in sire:
                sire[ketto] = father
                rid = rec_bytes[:2].decode("ascii")
                counts[rid] = counts.get(rid, 0) + 1

    # 既存 horse_master.json の father も併合
    hm = CACHE / "horse_master.json"
    if hm.exists():
        try:
            d = json.loads(hm.read_text(encoding="utf-8"))
            for k, v in d.items():
                fa = (v.get("father_num") or "").strip() if isinstance(v, dict) else ""
                if k and fa and fa.strip("0") and k not in sire:
                    sire[k] = fa
        except Exception:
            pass

    OUT.write_text(json.dumps(sire, ensure_ascii=False), encoding="utf-8")
    print(f"[OK] {OUT.name} 保存: {len(sire)} 頭ぶんの父馬 (内訳 {counts})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
