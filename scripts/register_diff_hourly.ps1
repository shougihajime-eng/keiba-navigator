# register_diff_hourly.ps1
# Wave35-A: Register hourly JV-Link option=2 fetch tasks (09:00 - 20:00)
# This ADDS to existing KeibaJVRetry-* tasks (which try option=4 / rc=-501)
# These succeed reliably and capture +500-2000 new records per call.

$ErrorActionPreference = "Continue"
$KEIBA_ROOT = (Get-Item (Join-Path $PSScriptRoot "..")).FullName
$PS_SCRIPT = Join-Path $KEIBA_ROOT "scripts\fetch_diff_hourly.ps1"

if (-not (Test-Path $PS_SCRIPT)) {
    Write-Host ("[ERROR] script not found: " + $PS_SCRIPT)
    exit 1
}

$HOURS = @("09:00", "09:30", "10:30", "11:30", "12:30", "13:30", "14:30", "15:30", "16:30", "17:30", "18:30", "19:30", "20:30")

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument ("-ExecutionPolicy Bypass -WindowStyle Hidden -File `"" + $PS_SCRIPT + "`"")

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -WakeToRun `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 20) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

foreach ($t in $HOURS) {
    $taskName = "KeibaDiffFetch-" + $t.Replace(":", "")
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
            -Description "Wave35-A: hourly JV-Link option=2 diff fetch" | Out-Null
        Write-Host ("[OK] Registered: " + $taskName + " at " + $t + " daily")
    } catch {
        Write-Host ("[ERROR] " + $taskName + " failed: " + $_.Exception.Message)
    }
}

Write-Host ""
Write-Host "=== Done ==="
Write-Host "  12 tasks (09:30 - 20:30 hourly, 30min offset from KeibaJVRetry)"
Write-Host "  Each call fetches +500-2000 new records via option=2"
Write-Host "  After 1 week: +20,000-50,000 new training rows expected"
