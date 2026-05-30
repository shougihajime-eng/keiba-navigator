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

# 必殺一号艇の予想思想を移植した「正直な期待値 + 4段階判定」エンジン
sys.path.insert(0, str(Path(__file__).resolve().parent))
from honest_ev import honest_ev, judge_race, TIER_ORDER, TIER_LABEL  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
RACES = CACHE / "races"
PREDS = CACHE / "predictions"
RESULTS = CACHE / "results"
SIGNALS = CACHE / "signals"
OUT = CACHE / "race_card_latest.json"


def _signal_odds_moves(rid: str) -> dict:
    """signals/<rid>.json から、最初に付いた本物オッズと最新オッズを比べて
    急変した馬を返す。戻り値: {馬番: 変化率%}  (マイナス=下がった=お金が入った)"""
    hist = _load(SIGNALS / f"{rid}.json")
    if not isinstance(hist, list) or len(hist) < 2:
        return {}
    first: dict = {}
    last: dict = {}
    for snap in hist:
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
    moves = {}
    for n, o0 in first.items():
        o1 = last.get(n)
        if o1 and o0 and o1 != o0:
            moves[n] = round((o1 - o0) / o0 * 100, 1)
    return moves


def _race_facts(rid: str, horses_raw: dict) -> list:
    """「人が見落としがちな硬い事実」を 1 レースぶん集める。
    予想には混ぜない。参考メモとして画面に出すだけ (未検証)。"""
    facts = []
    moves = _signal_odds_moves(rid)
    for n, h in horses_raw.items():
        name = h.get("name")
        mv = moves.get(n)
        if mv is not None and mv <= -15:
            facts.append({"number": n, "name": name, "kind": "money_in",
                          "detail": f"直前にオッズが{abs(mv):.0f}%下がった"})
        elif mv is not None and mv >= 30:
            facts.append({"number": n, "name": name, "kind": "money_out",
                          "detail": f"直前にオッズが{mv:.0f}%上がった"})
        ij = str(h.get("ijyou_code") or "").strip()
        if ij in ("2", "3", "4"):
            facts.append({"number": n, "name": name, "kind": "scratch",
                          "detail": {"2": "取消", "3": "除外", "4": "中止"}[ij]})
        wd = h.get("weight_diff")
        # 現実の馬体重増減は最大でも 40kg 程度。それを超える値は壊れたデータなので無視。
        if isinstance(wd, int) and 16 <= abs(wd) <= 40:
            facts.append({"number": n, "name": name,
                          "kind": "weight_up" if wd > 0 else "weight_down",
                          "detail": f"馬体重{'+' if wd > 0 else ''}{wd}kg"})
        bl = h.get("blinker")
        if bl not in (None, "", "0", 0):
            facts.append({"number": n, "name": name, "kind": "blinker",
                          "detail": "ブリンカー着用"})
    order = {"money_in": 0, "scratch": 1, "weight_up": 2, "weight_down": 2,
             "money_out": 3, "blinker": 4}
    facts.sort(key=lambda f: order.get(f["kind"], 9))
    return facts[:6]


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


def _has_real_data(rid: str) -> bool:
    """そのレースが「本物のオッズ + AI予想」を持つか (空枠=出走前を除外するため)。"""
    pred = _load(PREDS / f"{rid}.json")
    if not pred or not any(h.get("win_prob") for h in (pred.get("horses") or [])):
        return False
    race = _load(RACES / f"{rid}.json")
    return bool(race and any(h.get("win_odds") for h in (race.get("horses") or [])))


def _pick_latest_real_date(all_ids: list[str]) -> str:
    """最新の「本物データ(オッズ+予想)が揃った開催日」を選ぶ。
    無ければ最大日付(出走前の空枠日)にフォールバック。
    → 開催当日にオッズが届けばその日・無ければ直近の確定日を自動表示。"""
    dates = sorted({rid[:8] for rid in all_ids}, reverse=True)
    for d in dates:
        for rid in (rid for rid in all_ids if rid.startswith(d)):
            if _has_real_data(rid):
                return d
    return dates[0] if dates else ""


def build_card(date8: str | None = None) -> dict:
    all_ids = [os.path.basename(f)[:-5] for f in glob.glob(str(RACES / "*.json"))]
    if not all_ids:
        return {"ok": False, "reason": "races なし", "races": []}
    if date8 is None:
        date8 = _pick_latest_real_date(all_ids)
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
            # 正直な期待値 = 生EVを過去の実回収率に合わせて冷ました値 (穴馬ほど強く冷ます)
            x["cooled_ev"] = honest_ev(x["ev"], x["odds"])

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

        # 必殺一号艇方式の4段階判定 (絶好機/勝負/様子見/見送り) + 一言理由 + 買い方
        judge = judge_race(horses)

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
            # 4段階判定 (tier: prime/bet/watch/skip)
            "tier": judge["tier"],
            "tier_label": judge["tier_label"],
            "reason": judge["reason"],
            "bet_style": judge["bet_style"],
            "best_honest_ev": judge["best_honest_ev"],
            # 旧UI互換 (買い候補のみ go、それ以外 skip)
            "verdict": "go" if judge["tier"] in ("prime", "bet") else "skip",
            # 「人が見落としがちな硬い事実」の参考メモ (未検証・予想には混ぜない)
            "facts": _race_facts(rid, dedup),
            "horses": horses,
        })

    # tier の強い順 → 同 tier 内は発走順(race_id)で安定ソート
    races_out.sort(key=lambda r: (TIER_ORDER.get(r.get("tier"), 9), r["race_id"]))

    # 日別の AI 本命成績 (正直なトラックレコード)
    settled = [r for r in races_out if r["has_result"] and r["top_number"] is not None]
    top1_win = sum(1 for r in settled if r["top_won"])
    top1_in3 = sum(1 for r in settled if r["top_in3"])
    # 4段階の件数サマリ (絶好機/勝負/様子見/見送り)
    tier_counts = {"prime": 0, "bet": 0, "watch": 0, "skip": 0}
    for r in races_out:
        tier_counts[r.get("tier", "skip")] = tier_counts.get(r.get("tier", "skip"), 0) + 1
    return {
        "ok": True,
        "date": date8,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "race_count": len(races_out),
        "settled_count": len(settled),
        "top1_win": top1_win,
        "top1_in3": top1_in3,
        "tier_counts": tier_counts,
        "races": races_out,
    }


def main():
    date8 = sys.argv[1] if len(sys.argv) > 1 else None
    card = build_card(date8)
    OUT.write_text(json.dumps(card, ensure_ascii=False), encoding="utf-8")
    n = card.get("race_count", 0)
    tc = card.get("tier_counts", {})
    print(
        f"[OK] {OUT.name}: 日={card.get('date')} レース={n} "
        f"絶好機={tc.get('prime',0)} 勝負={tc.get('bet',0)} "
        f"様子見={tc.get('watch',0)} 見送り={tc.get('skip',0)}",
        flush=True,
    )


if __name__ == "__main__":
    main()
