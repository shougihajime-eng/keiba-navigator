# JV-Link 設定の「状態を取得する」を押して、表示メッセージを読み取る (読み取り主体・診断用)
$ErrorActionPreference = "Continue"
$exe = "C:\Program Files (x86)\JRA-VAN\Data Lab\JV-Link設定.exe"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class JvWin {
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int SendMessageText(IntPtr h, uint m, int w, StringBuilder l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
}
"@

function Get-CtrlText($h, $id) {
  $c = [JvWin]::GetDlgItem($h, $id)
  if ($c -eq [IntPtr]::Zero) { return "(no ctrl $id)" }
  $sb = New-Object System.Text.StringBuilder 1024
  [void][JvWin]::SendMessageText($c, 0x000D, 1024, $sb)  # WM_GETTEXT
  return $sb.ToString()
}

$proc = Start-Process $exe -PassThru
Start-Sleep -Seconds 3
$proc.Refresh()
$main = $proc.MainWindowHandle
Write-Output "main handle = $main"
[void][JvWin]::SetForegroundWindow($main)
Start-Sleep -Milliseconds 500

Write-Output "BEFORE 状態234 = [$((Get-CtrlText $main 234))]"

# 261 = 状態を取得する
$btn = [JvWin]::GetDlgItem($main, 261)
Write-Output "btn261 = $btn"
[void][JvWin]::SetForegroundWindow($main)
[void][JvWin]::SendMessage($btn, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)  # BM_CLICK
Start-Sleep -Seconds 8

# 押下後にポップアップ(#32770)が出ていないか全トップウィンドウを走査
$found = New-Object System.Collections.ArrayList
$cb = [JvWin+EnumProc]{
  param($h,$l)
  $cn = New-Object System.Text.StringBuilder 256
  [void][JvWin]::GetClassName($h,$cn,256)
  if ($cn.ToString() -eq "#32770") {
    $wt = New-Object System.Text.StringBuilder 512
    [void][JvWin]::GetWindowText($h,$wt,512)
    # ダイアログ内の static テキストも集める
    $texts = New-Object System.Collections.ArrayList
    $ccb = [JvWin+EnumProc]{
      param($ch,$cl)
      $sb = New-Object System.Text.StringBuilder 1024
      [void][JvWin]::SendMessageText($ch,0x000D,1024,$sb)
      $t = $sb.ToString().Trim()
      if ($t.Length -gt 0) { [void]$global:dlgTexts.Add($t) }
      return $true
    }
    $global:dlgTexts = New-Object System.Collections.ArrayList
    [void][JvWin]::EnumChildWindows($h,$ccb,[IntPtr]::Zero)
    [void]$global:found.Add("DIALOG title=[$($wt.ToString())] body=[$($global:dlgTexts -join ' | ')]")
  }
  return $true
}
$global:found = $found
[void][JvWin]::EnumWindows($cb,[IntPtr]::Zero)

Write-Output "AFTER  状態234 = [$((Get-CtrlText $main 234))]"
foreach ($f in $global:found) { Write-Output $f }

# 後片付け: ポップアップOK(通常 id 1 か 2) を閉じ、本体も閉じる
Start-Sleep -Milliseconds 500
try { $proc.CloseMainWindow() | Out-Null } catch {}
Start-Sleep -Seconds 2
try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
Write-Output "DONE"
