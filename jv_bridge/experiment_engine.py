#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
experiment_engine.py — 「自己成長する実験モード」の心臓部

コンセプト (ユーザー指示 2026-05-30):
  使えば使うほど自然に学習・成長していくアプリ。世の中の成功例を取り入れて試し、
  いけそうなら採用・ダメなら自己学習して直す。本物の機能は壊さず実験モードで併存。

このエンジンがやること:
  1. リークなし(未来を見ない)の per-bet キャッシュ value_ev_bets.json を読む
     (= walk_forward_value_ev.py が各期間を「過去だけで学習」して作った正直なデータ)
  2. いくつかの「作戦(戦略)」で “紙の上で買ったつもり” にする (お金は使わない)
  3. 本物の結果で自己採点 → 作戦ごとの回収率・的中率・紙上収支カーブを出す
  4. 回収率の良い順に作戦を自動ランキング (champion = 一番成績の良い作戦)
  5. 正直に表示 (100%未満なら「まだ勝ててません」と分かるようにフラグを立てる)
  6. 成長ログ snapshot を追記 (実行のたびに台帳が更新され、データが増えれば数字も育つ)

出力: data/jv_cache/experiment_status.json  (アプリが読む正直な成績表)
      data/jv_cache/experiment_history.json (成長の足あと・実行ごとの snapshot)

再評価のたびに値が更新される = これ自体が「自己成長ループ」。
週末ごとに walk_forward_value_ev.py → experiment_engine.py を回せば賢くなる。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from datetime import datetime, timezone

os.environ["PYTHONIOENCODING"] = "utf-8"
for _a in ("stdout", "stderr"):
    _s = getattr(sys, _a, None)
    if _s is not None:
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

CACHE = Path(__file__).resolve().parent.parent / "data" / "jv_cache"
RESULTS = CACHE / "results"
BETS = CACHE / "value_ev_bets.json"
OUT = CACHE / "experiment_status.json"
HIST = CACHE / "experiment_history.json"

START_BANKROLL = 10000  # 紙上の元手 1万円
UNIT = 100              # 1点100円


# ---------------------------------------------------------------------------
# 作戦(戦略)の定義
#   各作戦は「どのレースのどの馬を、どの券種で買うか」を決める関数。
#   field: tan_pay(単勝の払戻) か fuku_pay(複勝の払戻)
#   世の中の成功例から取り入れた候補を中心に、正直に全部並べて競わせる。
# ---------------------------------------------------------------------------
def _top1_map(recs):
    """各レースで補正nopop勝率が最大の馬番。"""
    best = {}
    for r in recs:
        cur = best.get(r["rid"])
        if cur is None or r["p_nopop"] > cur[1]:
            best[r["rid"]] = (r["number"], r["p_nopop"])
    return {rid: num for rid, (num, _) in best.items()}


def build_strategies(recs):
    top1 = _top1_map(recs)

    def is_top1(r):
        return top1.get(r["rid"]) == r["number"]

    strategies = [
        # --- 世の中の成功例ベース (単勝・実力派AI一番手) ---
        {"key": "tansho_top1", "name": "単勝・実力派AIの本命",
         "desc": "実力派AIが一番強いと見た馬を毎レース単勝で買う",
         "field": "tan_pay", "origin": "世の中の成功例",
         "pred": lambda r: is_top1(r)},
        {"key": "tansho_top1_odds5", "name": "単勝・本命・オッズ5倍以上",
         "desc": "実力派AI本命のうち、配当が5倍以上のときだけ単勝で買う",
         "field": "tan_pay", "origin": "世の中の成功例",
         "pred": lambda r: is_top1(r) and r["odds"] is not None and r["odds"] >= 5.0},
        {"key": "tansho_top1_odds10", "name": "単勝・本命・オッズ10倍以上",
         "desc": "実力派AI本命のうち、配当が10倍以上の中穴だけ単勝で買う",
         "field": "tan_pay", "origin": "世の中の成功例",
         "pred": lambda r: is_top1(r) and r["odds"] is not None and r["odds"] >= 10.0},
        {"key": "tansho_conf20", "name": "単勝・本命・自信20%以上",
         "desc": "実力派AI本命のうち、勝てる自信が20%以上のときだけ単勝",
         "field": "tan_pay", "origin": "世の中の成功例",
         "pred": lambda r: is_top1(r) and r["p_nopop"] >= 0.20},
        # --- 価値投資(期待値) ---
        {"key": "value_ev110", "name": "単勝・お得な馬(期待値1.1以上)",
         "desc": "補正した勝率×配当=期待値が1.1以上の馬を単勝で買う",
         "field": "tan_pay", "origin": "価値投資",
         "pred": lambda r: r["odds"] is not None and r["p_nopop"] * r["odds"] >= 1.10},
        {"key": "value_ev120_mid", "name": "単勝・お得な中穴(期待値1.2/5-50倍)",
         "desc": "期待値1.2以上かつ配当5〜50倍のお得な中穴を単勝で買う",
         "field": "tan_pay", "origin": "価値投資",
         "pred": lambda r: r["odds"] is not None and 5.0 <= r["odds"] <= 50.0 and r["p_nopop"] * r["odds"] >= 1.20},
        # --- 2026-06-04 のしらみつぶし再探索で見つけた「損益分岐に最も近い帯」。
        #     1番人気なのにAIの補正期待値も高い=市場とAIの意見が一致した堅い馬だけ単勝。
        #     発見時点: EV1.05+ 回収94.7%(127件) / EV1.15+ 99.5%(85件)・どちらも3/6期間勝ち。
        #     件数が少ないので断定せず、データが増えるたびここで自動採点して観察する。
        {"key": "fav1_ev105", "name": "単勝・1番人気でAI期待値1.05以上",
         "desc": "市場1番人気かつAIの補正期待値1.05以上の馬だけ単勝(市場とAIの意見一致)",
         "field": "tan_pay", "origin": "価値投資",
         "pred": lambda r: r["popularity"] == 1 and r["odds"] is not None and r["p_nopop"] * r["odds"] >= 1.05},
        {"key": "fav1_ev115", "name": "単勝・1番人気でAI期待値1.15以上(厳選)",
         "desc": "1番人気かつAI補正期待値1.15以上に厳選した単勝。発見時99.5%で損益分岐に最接近",
         "field": "tan_pay", "origin": "価値投資",
         "pred": lambda r: r["popularity"] == 1 and r["odds"] is not None and r["p_nopop"] * r["odds"] >= 1.15},
        # --- 複勝(手堅い) ---
        {"key": "fuku_top1", "name": "複勝・実力派AIの本命",
         "desc": "実力派AI本命を複勝(3着以内)で手堅く買う",
         "field": "fuku_pay", "origin": "手堅い",
         "pred": lambda r: is_top1(r)},
        {"key": "fuku_value120", "name": "複勝・お得な馬(期待値1.2以上)",
         "desc": "期待値1.2以上の馬を複勝で手堅く買う",
         "field": "fuku_pay", "origin": "手堅い",
         "pred": lambda r: r["odds"] is not None and r["p_nopop"] * r["odds"] >= 1.20},
        # --- 穴狙い (世の中の「AIが推す人気薄」を狙う工夫) ---
        {"key": "ana_top1_pop5", "name": "単勝・AI本命なのに人気薄(5番人気以下)",
         "desc": "実力派AIが本命にしたのに世間は5番人気以下=市場が見落とした穴を単勝で狙う",
         "field": "tan_pay", "origin": "穴狙い",
         "pred": lambda r: is_top1(r) and r["popularity"] and r["popularity"] >= 5},
        {"key": "ana_top1_pop5_fuku", "name": "複勝・AI本命なのに人気薄(5番人気以下)",
         "desc": "同じ穴馬を複勝で手堅めに(3着以内で当たり)",
         "field": "fuku_pay", "origin": "穴狙い",
         "pred": lambda r: is_top1(r) and r["popularity"] and r["popularity"] >= 5},
        # --- 食い違い (AIの評価と市場の評価が大きくズレた馬) ---
        {"key": "gap_top1_pop3", "name": "単勝・AI本命×市場は3番人気以下",
         "desc": "AIは一番手なのに市場は3番人気以下=評価のズレが中くらいの馬を単勝",
         "field": "tan_pay", "origin": "食い違い",
         "pred": lambda r: is_top1(r) and r["popularity"] and r["popularity"] >= 3},
        # --- 手堅い (市場の人気上位を複勝で) ---
        {"key": "fav123_fuku", "name": "複勝・1〜3番人気をすべて (ものさし)",
         "desc": "市場の上位人気3頭をまとめて複勝で買う鉄板狙い。AIは使わない比較用の基準",
         "field": "fuku_pay", "origin": "ものさし",
         "pred": lambda r: r["popularity"] and r["popularity"] <= 3},
        {"key": "fuku_top1_conf25", "name": "複勝・AI本命・自信25%以上(厳選)",
         "desc": "AI本命のうち特に自信が高い(25%以上)レースだけ複勝で厳選",
         "field": "fuku_pay", "origin": "手堅い",
         "pred": lambda r: is_top1(r) and r["p_nopop"] >= 0.25},
        # --- ものさし(市場のベタ買い) ---
        {"key": "fav1_tansho", "name": "単勝・1番人気ベタ買い (ものさし)",
         "desc": "毎レース1番人気を単勝で買うだけ。AIと比べるための基準",
         "field": "tan_pay", "origin": "ものさし",
         "pred": lambda r: r["popularity"] == 1},
        {"key": "fav1_fuku", "name": "複勝・1番人気ベタ買い (ものさし)",
         "desc": "毎レース1番人気を複勝で買うだけ。手堅い基準",
         "field": "fuku_pay", "origin": "ものさし",
         "pred": lambda r: r["popularity"] == 1},
    ]
    return strategies


# ---------------------------------------------------------------------------
# 採点
# ---------------------------------------------------------------------------
def score_strategy(recs, strat, periods):
    field = strat["field"]
    pred = strat["pred"]
    inv = ret = bets = hits = 0
    by_period = {}
    # 紙上の収支カーブ (時系列順 = rid 昇順)
    bankroll = START_BANKROLL
    curve = []
    last_rid = None
    for r in sorted(recs, key=lambda x: (x["rid"], x["number"])):
        if not pred(r):
            continue
        pay = r.get(field) or 0
        inv += UNIT
        ret += pay
        bets += 1
        if pay > 0:
            hits += 1
        bankroll += pay - UNIT
        p = r["period"]
        by_period.setdefault(p, [0, 0])
        by_period[p][0] += UNIT
        by_period[p][1] += pay
        # 50ベットごとに収支カーブの点を打つ (描画用に間引き)
        if bets % 50 == 0:
            curve.append(round(bankroll))
    curve.append(round(bankroll))

    period_rois = []
    for p in sorted(by_period):
        i, rr = by_period[p]
        period_rois.append(round(rr / i * 100, 1) if i else None)
    valid = [x for x in period_rois if x is not None]
    roi = round(ret / inv * 100, 1) if inv else None
    return {
        "key": strat["key"],
        "name": strat["name"],
        "desc": strat["desc"],
        "origin": strat["origin"],
        "bet_type": "単勝" if field == "tan_pay" else "複勝",
        "bets": bets,
        "hit_rate_pct": round(hits / bets * 100, 1) if bets else None,
        "roi_pct": roi,
        "profit_yen": ret - inv,
        "win_periods": sum(1 for x in valid if x >= 100),
        "active_periods": len(valid),
        "period_rois": period_rois,
        "bankroll_curve": curve,
        "is_winning": bool(roi is not None and roi >= 100),
    }


# ---------------------------------------------------------------------------
# 連系の券種 (馬連・ワイド・3連複) を AI 上位馬で組む作戦
#   value_ev_bets.json はリークなしの予想(p_nopop)を馬ごとに持つ。
#   各レースの結果ファイル results/<rid>.json から本物の連系払戻を引いて採点する。
# ---------------------------------------------------------------------------
def _key_to_set(key):
    """'11-12' / '4-7-12' -> {11,12} / {4,7,12}"""
    try:
        return frozenset(int(x) for x in str(key).split("-") if x != "")
    except (TypeError, ValueError):
        return frozenset()


def _load_combo_payouts(rids):
    """rid -> {uren:(set,amount), wide:[(set,amount)...], fuku3:(set,amount)}"""
    out = {}
    for rid in rids:
        f = RESULTS / f"{rid}.json"
        if not f.exists():
            continue
        try:
            p = (json.loads(f.read_text(encoding="utf-8")).get("payouts") or {})
        except Exception:
            continue
        entry = {"uren": None, "wide": [], "fuku3": None}
        u = p.get("uren")
        if isinstance(u, dict) and u.get("key"):
            try:
                entry["uren"] = (_key_to_set(u["key"]), int(u.get("amount") or 0))
            except (TypeError, ValueError):
                pass
        for w in (p.get("wide") or []):
            if isinstance(w, dict) and w.get("key"):
                try:
                    entry["wide"].append((_key_to_set(w["key"]), int(w.get("amount") or 0)))
                except (TypeError, ValueError):
                    pass
        f3 = p.get("fuku3")
        if isinstance(f3, dict) and f3.get("key"):
            try:
                entry["fuku3"] = (_key_to_set(f3["key"]), int(f3.get("amount") or 0))
            except (TypeError, ValueError):
                pass
        out[rid] = entry
    return out


def _ranked_by_nopop(recs):
    """rid -> [馬番...] を補正nopop勝率の高い順に。"""
    by_rid = {}
    for r in recs:
        by_rid.setdefault(r["rid"], []).append((r["p_nopop"], r["number"]))
    ranked = {}
    for rid, lst in by_rid.items():
        lst.sort(key=lambda x: (x[0], -x[1]), reverse=True)
        ranked[rid] = [num for _, num in lst]
    return ranked


def _wide_pay(wide_list, pair):
    """ワイドの payout: pair(frozenset) に一致する組の amount。無ければ 0。"""
    best = 0
    for s, amt in wide_list:
        if s == pair:
            best = max(best, amt)
    return best


def score_combo(recs, combo_pay, ranked, period_of, kind):
    """連系作戦を 1 レース単位で採点。score_strategy と同じ形の dict を返す。
    kind: 'uren' | 'wide_box3' | 'fuku3_box3'
    """
    defs = {
        "uren": {
            "key": "uren_top12", "name": "馬連・AIの上位2頭",
            "desc": "実力派AIの1番手と2番手で馬連を1点買う",
            "bet_type": "馬連", "need": 2, "tickets": 1, "origin": "連系を試す",
        },
        "wide_box3": {
            "key": "wide_box_top3", "name": "ワイド・AI上位3頭ボックス",
            "desc": "実力派AIの上位3頭から3組のワイドを買う(手堅め)",
            "bet_type": "ワイド", "need": 3, "tickets": 3, "origin": "連系を試す",
        },
        "fuku3_box3": {
            "key": "fuku3_box_top3", "name": "3連複・AI上位3頭ボックス",
            "desc": "実力派AIの上位3頭で3連複を1点買う(大きく狙う)",
            "bet_type": "3連複", "need": 3, "tickets": 1, "origin": "連系を試す",
        },
    }
    d = defs[kind]
    inv = ret = bets = hits = 0
    by_period = {}
    bankroll = START_BANKROLL
    curve = []
    for rid in sorted(ranked):
        order = ranked[rid]
        if len(order) < d["need"]:
            continue
        pay = combo_pay.get(rid)
        if pay is None:
            continue
        per = period_of.get(rid)
        if per is None:
            continue
        race_inv = 0
        race_ret = 0
        if kind == "uren":
            pair = frozenset(order[:2])
            race_inv = UNIT
            up = pay.get("uren")
            won = bool(up and up[0] == pair)
            race_ret = up[1] if won else 0
            bets += 1
            if won:
                hits += 1
        elif kind == "wide_box3":
            top3 = order[:3]
            pairs = [frozenset((top3[0], top3[1])),
                     frozenset((top3[0], top3[2])),
                     frozenset((top3[1], top3[2]))]
            for pr in pairs:
                race_inv += UNIT
                amt = _wide_pay(pay.get("wide") or [], pr)
                race_ret += amt
                bets += 1
                if amt > 0:
                    hits += 1
        elif kind == "fuku3_box3":
            trio = frozenset(order[:3])
            race_inv = UNIT
            fp = pay.get("fuku3")
            won = bool(fp and fp[0] == trio)
            race_ret = fp[1] if won else 0
            bets += 1
            if won:
                hits += 1
        inv += race_inv
        ret += race_ret
        bankroll += race_ret - race_inv
        by_period.setdefault(per, [0, 0])
        by_period[per][0] += race_inv
        by_period[per][1] += race_ret
        if bets and bets % 50 == 0:
            curve.append(round(bankroll))
    curve.append(round(bankroll))

    period_rois = []
    for per in sorted(by_period):
        i, rr = by_period[per]
        period_rois.append(round(rr / i * 100, 1) if i else None)
    valid = [x for x in period_rois if x is not None]
    roi = round(ret / inv * 100, 1) if inv else None
    return {
        "key": d["key"], "name": d["name"], "desc": d["desc"], "origin": d["origin"],
        "bet_type": d["bet_type"],
        "bets": bets,
        "hit_rate_pct": round(hits / bets * 100, 1) if bets else None,
        "roi_pct": roi,
        "profit_yen": ret - inv,
        "win_periods": sum(1 for x in valid if x >= 100),
        "active_periods": len(valid),
        "period_rois": period_rois,
        "bankroll_curve": curve,
        "is_winning": bool(roi is not None and roi >= 100),
    }


def main():
    if not BETS.exists():
        print(f"[NG] {BETS.name} が無い。先に walk_forward_value_ev.py を実行してください。", flush=True)
        return 1
    recs = json.loads(BETS.read_text(encoding="utf-8"))
    # odds/p_nopop が無いレコードは捨てる
    recs = [r for r in recs if r.get("p_nopop") is not None]
    periods = sorted({r["period"] for r in recs})

    strategies = build_strategies(recs)
    scored = [score_strategy(recs, s, periods) for s in strategies]

    # --- 連系の券種 (馬連・ワイド・3連複) を追加 ---
    period_of = {r["rid"]: r["period"] for r in recs}
    ranked = _ranked_by_nopop(recs)
    combo_pay = _load_combo_payouts(list(ranked.keys()))
    for kind in ("uren", "wide_box3", "fuku3_box3"):
        try:
            scored.append(score_combo(recs, combo_pay, ranked, period_of, kind))
        except Exception as e:
            print(f"[warn] combo {kind} 採点失敗: {e}", flush=True)
    # 回収率の高い順 (None は最後)
    scored.sort(key=lambda s: (s["roi_pct"] is not None, s["roi_pct"] or 0), reverse=True)

    # 首位(champion)は「AIの作戦」だけから選ぶ。
    # origin=="ものさし"(1番人気ベタ買い等)は比較用の基準なので首位にしない
    # = 「AIより単なる人気買いが上」という誤解を防ぐ。表示はする。
    ai_strategies = [s for s in scored if s["origin"] != "ものさし"]
    champion = ai_strategies[0] if ai_strategies else (scored[0] if scored else None)
    any_winning = any(s["is_winning"] and s["bets"] >= 100 for s in ai_strategies)

    # ものさしの最上位 (AI と比べるための基準値)
    ruler = next((s for s in scored if s["origin"] == "ものさし"), None)

    # 正直なひとこと
    if any_winning:
        headline = "実験中: AIの作戦で100%を超えたものが出ています(まだ過去データ上の話・継続観察中)"
    else:
        best_roi = champion["roi_pct"] if champion else None
        ruler_note = ""
        if ruler and ruler["roi_pct"] is not None:
            ruler_note = f" / 比較用の1番人気ベタ買いは{ruler['roi_pct']}%"
        headline = (f"実験中: AIの一番良い作戦でも回収率 {best_roi}% "
                    f"(まだ勝てる買い方は見つかっていません・正直に観察を続けます){ruler_note}")

    out = {
        "ok": True,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "leakage_free": True,
        "method": "未来を見ない週ごと再学習(walk-forward)で紙上ベットを自己採点",
        "total_bet_records": len(recs),
        "periods": len(periods),
        "start_bankroll": START_BANKROLL,
        "unit_yen": UNIT,
        "any_winning_strategy": any_winning,
        "headline": headline,
        "champion_key": champion["key"] if champion else None,
        "strategies": scored,
        "note": ("これは“紙の上で買ったつもり”の実験です。実際のお金は使いません。"
                 "未来のレース結果を一切見ずに採点しているので、表示の回収率は正直な見込みです。"
                 "データが増えるたびに数字は更新され、作戦は自動で並び替わります。"),
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    # --- 成長ログに snapshot を追記 ---
    hist = {"version": 1, "snapshots": []}
    if HIST.exists():
        try:
            hist = json.loads(HIST.read_text(encoding="utf-8"))
        except Exception:
            pass
    hist.setdefault("snapshots", [])
    hist["snapshots"].append({
        "at": out["updated_at"],
        "records": len(recs),
        "champion": champion["key"] if champion else None,
        "champion_roi": champion["roi_pct"] if champion else None,
        "any_winning": any_winning,
    })
    hist["snapshots"] = hist["snapshots"][-200:]  # 直近200回だけ保持
    hist["version"] = 1
    HIST.write_text(json.dumps(hist, ensure_ascii=False, indent=2), encoding="utf-8")

    # --- コンソール表示 ---
    print(f"=== 自己成長 実験モード 採点結果 ({len(recs)}件・{len(periods)}期間・リークなし) ===\n")
    print(f"{'作戦':<34}{'券種':>5}{'回収率':>8}{'的中':>7}{'勝期間':>8}{'買い':>7}")
    print("-" * 78)
    for s in scored:
        roi = f"{s['roi_pct']}%" if s["roi_pct"] is not None else "—"
        hr = f"{s['hit_rate_pct']}%" if s["hit_rate_pct"] is not None else "—"
        wp = f"{s['win_periods']}/{s['active_periods']}"
        star = " ★" if s["is_winning"] and s["bets"] >= 100 else ""
        print(f"{s['name']:<34}{s['bet_type']:>5}{roi:>8}{hr:>7}{wp:>8}{s['bets']:>7}{star}")
    print(f"\n{headline}")
    print(f"[OK] {OUT.name} / {HIST.name} を書き出しました。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
