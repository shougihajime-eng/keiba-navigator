@echo off
chcp 65001 > nul
title 明日のレースのオッズを取得
cd /d "%~dp0"
set PY=%LOCALAPPDATA%\Programs\Python\Python312-32\python.exe

if not exist "%PY%" (
  echo [NG] 32bit Python が見つかりません。jv_bridge\SETUP.txt の手順で入れてください。
  pause
  exit /b 1
)

echo === 明日のレースのオッズ取得を開始します ===
echo.
"%PY%" scripts\fetch_tomorrow.py
echo.
echo === 完了しました ===
echo このウィンドウは何かキーを押すと閉じます。
pause
