# 智能选框延迟 A/B（跨窗口/跨屏版）
#
# 场景：光标从 微信 窗口扫到别的窗口（跨屏）再扫回来。
# 动机：受控单窗口扫掠下 F2 比 F1 更快，但用户实测日志里出现
#   `dll=0/0ms total=245/397ms` 这类尖峰 —— dll=0 说明 worker 自身没干活，
#   慢在「等 worker 回应」，而触发条件是**换窗**（rowMissing → tryRefresh
#   → 同步整窗快照 60~900ms，快照期间 node 事件循环被占）。
#
# 用法：pwsh -NoProfile -File tools\_latency_cross.ps1 -Version f2
param(
  [ValidateSet('f1','f2')][string]$Version = 'f2',
  [int]$Steps = 70,        # 单程步数
  [int]$GapMs = 40,        # 每步间隔
  [int]$X1 = 900,          # 起点（微信内）
  [int]$X2 = 2700,         # 终点（副屏侧，触发换窗）
  [int]$Y = 460
)
$ErrorActionPreference = 'Stop'
$wd = 'F:\Work\Create\OCR\screenshot'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LatX {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetThreadDpiAwarenessContext(IntPtr ctx);
}
"@
[LatX]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
function Key([byte]$vk,[int]$hold=60){ [LatX]::keybd_event($vk,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds $hold; [LatX]::keybd_event($vk,0,2,[UIntPtr]::Zero) }

$f1log = "$wd\app\smart_err.log"
$f2log = Join-Path $env:TEMP 'petalsnap-spike.log'

if ($Version -eq 'f1') {
  # ⚠️ 2026-11-02 事故：Stop-Process -Force → 应用来不及回收 python 侧车
  #    → llama-server 变孤儿（~1.2GB 显存/个）→ 整机崩溃。改走 _stop_app.ps1。
  & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File "$wd\tools\_stop_app.ps1" | Out-Null
  Start-Sleep -Seconds 1
  $env:PETALSNAP_SMART_DEBUG = '1'
  Push-Location $wd; powershell -NoProfile -ExecutionPolicy Bypass -File "$wd\tools\_launch_petalsnap.ps1" | Out-Null; Pop-Location
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
if ($Version -eq 'f2') { $mark = (Get-Item $f2log).Length }

[LatX]::SetCursorPos($X1, $Y) | Out-Null
Start-Sleep -Milliseconds 400
Key 0x70
Start-Sleep -Seconds 4
# 去程：微信 → 副屏（换窗）
for ($i = 0; $i -lt $Steps; $i++) {
  [LatX]::SetCursorPos([int]($X1 + ($i * ($X2 - $X1) / $Steps)), $Y) | Out-Null
  Start-Sleep -Milliseconds $GapMs
}
# 回程：副屏 → 微信（再换回）
for ($i = 0; $i -lt $Steps; $i++) {
  [LatX]::SetCursorPos([int]($X2 - ($i * ($X2 - $X1) / $Steps)), $Y) | Out-Null
  Start-Sleep -Milliseconds $GapMs
}
Start-Sleep -Milliseconds 600
Key 0x1B
Start-Sleep -Milliseconds 1500

if ($Version -eq 'f1') {
  $lines = Get-Content -LiteralPath $f1log -Encoding UTF8 | ForEach-Object { $_ -replace '^\[capture-console:error\] ','' -replace ' \(file:.*$','' }
} else {
  $fs = [System.IO.File]::Open($f2log,'Open','Read','ReadWrite')
  $fs.Seek($mark,'Begin') | Out-Null
  $sr = New-Object System.IO.StreamReader($fs)
  $lines = ($sr.ReadToEnd() -split "`r?`n")
  $sr.Close(); $fs.Close()
}
Write-Output "===== $Version 跨窗扫掠 ====="
$diag = @($lines | Where-Object { $_ -match 'SMART-DIAG' })
$diag | ForEach-Object { Write-Output $_ }
$tot=@(); $dll=@()
foreach ($l in $diag) {
  if ($l -match 'total=(\d+)/(\d+)ms') { $tot += [int]$Matches[1]; $tot += [int]$Matches[2] }
  if ($l -match 'dll=(\d+)/(\d+)ms')  { $dll += [int]$Matches[1]; $dll += [int]$Matches[2] }
}
function Stats($a,$label){
  if($a.Count -eq 0){ Write-Output ("{0,-28} (无样本)" -f $label); return }
  $s=$a|Sort-Object; $n=$s.Count
  Write-Output ("{0,-28} n={1,-4} avg={2,-7} p50={3,-6} p95={4,-6} max={5}" -f $label,$n,[math]::Round(($s|Measure-Object -Average).Average,1),$s[[int]($n*0.5)],$s[[int]($n*0.95)],$s[-1])
}
Stats $tot "Rust 命令耗时 total(ms)"
Stats $dll "worker 内部 dll(ms)"
