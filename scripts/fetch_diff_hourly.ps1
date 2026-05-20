# fetch_diff_hourly.ps1
# Wave35-A: JV-Link option=2 (diff + previous) hourly fetch
# option=4 (setup) keeps returning rc=-501 from JRA-VAN server,
# but option=2 succeeds reliably and returns 2000-3000 new records per call.
#
# This script:
#   1. Runs jv_fetch.py aggregate --dataspec RACE --option 2 --fromtime <last_success_or_4days_ago>
#   2. If new records found, runs build_all + aggregate_features_v2 + train (primary + nopop)
#   3. Runs walk_forward_validate + aggregate_recommendations
#   4. git commit + push
#   5. Records last success timestamp in data/jv_cache/last_diff_fetch.txt
#
# Schedule: every hour 09:00-20:00 via Task Scheduler
# (race data builds up to 60 万 rows over time)

$ErrorActionPreference = "Continue"
$KEIBA_ROOT = (Get-Item (Join-Path $PSScriptRoot "..")).FullName
$LOG_DIR = Join-Path $KEIBA_ROOT "logs"
New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
$LOG_PATH = Join-Path $LOG_DIR ("fetch_diff_" + (Get-Date -Format "yyyy-MM-dd") + ".log")

function Write-Log($msg) {
    $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $msg
    Add-Content -Path $LOG_PATH -Value $line -Encoding UTF8
    Write-Host $line
}

# Get last success time
$LAST_PATH = Join-Path $KEIBA_ROOT "data\jv_cache\last_diff_fetch.txt"
$fromtime = ""
if (Test-Path $LAST_PATH) {
    $fromtime = (Get-Content $LAST_PATH -Raw).Trim()
}
if (-not $fromtime -or $fromtime.Length -lt 8) {
    # Default: 4 days ago
    $fromtime = (Get-Date).AddDays(-4).ToString("yyyyMMddHHmmss")
}
Write-Log ("fromtime = " + $fromtime)

# Run JV-Link fetch
# QA-1 FIX: Detect new records via filesystem (raw_*.bin newest mtime),
# not by parsing cp932-mangled stdout from jv_fetch.py.
$JV_FETCH = Join-Path $KEIBA_ROOT "jv_bridge\jv_fetch.py"
$AGG_DIR_PREFIX = Join-Path $KEIBA_ROOT "data\jv_cache"
$pre_max_mtime = $null
$pre_files = Get-ChildItem -Path $AGG_DIR_PREFIX -Recurse -Filter "raw_*.bin" -ErrorAction SilentlyContinue
if ($pre_files) {
    $pre_max_mtime = ($pre_files | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
}
Write-Log ("Pre-fetch newest raw_*.bin mtime = " + $pre_max_mtime)

Write-Log "JV-Link aggregate option=2 starting..."
$fetchOutput = & py -3.12-32 $JV_FETCH aggregate --dataspec RACE --option 2 --fromtime $fromtime 2>&1
$fetchExit = $LASTEXITCODE
$fetchOutput | ForEach-Object { Write-Log ("  " + $_) }

if ($fetchExit -ne 0) {
    Write-Log ("JV-Link fetch failed (exit " + $fetchExit + "). Skipping.")
    exit 1
}

# Check if a new raw_*.bin appeared (filesystem-based detection)
$post_files = Get-ChildItem -Path $AGG_DIR_PREFIX -Recurse -Filter "raw_*.bin" -ErrorAction SilentlyContinue
$post_max_mtime = $null
if ($post_files) {
    $post_max_mtime = ($post_files | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
}
$capturedNew = $false
if ($post_max_mtime -and ($pre_max_mtime -eq $null -or $post_max_mtime -gt $pre_max_mtime)) {
    $capturedNew = $true
    Write-Log ("New raw_*.bin detected (mtime " + $post_max_mtime + ")")
}

if (-not $capturedNew) {
    Write-Log "No new records detected via filesystem. Updating timestamp only."
    (Get-Date).ToString("yyyyMMddHHmmss") | Set-Content -Path $LAST_PATH -Encoding ASCII
    exit 0
}

Write-Log "New records captured. Running build_all..."

# Run build_all to update races/results JSONs
$JV_BRIDGE = Join-Path $KEIBA_ROOT "jv_bridge"
& py -3.12 (Join-Path $JV_BRIDGE "build_all.py") 2>&1 | ForEach-Object { Write-Log ("  " + $_) }

# Run aggregate_features_v2 to update features.json
Write-Log "Running aggregate_features_v2..."
& py -3.12 (Join-Path $JV_BRIDGE "aggregate_features_v2.py") 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Log ("  " + $_) }

# Skip re-training if recent (within 6 hours)
$MODEL_PATH = Join-Path $KEIBA_ROOT "data\jv_cache\model_lgbm.txt"
$skipTrain = $false
if (Test-Path $MODEL_PATH) {
    $modelAge = ((Get-Date) - (Get-Item $MODEL_PATH).LastWriteTime).TotalHours
    if ($modelAge -lt 6) {
        Write-Log ("Skipping re-train (model age " + [math]::Round($modelAge, 1) + "h)")
        $skipTrain = $true
    }
}

if (-not $skipTrain) {
    Write-Log "Re-training LightGBM..."
    & py -3.12 (Join-Path $JV_BRIDGE "train_lightgbm.py") 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Log ("  " + $_) }
    & py -3.12 (Join-Path $JV_BRIDGE "train_lightgbm.py") --no-pop 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Log ("  " + $_) }
}

# Update aggregate_recommendations.json
Write-Log "Running aggregate_recommendations..."
& py -3.12 (Join-Path $JV_BRIDGE "aggregate_recommendations.py") 2>&1 | Select-Object -Last 5 | ForEach-Object { Write-Log ("  " + $_) }

# Update timestamp
(Get-Date).ToString("yyyyMMddHHmmss") | Set-Content -Path $LAST_PATH -Encoding ASCII

# git commit + push (silently)
# QA-1 FIX: use git diff --cached --quiet (exit code) instead of broken Measure-Object
Push-Location $KEIBA_ROOT
try {
    git add -A 2>&1 | Out-Null
    git diff --cached --quiet
    $hasDiff = ($LASTEXITCODE -ne 0)
    if ($hasDiff) {
        git commit -m ("Wave35-A: hourly diff fetch (" + (Get-Date -Format "yyyy-MM-dd HH:mm") + ")") 2>&1 | Out-Null
        git push origin main 2>&1 | Out-Null
        Write-Log "git commit + push completed"
    } else {
        Write-Log "no diff to commit"
    }
} finally {
    Pop-Location
}

Write-Log "fetch_diff_hourly completed"
exit 0
