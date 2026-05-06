# KEIBA NAVIGATOR (競馬)

期待値判定ダッシュボード。「買わないAI」コンセプト。長期で回収率100%超を目指す育つ系AI。

---

## 進捗（いまここ）

### ✅ 直近で済んだこと
- Supabase クラウド同期を本番設定に切替（`keiba` 専用スキーマ・RLS有効・anon キー埋込済）
- `keiba.learner_state` テーブル追加 + グレード別の自己学習 (calibration) 実装
- AI 育成レベル UI（★1〜5）+ ホーム画面に学習グリッド表示
- **GitHub リポジトリ公開**: https://github.com/shougihajime-eng/keiba-navigator
- **Vercel 本番デプロイ**: https://keiba-navigator.vercel.app
- 14 個の Vercel Functions を catch-all (`api/[...slug].js`) 1 個に集約（Hobby 12 個制限を回避）
- Supabase Auth の URI Allow List に Vercel URL と localhost を追加（Magic Link 動作）

### 🟡 進行中
- なし

### 🔜 次の一歩
1. **JV-Link（JRA-VAN 月額¥2,090）契約 → 実データ取得**（実データ無しではどんな AI も育たない・このプロジェクト最大の壁）
2. JV-Link 接続後に **LightGBM/勾配ブースティング** に差し替え（`learner_state.weights` の器は既に用意済）
3. ディープラーニング（PyTorch / TensorFlow.js）の学習パイプライン整備（JV-Link 過去10年データから）

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
