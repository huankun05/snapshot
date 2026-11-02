# 悬停「闪亮」形变曲线专项探针（2026-11-02）
#
# 为什么单独写：
#   `_local_path.ps1` 的扫掠是「连续移动」，目标每次都变 → 补间被打断，
#   采到的 [SMART-MORPH] 样本点落在**不同**的 from->to 段里，
#   **凑不出一次完整形变的曲线**（实测「变大」方向只采到 1 个点）。
#   而「闪亮」的观感恰恰取决于**一次完整形变**的面积曲线形状。
#
# 本脚本的做法（两段式）：
#   ① 先把光标停在**小元素**上（文件行）→ 等树稳定，框收敛到小尺寸
#   ② 再把光标**一次性**移到**无 UIA 元素**处（Explorer 下方的桌面）
#      → 目标变成整屏大框 → 补间完整跑完 260ms → 面积曲线可采全
#
# 判读：
#   新口径：area% 随 e **线性**（亮度匀速铺开）→ maxDev 应 < 1pp
#   旧口径：面积随尺寸线性插值 → **二次增长** → maxDev 明显 > 1pp
param(
  [ValidateSet('f1','f2')][string]$Version = 'f2',
  [int]$X = -1500,        # 小元素起点（物理坐标，落在 Explorer 文件行上）
  [int]$Y = 370,
  [int]$BigX = -1500,     # 大框终点（桌面区，无 UIA 元素 → 回落整屏大框）
  [int]$BigY = 1330,
  [switch]$NoLaunch,
  [switch]$OldHover       # 负向对照：退回旧的「线性尺寸插值」
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
  if ($OldHover) { $env:PETALSNAP_SMART_HOVER_MODE = '0' } else { $env:PETALSNAP_SMART_HOVER_MODE = '1' }
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
    # ⚠️ 必须先杀旧 F2：单实例锁 + env 只在窗口创建时求值 → 复用旧实例 = 开关没生效
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

# ① 停在小元素上，先让树稳定、框收敛
[MorphPath]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 400
if ($Version -eq 'f1') { Key 0x70 } else { Key 0x71 }
Start-Sleep -Seconds 6

# ② 一次性跳到大框区，尾部留足时间让 260ms 补间跑完
#    ⚠️ 必须留 4s：worker 查询回包有 ~0.5s 滞后（loop-lag 528ms / blocked snapshot 242ms），
#    停留太短会「目标还没切过去就 ESC」→ 只采到 e=0 一个点，曲线采不全。
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

Write-Output "===== $Version 形变曲线  ($Version, $(if($OldHover){'旧口径(线性尺寸)'}else{'新口径(面积匀速)'})) ====="
$morph = @($lines | Where-Object { $_ -match 'SMART-MORPH' })
$morph | ForEach-Object { Write-Output $_ }
Write-Output '--- [SMART-LAG]（目标位置随光标移动的轨迹，确认光标真的到了大框区）---'
@($lines | Where-Object { $_ -match 'SMART-LAG' }) | ForEach-Object { Write-Output $_ }

Write-Output '--- 按 from->to 分组：面积曲线线性度（maxDev 越小越匀速）---'
$groups = [ordered]@{}
foreach ($l in $morph) {
  if ($l -match 'e=([\d.]+)\s+area=([\d.]+)%\s+box=(\d+)x(\d+)\s+from=(\d+)x(\d+)\s+to=(\d+)x(\d+)\s+jump=(\d)\s+dur=(\d+)') {
    $k = "$($Matches[5])x$($Matches[6])->$($Matches[7])x$($Matches[8]) jump=$($Matches[9]) dur=$($Matches[10])"
    if (-not $groups.Contains($k)) { $groups[$k] = @() }
    $groups[$k] += [pscustomobject]@{ e=[double]$Matches[1]; area=[double]$Matches[2]; box="$($Matches[3])x$($Matches[4])" }
  }
}
foreach ($k in $groups.Keys) {
  $rows = $groups[$k] | Sort-Object e
  $n = $rows.Count
  $maxDev = 0.0
  if ($n -ge 3) {
    $sx=0.0; $sy=0.0; $sxx=0.0; $sxy=0.0
    foreach ($r in $rows) { $sx+=$r.e; $sy+=$r.area; $sxx+=$r.e*$r.e; $sxy+=$r.e*$r.area }
    $den = $n*$sxx - $sx*$sx
    if ([math]::Abs($den) -gt 1e-9) {
      $kS = ($n*$sxy - $sx*$sy)/$den; $kI = ($sy - $kS*$sx)/$n
      foreach ($r in $rows) { $d = [math]::Abs($r.area - ($kS*$r.e + $kI)); if ($d -gt $maxDev) { $maxDev = $d } }
    }
  }
  $seq = ($rows | ForEach-Object { "{0}:{1}%({2})" -f $_.e, $_.area, $_.box }) -join '  '
  Write-Output ("  {0}`n     n={1} maxDev={2:N1}pp  |  {3}" -f $k, $n, $maxDev, $seq)
}
