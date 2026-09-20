# hover self-test v3: cursor in this proc (PMv2), capture in child procs
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

function Shot([string]$tag) {
  Start-Sleep -Milliseconds 700
  & powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; \=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \=New-Object System.Drawing.Bitmap(\.Width,\.Height); \=[System.Drawing.Graphics]::FromImage(\); \.CopyFromScreen(0,0,0,0,\.Size); \.Save('F:/Work/Create/OCR/screenshot/_test/.png',[System.Drawing.Imaging.ImageFormat]::Png)"
  Write-Host "shot $tag"
}

$track = @('1200,900', '1250,920', '1300,940', '1350,960', '1400,980', '300,1100')
foreach ($p in $track) {
  $f = $p.Split(',')
  [Nat]::SetCursorPos([int]$f[0], [int]$f[1]) | Out-Null
  Start-Sleep -Milliseconds 40
}
Shot 'v3_sidebar'

[Nat]::SetCursorPos(2000, 980) | Out-Null
Shot 'v3_para_gap'

[Nat]::SetCursorPos(2400, 180) | Out-Null
Shot 'v3_top_empty'
Write-Host 'done'
