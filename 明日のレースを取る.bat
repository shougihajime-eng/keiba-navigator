@echo off
chcp 65001 > nul
title KEIBA NAVIGATOR - 土日 race-day pipeline
cd /d "%~dp0"
set PY=%LOCALAPPDATA%\Programs\Python\Python312-32\python.exe

if not exist "%PY%" (
  echo [NG] 32bit Python が見つかりません。jv_bridge\SETUP.txt の手順で入れてください。
  pause
  exit /b 1
)

echo === race_day_pipeline を開始します ===
echo (tomorrow_races 更新 -^> RT 取得 -^> build_all -^> aggregate_features)
echo.
"%PY%" -u scripts\race_day_pipeline.py
echo.
echo === 完了しました ===
if "%1"=="--no-pause" exit /b 0
echo このウィンドウは何かキーを押すと閉じます。
pause
