# F1(Electron) vs F2(Tauri) 智能选框受控 A/B
#
# 目的：两版在同一物理坐标、同一静止鼠标下各触发一次截图，抓全虚拟屏截图 + 读各自日志，
# 做并排比对。踩过的坑：鼠标一动，capture.js 的新鲜度守卫（moved<=64）会把回包丢弃，
# 两版差异就会被"鼠标在动"这个噪声淹没 —— 所以必须把光标钉死。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\_ab_test.ps1 -X 1400 -Y 700
param(
  [int]$X = 1400,
  [int]$Y = 700,
  [int]$HoldMs = 2600
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Nat {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
'@
# PerMonitorV2 —— SetCursorPos / GetSystemMetrics 全走物理像素
[Nat]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null

Add-Type -AssemblyName System.Drawing

$outDir = 'F:\Work\Create\OCR\screenshot\_test'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

function Shot([string]$path) {
  $vx = [Nat]::GetSystemMetrics(76); $vy = [Nat]::GetSystemMetrics(77)
  $vw = [Nat]::GetSystemMetrics(78); $vh = [Nat]::GetSystemMetrics(79)
  $bmp = New-Object System.Drawing.Bitmap($vw, $vh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vx, $vy, 0, 0, (New-Object System.Drawing.Size($vw, $vh)))
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host ("shot -> {0}  (virtual {1},{2} {3}x{4})" -f $path, $vx, $vy, $vw, $vh)
}
function Key([byte]$vk, [int]$hold = 60) {
  [Nat]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds $hold
  [Nat]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
}
function Park([int]$px, [int]$py) {
  [Nat]::SetCursorPos($px, $py) | Out-Null
  Start-Sleep -Milliseconds 250
}

Write-Host "=== 目标物理坐标 ($X,$Y) ==="
Park $X $Y
Write-Host "--- 触发 F1 (Electron) ---"
Key 0x70
Start-Sleep -Milliseconds $HoldMs
Shot "$outDir\ab_F1_electron.png"
Key 0x1B
Start-Sleep -Milliseconds 900

Write-Host "--- 触发 F2 (Tauri) ---"
Park $X $Y
Key 0x71
Start-Sleep -Milliseconds $HoldMs
Shot "$outDir\ab_F2_tauri.png"
Key 0x1B
Start-Sleep -Milliseconds 900

Park $X $Y
Write-Host 'done'
