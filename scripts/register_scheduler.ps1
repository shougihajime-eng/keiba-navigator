# ============================================================
# KEIBA NAVIGATOR  自動取得タスクの登録 (Windows タスクスケジューラ)
# Wave16: スリープ復帰 / 失敗時リトライ / 起動時キャッチアップ を追加
# ============================================================
#
# 使い方:
#   PowerShell (管理者) を開いて:
#     powershell -ExecutionPolicy Bypass -File scripts\register_scheduler.ps1
#
# 解除する場合:
#   Get-ScheduledTask -TaskName "KeibaNavigator-*" | Unregister-ScheduledTask -Confirm:$false

$ErrorActionPreference = "Stop"

$ScriptRoot = Split-Path -Parent $PSScriptRoot
$BatchFile  = Join-Path $ScriptRoot "明日のレースを取る.bat"
$CatchupPs  = Join-Path $ScriptRoot "scripts\catchup.ps1"

if (-not (Test-Path $BatchFile)) {
    Write-Host "[NG] バッチファイルが見つかりません: $BatchFile"
    exit 1
}

# 旧 (単一時刻) タスクが残っていたら削除
$old = Get-ScheduledTask -TaskName "KeibaNavigator-FetchTomorrow" -ErrorAction SilentlyContinue
if ($old) {
    Write-Host "旧タスク KeibaNavigator-FetchTomorrow を削除"
    Unregister-ScheduledTask -TaskName "KeibaNavigator-FetchTomorrow" -Confirm:$false
}

# 既存の KeibaNavigator-* を一旦全削除 (再登録)
Get-ScheduledTask -TaskName "KeibaNavigator-*" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "既存タスク削除: $($_.TaskName)"
    Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false
}

# ─── 共通設定 ───────────────────────────────────────────────
function New-KeibaSettings {
    # 失敗時に 15 分後 × 最大 3 回 自動再試行
    # スリープ中でも 起動して実行 (WakeToRun=true)
    # バッテリ駆動でも止めない
    New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -DontStopOnIdleEnd `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -WakeToRun `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 15) `
        -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
        -MultipleInstances IgnoreNew
}

# ─── 1) 土日の定時 4 タイミング ──────────────────────────────
$slots = @(
    @{ Name = "KeibaNavigator-Morning";   Time = "08:30"; Desc = "朝の出走表 + RT" },
    @{ Name = "KeibaNavigator-Pre";       Time = "11:00"; Desc = "直前オッズ" },
    @{ Name = "KeibaNavigator-Afternoon"; Time = "13:30"; Desc = "発走後オッズ更新" },
    @{ Name = "KeibaNavigator-Evening";   Time = "16:00"; Desc = "確定オッズ + 払戻" }
)

foreach ($slot in $slots) {
    $Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday, Sunday -At $slot.Time
    # WakeToRun を有効にするため、トリガー側でも明示
    $Trigger.StartBoundary = ([DateTime]::Parse($Trigger.StartBoundary)).ToString("s")
    $Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$BatchFile`" --no-pause"
    $Settings = New-KeibaSettings

    Register-ScheduledTask `
        -TaskName $slot.Name `
        -Description ("KEIBA NAVIGATOR " + $slot.Desc + " (毎週土日 " + $slot.Time + ")") `
        -Trigger $Trigger `
        -Action $Action `
        -Settings $Settings `
        -User $env:USERNAME | Out-Null

    Write-Host "[OK] 登録: $($slot.Name)  土日 $($slot.Time)  - $($slot.Desc)"
}

# ─── 2) 起動時キャッチアップ ────────────────────────────────
# PC を起動した時点で「最後の取得から 4 時間以上経過 かつ 今日が土日」なら即実行
# (PC が落ちていた時間帯のレースをカバー)
if (Test-Path $CatchupPs) {
    $TriggerLogon  = New-ScheduledTaskTrigger -AtLogOn
    $TriggerStart  = New-ScheduledTaskTrigger -AtStartup
    # 起動直後すぐ走ると重いので 2 分遅延
    $TriggerLogon.Delay  = "PT2M"
    $TriggerStart.Delay  = "PT2M"
    $Action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$CatchupPs`""
    $Settings = New-KeibaSettings

    Register-ScheduledTask `
        -TaskName "KeibaNavigator-Catchup" `
        -Description "起動/ログオン時に最後の取得から4時間以上空いていれば自動キャッチアップ" `
        -Trigger @($TriggerLogon, $TriggerStart) `
        -Action $Action `
        -Settings $Settings `
        -User $env:USERNAME | Out-Null

    Write-Host "[OK] 登録: KeibaNavigator-Catchup  起動/ログオン時 (4h以上空きなら自動実行)"
} else {
    Write-Host "[WARN] catchup.ps1 が見つかりません: $CatchupPs"
}

Write-Host ""
Write-Host "================================================="
Write-Host "Wave16 自動化タスクを登録しました。"
Write-Host ""
Write-Host "  定時 (毎週土日):"
Write-Host "    08:30  朝の出走表取得"
Write-Host "    11:00  直前オッズ"
Write-Host "    13:30  発走後オッズ更新"
Write-Host "    16:00  確定オッズ + 払戻"
Write-Host ""
Write-Host "  保険レイヤー:"
Write-Host "    起動時/ログオン時  4h 以上空きがあれば自動キャッチアップ"
Write-Host "    失敗時             15 分後に最大 3 回まで再試行"
Write-Host "    スリープ中         自動的に起こして実行 (WakeToRun)"
Write-Host ""
Write-Host "確認: Get-ScheduledTask -TaskName 'KeibaNavigator-*'"
Write-Host "解除: Get-ScheduledTask -TaskName 'KeibaNavigator-*' | Unregister-ScheduledTask -Confirm:`$false"
