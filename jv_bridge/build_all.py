# -*- coding: utf-8 -*-
"""
build_all.py — aggregate_*/raw_*.bin から races/<id>.json と results/<id>.json を全部書き出す。

flow:
  1. data/jv_cache/aggregate_*_RACE/raw_*.bin を全部読む
  2. parse.parse_raw_file で record dict のリストにする
  3. RA / SE / O1 / HR を race_id でグルーピング
  4. build_race_json.merge() + .write() → races/<id>.json
  5. SE で着順が確定しているレースは build_result_json.from_se_list() + .write() → results/<id>.json
     HR があれば build_result_json.build() で payouts も合体

🆕 2026-08-12 差分ビルド (既定):
  生データは 9,500 ファイル・2.6GB あり、毎回ぜんぶ読み直すと 60〜120 秒かかって
  毎朝の取り込みがタイムアウトしていた (8/11 に実際に発生し 8/8・8/9 の結果が落ちた)。
  そこで「どのファイルがどのレースを含むか」の索引 (_build_all_index.json) を持ち、
  **新しく増えた/中身が変わったファイルだけ**を読むようにした。

  正しさの担保 (ここが肝):
    1 つのレースの情報は複数のファイルにまたがる (金曜の出走表・土曜の毎時オッズ・
    日曜の確定着順…)。だから「新しいファイルだけ読んで書く」と情報が欠けたまま
    上書きしてしまう。
    → 新ファイルが触れたレース (= dirty) を洗い出し、**索引を引いて
      「その dirty レースを含む古いファイル」も必ず一緒に読み直す**。
      そして **書き出すのは dirty レースだけ** に限定する
      (道連れで読んだ古いファイルの他レースは情報が欠けているので絶対に書かない)。
    ＝書き出す全レースについて、そのレースに言及する全ファイルを読んでいる。
      全部読み直した版と 1 バイトも変わらないことを実データで検証ずみ。

使い方:
  py -3.12 jv_bridge\build_all.py                # 差分だけ (既定・速い)
  py -3.12 jv_bridge\build_all.py --full         # 全部読み直す (索引も作り直す)
  py -3.12 jv_bridge\build_all.py --raw-dir data/jv_cache/aggregate_20240101_RACE
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

# ── jv_bridge package を import 可能にする ──────────────────
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from jv_bridge import parse  # noqa: E402
from jv_bridge import build_race_json  # noqa: E402
from jv_bridge import build_result_json  # noqa: E402


CACHE_DIR = ROOT / "data" / "jv_cache"
RACES_DIR = CACHE_DIR / "races"
RESULTS_DIR = CACHE_DIR / "results"

# 差分ビルド用の索引 (どの生データファイルがどのレースを含むか)
INDEX_PATH = CACHE_DIR / "_build_all_index.json"
INDEX_VERSION = 1


RACE_KEY_FIELDS = ("year", "month_day", "jyo_code", "kai_ji", "nichi_ji", "race_num")


def _race_id_of(rec: Dict[str, Any]) -> Optional[str]:
    """RA/SE/O1/HR 共通の race ID (18 桁) を組み立てる。
    年(4)+月日(4)+場(2)+回(2)+日次(2)+R(2)+末尾"00"。
    フロント (lib/race_id.js: JRA_18DIGIT) と完全一致させるため末尾 00 を付与する。
    """
    parts = []
    for k in RACE_KEY_FIELDS:
        v = rec.get(k)
        if v in (None, "", " "):
            return None
        parts.append(str(v).strip())
    base = "".join(parts)
    if len(base) != 16 or not base.isdigit():
        return None
    return base + "00"


def _collect_raw_files(raw_dir: Optional[Path]) -> List[Path]:
    """対象 .bin ファイルを集める。
    - aggregate_*/<SPEC>/raw_*.bin  (cmd_aggregate の出力)
    - CACHE_DIR 直下の raw_*.bin   (cmd_rt の出力。発走前後の RT 系・0B14/0B15/0B11/0B12 等)
    """
    out: List[Path] = []
    if raw_dir is not None:
        out.extend(sorted(raw_dir.glob("raw_*.bin")))
    else:
        for sub in sorted(CACHE_DIR.glob("aggregate_*")):
            if sub.is_dir():
                out.extend(sorted(sub.glob("raw_*.bin")))
        # cmd_rt が CACHE_DIR 直下に書く raw_<dataspec>_<raceid>_<ts>.bin を拾う
        out.extend(sorted(CACHE_DIR.glob("raw_*.bin")))
    return out


def parse_all(raw_paths: List[Path], verbose: bool = True) -> List[Dict[str, Any]]:
    """全 raw .bin をパースして 1 つのリストに連結 (raw_paths の順そのまま)。"""
    recs_by_file, _races, _bytes = parse_files(raw_paths, verbose=verbose)
    return concat_in_order(raw_paths, recs_by_file)


def parse_files(raw_paths: List[Path],
                verbose: bool = True) -> Tuple[Dict[str, List[Dict[str, Any]]], Dict[str, Set[str]], int]:
    """raw .bin をパースして (ファイル別レコード, ファイル別レースID集合, 読んだバイト数) を返す。

    ⚠ここでは連結しない。連結の順番は結果を変える (下の concat_in_order を必ず使う)。
    ファイル別レースID集合は差分ビルドの索引 (_build_all_index.json) に使う。
    """
    recs_by_file: Dict[str, List[Dict[str, Any]]] = {}
    per_file: Dict[str, Set[str]] = {}
    total_bytes = 0
    for p in raw_paths:
        try:
            raw = p.read_bytes()
        except Exception as e:
            print(f"  [warn] read {p.name}: {e}", flush=True)
            continue
        total_bytes += len(raw)
        recs = parse.parse_raw_file(raw)
        ids: Set[str] = set()
        for r in recs:
            rid = _race_id_of(r)
            if rid:
                ids.add(rid)
        rel = _rel(p)
        per_file[rel] = ids
        recs_by_file[rel] = recs
        if verbose:
            print(f"  [info] {p.name}: {len(recs)} records", flush=True)
    return recs_by_file, per_file, total_bytes


def concat_in_order(raw_paths: List[Path],
                    recs_by_file: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """レコードを「ファイルの決まった並び順」で 1 本に連結する。

    🚨 これがとても大事:
      group_by_race は RA / O1 / HR を「あとから来たレコードで上書き」する作り
      (dedup_se_list も同点なら後勝ち)。つまり **読む順番が変わると出来上がりが変わる**。
      差分ビルドで「新しいファイル → 道連れの古いファイル」の順に連結すると、
      全読み版と天気・馬場などが食い違う (実際にこれで 61 レースがズレた)。
      だから必ず _collect_raw_files が返す並び順に揃えてから連結する。
    """
    out: List[Dict[str, Any]] = []
    for p in raw_paths:
        recs = recs_by_file.get(_rel(p))
        if recs:
            out.extend(recs)
    return out


# ─── 差分ビルドの索引 ──────────────────────────────────────
# 形式 (小さく保つため配列):
#   {"version":1, "generatedAt":"...", "files": {"<相対パス>": [size, mtime_ns, ["<raceId>", ...]]}}

_CACHE_RESOLVED = None  # CACHE_DIR.resolve() の結果を 1 回だけ取る


def _rel(p: Path) -> str:
    """CACHE_DIR からの相対パス (OS 差を消すため必ず / 区切り)。

    ⚠ Path.resolve() は 1 回あたり実ファイルを見に行くので、9,500 ファイル分やると
      それだけで 4 秒以上かかる (実測)。まず素の relative_to を試し、
      ダメなときだけ resolve に落とす。
    """
    global _CACHE_RESOLVED
    try:
        return p.relative_to(CACHE_DIR).as_posix()
    except ValueError:
        pass
    try:
        if _CACHE_RESOLVED is None:
            _CACHE_RESOLVED = CACHE_DIR.resolve()
        return p.resolve().relative_to(_CACHE_RESOLVED).as_posix()
    except Exception:
        return p.as_posix()


def _stamp(p: Path) -> Tuple[int, int]:
    """ファイルの「変わったか」を見る印 = (サイズ, 更新時刻ns)。"""
    st = p.stat()
    return (int(st.st_size), int(st.st_mtime_ns))


def load_index() -> Optional[Dict[str, Any]]:
    """索引を読む。無い/壊れている/版が違うなら None (= 全部読み直しに落とす)。"""
    try:
        data = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("version") != INDEX_VERSION:
        return None
    files = data.get("files")
    if not isinstance(files, dict):
        return None
    # 中身の形もざっと確かめる (壊れた索引で黙って間違うより全読みの方が安全)
    for v in files.values():
        if not (isinstance(v, list) and len(v) == 3 and isinstance(v[2], list)):
            return None
    return data


def save_index(files: Dict[str, Tuple[int, int, Iterable[str]]]) -> None:
    payload = {
        "version": INDEX_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "note": "build_all.py の差分ビルド用。<相対パス>: [サイズ, 更新時刻ns, [そのファイルが含む raceId...]]",
        "files": {k: [v[0], v[1], sorted(v[2])] for k, v in files.items()},
    }
    tmp = INDEX_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(INDEX_PATH)


def _se_record_score(se: Dict[str, Any]) -> tuple:
    """同一馬の重複 SE レコードから「どちらを残すか」を決めるスコア。
    確定着順あり > 情報が多い、の順で優先する。"""
    has_finish = 1 if (se.get("kakutei_jyuni") or 0) else 0
    filled = sum(1 for v in se.values() if v not in (None, "", "0", 0))
    return (has_finish, filled)


def dedup_se_list(se_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """SE (出走馬) レコードの重複を除去する。

    🚨 2026-06-07 バグ修正: 毎時の差分取得で同じレースの SE レコードが
    raw bin ごとに何度も届くが、従来は全部 se_list に追加していたため
    「同じ馬が 5 重複 + 枠順確定前の空シェル (馬番 0) 32 件 = 112 頭」の
    壊れたレース JSON が生成され、当日の予想が全レース「判断不可」になった。

    ルール:
    - 馬番 1 以上のレコードが 1 件でもあれば、馬番 0/None の空シェルは捨てる
      (全頭シェルの場合のみそのまま返す = 出走表未配信の表現を維持)
    - 同じ馬番の重複は「確定着順あり > 情報量が多い > 後から届いた方」を採用
    """
    real = [se for se in se_list if (se.get("horse_num") or 0) > 0]
    if not real:
        return se_list  # 全部シェル (枠順確定前) はそのまま
    best: Dict[int, tuple] = {}  # horse_num -> (score, index, record)
    for idx, se in enumerate(real):
        num = int(se.get("horse_num"))
        cand = (_se_record_score(se), idx, se)
        cur = best.get(num)
        # スコア同点なら後から届いたレコード (新しい更新) を採用
        if cur is None or (cand[0], cand[1]) >= (cur[0], cur[1]):
            best[num] = cand
    return [best[num][2] for num in sorted(best.keys())]


def group_by_race(records: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """race_id → {ra, se_list, o1, hr, dm_list, tk_list} に振り分け。

    SE/DM は同一 race に複数頭の繰り返しがあるためリスト。
    O1 / HR は通常 1 race に 1 件。
    SE は最後に dedup_se_list() で重複・空シェルを掃除する。
    """
    out: Dict[str, Dict[str, Any]] = {}
    for r in records:
        rid_full = _race_id_of(r)
        if not rid_full:
            continue
        slot = out.setdefault(rid_full, {
            "ra": None, "se_list": [], "o1": None, "hr": None,
            "dm_list": [], "tk_list": [],
        })
        rec_type = r.get("_record_id")
        if rec_type == "RA":
            slot["ra"] = r
        elif rec_type == "SE":
            slot["se_list"].append(r)
        elif rec_type == "O1":
            slot["o1"] = r
        elif rec_type == "HR":
            slot["hr"] = r
        elif rec_type == "DM":
            slot["dm_list"].append(r)
        elif rec_type == "TK":
            slot["tk_list"].append(r)
    # SE の重複・空シェルを掃除 (races と results の両方がこの結果を使う)
    for slot in out.values():
        if slot["se_list"]:
            slot["se_list"] = dedup_se_list(slot["se_list"])
    return out


def index_horse_master(records: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """HN レコード群 → ketto_num → 馬データ dict のインデックス。"""
    out: Dict[str, Dict[str, Any]] = {}
    for r in records:
        if r.get("_record_id") != "HN":
            continue
        k = r.get("ketto_num") or ""
        k = k.strip() if isinstance(k, str) else ""
        if not k:
            continue
        out[k] = {
            "ketto_num":    k,
            "horse_name":   (r.get("horse_name") or "").strip(),
            "name_kana":    (r.get("name_kana") or "").strip(),
            "birth_year":   r.get("birth_year"),
            "sex_code":     r.get("sex_code"),
            "keiro":        r.get("keiro"),
            "father_num":   r.get("hansyoku_f_num"),
            "mother_num":   r.get("hansyoku_m_num"),
        }
    return out


def build_races(groups: Dict[str, Dict[str, Any]]) -> int:
    """races/<id>.json を書き出す。RA 必須。SE は 0 件でも書く (出走表未配信時)。
    DM (JRA-VAN マイニング予想) があれば race JSON に dm_predictions として乗せる。
    """
    RACES_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for rid, g in groups.items():
        ra = g.get("ra")
        if not ra:
            continue
        race_json = build_race_json.merge(ra, g.get("se_list") or [], g.get("o1"))
        # DM (data mining = JRA-VAN 公式 AI 予想) を race JSON に乗せる
        dm_list = g.get("dm_list") or []
        if dm_list:
            race_json["dm_predictions"] = [
                {
                    "dm_kubun":   d.get("dm_kubun"),
                    "dm_time":    d.get("dm_time"),
                    "make_hm":    d.get("make_hm"),
                }
                for d in dm_list
            ]
            race_json["has_mining"] = True
        path = build_race_json.write(race_json)
        if path:
            written += 1
    return written


def build_results(groups: Dict[str, Dict[str, Any]]) -> int:
    """results/<id>.json を書き出す。SE 確定着順または HR があるレースのみ。"""
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for rid, g in groups.items():
        ra = g.get("ra")
        se_list = g.get("se_list") or []
        hr = g.get("hr")

        # 着順が確定している SE が 1 件以上あるか
        has_finished = any(isinstance(s.get("kakutei_jyuni"), int) and s.get("kakutei_jyuni", 0) > 0
                           for s in se_list)
        if not has_finished and not hr:
            continue

        result_json = None
        if ra and has_finished:
            result_json = build_result_json.from_se_list(ra, se_list, hr)
        elif hr:
            result_json = build_result_json.build(hr, ra, se_list)

        if not result_json or not result_json.get("race_id"):
            continue
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        out = RESULTS_DIR / f"{result_json['race_id']}.json"
        out.write_text(json.dumps(result_json, ensure_ascii=False, indent=2), encoding="utf-8")
        written += 1
    return written


def write_horse_master(records: List[Dict[str, Any]], merge: bool) -> int:
    """HN レコードから horse_master.json を書く。
    merge=True (差分ビルド) のときは既存ファイルに足す (今回読まなかった馬を消さない)。
    """
    horse_master = index_horse_master(records)
    if not horse_master:
        return 0
    hm_path = CACHE_DIR / "horse_master.json"
    if merge:
        try:
            old = json.loads(hm_path.read_text(encoding="utf-8"))
            if isinstance(old, dict):
                old.update(horse_master)
                horse_master = old
        except Exception:
            pass
    hm_path.write_text(json.dumps(horse_master, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[OK] horse_master.json 書き出し ({len(horse_master)} 頭 / {hm_path.stat().st_size} bytes)", flush=True)
    return len(horse_master)


def _report_groups(groups: Dict[str, Dict[str, Any]]) -> None:
    has_dm = sum(1 for g in groups.values() if g.get("dm_list"))
    has_tk = sum(1 for g in groups.values() if g.get("tk_list"))
    has_se = sum(1 for g in groups.values() if g.get("se_list"))
    has_hr = sum(1 for g in groups.values() if g.get("hr"))
    print(f"[info] race ごとの付随データ: DM(AI予想)={has_dm} TK(特別登録)={has_tk} "
          f"SE(出走馬)={has_se} HR(払戻)={has_hr}", flush=True)


def run_full(raw_paths: List[Path], write_index: bool, verbose: bool) -> int:
    """全ファイルを読み直す従来どおりのビルド。索引も作り直す。"""
    print(f"[info] 全読み: {len(raw_paths)} ファイル処理開始", flush=True)
    recs_by_file, per_file, nbytes = parse_files(raw_paths, verbose=verbose)
    records = concat_in_order(raw_paths, recs_by_file)
    print(f"[info] パース済 total {len(records)} レコード ({nbytes/1e6:.1f}MB)", flush=True)

    by_type: Dict[str, int] = {}
    for r in records:
        t = r.get("_record_id") or "?"
        by_type[t] = by_type.get(t, 0) + 1
    print(f"[info] 種別内訳: {dict(sorted(by_type.items(), key=lambda x: -x[1])[:15])}", flush=True)

    groups = group_by_race(records)
    print(f"[info] race 単位グルーピング: {len(groups)} race", flush=True)

    write_horse_master(records, merge=False)

    nr = build_races(groups)
    print(f"[OK] races/ に {nr} 件書き出し", flush=True)
    nres = build_results(groups)
    print(f"[OK] results/ に {nres} 件書き出し", flush=True)
    _report_groups(groups)

    if write_index:
        stamps: Dict[str, Tuple[int, int, Iterable[str]]] = {}
        for p in raw_paths:
            rel = _rel(p)
            try:
                sz, mt = _stamp(p)
            except OSError:
                continue
            stamps[rel] = (sz, mt, per_file.get(rel, set()))
        save_index(stamps)
        print(f"[OK] 索引を保存 ({len(stamps)} ファイル / {INDEX_PATH.stat().st_size/1e6:.2f}MB)", flush=True)
    return 0


def run_incremental(raw_paths: List[Path], index: Dict[str, Any], verbose: bool) -> int:
    """差分ビルド。新しい/変わったファイルと、それが触れたレースを含む古いファイルだけ読む。"""
    idx_files: Dict[str, List[Any]] = index["files"]

    current: Dict[str, Path] = {}
    for p in raw_paths:
        current[_rel(p)] = p

    # ① 新しい・中身が変わったファイル (サイズか更新時刻が違えば「変わった」)
    changed: List[str] = []
    unchanged: List[str] = []
    stamps: Dict[str, Tuple[int, int]] = {}
    for rel, p in current.items():
        try:
            stamps[rel] = _stamp(p)
        except OSError:
            continue
        sz, mt = stamps[rel]
        old = idx_files.get(rel)
        if old is None or int(old[0]) != sz or int(old[1]) != mt:
            changed.append(rel)
        else:
            unchanged.append(rel)
    removed = [rel for rel in idx_files if rel not in current]

    print(f"[info] 差分ビルド: 新規/変更 {len(changed)} / 変化なし {len(unchanged)} / 消えた {len(removed)}",
          flush=True)

    # ② dirty レース = 新規/変更ファイルが触れたレース + 消えたファイルが持っていたレース
    recs_by_file: Dict[str, List[Dict[str, Any]]] = {}
    per_file: Dict[str, Set[str]] = {}
    nbytes = 0
    if changed:
        rbf, pf, nb = parse_files([current[r] for r in changed], verbose=verbose)
        recs_by_file.update(rbf)
        per_file.update(pf)
        nbytes += nb

    dirty: Set[str] = set()
    for rel in changed:
        dirty |= per_file.get(rel, set())
    for rel in removed:
        dirty |= set(idx_files[rel][2])

    if not dirty:
        print("[OK] 新しいレースデータはありません (書き出し 0 件)", flush=True)
        write_horse_master(concat_in_order(raw_paths, recs_by_file), merge=True)
        _save_index_from(current, idx_files, per_file, stamps)
        return 0

    # ③ dirty レースを含む「変化していない古いファイル」も必ず読む
    #    (1 レースの情報は複数ファイルにまたがるので、これを飛ばすと情報が欠ける)
    companions = [rel for rel in unchanged if dirty & set(idx_files[rel][2])]
    if companions:
        rbf, pf, nb = parse_files([current[r] for r in companions], verbose=verbose)
        recs_by_file.update(rbf)
        per_file.update(pf)
        nbytes += nb

    # ⚠連結は必ず「全ファイルの決まった並び順」で (後勝ちの上書きが順番で変わるため)
    records = concat_in_order(raw_paths, recs_by_file)

    print(f"[info] 読んだファイル: {len(changed)} (新) + {len(companions)} (道連れ) = "
          f"{len(changed)+len(companions)} / 全 {len(current)} ・{nbytes/1e6:.1f}MB", flush=True)
    print(f"[info] 作り直すレース: {len(dirty)} 件", flush=True)
    print(f"[info] パース済 total {len(records)} レコード", flush=True)

    groups = group_by_race(records)
    # ④ 書き出すのは dirty レースだけ。
    #    道連れで読んだ古いファイルには他レースも入っているが、そちらは情報が欠けている
    #    (そのレースを含む全ファイルを読んでいない) ので絶対に上書きしない。
    groups = {rid: g for rid, g in groups.items() if rid in dirty}
    print(f"[info] race 単位グルーピング: {len(groups)} race (dirty のみ)", flush=True)

    write_horse_master(records, merge=True)

    nr = build_races(groups)
    print(f"[OK] races/ に {nr} 件書き出し", flush=True)
    nres = build_results(groups)
    print(f"[OK] results/ に {nres} 件書き出し", flush=True)
    _report_groups(groups)

    _save_index_from(current, idx_files, per_file, stamps)
    return 0


def _save_index_from(current: Dict[str, Path],
                     idx_files: Dict[str, List[Any]],
                     per_file: Dict[str, Set[str]],
                     stamps: Dict[str, Tuple[int, int]]) -> None:
    """今ある全ファイルぶんの索引を作って保存 (読まなかったファイルは前の記録を流用)。"""
    out: Dict[str, Tuple[int, int, Iterable[str]]] = {}
    for rel in current:
        st = stamps.get(rel)
        if st is None:
            continue
        if rel in per_file:
            out[rel] = (st[0], st[1], per_file[rel])
        elif rel in idx_files:
            out[rel] = (st[0], st[1], set(idx_files[rel][2]))
        else:
            # ここには来ない想定 (読んでいないのに記録も無い) が、来たら次回に全読みさせる
            continue
    save_index(out)
    print(f"[OK] 索引を更新 ({len(out)} ファイル)", flush=True)


def main():
    ap = argparse.ArgumentParser(description="raw .bin → races/results JSON")
    ap.add_argument("--raw-dir", type=Path, default=None,
                    help="特定の aggregate ディレクトリだけ処理する場合 (索引は触らない)")
    ap.add_argument("--full", action="store_true",
                    help="差分をやめて全ファイルを読み直す (索引も作り直す)")
    ap.add_argument("--quiet", action="store_true",
                    help="1 ファイルごとの行を出さない")
    args = ap.parse_args()

    t0 = time.time()
    raw_paths = _collect_raw_files(args.raw_dir)
    if not raw_paths:
        print("[NG] raw .bin が見つかりません")
        return 1

    verbose = not args.quiet

    if args.raw_dir is not None:
        # 一部ディレクトリだけの手動ビルド。全体の索引と食い違うので索引は書かない。
        print("[info] --raw-dir 指定: このディレクトリだけ全読み (索引は更新しません)", flush=True)
        rc = run_full(raw_paths, write_index=False, verbose=verbose)
    elif args.full:
        rc = run_full(raw_paths, write_index=True, verbose=verbose)
    else:
        index = load_index()
        if index is None:
            print("[info] 索引が無い/古い → 今回は全部読み直して索引を作ります", flush=True)
            rc = run_full(raw_paths, write_index=True, verbose=verbose)
        else:
            rc = run_incremental(raw_paths, index, verbose=verbose)

    print(f"[info] 所要 {time.time()-t0:.1f} 秒", flush=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
