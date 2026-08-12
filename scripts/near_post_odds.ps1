# ============================================================
# near_post_odds.ps1 - Fetch odds right before each race and publish.
#
# WHY THIS EXISTS (2026-08-11):
#   The owner said: "You are not looking at the odds. Odds keep moving,
#   but the prediction never changes."  He was right.
#   - Odds were only refreshed once per hour (KeibaDiffFetch-*).
#     Odds move the most in the last 30 minutes before post time,
#     and that whole window was missed.
#   - A per-race scheduler script existed (register_per_race_scheduler.ps1)
#     but ZERO tasks were ever registered, so it never ran.
#     Worse, it GUESSED post times as "09:50 + 25min * raceNo" instead of
#     using the real hassou_time that is already in the data.
#
#   This script uses the REAL post time (hassou_time, "HHMM" JST) from
#   data/jv_cache/races/<YYYYMMDD>*.json, and when any race is inside the
#   window (T-20min .. T+2min) it:
#     1. fetches realtime win/place odds (0B31) for those races
#     2. re-runs the prediction for today
#     3. re-runs precompute (what /api/races serves)
#     4. commits + pushes so production shows fresh odds
#
#   When no race is close to post time it exits in under a second.
#
# 2026-08-12 SCHEDULE FIX (found by scripts/near_post_verify.mjs):
#   The task was registered as 09:20 + repeat every 2min for 7h40m, i.e. it
#   STOPPED AT 17:00. That came from the wrong belief that "JRA races run until
#   about 16:40". In summer they do not:
#     JRA runs a TWO-PART day (2-bu-sei, a heat countermeasure) at Niigata and
#     Chukyo in late July / August. Races 1-5 run 09:40-11:50, then a ~3h20m
#     break, then races 6-12 run 15:00-18:30.
#     Measured in our own data: 28 such meeting-days across 2025 and 2026,
#     only at Niigata and Chukyo, always a gap right after race 5.
#     Cross-checked against netkeiba: 2026-08-09 Niigata 7R 15:35 = Leopard S
#     (G3), and 2026-07-26 Niigata 7R 15:45 = the 61st running (Sekiya Kinen).
#     So our race numbers and post times are correct; the schedule really is
#     split. 6 races per two-part day were NEVER covered by this task.
#   Duration raised to PT9H30M (09:20 -> 18:50).
#   IF THIS TASK IS EVER RE-REGISTERED, KEEP THE 9H30M DURATION.
#
# ASCII ONLY on purpose: PowerShell 5.1 reads BOM-less UTF-8 as Shift-JIS
# and SILENTLY EATS LINES when Japanese text is present (a comment can
# swallow the next line of code with no error). Japanese lives in the
# JSON config next to this file.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\near_post_odds.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\near_post_odds.ps1 -Force   (ignore the window, run once)
#   powershell -ExecutionPolicy Bypass -File scripts\near_post_odds.ps1 -DryRun  (look only, change nothing)
# ============================================================
param(
    [switch]$Force,
    [switch]$DryRun,
    # TEST ONLY: pretend "now" is this time today, e.g. -TestNow "09:35".
    # Needed because the window logic can only be verified honestly if we can
    # simulate a time of day. JRA races run 09:50-16:40 so real runs never use this.
    [string]$TestNow = ""
)

$ErrorActionPreference = "Continue"

$KEIBA_ROOT = Split-Path -Parent $PSScriptRoot
$CACHE      = Join-Path $KEIBA_ROOT "data\jv_cache"
$RACES_DIR  = Join-Path $CACHE "races"
$JV_BRIDGE  = Join-Path $KEIBA_ROOT "jv_bridge"
$JV_FETCH   = Join-Path $JV_BRIDGE "jv_fetch.py"
$LOG_DIR    = Join-Path $KEIBA_ROOT "logs"
$LOG        = Join-Path $LOG_DIR ("near_post_" + (Get-Date -Format "yyyy-MM-dd") + ".log")
$STATE      = Join-Path $CACHE "near_post_state.json"

# Shared with fetch_diff_hourly.ps1 so we never drive JV-Link twice at once.
$HOURLY_LOCK = Join-Path $CACHE "fetch_diff.lock"
$MY_LOCK     = Join-Path $CACHE "near_post.lock"

# Minutes before post time to start refreshing, and minutes after to stop.
$WINDOW_BEFORE = 20
$WINDOW_AFTER  = 2

if (-not (Test-Path $LOG_DIR)) { New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null }

function Write-Log($msg) {
    $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $msg
    Add-Content -Path $LOG -Value $line -Encoding UTF8
}

# ---- single instance guard (self-healing: a dead PID or a stale lock is ignored) ----
function Test-LockBusy($lockPath, $maxAgeMin) {
    if (-not (Test-Path $lockPath)) { return $false }
    try {
        $age = (Get-Date) - (Get-Item $lockPath).LastWriteTime
        if ($age.TotalMinutes -gt $maxAgeMin) { return $false }
        $lp = (Get-Content $lockPath -Raw -ErrorAction Stop).Trim()
        if ($lp -match '^\d+$') {
            $p = Get-Process -Id ([int]$lp) -ErrorAction SilentlyContinue
            if ($null -eq $p) { return $false }
            return $true
        }
        return $true
    } catch { return $false }
}

if (Test-LockBusy $MY_LOCK 20) {
    Write-Log "another near_post run is active - exit"
    exit 0
}
if (Test-LockBusy $HOURLY_LOCK 25) {
    Write-Log "hourly fetch is running (JV-Link busy) - exit"
    exit 0
}

# ---- find races that are close to their REAL post time ----
# NOTE: post time is built from TODAY's date. JRA races run 09:50-16:40 so this
# never crosses midnight in real use. Do not reuse this as-is for night racing.
$nowJst = Get-Date
if ($TestNow -ne "") {
    if ($TestNow -notmatch '^\d{1,2}:\d{2}$') { Write-Host "bad -TestNow (want HH:mm)"; exit 2 }
    $tp = $TestNow.Split(":")
    $nowJst = Get-Date -Hour ([int]$tp[0]) -Minute ([int]$tp[1]) -Second 0
    Write-Host ("TESTNOW pretending it is " + $nowJst.ToString("HH:mm"))
}
$today  = $nowJst.ToString("yyyyMMdd")

if (-not (Test-Path $RACES_DIR)) {
    Write-Log "no races dir - exit"
    exit 0
}

$targets = @()
$soonest = $null
Get-ChildItem -Path $RACES_DIR -Filter ($today + "*.json") -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        $r = Get-Content $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch { return }
    $hhmm = ""
    if ($null -ne $r.hassou_time) { $hhmm = ([string]$r.hassou_time).Trim() }
    if ($hhmm.Length -ne 4) { return }
    if ($hhmm -notmatch '^\d{4}$') { return }
    $hh = [int]$hhmm.Substring(0, 2)
    $mm = [int]$hhmm.Substring(2, 2)
    if ($hh -gt 23 -or $mm -gt 59) { return }
    $post = Get-Date -Year $nowJst.Year -Month $nowJst.Month -Day $nowJst.Day -Hour $hh -Minute $mm -Second 0
    $mins = ($post - $nowJst).TotalMinutes
    if ($null -eq $soonest -or ($mins -ge (-1 * $WINDOW_AFTER) -and $mins -lt $soonest)) {
        if ($mins -ge (-1 * $WINDOW_AFTER)) { $soonest = $mins }
    }
    if ($mins -le $WINDOW_BEFORE -and $mins -ge (-1 * $WINDOW_AFTER)) {
        $rid = [string]$r.race_id
        if ([string]::IsNullOrWhiteSpace($rid)) { $rid = $_.BaseName }
        $targets += $rid
    }
}

$targets = @($targets | Select-Object -Unique)

if ($targets.Count -eq 0 -and -not $Force) {
    if ($null -ne $soonest) {
        Write-Log ("no race within " + $WINDOW_BEFORE + " min (next in " + [math]::Round($soonest, 1) + " min) - exit")
    } else {
        Write-Log "no upcoming race today - exit"
    }
    exit 0
}

if ($DryRun) {
    Write-Log ("DRYRUN targets=" + $targets.Count + " : " + ($targets -join ","))
    Write-Host ("targets=" + $targets.Count + " : " + ($targets -join ","))
    exit 0
}

# ---- take the lock ----
try { Set-Content -Path $MY_LOCK -Value ([string]$PID) -Encoding ASCII } catch {}

try {
    Write-Log ("START near-post refresh for " + $targets.Count + " race(s): " + ($targets -join ","))

    # 1) realtime win/place odds (0B31). jv_fetch normalises 18-digit ids to 16.
    $okCount = 0
    foreach ($rid in $targets) {
        try {
            $out = & py -3.12-32 $JV_FETCH rt --dataspec 0B31 --raceid $rid 2>&1
            $tail = ($out | Select-Object -Last 1)
            if ($LASTEXITCODE -eq 0) { $okCount++ } else { Write-Log ("  rt NG " + $rid + " : " + $tail) }
        } catch {
            Write-Log ("  rt EX " + $rid + " : " + $_.Exception.Message)
        }
    }
    Write-Log ("  rt odds ok " + $okCount + "/" + $targets.Count)

    if ($okCount -eq 0) {
        Write-Log "  no odds fetched - skip rebuild (do not publish stale data)"
        exit 0
    }

    # 2) rebuild race json from the raw bin we just pulled
    try {
        & py -3.12 (Join-Path $JV_BRIDGE "build_all.py") 2>&1 | Select-Object -Last 1 | ForEach-Object { Write-Log ("  build_all: " + $_) }
    } catch { Write-Log ("  build_all EX: " + $_.Exception.Message) }

    # 3) re-predict today with the fresh odds
    try {
        & py -3.12 (Join-Path $JV_BRIDGE "predict_lightgbm.py") --date $today 2>&1 | Select-Object -Last 1 | ForEach-Object { Write-Log ("  predict: " + $_) }
    } catch { Write-Log ("  predict EX: " + $_.Exception.Message) }

    # 4) rebuild what /api/races serves
    try {
        & node (Join-Path $KEIBA_ROOT "scripts\precompute_predictions.js") 2>&1 | Select-Object -Last 1 | ForEach-Object { Write-Log ("  precompute: " + $_) }
    } catch { Write-Log ("  precompute EX: " + $_.Exception.Message) }

    # 5) publish. Only data/jv_cache so we never sweep up someone else's work in progress.
    Push-Location $KEIBA_ROOT
    try {
        git add data/jv_cache 2>&1 | Out-Null
        git diff --cached --quiet
        if ($LASTEXITCODE -ne 0) {
            git commit -m ("near-post odds refresh (" + (Get-Date -Format "yyyy-MM-dd HH:mm") + ")") 2>&1 | Out-Null
            git push origin main 2>&1 | Out-Null
            Write-Log "  pushed"
        } else {
            Write-Log "  nothing changed - no push"
        }
    } catch {
        Write-Log ("  git EX: " + $_.Exception.Message)
    } finally {
        Pop-Location
    }

    try {
        $st = @{ lastRunISO = (Get-Date).ToString("o"); races = $targets; oddsOk = $okCount }
        $st | ConvertTo-Json -Compress | Set-Content -Path $STATE -Encoding UTF8
    } catch {}

    Write-Log "DONE"
}
finally {
    try { Remove-Item $MY_LOCK -Force -ErrorAction SilentlyContinue } catch {}
}
