# register_overnight_gapfill.ps1
# 2026-05-31 作成: 「空白の時間を埋める」自動化。
#  - 早朝(0〜8時)の空白時間に生データ取得タスクを追加 (cheap)
#  - 毎日 07:00 に完全版パイプライン (確定データ取得→予想→カード→push) を実行
#  - 6/1 の確定データ配信を早く拾うため 6/1 限定の早朝 comprehensive 実行を 2 本追加
# 既存の KeibaDiffFetch-0900〜2030 / Catchup / HealthCheck はそのまま温存。

$ErrorActionPreference = "Stop"
$root     = "C:\Users\shoug\競馬"
$fetchPs  = Join-Path $root "scripts\fetch_diff_hourly.ps1"
$pipeline = Join-Path $root "scripts\race_day_pipeline.py"
$py64     = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312-64\python.exe"
# 完全版パイプライン: 確定データ取得(option=1) + build + 予想 + カード + 推奨 + 事前計算 + push。
# 重い学習/検証/実験室はスキップ (毎日回す必要なし)。RT は非開催日に無駄なのでスキップ。
$pipeArgs = "--skip-rt --skip-train --skip-train-nopop --skip-validate --skip-experiment"

$settings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

function Reg($name, $action, $trigger, $desc) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Description $desc | Out-Null
    Write-Host "  registered: $name"
}

# --- 1) 早朝の空白を埋める cheap な生データ取得 (毎日) ---
foreach ($t in @("00:30", "03:30", "06:30")) {
    $name = "KeibaDiffFetch-" + ($t -replace ":", "")
    $a = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument ("-ExecutionPolicy Bypass -NonInteractive -File `"" + $fetchPs + "`"")
    $tr = New-ScheduledTaskTrigger -Daily -At $t
    Reg $name $a $tr "blank-hour raw fetch (option=2 diff)"
}

# --- 2) 毎日 07:00 完全版リフレッシュ (予想+カード+push) ---
$a = New-ScheduledTaskAction -Execute $py64 -Argument ("`"" + $pipeline + "`" " + $pipeArgs)
$tr = New-ScheduledTaskTrigger -Daily -At "07:00"
Reg "KeibaGapFill-0700" $a $tr "daily full refresh: fetch(option1)+predict+card+recommend+push"

# --- 3) 6/1 限定: 確定データ配信を早く拾う早朝 comprehensive (one-time) ---
foreach ($t in @("01:30", "04:30")) {
    $name = "KeibaGapFill-Jun1-" + ($t -replace ":", "")
    $a2 = New-ScheduledTaskAction -Execute $py64 -Argument ("`"" + $pipeline + "`" " + $pipeArgs)
    $tr2 = New-ScheduledTaskTrigger -Once -At ([DateTime]"2026-06-01 $t")
    Reg $name $a2 $tr2 "Jun1 overnight gap fill (one-time)"
}

Write-Host "DONE: overnight gap-fill tasks registered."
