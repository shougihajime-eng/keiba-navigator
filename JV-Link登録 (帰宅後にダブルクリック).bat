@echo off
chcp 65001 > nul
title JV-Link 登録 (管理者権限が必要)

REM ============================================================
REM JV-Link を Windows に正式登録するスクリプト
REM ============================================================
REM 使い方: このファイルを「ダブルクリック」してください
REM 「このアプリがデバイスに変更を加えることを許可しますか?」と出たら「はい」
REM 数秒で終わります
REM ============================================================

REM 管理者権限チェック
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo 管理者権限で起動し直します...
    echo 「はい」を押してください
    echo.
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo.
echo ====================================================
echo  JV-Link 登録を開始します
echo ====================================================
echo.

cd /d "C:\Program Files (x86)\JRA-VAN\Data Lab"

echo [1/3] JVLinkAgent.exe を COM サーバとして登録...
JVLinkAgent.exe /regserver
echo 完了

echo.
echo [2/3] MSFLXGRD.OCX を登録...
regsvr32 /s MSFLXGRD.OCX
echo 完了

echo.
echo [3/3] JV-Link 設定を開きます...
echo (利用キーを入れる画面が出るので、3UJC-46WW-7VV1-T7RX-4 を入れてください)
echo.
start "" "JV-Link設定.exe"

echo.
echo ====================================================
echo  終わりました!設定ウィンドウで利用キーを入力してください
echo ====================================================
echo.
pause
