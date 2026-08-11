# Register the daily "KeibaPremiumDays" scheduled task.
#
# What it does: runs scripts/jra_premium_days.mjs once a day (07:10) so that
# data/jv_cache/jra_premium.json always knows which days JRA raises the payout
# rate (Ultra 85% / Super 80% / Premium +5% / Plus10).
#
# IMPORTANT (project-wide rule): this .ps1 must stay ASCII-only.
#   Windows PowerShell 5.1 reads BOM-less .ps1 as Shift_JIS. A single Japanese
#   character can swallow the following line WITHOUT any error, silently
#   changing behaviour. All Japanese paths are derived from $PSScriptRoot
#   at run time instead of being written here.
#
# Usage (from anywhere):
#   powershell -ExecutionPolicy Bypass -File "<this file>"
#   powershell -ExecutionPolicy Bypass -File "<this file>" -Unregister

param([switch]$Unregister)

$ErrorActionPreference = 'Stop'

$TaskName   = 'KeibaPremiumDays'
$ScriptDir  = $PSScriptRoot                       # ...\keiba\scripts (may contain Japanese)
$ProjectDir = Split-Path -Parent $ScriptDir       # ...\keiba
$Target     = Join-Path $ScriptDir 'jra_premium_days.mjs'
$Hidden     = 'C:\Users\shoug\' + [char]0x81EA + [char]0x52D5 + [char]0x5B9F + [char]0x884C + [char]0x30C4 + [char]0x30FC + [char]0x30EB + '\' + [char]0x304B + [char]0x304F + [char]0x308C + [char]0x5B9F + [char]0x884C + '.vbs'

if ($Unregister) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "removed: $TaskName"
    } else {
        Write-Output "not found: $TaskName"
    }
    return
}

if (-not (Test-Path $Target)) { throw "script not found: $Target" }
if (-not (Test-Path $Hidden)) { throw "hidden-launcher not found: $Hidden" }

# Find node.exe. Prefer the WinGet build the other keiba tasks already use.
$NodeCandidates = @(
    'C:\Users\shoug\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.15.0-win-x64\node.exe',
    'C:\Program Files\nodejs\node.exe',
    'C:\Users\shoug\node-portable\node.exe'
)
$Node = $NodeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Node) { throw 'node.exe not found' }
Write-Output "node   : $Node"
Write-Output "script : $Target"

# Every scheduled task in this project goes through the hidden launcher so that
# no black console window steals keyboard focus.
$Arguments = '"{0}" "{1}" "{2}"' -f $Hidden, $Node, $Target

$Action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $Arguments -WorkingDirectory $ProjectDir
# 07:10 daily: after the overnight work, before KeibaGapFill-0800.
$Trigger = New-ScheduledTaskTrigger -Daily -At '07:10'
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -MultipleInstances IgnoreNew

# Re-registering can fail with "already exists" because of parent/child
# privilege differences, so always remove first.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings `
    -Description 'Fetch JRA premium (higher payout rate) days into data/jv_cache/jra_premium.json' | Out-Null

Write-Output "registered: $TaskName (daily 07:10)"
