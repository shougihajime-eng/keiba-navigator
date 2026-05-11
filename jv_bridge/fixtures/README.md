# JV-Link テスト用サンプルバイナリの置き場所

JRA-VAN SDK (https://developer.jra-van.jp/ ・**開発者登録は無料**) に同梱の
サンプルバイナリをこの `fixtures/` フォルダに置きます。これにより、**JRA-VAN を
契約しなくても** パーサのテストができます。

## 推奨フォルダ構成

```
fixtures/
├── RA/  (レース情報)
│   └── sample_RA.bin
├── SE/  (馬毎レース情報)
│   └── sample_SE.bin
├── O1/  (単勝・複勝オッズ)
│   └── sample_O1.bin
└── HR/  (払戻)
    └── sample_HR.bin
```

## SDK の入手手順

1. https://developer.jra-van.jp/ をブラウザで開く
2. 「開発者登録」ボタン → メールアドレスだけで登録 (無料)
3. ログイン後、SDK ダウンロードページから ZIP を取得
4. ZIP 内の `Sample/` フォルダや `TestData/` フォルダに `.bin` ファイルがあるはず
5. レコード種別 (RA / SE / O1 / HR) ごとに分けて、上記フォルダに置く

## ⚠ 注意

- これらは JRA-VAN の配布物です。**git に commit して GitHub 公開してよいかは SDK の利用規約を確認**してください。
- 不明なら、`.gitignore` に `jv_bridge/fixtures/**/*.bin` を追加して、自分の PC 内だけで使うのが安全です。

## テスト実行

```powershell
py -3.12 -m pip install pytest
py -3.12 -m pytest jv_bridge/tests -q
```

仕様書転記が完了していないレコードのテストは自動 skip されます。
すべて緑になったら **「課金 GO サイン」** です。
