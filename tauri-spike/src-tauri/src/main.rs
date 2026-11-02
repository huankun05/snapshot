// PetalSnap Tauri/WebView2 spike —— capture.js 整体移植版
// 界面 = F1 的 capture.html/css/js 一字不改 + shim.js（Electron IPC 垫片）。
// Rust 侧 = 会话流（对齐 Electron captureWindow 时序）+ 通道后端（smart 三件套直调
// smart_uia.dll、OCR/翻译代理 18766、其余优雅 stub）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::c_void;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use windows::Win32::Foundation::POINT;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDCW, CreateDIBSection, DeleteDC, DeleteObject, EnumDisplayMonitors,
    GetMonitorInfoW, MonitorFromPoint, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
    CAPTUREBLT, DIB_RGB_COLORS, HDC, HGDIOBJ, HBITMAP, HMONITOR, MONITORINFO, MONITORINFOEXW,
    MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};
use windows::core::w;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static REVEALED: AtomicBool = AtomicBool::new(false);

/// MONITORINFOF_PRIMARY（winuser.h）：windows crate 0.58 未导出该常量，此处按原值定义。
const MONITORINFOF_PRIMARY: u32 = 0x0000_0001;

/// 渲染端上报的 WebView2 `devicePixelRatio`（= 窗口实际渲染用的单一 dpr）。
/// 由 ui/shim.js 在页面就绪时上报。**只作校验用，不作换算源**——见 start_session_ex 的说明。
static WEBVIEW_DPR: Mutex<Option<f64>> = Mutex::new(None);

/// 主显示器缩放率（= Electron `screen.getPrimaryDisplay().scaleFactor`）。
///
/// ⚠️ 这是本项目坐标模型的**权威 dpr 来源**，与 Electron 侧严格同源。
/// 绝不能用 `win.scale_factor()`：那是"窗口当前所在显示器"的 DPI，窗口跨屏移动后会变
/// （实测：窗口移到副屏 → 1.5，而 WebView2 渲染仍用 1.25）→ 两套系数并存 →
/// 整条坐标链错位（virtualScreen / cursor / visibleWindows 一起偏 512 CSS px）。
unsafe fn primary_scale_factor() -> f64 {
    struct Ctx {
        sf: f64,
    }
    let mut ctx = Ctx { sf: 1.0 };
    unsafe extern "system" fn enum_proc(
        hmon: HMONITOR,
        _hdc: HDC,
        _rc: *mut windows::Win32::Foundation::RECT,
        l: LPARAM,
    ) -> windows::Win32::Foundation::BOOL {
        let ctx: &mut Ctx = unsafe { &mut *(l.0 as *mut Ctx) };
        let mut mi = MONITORINFOEXW::default();
        mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmon, &mut mi as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool()
            && (mi.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0
        {
            let mut dpi = 96u32;
            let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi, &mut dpi);
            ctx.sf = dpi as f64 / 96.0;
            return windows::Win32::Foundation::BOOL(0); // 找到主屏，停
        }
        windows::Win32::Foundation::BOOL(1)
    }
    let _ = EnumDisplayMonitors(
        None,
        None,
        Some(enum_proc),
        LPARAM(&mut ctx as *mut Ctx as isize),
    );
    ctx.sf
}

// ── 日志：%TEMP%\petalsnap-spike.log（release 无控制台）────────────────
pub fn logln(s: &str) {
    let p: PathBuf = std::env::temp_dir().join("petalsnap-spike.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let _ = writeln!(f, "[{}] {}", now_ms(), s);
    }
    #[cfg(debug_assertions)]
    println!("{}", s);
}
fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ── 资源路径解析（2026-10-31 P0-5）───────────────────────────────────
// 旧版三处硬编码绝对路径（node worker / python 解释器 / OCR 脚本）→ 换机器即废、
// 不可分发。解析顺序：环境变量 → 可执行文件同级（含 resources/scripts/assets 子目录）
// → 从 exe 目录向上逐级查找（开发期 exe 在 src-tauri/target/release/，资源在项目根附近）。
fn app_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::env::temp_dir())
}

/// 解析随包资源（rel 可含子目录，如 "venv_ocr/Scripts/python.exe"）。
fn resolve_resource(env_key: &str, rel: &str) -> Option<PathBuf> {
    if let Ok(v) = std::env::var(env_key) {
        let p = PathBuf::from(v);
        if p.exists() {
            return Some(p);
        }
        logln(&format!("[res] env {} 指向不存在的路径: {}", env_key, p.display()));
    }
    let base = app_dir();
    let mut cur: &std::path::Path = base.as_path();
    for _ in 0..8 {
        for sub in ["", "resources", "scripts", "assets"] {
            let p = cur.join(sub).join(rel);
            if p.exists() {
                return Some(p);
            }
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => break,
        }
    }
    None
}

// ── 单实例锁（2026-10-31 P0-6）────────────────────────────────────────
// Electron 侧 app/main.ts 有单实例锁；Tauri 侧缺 → 可同时开多个实例抢全局热键
// （F1/F2 被占，先启动的那个静默失效，用户看到"有时没反应"）。命名互斥体兜住。
// HANDLE 是裸指针（*mut c_void），不是 Send → 不能直接放进 static。
// 句柄只需在进程存活期间持有（进程退出由 OS 回收），故以 usize 存。
static INSTANCE_MUTEX: std::sync::LazyLock<Mutex<Option<usize>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// 尝试获取单实例锁。false = 已有实例在跑（本进程应退出）。
fn acquire_single_instance() -> bool {
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;
    let name = w!("Local\\PetalSnapTauriSpike");
    let (handle, already_exists) = unsafe {
        // GetLastError 必须在 CreateMutexW 之后立刻取：ERROR_ALREADY_EXISTS 靠它判定
        let h = CreateMutexW(None, true, name);
        let already = GetLastError() == ERROR_ALREADY_EXISTS;
        match h {
            Ok(h) => (Some(h), already),
            Err(_) => (None, already),
        }
    };
    match handle {
        Some(h) => {
            if already_exists {
                unsafe {
                    let _ = CloseHandle(h);
                }
                logln("[instance] another instance is running → exit");
                return false;
            }
            *INSTANCE_MUTEX.lock().unwrap() = Some(h.0 as usize);
            logln("[instance] single-instance lock acquired");
            true
        }
        None => {
            // 创建失败（权限/组策略）不阻塞启动，只记日志
            logln("[instance] CreateMutexW failed → 继续启动（可能多开）");
            true
        }
    }
}

// ── 智能检测辅助进程（smart_worker.js + node）────────────────────────
// 为什么存在：smart_uia.dll 的 UIA 客户端在宿主=WebView2/Tauri 进程内返回空树
//（同点同时刻独立 node 进程正常，2026-10-28 实锤：node n=4 / tauri n=1），故照搬
// F1 的 worker 架构——DLL 由独立 node 进程独占（单线程 koffi，已被探针千锤百炼），
// 宿主经 stdin/stdout JSON 行协议调用；超时杀掉重建 = F1 worker terminate 同款。
// 协议：{"id":n,"op":"get_levels|snapshot|poke","x":..,"y":..} → {"id":n,"json":...}
struct SmartWorker {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    next_id: u64,
    pending: std::collections::HashMap<u64, (Sender<Option<Value>>, Instant)>,
}
static WORKER: std::sync::LazyLock<Mutex<Option<SmartWorker>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));
static WORKER_RETRY_AT: std::sync::LazyLock<Mutex<Instant>> =
    std::sync::LazyLock::new(|| Mutex::new(Instant::now().checked_sub(Duration::from_secs(3600)).unwrap_or_else(Instant::now)));

/// F1 内核调用（含诊断打点）：量「查询 → 回包」耗时、在飞数、内核待处理队列长度。
/// 在飞数 > 1 说明渲染端的单飞守卫失效（多个查询同时挂着 → 回包互相顶掉）。
fn kernel_uia(x: i32, y: i32, timeout_ms: u64) -> Option<Value> {
    let inflight = UIA_INFLIGHT.fetch_add(1, Ordering::SeqCst) + 1;
    UIA_PEAK.fetch_max(inflight, Ordering::SeqCst);
    let t0 = Instant::now();
    let queued = WORKER
        .lock()
        .unwrap()
        .as_ref()
        .map(|w| w.pending.len())
        .unwrap_or(0);
    let r = kernel_uia_inner(x, y, timeout_ms);
    let d = t0.elapsed().as_millis() as u64;
    UIA_INFLIGHT.fetch_sub(1, Ordering::SeqCst);
    logln(&format!(
        "[probe] uia ({},{}) {}ms inflight={} peak={} queued={} -> {}",
        x,
        y,
        d,
        inflight,
        UIA_PEAK.load(Ordering::SeqCst),
        queued,
        if r.is_some() { "ok" } else { "none" }
    ));
    r
}

/// F1 内核调用：{type:"uia",id,x,y} → {id,json}；1.5s 超时（F1 渲染端同款）
fn kernel_uia_inner(x: i32, y: i32, timeout_ms: u64) -> Option<Value> {
    // ── 分段探针（2026-11-01）：把「等 worker 回包」拆成「写 stdin」与「等回包」──
    // 实测谜团：`dll=0/1ms total=214/325ms` —— worker 内部 0ms、node 事件循环无滞后，
    // 但 Rust 等了 200ms+。候选：① 写 stdin 本身被阻塞（管道满 / 持锁写）② 回包已到但
    // 投递延迟（读线程在解析大行）。分段打点直接分辨。
    let t_seg = Instant::now();
    worker_ensure().ok()?;
    let t_after_ensure = t_seg.elapsed().as_millis() as u64;
    let (rtx, rrx) = channel();
    let id;
    let send_ok = {
        let mut guard = WORKER.lock().unwrap();
        let w = guard.as_mut()?;
        id = w.next_id;
        w.next_id += 1;
        w.pending.insert(id, (rtx, Instant::now()));
        use std::io::Write;
        let line = format!("{{\"type\":\"uia\",\"id\":{},\"x\":{},\"y\":{}}}\n", id, x, y);
        w.stdin.write_all(line.as_bytes()).is_ok() && w.stdin.flush().is_ok()
    };
    let t_after_write = t_seg.elapsed().as_millis() as u64;
    if !send_ok {
        let mut guard = WORKER.lock().unwrap();
        if let Some(w) = guard.as_mut() {
            w.pending.remove(&id);
        }
        return None;
    }
    let out = match rrx.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(v) => {
            let guard = WORKER.lock().unwrap();
            let hung = guard
                .as_ref()
                .map(|w| w.pending.values().any(|(_, t)| t.elapsed() > Duration::from_secs(6)))
                .unwrap_or(false);
            drop(guard);
            if hung {
                worker_kill_hung("hung>6s");
            }
            v
        }
        Err(_) => {
            // 弃单笔不杀进程（2026-10-29 教训：杀循环=冷树查询必超时的雪崩源）
            let mut guard = WORKER.lock().unwrap();
            if let Some(w) = guard.as_mut() {
                w.pending.remove(&id);
            }
            logln(&format!("[kernel] uia timeout {}ms (abandoned)", timeout_ms));
            None
        }
    };
    // 分段打点（只在慢的时候打，避免刷屏）：ensure / 写 stdin / 等回包
    let t_total = t_seg.elapsed().as_millis() as u64;
    if t_total > 100 {
        logln(&format!(
            "[probe] kernel seg ensure={}ms write={}ms wait={}ms total={}ms",
            t_after_ensure,
            t_after_write - t_after_ensure,
            t_total - t_after_write,
            t_total
        ));
    }
    out
}

fn worker_ensure() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let mut guard = WORKER.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    if Instant::now() < *WORKER_RETRY_AT.lock().unwrap() {
        return Err("backoff".into());
    }
    let exe = std::env::var("PETALSNAP_NODE").unwrap_or_else(|_| "node".into());
    let script = match resolve_resource("PETALSNAP_SMART_WORKER", "f1_worker.js") {
        Some(p) => p,
        None => {
            logln("[res] 找不到 f1_worker.js（智能选框不可用）；用 PETALSNAP_SMART_WORKER 指定路径");
            PathBuf::from("f1_worker.js")
        }
    };
    let mut child = std::process::Command::new(&exe)
        .arg(&script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // 宿主进程 PID 传给内核（2026-11-01）：F2 的 DLL 跑在**独立 node 进程**里，
        // GetCurrentProcessId() 是 node 的 PID，与本进程（Tauri）的截图遮罩对不上 →
        // DLL 判不出「自家遮罩」→ 放行 → 查询钻进自家 WebView2 DOM → 智能框 = 遮罩内容区
        // （实测占屏 69%）= 用户报的「识别还是不够准」。
        // F1 的 UIA 查询在 worker_threads（同进程）→ 不需要这个，F1 行为不变。
        .env("PETALSNAP_OWNER_PID", std::process::id().to_string())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let pid = child.id();
    *guard = Some(SmartWorker {
        child,
        stdin,
        next_id: 1,
        pending: std::collections::HashMap::new(),
    });
    logln(&format!("[worker] spawned pid={}", pid));
    std::thread::spawn(move || {
        use std::io::BufRead;
        let r = std::io::BufReader::new(stderr);
        for line in r.lines() {
            let Ok(l) = line else { break };
            logln(&format!("[worker-err] {}", l));
        }
    });
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            // ── 诊断探针（2026-11-01）：量「worker 回包这一行」的体积与解析耗时 ──
            // 为什么量：实测出现 `dll=0/1ms total=214/325ms` —— worker 自身处理 0ms、
            // node 事件循环也无滞后，但 Rust 侧等了 200ms+ → 只剩「这一行读进来解析」
            // 与「写 stdin → 收到回包」两处可疑。地图外发是**整窗元素表**（微信/Chromium
            // 可达数百项），F1 走 worker_threads 结构化克隆（零解析），F2 走 stdout 文本
            // → 这里必须逐行打点才知道是不是 JSON 解析吃掉了时间。
            let t_parse = Instant::now();
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let parse_ms = t_parse.elapsed().as_millis() as u64;
            let is_map = v.get("type").and_then(|x| x.as_str()) == Some("map");
            if parse_ms > 15 || (is_map && line.len() > 4096) {
                logln(&format!(
                    "[probe] worker line {} bytes parse={}ms kind={}",
                    line.len(),
                    parse_ms,
                    if is_map { "map" } else { "reply" }
                ));
            }
            if is_map {
                // F1 内核主动外发整窗图（物理坐标）→ 存 MAP 供 smart:map-get 换算下发
                let win = v.get("win").cloned().unwrap_or(Value::Null);
                let items = v.get("items").and_then(|i| i.as_array()).cloned().unwrap_or_default();
                *MAP.lock().unwrap() = Some(MapEntry { win, items, at: Instant::now() });
                continue;
            }
            if v.get("type").and_then(|x| x.as_str()) == Some("crash") {
                logln(&format!("[kernel-crash] {}", v.get("stack").and_then(|x| x.as_str()).unwrap_or("")));
                continue;
            }
            let id = v.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
            let json = v.get("json").cloned();
            let mut guard = WORKER.lock().unwrap();
            if let Some(w) = guard.as_mut() {
                if let Some((tx, _)) = w.pending.remove(&id) {
                    let _ = tx.send(json);
                }
            }
        }
        // worker 进程退出：清空挂起请求，300ms 后允许重建
        let mut guard = WORKER.lock().unwrap();
        if let Some(w) = guard.as_mut() {
            for (_, (tx, _)) in w.pending.drain() {
                let _ = tx.send(None);
            }
            let _ = w.child.kill();
        }
        *guard = None;
        *WORKER_RETRY_AT.lock().unwrap() = Instant::now() + Duration::from_millis(300);
        logln("[worker] exited — respawn in 300ms");
    });
    Ok(())
}

/// 真挂死判定：任一请求挂起超过 6s → worker 判死，杀掉重建
fn worker_kill_hung(reason: &str) {
    let mut guard = WORKER.lock().unwrap();
    if let Some(w) = guard.as_mut() {
        let _ = w.child.kill();
        for (_, (tx, _)) in w.pending.drain() {
            let _ = tx.send(None);
        }
    }
    *guard = None;
    *WORKER_RETRY_AT.lock().unwrap() = Instant::now() + Duration::from_millis(300);
    logln(&format!("[worker] {} → killed, respawn in 300ms", reason));
}

// 注：原 worker_call / dll_get_levels / dll_snapshot / dll_poke 一组（按 op 分派给
// 辅助进程）在 2026-10-29 换成 F1 内核（f1_worker.js）后已无调用方——内核的
// 快照/戳激活/重拍决策全部收进 f1_worker.js 内部，主进程只发 {type:"uia"} 查询。
// 连同"超时 ≠ 杀 worker"（冷树查询 0.4~1.4s，杀循环=雪崩）那条教训一并落在
// kernel_uia 的注释与实现里，故此处不再保留死代码。

// ── 整窗元素地图（F1 worker 架构的 Rust 等价物）──────────────────────
struct MapEntry {
    win: Value,
    items: Vec<Value>,
    at: Instant,
}
static MAP: Mutex<Option<MapEntry>> = Mutex::new(None);
static FALLBACK_Q: Mutex<Option<(Value, Instant)>> = Mutex::new(None);
static Q_LOG_LAST: std::sync::LazyLock<Mutex<Instant>> =
    std::sync::LazyLock::new(|| Mutex::new(Instant::now()));
static LAST_FRAME: Mutex<Option<(u32, u32, Vec<u8>)>> = Mutex::new(None); // (w, h, BGRA)
static VS_SIZE: Mutex<(u32, u32)> = Mutex::new((0, 0));
/// 最近一次已知目标窗矩形（物理）：内核查询超时期间画窗级兜底框，任何时刻屏上都有框
static LAST_WINDOW: Mutex<Option<Value>> = Mutex::new(None);

// ── 诊断探针（2026-10-31 用户实测报障：F2 卡顿 + ESC 退不出）────────────────
// 目的：把「卡在哪一环」变成可测数字。渲染端侧探针在 ui/shim.js（longtask / 键盘 /
// 鼠标洪水 / IPC 往返），Rust 侧这四个负责「壳」这一半。
/// UIA 查询在飞数（渲染端 smartIpcBusy 保证同时只有 1 条，这里验是不是真的）
static UIA_INFLIGHT: AtomicUsize = AtomicUsize::new(0);
/// UIA 在飞数峰值
static UIA_PEAK: AtomicUsize = AtomicUsize::new(0);
/// 主线程最大卡顿（ms）：run_on_main_thread 探针测得
static MT_STALL_MAX: AtomicU64 = AtomicU64::new(0);
/// 会话起始时刻（热键按下），用于算每一段时延
static SESSION_T0: Mutex<Option<Instant>> = Mutex::new(None);

/// 会话内相对时延打点（ms）。会话未开始时返回 -1。
fn sess_dt() -> i64 {
    SESSION_T0
        .lock()
        .unwrap()
        .map(|t| t.elapsed().as_millis() as i64)
        .unwrap_or(-1)
}

/// 主线程响应性探针：每 200ms 往主线程投递一个闭包，量「投递 → 执行」的延迟。
/// 延迟暴涨 = 主线程被卡住 —— **同步命令（含 ipc_send/capture-cancel）会排在它后面**，
/// 这正是「ESC 退不出」最可能的成因（2026-10-31 实测报障）。
fn spawn_main_thread_probe(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            let t = Instant::now();
            let _ = app.run_on_main_thread(move || {
                let d = t.elapsed().as_millis() as u64;
                MT_STALL_MAX.fetch_max(d, Ordering::SeqCst);
                if d > 80 {
                    logln(&format!("[probe] main-thread stall {}ms", d));
                }
            });
            std::thread::sleep(Duration::from_millis(200));
        }
    });
}

// ── 贴图（pin）：F1 capturePinWindow.ts 的 Rust 等价物 ────────────────
const PIN_EDGE: f64 = 30.0; // CSS 留白（与 pin.css body padding 一致）
const PIN_MIN_AXIS: f64 = 48.0;
const PIN_MAX_RATIO: f64 = 0.6;
static PIN_LABELS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static PIN_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
struct PinDrag {
    start_cur: (i32, i32),
    start_win: (i32, i32),
    expect: (f64, f64), // CSS 图尺寸
}
static PIN_DRAGS: std::sync::LazyLock<Mutex<std::collections::HashMap<String, PinDrag>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// 光标处显示器的工作区（物理 px）+ 缩放率
unsafe fn monitor_at_cursor() -> Option<(RECT, RECT, f64)> {
    let mut pt = POINT::default();
    if !GetCursorPos(&mut pt).is_ok() {
        return None;
    }
    let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
    if hmon.is_invalid() {
        return None;
    }
    let mut mi = MONITORINFO::default();
    mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if !GetMonitorInfoW(hmon, &mut mi).as_bool() {
        return None;
    }
    let mut dpi = 96u32;
    let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi, &mut dpi);
    Some((mi.rcMonitor, mi.rcWork, dpi as f64 / 96.0))
}

fn fit_min_axis(w: f64, h: f64) -> (f64, f64) {
    let mut width = w.max(1.0).round();
    let mut height = h.max(1.0).round();
    if width < PIN_MIN_AXIS || height < PIN_MIN_AXIS {
        let k = PIN_MIN_AXIS / width.min(height);
        width = (width * k).max(PIN_MIN_AXIS).round();
        height = (height * k).max(PIN_MIN_AXIS).round();
    }
    (width, height)
}

fn create_pin_window(app: &AppHandle, data_url: &str) -> bool {
    let Some(b64) = data_url.split(',').nth(1) else { return false };
    let Some(bytes) = base64_decode(b64) else { return false };
    let Ok(img) = image::load_from_memory(&bytes) else { return false };
    let (img_w, img_h) = (img.width() as f64, img.height() as f64); // 物理 px
    let Some((_mon, work, sf)) = (unsafe { monitor_at_cursor() }) else { return false };
    let work_w = (work.right - work.left) as f64 / sf;
    let work_h = (work.bottom - work.top) as f64 / sf;
    let img_css_w = img_w / sf;
    let img_css_h = img_h / sf;
    let scale = 1.0f64.min(work_w * PIN_MAX_RATIO / img_css_w).min(work_h * PIN_MAX_RATIO / img_css_h);
    let (fw, fh) = fit_min_axis(img_css_w * scale, img_css_h * scale);
    let win_css_w = fw + PIN_EDGE * 2.0;
    let win_css_h = fh + PIN_EDGE * 2.0;
    let stack = (PIN_LABELS.lock().unwrap().len() % 10) as f64 * 26.0;
    let raw_x = work.left as f64 / sf + (work_w - win_css_w) / 2.0 + stack;
    let raw_y = work.top as f64 / sf + (work_h - win_css_h) / 2.0 + stack;
    let x = raw_x.clamp(work.left as f64 / sf, work.left as f64 / sf + work_w - win_css_w);
    let y = raw_y.clamp(work.top as f64 / sf, work.top as f64 / sf + work_h - win_css_h);

    let seq = PIN_SEQ.fetch_add(1, Ordering::SeqCst);
    let label = format!("pin-{}", seq);
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("pin.html".into()))
        .title("pin")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false);
    let win = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            logln(&format!("[pin] create failed: {}", e));
            return false;
        }
    };
    let phys_x = (x * sf).round() as i32;
    let phys_y = (y * sf).round() as i32;
    let _ = win.set_position(tauri::Position::Physical(PhysicalPosition::new(phys_x, phys_y)));
    let _ = win.set_size(tauri::Size::Physical(PhysicalSize::new(
        (win_css_w * sf).round() as u32,
        (win_css_h * sf).round() as u32,
    )));
    PIN_LABELS.lock().unwrap().push(label.clone());
    let _ = win.emit_to(
        &label,
        "ipc-event",
        json!({ "ch": "pin-image", "args": { "dataURL": data_url, "displayWidth": fw, "displayHeight": fh } }),
    );
    let _ = win.show();
    logln(&format!("[pin] created {} img={}x{} css={:.0}x{:.0}", label, img_w, img_h, fw, fh));
    true
}

fn for_each_pin(app: &AppHandle, f: impl Fn(&WebviewWindow)) {
    let labels = PIN_LABELS.lock().unwrap().clone();
    for l in labels {
        if let Some(w) = app.get_webview_window(&l) {
            f(&w);
        }
    }
}

// ── Python 侧车（18766）自管理：健康则复用（F1 在跑时），否则自拉起、退出时回收 ──
static PY_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);
static PY_SPAWNING: Mutex<bool> = Mutex::new(false);

/// 侧车解释器：环境变量 → exe 相对（venv_ocr/Scripts/python.exe）→ 向上逐级找。
fn resolve_python() -> Option<PathBuf> {
    resolve_resource("PETALSNAP_PYTHON", "venv_ocr/Scripts/python.exe")
        .or_else(|| resolve_resource("PETALSNAP_PYTHON", "venv/Scripts/python.exe"))
}

/// OCR 服务脚本：环境变量 → exe 相对 → 向上逐级找。
fn resolve_ocr_script() -> Option<PathBuf> {
    resolve_resource("PETALSNAP_RAPIDOCR_SCRIPT", "rapidocr_service.py")
}

async fn py_health_ok() -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(400))
        .build()
        .unwrap();
    matches!(client.get("http://127.0.0.1:18766/health").send().await, Ok(r) if r.status().is_success())
}

async fn ensure_py_service() -> bool {
    if py_health_ok().await {
        return true; // F1 或此前自拉的实例在跑 → 直接复用
    }
    {
        let mut spawning = PY_SPAWNING.lock().unwrap();
        if *spawning {
            return false; // 另一线程正在拉起
        }
        *spawning = true;
    }
    let spawned = (|| {
        use std::os::windows::process::CommandExt;
        let (Some(python), Some(script)) = (resolve_python(), resolve_ocr_script()) else {
            logln("[py] 找不到 python 解释器或 rapidocr_service.py（识别功能不可用）");
            logln("[py] 用 PETALSNAP_PYTHON / PETALSNAP_RAPIDOCR_SCRIPT 指定路径");
            return false;
        };
        match std::process::Command::new(python)
            .arg(script)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
        {
            Ok(c) => {
                *PY_CHILD.lock().unwrap() = Some(c);
                logln("[py] sidecar spawned (18766)");
                true
            }
            Err(e) => {
                logln(&format!("[py] spawn failed: {}", e));
                false
            }
        }
    })();
    if spawned {
        // 冷启动 ~4-10s（模型加载）；封顶 30s
        for _ in 0..75 {
            std::thread::sleep(Duration::from_millis(400));
            if py_health_ok().await {
                *PY_SPAWNING.lock().unwrap() = false;
                logln("[py] sidecar healthy");
                return true;
            }
        }
    }
    *PY_SPAWNING.lock().unwrap() = false;
    false
}

fn kill_py_service() {
    let mut guard = PY_CHILD.lock().unwrap();
    if let Some(mut c) = guard.take() {
        let _ = c.kill();
        logln("[py] sidecar killed (owned)");
    }
}

// ── 设置持久化：%APPDATA%\petalsnap-spike\store.json ─────────────────
fn store_path() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let dir = PathBuf::from(appdata).join("petalsnap-spike");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("store.json"))
}
fn store_load() -> serde_json::Map<String, Value> {
    store_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}
fn store_save(map: &serde_json::Map<String, Value>) {
    if let Some(p) = store_path() {
        if let Ok(s) = serde_json::to_string_pretty(map) {
            let _ = std::fs::write(p, s);
        }
    }
}
fn store_default(key: &str) -> Value {
    match key {
        "i18n-language" => json!("zh-CN"),
        "screenshot-ocr-engine" => json!("local"),
        "screenshot-translate-engine" => json!("local"),
        "screenshot-translate-source-lang" => json!("auto"),
        "screenshot-translate-target-lang" => json!("zh"),
        "screenshot-text-translate-target-lang" => json!("zh"),
        _ => Value::Null,
    }
}

fn vnum(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}
// 注：原 rect_contains / map_inside / pick_chain 一组（渲染端本地查表取框用的
// 「按点挑最小元素链」）在 2026-10-29 换成 F1 内核后已无调用方——选框决策
// （最小元素 / 层级链 / 面积地板）全部收进 f1_worker.js，主进程只负责下发
// smart:map-get 的整窗图，故此处不再保留死代码。

// ── 帧传输：为什么仍走 IPC Response，不落盘给渲染端 asset:// 直读 ──────────
// 2026-10-31 实测（本机双屏 5120×1440 = 29.5MB 原始像素，同一台机器逐项打点）：
//   IPC Response（二进制 tauri::ipc::Response，不经 JSON 序列化）：
//     渲染端 meta→buf 214ms，buf→dispatch 62ms；Rust 侧 0 额外开销
//   asset protocol（Rust 落盘 + 渲染端 fetch(convertFileSrc)）：
//     渲染端 meta→buf 249ms（headers 215ms + body 34ms），buf→dispatch 136ms；
//     Rust 侧**额外**写盘 13~232ms（负载高时更差）
//   → asset 两端都不占优，净亏 35~150ms（渲染端）+ 13~232ms（Rust 落盘）。
//   故回退为纯 IPC，并保留分段打点以便将来再评估。
//   ⚠️ 真正的天花板是 WebView2 没有 Chromium 的 shared-memory IPC（Electron 传
//     同一个 Buffer 只需 ~26ms），29.5MB 过桥 ~200ms 是架构性的，不是实现问题。

// ── GDI 抓帧：全虚拟屏 BitBlt → BGRA（保持原生字节序，渲染端/DLL 都按对称通道处理）──
unsafe fn capture_virtual_screen() -> Option<(i32, i32, i32, i32, Vec<u8>)> {
    let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
    let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if vw <= 0 || vh <= 0 {
        return None;
    }
    let hdc_screen: HDC = CreateDCW(w!("DISPLAY"), None, None, None);
    let hdc_mem = CreateCompatibleDC(hdc_screen);
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = vw;
    bmi.bmiHeader.biHeight = -vh; // top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = 0; // BI_RGB
    let mut bits: *mut c_void = std::ptr::null_mut();
    let hbmp: HBITMAP =
        CreateDIBSection(hdc_mem, &bmi, DIB_RGB_COLORS, &mut bits, None, 0).expect("CreateDIBSection");
    let old = SelectObject(hdc_mem, HGDIOBJ(hbmp.0));
    let t0 = Instant::now();
    BitBlt(hdc_mem, 0, 0, vw, vh, hdc_screen, vx, vy, SRCCOPY | CAPTUREBLT).expect("BitBlt");
    let ms = t0.elapsed().as_millis();
    let size = (vw as usize) * (vh as usize) * 4;
    let mut bgra = vec![0u8; size];
    std::ptr::copy_nonoverlapping(bits as *const u8, bgra.as_mut_ptr(), size);
    SelectObject(hdc_mem, old);
    let _ = DeleteObject(HGDIOBJ(hbmp.0));
    let _ = DeleteDC(hdc_mem);
    let _ = DeleteDC(hdc_screen);
    logln(&format!("[gdi] capture {}x{} @{},{} bitblt={}ms", vw, vh, vx, vy, ms));
    Some((vx, vy, vw, vh, bgra))
}

/// 枚举可见顶层窗口（F1 getVisibleWindows 等价物，物理→CSS 换算）。
///
/// ⚠️ 坐标系（2026-10-31 修 P0-1）：入参 `vs_css_x/vs_css_y` 必须是**全局 CSS 原点**
/// （= 物理原点 ÷ 窗口 dpr），与 meta.virtualScreen.x/y 同值。早期版本误传物理原点
/// （−2560 而非 −2048）→ 同一份 meta 里并存两套原点，每个窗框恒偏 512 CSS px；
/// 而 visibleWindows 正是「无 UIA 树应用 → 窗级大块」档位的唯一数据源
/// （像素链已按 2026-10-27 定调全局停用），偏了等于该档整体不达标。
///
/// 过滤与 Electron `enumVisibleWindowsKoffi`（screenshotHelper.ts:143）等效：
/// 跳过本进程、UWP 幽灵窗（DWM cloaked——Electron 未跳，但它们本不可见，跳掉是净收益）、
/// 以及小于前端过滤线的小窗（前端 `findWindowRectAt` 滤 <90 CSS px，故此处用 90×dpr 物理，
/// 在任意 dpr 下都与前端对齐）。
unsafe fn enum_visible_windows(dpr: f64, vs_css_x: f64, vs_css_y: f64) -> Value {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongW, GetWindowTextW, GetWindowRect, GetWindowThreadProcessId,
        IsWindowVisible, GWL_EXSTYLE,
    };
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    struct Ctx {
        arr: Vec<Value>,
        self_pid: u32,
        dpr: f64,
        vs_css_x: f64,
        vs_css_y: f64,
    }
    let mut ctx = Ctx {
        arr: Vec::new(),
        self_pid: std::process::id(),
        dpr,
        vs_css_x,
        vs_css_y,
    };
    unsafe extern "system" fn enum_proc(h: HWND, l: LPARAM) -> windows::Win32::Foundation::BOOL {
        let ctx: &mut Ctx = unsafe { &mut *(l.0 as *mut Ctx) };
        unsafe {
            if !IsWindowVisible(h).as_bool() {
                return windows::Win32::Foundation::BOOL(1);
            }
            let mut pid = 0u32;
            let _ = GetWindowThreadProcessId(h, Some(&mut pid));
            if pid == ctx.self_pid {
                return windows::Win32::Foundation::BOOL(1);
            }
            let mut cloaked = 0u32;
            let _ = DwmGetWindowAttribute(
                h,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut _,
                std::mem::size_of::<u32>() as u32,
            );
            if cloaked != 0 {
                return windows::Win32::Foundation::BOOL(1);
            }
            let mut rc = windows::Win32::Foundation::RECT::default();
            if GetWindowRect(h, &mut rc).is_err() {
                return windows::Win32::Foundation::BOOL(1);
            }
            let w = rc.right - rc.left;
            let hh = rc.bottom - rc.top;
            // 阈值跟随前端过滤线：前端 findWindowRectAt 滤掉 <90 CSS px 的窗，
            // 这里用 90×dpr 物理，任意 dpr 下都与前端对齐（1.25 → 112px，与旧值同）。
            let min_px = (90.0 * ctx.dpr).round() as i32;
            if w < min_px || hh < min_px {
                return windows::Win32::Foundation::BOOL(1);
            }
            let ex = GetWindowLongW(h, GWL_EXSTYLE);
            if ex & 0x80 != 0 {
                return windows::Win32::Foundation::BOOL(1); // WS_EX_TOOLWINDOW
            }
            let mut buf = [0u16; 256];
            let n = GetWindowTextW(h, &mut buf);
            let title = String::from_utf16_lossy(&buf[..(n.max(0) as usize)]);
            let css = |v: i32, vs: f64| ((v as f64 / ctx.dpr) - vs).round() as i64;
            ctx.arr.push(serde_json::json!({
                "x": css(rc.left, ctx.vs_css_x),
                "y": css(rc.top, ctx.vs_css_y),
                "width": ((w as f64) / ctx.dpr).round() as i64,
                "height": ((hh as f64) / ctx.dpr).round() as i64,
                "title": title,
            }));
        }
        windows::Win32::Foundation::BOOL(1)
    }
    let _ = EnumWindows(
        Some(enum_proc),
        LPARAM(&mut ctx as *mut Ctx as isize),
    );
    let n = ctx.arr.len();
    logln(&format!(
        "[wins] enumerated {} visible windows (dpr={:.2}, vsCss=({:.0},{:.0}))",
        n, dpr, vs_css_x, vs_css_y
    ));
    Value::Array(ctx.arr)
}

/// 枚举显示器。
///
/// ⚠️ 字段语义必须与 Electron `captureWindow.ts:608-614` 对齐（前端 displayCssRect 依赖）：
///   - `physicalBounds` = **物理**像素外接框（前端优先用它 ÷ canvasDpr 换算成窗口 CSS）
///   - `bounds`         = 该屏自己的 **DIP** 外接框（物理 ÷ 该屏 scaleFactor）。
///     ⚠️ 前端注释明确「不能用 d.bounds」（副屏 150% 时它 ≠ 窗口里的 CSS 宽），
///     仅在 physicalBounds 缺失时兜底 —— 但语义必须仍是 DIP，不能塞物理值。
///   - `scaleFactor`    = 该屏真实缩放率（旧版恒写 1，是错值）。
///   - `primary`        = 是否主屏（旧版缺失 → 前端 d.primary 恒 undefined）。
unsafe fn enum_displays() -> Value {
    struct Ctx { arr: Vec<Value> }
    let mut ctx = Ctx { arr: Vec::new() };
    unsafe extern "system" fn enum_proc(
        hmon: HMONITOR,
        _hdc: HDC,
        rc: *mut windows::Win32::Foundation::RECT,
        l: LPARAM,
    ) -> windows::Win32::Foundation::BOOL {
        let ctx: &mut Ctx = unsafe { &mut *(l.0 as *mut Ctx) };
        let mut mi = MONITORINFOEXW::default();
        mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmon, &mut mi as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
            let r = &mi.monitorInfo.rcMonitor;
            let pw = r.right - r.left;
            let ph = r.bottom - r.top;
            let mut dpi = 96u32;
            let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi, &mut dpi);
            let sf = dpi as f64 / 96.0;
            let primary = (mi.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0;
            ctx.arr.push(json!({
                "id": format!("{}", hmon.0 as usize),
                "physicalBounds": { "x": r.left, "y": r.top, "width": pw, "height": ph },
                "bounds": {
                    "x": (r.left as f64 / sf).round() as i64,
                    "y": (r.top as f64 / sf).round() as i64,
                    "width": (pw as f64 / sf).round() as i64,
                    "height": (ph as f64 / sf).round() as i64,
                },
                "scaleFactor": sf,
                "primary": primary,
            }));
        }
        let _ = rc;
        windows::Win32::Foundation::BOOL(1)
    }
    let _ = EnumDisplayMonitors(
        None,
        None,
        Some(enum_proc),
        LPARAM(&mut ctx as *mut Ctx as isize),
    );
    Value::Array(ctx.arr)
}

// ── 会话（对齐 Electron captureWindow 时序：内容就位 → capture-ready → 亮窗）──
fn start_session(app: &AppHandle) {
    start_session_ex(app, false)
}

fn start_session_ex(app: &AppHandle, auto_copy: bool) {
    if ACTIVE.swap(true, Ordering::SeqCst) {
        return;
    }
    // 会话时基：后续所有打点都带「相对会话起点的 ms」，用来量端到端延迟
    *SESSION_T0.lock().unwrap() = Some(Instant::now());
    logln("[probe] session start");
    // 截图期间隐藏全部贴图（F1 同款），会话结束恢复
    for_each_pin(app, |w| {
        let _ = w.hide();
    });
    let t0 = Instant::now();
    let (vx, vy, vw, vh, bgra) = match unsafe { capture_virtual_screen() } {
        Some(v) => v,
        None => {
            ACTIVE.store(false, Ordering::SeqCst);
            return;
        }
    };
    *VS_SIZE.lock().unwrap() = (vw as u32, vh as u32);
    *LAST_FRAME.lock().unwrap() = Some((vw as u32, vh as u32, bgra.clone()));
    // 像素链：辅助进程暂无像素通道（渲染端 PIXEL_CHAIN_FOR_BOX=false 不发查询），framePrepared=false
    *MAP.lock().unwrap() = None; // 新会话新图
    *FALLBACK_Q.lock().unwrap() = None;

    let Some(win) = app.get_webview_window("capture") else {
        ACTIVE.store(false, Ordering::SeqCst);
        return;
    };
    let _ = win.set_position(tauri::Position::Physical(PhysicalPosition::new(vx, vy)));
    let _ = win.set_size(tauri::Size::Physical(PhysicalSize::new(vw as u32, vh as u32)));

    // ── 窗口 dpr（单一 dpr 表面）──────────────────────────────────────
    // 权威来源 = **主显示器 DPI**（与 Electron 侧 `screen.getPrimaryDisplay().scaleFactor`
    // 严格同源；窗口 backing = CSS × 该 dpr = 物理帧 1:1）。
    //
    // ⚠️ 绝不能用 `win.scale_factor()`：那是"窗口当前所在显示器"的 DPI，窗口跨屏移动
    // 后会跟着变（实测：窗口移到副屏 → 1.5），而 WebView2 渲染仍用 1.25 →
    // 两套系数并存 → virtualScreen / cursor / visibleWindows 一起偏 512 CSS px，
    // 且 smart:at-point 的物理查询点也偏 426 物理 px（查到了别的元素）。
    //
    // 渲染端上报的 devicePixelRatio 只用于**校验**这个假设（见 set_webview_dpr 与
    // shim.js 的 DPR MISMATCH 检查）——它一旦不等，就必须报警而不是静默错位。
    let win_dpr = unsafe { primary_scale_factor() }.clamp(0.25, 8.0);
    {
        let wv = WEBVIEW_DPR.lock().unwrap();
        if let Some(v) = *wv {
            if (v - win_dpr).abs() > 0.01 {
                logln(&format!(
                    "[dpr] ⚠️ 主屏 DPI={:.3} 但渲染端 devicePixelRatio={:.3} —— 两版行为将不一致",
                    win_dpr, v
                ));
            }
        }
    }

    // ── 全局 CSS 原点（唯一真源）──────────────────────────────────────
    // 渲染端坐标系：窗口 CSS = 桌面物理 ÷ winDpr；全局 CSS 原点 = 物理原点 ÷ winDpr。
    // meta.virtualScreen / meta.cursor / visibleWindows 三者必须共用这一对值 ——
    // 否则同一份 payload 里会并存两套原点（早期误把物理原点当 CSS 原点传，
    // 每个窗框恒偏 512 CSS px，且 visibleWindows 是「无 UIA 应用 → 窗级大块」的唯一数据源）。
    let vs_css_x = vx as f64 / win_dpr;
    let vs_css_y = vy as f64 / win_dpr;

    let mut cursor = json!({ "x": 0, "y": 0 });
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_ok() {
            cursor["x"] = json!(((pt.x - vx) as f64 / win_dpr).round() as i64);
            cursor["y"] = json!(((pt.y - vy) as f64 / win_dpr).round() as i64);
        }
    }
    let displays = unsafe { enum_displays() };
    let visible_windows = unsafe { enum_visible_windows(win_dpr, vs_css_x, vs_css_y) };
    let meta = json!({
        "captureSource": "plugin",
        "externalCapture": false,
        "autoCopy": auto_copy,
        "scaleFactor": 1,
        "cropRect": null,
        // 「帧已由主进程备好，渲染端不要重发」标志（capture.js:8182 读它 → :1015 直接 return）。
        //
        // F1 置 true：主进程 GDI 直抓位图并已喂 DLL 像素缓存 → 渲染端不必再回传。
        // F2 置 true：Rust 侧**已经**用原生抓屏拿到同一张全帧（LAST_FRAME），并经
        // `get_frame_raw` 的二进制通道（tauri::ipc::Response，不走 JSON）送进渲染端
        // ——渲染端手上已经有帧，没有理由再从画布 getImageData 回读一遍。
        // F1 该标志附带的另一半含义（主进程已把位图直喂 DLL 像素缓存）在 F2 不成立，
        // 但像素链整体停用（渲染端 PIXEL_CHAIN_FOR_BOX=false + Rust smart:pixel-at
        // 恒空），没有消费方，差异无影响。
        //
        // ⚠️ 不置 true 的代价（2026-10-31 用户实测「刚进截图就卡」+「ESC 退不出」实锤）：
        // 渲染端 sendSmartFrame() 会把 29.5MB 的 Uint8Array 丢进 ipcRenderer.send →
        // WebView2 postMessage 只接受「可 JSON 序列化」的对象 → 该数组被摊平成
        // 「两千万个键的 JSON 对象」（约 600MB 文本）：渲染端主线程 marshaling 阻塞
        // ~3.1s（实测 longtask 3090ms），Rust 主线程 serde_json 再解析一遍阻塞 ~2.2s
        // （实测 main-thread stall 2193ms）——两个观测数字由同一个原因解释掉。
        //
        // 负向测试开关：设 PETALSNAP_FRAME_PREPARE=0 可强制置 false，用于**验证
        // shim 侧那道二进制载荷拦截真的兜得住**（主修复被回退时的第二道防线）。
        "framePrepared": std::env::var("PETALSNAP_FRAME_PREPARE").as_deref() != Ok("0"),
        "virtualScreen": {
            "x": vs_css_x.round() as i64,
            "y": vs_css_y.round() as i64,
            "width": (vw as f64 / win_dpr).round() as i64,
            "height": (vh as f64 / win_dpr).round() as i64,
        },
        "physicalScreen": null,
        "cursor": cursor,
        "displays": displays,
        "visibleWindows": visible_windows,
        "frameW": vw,
        "frameH": vh,
        // 窗口 dpr 明文下发：shim 与渲染端 devicePixelRatio 交叉校验用（见 ui/shim.js）。
        // 两者一旦不一致 → 整条坐标链（选框 / 裁剪 / 智能框）全错，必须当场发现。
        "winDpr": win_dpr,
    });
    let _ = win.emit("ipc-event", json!({ "ch": "__frame_meta", "args": meta }));
    logln(&format!(
        "[session] emit meta (dpr={:.3} vsCss=({:.0},{:.0}))",
        win_dpr, vs_css_x, vs_css_y
    ));
    REVEALED.store(false, Ordering::SeqCst);
    // capture-ready 由渲染端 ipc_send 到达后 reveal；800ms 兜底（F1 同款）
    let w2 = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        if ACTIVE.load(Ordering::SeqCst) && !REVEALED.load(Ordering::SeqCst) {
            REVEALED.store(true, Ordering::SeqCst);
            let _ = w2.show();
            let _ = w2.set_focus();
            logln("[session] reveal fallback (800ms)");
        }
    });
    logln(&format!("[session] capture+meta total {}ms", t0.elapsed().as_millis()));
}

fn stop_session(win: &WebviewWindow, reason: &str) {
    if !ACTIVE.swap(false, Ordering::SeqCst) {
        return;
    }
    logln(&format!(
        "[probe] session stop ({}) sess+{}ms uiaPeak={} mtStallMax={}ms",
        reason,
        sess_dt(),
        UIA_PEAK.load(Ordering::SeqCst),
        MT_STALL_MAX.load(Ordering::SeqCst)
    ));
    UIA_PEAK.store(0, Ordering::SeqCst);
    MT_STALL_MAX.store(0, Ordering::SeqCst);
    let _ = win.hide();
    // 渲染端状态重置（F1 关窗必发 capture-clear；此前不发 = 渲染端残留旧会话状态、
    // 查询尾巴继续跑 = 用户实测"退也退不出"）
    let _ = win.emit("ipc-event", json!({ "ch": "capture-clear", "args": {} }));
    // 会话结束恢复贴图显示
    let app2 = win.app_handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        for_each_pin(&app2, |w| {
            let _ = w.show();
        });
    });
    logln(&format!("[session] stop ({})", reason));
}

/// 工作区钳制（物理 px）：贴图 resize 不越出所在显示器工作区
fn clamp_to_work_area(x: i32, y: i32, w: i32, h: i32) -> (i32, i32) {
    unsafe {
        let hwnd = HWND(0 as *mut _);
        let _ = hwnd;
        // 用窗口当前位置找显示器
        let pt = POINT { x: x + w / 2, y: y + h / 2 };
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        if hmon.is_invalid() {
            return (x, y);
        }
        let mut mi = MONITORINFO::default();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if !GetMonitorInfoW(hmon, &mut mi).as_bool() {
            return (x, y);
        }
        let wa = mi.rcWork;
        let nx = x.max(wa.left).min(wa.right - w);
        let ny = y.max(wa.top).min(wa.bottom - h);
        (nx, ny)
    }
}

/// 虚拟屏粗钳制（物理 px）：拖动不彻底跑出所有显示器（允许贴边一部分在外）
fn clamp_to_virtual(x: i32, y: i32) -> (i32, i32) {
    unsafe {
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let keep = 64;
        (x.max(vx - 4096).min(vx + vw - keep), y.max(vy - 4096).min(vy + vh - keep))
    }
}

// ── 剪贴板 PNG：dataURL/base64 → RGBA → 插件写图 ─────────────────────
fn png_b64_to_rgba(b64: &str) -> Option<(Vec<u8>, u32, u32)> {
    let bytes = base64_decode(b64)?;
    let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
    Some((img.as_raw().clone(), img.width(), img.height()))
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    // 最小 base64 解码（无外部依赖）
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\r' | b'\n' => continue,
            _ => continue,
        };
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

// ── OCR/翻译 HTTP 代理（F1 的 Python 侧车 18766，运行 F1 时即在线）────
async fn proxy_18766(path: &str, body: Value) -> Value {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap();
    match client
        .post(format!("http://127.0.0.1:18766{}", path))
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r.json::<Value>().await.unwrap_or(json!({ "success": false, "code": "badJson" })),
        Err(e) => json!({ "success": false, "code": "serviceDown", "msg": e.to_string() }),
    }
}

fn main() {
    // panic 全捕获（2026-10-29：进程无声消失——release 无 stderr，panic 全被吞。
    // 装钩子把 panic 落日志，下次死亡有全尸可验）
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("[PANIC] {}", info);
        logln(&msg);
    }));
    // 单实例锁：已有实例在跑 → 本进程直接退出。
    // 否则会同时开两个实例抢全局热键（F1/F2 被占），先启动的那个静默失效，
    // 用户侧表现为"有时按 F1 没反应"。
    if !acquire_single_instance() {
        std::process::exit(0);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let id = shortcut.into_string();
                        logln(&format!("[hotkey] {} fired", id));
                        start_session(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let gs = app.global_shortcut();
            // F1 / F2 **都注册**（2026-10-31）：迁移期两版并存，用户不该记"哪个键是谁"。
            // 谁空闲注册谁；两个都被占才失败。全局 handler 对已注册的键统一生效。
            let mut hotkeys: Vec<&str> = Vec::new();
            for name in ["F1", "F2"] {
                let sc: Shortcut = name.parse().unwrap();
                if gs.register(sc).is_ok() {
                    hotkeys.push(name);
                }
            }
            if hotkeys.is_empty() {
                logln("[hotkey] F1/F2 都注册失败");
            } else {
                logln(&format!("[hotkey] registered: {}", hotkeys.join(" + ")));
            }
            // 第二热键：截图并复制（F1 Alt+C 同款）
            let alt_c: Shortcut = "Alt+C".parse().unwrap();
            let app_c = app.handle().clone();
            if gs.register(alt_c).is_ok() {
                let _ = gs.on_shortcut("Alt+C", move |_app, _sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        logln("[hotkey] Alt+C fired");
                        start_session_ex(&app_c, true);
                    }
                });
                logln("[hotkey] Alt+C registered (截图并复制)");
            } else {
                logln("[hotkey] Alt+C 注册失败（可能被 F1 占用）");
            }

            // 捕获窗 = capture.html（驻留隐藏；capture-ready 后亮）
            // ⚠️ 诊断日志总闸走 **URL 参数**：capture.js 在**加载时**求值 SMART_DEBUG
            // （模块级常量），加载后无法再改——必须在页面创建前定好。默认关，与
            // Electron 侧一致（那边靠 process.env.PETALSNAP_SMART_DEBUG）。
            //
            // 2026-11-02：把「渲染端要读的环境变量」按**白名单**统一透传（?env=K=V,K=V）。
            // 此前 shim.js 的 window.process.env 是写死的一个键 → capture.js 读的其它
            // 环境变量（XIYUE_CAPTURE_NO_HOVER / PETALSNAP_SELFTEST /
            // PETALSNAP_SMART_HOVER_MODE…）在 Tauri 侧**静默失效**，两版行为不一致
            // 且毫无报错（例如负向测试开关在 F2 侧根本不生效，A/B 会得出假结论）。
            let mut env_pairs: Vec<String> = Vec::new();
            // 每个键的**允许值集合**（而不是统一只放行 "1"/"0"）：
            //   · PETALSNAP_SMART_HOVER_MODE 有三档口径 —— 1=新（三通道分离）
            //     2=二态分支（旧线上版本）0=最初线性补间；白名单若只放行 0/1，
            //     "2" 会被**静默丢掉** → A/B 的对照组根本没生效 → 假结论。
            //   · 其余是布尔开关，只放行 0/1。
            let env_allow: [(&str, &[&str]); 4] = [
                ("PETALSNAP_SMART_DEBUG", &["1", "0"]),
                ("PETALSNAP_SMART_HOVER_MODE", &["1", "2", "0"]),
                ("PETALSNAP_SELFTEST", &["1", "0"]),
                ("XIYUE_CAPTURE_NO_HOVER", &["1", "0"]),
            ];
            for (k, allowed) in env_allow {
                if let Ok(v) = std::env::var(k) {
                    if allowed.contains(&v.as_str()) {
                        env_pairs.push(format!("{}={}", k, v));
                    }
                }
            }
            let debug_url = if env_pairs.is_empty() {
                "capture.html".to_string()
            } else {
                format!("capture.html?env={}", env_pairs.join(","))
            };
            logln(&format!("[setup] capture window url = {}", debug_url));
            let win = WebviewWindowBuilder::new(app, "capture", WebviewUrl::App(debug_url.into()))
                .title("petalsnap-spike")
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .shadow(false)
                .visible(false)
                .build()?;
            win.hide()?;

            // ── dpr / CSS 原点 自检（2026-10-31 P0-1/P0-2）────────────────────
            // 权威 dpr = 主屏 DPI（与 Electron 同源）；窗口 scale_factor 仅打印对照
            // ——它会随窗口跨屏漂移，不可用于换算。两行（此处 + 渲染端 devicePixelRatio）
            // 在日志里相邻 → 一眼可比；不一致就是整条链会错。
            let primary_sf = unsafe { primary_scale_factor() };
            let win_sf = win.scale_factor().unwrap_or(1.0);
            let (vx0, vy0) = unsafe {
                (
                    GetSystemMetrics(SM_XVIRTUALSCREEN),
                    GetSystemMetrics(SM_YVIRTUALSCREEN),
                )
            };
            logln(&format!(
                "[dpr] 主屏DPI={:.3}（权威） 窗口scale_factor={:.3}（跨屏会漂·不采用） → 全局 CSS 原点=({:.0},{:.0})",
                primary_sf,
                win_sf,
                vx0 as f64 / primary_sf,
                vy0 as f64 / primary_sf
            ));

            // 托盘
            let snip_i = MenuItem::with_id(app, "snip", "立即截图 (F2)", true, None::<&str>)?;
            let snip_copy_i = MenuItem::with_id(app, "snipcopy", "截图并复制 (Alt+C)", true, None::<&str>)?;
            let set_i = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出 spike", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&snip_i, &snip_copy_i, &set_i, &quit_i])?;
            let mut tray = TrayIconBuilder::with_id("spike-tray").menu(&menu).on_menu_event(|app, event| {
                match event.id().as_ref() {
                    "snip" => start_session(app),
                    "snipcopy" => start_session_ex(app, true),
                    "settings" => open_settings(app),
                    "quit" => {
                        logln("[tray] quit");
                        app.exit(0);
                    }
                    _ => {}
                }
            });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            logln("[tray] created");

            // 智能检测已迁移至独立 node 辅助进程（smart_worker.js），setup 里拉起
            if let Err(e) = worker_ensure() {
                logln(&format!("[worker] init: {}", e));
            }

            // 主线程响应性探针（诊断用）：每 200ms 投递一个闭包量主线程延迟。
            // 主线程一卡，所有**同步**命令（含 ESC 的 capture-cancel）都排队 → 退不出。
            spawn_main_thread_probe(app.handle().clone());

            logln("[setup] ready");

            // 测试模式：PETALSNAP_SPIKE_AUTOTRIGGER_MS=3000 → 启动后自动触发一次会话
            let auto_ms = std::env::var("PETALSNAP_SPIKE_AUTOTRIGGER_MS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok());
            if let Some(ms) = auto_ms {
                let app_auto = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(ms));
                    logln("[autotest] trigger");
                    start_session(&app_auto);
                });
                logln(&format!("[autotest] armed {}ms", ms));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc_invoke,
            ipc_send,
            get_frame_raw,
            set_webview_dpr,
            clip_write_text,
            clip_write_image,
            open_external,
            js_log,
            win_close_self
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label().to_string();
                if label.starts_with("pin-") {
                    PIN_LABELS.lock().unwrap().retain(|l| l != &label);
                    PIN_DRAGS.lock().unwrap().remove(&label);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                kill_py_service();
                logln("[app] exit");
            }
        });
}

fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("拾花 spike 设置")
        .inner_size(560.0, 440.0)
        .resizable(false)
        .build();
    logln("[settings] opened");
}

// ── IPC 后端：invoke 通道 ────────────────────────────────────────────
fn phys_to_css(n: f64, dpr: f64, vs: f64) -> i64 {
    (n / dpr).round() as i64 - vs as i64
}
fn css_of(v: &Value, dpr: f64, vsx: f64, vsy: f64) -> Value {
    json!({
        "x": phys_to_css(vnum(v, "x"), dpr, vsx),
        "y": phys_to_css(vnum(v, "y"), dpr, vsy),
        "width": (vnum(v, "width") / dpr).round() as i64,
        "height": (vnum(v, "height") / dpr).round() as i64,
        "name": v.get("name").cloned().unwrap_or(Value::Null),
        "controlType": v.get("controlType").cloned().unwrap_or(Value::Null),
    })
}

/// IPC 入口（诊断打点）：量每条通道的往返耗时。
/// 关键：`smart:at-point` 走 async 命令 → 内部 `kernel_uia` **阻塞**一个 tokio worker
/// 最长 3000ms；`ipc_send`（capture-cancel/ESC）是**同步**命令 → 跑在**主线程**上。
/// 两者都可能被排队 —— 探针会把「谁堵了谁」直接量出来。
#[tauri::command]
async fn ipc_invoke(app: AppHandle, ch: String, args: Vec<Value>) -> Result<Value, String> {
    let t0 = Instant::now();
    let r = ipc_invoke_inner(app, ch.clone(), args).await;
    let d = t0.elapsed().as_millis() as u64;
    if d > 60 {
        logln(&format!("[probe] invoke {} {}ms (sess+{}ms)", ch, d, sess_dt()));
    }
    r
}

async fn ipc_invoke_inner(app: AppHandle, ch: String, args: Vec<Value>) -> Result<Value, String> {
    let a0 = args.first().cloned().unwrap_or(Value::Null);
    match ch.as_str() {
        // ── smart 三件套：与 F1 app/main.ts 严格同源的换算 ──
        "smart:at-point" => {
            // ── F1 内核纯代理（2026-10-29）：决策（地图/rowMissing/EFP/poke/重拍）全在
            // f1_worker.js（= F1 worker 原代码），这里只做坐标换算（phys→css，与 F1
            // main.ts 逐行同源）。查询即唤醒：内核每次查询自带 EFP/地图维护。
            let t0 = Instant::now();
            let css_x = vnum(&a0, "x");
            let css_y = vnum(&a0, "y");
            let vsx = a0.get("vsX").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let vsy = a0.get("vsY").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let dpr = a0.get("sf").and_then(|v| v.as_f64()).filter(|v| *v > 0.0).unwrap_or(1.25);
            let phys_x = ((css_x + vsx) * dpr).round() as i32;
            let phys_y = ((css_y + vsy) * dpr).round() as i32;
            let reply = kernel_uia(phys_x, phys_y, 3000);
            if let Some(r) = reply.as_ref() {
                if let Some(w) = r.get("window") {
                    if !w.is_null() {
                        *LAST_WINDOW.lock().unwrap() = Some(w.clone());
                    }
                }
            }
            // 超时兜底：内核无应答 → 用最近已知窗矩形画窗级框（绝不允许屏上无框的"卡死"观感）
            let reply = reply.or_else(|| {
                let lw = LAST_WINDOW.lock().unwrap().clone();
                lw.map(|w| {
                    json!({
                        "ok": true,
                        "levels": [],
                        "window": w,
                        "diag": { "dllMs": -1, "src": "lastwin" },
                    })
                })
            });
            let levels: Vec<Value> = reply
                .as_ref()
                .and_then(|r| r.get("levels").and_then(|l| l.as_array()).cloned())
                .unwrap_or_default()
                .iter()
                .map(|v| css_of(v, dpr, vsx, vsy))
                .collect();
            let win_css = reply
                .as_ref()
                .and_then(|r| r.get("window").cloned())
                .filter(|w| vnum(w, "width") as i64 >= 80)
                .map(|w| {
                    json!({
                        "x": phys_to_css(vnum(&w, "x"), dpr, vsx),
                        "y": phys_to_css(vnum(&w, "y"), dpr, vsy),
                        "width": (vnum(&w, "width") / dpr).round() as i64,
                        "height": (vnum(&w, "height") / dpr).round() as i64,
                        "title": w.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                    })
                });
            let dll_ms = reply
                .as_ref()
                .and_then(|r| r.get("diag").and_then(|d| d.get("ms")).and_then(|x| x.as_i64()))
                .unwrap_or(0);
            let src = reply
                .as_ref()
                .and_then(|r| r.get("diag").and_then(|d| d.get("src")).cloned())
                .unwrap_or(Value::Null);
            {
                let mut last = Q_LOG_LAST.lock().unwrap();
                if last.elapsed() >= Duration::from_millis(500) {
                    *last = Instant::now();
                    let src_s = if src.is_null() { "none".to_string() } else { src.to_string() };
                    // 诊断增强（2026-11-01，用户反馈「识别还是不够准」）：
                    // 光有 phys/n/src 看不出「是哪个应用 + 链上最小元素多大 + 面积地板选中了谁」，
                    // 而这三项恰好能一句话分诊：
                    //   win= 目标窗标题 → 判断应用是否有 UIA 树
                    //   min= 链上最小元素（CSS 尺寸 + 类型）→ 有细元素 = 树够细
                    //   auto= 面积地板选中的元素 → 与 min 差距大 = 地板跳过了中间层（DLL 出链要补中间层）
                    // 面积地板常量与 capture.js 的 SMART_MIN_AUTO_AREA 同值（0.003），
                    // 基准是**窗口 CSS 尺寸**（渲染端 W×H），与渲染端算法同源。
                    let win_name = reply
                        .as_ref()
                        .and_then(|r| r.get("window"))
                        .and_then(|w| w.get("name"))
                        .and_then(|n| n.as_str())
                        .unwrap_or("");
                    let vs_size = *VS_SIZE.lock().unwrap();
                    let css_w = (vs_size.0 as f64 / dpr).max(1.0);
                    let css_h = (vs_size.1 as f64 / dpr).max(1.0);
                    let floor_area = css_w * css_h * 0.003;
                    let fmt_lv = |v: &Value| {
                        format!(
                            "{}x{}:{}",
                            vnum(v, "width"),
                            vnum(v, "height"),
                            v.get("controlType").and_then(|t| t.as_str()).unwrap_or("-")
                        )
                    };
                    let min_s = levels.first().map(fmt_lv).unwrap_or_else(|| "-".to_string());
                    let auto_s = levels
                        .iter()
                        .find(|v| vnum(v, "width") * vnum(v, "height") >= floor_area)
                        .map(fmt_lv)
                        .unwrap_or_else(|| "-".to_string());
                    logln(&format!(
                        "[q] phys=({},{}) n={} src={} win=\"{}\" min={} auto={}",
                        phys_x,
                        phys_y,
                        levels.len(),
                        src_s,
                        win_name,
                        min_s,
                        auto_s
                    ));
                }
            }
            Ok(json!({
                "window": win_css,
                "element": levels.first().cloned().unwrap_or(Value::Null),
                "levels": levels,
                "diag": { "dllMs": dll_ms, "src": src, "totalMs": t0.elapsed().as_millis() as i64 },
            }))
        }
        "smart:map-get" => {
            let vsx = a0.get("vsX").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let vsy = a0.get("vsY").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let dpr = a0.get("sf").and_then(|v| v.as_f64()).filter(|v| *v > 0.0).unwrap_or(1.25);
            let guard = MAP.lock().unwrap();
            let Some(m) = guard.as_ref() else { return Ok(Value::Null) };
            if m.items.is_empty() || m.win.is_null() {
                return Ok(Value::Null);
            }
            Ok(json!({
                "t": m.at.elapsed().as_millis() as i64,
                "win": css_of(&m.win, dpr, vsx, vsy),
                "items": m.items.iter().map(|v| css_of(v, dpr, vsx, vsy)).collect::<Vec<_>>(),
            }))
        }
        // 像素兜底链：**有意停用**，不是"未移植"。
        // 渲染端总闸 PIXEL_CHAIN_FOR_BOX=false（capture.js:1810，2026-10-27 用户定调：
        // 无 UIA 约束的应用直接框窗级大块，不再按像素切分——像素块随光标每帧重算，
        // 碎框 + 频闪；Snipaste 同样零像素分析）。故本通道恒返回空 levels。
        // 「无 UIA 应用 → 窗级大块」这一档由 visibleWindows + smart_uia.dll 的
        // 大框名单（smart-bigbox.txt）承担，与本通道无关。
        "smart:pixel-at" => Ok(json!({ "ok": false, "levels": [] })),
        // ── store：持久化 JSON + 少量默认 ──
        "store:read" => {
            let key = a0.as_str().unwrap_or("");
            let map = store_load();
            Ok(map.get(key).cloned().unwrap_or_else(|| store_default(key)))
        }
        "store:write" => {
            if args.len() >= 2 {
                let key = a0.as_str().unwrap_or("").to_string();
                let val = args[1].clone();
                let mut map = store_load();
                map.insert(key, val);
                store_save(&map);
            }
            Ok(Value::Null)
        }
        // ── 贴图：新建 pin 窗（F1 capture-pin 同款语义，返回 bool）──
        "capture-pin" => {
            let data_url = a0.get("dataURL").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let app2 = app.clone();
            Ok(json!(tauri::async_runtime::spawn_blocking(move || create_pin_window(&app2, &data_url))
                .await
                .unwrap_or(false)))
        }
        // ── OCR/翻译：先确保 Python 侧车在线（复用 F1 实例或自拉起）──
        "capture-ocr-local" | "capture-ocr" => {
            if !ensure_py_service().await {
                return Ok(json!({ "success": false, "code": "serviceDown" }));
            }
            let data_url = a0.get("dataURL").and_then(|v| v.as_str()).unwrap_or("").to_string();
            Ok(proxy_18766("/ocr", json!({ "image": data_url })).await)
        }
        "capture-ocr-table" => {
            if !ensure_py_service().await {
                return Ok(json!({ "success": false, "code": "serviceDown" }));
            }
            let data_url = a0.get("dataURL").and_then(|v| v.as_str()).unwrap_or("").to_string();
            Ok(proxy_18766("/table", json!({ "image": data_url })).await)
        }
        "capture-ocr-smart" => {
            if !ensure_py_service().await {
                return Ok(json!({ "success": false, "code": "serviceDown" }));
            }
            let data_url = a0.get("dataURL").and_then(|v| v.as_str()).unwrap_or("").to_string();
            Ok(proxy_18766("/smart", json!({ "image": data_url })).await)
        }
        "capture-translate-local" | "capture-translate" => {
            if !ensure_py_service().await {
                return Ok(json!({ "success": false, "code": "serviceDown" }));
            }
            Ok(proxy_18766("/translate", a0).await)
        }
        // ── 有意未迁移 / 已废弃的通道（2026-10-31 用户决定，非遗漏）──────────
        //  code 区分两种性质，渲染端才能给出正确提示而不是泛化报错：
        //  · notPorted  = 本轮不迁（长截图 / 录屏：主线先跑通，见 Tauri迁移收尾方案 §4.1）
        //  · deprecated = 已废弃（PP-StructureV3 版面通道，主线已改 RapidOCR 路线）
        "capture-desktop-sources" => Ok(json!([])),
        "capture-desktop-source-for-window" => Ok(Value::Null),
        "capture-longshot-gdi" | "capture-longshot-frame" | "capture-longshot-save" | "capture-longshot-editor"
        | "capture-ls-autoscroll" | "capture-ls-debug" | "capture-ls-active" => {
            Ok(json!({ "success": false, "code": "notPorted" }))
        }
        "capture-record-save" | "capture-record-ignore-mouse" => {
            Ok(json!({ "success": false, "code": "notPorted" }))
        }
        "capture-ask-ai" => Ok(json!({ "success": false, "code": "notPorted" })),
        "capture-translate-text" => Ok(json!({ "success": false, "code": "notPorted" })),
        // 旧 PP-StructureV3 版面通道：Electron 侧注册了但从无调用方（2026-10-31 全仓核实），
        // 主线已改 RapidOCR 路线 → 判定废弃，Electron 侧一并移除。
        "capture-ocr-local-layout" | "capture-ocr-layout-status" | "capture-ocr-layout-cancel" => {
            Ok(json!({ "success": false, "code": "deprecated" }))
        }
        "smart:calib-run" | "smart:calib-report" => Ok(Value::Null),
        _ => {
            logln(&format!("[ipc] invoke 未实现: {} args={}", ch, serde_json::to_string(&args).unwrap_or_default().chars().take(120).collect::<String>()));
            Ok(Value::Null)
        }
    }
}

#[tauri::command]
fn ipc_send(window: tauri::WebviewWindow, app: AppHandle, ch: String, args: Vec<Value>) {
    let a0 = args.first().cloned().unwrap_or(Value::Null);
    match ch.as_str() {
        "capture-ready" => {
            if let Some(win) = app.get_webview_window("capture") {
                if !REVEALED.swap(true, Ordering::SeqCst) {
                    let t_show = Instant::now();
                    let _ = win.show();
                    // 诊断：show() 只是「让窗口可见」，**不等于用户已经看到画面**——
                    // WebView2 首次合成要时间，hidden→show 会有可见延迟/黑帧。
                    // F1 是「常驻 visible + opacity 0」，合成表面一直在 → 视觉瞬时。
                    // 这里记下 show→可见性确认的耗时与窗口矩形，供与 F1 对照。
                    let vis = win.is_visible().unwrap_or(false);
                    let scale = win.scale_factor().unwrap_or(1.0);
                    let size = win
                        .outer_size()
                        .map(|s| format!("{}x{}", s.width, s.height))
                        .unwrap_or_else(|_| "?".into());
                    logln(&format!(
                        "[probe] reveal show() {}ms visible={} outer={} css={}x{} (sess+{}ms)",
                        t_show.elapsed().as_millis(),
                        vis,
                        size,
                        (size.split('x').next().unwrap_or("0").parse::<f64>().unwrap_or(0.0) / scale) as i64,
                        (size.split('x').nth(1).unwrap_or("0").parse::<f64>().unwrap_or(0.0) / scale) as i64,
                        sess_dt()
                    ));
                    // ⚠️ Windows 前台锁：tao 的 set_focus 是标准 SetForegroundWindow，后台进程
                    // 常被拒绝（焦点留在原前台应用）→ 微信等 Qt 应用只对"前台进程的 UIA 客户端"
                    // 暴露完整无障碍树，焦点拿不到 = 智能框永远窗级（2026-10-28 F1/F2 差异最后
                    // 一块拼图：F1 会话前台=electron uiaLv=22；F2 会话前台=msedge uiaLv=0）。
                    // 经典解法：ALT 脉冲解锁前台锁，再 set_focus。
                    unsafe {
                        use windows::Win32::UI::Input::KeyboardAndMouse::{
                            keybd_event, KEYEVENTF_KEYUP, VK_MENU,
                        };
                        keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
                    }
                    let _ = win.set_focus();
                    unsafe {
                        let fg = windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
                        let mut pid = 0u32;
                        let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(
                            fg,
                            Some(&mut pid),
                        );
                        let mut name = String::new();
                        if let Ok(handle) = windows::Win32::System::Threading::OpenProcess(
                            windows::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION,
                            false,
                            pid,
                        ) {
                            let mut buf = [0u16; 260];
                            let mut sz = buf.len() as u32;
                            let ok = windows::Win32::System::Threading::QueryFullProcessImageNameW(
                                handle,
                                windows::Win32::System::Threading::PROCESS_NAME_FORMAT(0),
                                windows::core::PWSTR(buf.as_mut_ptr()),
                                &mut sz,
                            )
                            .is_ok();
                            if ok {
                                let full = String::from_utf16_lossy(&buf[..sz as usize]);
                                name = full.rsplit(['\\', '/']).next().unwrap_or("").to_string();
                            }
                            let _ = windows::Win32::Foundation::CloseHandle(handle);
                        }
                        logln(&format!(
                            "[session] reveal focus → foreground_pid={} {}",
                            pid, name
                        ));
                    }
                }
            }
        }
        "capture-cancel" | "capture-complete" => {
            // ESC 退出的关键路径：这条 ipc_send 是**同步**命令 → 跑在主线程。
            // 若主线程被卡住，它会排队 → 用户看到「ESC 没反应」。
            // 打点：到达时刻 + 本条处理耗时 + 相对会话起点的时延。
            let t_cancel = Instant::now();
            logln(&format!(
                "[probe] ipc_send {} arrived (sess+{}ms)",
                ch,
                sess_dt()
            ));
            if let Some(win) = app.get_webview_window("capture") {
                stop_session(&win, &ch);
                logln(&format!(
                    "[probe] ipc_send {} handled in {}ms",
                    ch,
                    t_cancel.elapsed().as_millis()
                ));
                if ch == "capture-complete" {
                    // complete 带 dataURL = 最终图：写剪贴板（F1 由主进程完成同样动作）
                    if let Some(u) = a0.get("dataURL").and_then(|v| v.as_str()) {
                        if let Some(b64) = u.split(',').nth(1) {
                            if let Some((rgba, w, h)) = png_b64_to_rgba(b64) {
                                use tauri_plugin_clipboard_manager::ClipboardExt;
                                let _ = app.clipboard().write_image(&tauri::image::Image::new_owned(rgba, w, h));
                                logln(&format!("[copy] {}x{} via capture-complete", w, h));
                            }
                        }
                    }
                }
            }
        }
        "capture-clipboard-image-write" => { /* 序号防护逻辑 F1 专用，此处空实现 */ }
        "smart:hover-mode" => { /* 单窗恒可交互（F1 等效行为） */ }
        // 正常情况下这条通道**不该再出现**：渲染端 framePrepared=true 直接跳过发送
        // （capture.js:1015 `if (smartFrameFromMain) return;`），且 ui/shim.js 还有
        // 一道硬拦截（ipcRenderer.send 包装里按二进制字节数掐掉 >1MB 载荷）。
        // 真收到 = 「不要发 29.5MB」的护栏被回退 → 大声记下来，别再静默丢弃。
        "smart:frame" => {
            logln("[warn] smart:frame 意外到达 —— 29.5MB 帧发送护栏被回退（渲染端 framePrepared 应为 true）");
        }
        "capture-log" => {
            logln(&format!("[js] {}", a0.as_str().unwrap_or("(non-str)")));
        }
        "capture-pin" => {
            logln("[pin] via send (unexpected path)");
        }
        "pin-copy" => {
            let data_url = a0.get("dataURL").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(b64) = data_url.split(',').nth(1) {
                if let Some((rgba, w, h)) = png_b64_to_rgba(b64) {
                    use tauri_plugin_clipboard_manager::ClipboardExt;
                    let _ = app.clipboard().write_image(&tauri::image::Image::new_owned(rgba, w, h));
                    logln(&format!("[pin] copy {}x{}", w, h));
                }
            }
        }
        "pin-save" => {
            let data_url = a0.get("dataURL").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(b64) = data_url.split(',').nth(1) {
                    if let Some(bytes) = base64_decode(b64) {
                        let ts = format!("{}", now_ms());
                        let default_name = format!("petalsnap_pin_{}.png", ts);
                        let pics = std::env::var("USERPROFILE")
                            .map(|u| PathBuf::from(u).join("Pictures"))
                            .unwrap_or_else(|_| std::env::temp_dir());
                        use tauri_plugin_dialog::DialogExt;
                        let file = app2
                            .dialog()
                            .file()
                            .add_filter("PNG", &["png"])
                            .set_file_name(default_name)
                            .set_directory(pics)
                            .blocking_save_file();
                        if let Some(p) = file {
                            let path = p.into_path().unwrap_or_else(|_| {
                                std::env::temp_dir().join("petalsnap_pin.png")
                            });
                            if std::fs::write(&path, &bytes).is_ok() {
                                logln(&format!("[pin] saved {}", path.display()));
                            }
                        }
                    }
                }
            });
        }
        "pin-resize" => {
            // 图 CSS 尺寸 → 窗口物理尺寸，左上锚定 + 工作区钳制
            let w = a0.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let h = a0.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let sf = window.scale_factor().unwrap_or(1.25);
            let img_w = w.max(PIN_MIN_AXIS);
            let img_h = h.max(PIN_MIN_AXIS);
            let win_w = ((img_w + PIN_EDGE * 2.0) * sf).round() as i32;
            let win_h = ((img_h + PIN_EDGE * 2.0) * sf).round() as i32;
            let cur = window.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
            let (x, y) = clamp_to_work_area(cur.0, cur.1, win_w, win_h);
            let _ = window.set_position(tauri::Position::Physical(PhysicalPosition::new(x, y)));
            let _ = window.set_size(tauri::Size::Physical(PhysicalSize::new(win_w as u32, win_h as u32)));
        }
        "pin-drag-start" => {
            let expect = (
                a0.get("expectW").and_then(|v| v.as_f64()).unwrap_or(0.0),
                a0.get("expectH").and_then(|v| v.as_f64()).unwrap_or(0.0),
            );
            unsafe {
                let mut pt = POINT::default();
                if GetCursorPos(&mut pt).is_ok() {
                    let pos = window.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
                    PIN_DRAGS.lock().unwrap().insert(
                        window.label().to_string(),
                        PinDrag { start_cur: (pt.x, pt.y), start_win: pos, expect },
                    );
                }
            }
        }
        "pin-drag-move" => {
            let mut session = PIN_DRAGS.lock().unwrap();
            let Some(s) = session.get_mut(window.label()) else { return };
            if let Some(wv) = a0.get("expectW").and_then(|v| v.as_f64()) {
                s.expect.0 = wv;
            }
            if let Some(hv) = a0.get("expectH").and_then(|v| v.as_f64()) {
                s.expect.1 = hv;
            }
            unsafe {
                let mut pt = POINT::default();
                if !GetCursorPos(&mut pt).is_ok() {
                    return;
                }
                // 尺寸回正（意外被系统改动时）
                let sf = window.scale_factor().unwrap_or(1.25);
                let ew = ((s.expect.0 + PIN_EDGE * 2.0) * sf).round() as u32;
                let eh = ((s.expect.1 + PIN_EDGE * 2.0) * sf).round() as u32;
                if let Ok(sz) = window.outer_size() {
                    if (sz.width as i64 - ew as i64).abs() > 4 || (sz.height as i64 - eh as i64).abs() > 4 {
                        let _ = window.set_size(tauri::Size::Physical(PhysicalSize::new(ew, eh)));
                    }
                }
                let moved_x = s.start_win.0 + (pt.x - s.start_cur.0);
                let moved_y = s.start_win.1 + (pt.y - s.start_cur.1);
                let (x, y) = clamp_to_virtual(moved_x, moved_y);
                let _ = window.set_position(tauri::Position::Physical(PhysicalPosition::new(x, y)));
            }
        }
        "pin-drag-end" => {
            PIN_DRAGS.lock().unwrap().remove(window.label());
        }
        "capture-save" => {
            let data_url = a0.get("dataURL").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let filename = a0.get("filename").and_then(|v| v.as_str()).map(|s| s.to_string());
            let app2 = app.clone();
            let cap_win = app.get_webview_window("capture");
            if let Some(w) = cap_win {
                stop_session(&w, "capture-save");
            }
            tauri::async_runtime::spawn(async move {
                if let Some(b64) = data_url.split(',').nth(1) {
                    if let Some(bytes) = base64_decode(b64) {
                        let default_name = format!("{}.png", filename.unwrap_or_else(|| format!("petalsnap_{}", now_ms())));
                        let pics = std::env::var("USERPROFILE")
                            .map(|u| PathBuf::from(u).join("Pictures"))
                            .unwrap_or_else(|_| std::env::temp_dir());
                        use tauri_plugin_dialog::DialogExt;
                        let file = app2
                            .dialog()
                            .file()
                            .add_filter("PNG", &["png"])
                            .set_file_name(default_name)
                            .set_directory(pics)
                            .blocking_save_file();
                        if let Some(p) = file {
                            let path = p.into_path().unwrap_or_else(|_| std::env::temp_dir().join("petalsnap_save.png"));
                            if std::fs::write(&path, &bytes).is_ok() {
                                logln(&format!("[save] {}", path.display()));
                            }
                        }
                    }
                }
            });
        }
        _ => {
            logln(&format!("[ipc] send 未实现: {}", ch));
        }
    }
}

#[tauri::command]
fn js_log(msg: String) {
    logln(&format!("[js] {}", msg));
}

/// shim 的 window.close() → 关闭调用者自己的窗口（pin 的 Esc/关闭按钮）
#[tauri::command]
fn win_close_self(window: tauri::WebviewWindow) {
    let label = window.label().to_string();
    logln(&format!("[pin] {} closed", label));
    let _ = window.close();
    PIN_LABELS.lock().unwrap().retain(|l| l != &label);
    PIN_DRAGS.lock().unwrap().remove(&label);
}

#[tauri::command]
fn get_frame_raw() -> tauri::ipc::Response {
    let t0 = Instant::now();
    // 取走而非克隆：29.5MB 的 clone 是一次纯 memcpy（~10-15ms），帧只有一次消费者
    let frame = { let mut g = LAST_FRAME.lock().unwrap(); g.take() };
    match frame {
        Some((_w, _h, bgra)) => {
            // 29.5MB 原始帧走这里；打点用来看清"帧传输"到底吃掉了多少毫秒
            logln(&format!(
                "[frame] get_frame_raw serving {} bytes (take {}ms)",
                bgra.len(),
                t0.elapsed().as_millis()
            ));
            tauri::ipc::Response::new(bgra)
        }
        None => {
            logln("[frame] get_frame_raw: no frame");
            tauri::ipc::Response::new(Vec::new())
        }
    }
}

/// 渲染端上报 WebView2 的 devicePixelRatio（= 窗口实际渲染用的单一 dpr）。
/// 只用于**校验**主屏 DPI 这个权威来源是否成立——不等就报警（换算仍用主屏 DPI，
/// 以与 Electron 侧 `getPrimaryDisplay().scaleFactor` 保持两版同源）。
#[tauri::command]
fn set_webview_dpr(dpr: f64) {
    if !(0.2..8.0).contains(&dpr) {
        return;
    }
    let mut g = WEBVIEW_DPR.lock().unwrap();
    if g.map(|v| (v - dpr).abs() > 0.001).unwrap_or(true) {
        logln(&format!("[dpr] webview reported devicePixelRatio = {:.3}", dpr));
        *g = Some(dpr);
    }
}

#[tauri::command]
async fn clip_write_text(app: AppHandle, text: String, html: Option<String>) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let _ = app.clipboard().write_text(text);
    // HTML 富文本（表格复制用）：通过 Win32 剪贴板 CF_HTML —— 插件不支持时降级纯文本
    if let Some(h) = html {
        unsafe { set_clipboard_html(&h); }
    }
    Ok(())
}

unsafe fn set_clipboard_html(_html: &str) {
    // phase 1 简化：CF_HTML 未接（表格粘贴为纯文本），后续专项补
}

#[tauri::command]
async fn clip_write_image(app: AppHandle, png_b64: String) -> Result<(), String> {
    let Some((rgba, w, h)) = png_b64_to_rgba(&png_b64) else {
        return Err("bad-png".into());
    };
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_image(&tauri::image::Image::new_owned(rgba, w, h))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    let _ = open::that(&url);
    Ok(())
}
