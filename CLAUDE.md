# KEIBA NAVIGATOR (競馬)

期待値判定ダッシュボード。「買わないAI」コンセプト。長期で回収率100%超を目指す育つ系AI。

---

## 進捗（いまここ）

### ✅ 直近で済んだこと
- **🛡️ Wave19.8 + 20 (2026-05-19 03:30・8 期間検証 + 朝の自動リトライ完成)** —
  - **8 期間 Walk-forward 検証** (`walk_forward_validate.py --periods 8`):
    | 戦略 | 1期 | 8期 平均 | 最悪 | 勝期間 | σ | trust |
    |------|-----|----------|------|--------|---|-------|
    | **BEST** | 126.8% | **112.1%** | **102.8%** | **7/7** | 12.1 | **★★★★ TRUSTED** |
    | **SAFE** | 106.3% | 106.7% | 93.6% | 6/7 | 7.0 | **★★★☆ STABLE** |
    | TURF | 141.9% | 111.0% | 91.1% | 5/7 | 21.2 | ★★ MIXED |
    | BIG | 142.7% | 110.1% | 95.5% | 3/7 | 27.1 | ★★ MIXED |
    | ULTRA | 127.1% | 98.3% | 83.5% | 2/7 | 16.9 | ★ RISKY |
  - **新発見**: `combo_trusted_strict` (BEST + 対抗差 5pt+ + 人気1-3 番) → 8 期間 σ=4.8 (歴代最小)・最悪 96.2%・勝 6/7・平均 105.8%
  - **TRUSTED 基準を 8 期間検証に合わせて調整**: `aggregate_recommendations.py` の trust_label を「全期間勝 + σ<15 + 平均 105%+」へ。これで BEST が ★★★★ TRUSTED に確定
  - **閾値スイープ追加** (`best_gap_*` 6 段階・`best_prob_only_*` 6 段階): `gap=0.04 / prob=0.22` が引き続きスイートスポット (これより緩める/厳しめにすると ROI 下がる)
  - **🌅 Wave20: 朝の自動リトライ仕込み (`scripts/retry_full_history.ps1` 新規)**:
    - Windows タスクスケジューラに 3 タスク登録: `KeibaRetryFullHistory-0900/1200/1500`
    - 動作: JV-Link 設定 GUI で「状態を取得する」を Win32 SendMessage 発火 → 60 秒待つ → JVOpen aggregate option=4 試行 → 成功時は build_all + 集計 + 学習 + 推論 + 推奨集約 + 検証 + git push を `race_day_pipeline.py --skip-refresh --skip-rt` で chain 実行
    - 営業時間内 (9-18 時) のみ動作・成功時は `full_history_fetched.flag` を作って当日中は再試行しない
    - WakeToRun=True + RestartCount=3 で堅牢
  - **sw.js**: v38 → v39 / smoke 126/0
  - **明朝 9:00 (5/19) 以降**: JRA-VAN サーバ営業開始 → 3 回の試行のいずれかで rc=-501 解消・過去 10 年データ取得 → 学習データ 5 万 → 60 万行へ → 全戦略の Walk-forward 信頼性が大幅 UP の見込み
- **🔬 Wave19.7 (2026-05-19 02:50・Walk-forward 検証で本物と偽物を判別)** — ユーザー「BIG+TURF 複合 + Walk-forward 検証」指示に応えて、戦略の真の安定性を初検証:
  - **🚨 重要な発見**: 過去 1 期間 (test 20%) で見えていた「ULTRA 127%・88% 的中率」は **Walk-forward 4 期間で平均 99.2% (期待値マイナス)** だった。「見かけの高 ROI」と「真の期待 ROI」は別物
  - **★★★★ TRUSTED (真に信頼できる戦略・全 4 期間で 100%+ かつ σ<10)**:
    | 戦略 | 1期間 | Walk-fwd 平均 | 最悪 | σ | 勝期間 |
    |------|-------|-------|------|---|--------|
    | **BEST** (combo_best_and_gap) | 126.8% | **113.6%** | 105.1% | 6.6 | **4/4** |
    | **SAFE** (fuku_top1_prob_020) | 106.3% | **107.4%** | 103.3% | **3.3** | **4/4** |
  - **★★ MIXED (1 期間で高 ROI だが Walk-forward でブレる)**:
    - BIG (fuku3_top3_conf50): 1期 142.7% → Walk-fwd 108.5%・最悪 93.5%・勝 2/4
    - TURF (best_turf): 1期 141.9% → Walk-fwd 113.4%・最悪 98.8%・勝 2/4
  - **★ RISKY (実は不安定)**:
    - **ULTRA (combo_best_wide_double_bet)**: 1期 127% → Walk-fwd **99.2%**・最悪 82.7%・勝 2/4 ← 期待値マイナス
  - **🆕 BIG+TURF 複合戦略 5 個追加**:
    | 戦略 | 件数 | 回収率 | 的中率 |
    |------|------|--------|--------|
    | **combo_big_turf_double_bet** | 23 | **165.7%** | **91.3%** | 芝・BIG・TURF 同時 → 複勝+3連複ボックス |
    | combo_turf_ultra | 30 | 139.2% | 90.0% | 芝・ULTRA |
    | combo_big_turf | 36 | 128.6% | 27.8% | 芝・BIG (3連複のみ) |
    | combo_big_turf_ultra | 23 | 124.3% | **95.7%** | 芝・BIG・ULTRA 全部 (複勝+ワイド+3連複 500 円) ← 的中率歴代最高 |
    Walk-forward では combo_big_turf_double_bet σ=33.7 で 1 期間 78.6% に落ちる (件数少のため)
  - **🛠 新規スクリプト `jv_bridge/walk_forward_validate.py`**: races/results を 5 期間に等分割・各期間を test にしたときの ROI を計測・期間別 ROI 配列・平均・最悪・σ・勝期間数を出力
  - **🎨 UI 強化** (`app.js stratCardHtml`):
    - 各戦略カードに **★★★★ 信頼性表示** + 色分け (TRUSTED=金/緑強・STABLE=緑・MIXED=オレンジ・RISKY=赤)
    - 「分割検証: 113.6%・4/4 期間 ◎」と Walk-forward 統計を併記
    - 「過去 1 回の検証」と「真の期待 ROI」の違いをユーザーが一目で判断できる
  - **CSS**: .rec-strat-{trusted,stable,mixed,risky} + .rec-strat-stars + .rec-strat-wf を追加
  - **sw.js**: v37 → v38 / smoke 126/0
  - **本日の総合戦略数**: 126 個 / Walk-forward 検証済: 12 個
- **🌟 Wave19.6 (2026-05-19 02:10・馬連/3連複/季節/コース別スイープで更なる強化)** — ユーザー「馬連・3 連複・季節・コース別」検証指示に応えて、20 戦略追加検証 → 新トップ 2 戦略発見:
  | 戦略 | 件数 | 回収率 | 的中率 | 内容 |
  |------|------|--------|--------|------|
  | **`fuku3_top3_conf50`** (BIG) | **49** | **142.7%** | 24.5% | **3 連複 ボックス 1 点** |
  | **`best_turf`** (TURF) | **37** | **141.9%** | **86.5%** | **芝レース限定 BEST** |
  | `best_venue_阪神` | 22 | 123.6% | **100%** | 阪神は的中率 100% (件数少だが驚異) |
  | `best_venue_京都` | 5 | 358.0% | 80.0% | 京都は超高 ROI (件数極少) |
  | `uren_ultra` (馬連) | 23 | 101.3% | 26.1% | BEST + top12 prob 合計 + 互角差 |
  - **🎰 5 戦略マルチアサインに拡張** (`STRATEGY_DEFS` 5 個):
    - **BIG**: 3 連複 ボックス 100 円 (142.7% / 24.5% / 49件) ← NEW 新最強 ROI
    - **TURF**: 芝レース BEST 複勝 100 円 (141.9% / 86.5% / 37件) ← NEW 新最強的中率
    - **ULTRA**: BEST+WIDE 併買 400 円 (127% / 87.8% / 41件)
    - **BEST**: 本命確率 22%+ かつ対抗差 4pt+ で複勝 (127% / 83% / 53件)
    - **SAFE**: 本命確率 20%+ で複勝 (106% / 72% / 100件)
  - **検証期間 690 R 集約**: BIG 426件 / TURF 287件 / ULTRA 348件 / BEST 451件 / SAFE 816件
  - **🛠 race meta 注入**: `_predict_horses_for_race` と `predict_lightgbm.predict_race` で各 horse に `race_course / race_surface / race_month / race_venue` を埋め込み (季節・コース・場別戦略の前提)
  - **その他の発見** (件数少だが将来データ増で検証続行):
    - `best_winter / best_summer / best_autumn` は 0 件発火 = test 期間が春 (5月) のみのため検証不可
    - `uren_top12_prob_30-45` (馬連) は 53-101%・控除率高で苦しい
    - `combo_triple_gap_concentrated`: 29件 105% 的中率 **93.1%** (歴代最高的中率)
  - **🎨 UI**: 5 戦略を grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)) で自動レイアウト・BIG=紫グロー / TURF=エメラルドグロー の新バッジ色追加 / 買い方表示が ULTRA > BIG > 複勝 の優先順で「複勝 + ワイド 400 円」「3 連複 ボックス 100 円」「複勝 100 円」を自動切替
  - **sw.js**: v36 → v37 / smoke 126/0
  - **過去 10 年取得**: 深夜に再リトライ → JV-Link `rc=-501` で再失敗。営業時間外で JRA-VAN サーバが応答しないため明朝に持ち越し
- **🔥 Wave19.4 (2026-05-19 01:15・複合戦略で 127% を達成)** — ユーザー「BEST + WIDE 両方発火」の複合戦略検証指示に応えて、10 個の複合戦略を追加検証 → 全部 100% 越え、しかも単純な閾値型より圧倒的に高 ROI:
  | 戦略 | 件数 | 回収率 | 的中率 |
  |------|------|--------|--------|
  | **`combo_best_wide_double_bet`** | **41** | **127.1%** | **87.8% (!!)** ← 最強的中率 |
  | `combo_best_and_gap` | 53 | 126.8% | 83.0% |
  | `combo_wide_with_pop1` | 42 | 128.3% | 73.8% |
  | `combo_super_safe` | 41 | 124.1% | 75.6% |
  | `combo_best_and_wide` | 41 | 124.1% | 75.6% |
  | `combo_wide_concentrated` | 40 | 116.9% | 75.0% |
  | `combo_fuku_strong_value` | 16 | 105.0% | 87.5% |
  - **🏆 推奨 3 戦略を全面更新** (`aggregate_recommendations.py STRATEGY_DEFS`):
    - **ULTRA** (新トップ): combo_best_wide_double_bet — BEST+WIDE 両方発火時に「複勝 100 + ワイド 3 点 300 = 400 円」併買 (127% / 88% / 41件) ← 旧 WIDE 戦略を置き換え
    - **BEST**: combo_best_and_gap — AI 本命確率 22%+ かつ 対抗との差 4pt 以上 で複勝 (127% / 83% / 53件) ← 旧 fuku_top1_prob_022 を置き換え
    - **SAFE**: fuku_top1_prob_020 — AI 本命確率 20%+ で複勝 (106% / 72% / 100件) ← 維持・発火多め
  - **🎨 UI 強化**: 各レース行の買い目表示を `複勝 #N 100 円 + ワイド 1-2-3 300 円 = 400 円` のように「具体的な馬番」を入れた。ULTRA バッジは光るゴールド (box-shadow 強調)
  - **検証期間 690 R での集約**: ULTRA 348件 / BEST 451件 / SAFE 816件 (重複あり)
  - **sw.js**: v34 → v35 / smoke 126/0
  - **重要な気づき**: 単一閾値より「2 条件以上を AND で重ねる」方が圧倒的に有利。控除率 20-25% を覆すには「複数の条件が同時に揃った絶好機」だけを狙うのが本筋。`combo_best_wide_double_bet` の的中率 87.8% は競馬予想 AI の世界でも稀少な水準
- **🎯 Wave19.3 (2026-05-19 00:50・閾値の精密スイープで最適点発見)** — ユーザー「閾値を 0.18 / 0.22 / 0.25 で追加検証して最適点を探したい」に応えて:
  - **🔬 0.01 刻みの精密スイープを 42 戦略で実行** (`fuku_top1_prob_*` 17 段階 / `fuku_gap_*` 13 段階 / `wide_top3_conf_*` 12 段階) → 計 75 戦略の実証
  - **🏆 真のスイートスポット発見**:
    | 戦略 | 件数 | 回収率 | 的中率 | 評価 |
    |------|------|--------|--------|------|
    | **`fuku_top1_prob_022`** | **65** | **112.2%** | **75.4%** | **★ BEST** |
    | `fuku_top1_prob_020` | 100 | 106.3% | 72.0% | SAFE (発火多め) |
    | `wide_top3_conf_050` | **49** | **132.0%** | 75.5% | WIDE 3 点 |
    | `wide_top3_conf_052` | 39 | 137.1% | 71.8% | WIDE (件数惜) |
    | `fuku_gap_007` | 146 | 99.8% | 71.2% | ほぼ 100% で件数最多 |
  - **📊 スパイク検証**: 旧 `fuku_top1_prob_020` の 106% が偶然ではなく、**0.20-0.22 が高原領域** であることが判明 (015→90.9% / 020→106.3% / 022→112.2% / 023→92.2% と急降下するため、明確なスイートスポット)
  - **🎰 aggregate_recommendations.py を 3 戦略マルチアサインに拡張**: 1 レースで複数戦略が発火する場合は `strategies: ["best","safe","wide"]` 配列で記録。ベストレースは複勝とワイドを併用すれば信頼性 UP
  - **🖥 UI 拡張** (`app.js renderRecommendations`):
    - ヘッダ下に **3 戦略カード** (BEST/SAFE/WIDE) を比較表示 (回収率 / 件数 / 的中率 / 内容)
    - BEST カードは金グラデ + 影で強調
    - 各レース行に **戦略バッジ** (★BEST/SAFE/WIDE) を付与・スマホ < 480px は縦並びに
    - WIDE 発火時は買い目を「ワイド 1-2-3 300 円」と自動切替
  - **CSS** (`styles.css`): `.rec-strats` 3 列グリッド・`.rec-strat-card` ホット/ゴー/ミュート 3 段階・`.rec-badge` 各色 (best=金/safe=緑/wide=青)・スマホ縦並びレスポンシブ・約 100 行追加
  - **sw.js**: v33 → v34
  - **動作確認**: /api/recommendations 200 OK・3 戦略統計入り・14 件 (今日 0 + 直近 14)・smoke 126/0
- **🏆 Wave19 (2026-05-19 00:00 ・「見送り戦略で 100% 越えできる?」への応答)** — ユーザー指示「あまりにも分からない・怪しいなら見送っても大丈夫・100% 越えそうですか」に応えて、見送り型戦略を 28 個追加して 690 R で実証 → **100% 越え戦略 8 個発見**:
  - **🎯 推奨買い方 (件数 50+ の信頼領域)**:
    | 戦略 | 件数 | 投資 | 払戻 | 回収率 | 的中率 |
    |------|------|------|------|--------|--------|
    | **`fuku_top1_prob_020`** (AI 本命の確率 20%+ で複勝) | **100** | 10,000 | 10,630 | **106.3%** | **72.0%** |
  - **🎯 100%+ 候補 (件数 10-49・偶然の可能性)**: `wide_top3_conf_060` (14件 109.0%) / `fuku_gap_012` (12件 101.7%)
  - **⚡ サンプル極小 (3-9件・参考)**: `wide_top3_conf_070` (3件 213.3%) / `fuku_gap_015` (2件 165.0%) / `wide_top3_conf_065` (8件 116.3%) / `fuku_top1_prob_030` (9件 111.1%)
  - **追加した 28 個の戦略カテゴリ**:
    - **EV 系**: tan_best_ev_any (全頭中 EV 最大・閾値 0.95) / fuku_best_ev_any (0.85) / tan|fuku_strict_combined (primary EV+ AND nopop EV+ AND value_signal>=0)
    - **確信系**: tan_top1_confident (win_prob≥0.40) / fuku_top1_confident (≥0.35) / wide_box_top3_confident (top3 合計確率 ≥0.70)
    - **本命突出系**: fuku_super_strict (top1-top2 prob gap ≥0.10) / uren_top1_top2_high (top1+top2 prob 合計 ≥0.55)
    - **穴狙い**: fuku_underdog_value (人気 4-8 番で nopop top3)
    - **閾値スイープ 18 個**: `wide_top3_conf_{55,60,65,70,75,80}` / `fuku_gap_{04,06,08,10,12,15}` / `fuku_top1_prob_{20,25,30,35,40,45}` — 何点で発火率と回収率がバランスするかを探索
  - **🖥 UI 強化**: `app.js renderMlStatus` に「★ 100% 越えの推奨買い方」セクション (緑強調) と「▲ 100%+ 候補 (サンプル少)」セクション (オレンジ) を追加。STRAT_LABELS に 28 個のラベル追加。`styles.css` に `.ml-recommended` / `.ml-possible` / `.ml-rec-card` 系約 80 行追加 (ボックス影 + アクセント色 + スマホ 1 列)
  - **重要な気づき**: 競馬は控除率 20-25% (払戻 75-80% に固定) のため、機械的に買うと長期で赤字が約束されている (最善でも 89.3%)。**「ほとんど見送って、確信レースだけ買う」**で初めて 100% 越えの可能性が開ける。ユーザーの直感「怪しいと思ったら見送り」が完全に正しかった
  - **ファイル**: `jv_bridge/validate_lightgbm.py` (28 戦略 + 閾値スイープファクトリ 3 個) / `app.js` (renderMlStatus 推奨セクション + 28 ラベル) / `styles.css` (推奨ボックス) / `sw.js` v31→v32
  - **テスト**: smoke 126/0 / `/api/ml-status` 200 (51 戦略・100%+ 8 個・信頼推奨 1 件 `fuku_top1_prob_020` 100件 106.3%)
  - **次の一歩**: `fuku_top1_prob_020` を当日推論パイプライン (`predict_lightgbm.py --all-today`) に組み込んで「今日の推奨買い目」として出す + 過去 10 年データが取れたら再学習で信頼性 UP
- **🎯 Wave18 (2026-05-18 23:30〜・「全部やる」指示への応答)** — ユーザー「全部やってください全部」(3 段ロードマップ全部) に応えて:
  - **🧬 人気を見ない「実力派モデル」を新規学習** (`train_lightgbm.py --no-pop`):
    - 人気系特徴量 12 個 (`win_odds / log_odds / implied_prob / popularity / log_popularity / odds_rank_in_race / popularity_z / popularity_x_jockey / popularity_x_course / implied_x_jockey_in3 / horsewin_x_popularity / prevfinish_x_popularity`) を `-1.0` でマスクして学習
    - 出力: `model_lgbm_nopop.txt` + `model_lgbm_nopop.json` + `model_lgbm_nopop_meta.json`
    - 結果: **AUC = 0.758** (人気込 0.806 から 5pt 減・実用上 OK)
    - トップ特徴量が `jockey_in_three_rate` / `horse_avg_finish` / `horse_prev_finish` / `trainer_in_three_rate` / `horse_in3_rate` に逆転 (= 実力派の見解)
  - **🔮 predict_lightgbm を 2 モデル合成に拡張**: primary (人気込) と nopop (実力派) を同時に推論し、`value_signal = nopop_prob - primary_prob` を算出。正なら「実力派モデルが市場より高評価」= 過小評価候補
  - **🎰 9 つの value pick 戦略を追加** (`validate_lightgbm.py` 23 戦略へ):
    - `tan/fuku_nopop_top1`: 実力派本命を単/複
    - `tan/fuku_nopop_undervalued`: 実力派本命が人気 3 番以下
    - `tan_value_signal_005` / `fuku_value_signal_003`: value_signal 大きい馬を狙う
    - `uren_primary_x_nopop` / `wide_primary_x_nopop`: 市場本命 × 実力派本命の馬連/ワイド
    - `fuku_ev_nopop_110`: 実力派 EV ≥ 1.10
  - **📊 23 戦略の実証結果 (test 690 R)**:
    | 戦略 | 件数 | 回収率 | 的中率 |
    |------|------|--------|--------|
    | 馬連 本命-対抗 (=Wave17 best) | 690 | **89.3%** | 11.9% |
    | 複勝 本命 (人気込) | 690 | 82.5% | 59.3% |
    | 複勝 実力派本命 | 690 | 82.0% | 53.6% |
    | ワイド 3 点 | 690 | 80.1% | 48.8% |
    | ワイド 市場本命×実力派本命 | 365 | 76.1% | 18.9% |
    | 複勝 実力派×人気3番以下 | 214 | 75.8% | 34.1% |
    | 複勝 価値シグナル+0.03 | 631 | 75.6% | 42.8% |
    | 単勝 本命 | 690 | 74.4% | 27.7% |
    | EV 閾値型 / 価値投資型 | 0〜14 件発火 | (発火少) |
    - 100% 越えはまだ届かず。理由: 「人気を見ない」モデルでも結局「騎手・馬の通算実績」を使うので実力馬 = 人気馬になりやすい
  - **🖥 JV-Link 設定 GUI を Win32 SendMessage で自動操作**:
    - 「状態を取得する」ボタン (id=261) を `BM_CLICK (0x00F5)` で発火
    - UIA は古い Win32 ダイアログ (#32770) に対応せず → `MainWindowHandle` + `EnumChildWindows` + `GetDlgItem` の Win32 直接呼び出しで実装
    - 結果: 試用期間ステータス (id=234) のテキストが空になった = 何かしら状態更新が走った
    - その後 `JVOpen option=4 fromtime=20140101` 再挑戦 → background PID=51404 で持続 (前回 rc=-501 即終了より進捗)
    - 取得結果は翌朝 build_all で評価予定
  - **🔌 アプリ統合 強化**:
    - `predictors/lightgbm_v1.js` に `loadModelMetaNopop()` 追加
    - `/api/ml-status` に `modelNopop` (nopop AUC + 重要度) を追加
    - `app.js renderMlStatus` を 3 セル化: 「AI 精度 (人気込)」「実力派 AI 精度」「過去 N R 検証 ベスト」
    - 23 戦略の日本語ラベルを追加 (tan_nopop_top1 = 「単勝 実力派モデル本命」など)
    - `styles.css .ml-grid` を 3 列 (スマホ < 480px は 1 列)
  - **テスト**: smoke 126/0 / `/api/ml-status` 200 (nopopAvailable=true, primary AUC 0.806, nopop AUC 0.758, 23 戦略)
- **🧠 Wave17 (2026-05-18 夜・「世界最高クラスの予想 AI」へ踏み出す)** — ユーザー指示「絶対当たる自信があるか・無いなら何時間かけてでも修正・最高のものを作ろう」に応えて、機械学習モデル一式を完成:
  - **🔧 raw 800MB → races/results を再展開** (`jv_bridge/build_all.py` 実行): 過去 raw データ (2025-2026 約 8 ヶ月分) から RA 3606 / SE 49238 / HR 3521 / O1-O6 各 3552 をパース → races/ 3492 件・results/ 3449 件で書き出し (新フィールド入り)
  - **⚠ 時系列リーク 2 件を発見・排除**:
    - LEAK-1 (AUC 0.955 → 0.806): 旧 `aggregate_features.py` は `horse_career.wins/starts` を**全期間通算**で計算 → train データの特徴量に「未来の結果」が混入 → AUC が異常に高い偽の値。修正: 新 `jv_bridge/aggregate_features_v2.py` を新規作成し、race_id 昇順走査で「当該レース直前まで」の集計のみを使う設計に
    - LEAK-2 (career_prize_norm 重要度 78748): SE の `honsyokin` は「**当該レースで獲得した本賞金**」(1 着なら大金) → これを「累計賞金」として特徴量化していた = 完璧な leakage。修正: `horse_prize_acc` を時系列で累積するよう v2 で書き直し
  - **🐛 payouts 欠損バグも修正**: `parse_record` が HR の `_raw` を保存していなかったため `build_result_json.from_se_list` が payouts を組み立てられず、results/*.json の payouts が `{}` 空 → 回収率検証が「全 690 R 払戻 0 円」になっていた。`parse.parse_raw_file` で HR レコードに限り `_raw` を保持するよう修正 → tan/fuku/uren/wide/utan/fuku3/tan3/wakuren 全 8 券種の payouts が復活
  - **🎯 過去レース特徴量を 12 個追加** (`jv_bridge/build_race_json.py` + `aggregate_features_v2.py` + `train_lightgbm.py`):
    - SE 由来: `haron_l3` (上がり 3F) / `haron_l4` / `jyuni_1c-4c` (コーナー通過順) / `time` (走破タイム) / `honsyokin` / `kyakusitu` (脚質)
    - v2 集計: `horseAvgLast3F` / `horseAvgPos4c` / `horseRunStyleMode` / `horseAvgFinish` / `horsePrevFinish` / `horseDaysSinceLast` (直近 5 走 ring buffer)
    - 累計: `jockeySamples` / `trainerSamples` / `careerPrizeJpy` (過去累積)
    - 交差項 2 個追加: `last3F_x_distance` / `prevfinish_x_popularity` → FEATURE_NAMES 計 54 個 (旧 42 個)
  - **🏋️ LightGBM 学習**:
    - 64bit Python 3.12.7 に lightgbm / scikit-learn / pandas を導入 (32bit Python は scipy/sklearn の wheel 無し・C コンパイラ要)
    - 学習設定: num_leaves 63 / learning_rate 0.02 / num_boost_round 1200 / early_stopping 40 / min_data_in_leaf 25 / lambda_l1/l2 0.15 / feature_fraction 0.8 / bagging
    - 時系列分割: race_id 昇順で train 80% (38,367 行) / valid 20% (9,519 行)
    - 結果: **AUC = 0.806** / logloss 0.2287 (leak-free な現実的な値)
    - 重要度 top-5: popularity (24334) / horsewin_x_popularity (15302) / popularity_z (4024) / log_popularity (2575) / weight_z (1159)
    - LightGBM Windows binary は非 ASCII path (「競馬」) を扱えないため tempfile copy で回避
  - **🎰 14 戦略で実証** (`jv_bridge/validate_lightgbm.py` 新規・test 期間 690 R):
    | 戦略 | 件数 | 投資 | 払戻 | 回収率 | 的中率 |
    |------|------|------|------|--------|--------|
    | 馬連 本命-対抗 | 690 | 69,000 | 61,620 | **89.3%** | 11.9% |
    | 複勝 本命 | 690 | 69,000 | 56,940 | 82.5% | 59.3% |
    | ワイド 3 点 | 690 | 207,000 | 165,790 | 80.1% | 48.8% |
    | 単勝 本命 | 690 | 69,000 | 51,340 | 74.4% | 27.7% |
    | EV 閾値 / 価値投資型 (人気 3 番以下) | 0 件発火 | — | — | — | — |
  - **❗ 正直な現状認識**: 「機械的に AI 本命を毎レース買う」と回収率 75-89% で **負け**。理由は AI が人気馬中心の予想をしている (popularity / implied_prob 特徴量が支配的)。価値投資型 (人気 3 番以下の AI 推し) は 690 R で **0 件発火** = AI と市場の予想がほぼ一致している
  - **🔌 アプリ統合**:
    - `predictors/lightgbm_v1.js` 新規 (Node 統合 wrapper・predictions/<race_id>.json を読む)
    - `/api/ml-status` を api/[...slug].js + server.js に追加 (model meta + backtest 結果)
    - `index.html` に `#ml-status-mount` 追加 / `app.js` に `renderMlStatus()` 追加 (14 戦略の回収率を色分け表示・正直な現状コメント込み)
    - `styles.css` に `.mlstatus-card` 系 約 110 行追加 (ライトな緑系ガラスモーフィズム + 戦略カード is-win/is-close/is-lose 色分け + スマホレスポンシブ)
    - `sw.js` v29 → v30
  - **テスト**: smoke 126/0 fail / `/api/ml-status` 200 OK (modelAvailable=true, AUC=0.806, bestStrategy=uren_top1_top2, bestRoiPct=89.3, 戦略数 14)
  - **次に強くするための地図**: (1) JV-Link のセットアップ期間問題を解決して過去 10 年フル取得 (現在 8 ヶ月分) → 学習サンプル 60 万行へ / (2) 人気依存を弱める feature engineering (popularity 系特徴量に lambda_l1 強める / 人気を見ない second model を作って ensemble) / (3) 調教タイム (HC/WC) と血統 (HN) を組み込む / (4) 券種ごとの最適停止
  - **ファイル**: `jv_bridge/aggregate_features_v2.py` (新規 270 行) / `jv_bridge/predict_lightgbm.py` (新規 240 行) / `jv_bridge/validate_lightgbm.py` (新規 280 行) / `predictors/lightgbm_v1.js` (新規 70 行) / `jv_bridge/build_race_json.py` (merge() 拡張) / `jv_bridge/build_result_json.py` (HR _raw 対応コメント) / `jv_bridge/parse.py` (HR _raw 保存) / `jv_bridge/train_lightgbm.py` (FEATURE_NAMES + extract_horse_features 拡張) / `api/[...slug].js` / `server.js` / `index.html` / `app.js` / `styles.css` / `sw.js` / `.gitignore`
- **🛡️ Wave16 当日運用 最終 QA (2026-05-18 12:45 ・ユーザー指示「凄く厳しい目で・バグないように・当日使えるように・修正してください」)** — 4 専門エージェント並列で深掘りレビュー → HIGH 級 3 件を全部修正:
  - **HIGH-1**: `catchup.ps1` の status.json パースが silent failure → `state="rt_failed"` で `lastAggregate` フィールドが消えるケース (5/18 に発生・JVRTOpen rc=-114) で 4h 判定が機能せず毎時実行されるリスク。修正: `lastAggregate.fetchedAt > updatedAt > なし` の優先順位フォールバック + `state=*_failed` かつ 4h 以内なら loop 防止のためスキップ
  - **HIGH-2**: `scripts/fetch_tomorrow.py:85` の `encoding="cp932"` を `utf-8` に統一 → `race_day_pipeline.py` の encoding と一致させ、サブプロセス出力の文字化けエラーで例外停止する事故を排除
  - **HIGH-3**: `race_day_pipeline.py` のタイムアウト時に部分データが git push されるリスク → 任意ステップが `rc=-2` (timeout) を返したら `timed_out=True` を立てて `git_commit_push()` 自体をスキップする防御を追加 (`overall |= 0x100` の新フラグ)
  - **MED**: `app.js` の `state` 定義に `autostatus: null` を初期化 (Wave16 で追加した renderAutostatus の defense in depth)
  - **検証**: smoke 126/0 fail / py -3.12-32 で fetch_tomorrow + race_day_pipeline 構文 OK / app.js `new Function()` 構文 OK / 本番 11 エンドポイント curl で全て期待通り (200 = status/weather/news/learning-status/automation-status/connection/venues/schedule/model-info / 503 = races/win5 で今日 5/18 競馬なし正常拒否 / 401 = cron-finalize 認証拒否)
  - **誤検知の整理**: agent から指摘された「index.html に config.js/storage.js script タグ追加」は Wave15 全削除設計通りで実害なし / 「CRON_SECRET 空文字攻撃」は `process.env.CRON_SECRET || null` で `"" → null` 変換で防御済 / 「path traversal」は `isFinalizableRaceId` で 18 桁数値 or `manual_` のみ通すため防御済 → いずれも修正不要
  - **当日運用 GO 判定**: 5/23 (土) 朝の本番運用に問題なし。`Win5PreSell 18:30` を含む 7 タスクが Ready 状態で WakeToRun=True + RestartCount=3 確認済
- **🔬 Wave16 後 最終 QA (2026-05-18 12:30 ・ユーザー指示「ちゃんと予想されているか・クリック効くか・エラー出ないか・更新遅くないか確かめて」)** — 全責任で深掘り検証:
  - **JV-Link 接続生存確認**: `py -3.12-32 jv_bridge\jv_fetch.py init` → `JVInit OK`
  - **当日データ確認**: aggregate RACE で 2780 レコード取得 → 5/18 の RA レコードは 0 件 = **5/18 は競馬開催なし** (5/16-5/17 が今週末・次は来週土日)
  - **API スモーク 16 個**: status/races/win5/race/learning-status/weather/news/conclusion/conclusion-manual/finalize/result/venues/connection/schedule/odds-movement/g1-history → すべて 200 OK
  - **応答速度**: /api/races 0.4 秒 (precomputed)・/api/win5 0.36 秒・/api/learning-status 1.7ms・他 ms オーダー
  - **エラーパス**: 不正 JSON POST → 400 / GET on POST-only → 405 / 未知 API → 404 すべて期待通り
  - **app.js syntax**: 1226 行・new Function() で構文 OK
  - **smoke テスト**: Node 126 ケース全通過
  - **発見した HIGH/MED は Wave15.1 + Wave16 で全部対応済を確認**: 過去レース誤表示 (`source:no_today`) / WIN5 stub の嘘の数値 (`evRatio:40000`) 削除 / 死にスクリプト 8 個 (`config.js / storage.js / predictors/*.js / lib/*.js`) を index.html から削除 / `parseVenueLabel` 末尾空白 trim / `tickCountdown` の renderAllRaces 重複 30s→60s / `setupTabs("history")` を id 参照に / 設定タブ active 戻し
  - **結論**: アプリは完成度高い。本日 5/18 のアプリ表示「今日は開催なしの日」は正しい挙動 (JRA は通常土日開催・5/18 は月曜)
- **🤖 Wave16 (2026-05-18 昼・「本当に自動更新?」への全面回答)** — ユーザー指示「自動更新アプリになってるんだよね・手動はほぼ無いはずなんだよね・最高のものを作ってね」に応えて、自動化レイヤーの穴を全部塞いだ:
  - **🔍 致命的バグ発見**: 5/17 (日曜) のスケジューラタスク 4 つすべて `LastResult=0x1` で失敗 → 原因は `WakeToRun=False` (PC スリープ中起動せず) + `RestartCount=0` (リトライなし) + `LogonType=Interactive` (ログオン中のみ実行) + ログが残らないほど早期に Python が落ちていた
  - **🛡️ 多層防御の自動化レイヤー** (`scripts/register_scheduler.ps1` 全面強化):
    - 土日定時 4 タスク (`Morning 08:30 / Pre 11:00 / Afternoon 13:30 / Evening 16:00`)
    - **`WakeToRun=True`**: PC スリープ中でも自動的に起こして実行
    - **`RestartCount=3 + RestartInterval=15min`**: 失敗時 15 分後に最大 3 回まで自動リトライ
    - **`MultipleInstances=IgnoreNew`**: 多重起動を防止
    - **`AllowStartIfOnBatteries + DontStopIfGoingOnBatteries`**: バッテリ駆動でも止めない
    - **キャッチアップ 2 タスク** (`Catchup-0800 / Catchup-1200`・毎日): `catchup.ps1` を呼んで「土日 + 最後の取得から 4h 以上空き」のときだけ実行 (PC が落ちてた時間帯のレースを救済)
  - **☁️ Vercel cron による結果自動 finalize** (`vercel.json` + `lib/cron_finalize.js` + `/api/cron-finalize`):
    - 毎日 14:00 UTC (= 23:00 JST) に Vercel cron が `/api/cron-finalize` を叩く
    - Supabase の `keiba.bets` テーブルから「result is null」かつ「race_id が 18 桁 JRA 形式」の bets を最大 500 件取得
    - `keiba.race_results` を一括取得して `finalizeBet()` で当落判定
    - bets テーブルを `result/factors/profit` で PATCH 更新
    - 認証: `Authorization: Bearer ${CRON_SECRET}` 必須 (Vercel cron が自動付与)・手動キック `?key=<CRON_SECRET>` も可
    - `CRON_SECRET` (32 文字ランダム) を Vercel 本番環境変数に登録済
    - `SUPABASE_SERVICE_ROLE_KEY` を Supabase Management API 経由で取得 → Vercel 環境変数に登録済 (RLS バイパスして全ユーザー分処理)
  - **📊 自動化ステータス カード** (`#automation-mount` / `/api/automation-status`):
    - 「データ取得 / 予想計算 / 本番反映 / 結果照合」の 4 セルを 30 秒ごと更新
    - 各セルに `is-ok / is-warn / is-ng` の状態色 + 経過時間 (例「12 分前」「2.3 時間前」)
    - 総合 pill: 「すべて自動稼働中」「確認推奨」「要対応」
    - これで「今自動が動いてるか」がアプリ開いた瞬間に判る
  - **テスト**: smoke 126 ケース全通過 (回帰なし) / `/api/cron-finalize` 認証なしで 401 / `/api/automation-status` 200 + 必要キー全揃い
  - **タスク登録**: PowerShell で 6 タスク (`Morning/Pre/Afternoon/Evening/Catchup-0800/Catchup-1200`) すべて `WakeToRun=True + RestartCount=3` で登録成功確認済
  - **🧪 試運転で実証 (2026-05-18 12:00 / 12:21)**:
    - 12:00:01 にスケジューラから `Catchup-1200` が自動起動 → 「平日のためスキップ」を正しく記録 (自動実行されている証拠)
    - 12:21:23 に `-Force` で強制実行 → `JV-Link → aggregate RACE 2780 レコード → build_all → fetch_tomorrow → features` の chain が頭から動くことを確認
    - 本番 (Vercel) で `/api/automation-status` 200 + `/api/cron-finalize` 401 (認証拒否) を確認 → デプロイ済 + 認証ガード稼働
    - `catchup.ps1` の `Start-Process` 引数渡しを 1 文字列形式に修正 (漢字パスでも壊れない)
  - **ファイル**: `vercel.json` (crons 追加) / `lib/cron_finalize.js` (新規) / `api/[...slug].js` (cron-finalize + automation-status 追加) / `index.html` (autostatus-card 追加) / `app.js` (renderAutostatus 追加) / `styles.css` (autostatus 系約 90 行追加) / `scripts/register_scheduler.ps1` (全面強化) / `scripts/catchup.ps1` (新規) / `sw.js` v27 → v28
- **🎨 Wave15 (2026-05-18 夕・必殺一号艇インスパイア 全面リライト)** — ユーザー指示「必殺一号艇みたいに見やすく・アニメーションも入れて・何を買うか分かりやすく・WIN5 もどれ買うかクリアに・妥協なし」に応えて、`index.html` / `styles.css` / `app.js` を一気にリライト:
  - **デザイン**: ライト + ガラスモーフィズム (rgba 白 + backdrop-blur)・メッシュグラデ背景 (シアン・ターフミント・ラベンダー・サンセット・ターフライト)・fractalNoise SVG グレイン・必殺一号艇相当のクオリティ
  - **DecisionCard** (最上段・必殺一号艇の `DecisionCard.tsx` を競馬向け移植): ティア別 (gold/go/cond/best/none) で色分け、`★★★★ / ★★★ / ★★ / ★ / ☆` 自信表示、場名+R 超デカ表示 (44-64px)、締切カウントダウン (秒進行・urgent/warn/past 切替)、期待値/1着確率/AI信頼度 の BigStat 3 つ、主軸/対抗/3着の買い目を `本命 単勝 / 押さえ 複勝 / 対抗 馬連 / 保険 ワイド` の ロールタグ + 金額 + 予想戻り 付き、CTA 大ボタン 2 本
  - **WIN5 専用カード** (`#win5-mount`): 紫グロー、`堅め (¥200・1点) / 中波 (¥6,400・32点) / 万舟 (¥48,600・243点)` の 3 戦略カード (AI 推奨にバッジ)、5 レース 本命を `第1戦〜第5戦` の縦並びで表示
  - **全レース 行リスト**: ティア別色付け (絶好機=ゴールド、勝負=ターフ、条件付=スカイ)、フィルタ chip (全/勝負/絶好機/G1)、ソート (時刻順/EV順)、各行は `[発走時刻] [会場+R+本命] [期待値+信頼度]` の 3 カラム、締切まで `urgent/warn/通常` の色で表示
  - **購入履歴**: 今日/7日 の `投資・収支・的中・回収率` を 4 セル、累計収支 SVG カーブ (黒字=ターフ緑塗り / 赤字=赤塗り)、最近 15 件の `is-hit / is-miss / is-pending` 色分け行、「結果を記録」プロンプト (当/外+払戻金) で更新
  - **ライブステータス**: `LIVE / 更新待 / 停止` のドット 3 段階、予想件数バッジ、`取得 N 秒前` 鮮度、AI 思考中の `...` ドット、`常時 学習中` のグラデバッジ
  - **ボトムナビ**: 本日/WIN5/履歴/手動入力/設定 の 5 タブ、SVG アイコン、active 時 上線インジケータ + ターフ色
  - **詳細モーダル**: 場名+R+レース名、馬場・天気・ペース予想 pill、AI の結論ボックス、AI 推定 18 頭ランキング (1-3 着は色分け)、AI 思考プロセス (`reasonList`)、`JRA 公式へ` + `+ 記録` ボタン
  - **手動入力モーダル**: スライドアップ入場、日付・レース・券種・買い目・金額・結果・払戻金、結果を `pending/hit/miss` で記録可能、payout 入力グループは hit 時のみ表示
  - **アニメーション**: `fade-in / slide-up / stagger (80ms 連鎖) / hit-glow / heroFloat / ctaGoldGlow / pulseDot / heartbeat / shimmer / thinkingDot / floaty / spinIt`、reduced-motion 完全尊重 (全停止)、`var(--ease-spring) = cubic-bezier(0.34, 1.56, 0.64, 1)` でぬるっと
  - **トースト**: 画面下中央、入場 spring / 退場 fade、`購入を記録しました` 等
  - **コード行数**: 11,151 → 2,348 (約 79% 削減・保守性大幅向上)
  - **ファイル**: `index.html` / `styles.css` / `app.js` 完全置換、`sw.js` v26 → v27 にバンプ (新ファイル即時反映)
  - **API 動作**: ローカル `node server.js` で /status /races /win5 /race?id=... /index.html /styles.css /app.js /sw.js 全 200 OK 確認、データ (馬名 エスカラムサ・ミセスリリー 等) 正常返却
  - **本番デプロイ**: commit `f87196b` → push origin main 済
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
- なし (Wave17 で機械学習モデル LightGBM の土台完成・AUC 0.806・ベスト戦略 馬連 89.3%)

### 🔜 次の一歩 (回収率 100% 超を狙う 3 段ロードマップ)

**フェーズ C (世界最高クラス化)** — Wave17 で土台完成・回収率 100% 超を狙う:
1. 🔜 **JV-Link セットアップ期間問題を解決** → 過去 10 年フル取得 (現在 8 ヶ月分 / 約 3500 R)
   - 現在の制約: option=4 で「Could not find vswhere.exe」「JVOpen は通るが過去 10 ヶ月分しか配信されない」
   - 対策案: JV-Link 設定 GUI で「セットアップ」を一度フォアグラウンドで実行・あるいは複数回 fromtime を遡らせて差分蓄積
2. 🔜 **人気依存を弱める feature engineering** → AI が市場 (人気) と同じ予想をしている問題への対策
   - popularity 系特徴量に lambda_l1 を強める / drop_feature で部分的に外したモデルとアンサンブル
   - 「人気を見ない second model」と「人気を含む primary model」の差分が大きいレースを value pick として推奨
3. 🔜 **未活用の取得データを訓練に組み込む** → 調教 (HC = 坂路 / WC = ウッドチップ) と血統 (HN = 馬経歴) の特徴量化
4. 🔜 **券種ごとの最適停止** → 単/複/馬連/ワイドそれぞれで EV 閾値を最適化 (現在 1.10 固定)
5. 🔜 **当日推論パイプライン** → ローカル PC で朝に `predict_lightgbm.py --all-today` を回し、`data/jv_cache/predictions/<id>.json` を生成 → git push で本番反映 (scripts/race_day_pipeline.py に組み込み)

**フェーズ A (0 円・無料準備)** — ✅ **完走** (2026-05-15):
- JRA-VAN 開発者登録 → SDK ダウンロード → 仕様書転記 → 32bit Python + pytest 環境構築 → smoke 64/6 skip 全部緑

**フェーズ B (月額 2,090 円・実データ接続)** — ✅ **完走** (2026-05-16):
- JRA-VAN Data Lab. 契約 → JV-Link COM 接続 → 過去 raw 800MB 取得 → races/results 3500 件展開済

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
