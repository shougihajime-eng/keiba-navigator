# 3UJC キーで「状態を取得する」を非同期(PostMessage)で押し、試用期間中表示が消えるか確認する
$ErrorActionPreference = "Continue"
$exe = (Get-ChildItem "C:\Program Files (x86)\JRA-VAN\Data Lab" -Filter "JV-Link*.exe" | Select-Object -First 1).FullName
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class Ra {
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h,int id);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] public static extern int GetTxt(IntPtr h,uint m,int w,StringBuilder l);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="GetClassNameW")] public static extern int GCN(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p,EP cb,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 public delegate bool EP(IntPtr h,IntPtr l);
}
"@
function Txt($h,$id){ $c=[Ra]::GetDlgItem($h,$id); if($c -eq [IntPtr]::Zero){return "(none)"}; $sb=New-Object Text.StringBuilder 2048; [void][Ra]::GetTxt($c,0x000D,2048,$sb); return $sb.ToString() }
function FindDlg(){
  $global:hit=$null
  $cb=[Ra+EP]{ param($h,$l)
    $cn=New-Object Text.StringBuilder 64; [void][Ra]::GCN($h,$cn,64)
    if($cn.ToString() -eq "#32770" -and [Ra]::IsWindowVisible($h)){
      $global:tx=New-Object Collections.ArrayList
      $cc=[Ra+EP]{ param($ch,$cl); $sb=New-Object Text.StringBuilder 1024; [void][Ra]::GetTxt($ch,0x000D,1024,$sb); $s=$sb.ToString().Trim(); if($s.Length-gt0){[void]$global:tx.Add($s)}; return $true }
      [void][Ra]::EnumChildWindows($h,$cc,[IntPtr]::Zero)
      $body = ($global:tx -join " | ")
      # メイン設定ダイアログ(利用キー設定 等を含む)はスキップし、メッセージ系の小ダイアログだけ拾う
      if($body -notmatch "利用キー設定" -and $body.Length -lt 200){ $global:hit=@{H=$h;B=$body} }
    }
    return $true }
  [void][Ra]::EnumWindows($cb,[IntPtr]::Zero)
  return $global:hit
}

$p=Start-Process $exe -PassThru; Start-Sleep -Seconds 4; $p.Refresh(); $m=$p.MainWindowHandle
Write-Output "main=$m  key-in-registry=3UJC"
Write-Output ("BEFORE-234=[{0}]" -f (Txt $m 234))
[void][Ra]::SetForegroundWindow($m); Start-Sleep -Milliseconds 500
# 261 = 状態を取得する を PostMessage(BM_CLICK 非同期)
$btn=[Ra]::GetDlgItem($m,261)
[void][Ra]::PostMessage($btn,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)
# サーバ応答ダイアログを最大40秒待つ
$dlg=$null
for($i=0;$i -lt 40;$i++){ Start-Sleep -Seconds 1; $d=FindDlg; if($d){ $dlg=$d; break } }
if($dlg){ Write-Output ("POPUP=[{0}]" -f $dlg.B); [void][Ra]::PostMessage($dlg.H,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) } # WM_CLOSE
else { Write-Output "POPUP=(none within 40s)" }
Start-Sleep -Seconds 3
Write-Output ("AFTER-234=[{0}]" -f (Txt $m 234))
Start-Sleep -Milliseconds 500
try{$p.CloseMainWindow()|Out-Null}catch{}; Start-Sleep -Seconds 2
try{if(-not $p.HasExited){$p.Kill()}}catch{}
Write-Output "DONE"
