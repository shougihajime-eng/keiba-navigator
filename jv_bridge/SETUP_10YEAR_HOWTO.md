# 過去データ・血統のとり方（実測ずみ手順書）

最終更新: 2026-08-12 / JV-Link **5.0.0** で全部このとおり動くのを実機で確認した。
これは「やり方」だけの紙。**推測は1つも書いていない。全部その日に実際に動かした結果**。

---

## 0. まず知っておくこと（これが今までの詰まりの正体）

JRA-VAN のデータは **2種類** ある。

| | 何 | どこまで遡れるか | ダイアログ |
|---|---|---|---|
| **通常データ** `option=1` | 毎日の差分 | **約12か月だけ**（実測: 2025-08-15 より前は取れない） | 出ない |
| **セットアップデータ** `option=3 / 4` | 過去のぜんぶ | **10年でも取れる** | **出る** |

**10年ぶんが欲しいなら option=3/4 しか道は無い。** option=1 では絶対に届かない（実測ずみ）。

### 🚨 rc=-501 の正体（1年ちかく詰まっていた原因）

option=3/4 を呼ぶと「セットアップ」という窓が出る。その窓の**最初から選ばれている方**が

- ⦿ スタートキット(CD/DVD-ROM)を**持っている**（推奨）  ← これが既定
- ○ スタートキット(CD/DVD-ROM)を**持っていない**

**CD/DVD の配布は 2022年3月に終わっている**ので、既定のまま OK を押すと
CD を探しに行って見つからず **`rc=-501`（スタートキットが無効）** で失敗する。
＝ JRA-VAN は何も悪くない。**こちらが「持っていない」を選べばよかっただけ**。

### 🚨 もう1つの落とし穴（ここで10分固まる）

**窓は2枚出る。** 1枚目（上のラジオ）を答えたあとに、**もう1枚 OK だけの窓**が出る。
2枚目を押さないと **JVOpen が永久に止まる**（CPU 0%・ダウンロード0のまま無言）。
実際これで10分待っても何も起きなかった。**2枚目を忘れないこと。**

### 🚨 裏で（窓を隠して）動かすと必ず固まる

`-WindowStyle Hidden` などで隠して起動すると、窓に誰も答えられないので
**エラーも出さずに止まりっぱなし**になる。過去のログが `-501` だったり
無言だったりバラバラだったのはこれが理由。**必ず ふつうの窓で動かす。**

---

## 1. 使う道具（今回つくった）

### `jv_bridge/setup_fetch.ps1` … 窓に自動で答えてくれる取得係
**2枚の窓を自分で押してくれる**ので、人は何もクリックしなくてよい。
時間制限つきで、終わったら必ず後片付け（JV-Link を掴んだままにしない）。

### `jv_bridge/probe_history.py` … 「いつまで遡れるか」を測るだけの道具
JVOpen で件数だけ聞いて即 JVClose する。**1バイトもダウンロードしない**ので安全・数秒。

```
py -3.12-32 jv_bridge/probe_history.py --dataspec RACE --option 1 --windows 2024 2025 2026
```

---

## 2. 血統（父）を取る ← **もう済んでいる。次からはこれだけ**

血統は **option=1 で取れる**（＝窓が出ない・全自動でよい）。
ただし **`BLOD` ではなく `BLDN` / `DIFN`** を使うのが正解。

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\shoug\はじめアプリ\７📦そのほか\競馬\jv_bridge\setup_fetch.ps1" -DataSpec BLDN -Option 1 -FromTime 20140101000000 -TimeoutMin 12
powershell -ExecutionPolicy Bypass -File "C:\Users\shoug\はじめアプリ\７📦そのほか\競馬\jv_bridge\setup_fetch.ps1" -DataSpec DIFN -Option 1 -FromTime 20140101000000 -TimeoutMin 20
```
かかる時間の実測: BLDN 約10秒 / DIFN 約4分。

そのあと父馬マップを作り直す:
```
py -3.12-64 jv_bridge/build_sire_map.py
```

**🚨 生データの置き場所は `data/jv_cache/kettou_raw/`。`aggregate_*/` に置かないこと。**
`build_all.py` は毎朝 `aggregate_*/raw_*.bin` を**中身を見ずに全部**読むので、
そこに血統の生データ（DIFN は約300MB・RA/SE も入っている）を置くと、
毎朝が重くなるうえ 中途半端なレース情報が `races/` `results/` に混ざる。
（調教を `chokyo_raw/` に分けてあるのと同じ理由）

---

## 3. レースを10年ぶん取る ← **2026-08-12 実行ずみ。手順はこれで確定**

### 🚨 いちばん大事なこと＝生データを `aggregate_*` に置いてはいけない

毎朝の `build_all.py` は `data/jv_cache/aggregate_*/raw_*.bin` を**自動で全部**拾う。
JV-Link は 1 回の取得を**1個の巨大な .bin** にまとめるので、そこに置くと次が同時に起きる:

| | 何が起きるか |
|---|---|
| ① | **翌朝の build_all.py が 10 年ぶんを展開しにいく。** しかも build_all.py は **32bit Python** で動く（`race_day_pipeline.py` の `python_exe()`）。32bit のメモリ上限は約2GB → MemoryError |
| ② | **その後も毎朝ダメ。** 差分ビルドは「dirty なレースを含む古いファイルも道連れで読む」作り。10年ファイルは**今日のレースも含む**ので毎回 道連れ → 毎朝 数GB を読む |
| ③ | races/ が 4,380 → 約40,000 に増えると **features.json が 42MB → 約380MB**。features.json は **git に載せて Vercel に配っている**。GitHub は 100MB 超のファイルを受け付けない → **毎朝の git push が落ちて本番が止まる** |

→ だから **「取る」と「取り込む」を分ける**（血統の `kettou_raw/` と同じ考え方）。

### 手順（この2行）

```powershell
# ① 取る（隔離フォルダへ。_status.json にも触らない）
powershell -ExecutionPolicy Bypass -File "C:\Users\shoug\はじめアプリ\７📦そのほか\競馬\jv_bridge\setup_fetch.ps1" -DataSpec RACE -Option 3 -FromTime 20140101000000 -TimeoutMin 180 -OutDir history_raw

# ② 取り込む（64bit python。人が見ている時に）
cd "C:\Users\shoug\はじめアプリ\７📦そのほか\競馬"
& "$env:LOCALAPPDATA\Programs\Python\Python312-64\python.exe" jv_bridge\import_history.py
```

- 出来上がり＝**`data/jv_cache/history/races|results/*.json`**（本番の `races/` とは別）。
  `history/` は build_all.py の索引にも入らず、毎朝のどの処理からも読まれない。
- **本番の `races/` `results/` に既にあるレースは絶対に書き換えない**（本番側には
  毎時オッズなど、セットアップデータに無い情報が入っているため）。
- 中央競馬（JRA・競馬場コード01〜10）だけ入れる。地方競馬は `--include-nar` で入る。
- メモリ対策＝巨大 .bin を **年月ごとの部品**に切ってから 1 個ずつ組み立てる
  （1レースの全レコードは必ず同じ日付なので、年月で切ってもレースは分断されない。
  「丸ごと読んだ版と1バイトも変わらない」ことを実データで検証ずみ）。

### 学習で使うとき（毎朝の features.json は増やさない）

```powershell
# 10年ぶんを足した features を別ファイルに作る（git には載せない）
& $py64 jv_bridge\aggregate_features_v2.py --extra-dir data/jv_cache/history --out data/jv_cache/features_10y.json
# 「増やすと本当に強くなるのか」をリークなしで測る（AUC と 回収率の両方）
& $py64 jv_bridge\experiment_10y.py --blocks 5
```

### ⚠️ そのほかの注意
1. 空きディスクを確認する（2026-08-12 時点で 127GB 空き。生データは数GB規模）。
2. **土日月・金の夕方は走らせない**（その時間は毎時の取得タスクが JV-Link を使う。
   JV-Link は同時に2つ動かせない）。**火・水・木の昼間が安全**。
   翌朝8時の `KeibaGapFill-0800` までに終わらせる。
3. **`build_all.py --full` を軽い気持ちで走らせない**。実測すると 4,380 レースのうち
   **95 レースの単勝オッズが書き換わった**（古い生データは容量のため削除ずみで、
   いま残っている生データだけからは当時と同じ値を再現できない）。
   `races/` は「積み上げてきた結果」なので、全部作り直すと情報が減ることがある。

---

## 4. 走らせる前の安全確認（毎回）

```powershell
# JV-Link を誰かが使っていないか（自分自身は除く）
Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.CommandLine -like '*jv_fetch*' -or $_.CommandLine -like '*collect_exotic*') }
# 鍵ファイルが残っていないか
dir "C:\Users\shoug\はじめアプリ\７📦そのほか\競馬\data\jv_cache\*.lock"
```
`setup_fetch.ps1` はこの2つを自分でも確認してから動く（ダメなら何もせず止まる）。

取ったあとは**必ず文字化けチェック**（`?@?@` があったら そのデータは捨てる）:
```
python -c "b=open(r'<生bin>','rb').read(); print(b.count(b'\x3f\x40\x3f\x40'))"
```
→ `0` なら無事。今回取った3本は全部 0 だった。

---

## 5. 実測した「どこまで遡れるか」一覧（2026-08-12・JV-Link 5.0.0）

| dataspec | option | fromtime | rc | 結果 |
|---|---|---|---|---|
| RACE | 1 | 2026年の窓 | 0 | 827ファイル |
| RACE | 1 | 2025年の窓 | 0 | 537ファイル |
| RACE | 1 | 2024年以前 | **-1** | 無し |
| RACE | 1 | 2025-08-13〜15 | 0 | **ここが境目**（最古 2025-08-15） |
| RACE | 3 | 20140101 | **0** | **2349ファイル**（10年ぶん・要ダイアログ） |
| RACE | 4 | 20140101 | **-501** | 既定が「CDを持っている」のまま失敗 |
| BLOD | 1 | いつでも | **-1** | 血統は通常データでは取れない |
| BLOD | 3 | 20140101 | 0 | 231ファイル（**2023-07-31 まで**の馬） |
| BLDN | **1** | いつでも | **0** | 86ファイル（**窓なし**・新しい馬） |
| DIFN | **1** | いつでも | **0** | 733ファイル（**窓なし**・UM=競走馬マスタ） |
| DIFF | 1 | いつでも | -1 | 無し |
