# Per-race scheduler: 各レースの発走 15 分前 + 5 分前に RT データを取りに行く
# tomorrow_races.json + RA.hassou_time から計算
# Windows タスクスケジューラに個別タスクとして登録
#
# 使い方:
#   powershell -ExecutionPolicy Bypass -File scripts\register_per_race_scheduler.ps1
#
# 既存の固定 4 タスク (KeibaNavigator-Morning 等) と共存する追加レイヤー。
# 削除:
#   Get-ScheduledTask -TaskName 'KeibaPerRace-*' | Unregister-ScheduledTask -Confirm:$false

$ErrorActionPreference = "Continue"

$ScriptRoot = Split-Path -Parent $PSScriptRoot
$BatchFile = Join-Path $ScriptRoot "明日のレースを取る.bat"
$RacesJson = Join-Path $ScriptRoot "data\jv_cache\tomorrow_races.json"

if (-not (Test-Path $RacesJson)) {
    Write-Host "[NG] $RacesJson が見つかりません。先に race_day_pipeline.py を実行してください。"
    exit 1
}

# 既存の per-race タスクを全削除
Get-ScheduledTask -TaskName 'KeibaPerRace-*' -ErrorAction SilentlyContinue |
    Unregister-ScheduledTask -Confirm:$false

$data = Get-Content $RacesJson -Raw -Encoding utf8 | ConvertFrom-Json
$raceIds = $data.race_ids
$venues  = $data.venues
$dateStr = $data.date

if (-not $raceIds -or $raceIds.Count -eq 0) {
    Write-Host "[NG] tomorrow_races.json に race_ids がありません。"
    exit 1
}

# JRA の発走時刻は通常 9:50-16:40 の間で 30 分刻みが多い。
# 厳密な時刻は RA レコードの hassou_time に入っているが、ここでは概算で
# 「同日中の race_num 順 = 10 分刻みで 9:50 開始」として配置する。
# 実時刻と多少ズレても OK (T-15 で取れば T-5 にも残るので冗長性あり)。
$startHour = 9
$startMin = 50
$stepMin  = 25   # 各レース間隔 (実情に近い値)

$registered = 0
foreach ($rid in $raceIds) {
    # 18 桁 race_id: YYYYMMDDJJKK NN RR + 末尾 00
    # 場 (JJ) と R (RR) を抜き取り、時刻を計算
    if ($rid.Length -lt 16) { continue }
    $raceNum = [int]$rid.Substring(14, 2)
    if ($raceNum -le 0 -or $raceNum -gt 12) { continue }

    # 発走時刻 (推定): 9:50 + (raceNum - 1) * 25 分
    $totalMin = ($startHour * 60) + $startMin + ($raceNum - 1) * $stepMin
    $h = [Math]::Floor($totalMin / 60)
    $m = $totalMin % 60
    if ($h -ge 24) { continue }
    $postTime = Get-Date -Hour $h -Minute $m -Second 0

    # 発走の 15 分前
    $trigger15 = $postTime.AddMinutes(-15)
    # 発走の 5 分前
    $trigger5  = $postTime.AddMinutes(-5)

    # 過去時刻はスキップ
    $now = Get-Date
    foreach ($pair in @(@{T=$trigger15; suffix="T15"}, @{T=$trigger5; suffix="T5"})) {
        $t = $pair.T
        if ($t -lt $now) { continue }
        $taskName = "KeibaPerRace-$rid-$($pair.suffix)"
        $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }

        $Trigger = New-ScheduledTaskTrigger -Once -At $t
        # 1 度きりトリガで RT 取得 (BAT を --no-pause で起動)
        $Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$BatchFile`" --no-pause"
        $Settings = New-ScheduledTaskSettingsSet `
            -StartWhenAvailable `
            -DontStopOnIdleEnd `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -DeleteExpiredTaskAfter (New-TimeSpan -Hours 6) `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

        try {
            Register-ScheduledTask `
                -TaskName $taskName `
                -Description ("Per-race RT fetch: " + $rid + " " + $pair.suffix) `
                -Trigger $Trigger `
                -Action $Action `
                -Settings $Settings `
                -User $env:USERNAME -Force | Out-Null
            $registered += 1
        } catch {
            Write-Host ("[warn] " + $taskName + " 登録失敗: " + $_)
        }
    }
}

Write-Host ""
Write-Host "[OK] per-race タスクを $registered 件登録しました ($dateStr 開催の $($raceIds.Count) レース x 最大 2 トリガ)"
Write-Host ""
Write-Host "確認: Get-ScheduledTask -TaskName 'KeibaPerRace-*' | Select TaskName, @{N='time';E={\$_.Triggers[0].StartBoundary}}"
Write-Host "解除: Get-ScheduledTask -TaskName 'KeibaPerRace-*' | Unregister-ScheduledTask -Confirm:`$false"
