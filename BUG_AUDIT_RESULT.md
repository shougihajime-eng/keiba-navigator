# 🛠 競馬アプリ・バグ監査結果レポート

**監査実施日**: 2026-05-21
**監査依頼元**: 必殺１ごうてい(競艇予想アプリ)の Claude (shoug さん直接指示)
**監査対象**: `C:\Users\shoug\競馬\` (KEIBA NAVIGATOR)
**監査方針**: 競艇アプリで起きた12個の致命的バグが、競馬アプリにも存在しないか実コードで照合
**結論**: ✅ 致命バグはなし。中度バグ3個を発見し、いずれも即座に修正完了。

---

## 📊 結果サマリ (shoug さん向け・専門用語なし)

12個のバグを1つずつ実コードで確認しました。
**今日、3つを直しました**。残り9個は競馬アプリには元々ありませんでした。
よって**「予想が出ない」「全部見送り」「結果が反映されない」のような事故は、これで競馬アプリでも起きません**。

### 直した3つ

1. **空っぽの結果データで「外れ」を保存しちゃう問題** (competition で 545件の偽データが蓄積した経路と同じ)
   → 直しました。これからは結果が空なら何もしません。

2. **新人騎手・転厩・休み明けの馬が「悪い」と過小評価される問題**
   → 直しました。データが少ない時はそもそも判断を中立に倒すようにしました。

3. **新しい予想に切り替えた時に古い画面が出続ける問題** (アプリで「ちょっとだけ読み込みに失敗」と出る原因)
   → 直しました。これからは画面を開くたびに最新版が出ます。

---

## 🔬 詳細監査結果 (技術記録)

### ① 予想テーブル肥大化 → ✅ 元々問題なし

**競艇での症状**: cron が同内容を毎回 INSERT し picks が 15万行に膨らみ全ページ 17秒 timeout

**競馬の構造調査**:
- 予想は `data/jv_cache/predictions.json` を**1ファイル上書き**で保存 (`scripts/precompute_predictions.js` L213)
- `keiba.bets` テーブルへの INSERT は app.js (フロントエンド) でユーザー操作起点のみ
- cron による自動 INSERT ループは存在しない

**判定**: 構造的にバグ無し。修正不要。

---

### ② スコア型 numeric/integer → ✅ 元々問題なし

**競艇での症状**: score が integer 型で +1.5 のような小数 INSERT 失敗 → 4日間で 66件の予想が消失

**競馬の構造調査**:
- `db/schema.sql` で `ev numeric / prob numeric / amount integer / profit integer / payout integer`
- 整数カラムへの代入箇所はすべて `Math.round()` で保護済 (`storage.js` L143/L155, `lib/finalize.js` 全箇所, `lib/csv_import.js` L152/L162)

**判定**: 全箇所で `Math.round()` 適用済。修正不要。

---

### ③ 結果API 当日 404 → ✅ 元々問題なし

**競艇での症状**: 当日中は `/YYYY/YYYYMMDD.json` が 404 → 過去日が placeholder 永続化

**競馬の構造調査**:
- `lib/finalize.js` L86-90 `readResultAsync()` は Supabase → ファイル の二重参照
- JV-Link (`jv_bridge/build_result_json.py`) でローカル JSON を生成 (Web API ではなく COM 経由)
- 当日中の 404 問題は競馬では発生しない構造

**判定**: 構造的にバグ無し。修正不要。

---

### ④ 偽プレースホルダー結果での偽外れ保存 → 🔧 修正完了

**競艇での症状**: 結果確定前の空 payouts の result 行で `won=false / profit=-N` を INSERT し 545件の偽データ蓄積

**競馬で見つかった問題**:
- `keiba.race_results` は `payouts jsonb default '{}'` (空デフォルト)
- 旧 `finalizeBet()` は `result.results` が配列ならそのまま処理 → 空配列でも `winnerEntry=undefined → won=false → profit=-amount` を返していた
- これは `cron_finalize.js` L136-138 経由で本番でも `bets` を「外れ」更新できる経路だった

**修正内容** (`lib/finalize.js`):
- 新関数 `isResultUnsettled(result)` を追加:
  - `results` 配列が空 → 未確定
  - rank=1 の行がない → 未確定
  - 主要券種 (tan/uren/tan3/fuku3/fuku) の払戻が一切ない → 未確定
- `finalizeBet()` の冒頭で `if (isResultUnsettled(result)) return null;` を追加し、空結果は finalize 対象外に

**インパクト**: 確定前の race_results が誤って bets を「外れ」上書きする経路が完全に塞がった。

---

### ⑤ データ欠損で確信度低下 → 暴走判定 → ✅ 元々問題なし

**競艇での症状**: 新節初日に確信度 5% でも「本命勝負」昇格

**競馬の構造調査**:
- `lib/conclusion.js` L148-150: go 昇格に `topEv >= 1.30 AND conf >= 0.30` の**両方**を必須化
- 低信頼度では topEv が大きくても "neutral" に降格 (L151-157)

**判定**: 構造的にバグ無し。修正不要。

---

### ⑥ 0%・極小値を「悪い」と誤判定 → 🔧 修正完了

**競艇での症状**: モーター2連率 0% を「悪い」と判定し新節初日に全レース見送り

**競馬で見つかった問題**:
- `predictors/heuristic_v1.js` の NEUTRAL.jockeyWinRate = `0.10`
- 一方、`jv_bridge/aggregate_features` のサンプル0時ベースラインは `0.075`
- → ベースライン同馬でも -5% の減点が掛かる構造

**修正内容** (`predictors/heuristic_v1.js`):
- NEUTRAL.{jockeyWinRate, courseWinRate, distanceWinRate, surfaceWinRate, goingWinRate} を `0.10` → `0.075` に統一
- 全部の補正計算で「-0.10」のハードコードを「-NEUTRAL.X」に置換
- 新関数 `trustRate(rate, samples, neutral)`: サンプル < 5 なら中立値に置換
- jockey 補正で `features.jockeySamples` を見て新人騎手を中立扱い

**インパクト**: 新馬戦・新人騎手・転厩馬で発生していた構造的減点を解消。

---

### ⑦ 浅コピーで学習状態が累積 → ✅ 元々問題なし

**競艇での症状**: `{...DEFAULT_PASS_TUNING}` 浅コピーで `loosenedReasons` 配列を参照共有 → 累積で巨大化

**競馬の構造調査**:
- `predictors/learner.js` は引数受け取り型の純粋関数で構成
- `cloudSync()` (L204-231) は upsert で毎回新規オブジェクトを書き、`history: []` で常に空配列スタート
- 配列累積バグのパターン無し

**判定**: 構造的にバグ無し。修正不要。

---

### ⑧ ChunkLoadError 対策 (SW キャッシュ) → 🔧 修正完了

**競艇での症状**: 新デプロイで JS チャンクハッシュが変わり、SW キャッシュ済の古い HTML が古いチャンク URL を参照 → 404 → 「ちょっとだけ読み込みに失敗しました」が頻発

**競馬で見つかった問題** (`sw.js`):
- 旧実装: `index.html` を **cache-first → stale-while-revalidate** で扱っていた (L78-83)
- → デプロイ直後の初回アクセスで古い HTML が返り、現行の JS チャンクと不整合
- 競艇で実際に起きた事故と同じ構造

**修正内容** (`sw.js`):
- `CACHE_VERSION` を `v65` → `v66` にバンプ (古いキャッシュ強制破棄)
- 新ヘルパー `isHtmlNavigation(req, url)` で HTML ナビゲーションを判定
- HTML は **network-only** に変更 (キャッシュしない)
- オフライン時のみインライン HTML フォールバック (3秒おきに復帰確認 → 自動リロード)
- PRECACHE から `/` と `/index.html` を除外
- 静的アセット (manifest.json / icon.svg) のみ cache-first 継続

**インパクト**: 新デプロイ後の chunk mismatch が物理的に発生不可能になった。

---

### ⑨ プレースホルダー pass が結論カードに大写し → 🔧 予防的補強

**競艇での症状**: 「展示走行前」「データ取得待ち」レースが「今日の本命」として大写し

**競馬の構造調査**:
- `app.js` `tierOfRace()` L252-262: `ev == null` で "none" 返却 → 結論カードから除外
- `lib/conclusion.js`: judgement_unavailable 時は `picks: []` → topPick=null → ev=null → 除外 ✓
- 既存ロジックでも基本的に守られている

**予防的補強** (`app.js`):
- `tierOfRace()` に明示的なガードを3つ追加:
  - `race.verdict === "judgement_unavailable"` → "none"
  - `race.verdict === "pass"` → "none"
  - `race.horse_count === 0` → "none"
- 将来 verdict 周りのロジックが変わってもプレースホルダー昇格を防げる二重防御

**インパクト**: 「データ取得待ちレースが大写し」事故が物理的に発生不可能。

---

### ⑩ 直前情報後着で再評価されない → ✅ 元々問題なし

**競艇での症状**: 締切10分以内のみ評価対象 → preview 後着で再評価されず古い判定が固定

**競馬の構造調査**:
- `scripts/race_day_pipeline.py` が日4回 (8:30/11:00/13:30/16:00) で全工程再実行
- 各回で `build_all → aggregate_features → train_lightgbm → predict_lightgbm → precompute_predictions` を回す
- 11:00 で直前オッズ・パドック情報を取り直して全レース再予想
- app.js が30秒おきにポーリング → `predictions.json` の更新時刻が新しければ即反映

**判定**: 構造的にバグ無し。修正不要。

---

### ⑪ cron 停止監視 (ウォッチドッグ) → ✅ 既存対応で十分

**競艇での症状**: GitHub Actions の cron が無料 tier で数時間サイレント停止 → 予想が古いまま

**競馬の構造調査**:
- `app.js` `renderLive()` L363-379 に3段階表示あり:
  - 120秒以内 → 緑「LIVE」
  - 600秒(10分)以内 → 黄「更新待」
  - それ以上 → 赤「停止」
- 競馬は GitHub Actions ではなく**ローカル PC のタスクスケジューラ**で動くため、競艇と構造が違う
- 競艇では Vercel Cron 失敗が致命的だったが、競馬はローカル実行のため止まりにくい

**判定**: 最低限のウォッチドッグはある。多層冗長化までは不要。

---

### ⑫ 空 result で終了扱いされ画面消失 → ✅ 元々問題なし + ④で内部突合も塞いだ

**競艇での症状**: 結果未到着の空 result 行で「終了」と誤判定 → ホームから消える

**競馬の構造調査**:
- `app.js` のレース終了判定は `startTime` (発走時刻) ベース
- result 行の有無で UI から消すロジックは存在しない
- 競艇とは画面構造そのものが違う
- 内部の馬券突合 (`finalizeBet`) も Bug ④ の修正で空 result を弾くようになった

**判定**: 構造的にバグ無し。

---

## 🧰 修正したファイル一覧

| ファイル | 種類 | 修正内容 |
|---|---|---|
| `lib/finalize.js` | 修正 | `isResultUnsettled()` 関数を追加し、空 result で finalize しないように (Bug ④) |
| `predictors/heuristic_v1.js` | 修正 | NEUTRAL ベースラインを 0.10 → 0.075 に統一 + `trustRate()` 追加 (Bug ⑥) |
| `sw.js` | 修正 | HTML を network-only 化・オフラインフォールバック追加 (Bug ⑧) |
| `app.js` | 修正 | `tierOfRace()` にプレースホルダー pass ガード3種追加 (Bug ⑨ 予防) |
| `app.js` | 追加修正 | `renderHeader()` のデッドコード `"gold"` tier 参照を `"ultra"/"prime"/"go"` に修正 — ヘッダの「狙えるレース」が ultra/prime を見落として過小カウントしていた |
| `tests/smoke.js` | テスト追加 | 偽プレースホルダー結果の null 返却を確認する 4 テスト追加 (旧 2 件を新仕様に更新) |

## 🔎 補足: 実 DB / 実ファイル監査の追加発見

### `data/jv_cache/results/` に 72 件の placeholder 結果ファイル
- 2026-05-16 (36件) と 2026-05-17 (36件) のレース結果が `results: []` (空配列) のまま
- 払戻データ (payouts) は揃っているが、着順 (rank/number/name) が空
- 真因: `jv_bridge/build_all.py` (line 195-196) が `has_finished=False AND hr あり` のケースで「払戻だけ書き出す」ファイルを生成していた (= 競艇でいう「結果API 当日 404」と同等のシナリオ)
- 既存の Bug ④ 修正 (`isResultUnsettled`) で偽外れ蓄積は構造的に防止済 → ファイル自体は次回 JV-Link 取得時に SE データが届けば自動で上書きされる

### `keiba.race_results` Supabase テーブルは 0 行
- 現在 Supabase 経由の結果照会はゼロ件 — 実害ゼロ
- ファイル経由の参照のみで動作中

### smoke テスト結果
- 修正前: 124 通過 / 2 失敗 (偽プレースホルダー検出の新仕様で旧テストが失敗)
- 修正後: **128 通過 / 0 失敗** ✅

---

## ✅ shoug さん向け次のステップ

shoug さんが直接やることはありません。修正は全部このセッションで完了しました。

次に競馬アプリを開いたときに:
1. **Service Worker の新バージョン (v66) が自動適用される** → ブラウザを 1 回完全再起動するのがおすすめ
2. **新人騎手の馬が極端に弱く出てた** のが、ちょうど中立評価に戻ります
3. **「外れ」と記録された過去の馬券で、本当は結果データがまだ来てなかった分** は自動修正されませんが、これ以降の馬券は適切に扱われます

何か気になることがあれば、必殺１ごうてい (競艇)の Claude に「競馬どうだった?」と聞いてみてください。

---

以上、12項目の監査完了。**致命バグなし・中度バグ3つを即修正**。

— 必殺１ごうてい(競艇)の Claude より、2026-05-21
