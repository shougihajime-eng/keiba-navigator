# KEIBA NAVIGATOR (Next.js v2)

長期回収率 100% 超えを目指す競馬予想アプリ。
Apple x Stripe x 競馬の躍動感をコンセプトに、世界最高クラスのデザインで構築。

## 構成

- **Next.js 16.2** (App Router)
- **React 19** + **TypeScript 5**
- **Tailwind CSS 4** (CSS-first config)
- **Inter** + **Noto Sans JP** + **JetBrains Mono** フォント
- **Framer Motion** (現状未使用・Phase 5 拡張用に同梱)

## ローカル起動

### 1. 既存 API サーバーを起動 (別ターミナル)

```sh
cd ..              # repo root
node server.js     # http://127.0.0.1:8765
```

### 2. Next.js dev サーバーを起動

```sh
cd web
cp .env.local.example .env.local   # 初回のみ
npm install
npm run dev                        # http://127.0.0.1:3000
```

`.env.local` で `NEXT_PUBLIC_API_BASE` を切り替え:
- `http://127.0.0.1:8765` ← ローカル開発
- `https://keiba-navigator.vercel.app` ← 本番 API を借りる場合

## デプロイ (Vercel)

### 方法 A: 別プロジェクトとして並走 (推奨・既存と共存)

1. https://vercel.com/new で同じ GitHub repo をインポート
2. Project Name: `keiba-navigator-v2` (任意)
3. **Root Directory: `web`** ← 重要
4. Framework Preset: Next.js (自動検出)
5. Environment Variables:
   - `NEXT_PUBLIC_API_BASE = https://keiba-navigator.vercel.app`
6. Deploy

→ `https://keiba-navigator-v2.vercel.app` で新アプリが見える。既存 keiba-navigator はそのまま継続。

### 方法 B: 既存 keiba-navigator を置き換え

1. Vercel ダッシュボードの既存プロジェクト Settings
2. **Root Directory** を `web` に変更
3. **Environment Variables** で `NEXT_PUBLIC_API_BASE` を **削除** (同一オリジン経由になるため)
4. Redeploy
5. ※注意: 旧 app.js / index.html は表示されなくなる

## ディレクトリ

```
web/
├── src/
│   ├── app/
│   │   ├── page.tsx         # メイン (3ブロック)
│   │   ├── design/page.tsx  # デザインショーケース
│   │   ├── layout.tsx       # フォント + メタデータ
│   │   └── globals.css      # 配色トークン + アニメーション
│   ├── components/
│   │   ├── ui/              # Card / Button / StarRating / Badge / Stat / Logo / HorseLoader
│   │   ├── icons/           # Horseshoe / RunningHorse / Trophy (馬モチーフ)
│   │   ├── blocks/          # BlockA (勝負レース) / BlockB (反省) / BlockC (収支) / CollapsibleSections
│   │   ├── BetConfirmModal.tsx
│   │   ├── NotifyBar.tsx
│   │   ├── Collapsible.tsx
│   │   ├── PendingBetsList.tsx
│   │   └── ReflectionDashboard.tsx
│   ├── lib/
│   │   ├── api.ts           # 既存 /api/* fetch ラッパ
│   │   ├── rating.ts        # EV+信頼度 → 1-5 段階評価
│   │   ├── snapshot.ts      # 暫定→確定 diff
│   │   ├── notify.ts        # Web Notification API
│   │   ├── store.ts         # localStorage 馬券保管
│   │   ├── reflection.ts    # 構造化反省文生成
│   │   ├── reflectionStore.ts
│   │   └── utils.ts         # cn / formatYen / formatPct
│   └── types/
│       └── api.ts           # 既存 API レスポンス型
└── public/
```

## 完成基準 (/goal より抜粋)

- [x] トップ画面は「星5・4のレース」「直近の反省1件」「収支サマリー」のみ
- [x] 星5・4 のレースは買い目・EV・一言根拠付き
- [x] 開催なし日は「今日は開催なし」と明示 (空白画面にならない)
- [x] 朝〜発走15分前は「暫定」表示・10分前で「最終確定」に切替
- [x] 暫定→確定の変更点 (買い目/星評価) が差分で表示
- [x] 発走 10 分前にプッシュ通知
- [x] 過剰人気で妙味消失なら「見送り推奨」に降格
- [x] 「これ買う」でモーダル表示・購入履歴に下書き保存
- [x] 外したレース全件に構造化反省文を自動生成・保存
- [x] 反省文は構造化タグ付きで保存・頻出タグをダッシュボード可視化
- [x] ニュース・騎手/厩舎ランキングは折りたたみ式・トップを汚さない
- [x] 累計回収率がトップに常時表示・100% 超えかを色で判別

## ライセンス

Internal project. 鈴木肇さん専用。
