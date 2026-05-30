# -*- coding: utf-8 -*-
"""
honest_ev.py — 「必殺一号艇」の予想思想を競馬に移植した正直な期待値&判定エンジン。

必殺一号艇(競艇アプリ)で効いていた 3 本柱を、競馬の実測データに合わせて移植:

  1. 期待値の冷まし (ev-calibration の移植)
     AI が「100円が120円になる(EV=1.20)」と強気に出しても、過去に同じような馬を
     実際に買うと平均いくら戻ったか(実回収率)に数字を冷ます。
     競馬の検証 (data/jv_cache/value_ev_result.json / 8ヶ月 3593レース) では、
     どの買い方をしても実回収率は約 67〜81% だった。特に「穴馬(高オッズ)」ほど
     市場に買われ過ぎ(favorite-longshot bias)で、生 EV の過大評価がひどい。
     → オッズ帯ごとに冷まし倍率をかけ、人気薄ほど強く冷ます。

  2. 構造フィルタ (強制見送り条件の移植)
     競艇が「強風・進入入替・展示が悪い」で機械的に見送ったのと同じ発想で、
     競馬は「上位が横並びで荒れそう」「本命が過剰人気で配当が安すぎ」を見送る。

  3. 4 段階のハッキリした判定 + 一言理由
     絶好機 / 勝負 / 様子見 / 見送り を色とアイコンで分け、各レースに
     「なぜ買うか / なぜ見送るか」を一言で添える。

【正直な前提】競馬は何億円もの賭け金でオッズが決まり市場がとても賢いため、
「必ず儲かる買い方」は存在しない(検証で確定済)。このエンジンの価値は利益の保証
ではなく、ムダな赤字を減らす「買わない判断の質」と「一目で分かる見やすさ」。
"""
from __future__ import annotations
from typing import Optional


# ---------------------------------------------------------------------------
# 1. 期待値の冷まし
# ---------------------------------------------------------------------------
# オッズ帯ごとの冷まし倍率。生 EV にこれを掛けて「正直な期待値」にする。
# 値は value_ev_result.json の実回収率から逆算:
#   - 人気1番ベタ買い(低オッズ)        実回収 約77%
#   - 中穴(オッズ5-50) EV>=1.1          実回収 約81% (一番マシな帯)
#   - 全オッズ込み(大穴含む) EV>=1.0    実回収 約71%、EV高いほど更に悪化
# → 中オッズが最もマシ、大穴は罠、過剰人気は配当が安いという実測の形に合わせる。
_COOL_BANDS = [
    (1.5, 0.75),    # オッズ ~1.5未満: 堅い人気馬。配当は安いが実績は比較的マシ
    (3.0, 0.74),    # 1.5-3倍
    (7.0, 0.76),    # 3-7倍: 手堅い妙味ゾーン
    (15.0, 0.74),   # 7-15倍: 中オッズ(実測で一番マシ)
    (30.0, 0.66),   # 15-30倍: ここから過大評価が増える
    (70.0, 0.55),   # 30-70倍: 穴。市場に買われ過ぎ
    (float("inf"), 0.42),  # 70倍超: 大穴は罠。強く冷ます
]


def cool_factor(odds: Optional[float]) -> float:
    """オッズに応じた冷まし倍率を返す。オッズ不明なら中間的な 0.70。"""
    if odds is None or odds <= 1.0:
        return 0.70
    for ceil, f in _COOL_BANDS:
        if odds < ceil:
            return f
    return 0.42


def honest_ev(raw_ev: Optional[float], odds: Optional[float]) -> Optional[float]:
    """生 EV(=AI勝率×オッズ)を実績ベースに冷ました「正直な期待値」。

    100円が平均で何円に戻るかの“現実的な”見込み。1.00 を超えれば理論上お買い得だが、
    競馬では市場が賢いためほぼ 1.00 未満に冷える(=お買い得は基本無い)のが正直な結果。
    """
    if raw_ev is None:
        return None
    return round(raw_ev * cool_factor(odds), 2)


# ---------------------------------------------------------------------------
# 2. 構造フィルタ + 3. 4段階判定
# ---------------------------------------------------------------------------
# tier の意味(必殺一号艇の go/conditional/pass を競馬向けに4段階化):
#   prime  絶好機 … AIが妙味ありと判断した稀なレース(それでも小額で)
#   bet    勝負  … 本命が抜けて堅い。買うなら複勝でここ(損を抑えやすい)
#   watch  様子見 … 本命は堅めだが妙味が薄い。見るだけ推奨
#   skip   見送り … 荒れ模様 / 過剰人気 / お買い得なし。買わない
TIER_PRIME = "prime"
TIER_BET = "bet"
TIER_WATCH = "watch"
TIER_SKIP = "skip"

TIER_LABEL = {
    TIER_PRIME: "絶好機",
    TIER_BET: "勝負",
    TIER_WATCH: "様子見",
    TIER_SKIP: "見送り",
}
# 並び順(強い順)
TIER_ORDER = {TIER_PRIME: 0, TIER_BET: 1, TIER_WATCH: 2, TIER_SKIP: 3}


def _fmt_horse(num, name) -> str:
    name = (name or "").strip()
    if num is None:
        return name or "本命"
    return f"{num}番{(' ' + name) if name else ''}"


def judge_race(horses: list[dict]) -> dict:
    """1レースの全頭(正規化済 win_prob と odds を持つ dict のリスト)から
    tier / 一言理由 / おすすめの買い方 を判定して返す。

    各馬 dict が想定するキー: number, name, win_prob(レース内正規化済), odds
    返り値: {"tier", "tier_label", "reason", "bet_style", "best_honest_ev"}
    """
    # オッズと勝率が揃った馬だけを判定対象に
    usable = [
        h for h in horses
        if h.get("win_prob") is not None and h.get("odds") is not None and h["odds"] > 1.0
    ]
    if not usable:
        return {
            "tier": TIER_SKIP, "tier_label": TIER_LABEL[TIER_SKIP],
            "reason": "出走馬かオッズの配信待ち", "bet_style": None, "best_honest_ev": None,
        }

    # AI勝率の高い順
    by_prob = sorted(usable, key=lambda h: -(h["win_prob"] or 0))
    top = by_prob[0]
    second = by_prob[1] if len(by_prob) > 1 else None
    top_prob = top["win_prob"] or 0.0
    second_prob = (second["win_prob"] or 0.0) if second else 0.0
    gap = top_prob - second_prob
    top_odds = top["odds"]
    top_label = _fmt_horse(top.get("number"), top.get("name"))

    # 各馬の正直な期待値。ただし大穴(70倍超)は罠なので tier を引き上げる根拠には使わない
    # (入力 dict は書き換えず、判定用に値だけ計算する)
    best_hev = None
    for h in usable:
        if (h.get("odds") or 0) > 70.0:
            continue
        hev = honest_ev(
            (h["win_prob"] * h["odds"]) if (h.get("win_prob") and h.get("odds")) else None,
            h.get("odds"),
        )
        if hev is not None and (best_hev is None or hev > best_hev):
            best_hev = hev

    # しきい値は過去10開催・360レースの実測で較正:
    #   本命勝率0.20+ → 実際に本命が3着内70%・1着39% (抜けて堅い)
    #   本命勝率0.16-0.20 → 3着内61% (堅め)
    #   本命勝率0.13-0.16 → 3着内51% (五分)
    #   本命勝率0.13未満  → 3着内37-50% (狙いとして弱い)
    #   gap(本命と2番手の差)0.04+ → 3着内70%前後 (本命が抜けている)

    # --- 構造フィルタ(必殺の強制見送り条件に相当) ---
    # 過剰人気: 本命のオッズが安すぎる = 当たっても配当の妙味がない
    if top_odds is not None and top_odds < 1.8:
        return {
            "tier": TIER_SKIP, "tier_label": TIER_LABEL[TIER_SKIP],
            "reason": f"本命{top_label}が人気すぎて配当が安く、妙味なし",
            "bet_style": None, "best_honest_ev": best_hev,
        }
    # 荒れ模様: 抜けた本命が居ない(勝率が低い) or 上位が横並び = 狙いを絞れない
    if top_prob < 0.13 or gap < 0.015:
        return {
            "tier": TIER_SKIP, "tier_label": TIER_LABEL[TIER_SKIP],
            "reason": "上位が横並びで荒れそう・狙いを絞れない",
            "bet_style": None, "best_honest_ev": best_hev,
        }

    # --- 4段階の本判定 ---
    reliable = top_prob >= 0.20 and gap >= 0.03  # 本命が抜けて堅い(3着内 約72%)
    # 絶好機: 本命が堅い かつ 冷まし後でも理論上お買い得(0.95+)が残る稀なレース
    if reliable and gap >= 0.04 and best_hev is not None and best_hev >= 0.95:
        return {
            "tier": TIER_PRIME, "tier_label": TIER_LABEL[TIER_PRIME],
            "reason": f"本命{top_label}が堅く、冷まし後も妙味が残る稀なレース（それでも小額で）",
            "bet_style": "複勝で手堅く（万一に備え小額で）", "best_honest_ev": best_hev,
        }
    # 勝負: 本命が抜けて堅い。買うなら複勝で損を抑える(3着内に来やすい)
    if reliable:
        return {
            "tier": TIER_BET, "tier_label": TIER_LABEL[TIER_BET],
            "reason": f"本命{top_label}が抜けて堅い・買うなら複勝向き（3着内に来やすい）",
            "bet_style": "複勝（当たりやすく損を抑えやすい）", "best_honest_ev": best_hev,
        }
    # 様子見: 本命は堅めだが抜けてはいない
    if top_prob >= 0.16:
        return {
            "tier": TIER_WATCH, "tier_label": TIER_LABEL[TIER_WATCH],
            "reason": f"本命{top_label}は堅めだが抜けてはいない・見るだけ推奨",
            "bet_style": None, "best_honest_ev": best_hev,
        }
    # 見送り: 五分の評価でお買い得なし
    return {
        "tier": TIER_SKIP, "tier_label": TIER_LABEL[TIER_SKIP],
        "reason": "評価が五分で狙いを絞れない・お買い得なし",
        "bet_style": None, "best_honest_ev": best_hev,
    }


if __name__ == "__main__":
    # 簡易自己テスト
    samples = [
        ("過剰人気の本命", [
            {"number": 1, "name": "A", "win_prob": 0.55, "odds": 1.4},
            {"number": 2, "name": "B", "win_prob": 0.20, "odds": 6.0},
        ]),
        ("抜けて堅い本命(勝負)", [
            {"number": 3, "name": "C", "win_prob": 0.34, "odds": 3.2},
            {"number": 4, "name": "D", "win_prob": 0.18, "odds": 6.0},
            {"number": 5, "name": "E", "win_prob": 0.12, "odds": 9.0},
        ]),
        ("横並びで荒れ(見送り)", [
            {"number": 6, "name": "F", "win_prob": 0.16, "odds": 5.0},
            {"number": 7, "name": "G", "win_prob": 0.15, "odds": 5.5},
            {"number": 8, "name": "H", "win_prob": 0.14, "odds": 6.0},
        ]),
        ("様子見", [
            {"number": 9, "name": "I", "win_prob": 0.24, "odds": 4.0},
            {"number": 10, "name": "J", "win_prob": 0.15, "odds": 6.0},
        ]),
    ]
    print("cool_factor(8.0)=", cool_factor(8.0), " honest_ev(1.10, 8.0)=", honest_ev(1.10, 8.0))
    for label, hs in samples:
        # レース内正規化
        s = sum(h["win_prob"] for h in hs)
        for h in hs:
            h["win_prob"] = round(h["win_prob"] / s, 4)
        r = judge_race(hs)
        print(f"[{label}] -> {r['tier_label']} / {r['reason']}")
