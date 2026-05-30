# 過去10年データ取得（option=4 セットアップ）間違い探し手順書

最終更新: 2026-05-30 / 通信制限あけ（2026-06-01以降）に着手する

## 大前提（最重要・本人指示 2026-05-30）

**JRA-VAN は絶対に正しい。間違っているのはこちら（Claude / 自分のコード・手順）の方。**
前回も「JRA-VANのせい」と100回くらい誤判定した。rc=-501 を「サーバ拒否」と決めつけない。
必ず「自分の取得手順・オプション・fromtime・前提条件のどこが間違っているか」を起点に調べる。

（参考実例: 2026-05-23 に「?」文字化けを「JRA-VANサーバ側問題」と誤結論 → 後日「こちらの
jv_read latin-1 変換バグ」と判明・訂正済み。同じ轍を踏まない。）

## 症状（前回までの記録・確証あり）

- やりたいこと: 過去10年分のレースデータを一括取得して学習データを約10倍に増やす
- 失敗していたコマンド:
  ```
  py -3.12-32 jv_bridge/jv_fetch.py aggregate --dataspec RACE --fromtime 20140101000000 --option 4
  ```
- 結果: `JVOpen failed rc=-501`（再現確認済み 2026-05-30 にも同じ -501）
- JVOpen を呼んで約7秒後に -501 が返る = データ転送が始まる前の段階で弾かれている。
  → 「呼ぶ前の前提（セットアップ/キー/パラメータ/option）」のどれかがこちらの誤り、の可能性が高い。
- 現状の学習データ: 2025-05-17〜2026-05-24・約1年・3593レース（10年分の約1/10）
- 注: -501 の正式な意味はローカルの仕様書ファイルに無い（`_jvdata_spec.txt` は空）。
  → 6/1 に developer.jra-van.jp の PDF 仕様書で必ず引くこと。

## まず最初にやること（順番厳守）

### 手順0: rc=-501 の本当の意味を仕様書で確認する（推測で動かない）
- JV-Data 仕様書 PDF（JV-Link リファレンス）の「エラーコード一覧」で **-501** を引く
  - 入手元: https://developer.jra-van.jp/ （ログインは ~/.claude/CLAUDE.md に記載）
  - SDK 同梱の「JV-Link インターフェース仕様書」内のエラーコード表
- -501 が「認証」「パラメータ」「サーバ」「セットアップ未実施」のどれ系かをまず確定する
- ★ ここを推測で飛ばすと前回と同じ失敗をする。必ず一次資料で確認。

### 手順1: option=4 の前提「セットアップ」が済んでいるか確認
- JV-Link の option=4（セットアップ）は、**JV-Link設定.exe で一度「セットアップ」を実行**
  していることが前提の可能性が高い（＝こちらの前提不足が原因かもしれない）
- `C:\Program Files (x86)\JRA-VAN\Data Lab\JV-Link設定.exe` を開き、
  「セットアップ」または「状態を取得する」を一度フォアグラウンドで実行する
  - 注: GUIクリックは Win32 SendMessage で自動化を試みる（過去 id=261 で実績あり）
  - それでもダメなら、ここだけは本人の手動クリックが要る場合がある（UAC同様のOS制約）

## こちら側の疑うべき点（チェックリスト・全部「自分のミス」前提で）

1. **option の使い方**: 4=セットアップが本当に dataspec=RACE で有効か。
   仕様書で「option=4 が使える dataspec」の一覧を確認。RACE が対象外なら別 dataspec が必要。
2. **fromtime の形式**: option=4（セットアップ）では fromtime の解釈が option=1/2 と違う可能性。
   セットアップは「全件」なので fromtime を空 or 別形式にすべきか仕様書で確認。
3. **dataspec の選び方**: 10年蓄積データは RACE 一発ではなく、蓄積系の専用 dataspec を順に
   叩く設計かもしれない。仕様書の「蓄積系データ」節を読む。
4. **JVOpen の引数順・戻り値**: jv_fetch.py:301 の
   `jv.JVOpen(args.dataspec, args.fromtime, opt, 0, 0, "")` が仕様書の順序と完全一致しているか
   再確認（特に option の型・位置・末尾引数）。
5. **利用キー**: PC1 のキー `3UJC-46WW-7VV1-T7RX-4` がレジストリ
   `HKCU\Software\JV-Link\ServiceKey` に正しく入っているか（過去に旧試用版の残骸で
   COM ルーティングが壊れていた前例あり → HKCU/HKCR の CLSID 登録も点検）。
6. **直前に JVClose し忘れ等で多重オープン状態**になっていないか。

## 確認に使うコマンド（通信あけに実行）

```powershell
# 接続そのものの確認（軽い）
py -3.12-32 jv_bridge\jv_fetch.py init

# rc=-501 を再現して、-501 が出る最小条件を特定
py -3.12-32 jv_bridge\jv_fetch.py aggregate --dataspec RACE --fromtime 20140101000000 --option 4

# 比較: option=2（毎時取得で実績あり）は通るはず → option だけが原因か切り分け
py -3.12-32 jv_bridge\jv_fetch.py aggregate --dataspec RACE --fromtime 20240101000000 --option 2
```

## 取れたあとの流れ（成功時）

1. `py -3.12-32 jv_bridge/build_all.py`（raw.bin → races/results JSON 展開）
2. `py -3.12-64 jv_bridge/aggregate_features_v2.py`（リークなし特徴量）
3. `py -3.12-64 jv_bridge/train_lightgbm.py` ＋ `--no-pop`（再学習）
4. `py -3.12-64 jv_bridge/walk_forward_value_ev.py`（リークなし採点データ再生成）
5. `py -3.12-64 jv_bridge/experiment_engine.py`（実験室を再採点）
6. commit + push → 実験室が「10年データ版」に育つ

## 人間（鈴木さん）に頼る可能性がある所

- JV-Link設定.exe の「セットアップ」がどうしても自動クリックできない場合の手動実行
- それでも -501 が解けない場合、JRA-VAN サポート（050-2031-3000 / office@jra-van.jp）に
  「過去10年の蓄積データを option=4 で取得したいが rc=-501 になる。正しい手順を教えてほしい」と相談
  （※あくまで「こちらの手順の誤りを教えてもらう」姿勢で。JRA-VANを責めない）
