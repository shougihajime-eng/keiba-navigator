@echo off
chcp 65001 >nul
title 競馬ダッシュボード
echo.
echo ===============================================
echo   🏇  競馬ダッシュボードを起動します
echo ===============================================
echo.
echo   ブラウザで開いてください: http://127.0.0.1:8765
echo.
echo   止めるときはこの黒い画面で Ctrl+C を押すか、
echo   この画面を閉じてください。
echo.

cd /d "%~dp0"

REM Node.js を探す
where node >nul 2>&1
if %errorlevel%==0 (
    node server.js
    goto :end
)

REM 標準PATHにない場合の WinGet パスを試す
set "NODE=%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.15.0-win-x64\node.exe"
if exist "%NODE%" (
    "%NODE%" server.js
    goto :end
)

echo [NG] Node.js が見つかりません。
echo     https://nodejs.org/ja から「LTS」版をインストールしてください。
pause

:end
