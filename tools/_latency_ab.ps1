# 智能选框延迟 A/B：连续移动鼠标场景（贴近真实跟手感）
#
# 为什么不能只测「钉死光标 + 慢步进」：那样测出来 F2 反而更快（total 1~26ms），
# 但用户实测的延迟尖峰（total=245/397ms、352/439ms）只出现在**连续移动**时。
# 连续移动会持续触发 worker 的重拍（rowMissing → tryRefresh → 同步整窗快照 60~900ms），
# 快照期间 node 事件循环被占 → 排队的查询一起等 → 尖峰。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\_latency_ab.ps1 -Version f2
param(
  [ValidateSet('f1','f2')][string]$Version = 'f2',
  [int]$Steps = 150,          # 移动步数
  [int]$StepPx = 3,           # 每步像素
  [int]$GapMs = 12,           # 每步间隔（≈60 次/秒，接近真实移动）
  [int]$X = 860,              # 起点物理坐标（落在微信窗口内）
  [int]$Y = 460
)
$ErrorActionPreference = 'Stop'
$wd = 'F:\Work\Create\OCR\screenshot'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LatAB {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetThreadDpiAwarenessContext(IntPtr ctx);
}
"@
[LatAB]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
function Key([byte]$vk,[int]$hold=60){ [LatAB]::keybd_event($vk,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds $hold; [LatAB]::keybd_event($vk,0,2,[UIntPtr]::Zero) }

$f1log = "$wd\app\smart_err.log"
$f2log = Join-Path $env:TEMP 'petalsnap-spike.log'

# 关掉另一版（并行会互相挡 UIA，且热键冲突）
if ($Version -eq 'f1') {
  # ⚠️ 2026-11-02 事故：Stop-Process -Force → 应用来不及回收 python 侧车
  #    → llama-server 变孤儿（~1.2GB 显存/个）→ 整机崩溃。改走 _stop_app.ps1。
  & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File "$wd\tools\_stop_app.ps1" | Out-Null
  Start-Sleep -Seconds 1
  $env:PETALSNAP_SMART_DEBUG = '1'
  Push-Location $wd
  powershell -NoProfile -ExecutionPolicy Bypass -File "$wd\tools\_launch_petalsnap.ps1" | Out-Null
  Pop-Location
  Start-Sleep -Seconds 10
} else {
  & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File "$wd\tools\_stop_app.ps1" | Out-Null
  Start-Sleep -Seconds 1
  $env:PETALSNAP_SMART_DEBUG = '1'
  $env:PETALSNAP_FRAME_PREPARE = '1'
  Start-Process -FilePath "$wd\tauri-spike\src-tauri\target\release\petalsnap-tauri-spike.exe" -WorkingDirectory $wd -WindowStyle Hidden
  Start-Sleep -Seconds 6
}

$mark = 0
if ($Version -eq 'f1') { $mark = 0 } else { $mark = (Get-Item $f2log).Length }

[LatAB]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 400
Key 0x70
Start-Sleep -Seconds 4          # 让冷树建图（两版都需要）
# 连续移动
$cx = $X
for ($i = 0; $i -lt $Steps; $i++) {
  $cx = $X + ($i * $StepPx)
  [LatAB]::SetCursorPos($cx, $Y) | Out-Null
  Start-Sleep -Milliseconds $GapMs
}
Start-Sleep -Milliseconds 600
Key 0x1B
Start-Sleep -Milliseconds 1500

if ($Version -eq 'f1') {
  $lines = Get-Content -LiteralPath $f1log -Encoding UTF8 | ForEach-Object { $_ -replace '^\[capture-console:error\] ', '' -replace ' \(file:.*$', '' }
} else {
  $fs = [System.IO.File]::Open($f2log,'Open','Read','ReadWrite')
  $fs.Seek($mark,'Begin') | Out-Null
  $sr = New-Object System.IO.StreamReader($fs)
  $lines = ($sr.ReadToEnd() -split "`r?`n")
  $sr.Close(); $fs.Close()
}

Write-Output "===== $Version 连续移动场景 ====="
$diag = @($lines | Where-Object { $_ -match 'SMART-DIAG' })
$diag | ForEach-Object { Write-Output $_ }

# 汇总 SMART-DIAG 的 total（Rust 命令耗时）分布
$tot = @(); $dll = @()
foreach ($l in $diag) {
  if ($l -match 'total=(\d+)/(\d+)ms') { $tot += [int]$Matches[1]; $tot += [int]$Matches[2] }
  if ($l -match 'dll=(\d+)/(\d+)ms')  { $dll += [int]$Matches[1]; $dll += [int]$Matches[2] }
}
function Stats($a,$label){
  if($a.Count -eq 0){ Write-Output "$label : (无样本)"; return }
  $s = $a | Sort-Object; $n=$s.Count
  $p50=$s[[int]($n*0.5)]; $p95=$s[[int]($n*0.95)]
  $avg=[math]::Round(($s|Measure-Object -Average).Average,1)
  Write-Output ("{0,-30} n={1,-4} avg={2,-7} p50={3,-6} p95={4,-6} max={5}" -f $label,$n,$avg,$p50,$p95,$s[-1])
}
Stats $tot "Rust 命令耗时 total(ms)"
Stats $dll "worker 内部 dll(ms)"
$ov = @(); foreach($l in $diag){ if($l -match 'total=(\d+)/(\d+)ms' -and $l -match 'dll=(\d+)/(\d+)ms'){ } }
Write-Output '--- 渲染端 mousemove 洪水（仅 F2 有该探针）---'
($lines | Where-Object { $_ -match '1s mouse=' } | Select-Object -Last 8) | ForEach-Object { Write-Output $_ }
