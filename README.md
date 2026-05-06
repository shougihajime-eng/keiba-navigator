# 🏇 KEIBA NAVIGATOR

> 回収率100%超を目指す育成型 AI — 「買わないAI」コンセプト

[![Live](https://img.shields.io/badge/Live-keiba--navigator.vercel.app-10b981?style=flat-square)](https://keiba-navigator.vercel.app)
[![License](https://img.shields.io/badge/license-private-64748b?style=flat-square)](#)

競馬の期待値（EV）を全頭に対して計算し、**「買わない」判断**を最優先で出すダッシュボード。期待値マイナスのレースで馬券を買わせないことで、長期回収率100%超を狙う。

## 特徴

- 🎯 **EV 採点**: 推定勝率 × オッズで期待値を全頭計算（オッズに引きずられない）
- 🚫 **「買わない」推奨**: 期待値マイナスのレースは見送りを強く出す
- 📈 **育成型 AI**: 確定した馬券から自動学習。★1〜★5 でレベルアップ
- ☁️ **クラウド同期**: メール認証だけ（パスワードなし）で複数端末に同期
- 📱 **PWA**: スマホで「ホーム画面に追加」可能
- 🔒 **自動投票なし**: 規約違反のため一切実装しない

## クイックスタート

→ **[QUICK_START.md](./QUICK_START.md)** に 30 分で動かすまでの全手順。

## 公開URL

- 本番: https://keiba-navigator.vercel.app
- ローカル: `npm start` → http://127.0.0.1:8765

## 技術構成

| 領域 | 内容 |
| --- | --- |
| フロント | バニラ JS + Tailwind CDN |
| サーバー（本番） | Vercel Serverless Functions（catch-all） |
| サーバー（ローカル） | Node.js 標準 `http` |
| 推定モデル | `predictors/heuristic_v1.js`（オッズ非依存）→ JV-Link接続後に LightGBM/DL に差替予定 |
| データ | JV-Link（JRA-VAN契約・Windows 32bit）/ 気象庁 / Google News |
| 永続化 | Supabase（共有プロジェクト・`keiba` スキーマ）+ localStorage フォールバック |
| 認証 | Supabase Auth Magic Link |

## ライセンス

private（個人利用想定）

## 重要な原則

1. **100%的中はあり得ない**（競馬は確率事象）
2. **長期で回収率100%超を目指す**（負けレース回避が最重要）
3. **データが無い時は推奨しない**
4. **オッズに引きずられない**（推定勝率はオッズを使わずに計算）
5. **学習する器を残す**（`learner_state` テーブル＋差替機構で無停止モデル更新）

## 禁止事項

- 自動投票（規約違反）
- JRA 公式サイトのスクレイピング（同上）
