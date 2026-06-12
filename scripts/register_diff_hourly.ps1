# register_diff_hourly.ps1
# 2026-06-09 改 (本人指摘「いつレースやってるか調べてから取りに行け」):
#   旧: 毎日 09:00-20:30 を毎時 + 深夜 0030/0330/0630。
#       → JRA中央は土日(と3連休の月曜・祝日)のみ開催。平日は「該当データなし」、
#         深夜はサーバーメンテで rc=-504 門前払い=ほぼ全部ムダ打ちだった。
#   新: レース日に合わせて取りに行く。
#       - 土日月 の日中 (09:00-17:30 毎時) … 本番(土日)+ 結果確定/祝日開催(月)
#       - 金土日月 の夕方 (18:30/19:30/20:30) … 前売りオッズ(前日夕方〜)
#       - 平日(火〜木)は毎日 07:00 の完全版リフレッシュ(KeibaGapFill-0700)に任せる
#       - fetch_diff_hourly.ps1 の「開催日ゲート」が、万一レース無しの日に起動しても
#         JV-Link を叩かず即終了する(祝日開催はカレンダーを見て自動で拾う二重の安全)
#   ExecutionTimeLimit 30分: 6/9 のように JVOpen が5時間ぶら下がる事故を防ぐ。

$ErrorActionPreference = "Continue"
$KEIBA_ROOT = (Get-Item (Join-Path $PSScriptRoot "..")).FullName
$PS_SCRIPT = Join-Path $KEIBA_ROOT "scripts\fetch_diff_hourly.ps1"
$HIDE_VBS = "C:\Users\shoug\自動実行ツール\かくれ実行.vbs"

if (-not (Test-Path $PS_SCRIPT)) {
    Write-Host ("[ERROR] script not found: " + $PS_SCRIPT)
    exit 1
}

# 日中の毎時 (土日月) と 夕方の前売り (金土日月)
$DAY_HOURS = @("09:00","09:30","10:30","11:30","12:30","13:30","14:30","15:30","16:30","17:30")
$EVE_HOURS = @("18:30","19:30","20:30")
$DAY_DOW = @("Saturday","Sunday","Monday")
$EVE_DOW = @("Friday","Saturday","Sunday","Monday")

# 黒い窓を出さないため かくれ実行.vbs 経由で起動 (全自動タスク共通の方式)
if (Test-Path $HIDE_VBS) {
    $Action = New-ScheduledTaskAction -Execute "wscript.exe" `
        -Argument ('"' + $HIDE_VBS + '" powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PS_SCRIPT + '"')
} else {
    $Action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument ("-ExecutionPolicy Bypass -WindowStyle Hidden -File `"" + $PS_SCRIPT + "`"")
}

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun `
    -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 20) `
    -MultipleInstances IgnoreNew -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# 旧スケジュール(毎日)の全タスクを撤去。深夜 0030/0330/0630 もここで消す。
$ALL_OLD = @("00:30","03:30","06:30") + $DAY_HOURS + $EVE_HOURS
foreach ($t in ($ALL_OLD | Select-Object -Unique)) {
    $n = "KeibaDiffFetch-" + $t.Replace(":","")
    Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
}

function RegDiff($t, $dow) {
    $name = "KeibaDiffFetch-" + $t.Replace(":","")
    $trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek $dow -At $t
    Register-ScheduledTask -TaskName $name -Action $Action -Trigger $trigger `
        -Settings $Settings -Principal $Principal `
        -Description ("smart diff fetch (option=2). days=" + ($dow -join ",")) | Out-Null
    Write-Host ("[OK] " + $name + " @ " + $t + " (" + ($dow -join ",") + ")")
}

foreach ($t in $DAY_HOURS) { RegDiff $t $DAY_DOW }
foreach ($t in $EVE_HOURS) { RegDiff $t $EVE_DOW }

Write-Host ""
Write-Host "=== Done: race-calendar-aware diff fetch schedule ==="
Write-Host "  day hourly 09:00-17:30 (Sat/Sun/Mon) + evening pre-sale 18:30-20:30 (Fri/Sat/Sun/Mon)"
Write-Host "  night 0030/0330/0630 removed (JRA-VAN maintenance window = rc=-504)"
Write-Host "  weekdays (Tue-Thu) handled by daily KeibaGapFill-0700"
