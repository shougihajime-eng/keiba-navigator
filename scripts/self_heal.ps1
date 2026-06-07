# self_heal.ps1 — 開催日の自動救急隊 (2026-06-08 本人「鳴らすだけでなく自動で直せ」指示で新設)
#
# 役割: 開催日の発売中、データの流れが死んでいたら「人を待たずに」自動で直し始める。
#   健康診断 → 異常なら
#   [1段目] 詰まった取得プロセスを片付けて、毎時取得をその場でやり直す (詰まり・取り損ね型の故障はこれで直る)
#   [2段目] それでも直らない = プログラム自体の故障 → Claude を自動起動して
#           原因調査→修正→テスト→反映までやらせる (scripts/self_heal_prompt.md が指示書)
#
# 起動: タスクスケジューラ KeibaSelfHeal (土日 9:48/11:48/13:48/15:48 + 金 20:48)
#       ※毎時取得(:30)と重ならない :48 に置く
# 手動テスト: powershell -File self_heal.ps1 -Force [-SkipL2] [-DateOverride yyyymmdd]

param(
    [switch]$Force,        # 曜日・時間帯のゲートを無視して健康診断から実行 (テスト用)
    [switch]$SkipL2,       # 2段目(Claude起動)を行わない (テスト用)
    [string]$DateOverride  # 「今日」を上書き (テスト用)
)

$ErrorActionPreference = "Continue"
$KEIBA_ROOT = (Get-Item (Join-Path $PSScriptRoot "..")).FullName
$LOG_DIR = Join-Path $KEIBA_ROOT "logs"
New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null
$LOG_PATH = Join-Path $LOG_DIR ("self_heal_" + (Get-Date -Format "yyyy-MM-dd") + ".log")

function Write-Log($msg) {
    $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $msg
    Add-Content -Path $LOG_PATH -Value $line -Encoding UTF8
    Write-Host $line
}

$today = if ($DateOverride) { $DateOverride } else { (Get-Date).ToString("yyyyMMdd") }
$tomorrow = (Get-Date).AddDays(1).ToString("yyyyMMdd")
$hour = (Get-Date).Hour
$CACHE = Join-Path $KEIBA_ROOT "data\jv_cache"
$RACES_DIR = Join-Path $CACHE "races"

$todayRaces = @(Get-ChildItem $RACES_DIR -Filter ($today + "*.json") -ErrorAction SilentlyContinue).Count
$tomorrowRaces = @(Get-ChildItem $RACES_DIR -Filter ($tomorrow + "*.json") -ErrorAction SilentlyContinue).Count

# ── どのモードで動くか ─────────────────────────────
# raceday  = 今日レースあり + 発売中 (9-16時) → フル救急 (1段目+2段目)
# presale  = 明日レースあり + 19時以降 (前売り) → 1段目のみ (前売り開始が遅い日もあるため騒ぎすぎない)
$mode = $null
if ($Force) {
    $mode = if ($todayRaces -gt 0) { "raceday" } elseif ($tomorrowRaces -gt 0) { "presale" } else { "raceday" }
    Write-Log ("FORCE mode=" + $mode + " today=" + $today + " races=" + $todayRaces)
} elseif ($todayRaces -gt 0 -and $hour -ge 9 -and $hour -le 16) {
    $mode = "raceday"
} elseif ($tomorrowRaces -gt 0 -and $hour -ge 19) {
    $mode = "presale"
} else {
    Write-Log ("対象外 (today races=" + $todayRaces + " tomorrow=" + $tomorrowRaces + " hour=" + $hour + ")。何もせず終了。")
    exit 0
}

# ── 健康診断 ─────────────────────────────────────
function Test-Health {
    $problems = @()
    if ($mode -eq "presale") {
        # 前売り: 明日レースの単複オッズ (0B31) が今日のうちに 1 件でも取れているか
        $bins = @(Get-ChildItem $CACHE -Filter ("raw_0B31_" + $tomorrow.Substring(0,8) + "*.bin") -ErrorAction SilentlyContinue |
                  Where-Object { $_.LastWriteTime.Date -eq (Get-Date).Date })
        if ($bins.Count -eq 0) { $problems += "前売りオッズ未着 (raw_0B31_" + $tomorrow + "* が今日 0 件)" }
        return $problems
    }
    # raceday:
    # (1) 今日のオッズ bin が直近 100 分以内に取れているか (毎時取得が生きている直接の証拠)
    $recentBins = @(Get-ChildItem $CACHE -Filter ("raw_0B31_" + $today + "*.bin") -ErrorAction SilentlyContinue |
                    Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-100) })
    if ($recentBins.Count -eq 0) { $problems += "当日オッズが100分以上止まっている (raw_0B31_" + $today + "*)" }
    # (2) 本番用予想 (predictions.json) が 2.5 時間以内に作り直されているか
    try {
        $pj = Get-Content (Join-Path $CACHE "predictions.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        $t = [DateTime]::Parse($pj.fetchedAt).ToLocalTime()
        if (((Get-Date) - $t).TotalHours -gt 2.5) { $problems += ("predictions.json が古い (" + $pj.fetchedAt + ")") }
    } catch { $problems += "predictions.json が読めない" }
    # (3) 全レース一覧が今日の日付か
    try {
        $rc = Get-Content (Join-Path $CACHE "race_card_latest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($rc.date -ne $today) { $problems += ("race_card の日付が " + $rc.date + " のまま") }
    } catch { $problems += "race_card_latest.json が読めない" }
    return $problems
}

$problems = Test-Health
if ($problems.Count -eq 0) {
    Write-Log ("健康 (mode=" + $mode + ")。何もせず終了。")
    exit 0
}
Write-Log ("異常検知 (mode=" + $mode + "): " + ($problems -join " / "))

# ── 1段目: 詰まりの掃除 + 取得のやり直し ─────────────────
# 15分以上前から動き続けている jv_fetch (JV-Link 取得) は詰まりとみなして終了させる
$stale = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -like "*jv_fetch.py*" -and $_.CreationDate -lt (Get-Date).AddMinutes(-15) }
foreach ($p in @($stale)) {
    Write-Log ("詰まったプロセスを終了: PID " + $p.ProcessId + " (" + $p.CommandLine.Substring(0, [Math]::Min(80, $p.CommandLine.Length)) + ")")
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Log "1段目: fetch_diff_hourly をその場で再実行..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "fetch_diff_hourly.ps1") 2>&1 |
    Select-Object -Last 3 | ForEach-Object { Write-Log ("  | " + $_) }

$problems = Test-Health
if ($problems.Count -eq 0) {
    Write-Log "1段目で回復。終了。"
    exit 0
}
Write-Log ("1段目では直らず: " + ($problems -join " / "))

if ($mode -eq "presale") {
    Write-Log "前売りモードは1段目まで (前売り開始が遅い日の可能性があるため)。明日朝の救急隊と遠隔点検が再確認する。"
    exit 0
}
if ($SkipL2) { Write-Log "SkipL2 指定のため2段目は行わない。"; exit 0 }

# ── 2段目: Claude を自動起動して修理させる ─────────────────
# 暴走防止: 2時間以内に2段目を起動していたら見送る (修理中の多重起動を防ぐ)
$L2_STAMP = Join-Path $CACHE "self_heal_l2_last.txt"
if (Test-Path $L2_STAMP) {
    $last = [DateTime]::Parse((Get-Content $L2_STAMP -Raw).Trim())
    if (((Get-Date) - $last).TotalHours -lt 2) {
        Write-Log "2段目は2時間以内に起動済み (修理中とみなす)。多重起動を避けて終了。"
        exit 0
    }
}
(Get-Date).ToString("o") | Set-Content $L2_STAMP -Encoding ASCII

$CLAUDE_EXE = "C:\Users\shoug\.local\bin\claude.exe"
if (-not (Test-Path $CLAUDE_EXE)) { Write-Log "claude.exe が見つからない。2段目を実行できない。"; exit 1 }
Write-Log "2段目: Claude 救急隊を起動 (最大25分)..."
$outFile = Join-Path $LOG_DIR ("self_heal_claude_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".log")
$errFile = $outFile + ".err"
$prompt = "Read the file scripts/self_heal_prompt.md (UTF-8, Japanese) in this repository and follow its instructions exactly. Work autonomously without asking questions."
$proc = Start-Process -FilePath $CLAUDE_EXE `
    -ArgumentList @("-p", ('"' + $prompt + '"'), "--dangerously-skip-permissions") `
    -WorkingDirectory $KEIBA_ROOT -NoNewWindow -PassThru `
    -RedirectStandardOutput $outFile -RedirectStandardError $errFile
Wait-Process -Id $proc.Id -Timeout 1500 -ErrorAction SilentlyContinue
if (-not $proc.HasExited) {
    Write-Log "25分で終わらないため Claude を停止。"
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
} else {
    Write-Log ("Claude 救急隊 終了 (exit " + $proc.ExitCode + ")。記録: " + (Split-Path $outFile -Leaf))
}

$problems = Test-Health
if ($problems.Count -eq 0) {
    Write-Log "2段目で回復。終了。"
    exit 0
}
Write-Log ("2段目でも未回復: " + ($problems -join " / ") + " — アプリの赤い警告は出続ける。次回の救急隊/遠隔点検が引き継ぐ。")
exit 0
