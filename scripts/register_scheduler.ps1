# Windows タスクスケジューラに「土曜・日曜 朝 8:30 に明日のレースを取る.bat を実行」を登録する。
#
# 使い方:
#   PowerShell を管理者権限で開いて、次を実行:
#     powershell -ExecutionPolicy Bypass -File scripts\register_scheduler.ps1
#
# 解除する場合:
#   Unregister-ScheduledTask -TaskName "KeibaNavigator-FetchTomorrow" -Confirm:$false

$ErrorActionPreference = "Stop"

$ScriptRoot = Split-Path -Parent $PSScriptRoot
$BatchFile = Join-Path $ScriptRoot "明日のレースを取る.bat"

if (-not (Test-Path $BatchFile)) {
    Write-Host "[NG] バッチファイルが見つかりません: $BatchFile"
    exit 1
}

$TaskName = "KeibaNavigator-FetchTomorrow"
$TaskDesc = "土曜・日曜の朝 8:30 に明日のレースのオッズを自動取得 (KEIBA NAVIGATOR)"

# 既存タスクを削除 (再登録のため)
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "既存タスクを削除します: $TaskName"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# トリガー: 土曜・日曜の 8:30
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday, Sunday -At 8:30AM

# アクション: バッチファイルを実行
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$BatchFile`""

# 設定: ノートPC でバッテリー駆動でも実行、終了したらタスクを残す
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

# 現在のユーザー権限で登録 (管理者権限不要)
Register-ScheduledTask `
    -TaskName $TaskName `
    -Description $TaskDesc `
    -Trigger $Trigger `
    -Action $Action `
    -Settings $Settings `
    -User $env:USERNAME | Out-Null

Write-Host ""
Write-Host "[OK] タスクを登録しました: $TaskName"
Write-Host "  実行タイミング: 毎週土曜・日曜 8:30"
Write-Host "  実行内容: $BatchFile"
Write-Host ""
Write-Host "確認するには:"
Write-Host "  Get-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "解除するには:"
Write-Host "  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
