# 造一个「小元素 ↔ 大面板」的稳定测试靶窗口（悬停形变/跟手性验证用，2026-11-02 晚）
#
# 为什么需要：
#   「迟缓 / 抖动 / 闪亮」的量化必须在**确定**的靶子上做。之前一直借 Explorer 当靶子，
#   但用户桌面在动（Lightroom/ZCode 全屏窗盖住 Explorer）→ DLL 直接抓不到窗口
#   （实测 n=0 src="snap" win=""）→ 整轮测量作废。
#   自造靶窗：TopMost、不受桌面其它窗口影响、元素尺寸写死。
#
# 结构（客户端坐标）：
#   · SMALL：一个 200x26 的按钮（= 小元素，≈ 文件行）
#   · BIG  ：一个 1000x600 的面板（= 大块，≈ 空白面板）
#   → 光标从小按钮移进大面板 = 确定性的「小 → 大」尺寸跳变。
#
# 用法：
#   pwsh -File tools\_morph_target.ps1 -X -2200 -Y 120     （前台运行；用完 kill）
param(
  [int]$X = -2200,     # 窗口左上角**物理**坐标（副屏用负 X）
  [int]$Y = 120
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MTarget {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
}
"@
# Per-Monitor-V2：窗口坐标按物理像素，否则会被虚拟化（副屏上位置全错）
[MTarget]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null

$f = New-Object System.Windows.Forms.Form
$f.Text = 'MorphTargetProbe'
$f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$f.ClientSize = New-Object System.Drawing.Size(1060, 680)
$f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$f.Location = New-Object System.Drawing.Point($X, $Y)
$f.TopMost = $true
$f.BackColor = [System.Drawing.Color]::FromArgb(32, 34, 38)

$small = New-Object System.Windows.Forms.Button
$small.Text = 'SMALL'
# ⚠️ 尺寸必须够大：渲染端有面积地板 SMART_MIN_AUTO_AREA=0.003（≈14156 CSS px²），
#    自动落笔只取链上第一个 ≥ 地板的元素 —— 太小的控件会被地板跳过，
#    目标就变成整个窗（测不到「小 → 大」的跳变）。200x26 物理 = 160x21 CSS = 3360 → 被跳过。
$small.Size = New-Object System.Drawing.Size(400, 100)
$small.Location = New-Object System.Drawing.Point(20, 20)
$small.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$small.BackColor = [System.Drawing.Color]::FromArgb(70, 130, 200)
$f.Controls.Add($small)

$big = New-Object System.Windows.Forms.Panel
$big.Size = New-Object System.Drawing.Size(1000, 600)
$big.Location = New-Object System.Drawing.Point(20, 80)
$big.BackColor = [System.Drawing.Color]::FromArgb(50, 54, 60)
$f.Controls.Add($big)

$f.Show()
$small.Focus()
[System.Windows.Forms.Application]::Run($f)
