<#
    停止 petalsnap 应用（优雅优先）+ 连带清理侧车 / llama-server 孤儿

    为什么需要它（2026-11-02 整机崩溃事故）：
      过去所有探针脚本都直接 `Stop-Process -Force` 杀应用。
      Windows 上强杀 = TerminateProcess → 应用**来不及跑自己的退出清理**
      → 宿主拉起的 python 侧车活了下来 → 侧车拉起的 llama-server 也活了下来
      → 每跑一次探针就多留一个 llama-server（~1.2GB 显存）
      → 跑了几十次后 8GB 显存的机器被占满 → CUDA 降级 → 内存雪崩 → 整机崩溃。

    本脚本做三件事：
      ① 尽量优雅地让应用自己退出（CloseMainWindow → 等 2s）
      ② 不行就 taskkill /T /F 连进程树一起杀（不留渲染子进程）
      ③ **无论①②结果如何，最后都跑一次孤儿清扫**（_sweep_orphans.ps1）
         —— 兜住「上一次崩溃留下的残骸」

    用法：
      powershell -NoProfile -ExecutionPolicy Bypass -File tools\_stop_app.ps1
      powershell -NoProfile -ExecutionPolicy Bypass -File tools\_stop_app.ps1 -Version f2
#>
param(
    [ValidateSet('all', 'f1', 'f2')][string]$Version = 'all',
    [switch]$NoSweep
)

$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sweep = Join-Path $here '_sweep_orphans.ps1'

$targets = @()
if ($Version -eq 'all' -or $Version -eq 'f1') { $targets += 'electron' }
if ($Version -eq 'all' -or $Version -eq 'f2') { $targets += 'petalsnap-tauri-spike' }

# ── ① 优雅退出：先关主窗口，给应用跑 onQuit / before-quit 的机会 ──────
foreach ($name in $targets) {
    foreach ($p in @(Get-Process -Name $name)) {
        try { [void]$p.CloseMainWindow() } catch { }
    }
}
if ($targets.Count -gt 0) {
    $stillAlive = @($targets | ForEach-Object { Get-Process -Name $_ })
    if ($stillAlive.Count -gt 0) { Start-Sleep -Seconds 2 }
}

# ── ② 还不走的就树杀（/T 连子进程，/F 强制）─────────────────────────
foreach ($name in $targets) {
    foreach ($p in @(Get-Process -Name $name)) {
        # ⚠️ 不要用 `2>&1 | Out-Null`（Windows PowerShell 5.1 下 taskkill 会不生效）
        $null = & taskkill /PID $p.Id /T /F 2>&1
    }
}
Start-Sleep -Milliseconds 500

# ── ③ 孤儿清扫（兜底：上一次崩溃留下的残骸）────────────────────────
if (-not $NoSweep -and (Test-Path $sweep)) {
    # 用**当前 PowerShell 宿主**再起一个进程跑清扫脚本，保证与调用方同一版本。
    # ⚠️ 必须这样：本仓库的 .ps1 是 UTF-8 **无 BOM**（仓库惯例），Windows PowerShell 5.1
    #    会按 ANSI(GBK) 读 → 中文注释解码错乱 → 脚本解析异常 → taskkill 根本没执行
    #    （实测 killed=0、进程还活着）。pwsh 7 按 UTF-8 读才正常。
    #    另：_sweep_orphans.ps1 本身已加 UTF-8 BOM，5.1 也能正确解码 —— 双保险。
    & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File $sweep | Out-Null
}

# ── 报告残留 ────────────────────────────────────────────────────────
$left = @()
foreach ($name in $targets) { $left += @(Get-Process -Name $name) }
$llama = @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'")
Write-Output ("STOPPED targets=$($targets -join ',') appLeft=$($left.Count) llamaLeft=$($llama.Count)")
