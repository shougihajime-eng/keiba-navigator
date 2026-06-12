# fetch_diff_hourly.ps1
# Wave35-A: JV-Link option=2 (diff + previous) hourly fetch
# Wave36: + 当日レースのRT単複オッズ(0B31)取得 + 当日予想の毎時更新 + precompute
# option=4 (setup) keeps returning rc=-501 from JRA-VAN server,
# but option=2 succeeds reliably and returns 2000-3000 new records per call.
#
# This script:
#   1. Runs jv_fetch.py aggregate --dataspec RACE --option 2 --fromtime <last_success_or_4days_ago>
#   1.5. (Wave36) 当日開催があれば各レースの単複オッズをRT取得 (オッズ変動=賢いお金の動きを signals に貯める)
#   2. If new records found, runs build_all + archive_signals + predict --all-today + race_card + features + train
#   3. Runs aggregate_recommendations + precompute_predictions
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

# ── 開催日ゲート (2026-06-09 追加・本人指摘「レースやってる時に取りに行け」) ──
# JRA中央競馬は土日(と3連休の月曜・祝日)のみ開催。前売りは前日(主に金)夕方〜。
# JV-Linkを叩く前に「本物のレースカレンダー(races\*.json)」を見て判断する:
#   ・土日 → 必ず実行
#   ・今日レースあり(祝日開催もカレンダーを見るので自動で拾える) → 実行
#   ・明日レースあり(前売り) → 実行
#   ・それ以外(平日でレース無し) → JV-Linkを叩かず即終了 (ムダ打ち・深夜rc=-504門前払いを防ぐ)
$dow = (Get-Date).DayOfWeek
$isWeekend = ($dow -eq [System.DayOfWeek]::Saturday) -or ($dow -eq [System.DayOfWeek]::Sunday)
$gateTodayStr = (Get-Date).ToString("yyyyMMdd")
$gateTomorrowStr = (Get-Date).AddDays(1).ToString("yyyyMMdd")
$gateRacesDir = Join-Path $KEIBA_ROOT "data\jv_cache\races"
$raceToday = @(Get-ChildItem $gateRacesDir -Filter ($gateTodayStr + "*.json") -ErrorAction SilentlyContinue).Count -gt 0
$raceTomorrow = @(Get-ChildItem $gateRacesDir -Filter ($gateTomorrowStr + "*.json") -ErrorAction SilentlyContinue).Count -gt 0
if (-not ($isWeekend -or $raceToday -or $raceTomorrow)) {
    Write-Log ("開催日ゲート: 今日も明日もレース無しの平日 (" + $dow + ")。JV-Linkを叩かず終了。")
    exit 0
}
Write-Log ("開催日ゲート通過 (weekend=" + $isWeekend + " raceToday=" + $raceToday + " raceTomorrow=" + $raceTomorrow + ")")

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

# Wave36: 当日+翌日開催があれば単複オッズ(0B31)をRT取得。
# 蓄積系(option=2)は前売りオッズを運ばないため、これが無いと
# signals のオッズ変動(money_in/money_out=賢いお金の動き)が一生貯まらない。
# 翌日分も取るのは、JRAの前売りが前日夕方から始まるため (金曜夜に土曜の予想が立つ)。
# 失敗(rc=-114=未発売など)は正常な拒否として無視する。
$todayStr = (Get-Date).ToString("yyyyMMdd")
$tomorrowStr = (Get-Date).AddDays(1).ToString("yyyyMMdd")
$RACES_DIR = Join-Path $KEIBA_ROOT "data\jv_cache\races"
$rtTargets = @()
foreach ($dstr in @($todayStr, $tomorrowStr)) {
    $rtTargets += @(Get-ChildItem $RACES_DIR -Filter ($dstr + "*.json") -ErrorAction SilentlyContinue)
}
if ($rtTargets.Count -gt 0) {
    Write-Log ("RT odds (0B31) fetch for " + $rtTargets.Count + " races (today+tomorrow)...")
    $rtOk = 0
    $rtFails = @{}
    foreach ($rf in $rtTargets) {
        $rid = [System.IO.Path]::GetFileNameWithoutExtension($rf.Name)
        $rtOut = & py -3.12-32 $JV_FETCH rt --dataspec 0B31 --raceid $rid 2>&1
        if ($LASTEXITCODE -eq 0) {
            $rtOk++
        } else {
            # 失敗理由(rc=コード)を必ず集計してログに残す。
            # 2026-06-06/07 の土日、レースID桁違い(18桁)で全RT取得が rc=-114 で
            # 二日間黙って全滅した事故の再発防止: 失敗を Out-Null で捨てない。
            $lastLine = ($rtOut | Select-Object -Last 1)
            if ("$lastLine" -match 'rc=(-?\d+)') { $key = "rc=" + $Matches[1] } else { $key = "other" }
            if ($rtFails.ContainsKey($key)) { $rtFails[$key]++ } else { $rtFails[$key] = 1 }
        }
    }
    Write-Log ("RT odds fetch done (" + $rtOk + "/" + $rtTargets.Count + " ok)")
    if ($rtFails.Count -gt 0) {
        $detail = ($rtFails.GetEnumerator() | ForEach-Object { $_.Key + " x" + $_.Value }) -join ", "
        Write-Log ("  RT failures: " + $detail)
    }
    # 発売中の時間帯 (9:00-16:59) に今日のレースがあるのに 1 件も取れない = 異常。
    # rc=-114 を「未発売の正常拒否」と同一視して黙る設計が事故の温床だったため、警報を出す。
    $hourNow = (Get-Date).Hour
    $todayCount = @($rtTargets | Where-Object { $_.Name -like ($todayStr + "*") }).Count
    if ($rtOk -eq 0 -and $todayCount -gt 0 -and $hourNow -ge 9 -and $hourNow -le 16) {
        Write-Log ("  [ALERT] 発売中の時間帯なのに RT オッズが 1 件も取れていない (today races=" + $todayCount + ")。レースID形式や JV-Link を確認すること。")
    }
    # 前売り時間帯 (19時以降) に翌日レースがあるのに 1 件も取れない場合も警報。
    # JRA の前売りは前日夕方 (18:30 頃〜) に始まるため、金曜夜にここが 0 件のままなら
    # 土曜本番も失敗する可能性が高い = 当日を待たずに金曜夜に気づける。
    $tomorrowCount = @($rtTargets | Where-Object { $_.Name -like ($tomorrowStr + "*") }).Count
    if ($rtOk -eq 0 -and $tomorrowCount -gt 0 -and $hourNow -ge 19) {
        Write-Log ("  [ALERT] 前売り時間帯なのに翌日レースの RT オッズが 1 件も取れていない (tomorrow races=" + $tomorrowCount + ")。前売り開始が遅い日もあるが、20:30 の回でも 0 件なら異常を疑うこと。")
    }
} else {
    Write-Log "No races today/tomorrow. RT odds fetch skipped."
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

# 硬い事実シグナルを日付つきで貯める箱に追記する。
# 当日のレースのオッズ変動(賢いお金の動き)/取消/馬体重増減/装備変更を時刻つきで残し、
# 数ヶ月後にリークなしで「本当に的中につながるか」を検証するための生ログ。
Write-Log "Running archive_signals (硬い事実シグナルの保存)..."
& py -3.12 (Join-Path $JV_BRIDGE "archive_signals.py") 2>&1 | ForEach-Object { Write-Log ("  " + $_) }

# Wave36: 当日+翌日レースの予想を最新オッズ込みで毎時更新。
# これが無いと土日の日中、オッズは毎時届くのに予想が朝のまま固まる。
# 翌日分は前日夜の前売りオッズで予想が立つ (日曜のWIN5を朝買う人に効く)。
Write-Log "Running predict_lightgbm (当日+翌日予想の更新)..."
& py -3.12 (Join-Path $JV_BRIDGE "predict_lightgbm.py") --date $todayStr 2>&1 | Select-Object -Last 1 | ForEach-Object { Write-Log ("  today: " + $_) }
& py -3.12 (Join-Path $JV_BRIDGE "predict_lightgbm.py") --date $tomorrowStr 2>&1 | Select-Object -Last 1 | ForEach-Object { Write-Log ("  tomorrow: " + $_) }

# 全レースカードを再生成 (事実メモ付き) → /api/race-card が返す race_card_latest.json を更新
Write-Log "Running build_race_card (全レースカード + 事実メモ)..."
& py -3.12 (Join-Path $JV_BRIDGE "build_race_card.py") 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Log ("  " + $_) }

# 事実シグナルの採点 (確定結果が貯まるほど精度が上がる)
Write-Log "Running validate_signals (事実シグナルの採点)..."
& py -3.12 (Join-Path $JV_BRIDGE "validate_signals.py") 2>&1 | Select-Object -Last 1 | ForEach-Object { Write-Log ("  " + $_) }

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

# Wave36: 本番 /api/races が読む predictions.json を再計算 (当日予想の本番反映に必須)
Write-Log "Running precompute_predictions.js..."
& node (Join-Path $KEIBA_ROOT "scripts\precompute_predictions.js") 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Log ("  " + $_) }

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
