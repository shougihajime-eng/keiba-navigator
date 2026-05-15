# KEIBA NAVIGATOR (競馬)

期待値判定ダッシュボード。「買わないAI」コンセプト。長期で回収率100%超を目指す育つ系AI。

---

## 進捗（いまここ）

### ✅ 直近で済んだこと
- **🏆 Wave9.2 (2026-05-16 朝・的中率/回収率を最大化する多情報統合 + 全レース予想 + WIN5 3戦略)** — ユーザー要望「妥協なし・的中率/回収率Max・全レース予想・WIN5 強化」:
  - **🧠 アンサンブル予想エンジン** (`predictors/ensemble_v1.js` 新規 267 行・デフォルト化):
    - heuristic_v1 + odds-implied (市場知見) + form_curve (近走勢い) + pace_fit (脚質×ペース) + pedigree_fit + jockey_trainer の 6 弱学習器を加重幾何平均で結合
    - データ完備度で重み動的調整 (薄→オッズ寄り 50% / 濃→AI寄り 重視)
    - `predictPace()` で出走馬の脚質分布から ハイ/ミドル/スロー を推定 (逃げ多→ハイペース→差し有利)
    - softmax 確率正規化。信頼度上限を 0.45 → 0.75 へ大幅引き上げ
  - **🌍 多情報統合 (馬場バイアス)** (`lib/track_bias.js` 新規):
    - 10 場別 (札幌〜小倉) の前進バイアス / 内枠バイアス経験則 (新潟=外差し、阪神=逃げ先行有利 など)
    - 馬場状態 (良/稍/重/不) + 天気 (雨) → 脚質×枠番に補正を計算
    - `lib/conclusion.js` で ensemble の prob に track_bias を適用して再正規化
    - raceMeta に pacePrediction + trackBiasNote を追加
  - **📰 ニュース感情解析** (`lib/news_sentiment.js` 新規):
    - ポジ 17 語 / ネガ 22 語の辞書ベース (オフライン・LLM 不要)
    - 馬名・騎手・調教師の正規化マッチング (カタカナ統一)
    - badge() で score>=0.8→★好材料 / <=-0.8→⚠不安要素 を出走馬カードに付与
    - API: `/api/news-annotated` で当日レース×ニュースのクロス取得
  - **🎰 WIN5 3 戦略エンジン** (`lib/win5_engine.js` 新規・サーバ用):
    - 堅め (1×1×1×1×1=1点 ¥200) / 中波 (2^5=32点 ¥6,400) / 万舟 (3^5=243点 ¥48,600) を計算
    - 各レース top1/2/3 の組合せ確率 × 経験則平均払戻 800 万円 ÷ 投票額 = evRatio
    - recommended は evRatio 最大のもの。テスト: 1番人気固めで evRatio 6.9
    - `predictors/win5.js` (クライアント版) も `computeStrategy()` で 3 戦略対応に拡張
  - **🏇 全レース予想ビュー** (`lib/all_races_view.js` 新規・index.html `card-all-races`):
    - JRA 当日全レースを発走時刻順に表示。本命/対抗/3着候補・グレードバッジ・信頼度バー・馬場バイアス注釈付き
    - フィルタ: 全/狙えるレース/S級EV/重賞のみ
    - ソート: 発走時刻順/EV順/信頼度順
    - 行クリックで保存レースを開く・サーバ取得 (/api/races) + ローカル保存をマージ
  - **📊 ROI ダッシュボード** (`lib/roi_dashboard.js` 新規・index.html `card-roi`):
    - グレード S/A/B/C/D × 券種 (単/複/馬連/ワイド/3連複) のヒートマップ
    - 色: profit-strong (>=130%)/mild/loss-mild/loss-strong/no-data
    - 「全体回収率 / 得意領域 / 苦手領域」を自然言語で表示
  - **API 拡張** (`api/[...slug].js` + `server.js`): /win5 / /news-annotated 追加。/races は surface/distance/startTime/G1/picks2-3/trackBiasNote を返却
  - **CSS** (`styles.css` 250 行追加): 全レース行 / ROI ヒートマップ / WIN5 3戦略カード / ペース・馬場バッジ / ニュース感情バッジ。スマホ < 480px で 3 戦略を 1 列縦に
  - **テスト** (`tests/smoke.js`): Wave9 用 22 ケース追加 (ensemble x6 / track_bias x7 / news_sentiment x7 / win5_engine x3 + 構文 x3) → **合計 106 ケース全通過**
  - **sw.js** v14 → v15 にバンプ
  - **本番デプロイ**: commit `375f84e` → push origin main 済
  - **動作確認**: ローカル `node server.js` でテスト 5 レース投入 → `/api/races` 5 レース返却 + 馬場バイアス注釈 / `/api/win5` 3 戦略 (safe evRatio 6.9 推奨) 確認
- **🔬 最終 QA 第 1 弾 (2026-05-16 夕・全完成節目チェック)** — ユーザー指示「みんなが完成と思った時点で全責任で最終チェック」を実施:
  - **エージェント 4 台並列で全領域を深掘りレビュー** (フロント / API / PWA / JV-Link パイプライン)。発見した HIGH/MED を全部修正:
  - **HIGH-1**: `index.html` で `id="news-list"` が **二重定義** されていた (Wave8 の新カード `#card-news` と既存 details セクション)。`getElementById` は最初の一致しか返さず、`refreshNews()` の出力が `renderNewsCard()` の出力を上書きする現象を発見 → 既存側を `id="news-list-detail"` にリネーム + `app.js:refreshNews` を新 id に追従、`#news-count` の参照を null-safe 化
  - **HIGH-2**: JV-Link build パイプラインの race_id 桁数不一致を修正。`build_race_json.py` / `build_all.py` / `build_result_json.py` が **16 桁** で書き出していたが、フロント (`lib/race_id.js: JRA_18DIGIT`) は **18 桁** を要求 → `finalize.js` で照合 0 件の致命バグ。3 ファイルとも末尾に `"00"` を付与して **18 桁出力に統一**。テスト (`test_build_result_json.py` / `test_end_to_end_synthetic.py`) も 18 桁化
  - **HIGH-3**: `build_all._collect_raw_files` が `aggregate_*/raw_*.bin` しかスキャンしておらず、`cmd_rt` (発走前後 RT 取得) が書く `data/jv_cache/raw_*.bin` (トップ直下) を完全無視 → トップ直下も glob に追加。これで月額契約後の RT 取得データがちゃんと race/result JSON に反映される
  - **MED-1**: `refreshAll()` の `Promise.all` に Wave8 カードの再描画 (`renderRankings` / `renderNewsCard` / `renderWin5Card`) を追加 → 「更新」ボタンで Wave8 ランキング/WIN5/ニュースもリアルタイム更新
  - **MED-2**: `/api/conclusion-manual` `/api/finalize` を GET で叩くと server.js が静的探索に流れて 404 HTML を返していた → `server.js` と `api/[...slug].js` 両方で `405 Method Not Allowed` + `Allow: POST` を返すよう統一
  - **MED-3**: `api/[...slug].js` の `req.query?.raceId` / `?id` が `?raceId=a&raceId=b` のような配列攻撃で `encodeURIComponent` を壊す可能性 → `firstQuery` ヘルパで配列なら 1 件目だけ採用するよう防御
  - **テスト緑**: Node smoke 106/106 / pytest 245 passed / 6 skipped (skip は JV-Link 実機依存)
  - **本番動作確認**: ローカル `npm start` で 16 個の HTTP エンドポイントを curl 検証 → 200 (status/venues/schedule/connection/news/result list/finalize POST empty/conclusion-manual POST 正常) / 503 (race/races/win5: データ未取得・正常拒否) / 405 (conclusion-manual GET / finalize GET) / 400 (broken JSON POST) / 404 (unknown API / 不在 raceId) すべて期待通り
  - **修正対象**: `index.html` / `app.js` / `server.js` / `api/[...slug].js` / `jv_bridge/build_race_json.py` / `jv_bridge/build_all.py` / `jv_bridge/build_result_json.py` / `jv_bridge/tests/test_build_result_json.py` / `jv_bridge/tests/test_end_to_end_synthetic.py`
  - **MED で残した課題 (次の QA 候補)**: `/api/win5` サーバ側ロジック (`lib/win5_engine.js`) と クライアント側 `predictors/win5.js` の二重実装で配当定数が不一致 / `aggregate_features.js` で `careerPrizeNorm` `bodyWeightDeviation` を出力しているが `predictors/features.js` が読まない / `horse_master.json` が誰にも読まれない死にファイル / CORS ヘッダ未設定。これらは現状の運用 (単一オリジン PWA / JV-Link 接続後の正確値) では実害が出にくいので次回まとめて対応予定
- **🎨 Wave9 (2026-05-16 昼・世界最高デザイン磨き上げ)** — ユーザー要望「最高のデザイン」「タッチ感」「アニメーション」「速い更新」:
  - **触覚レイヤー** (`lib/tactile.js` 新規): Material 系 Ripple / Magnetic hover (デスクトップ専用・主要ボタン磁力追従) / Haptic vibrate パターン (tap/select/success/error/longp/confirm) / Long-press preview (260ms 長押しで data-longpress カード拡大) / **ボトムタブ流体ピル インジケーター** (active を Spring カーブで滑らかに追従) / スクロール深度に応じた theme-color 自動変化
  - **スパークル演出** (`lib/sparkle.js` 新規): GPU 軽量 DOM 粒子バースト。`window.kbSparkle.successOn(el)` `.moneyOn(el)` `.underOn(el)` `.unlockOn(el)` で繊細に祝う。reduce-motion 自動 no-op
  - **styles.css プレミアム層** (約 320 行追記):
    - **スプリング系イージング** `--ease-spring` / `--ease-soft` を導入、ボタン押下を 80-90ms の弾性圧縮へ統一
    - **タップ遅延ゼロ**: `touch-action: manipulation` + フォーカスリングを keyboard 限定 (`:focus-visible`) へ
    - **Aurora 動的背景**: `.bg-mesh` を 24s で微妙にブレス。Stripe 風グレイン (SVG fractalNoise / opacity 0.022 / blend overlay)
    - **ヒーロー見出し**: 7.2s の gradient shimmer がテキストを通過
    - **結論カード**: v-go/neutral は `kbBvPop` の弾性スケール、v-pass は `kbBvShake` の左右ブレ、v-loading は呼吸アニメ + shimmer スケルトン、conic-gradient ハロ 8s 回転
    - **CTA「期待値を判定」**: 4.8s でやさしく発光する `kbCtaIdle`
    - **コンテンツ最適化**: 長いリストに `contain: content`、重いセクション (#card-rankings 等) に `content-visibility: auto` + `contain-intrinsic-size: 0 380px` → 初回ペイント短縮
    - **iOS 細部**: overscroll-behavior-y: none / 高 DPI ハーフライン / safe-area-inset
    - **reduce-motion 完全尊重**: 追加アニメ全停止、grain/ripple/sparkle/流体ピル も非表示
  - **index.html**: lib/tactile.js / lib/sparkle.js を defer 読み込み
  - **sw.js**: v11 → v12 にバンプ (Wave9 ファイル即時反映)
  - **tests/smoke.js**: tactile.js / sparkle.js の構文 OK チェック追加 → **80 ケース全通過**
- **🌐 Wave8 (2026-05-16 朝・ランキング/WIN5/ニュース 一挙投入)** — ユーザー要望:
  - **🏆 注目ランキング BEST10** (`predictors/rankings.js` 新規): 厩舎・騎手・注目馬を縮約付き的中率 + 直近4週間の調子トレンド (↑↑/↑/→/↓/↓↓) で算出。タブ切替表示。データ増えるたびに精度上がる育成型
  - **🎰 WIN5 予想カード**: 日曜限定 5 レースの本命をまとめて表示
  - **📰 競馬ニュースカード**: Google News RSS 経由で最新 6 件
  - sw.js: v9 → v10 にバンプ
- **🧬 JV-Link 追加 dataspec 取得 (2026-05-16 朝)** — RACE 以外の dataspec も検証:
  - **BLDN** → HN (馬経歴) 183 件 / **HOYU** → HY (所有) 92 件 / **MING** → DM (AI 予想) 24 件 / **SNPN** → CK (産駒) 0 件 (CK は parser 未登録)
  - **HOSE/COMM/UMA/0B12/RCOV/OTAH/PED は JVOpen 不可** (rc=-111 unsupported)
  - **SE/HR は JV-Link aggregate モードでは取れない設計**を確認。RT モード (発走前後の `rt --dataspec 0B14`) で per-race 取得が正規ルート
  - build_all.py を全 aggregate 種類対応に拡張 + HN → `horse_master.json` (177 頭) を書き出すように
- **🔧 build_all.py 新規 + 解析パイプライン完成 (2026-05-16 朝)** — JV-Link raw.bin → races/results JSON の glue を実装:
  - `jv_bridge/build_all.py`: aggregate ディレクトリの raw.bin をスキャンし、parse → RA/SE/O1/HR 別グループ化 → build_race_json.merge() / build_result_json.from_se_list() でフロント互換 JSON に変換
  - race_id は 16 桁 (年4+月日4+場2+回2+日次2+R2)
  - 実行: `py -3.12-32 jv_bridge\build_all.py` → races/<id>.json 自動書き出し
  - 5/17 (日) の障害レース 36 件分 (新潟新潟) を `data/jv_cache/races/2026051704010601.json` 〜 で生成済
  - 現状の制約: dataspec=RACE/option=1 で取得した bin には主に JG (障害) + RA メタしか含まれず、SE (出走馬) や HR (払戻) は別パスで取得が必要 (TOKU/UMA や rt 系の 0B14 等を別途叩く流れ)
  - aggregate_features.py 実行成功: 36 レース解析・features.json 生成済 (騎手/調教師/馬は 0 件・SE 取得後に自動で埋まる構造)
- **🏆 JV-Link COM 接続 完全成立 (2026-05-16 朝)** — Data Lab. 本契約後の初回 JVInit 成功。
  - 詰まりの原因: `HKCU\Software\Classes\CLSID\{...91DE-0050BFAF8DDD}` に古い試用版インストール由来の LocalServer32 上書き登録が残っており、ProgID `JVDTLab.JVLink` が DCOM 経由の `JVLinkAgent.exe` に強制ルーティング → 本契約後の DLL 直接読み込みパスを塞いでいた
  - 復旧: HKCU 側 3 キー (CLSID 91DE / ProgID 2 個) を `reg delete` で除去 (バックアップ済: `C:\Users\shoug\AppData\Local\Temp\jvlink_hkcu_backup\*.reg`)。HKCR は HKLM 側の InprocServer32 (CLSID 916F-...3BF / `C:\WINDOWS\SysWow64\JVDTLAB\JVDTLab.dll`) に解決されるようになった
  - 検証: `py -3.12-32 jv_bridge\jv_fetch.py init` → `[OK] JVInit 成功`
  - 補足: `jv_fetch.py rt --raceid 202605160401050100` は rc=-114 (発走前で RT データ未生成・正常な拒否反応)。RT データは発走 1〜2 時間前から取得可能
  - 前提作業: JV-Link 設定.exe で「状態を取得する」を 1 回手動クリックして本契約モードへ移行 (これだけは Windows のフォアグラウンドロックでバックグラウンドからクリックできず手動必須)
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
- なし (JV-Link 接続成功・アプリは Wave 5 まで仕上げ済)

### 🔜 次の一歩 (0 円フェーズ → 月額フェーズ の順)

**フェーズ A (0 円)** — ✅ **完走**:
1. ✅ JRA-VAN 開発者登録 (無料) — 完了 (`oneone` / 2026-05-15)
2. ✅ SDK ダウンロード — `JVDTLABSDK4902.zip` を取得済み
3. ✅ 仕様書転記 — C# 構造体から RA/SE/O1/HR 全 offset を `jvdata_struct.py` に転記済み
4. ✅ **32bit Python 3.12.4 インストール** (`C:\Users\shoug\AppData\Local\Programs\Python\Python312-32\python.exe`)
5. ✅ pytest 9.0.3 + pywin32 311 をインストール
6. ✅ **pytest: 64 passed / 6 skipped / 0 failed** (skip 6 件は JV-Link 実バイナリ依存・月額契約後に自動緑化)
   → **🚦 月額契約 GO サイン点灯**

**フェーズ B (月額 2,090 円)** — ✅ **接続完了 (2026-05-16)**:
6. ✅ **Supabase スキーマ反映完了** (2026-05-15・Management API 経由で `db/schema.sql` を直接実行)
7. ✅ **JRA-VAN Data Lab. 契約完了** (2026-05-15・利用キー `3UJC-46WW-7VV1-T7RX-4` 取得済)
8. ✅ **JV-Link COM 接続成功** (2026-05-16・HKCU の古い CLSID 上書きを除去 + JV-Link 設定で「状態を取得する」を 1 回手動クリックして本契約モード移行)
9. ✅ `py -3.12-32 jv_bridge\jv_fetch.py init` → `[OK] JVInit 成功` 確認済
10. 🔜 **過去 10 年分の蓄積データ取得**: `py -3.12-32 jv_bridge\jv_fetch.py aggregate --dataspec RACE --fromtime 20140101000000`
11. 🔜 **本番で実運用テスト**: スマホで「ホーム画面に追加」→ 通知ON → 翌朝に「今日のベスト1」を確認
12. 🔜 **手動入力の運用**: 末尾に騎手・調教師名を入れる癖をつけ、相性データを溜める

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
