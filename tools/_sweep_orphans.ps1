<#
    孤儿侧车 / llama-server 清扫（2026-11-02 整机崩溃事故修复）

    为什么要这个脚本：
      应用被强杀（Stop-Process -Force / 任务管理器「结束任务」/ 崩溃）时，
      Node 的 proc.kill() 与 Rust 的 Child::kill() 在 Windows 上都是 **TerminateProcess**
      → python 的 atexit 不执行 → mt_engine.shutdown() 不跑
      → 它拉起的 llama-server.exe 变成**孤儿进程**继续占着显存。
      每个 Hy-MT2 llama-server 占 ~1.2GB 显存；本机是 RTX 4070 Laptop **8GB**
      → 攒到 6~7 个就把显存打满 → CUDA 分配失败降级共享内存 → 系统内存雪崩 → 整机崩溃。
      侧车侧还有自己的看门狗「连续 5 次慢 → 重拉 llama-server」，
      显存被挤时不断重拉 → 用户看到的「一直重新启动」。

    判据（关键）：**父进程已不存在** 才算孤儿。
      · 应用还活着 → 侧车父进程 = 应用（存活）→ 不动
      · 应用被强杀 → 侧车父进程消失 → 判定为残骸 → 连树清掉（连带它的 llama-server）
      · 用户手动 run.bat 起的侧车 → 父进程 = cmd.exe（存活）→ 不动
      · 用户手动起的 llama-server → 父进程 = cmd/PowerShell（存活）→ 不动

    两条规则：
      A) llama-server.exe 且命令行含 Hy-MT2（我们自己那个翻译模型）→ 父进程已死 → 清掉
      B) python.exe/pythonw.exe 且命令行是 local_capture_service.py / rapidocr_service.py
         （= 我们自己的侧车脚本）→ 父进程已死 → taskkill /T 连树清掉（含其 llama-server）

    注意：**不能用 wmic**。Win11 新版已移除 wmic.exe，仓库外那份
    rapidocr_service.py 的 _kill_orphan_llama_servers() 正是靠 wmic
    → except 分支静默跳过 → 孤儿清理从未真正生效过。

    ⚠️ **本文件必须存成 UTF-8 with BOM**：
       Windows PowerShell 5.1 读**无 BOM** 的 .ps1 会按 ANSI(GBK) 解码 → 中文注释
       解码错乱 → 脚本解析异常 → taskkill 根本没执行（实测 killed=0、进程还活着，
       而且**没有任何报错**）。pwsh 7 默认按 UTF-8 读才正常。
       仓库惯例是 .ps1 一律无 BOM（探针本来就要求 pwsh 7），但本脚本会被宿主
       （Node/Rust）直接调用，宿主环境不保证有 pwsh 7 → 所以这里单独带 BOM 双保险。

    用法：
      powershell -NoProfile -ExecutionPolicy Bypass -File tools\_sweep_orphans.ps1
      # 或从宿主（Node / Rust）调用本脚本
#>
param(
    [switch]$Quiet
)

$ErrorActionPreference = 'SilentlyContinue'

function Test-ParentAlive([int]$parentId) {
    if ($parentId -le 0) { return $false }
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId"
    return ($null -ne $p)
}

$targets = @()   # 形如 @{Id=..; Kind='llama'|'sidecar'; Detail='..'}

# ── 规则 A：Hy-MT2 llama-server 的父进程已不存在 ────────────────────
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'")) {
    if (-not $p.CommandLine -or $p.CommandLine -notmatch 'Hy-MT2') { continue }
    if (Test-ParentAlive ([int]$p.ParentProcessId)) { continue }
    $targets += @{ Id = [int]$p.ProcessId; Kind = 'llama'; Detail = 'parent-dead' }
}

# ── 规则 B：侧车 python 的父进程已不存在 → 连树清掉 ──────────────────
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'")) {
    $cl = if ($p.CommandLine) { $p.CommandLine } else { '' }
    if ($cl -notmatch 'local_capture_service\.py|rapidocr_service\.py') { continue }
    if (Test-ParentAlive ([int]$p.ParentProcessId)) { continue }
    $targets += @{ Id = [int]$p.ProcessId; Kind = 'sidecar'; Detail = 'parent-dead' }
}

# ── 执行清理（/T = 连子进程树一起杀，/F = 强制）─────────────────────
$killed = 0
$failed = @()
foreach ($t in $targets) {
    # ⚠️ 不要用 `2>&1 | Out-Null`：Windows PowerShell 5.1 下这样写会让 taskkill
    #    的 stderr 进管道，管道提前关闭导致 taskkill 根本没执行成功（实测 killed=0、
    #    进程还活着）。改为把输出收进变量再判断退出码。
    $out = & taskkill /PID $t.Id /T /F 2>&1
    $code = $LASTEXITCODE
    if ($code -eq 0) {
        $killed++
    } else {
        $failed += "pid=$($t.Id) code=$code $(($out | Out-String).Trim())"
    }
}

$llama = @($targets | Where-Object { $_.Kind -eq 'llama' }).Count
$sidecar = @($targets | Where-Object { $_.Kind -eq 'sidecar' }).Count
$summary = "SWEEP orphan sidecars: llama=$llama sidecar=$sidecar killed=$killed"
if ($failed.Count -gt 0) { $summary += " failed=[$($failed -join '; ')]" }
Write-Output $summary
