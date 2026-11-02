# 悬停「形变曲线」专项探针（2026-11-02）
#
# 两种口径的探针不同：
#   · 旧口径（HOVER_MODE=0/2）→ [SMART-MORPH] e/area%/from/to/jump/dur
#   · 新口径（HOVER_MODE=1）   → [SMART-FLUX] area%/box/conv/tgt/mrate/dt/ticks
#     （新口径没有「补间进度」，尺寸由**限速器**驱动：面积恒速趋近，
#       位置无条件立即跟手 → 所以要看的是「面积曲线是否匀速」+「位置滞后是否恒 0」）
#
# 做法（两段式）：
#   ① 先把光标停在**小元素**上 → 等树稳定，框收敛到小尺寸
#   ② 再把光标**一次性**移到**大块**区 → 目标变成大框 → 形变完整跑完 → 曲线可采全
#
# ⚠️ 尾部必须留足 4s：worker/UIA 回包有 ~0.5s 滞后，停留太短会「目标还没切过去就结束」
#    → 只采到 e=0 一个点，看起来像"没补间"。
#
# 用法（必须 pwsh 7）：
#   & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -ExecutionPolicy Bypass `
#     -File tools\_morph_curve.ps1 -Version f2 -Mode 1 -X -2071 -Y 192 -BigX -1671 -BigY 539
param(
  [ValidateSet('f1','f2')][string]$Version = 'f2',
  [int]$Mode = 1,            # 悬停动画口径：1=新（三通道分离） 2=二态分支(旧线上) 0=最初线性补间
  [int]$X = -2071,           # 小元素（物理坐标）
  [int]$Y = 192,
  [int]$BigX = -1671,        # 大块（物理坐标）
  [int]$BigY = 539,
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$wd = 'F:\Work\Create\OCR\screenshot'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MorphPath {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetThreadDpiAwarenessContext(IntPtr ctx);
}
"@
[MorphPath]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
function Key([byte]$vk,[int]$hold=60){ [MorphPath]::keybd_event($vk,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds $hold; [MorphPath]::keybd_event($vk,0,2,[UIntPtr]::Zero) }

$f1log = "$wd\app\smart_err.log"
$f2log = Join-Path $env:TEMP 'petalsnap-spike.log'

if (-not $NoLaunch) {
  $env:PETALSNAP_SMART_HOVER_MODE = [string]$Mode
  if ($Version -eq 'f1') {
    # ⚠️ 2026-11-02 事故：原来这里是 Stop-Process -Force → 应用来不及回收 python 侧车
    #    → 侧车拉起的 llama-server 变孤儿（~1.2GB 显存/个）→ 探针跑几十次就打满 8GB 显存
    #    → CUDA 降级 → 内存雪崩 → 整机崩溃。改走 _stop_app.ps1（优雅停 + 树杀 + 孤儿清扫）。
    & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File "$wd\tools\_stop_app.ps1" | Out-Null
    Start-Sleep -Seconds 1
    $env:PETALSNAP_SMART_DEBUG = '1'
    Push-Location $wd
    powershell -NoProfile -ExecutionPolicy Bypass -File "$wd\tools\_launch_petalsnap.ps1" | Out-Null
    Pop-Location
    Start-Sleep -Seconds 10
  } else {
    # ⚠️ 必须先杀旧 F2：单实例锁 + env 只在窗口创建时求值 → 复用旧实例 = 开关没生效
    & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File "$wd\tools\_stop_app.ps1" | Out-Null
    Start-Sleep -Seconds 1
    $env:PETALSNAP_SMART_DEBUG = '1'
    $env:PETALSNAP_FRAME_PREPARE = '1'
    Start-Process -FilePath "$wd\tauri-spike\src-tauri\target\release\petalsnap-tauri-spike.exe" -WorkingDirectory $wd -WindowStyle Hidden
    Start-Sleep -Seconds 6
  }
}

$mark = 0
if ($Version -eq 'f2') { $mark = (Get-Item $f2log).Length }

# ① 停在小元素上，先让树稳定、框收敛
[MorphPath]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 400
if ($Version -eq 'f1') { Key 0x70 } else { Key 0x71 }
Start-Sleep -Seconds 6

# ② 一次性跳到大块区，尾部留足时间让形变完整跑完
[MorphPath]::SetCursorPos($BigX, $BigY) | Out-Null
Start-Sleep -Seconds 4
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

Write-Output "===== $Version 口径 $Mode  形变曲线  小=($X,$Y) → 大=($BigX,$BigY) ====="

$flux = @($lines | Where-Object { $_ -match '\[SMART-FLUX\]' })
$morph = @($lines | Where-Object { $_ -match '\[SMART-MORPH\]' })

if ($flux.Count) {
  Write-Output '--- 新口径 [SMART-FLUX]（面积匀速 + 位置跟手）---'
  $flux | ForEach-Object { Write-Output ($_ -replace '^\[\d+\] \[js\] ','') }
  $rows = @()
  foreach ($f in $flux) {
    if ($f -match 'area=([\d.]+)%\s+box=(\d+)x(\d+)\s+conv=([\d.]+)\s+tgt=(\d+)x(\d+)\s+@\s*(-?\d+),(-?\d+)\s+mrate=(\d+)\s+cap=(\d+)\s+dt=(\d+)\s+ticks=(\d+)') {
      $rows += [pscustomobject]@{
        area=[double]$Matches[1]; box="$($Matches[2])x$($Matches[3])"; conv=[double]$Matches[4]
        tgt="$($Matches[5])x$($Matches[6])"; mrate=[int]$Matches[9]; cap=[int]$Matches[10]
        dt=[int]$Matches[11]; ticks=[int]$Matches[12]
      }
    }
  }
  if ($rows.Count) {
    $mr = $rows | ForEach-Object { $_.mrate } | Where-Object { $_ -gt 0 }
    Write-Output ("  面积实测速率：max={0} px²/ms（上限 {1}）  tick 总数={2}  末次 dt={3}ms" -f `
      (($mr | Measure-Object -Maximum).Maximum), $rows[0].cap, $rows[-1].ticks, $rows[-1].dt)
    Write-Output ("  收敛度 conv：min={0} max={1}" -f (($rows | ForEach-Object { $_.conv } | Measure-Object -Minimum).Minimum), (($rows | ForEach-Object { $_.conv } | Measure-Object -Maximum).Maximum))
    Write-Output '  轨迹：'
    $rows | ForEach-Object { Write-Output ("    area={0,6}%  box={1,-12} conv={2}  tgt={3}  mrate={4}" -f $_.area, $_.box, $_.conv, $_.tgt, $_.mrate) }
  }
}

if ($morph.Count) {
  Write-Output '--- 旧口径 [SMART-MORPH] ---'
  $morph | ForEach-Object { Write-Output ($_ -replace '^\[\d+\] \[js\] ','') }
}

Write-Output '--- [SMART-LAG]（位置滞后：新口径应恒为 0）---'
@($lines | Where-Object { $_ -match '\[SMART-LAG\]' }) | ForEach-Object { Write-Output ($_ -replace '^\[\d+\] \[js\] ','') }
