# register_jv_retry.ps1
# Wave32-B: Register 9 hourly tasks for JV-Link retry (09:00 - 17:00)
# Each task calls retry_full_history.ps1 which:
#   - Triggers JV-Link GUI status check
#   - Tries JVOpen aggregate option=4 fromtime=20140101
#   - Builds JSON if success and skips for 24h
# Once any task succeeds, full_history_fetched.flag is set and others skip.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\register_jv_retry.ps1

$ErrorActionPreference = "Continue"
$ROOT = "C:\Users\shoug\keiba"
# Use Resolve-Path to handle Japanese folder name correctly
$KEIBA_ROOT = (Get-Item (Join-Path $PSScriptRoot "..")).FullName
$PS_SCRIPT = Join-Path $KEIBA_ROOT "scripts\retry_full_history.ps1"

if (-not (Test-Path $PS_SCRIPT)) {
    Write-Host ("[ERROR] retry_full_history.ps1 not found: " + $PS_SCRIPT)
    exit 1
}

$HOURS = @("09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00")

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument ("-ExecutionPolicy Bypass -WindowStyle Hidden -File `"" + $PS_SCRIPT + "`"")

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -WakeToRun `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

foreach ($t in $HOURS) {
    $taskName = "KeibaJVRetry-" + $t.Replace(":", "")
    try {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    } catch {}

    $Trigger = New-ScheduledTaskTrigger -Daily -At $t

    try {
        Register-ScheduledTask `
            -TaskName $taskName `
            -Action $Action `
            -Trigger $Trigger `
            -Settings $Settings `
            -Principal $Principal `
            -Description "Wave32-B: JV-Link retry hourly (rc=-501 workaround)" | Out-Null
        Write-Host ("[OK] Registered: " + $taskName + " at " + $t + " daily")
    } catch {
        Write-Host ("[ERROR] " + $taskName + " failed: " + $_.Exception.Message)
    }
}

Write-Host ""
Write-Host "=== Done ==="
Write-Host "  9 tasks (09:00 - 17:00 hourly)"
Write-Host "  WakeToRun=True, RestartCount=3 with 10min interval"
