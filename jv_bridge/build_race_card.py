# -*- coding: utf-8 -*-
"""
build_race_card.py — 直近の開催日の「全レース・全頭」カードを 1 ファイルにまとめる。

予想 (predictions/<id>.json の win_prob/nopop_prob) と
レース (races/<id>.json の win_odds/人気/着順) と
結果 (results/<id>.json の確定) を馬番で結合し、
各馬に AI勝率・本物オッズ・正直な期待値(EV=AI勝率×オッズ)・判定 を付ける。

出力: data/jv_cache/race_card_latest.json  (API /api/race-card が返す)
正直方針: EV>=1.0 の馬だけ「買い候補」。それ以外は「見送り」。
          検証で+EV戦略は無いと確定済なので、過度な「買い」表示はしない。
"""
from __future__ import annotations
import glob, json, os, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
RACES = CACHE / "races"
PREDS = CACHE / "predictions"
RESULTS = CACHE / "results"
OUT = CACHE / "race_card_latest.json"


def _load(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _winner_number(result) -> int | None:
    if not result:
        return None
    tan = (result.get("payouts") or {}).get("tan")
    if isinstance(tan, dict) and tan.get("winner") is not None:
        try:
            return int(tan["winner"])
        except (TypeError, ValueError):
            pass
    for r in (result.get("results") or []):
        if r.get("rank") == 1 and r.get("number") is not None:
            try:
                return int(r["number"])
            except (TypeError, ValueError):
                pass
    return None


def build_card(date8: str | None = None) -> dict:
    all_ids = [os.path.basename(f)[:-5] for f in glob.glob(str(RACES / "*.json"))]
    if not all_ids:
        return {"ok": False, "reason": "races なし", "races": []}
    if date8 is None:
        date8 = sorted({rid[:8] for rid in all_ids})[-1]
    day_ids = sorted(rid for rid in all_ids if rid.startswith(date8))

    races_out = []
    for rid in day_ids:
        race = _load(RACES / f"{rid}.json")
        if not race or not race.get("horses"):
            continue
        pred = _load(PREDS / f"{rid}.json")
        result = _load(RESULTS / f"{rid}.json")
        winner = _winner_number(result)

        # 予想の馬番→確率マップ
        pmap = {}
        for h in ((pred or {}).get("horses") or []):
            n = h.get("number")
            if isinstance(n, int):
                pmap[n] = h

        # races ファイルは同一馬を複数回持つ既知バグあり → 馬番で重複除去。
        # 最も情報が揃った 1 件を採用 (オッズ有 > 人気>0 > 着順有 を優先)
        def _completeness(h):
            return (h.get("win_odds") is not None) * 4 + (1 if (h.get("popularity") or 0) > 0 else 0) * 2 + (1 if h.get("kakutei_jyuni") else 0)
        dedup = {}
        for h in race.get("horses") or []:
            n = h.get("number")
            if not isinstance(n, int):
                continue
            if n not in dedup or _completeness(h) > _completeness(dedup[n]):
                dedup[n] = h

        horses = []
        for n, h in dedup.items():
            ph = pmap.get(n, {})
            odds = h.get("win_odds")
            try:
                odds = float(odds) if odds is not None else None
            except (TypeError, ValueError):
                odds = None
            horses.append({
                "number": n,
                "name": h.get("name"),
                "win_prob": ph.get("win_prob"),
                "nopop_prob": ph.get("nopop_prob"),
                "odds": odds,
                "popularity": h.get("popularity"),
                "finish": h.get("kakutei_jyuni"),
                "won": 1 if (winner is not None and n == winner) else 0,
            })

        # レース内で確率を正規化 (表示用に和=1 へ) + 正直な期待値 EV=正規化勝率×オッズ
        sw = sum(x["win_prob"] for x in horses if x["win_prob"]) or 0.0
        sn = sum(x["nopop_prob"] for x in horses if x["nopop_prob"]) or 0.0
        for x in horses:
            x["win_prob"] = round(x["win_prob"] / sw, 4) if (sw and x["win_prob"]) else None
            x["nopop_prob"] = round(x["nopop_prob"] / sn, 4) if (sn and x["nopop_prob"]) else None
            x["ev"] = round(x["win_prob"] * x["odds"], 2) if (x["win_prob"] and x["odds"]) else None

        # AI勝率順に並べる (予想が無い馬は末尾)
        horses.sort(key=lambda x: (x["win_prob"] is None, -(x["win_prob"] or 0)))

        # AI本命 (勝率トップ) とその結果。検証で+EV戦略は無いため「買い」判定はしない。
        top = horses[0] if horses else None
        top_finish = top.get("finish") if top else None
        try:
            top_in3 = 1 if (top_finish is not None and 1 <= int(top_finish) <= 3) else 0
        except (TypeError, ValueError):
            top_in3 = 0
        top_won = top.get("won") if top else 0

        races_out.append({
            "race_id": rid,
            "race_name": race.get("race_name"),
            "course": race.get("course"),
            "surface": race.get("surface"),
            "distance": race.get("distance"),
            "going": race.get("going"),
            "weather": race.get("weather"),
            "is_g1": bool(race.get("is_g1")),
            "horse_count": len(horses),
            "has_result": winner is not None,
            "winner_number": winner,
            "top_number": top.get("number") if top else None,
            "top_name": top.get("name") if top else None,
            "top_prob": top.get("win_prob") if top else None,
            "top_odds": top.get("odds") if top else None,
            "top_finish": top_finish,
            "top_in3": top_in3,
            "top_won": top_won,
            # 検証で+EV戦略は無いと確定 → 全レース「見送り」が正直な判定
            "verdict": "skip",
            "horses": horses,
        })

    # 日別の AI 本命成績 (正直なトラックレコード)
    settled = [r for r in races_out if r["has_result"] and r["top_number"] is not None]
    top1_win = sum(1 for r in settled if r["top_won"])
    top1_in3 = sum(1 for r in settled if r["top_in3"])
    return {
        "ok": True,
        "date": date8,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "race_count": len(races_out),
        "settled_count": len(settled),
        "top1_win": top1_win,
        "top1_in3": top1_in3,
        "races": races_out,
    }


def main():
    date8 = sys.argv[1] if len(sys.argv) > 1 else None
    card = build_card(date8)
    OUT.write_text(json.dumps(card, ensure_ascii=False), encoding="utf-8")
    n = card.get("race_count", 0)
    buys = sum(1 for r in card.get("races", []) if r["verdict"] == "buy")
    print(f"[OK] {OUT.name}: 日={card.get('date')} レース={n} 買い候補レース={buys}", flush=True)


if __name__ == "__main__":
    main()
