#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""进程 / 显存孤儿防护 —— 一键自测（2026-11-02 整机崩溃事故修复的回归套件）

跑什么（全部不加载任何模型，秒级完成）：

  A  仓库外三个文件语法编译
       local_capture_service.py / rapidocr_service.py / screenshot_tool/mt_engine.py
  B  _pid_alive 三态自测（在两个侧车里各测一遍）
       自己在跑 → True；别的活进程 → True；已退出 → False；不存在 → False
  C  父进程死亡守护端到端
       造一个「假宿主」拉起侧车守护线程，宿主立刻消失 → 守护线程必须自杀
  D  孤儿 llama-server 清理（CIM 版，替代已失效的 wmic）
       父进程已死 → 必须杀掉；父进程还活着 → **不能**误杀（用户手动起的实例）
  E  收尾：确认没有残留的 llama-server / 侧车 python

用法（**一条命令**）：
  & 'F:\\Work\\Create\\OCR\\venv_ocr\\Scripts\\python.exe' 'F:\\Work\\Create\\OCR\\screenshot\\tools\\_process_selftest.py'

加 -WithCargo 还会跑 F2 的 Job Object 回归测试（cargo test，首次较慢）。
退出码：0 = 全过，1 = 有失败项。
"""

from __future__ import annotations

import ast
import os
import shutil
import subprocess
import sys
import tempfile
import time

# ── 输出统一 UTF-8 ────────────────────────────────────────────────────
# 简体中文 Windows 的控制台默认 GBK(936)；不切码页的话中文输出在管道/控制台里会花。
# 先把控制台码页切到 65001，再把 stdout/stderr 强制成 UTF-8 —— 两种场景都可读。
try:
    import ctypes as _c

    _c.windll.kernel32.SetConsoleOutputCP(65001)
    _c.windll.kernel32.SetConsoleCP(65001)
except Exception:
    pass
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

OCR_DIR = r"F:\Work\Create\OCR"
PY = os.path.join(OCR_DIR, "venv_ocr", "Scripts", "python.exe")
SIDECAR_F1 = os.path.join(OCR_DIR, "local_capture_service.py")
SIDECAR_F2 = os.path.join(OCR_DIR, "rapidocr_service.py")
MT_ENGINE = os.path.join(OCR_DIR, "screenshot_tool", "mt_engine.py")

FAILS: list[str] = []


def ok(cond: bool, label: str, detail: str = "") -> bool:
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"  ({detail})" if detail else ""))
    if not cond:
        FAILS.append(label)
    return cond


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def extract(path: str, names: tuple[str, ...], extra_ns: dict | None = None):
    """从源文件里抽出指定函数（支持 __main__ 下的嵌套定义）并 exec。"""
    src = open(path, encoding="utf-8").read()
    tree = ast.parse(src)
    ns: dict = {"subprocess": subprocess, "sys": sys, "os": os}
    if extra_ns:
        ns.update(extra_ns)
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in names:
            exec(compile(ast.Module(body=[node], type_ignores=[]), path, "exec"), ns)
            break
    return ns


def pid_alive(pid: int) -> bool:
    out = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command",
         f"if (Get-Process -Id {pid} -EA SilentlyContinue) {{ 'ALIVE' }}"],
        capture_output=True, text=True, timeout=30)
    return "ALIVE" in (out.stdout or "")


def cim_pids(expr: str) -> list[int]:
    out = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", expr],
        capture_output=True, text=True, timeout=30)
    return [int(x) for x in (out.stdout or "").split(",") if x.strip().isdigit()]


# ── A 语法编译 ────────────────────────────────────────────────────────
def test_compile() -> None:
    section("A  仓库外文件语法编译")
    for f in (SIDECAR_F1, SIDECAR_F2, MT_ENGINE):
        if not os.path.exists(f):
            ok(False, f"{os.path.basename(f)} 存在", f)
            continue
        r = subprocess.run([PY, "-m", "py_compile", f], capture_output=True, text=True)
        ok(r.returncode == 0, f"{os.path.basename(f)} 编译通过",
           "" if r.returncode == 0 else (r.stderr or "")[-200:])


# ── B _pid_alive 三态 ──────────────────────────────────────────────────
def test_pid_alive(path: str) -> None:
    name = os.path.basename(path)
    ns = extract(path, ("_pid_alive",), {"_ctypes": __import__("ctypes")})
    if "_pid_alive" not in ns:
        ok(False, f"{name} 含 _pid_alive")
        return
    alive = ns["_pid_alive"]
    ok(alive(os.getpid()) is True, f"{name} _pid_alive(自己) = True")
    other = subprocess.Popen([PY, "-c", "import time; time.sleep(20)"])
    ok(alive(other.pid) is True, f"{name} _pid_alive(别的活进程) = True")
    other.kill(); other.wait()
    dead = subprocess.Popen([PY, "-c", "pass"]); dead.wait()
    ok(alive(dead.pid) is False, f"{name} _pid_alive(已退出) = False")
    ok(alive(999999) is False, f"{name} _pid_alive(不存在) = False")


# ── C 父进程死亡守护端到端 ────────────────────────────────────────────
def test_parent_watchdog(path: str) -> None:
    name = os.path.basename(path)
    tmp = tempfile.mkdtemp(prefix="pwatch_")
    child_py = os.path.join(tmp, "child.py")
    host_py = os.path.join(tmp, "host.py")
    with open(child_py, "w", encoding="utf-8") as f:
        f.write(
            "import ast, os, sys\n"
            f"SRC = {path!r}\n"
            "src = open(SRC, encoding='utf-8').read()\n"
            "tree = ast.parse(src)\n"
            "ns = {'_ctypes': __import__('ctypes')}\n"
            "for n in ast.walk(tree):\n"
            "    if isinstance(n, ast.FunctionDef) and n.name in ('_pid_alive','_parent_watchdog'):\n"
            "        exec(compile(ast.Module(body=[n], type_ignores=[]), SRC, 'exec'), ns)\n"
            f"sys.path.insert(0, {OCR_DIR!r})\n"
            "print('[child] watchdog up, owner=' + os.environ.get('PETALSNAP_OWNER_PID','?'), flush=True)\n"
            "ns['_parent_watchdog']()\n"
        )
    with open(host_py, "w", encoding="utf-8") as f:
        f.write(
            "import os, subprocess, sys, time\n"
            "env = dict(os.environ); env['PETALSNAP_OWNER_PID'] = str(os.getpid())\n"
            f"c = subprocess.Popen([sys.executable, {child_py!r}], env=env)\n"
            f"open({os.path.join(tmp, 'pid.txt')!r}, 'w').write(str(c.pid))\n"
            "print('[host] pid=%d child=%d -> vanishing' % (os.getpid(), c.pid), flush=True)\n"
            "time.sleep(2); os._exit(0)\n"
        )
    subprocess.run([PY, host_py], capture_output=True, text=True)
    pid_file = os.path.join(tmp, "pid.txt")
    if not os.path.exists(pid_file):
        ok(False, f"{name} 守护端到端（宿主脚本没起来）")
        shutil.rmtree(tmp, ignore_errors=True)
        return
    pid = int(open(pid_file).read())
    died = False
    for _ in range(20):
        time.sleep(1)
        if not pid_alive(pid):
            died = True
            break
    ok(died, f"{name} 宿主消失后侧车自杀", f"{'已退出' if died else '15s 仍存活'}")
    if not died:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)
    shutil.rmtree(tmp, ignore_errors=True)


# ── D CIM 版孤儿清理（正 + 负） ───────────────────────────────────────
def test_cim_cleanup() -> None:
    ns = extract(SIDECAR_F2, ("_kill_orphan_llama_servers",))
    if "_kill_orphan_llama_servers" not in ns:
        ok(False, "rapidocr_service.py 含 _kill_orphan_llama_servers")
        return
    clean = ns["_kill_orphan_llama_servers"]

    tmp = tempfile.mkdtemp(prefix="llamatest_")
    fake = os.path.join(tmp, "llama-server.exe")
    shutil.copy2(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe", fake)

    # ① 真孤儿：父进程立刻退出
    code = ("import subprocess,sys; subprocess.Popen([sys.argv[1],'-NoProfile','-Command',"
            "'Start-Sleep -Seconds 300; # Hy-MT2 orphan'], "
            "creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0));")
    subprocess.run([PY, "-c", code, fake], capture_output=True)
    time.sleep(2)
    orphans = cim_pids("(Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | "
                        "Where-Object { $_.CommandLine -match 'Hy-MT2' } | "
                        "ForEach-Object { $_.ProcessId }) -join ','")
    if not orphans:
        ok(False, "CIM 清理：没找到测试孤儿")
    else:
        clean()
        time.sleep(2)
        alive_left = [p for p in orphans if pid_alive(p)]
        ok(not alive_left, "CIM 清理：父进程已死的 llama-server 被杀掉",
           f"残留 {alive_left}" if alive_left else f"pid={orphans}")

    # ② 父进程还活着 → 不能误杀
    holder = subprocess.Popen([fake, "-NoProfile", "-Command",
                               "Start-Sleep -Seconds 300; # Hy-MT2 keep"],
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    time.sleep(2)
    clean()
    time.sleep(2)
    ok(pid_alive(holder.pid), "CIM 清理：父进程存活的实例未被误杀")
    holder.kill(); holder.wait()
    shutil.rmtree(tmp, ignore_errors=True)


# ── E 收尾残留检查 ────────────────────────────────────────────────────
def test_no_leftovers() -> None:
    section("E  收尾残留检查")
    left = cim_pids("(Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | "
                    "ForEach-Object { $_.ProcessId }) -join ','")
    ok(not left, "无残留 llama-server", f"残留 {left}" if left else "0 个")
    sidecars = cim_pids("(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "
                         "'local_capture_service\\.py|rapidocr_service\\.py' } | "
                         "ForEach-Object { $_.ProcessId }) -join ','")
    ok(not sidecars, "无残留侧车 python", f"残留 {sidecars}" if sidecars else "0 个")


def main() -> int:
    print("进程 / 显存孤儿防护 —— 一键自测")
    print(f"python = {PY}")
    test_compile()
    section("B  _pid_alive 三态")
    test_pid_alive(SIDECAR_F1)
    test_pid_alive(SIDECAR_F2)
    section("C  父进程死亡守护端到端")
    test_parent_watchdog(SIDECAR_F1)
    test_parent_watchdog(SIDECAR_F2)
    section("D  CIM 版孤儿 llama-server 清理")
    test_cim_cleanup()
    test_no_leftovers()

    if "--with-cargo" in sys.argv:
        section("F  F2 Job Object 回归测试（cargo test）")
        r = subprocess.run(
            ["cargo", "test", "--manifest-path",
             r"F:\Work\Create\OCR\screenshot\tauri-spike\src-tauri\Cargo.toml",
             "--bin", "petalsnap-tauri-spike"],
            capture_output=True, text=True)
        ok(r.returncode == 0, "cargo test 通过",
           "" if r.returncode == 0 else (r.stdout or "")[-400:])

    print("\n" + "=" * 56)
    if FAILS:
        print(f"RESULT: FAIL（{len(FAILS)} 项）→ " + "; ".join(FAILS))
        return 1
    print("RESULT: ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
