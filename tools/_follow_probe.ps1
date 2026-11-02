# 悬停「跟手性 / 抖动」专项探针（2026-11-02 晚）
#
# 为什么要单独写：
#   用户报两个症状——①「位置变化时特别迟缓、不跟手」②「剧烈变化时加速移动 → 窗口剧烈抖动」。
#   这两个症状**可能同源**：目标有两个竞争来源（0ms 本地图命中 vs UIA 实时回包），
#   两者对「光标下是哪个元素」可能不一致 → 目标在两个矩形间来回跳 → 补间反复重启。
#   而当前实现是**二态分支**（jump=1 走中心滑移 / jump=0 走立即跟手），
#   分支一旦翻转，位置处理方式就整块换掉 → 观感上就是「一会儿跟手一会儿迟缓」。
#
# 本脚本量三件事：
#   ① 目标变化率（[SMART-KEY] 条数/秒）——越高越容易抖
#   ② 分支翻转率（[SMART-MORPH] 里 jump=1/0 的分布与翻转次数）——翻转 = 迟缓来源
#   ③ 位置滞后（[SMART-LAG] avg/max）——迟缓的硬指标
#
# 用法（必须 pwsh 7）：
#   & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -ExecutionPolicy Bypass `
#     -File tools\_follow_probe.ps1 -Version f2 -X -1500 -Y 370 -Steps 40 -StepPx 25 -GapMs 8
param(
  [ValidateSet('f1','f2')][string]$Version = 'f2',
  [int]$X = -1500,
  [int]$Y = 370,
  [int]$Steps = 40,
  [int]$StepPx = 25,       # 每步横向像素（配合 GapMs 决定移动速度）
  [int]$StepPy = 0,
  [int]$GapMs = 8,         # 每步间隔：8ms ≈ 快速扫掠（用户说的「移动速度加快」）
  [switch]$NoLaunch,
  [switch]$OldHover,
  [int]$Mode = 1             # 悬停动画口径：1=新（三通道分离） 2=二态分支(旧线上) 0=最初线性补间
)
$ErrorActionPreference = 'Stop'
$wd = 'F:\Work\Create\OCR\screenshot'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FollowPath {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetThreadDpiAwarenessContext(IntPtr ctx);
}
"@
[FollowPath]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
function Key([byte]$vk,[int]$hold=60){ [FollowPath]::keybd_event($vk,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds $hold; [FollowPath]::keybd_event($vk,0,2,[UIntPtr]::Zero) }

$f1log = "$wd\app\smart_err.log"
$f2log = Join-Path $env:TEMP 'petalsnap-spike.log'

if (-not $NoLaunch) {
  $env:PETALSNAP_SMART_HOVER_MODE = [string]$Mode
  if ($Version -eq 'f1') {
    Get-Process -Name 'petalsnap-tauri-spike' -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
    $env:PETALSNAP_SMART_DEBUG = '1'
    Push-Location $wd
    powershell -NoProfile -ExecutionPolicy Bypass -File "$wd\tools\_launch_petalsnap.ps1" | Out-Null
    Pop-Location
    Start-Sleep -Seconds 10
  } else {
    Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process -Name 'petalsnap-tauri-spike' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
    $env:PETALSNAP_SMART_DEBUG = '1'
    $env:PETALSNAP_FRAME_PREPARE = '1'
    Start-Process -FilePath "$wd\tauri-spike\src-tauri\target\release\petalsnap-tauri-spike.exe" -WorkingDirectory $wd -WindowStyle Hidden
    Start-Sleep -Seconds 6
  }
}

$mark = 0
if ($Version -eq 'f2') { $mark = (Get-Item $f2log).Length }

[FollowPath]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 400
if ($Version -eq 'f1') { Key 0x70 } else { Key 0x71 }
Start-Sleep -Seconds 5
$t0 = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
for ($i = 0; $i -lt $Steps; $i++) {
  [FollowPath]::SetCursorPos($X + ($i * $StepPx), $Y + ($i * $StepPy)) | Out-Null
  Start-Sleep -Milliseconds $GapMs
}
$t1 = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
Start-Sleep -Milliseconds 800
Key 0x1B
Start-Sleep -Milliseconds 1200

if ($Version -eq 'f1') {
  $lines = Get-Content -LiteralPath $f1log -Encoding UTF8 | ForEach-Object { $_ -replace '^\[capture-console:error\] ', '' -replace ' \(file:.*$', '' }
} else {
  $fs = [System.IO.File]::Open($f2log,'Open','Read','ReadWrite')
  $fs.Seek($mark,'Begin') | Out-Null
  $sr = New-Object System.IO.StreamReader($fs)
  $lines = ($sr.ReadToEnd() -split "`r?`n")
  $sr.Close(); $fs.Close()
}

$keys = @($lines | Where-Object { $_ -match '\[SMART-KEY\]' })
$morph = @($lines | Where-Object { $_ -match '\[SMART-MORPH\]' })
$lags = @($lines | Where-Object { $_ -match '\[SMART-LAG\]' })
$sweepSec = [math]::Max(0.5, ($t1 - $t0) / 1000.0)

Write-Output "===== $Version 跟手性/抖动探针  扫掠=$Steps 步 x ${StepPx}px 间隔=${GapMs}ms（≈$([math]::Round($sweepSec,1))s）====="

# ① 目标变化率
Write-Output "--- ① 目标变化率（[SMART-KEY]）---"
Write-Output ("  目标变化 {0} 次 / 扫掠 {1}s  →  {2} 次/秒" -f $keys.Count, [math]::Round($sweepSec,1), [math]::Round($keys.Count / $sweepSec,1))
# 目标在多少个不同矩形之间跳（两个来源打架的直接证据）
$tos = @{}
foreach ($k in $keys) { if ($k -match 'to=(-?\d+),(-?\d+) (\d+)x(\d+)') { $k2 = "$($Matches[3])x$($Matches[4])@$($Matches[1]),$($Matches[2])"; $tos[$k2] = 1 + [int]($tos[$k2]) } }
Write-Output ("  出现过的目标矩形 {0} 种（前 8）:" -f $tos.Count)
$tos.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 8 | ForEach-Object { Write-Output ("    {0}  x{1}" -f $_.Key, $_.Value) }

# ② 分支翻转率
Write-Output "--- ② 分支分布与翻转（[SMART-MORPH] jump=）---"
$jumps = @()
foreach ($m in $morph) { if ($m -match 'jump=(\d)') { $jumps += [int]$Matches[1] } }
if ($jumps.Count) {
  $flip = 0
  for ($i = 1; $i -lt $jumps.Count; $i++) { if ($jumps[$i] -ne $jumps[$i-1]) { $flip++ } }
  $n1 = @($jumps | Where-Object { $_ -eq 1 }).Count
  Write-Output ("  采样 {0} 次：jump=1（走中心滑移·会迟缓）{1} 次，jump=0（立即跟手）{2} 次" -f $jumps.Count, $n1, ($jumps.Count - $n1))
  Write-Output ("  **分支翻转 {0} 次 / {1} 次采样 = {2}%**（翻转 = 迟缓与抖动的直接来源）" -f $flip, $jumps.Count, [math]::Round(100.0 * $flip / [math]::Max(1,$jumps.Count)))
}

# ③ 位置滞后（[SMART-LAG]）—— 「迟缓」的硬指标
Write-Output "--- ③ 位置滞后（[SMART-LAG]）---"
$lagAvgs = @(); $lagMaxs = @(); $lagSum = 0.0; $lagN = 0
foreach ($l in $lags) {
  if ($l -match 'avg=([\d.]+)px\s+max=([\d.]+)px\s+n=(\d+)') {
    $lagAvgs += [double]$Matches[1]; $lagMaxs += [double]$Matches[2]
    $lagSum += [double]$Matches[1] * [int]$Matches[3]; $lagN += [int]$Matches[3]
  }
}
if ($lagAvgs.Count) {
  $worst = ($lagAvgs | Measure-Object -Maximum).Maximum
  $over = @($lagAvgs | Where-Object { $_ -gt 1 }).Count
  Write-Output ("  分段数={0}  加权平均滞后={1}px  最差分段均值={2}px  全局最大={3}px" -f `
    $lagAvgs.Count, [math]::Round($lagSum / [math]::Max(1,$lagN),1), $worst, (($lagMaxs | Measure-Object -Maximum).Maximum))
  Write-Output ("  **滞后>1px 的分段：{0}/{1} = {2}%**（旧口径这里是 6~18% —— 二态分支翻转的代价）" -f $over, $lagAvgs.Count, [math]::Round(100.0*$over/[math]::Max(1,$lagAvgs.Count)))
} else { Write-Output '  （无样本）' }

# ④ 新口径的面积速率（[SMART-FLUX]）—— 「亮度匀速」的硬指标
$flux = @($lines | Where-Object { $_ -match '\[SMART-FLUX\]' })
if ($flux.Count) {
  $rates = @(); $convs = @()
  foreach ($f in $flux) {
    if ($f -match 'mrate=(\d+)\s+cap=(\d+)') { $rates += [int]$Matches[1] }
    if ($f -match 'conv=([\d.]+)') { $convs += [double]$Matches[1] }
  }
  if ($rates.Count) {
    Write-Output ("  面积实测速率 max={0} px²/ms（上限 4665）  收敛度 avg={1} min={2}" -f `
      ($rates | Measure-Object -Maximum).Maximum, [math]::Round((($convs | Measure-Object -Average).Average),2), (($convs | Measure-Object -Minimum).Minimum))
  }
} else { Write-Output '  （无 [SMART-FLUX] 样本 = 当前不是新口径，或诊断未开）' }

$lags | Select-Object -Last 6 | ForEach-Object { Write-Output "  $_" }
