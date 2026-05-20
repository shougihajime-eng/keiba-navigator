# friday_evening_healthcheck.ps1
# Wave35-C: Friday evening health check before Saturday's race day
# Runs at 22:00 Friday to verify:
#   1. JV-Link connection alive
#   2. Tomorrow's races data exists (or attempts fetch)
#   3. Latest model is trained and recent
#   4. recommendations.json has fired strategies for tomorrow
#   5. Tasks scheduler entries exist
# Writes a summary to data/jv_cache/friday_health.json

$ErrorActionPreference = "Continue"
$KEIBA_ROOT = (Get-Item (Join-Path $PSScriptRoot "..")).FullName
$LOG_DIR = Join-Path $KEIBA_ROOT "logs"
New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
$LOG_PATH = Join-Path $LOG_DIR ("friday_health_" + (Get-Date -Format "yyyy-MM-dd") + ".log")
$HEALTH_PATH = Join-Path $KEIBA_ROOT "data\jv_cache\friday_health.json"

function Write-Log($msg) {
    $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $msg
    Add-Content -Path $LOG_PATH -Value $line -Encoding UTF8
    Write-Host $line
}

$health = @{
    checked_at = (Get-Date).ToString("o")
    checks     = @{}
    overall    = "OK"
}

# Check 1: JV-Link connection
Write-Log "Check 1: JV-Link connection"
$jvInit = & py -3.12-32 (Join-Path $KEIBA_ROOT "jv_bridge\jv_fetch.py") init 2>&1
$jvOk = ($LASTEXITCODE -eq 0)
$health.checks.jvlink = if ($jvOk) { "OK" } else { "NG" }
Write-Log ("  JV-Link: " + $health.checks.jvlink)

# Check 2: Tomorrow's races
Write-Log "Check 2: Tomorrow's races data"
$tomorrow = (Get-Date).AddDays(1).ToString("yyyyMMdd")
$RACES_DIR = Join-Path $KEIBA_ROOT "data\jv_cache\races"
$tomorrowFiles = @()
if (Test-Path $RACES_DIR) {
    $tomorrowFiles = Get-ChildItem $RACES_DIR -Filter ($tomorrow + "*.json") -ErrorAction SilentlyContinue
}
$health.checks.tomorrow_races = $tomorrowFiles.Count
Write-Log ("  Tomorrow races: " + $tomorrowFiles.Count)

if ($tomorrowFiles.Count -lt 5 -and $jvOk) {
    Write-Log "  Attempting to fetch tomorrow's data..."
    & py -3.12 (Join-Path $KEIBA_ROOT "scripts\fetch_tomorrow.py") 2>&1 | ForEach-Object { Write-Log ("    " + $_) }
    # Re-count
    $tomorrowFiles = Get-ChildItem $RACES_DIR -Filter ($tomorrow + "*.json") -ErrorAction SilentlyContinue
    $health.checks.tomorrow_races = $tomorrowFiles.Count
    Write-Log ("  After fetch: " + $tomorrowFiles.Count)
}

# Check 3: Latest model
Write-Log "Check 3: Latest model age"
$modelPath = Join-Path $KEIBA_ROOT "data\jv_cache\model_lgbm.txt"
if (Test-Path $modelPath) {
    $modelAge = ((Get-Date) - (Get-Item $modelPath).LastWriteTime).TotalHours
    $health.checks.model_age_hours = [math]::Round($modelAge, 1)
    Write-Log ("  Model age: " + $health.checks.model_age_hours + "h")
    if ($modelAge -gt 48) {
        Write-Log "  WARN: model is older than 48h"
        $health.overall = "WARN"
    }
} else {
    $health.checks.model_age_hours = -1
    $health.overall = "NG"
}

# Check 4: recommendations.json fired strategies
Write-Log "Check 4: recommendations.json"
$recPath = Join-Path $KEIBA_ROOT "data\jv_cache\recommendations.json"
if (Test-Path $recPath) {
    $rec = Get-Content $recPath -Raw | ConvertFrom-Json
    $health.checks.rec_today = $rec.count_today
    $health.checks.rec_recent = $rec.count_recent
    Write-Log ("  count_today: " + $rec.count_today)
    Write-Log ("  count_recent: " + $rec.count_recent)
} else {
    $health.checks.rec_today = -1
    Write-Log "  recommendations.json missing"
    $health.overall = "NG"
}

# Check 5: Saturday scheduler tasks
Write-Log "Check 5: Saturday scheduler"
$satTasks = Get-ScheduledTask | Where-Object { $_.TaskName -match "Keiba" } | Measure-Object
$health.checks.scheduler_tasks = $satTasks.Count
Write-Log ("  Keiba tasks: " + $satTasks.Count)
if ($satTasks.Count -lt 10) {
    Write-Log "  WARN: fewer than 10 Keiba tasks"
    $health.overall = "WARN"
}

# Write health JSON
$health | ConvertTo-Json -Depth 10 | Set-Content -Path $HEALTH_PATH -Encoding UTF8
Write-Log ("Health written to: " + $HEALTH_PATH)
Write-Log ("OVERALL: " + $health.overall)
exit 0
