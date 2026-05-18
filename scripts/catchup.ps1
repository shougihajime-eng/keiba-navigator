# ============================================================
# KEIBA NAVIGATOR  起動/ログオン時のキャッチアップ
# ============================================================
# 動作: PC 起動 / Windows ログオン後 2 分で 1 回実行される。
# 内容:
#   1. 今日が土曜 or 日曜なら → 後続チェックへ
#   2. data/jv_cache/_status.json の lastAggregate.fetchedAt が 4 時間以上前なら
#      明日のレースを取る.bat --no-pause を起動 (バックグラウンド)
#   3. 平日 or 4h 以内に取れていればスキップ (重複防止)
#
# オプション: -Force で土日チェックと 4h チェックを両方スキップ (試運転用)
#
# ログ: logs\catchup_YYYY-MM-DD.log

param(
    [switch]$Force
)

$ErrorActionPreference = "Continue"

$ScriptRoot = Split-Path -Parent $PSScriptRoot
$BatchFile  = Join-Path $ScriptRoot "明日のレースを取る.bat"
$StatusJson = Join-Path $ScriptRoot "data\jv_cache\_status.json"
$LogDir     = Join-Path $ScriptRoot "logs"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

$today    = Get-Date
$logPath  = Join-Path $LogDir ("catchup_" + $today.ToString("yyyy-MM-dd") + ".log")

function Write-Log($msg) {
    $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $msg
    Add-Content -Path $logPath -Value $line -Encoding utf8
}

Write-Log "=== catchup 開始 ==="

# 1) 土日チェック
$dow = $today.DayOfWeek
Write-Log "今日: $($today.ToString('yyyy-MM-dd')) ($dow) Force=$Force"
if (-not $Force -and -not ($dow -eq [DayOfWeek]::Saturday -or $dow -eq [DayOfWeek]::Sunday)) {
    Write-Log "平日のためスキップ (試運転は -Force で強制実行可)"
    exit 0
}

# 2) 最終アクセス時刻チェック
# 優先順位: lastAggregate.fetchedAt > updatedAt > なし
# state="rt_failed" 等のエラー状態でも updatedAt は最後の実行時刻を持つので、
# 「直近に走ったがエラーだった」場合に毎時走り続けるのを防ぐ
$staleHours = 4
$fetchedAt  = $null
$stateLabel = "(unknown)"
if (Test-Path $StatusJson) {
    try {
        $j = Get-Content -Path $StatusJson -Raw -Encoding utf8 | ConvertFrom-Json
        $stateLabel = $j.state
        if ($j.lastAggregate -and $j.lastAggregate.fetchedAt) {
            $fetchedAt = [DateTime]::Parse($j.lastAggregate.fetchedAt)
        } elseif ($j.updatedAt) {
            # lastAggregate がない場合は updatedAt をフォールバック
            $fetchedAt = [DateTime]::Parse($j.updatedAt)
        }
    } catch {
        Write-Log "status.json 読み込み失敗 (実行する): $($_.Exception.Message)"
    }
}

Write-Log "JV-Link 状態: $stateLabel"
if ($fetchedAt) {
    $gap = ($today - $fetchedAt).TotalHours
    Write-Log ("最終実行: {0:yyyy-MM-dd HH:mm} ({1:F1}h 前)" -f $fetchedAt, $gap)
    if (-not $Force -and $gap -lt $staleHours) {
        Write-Log "4h 以内に取得済みのためスキップ (試運転は -Force で強制実行可)"
        exit 0
    }
} else {
    Write-Log "最終実行時刻 不明。実行する"
}

# JV-Link がエラー状態 (rt_failed / init_failed) かつ最近 (4h以内) 実行していたら
# 短時間で再試行しても同じエラーになる可能性が高いのでスキップ (loop 防止)
if (-not $Force -and $stateLabel -match "_failed" -and $fetchedAt -and ($today - $fetchedAt).TotalHours -lt $staleHours) {
    Write-Log "JV-Link エラー状態 + 4h 以内に試行済みのためスキップ (試運転は -Force で強制実行可)"
    exit 0
}

# 3) バッチを起動 (新ウィンドウ・非対話・終了待たない)
Write-Log "race_day_pipeline を起動: $BatchFile"
try {
    # 引数は 1 つの文字列にまとめ、パスを "..." でクォート (漢字フォルダ対策)
    $argString = '/c "' + $BatchFile + '" --no-pause'
    Start-Process -FilePath "cmd.exe" `
                  -ArgumentList $argString `
                  -WorkingDirectory $ScriptRoot `
                  -WindowStyle Minimized | Out-Null
    Write-Log "起動 OK (バックグラウンド実行)"
} catch {
    Write-Log "起動失敗: $($_.Exception.Message)"
    exit 1
}

Write-Log "=== catchup 終了 ==="
