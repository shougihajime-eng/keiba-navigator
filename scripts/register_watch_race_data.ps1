# register_watch_race_data.ps1
# Daily auto-launch of watch_race_data.sh on Sat/Sun 7:00 AM
# Prevents the 5/23 fiasco from recurring.

$ErrorActionPreference = "Continue"
$ROOT = "C:\Users\shoug\Keiba"  # placeholder - replaced below
$ROOT = "$env:USERPROFILE\" + [string]([char]31478) + [string]([char]39340)
# Actually use literal Japanese path stored as variable assigned from non-literal source
$ROOT = Join-Path $env:USERPROFILE ([System.Text.Encoding]::UTF8.GetString([byte[]](0xE7, 0xAB, 0xB6, 0xE9, 0xA6, 0xAC)))
$TASK_NAME = "KeibaWatcher-Morning-0530"
$LOG_DIR = Join-Path $ROOT "logs"
New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null

$bashCandidates = @(
  "C:\Program Files\Git\bin\bash.exe",
  "C:\Program Files\Git\usr\bin\bash.exe",
  "C:\Program Files (x86)\Git\bin\bash.exe"
)
$bashExe = $bashCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bashExe) {
  Write-Output "[NG] Git Bash (bash.exe) not found"
  exit 1
}
Write-Output "[OK] bash.exe = $bashExe"
Write-Output "[OK] ROOT = $ROOT"

$existing = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
if ($existing) {
  Write-Output "Removing existing task..."
  Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
}

# Path inside bash uses /c/Users/shoug/<japanese-keiba>/...
# pre-compute bash-form path
$bashPath = "/c/Users/shoug/" + [System.Text.Encoding]::UTF8.GetString([byte[]](0xE7, 0xAB, 0xB6, 0xE9, 0xA6, 0xAC))

$action = New-ScheduledTaskAction `
  -Execute $bashExe `
  -Argument "-c `"cd '$bashPath' && bash scripts/watch_race_data.sh >> logs/watcher_cron.log 2>&1`"" `
  -WorkingDirectory $ROOT

$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday,Sunday -At 5:30am

$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 15) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 6)

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TASK_NAME `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Sat/Sun 7:00 JV-Link watcher auto-launch (retries until data arrives)" | Out-Null

Write-Output "[OK] Registered $TASK_NAME"
Get-ScheduledTask -TaskName $TASK_NAME | Get-ScheduledTaskInfo | Select-Object NextRunTime, LastRunTime, LastTaskResult | Format-Table -AutoSize | Out-String
