# ============================================================
# KEIBA NAVIGATOR  自動化ヘルスチェック (5/23 朝の自動診断用)
# ============================================================
# 役割:
#   - Windows ScheduledTask の最新実行結果
#   - ローカル status.json の最新 state
#   - predictions.json の鮮度
#   - 本番 (Vercel) の /api/automation-status の 4 セル状態
#  を一括チェックして、わかりやすい結果ファイルをデスクトップに出力する。
#
# 想定実行: 5/23 (土) 9:00 (Morning 8:30 の 30 分後 = 最初のデータ取得完了後)
# 出力先:    %USERPROFILE%\Desktop\keiba_check_YYYY-MM-DD.txt

$ErrorActionPreference = "Continue"

$ScriptRoot = Split-Path -Parent $PSScriptRoot
$StatusJson = Join-Path $ScriptRoot "data\jv_cache\_status.json"
$PredsJson  = Join-Path $ScriptRoot "data\jv_cache\predictions.json"
$Desktop    = [Environment]::GetFolderPath("Desktop")
$OutFile    = Join-Path $Desktop ("keiba_check_" + (Get-Date -Format "yyyy-MM-dd") + ".txt")

$now = Get-Date
$lines = New-Object System.Collections.ArrayList

function Add($txt)  { [void]$lines.Add($txt) }
function Hdr($txt)  { Add ""; Add "==============================================="; Add $txt; Add "===============================================" }

Add "KEIBA NAVIGATOR  自動化ヘルスチェック"
Add ("実行時刻: " + $now.ToString("yyyy-MM-dd HH:mm:ss"))
Add ""

# ─── 1) ScheduledTask の最新状態 ─────────────────────────────
Hdr "1. Windows タスクスケジューラ (Wave16 で登録した 7 タスク)"
$tasks = Get-ScheduledTask -TaskName 'KeibaNavigator-*' -ErrorAction SilentlyContinue
if (-not $tasks) {
    Add "[NG] KeibaNavigator-* タスクが 1 つも見つかりません"
} else {
    $okCount = 0
    foreach ($t in $tasks) {
        $info = Get-ScheduledTaskInfo -TaskName $t.TaskName
        $resHex = '0x{0:X}' -f $info.LastTaskResult
        # 0x0 = 成功, 0x41303 = 未実行 (新規登録直後など)
        $resLabel = switch ($info.LastTaskResult) {
            0       { "[OK] 成功"; $okCount++; break }
            267009  { "[--] 実行中" ; $okCount++; break }
            267011  { "[--] 未実行" ; break }
            default { "[NG] 失敗 ($resHex)" }
        }
        Add ("  " + $t.TaskName.PadRight(34) + " " + $resLabel + "  最終 " + $info.LastRunTime)
    }
    Add ""
    Add ("  -> 成功または実行中: " + $okCount + " / " + $tasks.Count + " タスク")
}

# ─── 2) JV-Link 状態 (status.json) ──────────────────────────
Hdr "2. JV-Link 状態 (data/jv_cache/_status.json)"
if (Test-Path $StatusJson) {
    try {
        $j = Get-Content -Path $StatusJson -Raw -Encoding utf8 | ConvertFrom-Json
        Add ("  state:     " + $j.state)
        Add ("  updatedAt: " + $j.updatedAt)
        if ($j.lastAggregate) {
            Add ("  最終 aggregate: " + $j.lastAggregate.fetchedAt + "  ($($j.lastAggregate.recordCount) レコード)")
        }
        if ($j.error) {
            Add ("  [WARN] error: " + $j.error)
        }
        if ($j.state -eq "ready") {
            Add "  -> [OK] JV-Link は正常稼働中"
        } elseif ($j.state -match "_failed") {
            Add "  -> [NG] JV-Link がエラー状態。利用キーの期限切れ / 接続不可の可能性"
        } elseif ($j.state -match "no_data") {
            Add ("  [WARN] データが 1 件も取れていません (state=" + $j.state + ")")
            Add "  -> 平日でレースが無い日なら正常。開催日や 2 日以上続くなら異常です。"
            Add "     いちばん多い原因: JV-Link に新しい版が出て、古い版が配信を止められている。"
            Add "     確認: https://jra-van.jp/dlb/sft/jv.html から最新の JV-Link を入れ直す"
            Add "     (今入っている版は Windows の アプリと機能 で JV-Link を見ると分かります)"
        } else {
            Add ("  [WARN] state=" + $j.state + " (ready でない状態です・確認してください)")
        }
    } catch {
        Add ("  [NG] status.json 読み込み失敗: " + $_.Exception.Message)
    }
} else {
    Add "  [NG] status.json が見つかりません"
}

# ─── 3) 予想の鮮度 (predictions.json) ───────────────────────
Hdr "3. 予想計算 (data/jv_cache/predictions.json)"
if (Test-Path $PredsJson) {
    $finfo = Get-Item $PredsJson
    $age = ($now - $finfo.LastWriteTime).TotalHours
    Add ("  最終更新: " + $finfo.LastWriteTime + ("  ({0:F1}h 前)" -f $age))
    Add ("  サイズ:   {0:N0} bytes" -f $finfo.Length)
    if ($age -lt 24) {
        Add "  -> [OK] 24h 以内に再計算済み"
    } elseif ($age -lt 72) {
        Add "  -> [WARN] 24-72h 前。週末ならOK・平日なら問題なし"
    } else {
        Add "  -> [NG] 72h 以上前。手動で再計算が必要かも"
    }
} else {
    Add "  [NG] predictions.json が見つかりません"
}

# ─── 4) 本番 (Vercel) の自動化ステータス ────────────────────
Hdr "4. 本番 (Vercel) /api/automation-status"
try {
    $resp = Invoke-RestMethod -Uri "https://keiba-navigator.vercel.app/api/automation-status" -TimeoutSec 15
    Add ("  ok:                    " + $resp.ok)
    Add ("  lastDataFetch:         " + $resp.lastDataFetch)
    Add ("  predictionsFresh:      " + $resp.predictionsFresh)
    Add ("  predictionsComputedAt: " + $resp.predictionsComputedAt)
    Add ("  lastGitPushDeploy:     " + $resp.lastGitPushDeploy)
    Add ("  nextCronFinalizeISO:   " + $resp.nextCronFinalizeISO)
    if ($resp.ok) {
        Add "  -> [OK] 本番側エンドポイント生存"
    } else {
        Add "  -> [NG] 本番が ok=false を返している"
    }
} catch {
    Add ("  [NG] 本番 /api/automation-status 取得失敗: " + $_.Exception.Message)
}

# ─── 5) 本番の主要エンドポイント ─────────────────────────────
Hdr "5. 本番 主要エンドポイント (5 個)"
$endpoints = @(
    @{path="/api/status";       expected=200},
    @{path="/api/races";        expected=200},
    @{path="/api/win5";         expected=200},
    @{path="/api/weather";      expected=200},
    @{path="/api/cron-finalize"; expected=401}
)
foreach ($e in $endpoints) {
    try {
        $r = Invoke-WebRequest -Uri ("https://keiba-navigator.vercel.app" + $e.path) -TimeoutSec 10 -UseBasicParsing -ErrorAction SilentlyContinue
        $code = $r.StatusCode
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
    }
    $mark = if ($code -eq $e.expected) { "[OK]" } else { "[NG]" }
    Add ("  " + $mark + " " + $e.path.PadRight(28) + " HTTP " + $code + " (期待 " + $e.expected + ")")
}

# ─── 6) 総合判定 ────────────────────────────────────────────
Hdr "総合判定"
$ngCount = ($lines | Where-Object { $_ -match "\[NG\]" }).Count
$warnCount = ($lines | Where-Object { $_ -match "\[WARN\]" }).Count
if ($ngCount -eq 0 -and $warnCount -eq 0) {
    Add "  >>> すべて緑。完全自動稼働中。何もしなくて OK。 <<<"
} elseif ($ngCount -eq 0) {
    Add ("  >>> [WARN] " + $warnCount + " 件。要確認 (NG はないので使えるはず)。 <<<")
} else {
    Add ("  >>> [NG] " + $ngCount + " 件 + [WARN] " + $warnCount + " 件。 <<<")
    Add "  >>> Claude にこのファイルを見せて修正を依頼してください <<<"
}

Add ""
Add "（このファイルは scripts\health_check.ps1 が自動生成。要らなくなったら削除可）"

# ─── 出力 (UTF-8 BOM 付きで文字化け回避) ────────────────────
$content = $lines -join "`r`n"
[System.IO.File]::WriteAllText($OutFile, $content, (New-Object System.Text.UTF8Encoding($true)))

Write-Output ("[OK] ヘルスチェック結果を出力: " + $OutFile)
