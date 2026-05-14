# KEIBA NAVIGATOR (競馬)

期待値判定ダッシュボード。「買わないAI」コンセプト。長期で回収率100%超を目指す育つ系AI。

---

## 進捗（いまここ）

### ✅ 直近で済んだこと
- **🛡️ 入金前の事前準備を一気に完成** (2026-05-15):
  - **io_helpers** に `to_signed_int` (符号付き馬体重差) / `decode_track_code` (芝/ダ/障) /
    `decode_going/weather/sex` / `is_data_missing` (Z 埋め判定) を追加
  - **parse.py** に汎用 `parse_loop()` + `parse_win_odds_element()` を追加
    (O1 単勝オッズの馬番ループを仕様書なしでも構造的に処理可能)
  - **jvdata_struct.py** の O1 ヘッダ/O1_WIN_LOOP/HR_PAYOUT_LAYOUT を整理
    (確実な部分=tan/fuku は count/key_len 埋め込み、不確定な部分=馬連/三連単などは None)
  - **build_result_json.py** を完全実装: `parse_payout_block` / `parse_hr_payouts` (offset 表→dict) /
    `_shape_payouts` (finalize.js が読む形に整形) を追加。`build()` は payouts 既存形でも
    raw bytes + offset 形でも受け付ける2way 設計
  - **build_race_json.py**: バグ修正 (track_surface_label という未定義キー参照を解消し、
    track_code 経由で芝/ダを取り出すように)・surface を JSON に乗せる
  - **aggregate_features.py**: 「in_three (3着以内)」「人気区分」集計を追加 (今まで bug で未集計だった)。
    `jockey_in_three` / `trainer_in_three` / `popularity_band` を新規。features.json に
    `jockeyInThreeRate` / `trainerInThreeRate` を出力。これで複勝の期待値計算が正確になる
  - **jv_link_features.js**: `_meta` キーを race id として誤マッチする可能性を排除
  - **テストを 4 ファイル追加** (`test_io_helpers.py` / `test_build_result_json.py` /
    `test_parse_loop.py` / `test_end_to_end_synthetic.py`) — 仕様書転記前でも全部走る合成テスト。
    `0306` → `3-6` / `00060301` → `6-3-1` のような券種パースを E2E で検証
  - **SETUP.txt** を全面改訂: **「無料の開発者登録だけで完結する [A-1〜A-5]」と「月額契約が必要な [B-1〜B-6]」を明確に分離**。
    A-5 まで終われば 1 円も払わずに「あとは月額契約するだけ」状態が作れる
- **🛠️ 設計問題 C〜G を一括修正** (JV課金前の地盤固め):
  - **C**: `db/schema.sql` に `keiba.race_results` テーブル追加 / `lib/finalize.js` を
    Supabase 優先・ファイルフォールバックに書き換え → **本番Vercelからも結果照合可**
  - **D**: `lib/finalize.js` が単複だけでなく **馬連・ワイド・三連複・三連単** にも自動○×対応
  - **E**: `predictors/learner.js` の `computeCalibration` / `backtest` を**メモ化**
    (bets の末尾要素キーでキャッシュ判定) → 1000件超でも再計算なし
  - **F**: `lib/race_id.js` 新規 — `kind()` / `isJraRaceId()` / `parseJraRaceId()` /
    `labelOf()` で 18桁/`manual_xxx`/`demo_xxx` の判定を一元化。
    `finalize.js` は `isFinalizableRaceId()` で照合対象を絞る
  - **G**: `.githooks/pre-commit` 追加 — `data/jv_cache/raw_*.bin` などの
    JRA-VAN 規約違反になりうるファイルを git commit でブロック (`git config core.hooksPath .githooks` 適用済)
- **📘 Python 32bit インストール手順を `jv_bridge/SETUP.txt` に詳細化** (コピペで進められる)
- **🧮 集計レイヤを追加** (JV課金前の最重要ピース):
  - `db/schema.sql` に集計テーブル 4 つ追加:
    `jockey_stats` / `trainer_stats` / `horse_career` / `course_distance_stats` / `aggregate_meta`
  - `jv_bridge/aggregate_features.py`: 過去レース (`races/*.json` + `results/*.json`) を横断走査して
    騎手・調教師・コース別の勝率を集計し、`data/jv_cache/features.json` に書き出す
  - ベイジアン縮約 (k=20) でサンプル数が少ない時はベースラインに収束 → ノイズ耐性
  - `--push-supabase` オプションで Supabase テーブルにも UPSERT (任意・service_role 必要)
  - `tests/test_aggregate.py`: 縮約ロジック・集計・空入力・出力フォーマットの smoke テスト
  - **これで仕様書転記が終わったら即「騎手勝率」「コース別勝率」などが AI 補正に効くようになる**
- **🧰 JV-Link バイナリパーサの骨組み** (`jv_bridge/`):
  - `io_helpers.py`: SJIS デコード・固定小数 (例: '0032' → 3.2) などの共通変換
  - `jvdata_struct.py`: RA / SE / O1 / HR の Field 定義テーブル (offset/length は **TODO**)
  - `parse.py`: `parse_record(bytes) → dict` 汎用パーサ・`RECORD_COMPLETED` フラグで安全運転
  - `build_race_json.py` / `build_result_json.py`: RA+SE+O1 → races/, HR → results/ への組立
  - `tests/test_parse.py`: 仕様書未充填の間は自動 skip する smoke テスト
  - `fixtures/README.md`: 開発者登録 (無料) → SDK サンプル binary の置き場
  - **状態**: 仕様書 (JRA-VAN SDK 同梱) を入手して RA/SE の offset を埋めれば即動く所まで完成
- **📱 スマホ最適化＆通知**:
  - `sw.js` を新規作成 (Service Worker・オフライン起動・stale-while-revalidate)
  - 朝6〜12時にアプリを開くと「今日のベスト1」をローカル通知 (`maybeShowMorningNotification`)
  - 設定タブに「📱 通知」セクション追加 (ON/OFF・テスト送信)
  - iOS Safari 限定で「ホーム画面に追加」バナーを 1 回だけ表示
  - manifest に shortcuts 追加 (?view=best1 / ?tab=record)
- **💴 Kelly シミュレータ**: 比較タブに「実際 vs Kelly vs 等額」の3本線チャート + サマリ
- **🎯 騎手・調教師の相性**:
  - 手動入力に `馬名 オッズ 人気 前走 騎手 調教師` (騎手・調教師は任意) を吸収
  - 記録時に騎手・調教師を保存し、3件以上溜まった人を回収率順で表示
- **🏁 多レース横断ランキング** (`#card-saved-races`):
  - 手動入力で判定したレースを localStorage に自動保存 (当日 0 時以降のみ表示・上限30件)
  - 補正後 top EV の高い順にソート、トップに 🏆「今日のベスト1」バッジ
  - 行クリックで再ロード、× で削除、全消去ボタンあり
- **`lib/backtest.js`** 追加: 静的サマリ (今のAIで全件再評価・改善幅・判定変化・自然言語インサイト)
  - 時系列カーブ (`Learner.backtest`) と並立して compare タブに表示
- **🧪 バックテスト機能** (`Learner.backtest`): 過去記録を「今のAI」で再評価
  - 時系列順に過去だけから calibration を計算 (look-ahead 排除)
  - 補正前 (灰線) vs 補正後 (緑線) の累積収支を比較
  - 補正後 AI が見送りした位置を紫点で可視化
  - サマリーに採用/見送り件数・累計差・自然言語 verdict
- **記録タブに長期可視化を追加** (エア vs リアル):
  - 月次収支棒グラフ (直近12ヶ月)
  - 直近20件のローリング的中率 (AI 進化曲線)
  - グレード別の回収率差テーブル (10件以上のみ評価)
- **💴 Kelly基準の推奨金額**: pick_card に「いくら買うべきか」を自動表示
  - `lib/kelly.js`: Half Kelly (信頼度<0.20 は Quarter Kelly に切替・破産確率低減)
  - 期待値マイナスは ¥0 (買うな) を強く出す
  - 100円単位 floor、1日予算 × 1レース上限 でクリップ
  - 記録ボタンの初期金額もKelly推奨をプリセット
- **記録タブの結果入力UI**: 「結果待ち」記録に [○ 当たり] [× 外れ] ボタンを追加・払戻金入力・取り消しも可能
- **CSV インポート機能** (`lib/csv_import.js`): 既存の馬券簿 CSV を一括取り込み
  - UTF-8 BOM / Shift_JIS / UTF-8 自動判別
  - 列名ゆらぎ (date/日付/購入日, won/○/結果) 吸収
  - 設定タブから「サンプルDL → ファイル選択 → プレビュー → 確認」でコミット
- **無料路線で本格機能**: 「📝 手動でEVチェック」モード (JV-Link 不要)
- **学習結果の live UI 適用**: グレード別 calibration 倍率を picks の表示EVに反映 (n≥10で発火)
- **「AIが学んだこと」インサイト**: S/A/B/C/D 別に自然言語で表示
- 既存: Supabase keiba スキーマ、AI 育成レベル ★1-5、GitHub + Vercel 公開、catch-all集約

### 🟡 進行中
- なし

### 🔜 次の一歩 (0 円フェーズ → 月額フェーズ の順)

**フェーズ A (0 円・ここを完走しないと月額に進まない)**:
1. **JRA-VAN 開発者登録** (https://developer.jra-van.jp/ で無料登録)
2. **SDK ダウンロード** (https://jra-van.jp/dlb/sdv/sdk.html) → 仕様書 PDF と SampleData/*.bin が手に入る
3. **32bit Python 3.12 を入れる** → `py -3.12-32 -m pip install pywin32 pytest`
4. **仕様書を Claude に見せる** → `jvdata_struct.py` の RA/SE/HR の offset 表を 30 分〜1 時間で転記
5. **SampleData を `jv_bridge/fixtures/<RID>/sample_<RID>.bin` に配置**
6. `py -3.12-32 -m pytest jv_bridge/tests -q` が **全て passed** になったら **月額契約 GO サイン**

**フェーズ B (月額 2,090 円)**:
7. **Supabase に新スキーマ反映** (`db/schema.sql` を SQL Editor で再実行 — 集計テーブル 5 つ追加)
8. **JRA-VAN Data Lab. 契約** (https://jra-van.jp/dlb/) → 利用キー発行
9. **JV-Link 本体インストール** (SDK 同梱の JVLink_v4_xx.exe)
10. `py -3.12-32 jv_bridge\jv_fetch.py init` で接続テスト
11. `py -3.12-32 jv_bridge\jv_fetch.py aggregate --dataspec RACE --fromtime 20140101000000` で 10 年分取得
12. **本番で実運用テスト**: スマホで「ホーム画面に追加」→ 通知ON → 翌朝に「今日のベスト1」を確認
13. **手動入力の運用**: 末尾に騎手・調教師名を入れる癖をつけ、相性データを溜める

---

## 本番URL / 環境

- **本番（Vercel）**: https://keiba-navigator.vercel.app
- **GitHub**: https://github.com/shougihajime-eng/keiba-navigator
- **Vercel Dashboard**: https://vercel.com/shougihajime-3368s-projects/keiba-navigator
- **ローカル**: `npm start` で `http://127.0.0.1:8765`
- **PWA**: `manifest.json` 設定済。スマホで「ホーム画面に追加」可

注: 本番 (Vercel) では JV-Link は動作しない（JV-Link は Windows 32bit 専用）。
本番は「天気・ニュース・既存記録の閲覧と学習可視化」用。実データの取り込みはローカル PC で `jv_bridge/jv_fetch.py` を回し、`data/jv_cache/*.json` を git push すると Vercel にも反映できる構成。

## 技術構成

| 領域 | 内容 |
| --- | --- |
| フロント | バニラ JS + Tailwind CDN（`index.html` / `app.js` / `styles.css`） |
| サーバー | Node.js 標準 `http`（`server.js`）／本番は Vercel Functions（`api/*.js`） |
| 推定 | `predictors/heuristic_v1.js`（オッズ非依存）／後で LightGBM・DL に差替予定 |
| データ | `lib/jv_cache.js` → `data/jv_cache/*.json`（JV-Link Python ブリッジから書込） |
| 補助API | 気象庁（天気）／Google News RSS（ニュース） |
| 永続化 | Supabase `keiba` スキーマ（クラウド）＋ localStorage（フォールバック） |
| 認証 | Supabase Auth Magic Link（メールのみ） |

## 主要ドキュメント

| 場所 | 内容 |
| --- | --- |
| `db/schema.sql` | Supabase 用スキーマ定義（`keiba` 名前空間） |
| `jv_bridge/SETUP.txt` | JRA-VAN / JV-Link / 32bit Python の手順 |
| `predictors/features.js` | 馬1頭あたりの特徴量抽出ロジック |
| `lib/conclusion.js` | EV 計算と「狙う/見送り/普通」判定 |

## 検証コマンド

```powershell
# ローカル起動
npm start

# Supabase 接続確認 (anon でテーブルが見える=スキーマ公開OK)
curl "https://eqkaaohdbqefuszxwqzr.supabase.co/rest/v1/bets?select=id&limit=1" `
  -H "apikey: <CLAUDE.md anon key>" `
  -H "Accept-Profile: keiba"

# JV-Link 動作確認 (要 JRA-VAN契約)
py -3.12-32 jv_bridge\jv_fetch.py init
```

## 外部リソース

- **Supabase**: 共有プロジェクト `eqkaaohdbqefuszxwqzr`（~/.claude/CLAUDE.md 参照）
  - スキーマ: `keiba`（他プロジェクトのスキーマには触らない）
  - 公開状況: `keiba` を Exposed schemas に追加済
- **JRA-VAN**: 月額¥2,090（実データ取得のため契約必須）
- **JV-Link SDK**: Windows 32bit 専用

## 設計上の重要原則

1. **100%的中はあり得ない** ─ 競馬は確率事象。「絶対当たる」と謳わない
2. **長期で回収率100%超を目指す** ─ 期待値プラスの場面だけ買う・マイナスは見送り
3. **データが無い時は推奨しない** ─ 仮データでは記録ボタンが無効化される
4. **オッズに引きずられない** ─ 推定勝率はオッズを使わずに計算→EV =（推定勝率×オッズ）で評価
5. **学習する器を残す** ─ `learner_state` テーブル＋ `predictors/index.js` の差し替え機構で、JV-Link接続後に強い学習モデル（LightGBM・DL）へ無停止移行

## 禁止事項（このプロジェクト固有）

- 自動投票機能の実装（規約違反）
- JRA 公式サイトのスクレイピング（同上）
- service_role key の git コミット（共有 Supabase なので全プロジェクト被害）
- `public` スキーマや他プロジェクト（`hissatsu` / `kyotei_app` 等）のテーブルへの読み書き
