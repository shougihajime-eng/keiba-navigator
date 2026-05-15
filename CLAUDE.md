# KEIBA NAVIGATOR (競馬)

期待値判定ダッシュボード。「買わないAI」コンセプト。長期で回収率100%超を目指す育つ系AI。

---

## 進捗（いまここ）

### ✅ 直近で済んだこと
- **🌍 「世界一の競馬アプリ」へ全面磨き上げ (2026-05-15 夕)** — ユーザ離席中の自走で 5 波の機能投入:
  - **Wave 1**: 4 ステップのオンボーディング ツアー (光るスポット枠) / 🎙 音声で 1 頭追加 (Web Speech API ja-JP + 漢数字/かな数字パーサ) / 🔊 結論カードを読み上げ (Web Speech Synthesis) / 用語ツールチップ (`data-gloss` 23 語: EV/Kelly/単複連単/calibration/edge/stake/minev 等)
  - **Wave 2**: 🧠 AI 思考プロセス可視化 (6 ステップ縦タイムライン + 計算式の展開) / 📤 シェアボタン (テキスト) / `lib/reasoning.js` の純関数化 + smoke 12 ケース追加
  - **Wave 3**: 🎚 「もしも、条件が変わったら?」What-If シミュレータ (オッズ・推定勝率スライダーで EV メーターがリアルタイム動く) / 🌅 朝の概要カード (時間帯あいさつ + 開催日バッジ + 育成 Lv. + 直近回収率 + クイックアクションチップ) / 数字アニメーション (`animateNumber` + `flashHighlight`)
  - **Wave 4**: 🏅 達成バッジ 15 種 (`first_bet`/`hit_5_streak`/`profit_first`/`profit_10pct`/`tour_done`/`voice_used`/`share_done`/`level_5` 等) + 達成時の浮上バナー演出 / 📈 累積収支スパークライン (HiDPI / グラデ塗り)
  - **Wave 5**: 📸 シェア画像ジェネレータ (1080×1080 PNG・Canvas で AI 判定カードを自動生成 + Web Share API でファイル付き or ダウンロード)
  - **テスト**: `node tests/smoke.js` 29 → 57 ケース全通過 (音声パーサ 16 + reasoning 12)
  - **新規ファイル**: `lib/onboarding.js` / `voice_input.js` / `ai_voice.js` / `glossary.js` / `reasoning.js` / `whatif.js` / `daily_brief.js` / `animate.js` / `achievements.js` / `share_image.js` (10 モジュール / 約 1,800 行)
  - **CSS 追加**: 約 690 行 (各機能専用のコンポーネント + reduced-motion 対応)
  - **sw.js**: v3 → v7 にバンプ (Service Worker のキャッシュ更新を 4 波ぶん明示)
  - **JV-Link 登録の準備**: `JV-Link登録 (帰宅後にダブルクリック).bat` を同梱。利用キー `3UJC-46WW-7VV1-T7RX-4` は CLAUDE.md (グローバル本人用メモ) に保管済
- **🚀 妥協なし総合拡張 (2026-05-15 朝)** — 「最高のものを作れ」指示で 1 ターン完走:
  - **33 種類のレコードに対応** (RA/SE/O1-O6/HR/JG/TK/HC/WC/WH/WE/YS/UM/KS/CH/AV/RC/BR/BN/HN/SK/HS/HY/JC/TC/CC/DM/BT/CS)
  - **O2-O6 オッズ繰り返し領域** の parse_odds_element + 5 券種対応 (馬連/ワイド/馬単/3連複/3連単)
  - **TK の TOKUUMA_INFO ループ** (最大 300 頭/レース)
  - **WH の BATAIJYU_INFO ループ** (1 頭 45 バイト × 18 頭)
  - **build_race_json** に WH/UM/AV/JC/CC/TC 統合関数を追加 (apply_wh / apply_um / apply_av / apply_jc / apply_cc / apply_tc)
  - **build_result_json.from_se_list** で HR が無くても SE の確定着順から結果データを組立
  - **aggregate_features** に累計賞金 (careerPrizeJpy/Norm) と馬体重偏差 (bodyWeightDeviation) を追加
  - **scripts/fetch_tomorrow.py** が 9 種類の dataspec (0B31/0B14/0B15/0B16/0B17/0B20/0B30/0B11/0B12) を順次取得
  - **scripts/register_scheduler.ps1 + 自動実行を登録.bat** で土曜・日曜 8:30 自動実行登録
  - **smoke test 追加**: 33 レコード × 5 観点 + 共通 2 = **pytest 245 通過 / 6 skipped**
- **🏗️ JV-Link 接続成功 (2026-05-15)** — JRA-VAN 開発者向け試用機能で実データ取得実証:
  - JVInit OK / JVOpen 6 ファイルダウンロード / JVRead 522 レコード取得
  - jv_fetch.py: JVRead の戻り値タプル 3/4 両対応 + rc=-1 を正常終了として扱う改修
  - dataspec='RACE' 'TOKU' 'SLOP' 'WOOD' 'YSCH' で JG/TK/HC/WC/YS の実データ流入確認
  - 明日 5/16 のレース ID 37 件 (新潟/東京/京都) を `data/jv_cache/tomorrow_races.json` に保存
- **📘 仕様書転記完了 (2026-05-15)** — JRA-VAN 開発者登録 (無料) → SDK Ver4.9.0.2 ダウンロード →
  C# 構造体 `JV-Data構造体/C#版/JVData_Struct.cs` から RA/SE/O1/HR の全 offset/length を
  Python 側 `jvdata_struct.py` に**正式転記**:
  - `RECORD_COMPLETED` 全部 True / `SPEC_VERSION = "4.9.0.1"`
  - **RA** (1272B): grade_code / distance / track_code / weather / going_shiba / going_dirt
    / race_name (Hondai 60字) / Ryakusyo10/6/3 / hassou_time / toroku/syusso/nyusen_tosu
  - **SE** (555B): wakuban / umaban / 馬名 / 性齢 / 騎手8字略称 / 調教師8字略称
    / 負担重量 / 馬体重 / 増減符号 + 増減差 (符号付き) / 異常区分 / 確定着順 / 単勝オッズ / 人気
    / マイニング予想 (DM_*) / 脚質判定
  - **O1** (962B): ヘッダ + 単勝オッズ繰り返し (offset=43, 8B × 最大28頭)
    + 複勝 (267, 12B×28) + 枠連 (603, 9B×36)
  - **HR** (719B): 8 券種の offset 全部入り (tan@102 / fuku@141 / wakuren@206 / uren@245
    / wide@293 / utan@453 / fuku3@549 / tan3@603) — `HR_PAYOUT_LAYOUT` にデフォルト offset
  - `build_race_json.py` 改修: track_code 由来の going_shiba/dirt 自動切替、weight_diff の符号統合
  - `build_result_json.py` 改修: `parse_hr_payouts` がデフォルト offset で動くように
  - `test_parse.py` に転記完了確認テスト追加 (RA/SE/HR/O1 全部 `is_completed=True`)
  - `fixtures/README.md` を「SDK にサンプル無し・実取得が必要」と正確に書き直し
- **🔬 妥協なし総点検 (2026-05-15 夜・ユーザー就寝中)** — エージェント3台で全コードを深掘りレビューし、見つかった HIGH/MED 全部を修正:
  - **コア計算ロジック修正**:
    - `predictors/learner.js`: `nextLevelTarget` の OFF-BY-ONE バグ修正 (Lv5 で undefined を返していた)
    - `predictors/learner.js`: `computeCalibration` で `evSum` に NaN 時 1.0 を加算していた noise を排除
    - `lib/finalize.js`: 馬連/3連複/3連単で `exactTop3.length < 2 or 3` のとき undefined.number 参照で落ちるバグを修正
    - `lib/conclusion.js`: EV 計算前に `Number.isFinite` ガード追加、`prob*100` の NaN ガード
    - `lib/kelly.js`: `odds = 1.0` 近辺の浮動小数点誤差ガード (1+1e-6 以下は 0)、上限 1.0 クリップ
    - `lib/backtest.js`: `improvement` の NaN 伝播を `Number.isFinite` チェックでガード
    - `lib/manual_race.js`: `splice()` 副作用を排除し、純粋関数化。race_id にミリ秒+3桁ランダムサフィックスで衝突対策
    - `lib/race_id.js`: 新 race_id 形式 `manual_<ms>_<sfx>` を判定パターンに追加
    - `predictors/features.js`: `isValidHorseNumber()` 追加 (馬番 1-30 範囲チェック)
    - `lib/csv_import.js`: `parseType` 空欄時の "air" フォールバック挙動を明示コメント
  - **UI / フロント修正**:
    - `app.js`: `submitManual` で API JSON.parse 失敗時を `try-catch` で捕捉、`res.ok` チェック追加
    - `app.js`: 金額入力 `prompt` のキャンセル/空入力を分岐、全角数字・カンマ・円記号の正規化追加
    - `app.js`: `saveStore` の `QuotaExceededError` 時に古いバックアップキーを自動掃除して再試行
    - `sw.js`: app.js / styles.css / predictors/ / lib/ を **network-first** に変更 (デプロイ後の "古い app.js 残存" 防止)。`CACHE_VERSION` を v3 に
    - `index.html`: 設定タブの数値入力に `max` `maxlength` `inputmode` 追加。EV 用語ツールチップ `ⓘ` を追加
    - `styles.css`: `.settings-tip` クラス追加 (ツールチップ表示)。スマホ (480px 以下) で textarea 縮小
  - **サーバ・本番整合性修正**:
    - `lib/odds_movement.js`: Vercel 本番では `/tmp/keiba_odds_history/` に書き込み (best-effort・read-only FS 対策)
    - `lib/venues.js`: `__dirname` 起点を明示コメント化、読み込み失敗時に warn ログ
    - `lib/finalize.js`: Supabase fetch 失敗時のエラー詳細を `console.warn` で記録 (silent fail 解消)
    - `lib/jv_cache.js`: ENOENT 以外の readdir エラーをログ出力
    - `api/[...slug].js`: POST body JSON.parse 失敗時に 400 を返す (500 化を防ぐ)
    - `api/[...slug].js` / `server.js`: deprecated な `url.parse()` を WHATWG `URL` に置換 (Node 24 で DEP0169 警告解消)
    - `server.js`: `/api/result` `/api/finalize` を `async` 版に統一 (Supabase 経由が本番と同じ挙動)
    - `vercel.json`: `maxDuration` を 10 秒 → 30 秒 (天気10会場+ニュース同時呼び出しの timeout 防止)
    - `db/schema.sql`: `keiba.race_results` の RLS read ポリシーを `auth.role()='authenticated'` → `using (true)` に変更 (結果は公開情報・anon でも読める必要)
  - **テスト追加**: `tests/smoke.js` (Node 用・29 ケース全通過)。`npm test` でいつでも走る。
  - **本番動作確認**: ローカル `npm start` で全 API (status/venues/schedule/connection/conclusion-manual/finalize/race/races/result) を curl で叩いて 200/4xx/5xx すべて期待通り。不正 JSON は 400、データ未取得は 503、未知 race_id は 404
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
- なし (アプリは Wave 5 まで仕上げ済・あとは本人の物理アクション待ち)

### 🔜 次の一歩 (0 円フェーズ → 月額フェーズ の順)

**フェーズ A (0 円)** — ✅ **完走**:
1. ✅ JRA-VAN 開発者登録 (無料) — 完了 (`oneone` / 2026-05-15)
2. ✅ SDK ダウンロード — `JVDTLABSDK4902.zip` を取得済み
3. ✅ 仕様書転記 — C# 構造体から RA/SE/O1/HR 全 offset を `jvdata_struct.py` に転記済み
4. ✅ **32bit Python 3.12.4 インストール** (`C:\Users\shoug\AppData\Local\Programs\Python\Python312-32\python.exe`)
5. ✅ pytest 9.0.3 + pywin32 311 をインストール
6. ✅ **pytest: 64 passed / 6 skipped / 0 failed** (skip 6 件は JV-Link 実バイナリ依存・月額契約後に自動緑化)
   → **🚦 月額契約 GO サイン点灯**

**フェーズ B (月額 2,090 円)** — ✅ **契約完了 (2026-05-15)**:
6. ✅ **Supabase スキーマ反映完了** (2026-05-15・Management API 経由で `db/schema.sql` を直接実行)
7. ✅ **JRA-VAN Data Lab. 契約完了** (2026-05-15・利用キー `3UJC-46WW-7VV1-T7RX-4` 取得済)
8. 🟡 **JV-Link 本体の COM 登録** (本人作業) ← **次にやる**
   - 帰宅後 `C:\Users\shoug\競馬\JV-Link登録 (帰宅後にダブルクリック).bat` をダブルクリック
   - UAC で「はい」→ COM 登録 → JV-Link 設定画面が自動で開く → 利用キー貼り付け
9. `py -3.12-32 jv_bridge\jv_fetch.py init` で接続テスト
10. `py -3.12-32 jv_bridge\jv_fetch.py aggregate --dataspec RACE --fromtime 20140101000000` で 10 年分取得
11. **本番で実運用テスト**: スマホで「ホーム画面に追加」→ 通知ON → 翌朝に「今日のベスト1」を確認
12. **手動入力の運用**: 末尾に騎手・調教師名を入れる癖をつけ、相性データを溜める

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
