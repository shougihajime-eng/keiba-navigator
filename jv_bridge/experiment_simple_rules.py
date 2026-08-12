# -*- coding: utf-8 -*-
"""
experiment_simple_rules.py — 「ものさし(1番人気の複勝ベタ買い 84.9%)に勝てる単純な買い方」を
                             リークなしで総当たりに探す（オフライン実験・本番未配線）

★このファイルの立場
  見つけるのが目的ではなく、**幻を1つも通さないのが目的**。
  このプロジェクトは 99.5% / 244% / 308% の「勝てる買い方」を何度も掴んでは
  リーク・過適合と分かって捨ててきた。だから最初から、幻を殺すための道具を全部入れる。

★幻を殺すための7つの関門（1つでも落ちたら「見つかった」と言わない）
  1. リークなし   … レース後にしか分からない情報を使わない／期間で分ける
  2. 200件以上    … 少ないものは「少なすぎ」と書いて捨てる
  3. 回収率 > 84.9%
  4. レース単位ブートストラップの95%の幅の下限も 84.9% を超える
  5. いちばん大きい当たりを1回抜いても まだ 84.9% を超える
  6. 期間べつで一貫している（良い期間だけで持ち上がっていない）
  7. 前半4期間で見つけて、後半2期間（一度も見ていない）でも生きている

★さらに「たくさん試したこと」自体の補正（多重比較）
  何千通り試せば、中身が空っぽでも1つくらい良い数字が出る。
  だから White の Reality Check（データスヌーピング検定）を回す：
    ・観測値 V   = max_k（その買い方の回収率 − ものさしの回収率）
    ・帰無分布   = 同じレースを resample して max_k（ブレ分）の分布
    ・p値        = 「全部ただの運」でも V 以上が出てしまう確率
  ブートストラップは **全部の買い方で同じ resample を使う**（共通乱数）＝
  買い方どうしが似ていることを正しく扱う。

★絶対にしないこと
  ・本番の予想・おすすめ・EV計算・画面に触らない（このファイルは結果を出すだけ）
  ・races/ results/ を書き換えない（下ごしらえ済みスナップショットを読むだけ）
  ・レース後の情報（着順・タイム・上がり・通過順・賞金・脚質）を選ぶ条件に使わない

使い方: python jv_bridge/experiment_simple_rules.py
       （先に experiment_simple_rules_meta.py を1回走らせておくこと）
"""
from __future__ import annotations

import io
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

os.environ["PYTHONIOENCODING"] = "utf-8"
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
BETS = CACHE / "value_ev_bets.json"
META = CACHE / "experiment_simple_rules_meta.json"
OUT = CACHE / "experiment_simple_rules.json"

YARDSTICK = 84.9          # ものさし＝1番人気の複勝ベタ買い（実運用645Rの実測）
MIN_BETS = 200            # 関門2
BOOT = 4000               # ブートストラップ回数
SEED = 20260812
DISCOVERY = (1, 2, 3, 4)  # 前半＝ここで探す
CONFIRM = (5, 6)          # 後半＝最後まで見ない


# ============================================================================
# 1. データを読む
# ============================================================================
def load():
    recs = json.loads(BETS.read_text(encoding="utf-8"))
    meta = json.loads(META.read_text(encoding="utf-8"))
    byrace = defaultdict(list)
    for r in recs:
        byrace[r["rid"]].append(r)

    races = []
    for rid in sorted(byrace):
        m = meta.get(rid)
        if not m:
            continue
        bets = byrace[rid]
        # モデルが一番推す馬（同点は馬番の小さい方＝毎回同じ答えになるように）
        top1 = min(bets, key=lambda b: (-(b.get("p_nopop") or 0.0), b["number"]))["number"]
        horses = []
        for b in bets:
            hm = (m.get("horses") or {}).get(str(b["number"])) or {}
            wd = hm.get("weight_diff")
            horses.append({
                "n": b["number"],
                "pop": b.get("popularity"),
                "odds": b.get("odds"),
                "tan": float(b.get("tan_pay") or 0.0),
                "fuku": float(b.get("fuku_pay") or 0.0),
                "won": int(b.get("won") or 0),
                "is_top1": b["number"] == top1,
                "dm": hm.get("dm_jyuni"),
                "frame": hm.get("frame"),
                "sex": hm.get("sex"),
                "age": hm.get("age"),
                "kin": hm.get("weight"),          # 斤量
                "bw": hm.get("body_weight"),      # 馬体重
                "wd": wd if isinstance(wd, (int, float)) else None,
            })
        races.append({
            "rid": rid,
            "period": bets[0]["period"],
            "date": m["date"],
            "month": int(m["date"][4:6]),
            "jyo": m["jyo"],
            "race_no": m["race_no"],
            "surface": m["surface"],
            "distance": m["distance"],
            "going": m["going"],
            "weather": m["weather"],
            "is_g1": m["is_g1"],
            "grade": m["grade"],
            "field": len(bets),
            "horses": horses,
        })
    return races


# ============================================================================
# 2. 買い方の部品（base = どの馬を買うか / filt = どんなレース・馬に限るか）
# ============================================================================
def make_bases():
    """1レースの中で「どの馬を買うか」を返す関数たち。返すのは馬のリスト。"""
    B = []

    def add(name, fn):
        B.append((name, fn))

    # --- 人気ちょうど ---
    for k in range(1, 11):
        add(f"{k}番人気", (lambda k: lambda R: [h for h in R["horses"] if h["pop"] == k])(k))
    # --- 人気の帯（複数買い） ---
    for lo, hi in [(1, 2), (1, 3), (2, 3), (2, 4), (3, 5), (4, 6), (5, 8), (7, 12), (2, 5)]:
        add(f"{lo}〜{hi}番人気を全部",
            (lambda lo, hi: lambda R: [h for h in R["horses"] if h["pop"] and lo <= h["pop"] <= hi])(lo, hi))
    # --- オッズの帯 ---
    for lo, hi in [(1.0, 1.5), (1.5, 2.0), (2.0, 2.5), (2.5, 3.0), (3.0, 4.0), (4.0, 5.0),
                   (5.0, 7.0), (7.0, 10.0), (10.0, 15.0), (15.0, 25.0), (25.0, 50.0), (50.0, 9999.0),
                   (1.0, 2.0), (1.0, 3.0), (2.0, 4.0)]:
        add(f"単勝{lo:g}〜{hi:g}倍の馬を全部",
            (lambda lo, hi: lambda R: [h for h in R["horses"]
                                       if h["odds"] is not None and lo <= h["odds"] < hi])(lo, hi))
    # --- AIの本命 ---
    add("AIの本命(1頭)", lambda R: [h for h in R["horses"] if h["is_top1"]])
    add("AIの本命 かつ 1番人気", lambda R: [h for h in R["horses"] if h["is_top1"] and h["pop"] == 1])
    add("AIの本命 だが 1番人気ではない", lambda R: [h for h in R["horses"] if h["is_top1"] and h["pop"] != 1])
    add("1番人気 だが AIの本命ではない", lambda R: [h for h in R["horses"] if h["pop"] == 1 and not h["is_top1"]])
    # --- JRA-VANの予想印(DM) …レース前に出る公式の予想順位 ---
    add("DM1位(1頭)", lambda R: [h for h in R["horses"] if h["dm"] == 1])
    add("DM1位 かつ 1番人気", lambda R: [h for h in R["horses"] if h["dm"] == 1 and h["pop"] == 1])
    add("DM1位 だが 1番人気ではない", lambda R: [h for h in R["horses"] if h["dm"] == 1 and h["pop"] != 1])
    add("1番人気 かつ DM1位ではない", lambda R: [h for h in R["horses"] if h["pop"] == 1 and h["dm"] != 1])
    add("DM1〜3位を全部", lambda R: [h for h in R["horses"] if h["dm"] in (1, 2, 3)])
    # --- 枠 ---
    add("1枠を全部", lambda R: [h for h in R["horses"] if h["frame"] == 1])
    add("8枠を全部", lambda R: [h for h in R["horses"] if h["frame"] == 8])
    add("内枠(1〜3枠)を全部", lambda R: [h for h in R["horses"] if h["frame"] in (1, 2, 3)])
    return B


def make_filters():
    """「このレース／この馬のときだけ買う」条件。(名前, 関数(レース, 馬)->bool)"""
    F = [("しぼらない", lambda R, h: True)]

    def add(name, fn):
        F.append((name, fn))

    # レースの条件
    add("芝", lambda R, h: R["surface"] == "芝")
    add("ダート", lambda R, h: R["surface"] == "ダート")
    add("障害", lambda R, h: R["surface"] == "障害")
    for lo, hi, lab in [(0, 1200, "短距離(〜1200m)"), (1201, 1600, "マイル(1201〜1600m)"),
                        (1601, 2000, "中距離(1601〜2000m)"), (2001, 2400, "中長(2001〜2400m)"),
                        (2401, 9999, "長距離(2401m〜)")]:
        add(lab, (lambda lo, hi: lambda R, h: R["distance"] and lo <= R["distance"] <= hi)(lo, hi))
    add("良馬場", lambda R, h: R["going"] == "良")
    add("稍重", lambda R, h: R["going"] == "稍重")
    add("道悪(重・不良)", lambda R, h: R["going"] in ("重", "不良"))
    add("良馬場ではない", lambda R, h: R["going"] is not None and R["going"] != "良")
    add("晴れ", lambda R, h: R["weather"] == "晴")
    add("曇り", lambda R, h: R["weather"] == "曇")
    add("雨（小雨ふくむ）", lambda R, h: R["weather"] in ("雨", "小雨"))
    for lo, hi, lab in [(0, 9, "少頭数(〜9頭)"), (10, 13, "10〜13頭"), (14, 16, "14〜16頭"),
                        (17, 99, "多頭数(17頭〜)"), (0, 12, "12頭以下"), (13, 99, "13頭以上")]:
        add(lab, (lambda lo, hi: lambda R, h: lo <= R["field"] <= hi)(lo, hi))
    add("G1", lambda R, h: R["is_g1"])
    add("重賞(グレードあり)", lambda R, h: bool(R["grade"]))
    add("平場(グレードなし)", lambda R, h: not R["grade"])
    for j in ["札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"]:
        add(f"{j}競馬場", (lambda j: lambda R, h: R["jyo"] == j)(j))
    add("前半(1〜5R)", lambda R, h: R["race_no"] and R["race_no"] <= 5)
    add("中盤(6〜9R)", lambda R, h: R["race_no"] and 6 <= R["race_no"] <= 9)
    add("後半(10R〜)", lambda R, h: R["race_no"] and R["race_no"] >= 10)
    add("春(3〜5月)", lambda R, h: R["month"] in (3, 4, 5))
    add("夏(6〜8月)", lambda R, h: R["month"] in (6, 7, 8))
    add("秋(9〜11月)", lambda R, h: R["month"] in (9, 10, 11))
    add("冬(12〜2月)", lambda R, h: R["month"] in (12, 1, 2))
    # 買う馬そのものの条件
    add("牡馬", lambda R, h: h["sex"] == "牡")
    add("牝馬", lambda R, h: h["sex"] == "牝")
    add("3歳以下", lambda R, h: h["age"] is not None and h["age"] <= 3)
    add("4歳", lambda R, h: h["age"] == 4)
    add("5歳以上", lambda R, h: h["age"] is not None and h["age"] >= 5)
    add("馬体重プラス", lambda R, h: h["wd"] is not None and h["wd"] > 0)
    add("馬体重マイナス", lambda R, h: h["wd"] is not None and h["wd"] < 0)
    add("馬体重かわらず", lambda R, h: h["wd"] == 0)
    add("大型馬(480kg以上)", lambda R, h: h["bw"] is not None and h["bw"] >= 480)
    add("小型馬(480kg未満)", lambda R, h: h["bw"] is not None and 0 < h["bw"] < 480)
    add("斤量57kg以上", lambda R, h: h["kin"] is not None and h["kin"] >= 57)
    add("斤量54kg以下", lambda R, h: h["kin"] is not None and h["kin"] <= 54)
    add("内枠(1〜3枠)の馬", lambda R, h: h["frame"] in (1, 2, 3))
    add("外枠(6〜8枠)の馬", lambda R, h: h["frame"] in (6, 7, 8))
    add("単勝2.0倍未満", lambda R, h: h["odds"] is not None and h["odds"] < 2.0)
    add("単勝2.0〜3.5倍", lambda R, h: h["odds"] is not None and 2.0 <= h["odds"] < 3.5)
    add("単勝3.5倍以上", lambda R, h: h["odds"] is not None and h["odds"] >= 3.5)
    add("単勝5.0倍以上", lambda R, h: h["odds"] is not None and h["odds"] >= 5.0)
    return F


# ============================================================================
# 3. 買い方を1つずつ「レースごとの 賭け金 / 払戻」の並びに変える
# ============================================================================
def build_matrices(races, specs):
    """specs = [(名前, base関数, filt関数, 券種)] → 賭け金行列 S, 払戻行列 P（specs × レース）"""
    n = len(races)
    k = len(specs)
    S = np.zeros((k, n), dtype=np.float32)
    P = np.zeros((k, n), dtype=np.float32)
    maxpay = np.zeros(k, dtype=np.float32)      # いちばん大きい当たり1本
    for si, (_, base, filt, kind) in enumerate(specs):
        mx = 0.0
        for ri, R in enumerate(races):
            picks = base(R)
            if not picks:
                continue
            stake = 0.0
            pay = 0.0
            for h in picks:
                try:
                    if not filt(R, h):
                        continue
                except Exception:
                    continue
                stake += 100.0
                p = h[kind]
                pay += p
                if p > mx:
                    mx = p
            if stake:
                S[si, ri] = stake
                P[si, ri] = pay
        maxpay[si] = mx
    return S, P, maxpay


def roi_of(S, P, mask=None):
    if mask is None:
        s = S.sum(axis=1)
        p = P.sum(axis=1)
    else:
        s = S[:, mask].sum(axis=1)
        p = P[:, mask].sum(axis=1)
    out = np.full(len(s), np.nan, dtype=np.float64)
    ok = s > 0
    out[ok] = p[ok] / s[ok] * 100.0
    return out, s


# ============================================================================
# 4. 本体
# ============================================================================
def main() -> int:
    if not META.exists():
        print("[error] 先に experiment_simple_rules_meta.py を走らせてください", flush=True)
        return 1
    races = load()

    # ---- にせデータで走らせる（プラセボ検査） ------------------------------
    # 「この道具は、中身が空っぽのデータからでも“勝てる買い方”をひねり出してしまうのでは？」
    # を確かめる。各レースの中で払戻を馬どうしシャッフルする＝
    # オッズ・人気・枠・性別… どれとも関係が無いデータになる。
    # ここで p が小さく出るなら、道具そのものが幻を作っている＝本番の結果も信じられない。
    placebo = "--placebo" in sys.argv
    if placebo:
        prng = np.random.default_rng(SEED + 999)
        for R in races:
            pays = [(h["tan"], h["fuku"], h["won"]) for h in R["horses"]]
            order = prng.permutation(len(pays))
            for h, oi in zip(R["horses"], order):
                h["tan"], h["fuku"], h["won"] = pays[oi]
        print("[PLACEBO] 各レースの中で払戻をシャッフルしました（本物の関係は消えています）", flush=True)

    n = len(races)
    periods = np.array([R["period"] for R in races])
    print(f"[info] {n} レース / 期間 {sorted(set(periods.tolist()))} "
          f"/ {races[0]['date']} 〜 {races[-1]['date']}", flush=True)

    # ---- ものさし（1番人気の複勝）を同じデータでも計算しておく ----
    fav_stake = np.zeros(n, dtype=np.float32)
    fav_pay = np.zeros(n, dtype=np.float32)
    for ri, R in enumerate(races):
        f = [h for h in R["horses"] if h["pop"] == 1]
        if f:
            fav_stake[ri] = 100.0
            fav_pay[ri] = f[0]["fuku"]
    fav_roi_all = fav_pay.sum() / fav_stake.sum() * 100
    print(f"[info] 同じデータでの ものさし(1番人気の複勝) = {fav_roi_all:.2f}%  "
          f"（実運用645Rの実測は {YARDSTICK}%）", flush=True)

    # ---- 買い方を全部つくる ----
    bases = make_bases()
    filts = make_filters()
    specs = []
    for bname, bfn in bases:
        for fname, ffn in filts:
            for kind, klab in (("tan", "単勝"), ("fuku", "複勝")):
                specs.append((f"{klab}／{bname}／{fname}", bfn, ffn, kind))
    n_stage_a = len(specs)

    # ---- 追加：ものさし(1番人気の複勝)を2条件のANDで絞る＝「見送り」研究 ----
    fi = [(fn, ff) for fn, ff in filts if fn != "しぼらない"]
    fav_base = [b for b in bases if b[0] == "1番人気"][0][1]
    for i in range(len(fi)):
        for j in range(i + 1, len(fi)):
            (n1, f1), (n2, f2) = fi[i], fi[j]
            specs.append((f"複勝／1番人気／{n1} かつ {n2}",
                          fav_base,
                          (lambda f1, f2: lambda R, h: f1(R, h) and f2(R, h))(f1, f2),
                          "fuku"))
    n_total = len(specs)
    print(f"[info] 試す買い方＝{n_total} 通り "
          f"（1条件しぼり {n_stage_a} + 2条件AND {n_total - n_stage_a}）", flush=True)

    print("[info] 集計中…", flush=True)
    S, P, maxpay = build_matrices(races, specs)
    roi_all, stake_all = roi_of(S, P)
    bets_all = (S.sum(axis=1) / 100.0).astype(int)

    # ---- 関門2: 200件以上だけを「家族」として扱う ----
    fam = np.where(bets_all >= MIN_BETS)[0]
    print(f"[info] うち 200件以上あるのは {len(fam)} 通り "
          f"（{n_total - len(fam)} 通りは件数が少なすぎるので最初から捨てる）", flush=True)

    # ---- ブートストラップ（レース単位・全部の買い方で同じ resample＝共通乱数） ----
    print(f"[info] レース単位ブートストラップ {BOOT} 回…", flush=True)
    rng = np.random.default_rng(SEED)
    Sf = S[fam]
    Pf = P[fam]
    Mf = (Sf > 0).astype(np.float32)                    # そのレースを使うか
    BPf = Mf * fav_pay[None, :]                          # 同じレースでの ものさしの払戻
    BSf = Mf * fav_stake[None, :]                        # 同じレースでの ものさしの賭け金

    boot_roi = np.zeros((len(fam), BOOT), dtype=np.float32)
    boot_bench = np.zeros((len(fam), BOOT), dtype=np.float32)
    CH = 500
    for a in range(0, BOOT, CH):
        b = min(a + CH, BOOT)
        C = rng.multinomial(n, np.full(n, 1.0 / n), size=(b - a)).T.astype(np.float32)  # (n, chunk)
        ps = Pf @ C
        ss = Sf @ C
        bp = BPf @ C
        bs = BSf @ C
        with np.errstate(divide="ignore", invalid="ignore"):
            boot_roi[:, a:b] = np.where(ss > 0, ps / ss * 100.0, np.nan)
            boot_bench[:, a:b] = np.where(bs > 0, bp / bs * 100.0, np.nan)

    lo95 = np.nanpercentile(boot_roi, 2.5, axis=1)
    hi95 = np.nanpercentile(boot_roi, 97.5, axis=1)

    # 同じレースでのものさしとの差（ペア比較）
    bench_paired = np.divide(BPf.sum(axis=1), BSf.sum(axis=1),
                             out=np.full(len(fam), np.nan), where=BSf.sum(axis=1) > 0) * 100.0
    diff_obs = roi_all[fam] - bench_paired
    boot_diff = boot_roi - boot_bench
    diff_lo = np.nanpercentile(boot_diff, 2.5, axis=1)
    diff_hi = np.nanpercentile(boot_diff, 97.5, axis=1)

    # ---- White の Reality Check（たくさん試したことの補正） ----
    centered = boot_diff - diff_obs[:, None]
    V_null = np.nanmax(centered, axis=0)
    V_obs = float(np.nanmax(diff_obs))
    p_rc = float(np.mean(V_null >= V_obs))

    # 84.9% を絶対の壁として見た版
    diff_abs = roi_all[fam] - YARDSTICK
    centered_abs = (boot_roi - roi_all[fam][:, None])
    V_null_abs = np.nanmax(centered_abs, axis=0)
    V_obs_abs = float(np.nanmax(diff_abs))
    p_rc_abs = float(np.mean(V_null_abs >= V_obs_abs))

    # ---- Hansen の SPA（ブレの大きさで割る＝studentize） ----
    # 素の Reality Check は「ブレの大きい買い方（人気薄の単勝）」に引っぱられて
    # 帰無分布がやたら広くなり、**ブレの小さい買い方（本命の複勝）を見落とす**。
    # そこで各買い方を自分のブレで割ってから max を取る（＝同じものさしで比べる）。
    sd = np.nanstd(boot_diff, axis=1)
    sd = np.where(sd > 1e-9, sd, np.nan)
    t_obs_arr = diff_obs / sd
    t_obs = float(np.nanmax(t_obs_arr))
    t_null = np.nanmax(centered / sd[:, None], axis=0)
    p_spa = float(np.mean(t_null >= t_obs))
    best_t = int(np.nanargmax(t_obs_arr))

    sd_abs = np.nanstd(boot_roi, axis=1)
    sd_abs = np.where(sd_abs > 1e-9, sd_abs, np.nan)
    t_obs_abs_arr = diff_abs / sd_abs
    t_obs_abs = float(np.nanmax(t_obs_abs_arr))
    t_null_abs = np.nanmax(centered_abs / sd_abs[:, None], axis=0)
    p_spa_abs = float(np.mean(t_null_abs >= t_obs_abs))
    best_t_abs = int(np.nanargmax(t_obs_abs_arr))
    # 家族ごとの棄却の壁（95%点）を超えた買い方を全部あげる
    crit = float(np.nanpercentile(t_null_abs, 95))
    spa_winners = [int(i) for i in np.where(t_obs_abs_arr > crit)[0]]

    # ---- 期間べつ ----
    per_ids = sorted(set(periods.tolist()))
    per_roi = {}
    for p in per_ids:
        m = periods == p
        r, _ = roi_of(S[fam], P[fam], m)
        per_roi[p] = r
    dmask = np.isin(periods, DISCOVERY)
    cmask = np.isin(periods, CONFIRM)
    roi_d, stake_d = roi_of(S[fam], P[fam], dmask)
    roi_c, stake_c = roi_of(S[fam], P[fam], cmask)
    bets_d = (stake_d / 100).astype(int)
    bets_c = (stake_c / 100).astype(int)

    # ---- 大当たり1本抜き ----
    tot_pay = P[fam].sum(axis=1)
    tot_stake = S[fam].sum(axis=1)
    drop = np.divide(tot_pay - maxpay[fam], np.maximum(tot_stake - 100, 1e-9)) * 100.0

    # ---- 7つの関門で判定 ----
    rows = []
    for i, gi in enumerate(fam):
        name = specs[gi][0]
        pr = [float(per_roi[p][i]) if np.isfinite(per_roi[p][i]) else None for p in per_ids]
        pr_ok = [x for x in pr if x is not None]
        rows.append({
            "name": name,
            "bets": int(bets_all[gi]),
            "roi": round(float(roi_all[gi]), 2),
            "ci95": [round(float(lo95[i]), 2), round(float(hi95[i]), 2)],
            "vs_bench_same_races": round(float(diff_obs[i]), 2),
            "vs_bench_ci95": [round(float(diff_lo[i]), 2), round(float(diff_hi[i]), 2)],
            "drop_top_hit_roi": round(float(drop[i]), 2),
            "period_roi": [None if x is None else round(x, 1) for x in pr],
            "periods_over_yardstick": sum(1 for x in pr_ok if x > YARDSTICK),
            "periods_active": len(pr_ok),
            "discovery_roi": round(float(roi_d[i]), 2) if np.isfinite(roi_d[i]) else None,
            "discovery_bets": int(bets_d[i]),
            "confirm_roi": round(float(roi_c[i]), 2) if np.isfinite(roi_c[i]) else None,
            "confirm_bets": int(bets_c[i]),
            "gate2_size": bool(bets_all[gi] >= MIN_BETS),
            "gate3_beats": bool(roi_all[gi] > YARDSTICK),
            "gate4_ci_lower": bool(lo95[i] > YARDSTICK),
            "gate5_drop_top": bool(drop[i] > YARDSTICK),
            "gate6_consistent": bool(len(pr_ok) >= 5 and sum(1 for x in pr_ok if x > YARDSTICK) >= len(pr_ok) - 1),
            "gate7_confirm": bool(np.isfinite(roi_c[i]) and roi_c[i] > YARDSTICK and bets_c[i] >= 50),
        })
    for r in rows:
        r["gates_passed"] = sum(1 for k in ("gate2_size", "gate3_beats", "gate4_ci_lower",
                                            "gate5_drop_top", "gate6_consistent", "gate7_confirm") if r[k])
        r["all_gates"] = r["gates_passed"] == 6

    rows.sort(key=lambda r: -r["roi"])

    # ---- 前半だけで選んで後半で確かめる（本物の out-of-sample） ----
    disc = [r for r in rows if r["discovery_bets"] >= 150 and r["discovery_roi"] is not None]
    disc.sort(key=lambda r: -r["discovery_roi"])
    top_disc = disc[:20]
    kept = [r for r in top_disc if r["confirm_bets"] >= 50]
    surv = [r for r in kept if r["confirm_roi"] and r["confirm_roi"] > YARDSTICK]

    # ============================ 表示 ============================
    W = 96
    print("\n" + "=" * W)
    print(f"◆ 総当たりの結果（{n_total} 通り試した／{len(fam)} 通りが200件以上）")
    print("=" * W)
    print(f"{'買い方':<52}{'件数':>7}{'回収率':>8}{'95%の幅':>17}{'大当抜':>8}")
    print("-" * W)
    for r in rows[:25]:
        ci = f"[{r['ci95'][0]:.0f}〜{r['ci95'][1]:.0f}]"
        print(f"{r['name'][:52]:<52}{r['bets']:>7}{r['roi']:>7.1f}%{ci:>17}{r['drop_top_hit_roi']:>7.1f}%")

    print("\n【関門をいくつ抜けたか】")
    cnt = defaultdict(int)
    for r in rows:
        cnt[r["gates_passed"]] += 1
    for g in sorted(cnt, reverse=True):
        print(f"  {g}/6 の関門を抜けた買い方: {cnt[g]} 通り")
    allpass = [r for r in rows if r["all_gates"]]
    print(f"  ★7つ全部（リークなしを含む）を満たした買い方: {len(allpass)} 通り")
    for r in allpass[:10]:
        print(f"     - {r['name']}  {r['roi']}%  n={r['bets']}")

    print("\n【たくさん試したことの補正（White の Reality Check）】")
    print(f"  いちばん良かった買い方の「ものさし超え」= {V_obs:+.2f}pt（同じレースでのペア比較）")
    print(f"  中身が空っぽでも運だけでこれ以上出る確率 p = {p_rc:.3f}"
          f"  → {'運では説明できない' if p_rc < 0.05 else '運で十分説明できる＝幻の可能性が高い'}")
    print(f"  （84.9%を絶対の壁とした版： 最大 {V_obs_abs:+.2f}pt / p = {p_rc_abs:.3f}）")
    print("  ※この素の検定は「ブレの大きい人気薄の単勝」に引っぱられて鈍い。下の SPA が本命。")

    print("\n【ブレの大きさでそろえた補正（Hansen の SPA）】")
    print(f"  いちばん強かった: {specs[fam[best_t_abs]][0]}")
    print(f"    回収率 {roi_all[fam[best_t_abs]]:.1f}% / n={bets_all[fam[best_t_abs]]} / "
          f"ものさし超え {diff_abs[best_t_abs]:+.1f}pt / t値 {t_obs_abs:.2f}")
    print(f"  7,231通り試したことを込みにした棄却の壁（t値）= {crit:.2f}")
    print(f"  p = {p_spa_abs:.4f} → "
          f"{'★運では説明できない＝本物の可能性が高い' if p_spa_abs < 0.05 else '運で説明できる＝幻の可能性が高い'}")
    print(f"  （同じレースでのペア比較版： t={t_obs:.2f} / p={p_spa:.4f}）")
    print(f"  壁を越えた買い方は {len(spa_winners)} 通り：")
    for i in sorted(spa_winners, key=lambda i: -t_obs_abs_arr[i])[:15]:
        print(f"     t={t_obs_abs_arr[i]:5.2f}  {specs[fam[i]][0][:60]}  "
              f"{roi_all[fam[i]]:.1f}%  n={bets_all[fam[i]]}")

    print("\n" + "=" * W)
    print("◆ 前半4期間で選んで、後半2期間（一度も見ていない）で確かめる")
    print("=" * W)
    print(f"{'前半で良かった買い方':<52}{'前半':>9}{'後半':>9}{'後半n':>7}")
    print("-" * W)
    for r in top_disc[:15]:
        c = f"{r['confirm_roi']:.1f}%" if r["confirm_roi"] is not None else "—"
        print(f"{r['name'][:52]:<52}{r['discovery_roi']:>8.1f}%{c:>9}{r['confirm_bets']:>7}")
    print(f"\n  前半トップ20のうち、後半でも {YARDSTICK}% を超えたのは {len(surv)}/{len(kept)} 通り")
    if kept:
        med = float(np.median([r["confirm_roi"] for r in kept]))
        print(f"  前半トップ20の後半での回収率の中央値: {med:.1f}%"
              f"（ものさし {YARDSTICK}% / 同データのものさし {fav_roi_all:.1f}%）")

    # ---- 見送りの効果（1番人気の複勝を、条件で絞ったら） ----
    print("\n" + "=" * W)
    print("◆「見送り」＝1番人気の複勝を、どこを買わずに済ませると損が減るか")
    print("=" * W)
    fav_rows = [r for r in rows if r["name"].startswith("複勝／1番人気／") and "かつ" not in r["name"]]
    fav_rows.sort(key=lambda r: -r["roi"])
    print(f"{'買う場面':<40}{'件数':>7}{'回収率':>8}{'損(円)':>10}{'後半':>8}")
    print("-" * W)
    base_loss = int(fav_stake.sum() - fav_pay.sum())
    print(f"{'（全部買う＝ものさし）':<40}{int(fav_stake.sum()/100):>7}{fav_roi_all:>7.1f}%{-base_loss:>10}{'':>8}")
    for r in fav_rows[:12]:
        loss = int(r["bets"] * 100 * (1 - r["roi"] / 100))
        c = f"{r['confirm_roi']:.1f}%" if r["confirm_roi"] is not None else "—"
        lab = r["name"].replace("複勝／1番人気／", "")
        print(f"{lab[:40]:<40}{r['bets']:>7}{r['roi']:>7.1f}%{-loss:>10}{c:>8}")

    payload = {
        "note": "オフライン実験・本番未配線。ものさし(1番人気の複勝84.9%)に勝てる単純な買い方を総当たりで探した。",
        "races": n, "date_from": races[0]["date"], "date_to": races[-1]["date"],
        "yardstick": YARDSTICK, "yardstick_same_data": round(float(fav_roi_all), 2),
        "specs_tried": n_total, "specs_with_enough_bets": int(len(fam)),
        "bootstrap": BOOT, "seed": SEED,
        "reality_check": {"best_excess_pt": round(V_obs, 2), "p_value": round(p_rc, 4),
                          "best_excess_vs_849_pt": round(V_obs_abs, 2), "p_value_vs_849": round(p_rc_abs, 4)},
        "spa_studentized": {
            "best_spec": specs[fam[best_t_abs]][0],
            "best_roi": round(float(roi_all[fam[best_t_abs]]), 2),
            "best_bets": int(bets_all[fam[best_t_abs]]),
            "t_obs": round(t_obs_abs, 3), "critical_t_95": round(crit, 3),
            "p_value": round(p_spa_abs, 4),
            "p_value_paired": round(p_spa, 4),
            "winners": [{"name": specs[fam[i]][0], "roi": round(float(roi_all[fam[i]]), 2),
                         "bets": int(bets_all[fam[i]]), "t": round(float(t_obs_abs_arr[i]), 3)}
                        for i in sorted(spa_winners, key=lambda i: -t_obs_abs_arr[i])],
        },
        "all_gates_passed": [r["name"] for r in allpass],
        "top25_by_roi": rows[:25],
        "discovery_top20_then_confirm": top_disc,
        "confirm_survivors": len(surv), "confirm_tested": len(kept),
        "fav_fuku_slices": fav_rows[:30],
    }
    if placebo:
        globals()['OUT'] = CACHE / "experiment_simple_rules_PLACEBO.json"
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[OK] {OUT.name} 保存（本番未配線）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
