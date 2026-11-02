# 0ms 本地查表旁路的有效性探针（2026-11-01 延迟专项 P0-a / P0-b）
#
# 为什么需要它：
#   **用户感知的延迟 = 渲染端那条 0ms 本地查表旁路是否生效**。
#   而 SMART-DIAG 只在「**有 worker 回包**」时才打印 —— 恰好在 worker 被同步 DLL 调用
#   堵住的窗口期（实测 dll=0ms 而 total=482ms）它一声不吭，看不出旁路有没有顶上来。
#   本脚本直接读两处证据：
#     ① 渲染端 `[SMART-LOCAL] hit=N miss=M map=K`（旁路命中/落空 + 本地图元素数）
#     ② worker 侧 `[f1_kernel] publish thin map items=N`（瘦图外发 = P0-a 是否生效）
#
# 判读：
#   map=0 且 hit=0        → 旁路结构性失效（本地根本没图）
#   map=0 且 miss 持续涨   → 图没发布/没拉到
#   map≥1 且 hit>0        → 旁路在起作用（用户看到的框是 0ms 画的）
#
# 用法（必须 pwsh 7，5.1 按 ANSI 读 UTF-8 无 BOM 会让中文注释吞行）：
#   & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -ExecutionPolicy Bypass `
#     -File tools\_local_path.ps1 -Version f2 -X 700 -Y 400
param(
  [ValidateSet('f1','f2')][string]$Version = 'f2',
  [int]$X = 700,              # 起点物理坐标（落在目标窗内）
  [int]$Y = 400,
  [int]$Steps = 60,           # 移动步数
  [int]$StepPx = 4,           # 每步横向像素
  [int]$StepPy = 0,           # 每步纵向像素（>0 = 纵向扫掠，如沿列表上下移动）
  [int]$GapMs = 15,           # 每步间隔（≈60 次/秒）
  [switch]$NoLaunch,         # 不重启目标版本（用已在跑的实例）→ 用于「旧构建」基线对照
  [switch]$NoThinMap,        # 负向对照：PETALSNAP_SMART_THIN_MAP=0 → 退回旧口径（items<3 不下发）
  [switch]$OldHover          # 负向对照：PETALSNAP_SMART_HOVER_MODE=0 → 退回旧的「整体补间」手感
)
$ErrorActionPreference = 'Stop'
$wd = 'F:\Work\Create\OCR\screenshot'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LocalPath {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetThreadDpiAwarenessContext(IntPtr ctx);
}
"@
[LocalPath]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
function Key([byte]$vk,[int]$hold=60){ [LocalPath]::keybd_event($vk,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds $hold; [LocalPath]::keybd_event($vk,0,2,[UIntPtr]::Zero) }

$f1log = "$wd\app\smart_err.log"
$f2log = Join-Path $env:TEMP 'petalsnap-spike.log'

# 关掉另一版（并行会互相挡 UIA，且热键冲突）
if (-not $NoLaunch) {
  # 负向开关：默认走新口径（瘦图在「已判定无细元素」后下发）；-NoThinMap 退回旧口径
  if ($NoThinMap) { $env:PETALSNAP_SMART_THIN_MAP = '0' } else { $env:PETALSNAP_SMART_THIN_MAP = '1' }
  # 手感负向开关：默认自适应（位置立即跟手）；-OldHover 退回旧的「位置+尺寸一起补间」
  if ($OldHover) { $env:PETALSNAP_SMART_HOVER_MODE = '0' } else { $env:PETALSNAP_SMART_HOVER_MODE = '1' }
  if ($Version -eq 'f1') {
    Get-Process -Name 'petalsnap-tauri-spike' -ErrorAction SilentlyContinue | Stop-Process -Force
    # 旧实例会占着全局热键（且它可能带着已崩的 capture renderer）→ 一起清掉
    Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
    $env:PETALSNAP_SMART_DEBUG = '1'
    Push-Location $wd
    powershell -NoProfile -ExecutionPolicy Bypass -File "$wd\tools\_launch_petalsnap.ps1" | Out-Null
    Pop-Location
    Start-Sleep -Seconds 10
  } else {
    Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Stop-Process -Force
    # ⚠️ 必须先杀掉旧的 F2：单实例锁会把新实例挡在门外 → 负向开关（环境变量）在
    #    URL 里、只在**窗口创建时**求值 → 复用旧实例 = 开关根本没生效，A/B 会得出假结论。
    Get-Process -Name 'petalsnap-tauri-spike' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
    $env:PETALSNAP_SMART_DEBUG = '1'
    $env:PETALSNAP_FRAME_PREPARE = '1'
    Start-Process -FilePath "$wd\tauri-spike\src-tauri\target\release\petalsnap-tauri-spike.exe" -WorkingDirectory $wd -WindowStyle Hidden
    Start-Sleep -Seconds 6
  }
}

$mark = 0
if ($Version -eq 'f1') { $mark = 0 } else { $mark = (Get-Item $f2log).Length }

[LocalPath]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 400
if ($Version -eq 'f1') { Key 0x70 } else { Key 0x71 }
Start-Sleep -Seconds 5          # 让冷树建图 + 判定「该应用确实无细元素」
# 连续移动（触发 rowMissing → 瘦图判定 → 旁路拉图）
$cx = $X
$cy = $Y
for ($i = 0; $i -lt $Steps; $i++) {
  $cx = $X + ($i * $StepPx)
  $cy = $Y + ($i * $StepPy)
  [LocalPath]::SetCursorPos($cx, $cy) | Out-Null
  Start-Sleep -Milliseconds $GapMs
}
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

Write-Output "===== $Version 0ms 旁路探针  起点=($X,$Y) 步数=$Steps ====="
Write-Output '--- 渲染端 [SMART-LOCAL]（旁路命中/落空）---'
$local = @($lines | Where-Object { $_ -match 'SMART-LOCAL' })
$local | ForEach-Object { Write-Output $_ }
Write-Output '--- worker [f1_kernel] publish thin map（P0-a 是否生效）---'
@($lines | Where-Object { $_ -match 'publish thin map' }) | ForEach-Object { Write-Output $_ }
Write-Output '--- 汇总 ---'
$hit = 0; $miss = 0
foreach ($l in $local) {
  if ($l -match 'hit=(\d+)\s+miss=(\d+)') { $hit += [int]$Matches[1]; $miss += [int]$Matches[2] }
}
$thin = @($lines | Where-Object { $_ -match 'publish thin map' }).Count
Write-Output ("SMART-LOCAL 累计 hit={0} miss={1}   瘦图外发条数={2}" -f $hit, $miss, $thin)
Write-Output '--- 渲染端 [SMART-LAG]（框落后目标的像素；果冻感的硬指标）---'
$lag = @($lines | Where-Object { $_ -match 'SMART-LAG' })
$lag | Select-Object -Last 12 | ForEach-Object { Write-Output $_ }
if ($lag.Count -gt 0) {
  $vals = @()
  foreach ($l in $lag) { if ($l -match 'pos=(\d+)/(\d+)px') { $vals += [int]$Matches[1] } }
  if ($vals.Count -gt 0) {
    $mx = ($vals | Measure-Object -Maximum).Maximum
    $av = [math]::Round(($vals | Measure-Object -Average).Average, 1)
    Write-Output ("SMART-LAG 位置滞后 avg={0}px max={1}px （旧手感下这值=几十~几百 px = 果冻感）" -f $av, $mx)
  }
}
Write-Output '--- 最近若干 [SMART-DIAG]（对照：IPC 往返 total）---'
@($lines | Where-Object { $_ -match 'SMART-DIAG' }) | Select-Object -Last 6 | ForEach-Object { Write-Output $_ }
Write-Output '--- 日志尾部（诊断：会话是否真的开起来）---'
$lines | Select-Object -Last 18 | ForEach-Object { Write-Output $_ }
