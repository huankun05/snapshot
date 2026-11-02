# 造一个「没有细元素」的测试靶窗口（延迟专项 P0-a 验证用，2026-11-01）
#
# 为什么需要：P0-a 修的是「整窗级窗口（MAP items=1）永远不会被外发」→
#   渲染端 0ms 本地查表旁路结构性失效 → 用户吃到 worker 排队延迟。
#   要验证它，必须有一个**确定**是 items<3 的窗口在前台。
#   本机现成的候选（设置 / Realtek / Windows 输入体验）要么被 Edge 全屏挡住、
#   要么 z 序抢不到、要么会被关掉 → 干脆自己造一个。
#
# 做法：WinForms 窗口但**不放任何控件** → UIA 树里只有 Window/Client 级别，
#   DLL 的 MAP 过滤后 items 极小（预期 1）→ 正好是「整窗级」那一档。
#
# 用法：pwsh -File tools\_thin_win.ps1 [-X -1500] [-Y 150]   （前台运行；用完 Ctrl+C 或 kill）
param(
  [int]$X = 160,      # 窗口左上角物理坐标（副屏用负 X）
  [int]$Y = 120
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.Text = 'ThinMapProbe'
$f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$f.ClientSize = New-Object System.Drawing.Size(900, 620)
$f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$f.Location = New-Object System.Drawing.Point($X, $Y)
$f.TopMost = $true
$f.Show()
[System.Windows.Forms.Application]::Run($f)
