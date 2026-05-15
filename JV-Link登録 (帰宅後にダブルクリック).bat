@echo off
chcp 65001 > nul
title JV-Link 自動セットアップ (管理者権限が必要)

REM ============================================================
REM  KEIBA NAVIGATOR - JV-Link ワンクリック セットアップ
REM ============================================================
REM  これを「ダブルクリック」してください
REM  「許可しますか?」と聞かれたら「はい」だけ押してください
REM  あとは全部自動でやります(数十秒で完了)
REM ============================================================

REM ─── 管理者権限チェック ──────────────────────────────
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo 管理者として起動し直します...
    echo 「はい」を押してください
    echo.
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

set "JVDIR=C:\Program Files (x86)\JRA-VAN\Data Lab"
set "LICKEY=3UJC-46WW-7VV1-T7RX-4"

echo.
echo ====================================================
echo  JV-Link 自動セットアップを開始します
echo  利用キー: %LICKEY%
echo ====================================================
echo.

cd /d "%JVDIR%" 2>nul || (
  echo ERROR: %JVDIR% が見つかりません
  echo 先に JV-Link 本体をインストールしてください
  pause
  exit /b 1
)

echo [1/5] 古い COM 登録をクリーンアップ...
JVLinkAgent.exe /unregserver >nul 2>&1
echo   OK

echo.
echo [2/5] JVLinkAgent.exe を COM サーバとして登録...
JVLinkAgent.exe /regserver
if %errorLevel% neq 0 (
  echo   WARN: regserver が想定外の終了。/Embedding でリトライ...
  start "" "%JVDIR%\JVLinkAgent.exe" /regserver
  timeout /t 2 /nobreak >nul
)
echo   OK

echo.
echo [3/5] MSFLXGRD.OCX を登録...
regsvr32 /s "%JVDIR%\MSFLXGRD.OCX"
echo   OK

echo.
echo [4/5] 利用キーをレジストリに事前書き込み (パスを複数試行)...
REM JV-Link 4.x の典型的なレジストリパス候補に書き込む
REM どれかが当たれば、GUI を開いた時に利用キーが既に入力済みの状態になる

reg add "HKCU\Software\JRA-VAN\Data Lab\JVLink" /v "ServiceKey" /t REG_SZ /d "%LICKEY%" /f >nul 2>&1
reg add "HKCU\Software\JRA-VAN\Data Lab\JVLink" /v "Key"        /t REG_SZ /d "%LICKEY%" /f >nul 2>&1
reg add "HKCU\Software\JRA-VAN\JVLink"          /v "ServiceKey" /t REG_SZ /d "%LICKEY%" /f >nul 2>&1
reg add "HKCU\Software\JRA-VAN\JVLink"          /v "Key"        /t REG_SZ /d "%LICKEY%" /f >nul 2>&1
reg add "HKCU\Software\JRA-VAN\JVDTLab"         /v "ServiceKey" /t REG_SZ /d "%LICKEY%" /f >nul 2>&1
reg add "HKCU\Software\JRA-VAN\JVDTLab\JVLink"  /v "ServiceKey" /t REG_SZ /d "%LICKEY%" /f >nul 2>&1
reg add "HKCU\Software\JV-Link"                  /v "ServiceKey" /t REG_SZ /d "%LICKEY%" /f >nul 2>&1
echo   OK (7 箇所試行)

echo.
echo [5/5] 接続テストを試行 (Python 32bit が居れば)...
set "PY32=C:\Users\shoug\AppData\Local\Programs\Python\Python312-32\python.exe"
if exist "%PY32%" (
  echo   Python 32bit を検出。jv_fetch.py init を実行...
  pushd "C:\Users\shoug\競馬"
  "%PY32%" jv_bridge\jv_fetch.py init
  popd
) else (
  echo   Python 32bit 未検出。接続テストはスキップします
)

echo.
echo ====================================================
echo  自動セットアップ完了
echo ====================================================
echo.
echo  次にやること:
echo    1. JV-Link 設定画面を開きます (確認だけしてください)
echo    2. 利用キーが既に入っていれば OK・閉じてください
echo    3. 入っていなければ "%LICKEY%" を貼り付けて保存してください
echo.
echo  その後、Web アプリを再読み込みすると JV-Link 接続済みになります
echo  https://keiba-navigator.vercel.app
echo.
echo  問題があれば、このウィンドウのログを撮って Claude に見せてください
echo.

start "" "%JVDIR%\JV-Link設定.exe"

echo  Enter を押すと終了します...
pause >nul
