# 競馬アプリ 緊急修理の指示書 (self_heal.ps1 の2段目から自動起動される)

あなたは競馬アプリ (このリポジトリ = C:\Users\shoug\競馬) の緊急修理係です。
開催日の発売中に「当日オッズの流れが止まり、1段目の再取得でも直らなかった」ため自動起動されました。
人間は見ていません。質問せず、自律的に、以下の順で作業してください。

## 0. まず本当に壊れているか確認する (誤報なら何もせず終わる)

- 今日 (実行時点の日付) のレースが `data/jv_cache/races/<今日yyyymmdd>*.json` に存在するか。
  **無ければ誤報** (開催なしの日)。何も変更せず、報告ファイルだけ書いて終了。
- `data/jv_cache/raw_0B31_<今日>*.bin` の最新更新時刻、`data/jv_cache/predictions.json` の fetchedAt、
  `data/jv_cache/race_card_latest.json` の date を確認。全部健全なら誤報として終了。

## 1. 診断 (直す前に必ず原因を特定する)

- `logs/fetch_diff_<今日>.log` を読む。「RT odds fetch done (N/M ok)」の N、「RT failures: rc=...」、[ALERT] 行に注目。
- 手で1回だけ実取得して本当のエラーを見る:
  `py -3.12-32 jv_bridge\jv_fetch.py rt --dataspec 0B31 --raceid <今日のレースID 16桁>`
  (races/ のファイル名は18桁。末尾の00を除いた16桁が JVRTOpen 用。cmd_rt は18桁でも自動変換する)
- rc の意味: -114=該当データなし(発売中なら異常) / -111=未対応 / -201=JVInit未実行 / -301=認証エラー / -504=サーバメンテ。
- 過去の実バグ例: ①レースID 18桁渡し (16桁が正・2026-06-07修正) ②O1オッズの win_odds_by_horse 未配線 (parse.py・2026-06-07修正)
  ③SE重複で races 壊れ (build_all.py dedup_se_list・2026-06-07修正)。同種の退行を疑う。
- JRA-VAN 側は正しい前提で考える (こちらのコード/手順の誤りを先に疑う。本人の方針)。

## 2. 修理 (最小限・このリポジトリの中だけ)

- 原因がコードのバグなら最小修正する。修正対象になりやすい場所:
  `jv_bridge/jv_fetch.py` / `jv_bridge/parse.py` / `jv_bridge/build_race_json.py` / `jv_bridge/build_all.py` / `scripts/fetch_diff_hourly.ps1`
- 修正後に必ず検証:
  1. `node tests/smoke.js` が 128/0 で通る
  2. `py -3.12-32 -m pytest jv_bridge\tests -q` が通る
  3. `powershell -ExecutionPolicy Bypass -File scripts\fetch_diff_hourly.ps1` を実行し、
     ログに「RT odds fetch done (N/M ok)」N>0 と、predictions.json の fetchedAt 更新を確認
- 検証が通ったら `git add -A` → 日本語のコミット (fix: で始める) → `git push origin main`。
- **直せない場合** (JRA-VAN サーバ停止・回線断など): コードを壊さない。何も変更せずに報告だけ書く。
  アプリには既に「自動更新が止まっています」の赤い警告が自動表示されるので、利用者が誤って買うことはない。

## 3. 報告 (成否にかかわらず必ず)

- `logs/self_heal_claude_report.txt` に日本語で追記:
  日時 / 誤報か本物か / 原因 / 直したか / 検証結果 / push したコミット / 残る問題。

## 禁止事項

- このフォルダ (C:\Users\shoug\競馬) の外を変更しない。
- git の履歴を壊す操作 (force push・reset --hard origin 等) をしない。
- 自動投票・購入に類する機能を作らない。
- データファイルの大量削除をしない。
