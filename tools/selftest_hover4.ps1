# hover self-test v4
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Nat {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetThreadDpiAwarenessContext(IntPtr ctx);
}
'@
[Nat]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null

[Nat]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[Nat]::keybd_event(0x51, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[Nat]::keybd_event(0x51, 0, 2, [UIntPtr]::Zero)
[Nat]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 1500

$track = @('1200,900', '1250,920', '1300,940', '1350,960', '1400,980', '300,1100')
foreach ($p in $track) {
  $f = $p.Split(',')
  [Nat]::SetCursorPos([int]$f[0], [int]$f[1]) | Out-Null
  Start-Sleep -Milliseconds 40
}
Start-Sleep -Milliseconds 600
powershell -NoProfile -ExecutionPolicy Bypass -File tools\shot.ps1 -Tag v4_sidebar

[Nat]::SetCursorPos(2000, 980) | Out-Null
Start-Sleep -Milliseconds 700
powershell -NoProfile -ExecutionPolicy Bypass -File tools\shot.ps1 -Tag v4_para_gap

[Nat]::SetCursorPos(2400, 180) | Out-Null
Start-Sleep -Milliseconds 700
powershell -NoProfile -ExecutionPolicy Bypass -File tools\shot.ps1 -Tag v4_top_empty
Write-Host 'done'
