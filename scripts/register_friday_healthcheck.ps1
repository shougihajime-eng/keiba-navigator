# register_friday_healthcheck.ps1
# Wave35-C: Register Friday 22:00 health check task

$ErrorActionPreference = "Continue"
$KEIBA_ROOT = (Get-Item (Join-Path $PSScriptRoot "..")).FullName
$PS_SCRIPT = Join-Path $KEIBA_ROOT "scripts\friday_evening_healthcheck.ps1"

if (-not (Test-Path $PS_SCRIPT)) {
    Write-Host ("[ERROR] script not found: " + $PS_SCRIPT)
    exit 1
}

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument ("-ExecutionPolicy Bypass -WindowStyle Hidden -File `"" + $PS_SCRIPT + "`"")

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -WakeToRun `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# Friday 22:00 weekly
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At "22:00"

$taskName = "KeibaFridayHealthCheck"
try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
} catch {}

try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $Action `
        -Trigger $Trigger `
        -Settings $Settings `
        -Principal $Principal `
        -Description "Wave35-C: Friday 22:00 pre-Saturday health check" | Out-Null
    Write-Host ("[OK] Registered: " + $taskName + " Friday 22:00 weekly")
} catch {
    Write-Host ("[ERROR] " + $taskName + " failed: " + $_.Exception.Message)
}
