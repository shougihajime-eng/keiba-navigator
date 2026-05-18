# retry_full_history.ps1
# Wave20: JV-Link rc=-501 を朝の営業時間で自動解消する
#
# 動作:
#   1. JV-Link 設定 GUI を background で操作 (「状態を取得する」を SendMessage)
#   2. 60 秒待ってサーバ応答を引き出す
#   3. jv_fetch.py aggregate --dataspec RACE --fromtime 20140101 --option 4 を試行
#   4. 成功 (exit 0) なら build_all → aggregate_features_v2 → train_lightgbm (primary+nopop)
#      → predict_lightgbm --all-races → aggregate_recommendations → validate_lightgbm
#      → git commit + push
#   5. 失敗 (exit 6) なら何もしない (次回起動時に再試行)
#
# Windows タスクスケジューラから 1 日複数回 (09:00 / 11:00 / 13:00 / 15:00 / 17:00) 呼び出す想定。
# 一度成功すれば過去 10 年データが入った状態になり、recommendations.json と
# walk_forward_result.json が大幅に拡充される (サンプル 60 万+)。

$ErrorActionPreference = "Continue"
$ROOT = "C:\Users\shoug\競馬"
$LOG_DIR = Join-Path $ROOT "logs"
New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
$LOG_PATH = Join-Path $LOG_DIR ("retry_full_history_" + (Get-Date -Format "yyyy-MM-dd") + ".log")

function Write-Log($msg) {
    $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $msg
    Add-Content -Path $LOG_PATH -Value $line -Encoding UTF8
    Write-Host $line
}

# 既に成功フラグファイルがあるなら今日はもう試行しない (1 日 1 回成功で十分)
$SUCCESS_FLAG = Join-Path $ROOT "data\jv_cache\full_history_fetched.flag"
if (Test-Path $SUCCESS_FLAG) {
    $stat = Get-Item $SUCCESS_FLAG
    $ageMin = ((Get-Date) - $stat.LastWriteTime).TotalMinutes
    if ($ageMin -lt 24 * 60) {
        Write-Log "今日は既に過去 10 年取得済 ($([int]$ageMin) 分前)。スキップ。"
        exit 0
    }
}

# 平日でも実行 (営業時間なら本契約フラグが取れる可能性)
$hour = (Get-Date).Hour
if ($hour -lt 9 -or $hour -gt 18) {
    Write-Log "営業時間外 (現在 $hour 時)。スキップ。"
    exit 0
}

Write-Log "=== 過去 10 年取得 リトライ開始 ==="

# (1) JV-Link 設定 GUI で「状態を取得する」を Win32 SendMessage で発火
$jvSettingsExe = "C:\Program Files (x86)\JRA-VAN\Data Lab\JV-Link設定.exe"
if (Test-Path $jvSettingsExe) {
    Write-Log "JV-Link 設定 を起動 + 「状態を取得する」発火"
    Add-Type -Name Wave20 -Namespace HelperW20 -MemberDefinition @"
[DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hDlg, int nIDDlgItem);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
"@ -ErrorAction SilentlyContinue
    $proc = Start-Process -FilePath $jvSettingsExe -PassThru
    Start-Sleep -Seconds 5
    $proc.Refresh()
    $mainWnd = $proc.MainWindowHandle
    if ($mainWnd -ne [IntPtr]::Zero) {
        $btn = [HelperW20.Wave20]::GetDlgItem($mainWnd, 261)  # 「状態を取得する」
        if ($btn -ne [IntPtr]::Zero) {
            [void][HelperW20.Wave20]::SendMessage($btn, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
            Write-Log "「状態を取得する」クリック送信。サーバ応答待ち 60 秒..."
            Start-Sleep -Seconds 60
        }
        # OK で閉じる
        $ok = [HelperW20.Wave20]::GetDlgItem($mainWnd, 1)
        if ($ok -ne [IntPtr]::Zero) {
            [void][HelperW20.Wave20]::SendMessage($ok, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
        }
    }
    Start-Sleep -Seconds 2
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Write-Log "JV-Link 設定 閉じた"
}

# (2) JVOpen aggregate option=4 を試行
$pyExe32 = "C:\Users\shoug\AppData\Local\Programs\Python\Python312-32\python.exe"
Write-Log "JVOpen aggregate --fromtime 20140101 --option 4 試行..."
$aggLog = Join-Path $LOG_DIR ("retry_aggregate_" + (Get-Date -Format "HHmmss") + ".log")
& $pyExe32 (Join-Path $ROOT "jv_bridge\jv_fetch.py") aggregate `
    --dataspec RACE --fromtime 20140101000000 --option 4 *>&1 | Out-File -FilePath $aggLog -Encoding utf8
$aggExit = $LASTEXITCODE
Write-Log "JVOpen aggregate 終了 exit=$aggExit (log=$aggLog)"

if ($aggExit -ne 0) {
    Write-Log "失敗 (rc=$aggExit)。次回起動時に再試行する。"
    exit $aggExit
}

# (3) 成功した → 後続チェーンを実行
Write-Log "成功! 過去 10 年データ取得完了。"
Write-Log "build_all + 集計 + 学習 + 推論 + 推奨集約 + 検証 を chain 実行..."

# 後続は race_day_pipeline と同じ。ただし JV-Link 取得部分はスキップ。
& $pyExe32 (Join-Path $ROOT "scripts\race_day_pipeline.py") `
    --skip-refresh --skip-rt 2>&1 | Out-File -FilePath (Join-Path $LOG_DIR "retry_pipeline.log") -Encoding utf8
$pipelineExit = $LASTEXITCODE
Write-Log "pipeline chain 終了 exit=$pipelineExit"

# 成功フラグを書く (1 日 1 回成功で十分・翌日まで再試行しない)
if ($pipelineExit -eq 0) {
    "" | Out-File -FilePath $SUCCESS_FLAG -Encoding ascii
    Write-Log "=== 全 chain 成功・成功フラグを書いた ==="
} else {
    Write-Log "=== chain で 1 つ以上失敗 (pipelineExit=$pipelineExit)・成功フラグは書かない ==="
}

exit $pipelineExit
