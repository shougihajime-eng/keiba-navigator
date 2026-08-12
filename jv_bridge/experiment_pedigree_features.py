# -*- coding: utf-8 -*-
"""
experiment_pedigree_features.py — 血統の「きめ細かい使い方」を作る（実験専用・本番未配線）

★ここは特徴を作るだけ。判定（お金で効くか）は experiment_pedigree_roi.py が行う。
★実装は1つだけ。ROI実験はこのファイルの関数を import して使う（同じ計算を2か所に書かない）。

作る特徴（ぜんぶ「そのレースより前」だけで数える＝リークなし）
  父（種牡馬）  … 全体 / 馬場べつ(芝・ダート・障害) / 距離帯べつ / 馬場状態べつ(良・道悪)
  母父（BMS）   … 全体 / 馬場べつ
  それぞれ「勝率」と「3着内率(複勝率)」と「何走ぶんの実績か」の3つ。

なぜ「なめらか化(縮約)」するか
  既存 experiment_sire_feature.py は「20走未満は全部リーグ平均に置きかえ」という
  かたい線引きをしている。これだと19走と20走で値が飛ぶし、
  「500走の父」と「21走の父」を同じ重さで信じてしまう。
  そこで  率 = (実績 + K×リーグ平均) / (走数 + K)   の形にする（K=25走ぶんの重み）。
  走数0なら自動でリーグ平均、走数が増えるほど実績そのものに近づく＝なめらか。
  あわせて log(走数) も渡して「どれくらい信じてよい数字か」をモデルに教える。

⚠ 着順は races/*.json の kakutei_jyuni を使う（4,337レース全部で results/ の1着馬と一致・食い違い0で確認ずみ）。
⚠ ijyou_code が "0" 以外（取消・除外など）の馬は走っていないので数に入れない。
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
RACES = CACHE / "races"
PED_MAP = CACHE / "experiment_pedigree_map.json"

K_SHRINK = 25.0     # なめらか化の重み（何走ぶんのリーグ平均を混ぜるか）

# 特徴の名前（この順で数字が並ぶ）
FEATURE_NAMES = [
    "f_win", "f_pl", "f_ln",        # 父 ぜんたい
    "fs_win", "fs_pl", "fs_ln",     # 父 × 馬場（芝/ダート/障害）
    "fd_win", "fd_pl", "fd_ln",     # 父 × 距離帯
    "fg_win", "fg_pl", "fg_ln",     # 父 × 馬場状態（良/道悪）
    "b_win", "b_pl", "b_ln",        # 母父 ぜんたい
    "bs_win", "bs_pl", "bs_ln",     # 母父 × 馬場
]


def _load(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_pedigree_map():
    """experiment_pedigree_map.py が作った血統マップを読む。"""
    d = _load(PED_MAP)
    if not d:
        raise SystemExit(
            f"[error] {PED_MAP.name} が無い。先に "
            f"<64bit python> jv_bridge/experiment_pedigree_map.py を実行する。")
    return d.get("pedigree") or {}, d.get("names") or {}


def surface_of(race) -> str:
    s = race.get("surface")
    if s in ("障害",):
        return "jump"
    if s in ("ダート", "dirt") or race.get("is_dirt"):
        return "dirt"
    return "turf"


def dist_bin_of(race) -> str:
    d = race.get("distance")
    if not isinstance(d, int) or d <= 0:
        return "na"
    if d <= 1400:
        return "sprint"      # 短距離
    if d <= 1800:
        return "mile"        # マイル
    if d <= 2200:
        return "mid"         # 中距離
    return "long"            # 長距離


def going_bin_of(race) -> str:
    g = (race.get("going") or "").strip()
    if not g:
        return "na"
    return "firm" if g == "良" else "soft"   # 良 / 道悪(稍重・重・不良)


def build_pedigree_features(ped_map, k_shrink: float = K_SHRINK):
    """各 (race_id, 馬番) に血統の特徴を付ける。返り値 (feat, info)。

    feat[(rid, number)] = [FEATURE_NAMES の順に並んだ数字]
    ぜんぶ「そのレースより前」の集計だけ＝未来を1ミリも見ていない。
    """
    files = sorted(RACES.glob("*.json"), key=lambda p: p.stem)   # rid の先頭が日付＝時間順
    stat: dict = defaultdict(lambda: [0, 0, 0])   # key -> [走数, 1着数, 3着内数]
    league = [0, 0, 0]
    feat: dict = {}
    n_race = 0
    n_horse = 0
    n_no_f = 0
    n_no_b = 0

    for fp in files:
        race = _load(fp)
        if not race:
            continue
        rid = race.get("race_id") or fp.stem
        surf = surface_of(race)
        dbin = dist_bin_of(race)
        gbin = going_bin_of(race)
        horses = [h for h in (race.get("horses") or []) if isinstance(h.get("number"), int)]
        if not horses:
            continue
        n_race += 1

        # ── リーグ平均（この時点までの全体） ──
        lw = league[1] / league[0] if league[0] >= 200 else 0.075
        lp = league[2] / league[0] if league[0] >= 200 else 0.23

        def rates(key):
            """(なめらか化した勝率, なめらか化した3着内率, log(走数)) を返す。"""
            v = stat.get(key)
            if v is None:
                n = w = t = 0
            else:
                n, w, t = v
            return ((w + k_shrink * lw) / (n + k_shrink),
                    (t + k_shrink * lp) / (n + k_shrink),
                    math.log1p(n))

        # ── まず「今の時点の値」を記録（＝過去だけ） ──
        for h in horses:
            ketto = h.get("ketto_num")
            ped = ped_map.get(ketto) if ketto else None
            fa = (ped or {}).get("f") or ""
            bm = (ped or {}).get("b") or ""
            if not fa:
                n_no_f += 1
            if not bm:
                n_no_b += 1
            row = []
            row += rates(("F", fa)) if fa else rates(("_none_F",))
            row += rates(("FS", fa, surf)) if fa else rates(("_none_FS",))
            row += rates(("FD", fa, dbin)) if fa else rates(("_none_FD",))
            row += rates(("FG", fa, gbin)) if fa else rates(("_none_FG",))
            row += rates(("B", bm)) if bm else rates(("_none_B",))
            row += rates(("BS", bm, surf)) if bm else rates(("_none_BS",))
            feat[(rid, h["number"])] = row
            n_horse += 1

        # ── そのあとで結果を数に入れる（次のレース以降の「過去」になる） ──
        for h in horses:
            if str(h.get("ijyou_code") or "0") != "0":
                continue                      # 取消・除外などは走っていない
            rank = h.get("kakutei_jyuni")
            if not isinstance(rank, int) or rank <= 0:
                continue                      # まだ結果が出ていないレース
            won = 1 if rank == 1 else 0
            in3 = 1 if rank <= 3 else 0
            league[0] += 1
            league[1] += won
            league[2] += in3
            ketto = h.get("ketto_num")
            ped = ped_map.get(ketto) if ketto else None
            fa = (ped or {}).get("f") or ""
            bm = (ped or {}).get("b") or ""
            for key in ([("F", fa), ("FS", fa, surf), ("FD", fa, dbin), ("FG", fa, gbin)] if fa else []):
                s = stat[key]
                s[0] += 1
                s[1] += won
                s[2] += in3
            for key in ([("B", bm), ("BS", bm, surf)] if bm else []):
                s = stat[key]
                s[0] += 1
                s[1] += won
                s[2] += in3

    info = {
        "races": n_race,
        "horses": n_horse,
        "father_missing": n_no_f,
        "bms_missing": n_no_b,
        "league_runs": league[0],
        "league_win_rate": round(league[1] / max(1, league[0]), 4),
        "league_place_rate": round(league[2] / max(1, league[0]), 4),
        "sire_keys": sum(1 for k in stat if k[0] == "F"),
        "bms_keys": sum(1 for k in stat if k[0] == "B"),
    }
    return feat, info


if __name__ == "__main__":
    import io
    import os
    import sys
    os.environ["PYTHONIOENCODING"] = "utf-8"
    for _a in ("stdout", "stderr"):
        _s = getattr(sys, _a, None)
        if _s and hasattr(_s, "buffer"):
            setattr(sys, _a, io.TextIOWrapper(_s.buffer, encoding="utf-8"))
    ped, names = load_pedigree_map()
    f, info = build_pedigree_features(ped)
    print(f"[OK] 特徴を作った: {len(f)} 頭ぶん")
    for k, v in info.items():
        print(f"   {k}: {v}")
