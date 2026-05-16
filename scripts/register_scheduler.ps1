# Windows タスクスケジューラに「土曜・日曜の朝〜夕方の 4 タイミングで
# race_day_pipeline を自動実行」する設定を登録する。
#
# 使い方:
#   PowerShell を管理者権限で開いて、次を実行:
#     powershell -ExecutionPolicy Bypass -File scripts\register_scheduler.ps1
#
# 解除する場合:
#   Get-ScheduledTask -TaskName "KeibaNavigator-*" | Unregister-ScheduledTask -Confirm:$false

$ErrorActionPreference = "Stop"

$ScriptRoot = Split-Path -Parent $PSScriptRoot
$BatchFile = Join-Path $ScriptRoot "明日のレースを取る.bat"

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

# 4 タイミング (土日とも各時刻に走る)
$slots = @(
    @{ Name = "KeibaNavigator-Morning";   Time = "08:30"; Desc = "朝の出走表 + RT" },
    @{ Name = "KeibaNavigator-Pre";       Time = "11:00"; Desc = "直前オッズ" },
    @{ Name = "KeibaNavigator-Afternoon"; Time = "13:30"; Desc = "発走後オッズ更新" },
    @{ Name = "KeibaNavigator-Evening";   Time = "16:00"; Desc = "確定オッズ + 払戻" }
)

foreach ($slot in $slots) {
    $taskName = $slot.Name
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "既存タスクを削除: $taskName"
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }

    $Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday, Sunday -At $slot.Time
    # 引数 --no-pause で BAT 末尾の pause を抑止 (自動実行のため)
    $Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$BatchFile`" --no-pause"
    $Settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -DontStopOnIdleEnd `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Hours 1)

    Register-ScheduledTask `
        -TaskName $taskName `
        -Description ("KEIBA NAVIGATOR " + $slot.Desc + " (毎週土日 " + $slot.Time + ")") `
        -Trigger $Trigger `
        -Action $Action `
        -Settings $Settings `
        -User $env:USERNAME | Out-Null

    Write-Host "[OK] 登録: $taskName  土日 $($slot.Time)  -  $($slot.Desc)"
}

Write-Host ""
Write-Host "================================================="
Write-Host "全 4 タスクを登録しました。今後は土日に自動で:"
Write-Host "  08:30  朝の出走表取得"
Write-Host "  11:00  直前オッズ"
Write-Host "  13:30  発走後オッズ更新"
Write-Host "  16:00  確定オッズ + 払戻"
Write-Host "が走り、data/jv_cache/ に最新データが溜まります。"
Write-Host ""
Write-Host "確認: Get-ScheduledTask -TaskName 'KeibaNavigator-*'"
Write-Host "解除: Get-ScheduledTask -TaskName 'KeibaNavigator-*' | Unregister-ScheduledTask -Confirm:`$false"
