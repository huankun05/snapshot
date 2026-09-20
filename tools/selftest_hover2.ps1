# hover self-test v2
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
  Start-Sleep -Milliseconds 600
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "saved $path"
}

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
Shot 'F:\Work\Create\OCR\screenshot\_test\hover_empty_sidebar.png'

[Nat]::SetCursorPos(2000, 980) | Out-Null
Shot 'F:\Work\Create\OCR\screenshot\_test\hover_para_gap.png'

[Nat]::SetCursorPos(2400, 180) | Out-Null
Shot 'F:\Work\Create\OCR\screenshot\_test\hover_top_empty.png'
Write-Host 'done'
