# -*- coding: utf-8 -*-
"""
experiment_simple_rules_meta.py — 総当たり実験のための「レースの下ごしらえ」だけをする道具

★なにをするか
  value_ev_bets.json に入っている 3,656 レースぶんの「レースの条件」を、
  races/*.json から **読むだけ** で1つのファイルに写し取る（＝スナップショット）。

★なぜ写すのか
  ・races/ は今この瞬間も別の作業が10年ぶんを取り込んでいる＝中身が増えていく。
    直接読みながら実験すると「昨日と今日で答えが変わる」ことが起きる。
  ・写しておけば、あとから何度やっても同じ答えになる（再現できる）。

★絶対にしないこと
  ・races/ results/ を1文字も書き換えない（開いて読むだけ）
  ・レースが終わってからしか分からない情報（着順・タイム・上がり3F・通過順・
    賞金・脚質）を1つも持ち出さない ＝ 未来を見ない（リーク防止）

使い方: python jv_bridge/experiment_simple_rules_meta.py
出力  : data/jv_cache/experiment_simple_rules_meta.json
"""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

os.environ["PYTHONIOENCODING"] = "utf-8"
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
BETS = CACHE / "value_ev_bets.json"
RACES = CACHE / "races"
OUT = CACHE / "experiment_simple_rules_meta.json"

# 🚨 ここに載っていない馬の項目は「レース後にしか分からない」ので持ち出さない。
#    kakutei_jyuni / time / haron_l3 / haron_l4 / jyuni_1c..4c / honsyokin / kyakusitu は全部レース後。
HORSE_PRERACE = ("number", "frame", "sex_age", "weight", "body_weight",
                 "weight_diff", "jockey", "trainer", "prev_finish", "dm_jyuni", "blinker")

JYO = {"01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京",
       "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉"}


def _sex_age(s):
    """「牡3」→ ('牡', 3)。読めなければ (None, None)。"""
    if not isinstance(s, str) or not s:
        return None, None
    sex = s[0] if s[0] in "牡牝セせん騸" else None
    if sex in ("せ", "騸"):
        sex = "セ"
    digits = "".join(ch for ch in s if ch.isdigit())
    try:
        age = int(digits) if digits else None
    except ValueError:
        age = None
    return sex, age


def main() -> int:
    if not BETS.exists():
        print("[error] value_ev_bets.json が無い", flush=True)
        return 1
    recs = json.loads(BETS.read_text(encoding="utf-8"))
    rids = sorted({r["rid"] for r in recs})
    print(f"[info] per-bet {len(recs)}件 / レース {len(rids)}件 の条件を写し取ります", flush=True)

    out = {}
    missing = 0
    for rid in rids:
        f = RACES / f"{rid}.json"
        if not f.exists():
            missing += 1
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            missing += 1
            continue
        horses = d.get("horses") or []
        hs = {}
        for h in horses:
            n = h.get("number")
            if not isinstance(n, int):
                continue
            sex, age = _sex_age(h.get("sex_age"))
            rec = {k: h.get(k) for k in HORSE_PRERACE}
            rec["sex"] = sex
            rec["age"] = age
            hs[str(n)] = rec
        out[rid] = {
            "date": rid[:8],
            "jyo": JYO.get(rid[8:10], rid[8:10]),
            "race_no": int(rid[14:16]) if rid[14:16].isdigit() else None,
            "surface": d.get("surface"),
            "distance": d.get("distance"),
            "going": d.get("going"),
            "weather": d.get("weather"),
            "is_g1": bool(d.get("is_g1")),
            "grade": d.get("grade"),
            "field_size": len(hs),
            "horses": hs,
        }

    OUT.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"[OK] {OUT.name} に {len(out)} レース保存（見つからなかった {missing} レース）", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
