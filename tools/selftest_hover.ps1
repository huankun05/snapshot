# 悬停自测：触发 Alt+Q 截图 → 按轨迹移动光标 → 每步抓屏
# 用法：powershell -File tools\selftest_hover.ps1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
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

function Shot([string]$path) {
  Start-Sleep -Milliseconds 500
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "saved $path"
}

# 1. 触发 Alt+Q
[Nat]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[Nat]::keybd_event(0x51, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[Nat]::keybd_event(0x51, 0, 2, [UIntPtr]::Zero)
[Nat]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 1200

# 2. 依次移动到几个位置并抓屏（模拟滑动后停留）
$points = @('1500,1100,empty_lower', '900,650,mid_text')
foreach ($p in $points) {
  $f = $p.Split(',')
  [Nat]::SetCursorPos([int]$f[0], [int]$f[1]) | Out-Null
  Write-Host ("cursor -> {0},{1}" -f $f[0], $f[1])
  Shot ("F:\Work\Create\OCR\screenshot\_test\hover_{0}.png" -f $f[2])
}
Write-Host "done"
