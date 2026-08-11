# ============================================================
# collect_exotic.ps1 - pre-race exotic odds collector wrapper (ASCII only).
#
# Invoked by scheduled task KeibaExoticOdds via kakure-jikkou.vbs (no window).
# Runs the 32-bit Python collector in --auto mode (only races near post time).
#
# WHY THE CADENCE CHANGED (2026-08-12):
#   The task used to fire every 15 minutes. Post times are usually on the
#   :00/:05/:10... mark, so the 15-minute grid kept landing EXACTLY ON or AFTER
#   post time: 114 of 433 stored races (26.3%) had their newest snapshot taken
#   after the horses had already left the gate. Every reader takes "the newest
#   .json" as the final odds, so the whole overlay backtest was scored with
#   prices nobody could actually bet on (121% -> ~100.7% once corrected).
#   Now this runs every 2 minutes; the Python side only calls JV-Link when the
#   current time-slot for a race has no snapshot yet, so the extra runs are
#   nearly free (a run with nothing to do exits in about a second).
#
# NOTE: keep this file ASCII-only; build Japanese paths from $PSScriptRoot so
#       Windows PowerShell 5.1 never mojibakes the path (and never silently
#       eats the next line of code, which is what Japanese comments do here).
# ============================================================
$ErrorActionPreference = "Continue"

$root   = Split-Path -Parent $PSScriptRoot           # scripts\ -> project root
$script = Join-Path $root "jv_bridge\collect_exotic_odds.py"
$logdir = Join-Path $root "logs"
if (-not (Test-Path $logdir)) { New-Item -ItemType Directory -Force -Path $logdir | Out-Null }

# One log file per day (the old single file had already grown to 240 KB of
# "nothing to do" lines). Nothing reads these logs; they are for diagnosis.
$log       = Join-Path $logdir ("collect_exotic_" + (Get-Date -Format "yyyy-MM-dd") + ".log")
$heartbeat = Join-Path $logdir "collect_exotic.heartbeat"
$stamp     = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# 32-bit Python (JV-Link is a 32-bit COM component)
$out = & py -3.12-32 $script --auto 2>&1
$code = $LASTEXITCODE

# Always leave a heartbeat so "is this task alive?" can be answered without
# reading the log. Only append to the log when something actually happened,
# so a race day stays readable instead of 240 idle entries.
try { Set-Content -Path $heartbeat -Value ("$stamp exit=$code") -Encoding ASCII } catch {}

$text = ($out | Out-String)
if ($text -match '\[(OK|NG|err|warn)\]' -or $code -ne 0) {
    Add-Content -Path $log -Value "[$stamp] start --auto" -Encoding UTF8
    Add-Content -Path $log -Value $text -Encoding UTF8
    Add-Content -Path $log -Value "[$stamp] done exit=$code" -Encoding UTF8
}
