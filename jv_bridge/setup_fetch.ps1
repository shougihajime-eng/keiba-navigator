# ============================================================
#  setup_fetch.ps1
#  JRA-VAN "setup data" (10 years of history) fetcher.
#
#  WHY THIS EXISTS
#  ---------------
#  Normal data (option=1) only goes back about 12 months.
#  To get 10 years you must use SETUP data (option=3 or 4).
#  Setup opens a modal dialog whose DEFAULT answer is
#  "I have the start kit (CD/DVD-ROM)" -- but JRA-VAN stopped
#  shipping those discs in March 2022, so the default always
#  fails with rc=-501.
#  There is ALSO a second follow-up dialog right after it.
#  If either dialog is left unanswered, JVOpen blocks forever.
#
#  This script starts the fetch and answers BOTH dialogs
#  automatically, so nobody has to click anything.
#
#  IMPORTANT
#  ---------
#  * Must run in a NORMAL (visible) window. If the process is
#    started hidden, the dialog cannot be answered and JVOpen
#    hangs forever with 0% CPU.
#  * JV-Link cannot run twice at once. This script refuses to
#    start if another fetch is running.
#
#  NOTE FOR MAINTAINERS: this file is ASCII-only on purpose.
#  Windows PowerShell 5.1 reads BOM-less .ps1 as Shift-JIS and
#  silently eats lines that contain Japanese. Japanese button
#  captions are therefore built from [char] codes below.
# ============================================================
param(
  [string]$DataSpec   = 'RACE',
  [string]$FromTime   = '20140101000000',
  [int]   $Option     = 3,
  [int]   $TimeoutMin = 90,
  [string]$OutDir     = '',   # isolated mode: put raw data here (relative to data/jv_cache is OK)
  [switch]$ProbeOnly          # only ask "how many files?", do not download/read
)
# ---- WHY -OutDir MATTERS -------------------------------------------------
#  build_all.py (the every-morning importer) auto-globs
#      data/jv_cache/aggregate_*/raw_*.bin
#  If the 10-year setup dump (multi-GB, ONE file) lands there, the next
#  morning run tries to expand 10 years at once. That run uses 32-bit
#  Python (2GB address space) -> MemoryError, and every later morning the
#  huge file is pulled in as a "companion" file because it also contains
#  today's races. So: fetch into an isolated folder, import explicitly.
# --------------------------------------------------------------------------

$ErrorActionPreference = 'Continue'

# --- where things are -------------------------------------------------
$root  = Split-Path -Parent $PSScriptRoot          # ...\keiba
$py    = 'C:\Users\shoug\AppData\Local\Programs\Python\Python312-32\python.exe'
$cache = 'C:\ProgramData\JRA-VAN\Data Lab'
$log   = Join-Path $PSScriptRoot 'setup_fetch.log'

function Say($m){
  $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m)
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding UTF8
}

if(-not (Test-Path $py)){ Say 'FATAL: 32bit Python not found.'; exit 9 }

# --- preflight: JV-Link must not be busy ------------------------------
$busy = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and (
    $_.CommandLine -like '*jv_fetch.py*' -or
    $_.CommandLine -like '*collect_exotic_odds.py*' -or
    $_.CommandLine -like '*probe_history.py*'
  )
}
if($busy){
  Say 'ABORT: another JV-Link job is already running:'
  foreach($b in $busy){ Say ('   pid=' + $b.ProcessId) }
  exit 8
}
foreach($lk in @('fetch_diff.lock','near_post.lock')){
  $lp = Join-Path $root ('data\jv_cache\' + $lk)
  if(Test-Path $lp){ Say ('ABORT: lock file present -> ' + $lp); exit 8 }
}

# --- build the command ------------------------------------------------
if($ProbeOnly){
  $script = 'jv_bridge\probe_history.py'
  $argline = ('{0} --dataspec {1} --option {2} --fromtime {3}' -f $script,$DataSpec,$Option,$FromTime)
} else {
  $script = 'jv_bridge\jv_fetch.py'
  $argline = ('{0} aggregate --dataspec {1} --option {2} --fromtime {3}' -f $script,$DataSpec,$Option,$FromTime)
  if($OutDir -ne ''){ $argline = $argline + (' --outdir "{0}"' -f $OutDir) }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outF  = Join-Path $PSScriptRoot ('_setup_{0}_{1}.out.txt' -f $DataSpec,$stamp)
$errF  = Join-Path $PSScriptRoot ('_setup_{0}_{1}.err.txt' -f $DataSpec,$stamp)

Say ('START dataspec=' + $DataSpec + ' option=' + $Option + ' fromtime=' + $FromTime + ' probeOnly=' + $ProbeOnly)

# --- Win32 helpers for answering the dialogs --------------------------
$sig = @'
using System;using System.Text;using System.Runtime.InteropServices;
public class JvDlg{
 public delegate bool EP(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p,EP cb,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static string T(IntPtr h){var s=new StringBuilder(512);GetWindowTextW(h,s,512);return s.ToString();}
 public static string C(IntPtr h){var s=new StringBuilder(256);GetClassNameW(h,s,256);return s.ToString();}
}
'@
if(-not ([System.Management.Automation.PSTypeName]'JvDlg').Type){ Add-Type -TypeDefinition $sig }

# "motte-inai"  = "(I do) NOT have (the start kit)"
$NEEDLE = [string]([char]0x6301+[char]0x3063+[char]0x3066+[char]0x3044+[char]0x306A+[char]0x3044)
$BM_CLICK    = 0x00F5
$BM_GETCHECK = 0x00F0

$p = Start-Process -FilePath $py -ArgumentList $argline -WorkingDirectory $root `
       -RedirectStandardOutput $outF -RedirectStandardError $errF -PassThru
$target = [uint32]$p.Id
Say ('  python pid=' + $p.Id)

$deadline = (Get-Date).AddMinutes($TimeoutMin)
$answered = @{}
$lastMB = -1

while((Get-Date) -lt $deadline){
  Start-Sleep -Seconds 10
  if($p.HasExited){ break }

  # -- find and answer any modal dialog owned by our python process --
  $script:dlgs = New-Object System.Collections.ArrayList
  $cb = [JvDlg+EP]{
    param($h,$l)
    $wp=[uint32]0; [void][JvDlg]::GetWindowThreadProcessId($h,[ref]$wp)
    if($wp -eq $target -and [JvDlg]::C($h) -eq '#32770'){ [void]$script:dlgs.Add($h) }
    return $true
  }
  [void][JvDlg]::EnumWindows($cb,[IntPtr]::Zero)

  foreach($dh in $script:dlgs){
    $script:radio=[IntPtr]::Zero; $script:ok=[IntPtr]::Zero
    $cb2 = [JvDlg+EP]{
      param($h2,$l2)
      if([JvDlg]::C($h2) -eq 'Button'){
        $tt=[JvDlg]::T($h2)
        if($tt.Contains($NEEDLE)){ $script:radio=$h2 } elseif($tt -eq 'OK'){ $script:ok=$h2 }
      }
      return $true
    }
    [void][JvDlg]::EnumChildWindows($dh,$cb2,[IntPtr]::Zero)

    if($script:radio -ne [IntPtr]::Zero){
      # dialog 1: choose "I do NOT have the start kit", then OK
      [void][JvDlg]::SendMessage($script:radio,$BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero)
      Start-Sleep -Milliseconds 800
      $chk = [JvDlg]::SendMessage($script:radio,$BM_GETCHECK,[IntPtr]::Zero,[IntPtr]::Zero)
      Say ('  dialog#1 "no start kit" selected (check=' + $chk + ')')
      if($script:ok -ne [IntPtr]::Zero){
        [void][JvDlg]::SendMessage($script:ok,$BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero)
        Say '  dialog#1 OK pressed'
      }
    }
    elseif($script:ok -ne [IntPtr]::Zero){
      # dialog 2 (follow-up notice): just OK.
      # THIS ONE IS EASY TO MISS -- forgetting it makes JVOpen hang forever.
      $k = $dh.ToString()
      if(-not $answered.ContainsKey($k)){
        $answered[$k] = 1
        [void][JvDlg]::SendMessage($script:ok,$BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero)
        Say '  dialog#2 (follow-up) OK pressed'
      }
    }
  }

  # -- progress --
  $fl = Get-ChildItem $cache -Recurse -File -ErrorAction SilentlyContinue
  $mb = [math]::Round(($fl | Measure-Object Length -Sum).Sum/1MB,1)
  if($mb -ne $lastMB){
    Say ('  downloading... cacheFiles=' + $fl.Count + ' cacheMB=' + $mb)
    $lastMB = $mb
  }
}

$hung = -not $p.HasExited
if($hung){
  Say 'TIMEOUT -> stopping python so JV-Link is not held.'
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1000
}

Say '--- python stdout ---'
if(Test-Path $outF){ foreach($l in (Get-Content $outF -Encoding UTF8)){ Say ('  ' + $l) } }
if(Test-Path $errF){
  $errTxt = Get-Content $errF -Encoding UTF8
  if($errTxt){ Say '--- python stderr ---'; foreach($l in $errTxt){ Say ('  ' + $l) } }
}

# -- guarantee nothing is left holding JV-Link --
$left = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and ($_.CommandLine -like '*jv_fetch.py*' -or $_.CommandLine -like '*probe_history.py*')
}
if($left){
  Say 'cleaning up leftover processes'
  foreach($x in $left){ Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }
} else {
  Say 'OK: no leftover JV-Link process.'
}

# Drop the temp files; everything is already copied into setup_fetch.log.
# (This comment MUST stay ASCII: PS 5.1 reads BOM-less .ps1 as Shift-JIS and a
#  Japanese comment silently swallows the next line -- see global CLAUDE.md.)
Remove-Item $outF -ErrorAction SilentlyContinue
Remove-Item $errF -ErrorAction SilentlyContinue

if($hung){ exit 7 } else { exit 0 }
