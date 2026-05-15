@echo off
chcp 65001 > nul
title KEIBA NAVIGATOR 自動実行を登録
cd /d "%~dp0"

echo === 土曜・日曜の朝 8:30 にオッズを自動取得する設定を登録します ===
echo.
echo PowerShell スクリプトを実行します。
echo Windows から確認ダイアログが出たら「はい」を選んでください。
echo.

powershell -ExecutionPolicy Bypass -File "scripts\register_scheduler.ps1"

echo.
echo === 完了 ===
echo このウィンドウは何かキーを押すと閉じます。
pause
