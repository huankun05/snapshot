# 悬停靶点扫描：把物理坐标 → UIA 目标尺寸的映射打出来（2026-11-02）
#
# 用途：给 `_morph_curve.ps1` 找一对「小元素 ↔ 大元素」可配对的坐标，
#   让「小 → 大」的完整形变曲线能被采全。
#   （鼠标移到无 UIA 元素的区域 → 走「窗级大块兜底」，框会突然变成整屏 → 就是「闪亮」现场）
#
# 用法（必须 pwsh 7）：
#   & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -ExecutionPolicy Bypass `
#     -File tools\_scan_targets.ps1 -Points '-1500,370,-700,370,-2000,600'
param(
  [string]$Points = '-1500,370,-700,370,-2000,600,-400,700,-1500,1330,-1000,1000,-1500,370'
)
$ErrorActionPreference = 'Stop'
$wd = 'F:\Work\Create\OCR\screenshot'
$pts = @($Points -split ',' | ForEach-Object { [int]$_.Trim() })

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ScanPath {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetThreadDpiAwarenessContext(IntPtr ctx);
}
"@
[ScanPath]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
function Key([byte]$vk,[int]$hold=60){ [ScanPath]::keybd_event($vk,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds $hold; [ScanPath]::keybd_event($vk,0,2,[UIntPtr]::Zero) }

$f2log = Join-Path $env:TEMP 'petalsnap-spike.log'

Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Stop-Process -Force
# ⚠️ 必须先杀旧 F2：单实例锁 + env 只在窗口创建时求值 → 复用旧实例 = 开关没生效
Get-Process -Name 'petalsnap-tauri-spike' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
$env:PETALSNAP_SMART_DEBUG = '1'
$env:PETALSNAP_FRAME_PREPARE = '1'
$env:PETALSNAP_SMART_HOVER_MODE = '1'
Start-Process -FilePath "$wd\tauri-spike\src-tauri\target\release\petalsnap-tauri-spike.exe" -WorkingDirectory $wd -WindowStyle Hidden
Start-Sleep -Seconds 6
$mark = (Get-Item $f2log).Length

[ScanPath]::SetCursorPos($pts[0], $pts[1]) | Out-Null
Start-Sleep -Milliseconds 400
Key 0x71
Start-Sleep -Seconds 6

for ($i = 0; $i -lt $pts.Count; $i += 2) {
  [ScanPath]::SetCursorPos($pts[$i], $pts[$i+1]) | Out-Null
  Start-Sleep -Milliseconds 1600
}
Key 0x1B
Start-Sleep -Milliseconds 1200

$fs = [System.IO.File]::Open($f2log,'Open','Read','ReadWrite')
$fs.Seek($mark,'Begin') | Out-Null
$sr = New-Object System.IO.StreamReader($fs)
$lines = ($sr.ReadToEnd() -split "`r?`n")
$sr.Close(); $fs.Close()

Write-Output '===== 靶点扫描：每个物理坐标对应的 UIA 目标尺寸 ====='
$last = ''
foreach ($l in $lines) {
  if ($l -match 'SMART-LAG.*tgt=(\d+)x(\d+)@(-?\d+),(-?\d+)') {
    $cur = "$($Matches[1])x$($Matches[2])@$($Matches[3]),$($Matches[4])"
    if ($cur -ne $last) {
      Write-Output ("  css={0,-24} -> 目标 {1}x{2}" -f $cur, $Matches[1], $Matches[2])
      $last = $cur
    }
  }
}
Write-Output '--- 原始 SMART-LAG 尾部 ---'
@($lines | Where-Object { $_ -match 'SMART-LAG' }) | Select-Object -Last 20 | ForEach-Object { Write-Output $_ }
