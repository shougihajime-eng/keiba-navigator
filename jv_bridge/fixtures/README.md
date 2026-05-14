# JV-Link バイナリの fixtures 置き場

## 現状 (2026-05-15)

**仕様書からの転記は完了済み**:
- `jvdata_struct.py` の RA / SE / O1 / HR は SDK Ver4.9.0.2 の C# 構造体
  (`JV-Data構造体/C#版/JVData_Struct.cs`) から全 offset/length を正式に転記済み
- `RECORD_COMPLETED["RA"] = RECORD_COMPLETED["SE"] = RECORD_COMPLETED["O1"] = RECORD_COMPLETED["HR"] = True`
- SPEC_VERSION = "4.9.0.1"

つまり、**実バイナリが取れた瞬間に動く状態**。

## サンプルバイナリは SDK には同梱されていません

JRA-VAN SDK (Ver4.9.0.2) を確認した結果、`Sample/` `TestData/` といった
バイナリサンプルフォルダは **存在しません**。SDK に入っているのは:

- C# / C++ / Delphi7 / VB2019 用の構造体定義 (.cs / .h / .pas / .bas)
- 仕様書 PDF / Excel
- DataLab.検証ツール (Setup.msi)
- サンプルプログラム (Visual Studio プロジェクトコード)

**実バイナリは「JV-Link 経由で実取得した時に初めて手に入る」** 性質のもので、
JRA-VAN Data Lab. の月額契約 (¥2,090) が必要です。

## 取得後のフォルダ構成 (将来用)

JV-Link 接続後、`jv_fetch.py rt` でレコードを取得すると `data/jv_cache/`
に raw .bin が保存されます。そこから 1 レコード分を切り出して以下に置けば、
**実データでのパーステストが追加で緑になります**:

```
fixtures/
├── RA/sample_RA.bin
├── SE/sample_SE.bin
├── O1/sample_O1.bin
└── HR/sample_HR.bin
```

`test_parse.py` の `test_first_byte_is_record_id` / `test_ra_parses_to_race_name_and_distance`
等は fixture があれば自動で実行されます。

## ⚠ 規約上の注意

JRA-VAN の利用規約により、**取得した raw データを git にコミット・GitHub に
公開することは禁止**されています (`.githooks/pre-commit` で自動ブロック)。
個人 PC 内でのテスト用途のみに使ってください。

## テスト実行

```powershell
py -3.12-32 -m pip install pytest
py -3.12-32 -m pytest jv_bridge/tests -q
```

仕様書転記は済んでいるので、サンプルバイナリ無しでも以下のテストは緑になります:
- `test_io_helpers.py` (各種デコーダ)
- `test_parse_loop.py` (汎用ループパーサ)
- `test_build_result_json.py` (払戻組み立て)
- `test_aggregate.py` (集計レイヤ)
- `test_end_to_end_synthetic.py` (合成バイナリ E2E)
- `test_parse.py` の RA/SE 短バイト数テストなど

実バイナリが揃ったら追加 7 ケースが skip → passed に変わり、**「課金 GO」** 完了です。
