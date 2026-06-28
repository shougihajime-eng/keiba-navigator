# collect_exotic.ps1 - pre-race exotic odds collector wrapper (ASCII only).
# Invoked by scheduled task KeibaExoticOdds via kakure-jikkou.vbs (no window).
# Runs the 32-bit Python collector in --auto mode (only races near post time).
# NOTE: keep this file ASCII-only; build Japanese paths from $PSScriptRoot so
#       Windows PowerShell 5.1 never mojibakes the path.
$ErrorActionPreference = "Continue"
$root   = Split-Path -Parent $PSScriptRoot           # scripts\ -> project root
$script = Join-Path $root "jv_bridge\collect_exotic_odds.py"
$logdir = Join-Path $root "logs"
if (-not (Test-Path $logdir)) { New-Item -ItemType Directory -Force -Path $logdir | Out-Null }
$log = Join-Path $logdir "collect_exotic.log"
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $log -Value "[$stamp] start --auto"
# 32-bit Python (JV-Link is a 32-bit COM component)
& py -3.12-32 $script --auto 2>&1 | Add-Content -Path $log
Add-Content -Path $log -Value "[$stamp] done"
