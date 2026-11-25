// PetalSnap Tauri/WebView2 spike —— capture.js 整体移植版
// 界面 = F1 的 capture.html/css/js 一字不改 + shim.js（Electron IPC 垫片）。
// Rust 侧 = 会话流（对齐 Electron captureWindow 时序）+ 通道后端（smart 三件套直调
// smart_uia.dll、OCR/翻译代理 18766、其余优雅 stub）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod longshot;

use std::ffi::c_void;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
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
pub(crate) unsafe fn primary_scale_factor() -> f64 {
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
//
// ⚠️ 2026-11-02「整机崩溃」事故的根治点（详见 docs/功能状态清单.md）：
//   侧车 python 会拉起 llama-server.exe（Hy-MT2 翻译模型，~1.2GB 显存/个）。
//   过去宿主被杀时只 kill python 一个进程 —— 但 Windows 上 TerminateProcess
//   **不跑 python 的 atexit** → mt_engine.shutdown() 不执行 → 它拉起的 llama-server
//   变孤儿继续占显存 → 攒到 6~7 个（RTX 4070 Laptop 只有 8GB）就打满 →
//   CUDA 分配失败降级共享内存 → 系统内存雪崩 → 整机崩溃。
//   旁证：本机 wmic.exe 已被 Win11 移除，仓库外那份 rapidocr_service.py 的
//   孤儿清理（wmic process where ...）走 except 分支**静默跳过** → 从未生效过。
//
//   对策两道：
//   ① Job Object + JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
//      侧车进 Job → 宿主进程一消失（**哪怕被 TerminateProcess 强杀**）→ OS 连树陪葬。
//      这是 Windows 上唯一能对抗「宿主被强杀」的手段（atexit 靠不住）。
//   ② 拉起前扫一遍「父进程已死」的残骸（_sweep_orphans.ps1），兜住历史遗留。
static PY_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);
static PY_SPAWNING: Mutex<bool> = Mutex::new(false);
/// 侧车所属 Job Object 句柄（HANDLE 是裸指针、不是 Send，按既有惯例以 usize 存）。
static PY_JOB: Mutex<Option<usize>> = Mutex::new(None);

/// Job Object 的 Win32 ABI（手写 extern）。
///
/// 为什么不用 windows crate 的 `Win32_System_JobObjects`：
///   依赖树里存在**两份 windows_core**（0.58 与 0.62）。`PCWSTR` 在 0.58 是
///   `*const u16` 别名、在 0.62 是结构体 → `CreateJobObjectW<P0: Param<PCWSTR>>`
///   的泛型参数推不出类型（E0271/E0277：expected CopyType, found InterfaceType）。
///   这里直接声明 kernel32 ABI，结构体按 Win32 头文件的字段顺序手写，避开整���机制。
mod jobobj {
    use std::ffi::c_void;

    /// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE（winnt.h）
    pub const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    /// JobObjectExtendedLimitInformation（JOBOBJECTINFOCLASS）
    pub const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    pub const PROCESS_TERMINATE: u32 = 0x0001;
    pub const PROCESS_SET_QUOTA: u32 = 0x0100;

    /// JOBOBJECT_BASIC_LIMIT_INFORMATION（winnt.h）
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        pub per_process_user_time_limit: i64,
        pub per_job_user_time_limit: i64,
        pub limit_flags: u32,
        pub _pad0: u32,
        pub minimum_working_set_size: usize,
        pub maximum_working_set_size: usize,
        pub active_process_limit: u32,
        pub _pad1: u32,
        pub affinity: usize,
        pub priority_class: u32,
        pub scheduling_class: u32,
    }

    /// IO_COUNTERS（winnt.h）
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct IO_COUNTERS {
        pub read_operation_count: u64,
        pub write_operation_count: u64,
        pub other_operation_count: u64,
        pub read_transfer_count: u64,
        pub write_transfer_count: u64,
        pub other_transfer_count: u64,
    }

    /// JOBOBJECT_EXTENDED_LIMIT_INFORMATION（winnt.h）
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        pub basic_limit_information: JOBOBJECT_BASIC_LIMIT_INFORMATION,
        pub io_info: IO_COUNTERS,
        pub process_memory_limit: usize,
        pub job_memory_limit: usize,
        pub peak_process_memory_used: usize,
        pub peak_job_memory_used: usize,
    }

    impl JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        pub fn zeroed() -> Self {
            // SAFETY: 全零是合法初值（LimitFlags=0 表示不设任何限制）。
            unsafe { std::mem::zeroed() }
        }
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateJobObjectW(lp_job_attributes: *mut c_void, lp_name: *const u16) -> *mut c_void;
        pub fn SetInformationJobObject(
            h_job: *mut c_void,
            job_object_information_class: i32,
            lp_job_object_information: *const c_void,
            cb_job_object_information_length: u32,
        ) -> i32;
        pub fn AssignProcessToJobObject(h_job: *mut c_void, h_process: *mut c_void) -> i32;
        pub fn TerminateJobObject(h_job: *mut c_void, u_exit_code: u32) -> i32;
        pub fn OpenProcess(dw_desired_access: u32, b_inherit_handle: i32, dw_process_id: u32) -> *mut c_void;
        pub fn CloseHandle(h_object: *mut c_void) -> i32;
    }
}

/// 创建「宿主一死就整树陪葬」的 Job Object。None = 不支持（退化成只杀 python 本体）。
///
/// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：Job 句柄关闭（宿主进程消失，**包括被
/// TerminateProcess 强杀**）→ OS 连带杀掉 Job 内所有进程。这是唯一能对抗
/// 「宿主被强杀」的手段 —— python 的 atexit 在强杀时根本不跑。
fn create_kill_on_close_job() -> Option<usize> {
    use jobobj::*;
    unsafe {
        // lpname = NULL → 匿名 Job（不给名字，避免与别的进程撞名后互相干扰）。
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            logln(&format!(
                "[py] CreateJobObjectW 失败（将退化为只杀 python 本体）: err={}",
                std::io::Error::last_os_error()
            ));
            return None;
        }
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::zeroed();
        info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        if SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            &info as *const _ as *const c_void,
            size,
        ) == 0
        {
            let _ = CloseHandle(job);
            logln(&format!(
                "[py] SetInformationJobObject 失败（将退化为只杀 python 本体）: err={}",
                std::io::Error::last_os_error()
            ));
            return None;
        }
        Some(job as usize)
    }
}

/// 把 pid 的进程塞进 job —— 连同它**之后**拉起的所有子孙（llama-server）都在内。
///
/// 竞态说明：python 进程创建后到本调用之间理论上可能已经 fork 出 llama-server，
/// 但那要求 python 在几毫秒内完成解释器启动 + 导入 + 拉起推理引擎，实际不可能
/// （侧车加载模型要好几秒）。真要彻底消除得用 CREATE_SUSPENDED + 恢复主线程，
/// 代价是 std::process::Child 不暴露主线程句柄，不值得。
fn assign_to_job(job: usize, pid: u32) -> bool {
    use jobobj::*;
    unsafe {
        let h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if h.is_null() {
            logln(&format!("[py] OpenProcess({}) 失败: {}", pid, std::io::Error::last_os_error()));
            return false;
        }
        let r = AssignProcessToJobObject(job as *mut c_void, h);
        let _ = CloseHandle(h);
        if r == 0 {
            logln(&format!("[py] AssignProcessToJobObject({}) 失败: {}", pid, std::io::Error::last_os_error()));
            return false;
        }
        true
    }
}

/// 杀掉 Job 里的整棵树（python + 它拉起的 llama-server）。返回是否成功。
fn terminate_job(job: usize) -> bool {
    use jobobj::*;
    unsafe { TerminateJobObject(job as *mut c_void, 1) != 0 }
}

/// 关闭 Job 句柄（KILL_ON_JOB_CLOSE 时会顺带把整棵树带走）。
fn close_job(job: usize) {
    use jobobj::*;
    unsafe {
        let _ = CloseHandle(job as *mut c_void);
    }
}

/// 兜底连树杀：taskkill /PID <pid> /T /F（Job 不可用时的第二道保险）。
fn kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output();
}

/// 清扫「父进程已死」的侧车 / llama-server 孤儿（历史残骸兜底）。
///
/// 脚本是仓库里的唯一事实源（tools/_sweep_orphans.ps1），**编译期内嵌**进本二进制，
/// 运行时落到 %TEMP% 再执行 —— 不依赖运行目录布局，部署到任何位置都能用。
/// 判据见脚本头注释：父进程已不存在 = 孤儿；用户手动起的实例父进程存活 → 不动。
fn sweep_orphan_sidecars() {
    use std::os::windows::process::CommandExt;
    const SCRIPT: &str = include_str!("../../../tools/_sweep_orphans.ps1");
    let tmp = std::env::temp_dir().join("petalsnap-sweep-orphans.ps1");
    // ⚠️ 双 BOM 会让 PowerShell 解析出错：仓库里的脚本文件**已经自带** UTF-8 BOM
    //    （include_str! 会把 BOM 当成 U+FEFF 字符读进来），这里再补一个就成了双 BOM。
    //    所以先剥掉脚本自带的 BOM，再补**恰好一个** BOM。
    let body = SCRIPT.strip_prefix('\u{feff}').unwrap_or(SCRIPT);
    // 带 BOM 写：Windows PowerShell 5.1 读**无 BOM** 的 .ps1 会按 ANSI 解码 → 中文注释
    // 解码错乱 → 脚本解析异常 → taskkill 根本没执行（实测 killed=0、进程还活着）。
    if let Err(e) = std::fs::write(&tmp, format!("\u{feff}{}", body)) {
        logln(&format!("[py] 孤儿清扫脚本写入失败（跳过）: {}", e));
        return;
    }
    // 优先 pwsh 7（UTF-8 友好）；没装就退回 Windows PowerShell 5.1（脚本已带 BOM，5.1 也能跑）。
    let mut last_err = String::new();
    for shell in ["pwsh.exe", "powershell.exe"] {
        let out = std::process::Command::new(shell)
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&tmp)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output();
        match out {
            Ok(o) => {
                let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
                let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                if !text.is_empty() {
                    logln(&format!("[py] {}", text));
                } else if !err.is_empty() {
                    logln(&format!("[py] 孤儿清扫无输出，stderr: {}", err));
                } else {
                    logln("[py] 孤儿清扫无输出");
                }
                return;
            }
            Err(e) => last_err = format!("{}: {}", shell, e),
        }
    }
    logln(&format!("[py] 孤儿清扫执行失败: {}", last_err));
}

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

/// 18766 端口有没有人在监听。
///
/// 为什么要单独判：/health 探测的超时只有 400ms，侧车正忙（加载模型 / 处理请求）时
/// 会**误判为不健康** → 于是再拉一个侧车 → 第二个侧车又拉一个 llama-server
/// （~1.2GB 显存）→ 8GB 卡上很容易堆出好几个。端口在监听 = 已经有实例了，
/// 绝不能再拉。
fn py_port_listening() -> bool {
    port_listening(18766)
}

/// 某个 TCP 端口有没有人在监听（连接能建立即有人在 listen）。
fn port_listening(port: u16) -> bool {
    use std::net::SocketAddr;
    use std::net::TcpStream;
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

async fn ensure_py_service() -> bool {
    if py_health_ok().await {
        return true; // F1 或此前自拉的实例在跑 → 直接复用
    }
    // 先清扫「父进程已死」的残骸：上次崩溃 / 被强杀留下的侧车 + 它拉起的 llama-server。
    // 不清的话，它们占着显存，且会让下面的「端口有人监听」判断误以为实例健康。
    sweep_orphan_sidecars();
    if py_health_ok().await {
        return true;
    }
    // 端口有人监听但 /health 不通（侧车正忙：加载模型 / 处理请求）→ **绝不能再拉一个**：
    // 第二个侧车会再拉一个 llama-server（~1.2GB 显存），8GB 卡上极易堆爆。
    if py_port_listening() {
        logln("[py] 18766 已被占用但不健康 → 等待现有实例，不重复拉起");
        for _ in 0..75 {
            std::thread::sleep(Duration::from_millis(400));
            if py_health_ok().await {
                logln("[py] 现有侧车恢复健康");
                return true;
            }
        }
        logln("[py] 等待 18766 现有实例超时（不重复拉起）");
        return false;
    }
    {
        let mut spawning = PY_SPAWNING.lock().unwrap();
        if *spawning {
            return false; // 另一线程正在拉起
        }
        *spawning = true;
    }
    let spawned = spawn_py_sidecar();
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

/// 拉起 python 侧车，并把它塞进「宿主一死就整树陪葬」的 Job Object。
///
/// 这是**生产路径**：单元测试直接调它，验证侧车确实被收进了 Job
/// （如果哪天 assign 失败 → 侧车会重新变孤儿 → 显存被吃光 → 整机崩溃）。
fn spawn_py_sidecar() -> bool {
    use std::os::windows::process::CommandExt;
    let (Some(python), Some(script)) = (resolve_python(), resolve_ocr_script()) else {
        logln("[py] 找不到 python 解释器或 rapidocr_service.py（识别功能不可用）");
        logln("[py] 用 PETALSNAP_PYTHON / PETALSNAP_RAPIDOCR_SCRIPT 指定路径");
        return false;
    };
    match std::process::Command::new(python)
        .arg(script)
        // 侧车的「父进程死亡守护」要盯**宿主应用**的 PID。
        // ⚠️ 不能让侧车自己用 os.getppid()：本机 venv 的 Scripts\python.exe 是**转发器**
        //（它自己再拉起一个真正的解释器进程），侧车的直接父进程是那个转发器而不是本应用
        // → 宿主被强杀时转发器还活着（它在等侧车退出）→ 盯 getppid() 永远触发不了。
        .env("PETALSNAP_OWNER_PID", std::process::id().to_string())
        // 自定义资产目录（2026-11-22：表格/版面模型落盘位置；设置 → 识别 → 识别资源 → 存放位置）
        .envs(
            store_load()
                .get("screenshot-assets-dir")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|d| ("PETALSNAP_ASSETS_DIR", d.to_string())),
        )
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn()
    {
        Ok(c) => {
            let pid = c.id();
            // 塞进 kill-on-close Job：宿主被强杀（任务管理器结束任务 / 崩溃 / 探针
            // Stop-Process -Force）时，OS 会连 python 与它拉起的 llama-server 一起
            // 陪葬 —— 这正是 2026-11-02 整机崩溃事故缺的那一环。
            let mut in_job = false;
            if let Some(job) = create_kill_on_close_job() {
                if assign_to_job(job, pid) {
                    *PY_JOB.lock().unwrap() = Some(job);
                    in_job = true;
                } else {
                    close_job(job);
                }
            }
            *PY_CHILD.lock().unwrap() = Some(c);
            logln(&format!("[py] sidecar spawned (18766) pid={} killOnCloseJob={}", pid, in_job));
            true
        }
        Err(e) => {
            logln(&format!("[py] spawn failed: {}", e));
            false
        }
    }
}

/// 回收侧车：**连同它拉起的 llama-server 一起**。
///
/// 过去这里只 `c.kill()` 杀 python 一个进程 —— Windows 上 TerminateProcess 不跑
/// atexit → mt_engine.shutdown() 不执行 → llama-server 变孤儿（~1.2GB 显存/个）
/// → 多次启动后显存打满 → CUDA 降级 → 内存雪崩 → 整机崩溃（2026-11-02 事故）。
/// 现在：① 先 TerminateJobObject 杀整棵树（最可靠）；② 兜底 taskkill /T /F。
fn kill_py_service() {
    let mut tree_killed = false;
    if let Some(job) = PY_JOB.lock().unwrap().take() {
        tree_killed = terminate_job(job);
        close_job(job);
        logln(&format!("[py] sidecar job terminated (python + llama-server) ok={}", tree_killed));
    }
    let mut guard = PY_CHILD.lock().unwrap();
    if let Some(mut c) = guard.take() {
        let pid = c.id();
        if !tree_killed {
            let _ = c.kill();
            let _ = c.wait();
            kill_process_tree(pid);
        }
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
        "screenshot-hotkey" => json!("Alt+Q"),
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
    // OCR 预热（2026-11-21 三档消费，对齐 F1 app/main.ts）：capture-prewarm=会话触发时
    // 预热（识别按钮按下去时服务已就绪）；resident=启动常驻（setup 里拉）；on-demand=识别时才拉
    if read_ocr_warmup_mode() == "capture-prewarm" {
        prewarm_ocr();
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
    // 长截图兜底：渲染端漏发 capture-ls-active off 时，滚轮定时器/Enter·Esc 热键/窗口透传
    // 都不能留在系统里（F1 的 will-quit + active off 双保险同款）
    longshot::on_session_end(win.app_handle());
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
/// 带 per-request 超时：translate_image 首调含 llama 冷启动（F1 用 300s），
/// 60s 统一超时会把冷启动误判成失败 —— F2 原实现的坑之一。
async fn proxy_18766_with(path: &str, body: Value, timeout: Duration) -> Value {
    let client = reqwest::Client::builder()
        .timeout(timeout)
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

/// 二进制通道代理（2026-09-28 服务端原生支持：Content-Type=octet-stream 时 body 即
/// PNG 字节，免 base64 三程浪费）
async fn proxy_18766_bytes(path: &str, png: &[u8], timeout: Duration) -> Value {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .unwrap();
    match client
        .post(format!("http://127.0.0.1:18766{}", path))
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(png.to_vec())
        .send()
        .await
    {
        Ok(r) => r.json::<Value>().await.unwrap_or(json!({ "success": false, "code": "badJson" })),
        Err(e) => json!({ "success": false, "code": "serviceDown", "msg": e.to_string() }),
    }
}

// ── P1 借鉴（2026-11-19，源自功能状态清单 §3.11 竞品调研：青蛙截图OCR + 天若OCR6）──
// ① Windows.Media.Ocr 兜底识别（青蛙主引擎实锤）：18766 侧车不可用/报错时在宿主进程内
//    走 WinRT 系统 OCR（离线、零模型、零 GPU；依赖系统「中文 OCR 语言包」）。
//    兜底必须住在服务**外**——服务内部的兜底救不了「服务本身死了」。
// ② Edge 免 key 翻译降级（青蛙实锤端点）：本地 llama 不可用/失败时走
//    edge.microsoft.com/translate/auth 换 token → api-edge.cognitive.microsofttranslator.com，
//    token 缓存 8 分钟、401 自动刷新重试一次。翻译降级 = wmocr 文本 + Edge，
//    面板纯文本模式呈现（translatedImage 留空，渲染端已支持该路径）。
// ③ 问 AI 移植 + 模板（天若 OCRModes.json 思路）：选区图 + 模板提示词 → 用户自配置
//    OpenAI 兼容接口。凭据只读继承 F1 store（%APPDATA%\petalsnap\eIsland_store，
//    = 迁移方案 §4.3 store 互通方向）；模板清单在 resources/ask-ai-modes.json（可编辑）。
//    响应映射与 F1 rapidOcrService.ts / askAiService.ts 逐字段对齐。

use base64::Engine as _;

/// dataURL → PNG 字节（仅 data:image/*；解析失败返回 None 走相应兜底报错）
fn data_url_png(data_url: &str) -> Option<Vec<u8>> {
    let rest = data_url.strip_prefix("data:image/")?;
    let b64 = rest.split_once(',')?.1.trim();
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .ok()
        .or_else(|| base64::engine::general_purpose::STANDARD_NO_PAD.decode(b64).ok())
}

/// 渲染端语言代码 → 18766 翻译目标语中文全称（对齐 F1 localOcrMtService LANG_CODE_TO_NAME）
fn to_target_name(code: &str) -> &'static str {
    match code {
        "en" => "英语", "ja" => "日语", "ko" => "韩语", "fr" => "法语",
        "de" => "德语", "es" => "西班牙语", "ru" => "俄语",
        _ => "中文",
    }
}

/// 渲染端语言代码 → Edge 翻译 to= 代码
fn edge_to_code(code: &str) -> &'static str {
    match code {
        "en" => "en", "ja" => "ja", "ko" => "ko", "fr" => "fr",
        "de" => "de", "es" => "es", "ru" => "ru",
        _ => "zh-Hans",
    }
}

/// spawn_blocking 线程的 COM/MTA 初始化：WinRT 激活（RoGetActivationFactory）要求线程
/// 至少是 MTA；tokio 工作线程不保证。CoIncrementMTAUsage 与任何已有 apartment 不冲突。
fn mta_thread_init() {
    use windows::Win32::System::Com::CoIncrementMTAUsage;
    unsafe {
        let _ = CoIncrementMTAUsage();
    }
}

/// CJK 判定（表意文字 + CJK 标点 + 全角形式）：wmocr 空格除噪用
fn is_cjk_char(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}'   // CJK 统一表意文字
        | '\u{3400}'..='\u{4DBF}' // 扩展 A
        | '\u{3000}'..='\u{303F}' // CJK 标点（，。、「」…）
        | '\u{FF00}'..='\u{FFEF}' // 全角形式
    )
}

/// Windows OCR 对 CJK 逐字分词，行文本是「深 度 学 习 …」——把**两侧都是 CJK** 的
/// 单个空格合并掉（中英文边界空格保留）。青蛙的灰度双通道同理是在治这类输出质量。
fn collapse_cjk_spaces(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == ' '
            && i > 0
            && i + 1 < chars.len()
            && is_cjk_char(chars[i - 1])
            && is_cjk_char(chars[i + 1])
        {
            continue;
        }
        out.push(c);
    }
    out
}

/// WinRT 系统 OCR 一张 PNG：返回 (行文本, 行box[x1,y1,x2,y2]（图内像素）) 列表。
/// 引擎语言：优先 zh-Hans-CN（主用户场景），失败退用户配置语言，再失败如实报错
/// （报错文案引导去装 OCR 语言包 —— 青蛙 FAQ 同款场景）。
fn wmocr_png(png: &[u8]) -> Result<Vec<(String, [f64; 4])>, String> {
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    mta_thread_init();
    let stream = InMemoryRandomAccessStream::new().map_err(|e| format!("内存流创建失败: {e}"))?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(|e| format!("DataWriter 创建失败: {e}"))?;
    writer.WriteBytes(png).map_err(|e| format!("写入图像失败: {e}"))?;
    writer.StoreAsync().map_err(|e| format!("图像提交失败: {e}"))?.get().map_err(|e| format!("图像提交等待失败: {e}"))?;
    let _detached = writer.DetachStream().map_err(|e| format!("流分离失败: {e}"))?;
    drop(writer);

    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| format!("解码器创建失败: {e}"))?
        .get()
        .map_err(|e| format!("解码器等待失败: {e}"))?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| format!("位图解码失败: {e}"))?
        .get()
        .map_err(|e| format!("位图解码等待失败: {e}"))?;

    let engine = match Language::CreateLanguage(&windows::core::HSTRING::from("zh-Hans-CN")) {
        Ok(lang) => OcrEngine::TryCreateFromLanguage(&lang)
            .ok()
            .or_else(|| OcrEngine::TryCreateFromUserProfileLanguages().ok()),
        Err(_) => None,
    };
    let engine = match engine {
        Some(e) => e,
        None => OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|_| "系统未安装 OCR 语言包（设置 → 时间和语言 → 语言 → 光学字符识别）".to_string())?,
    };

    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("识别启动失败: {e}"))?
        .get()
        .map_err(|e| format!("识别等待失败: {e}"))?;

    let mut out = Vec::new();
    for line in result.Lines().map_err(|e| format!("读取行失败: {e}"))? {
        let text = collapse_cjk_spaces(
            line.Text().map_err(|e| format!("读取行文本失败: {e}"))?.to_string().as_str(),
        );
        let mut box4: Option<[f64; 4]> = None;
        for word in line.Words().map_err(|e| format!("读取词失败: {e}"))? {
            let r = word.BoundingRect().map_err(|e| format!("读取词矩形失败: {e}"))?;
            let (x2, y2) = (r.X + r.Width, r.Y + r.Height);
            box4 = Some(match box4 {
                None => [r.X as f64, r.Y as f64, x2 as f64, y2 as f64],
                Some(b) => [
                    b[0].min(r.X as f64), b[1].min(r.Y as f64),
                    b[2].max(x2 as f64), b[3].max(y2 as f64),
                ],
            });
        }
        out.push((text, box4.unwrap_or([0.0, 0.0, 0.0, 0.0])));
    }
    Ok(out)
}

// ── 兜底①a：微信 OCR（MaaXYZ/WeChatOCR-SDK v0.2.1，AGPLv3 本地部署）────────────
// ⚠️ 2026-11-20 网络调研推翻了"微信 4.x 不可行"的初判：微信 4.x 的 OCR 虽是进程内插件
// （XPlugin 的 wxocr.dll），但 MaaXYZ 的 SDK 已把 wxocr.dll+runtime 的调用链封装成 C ABI
// （worker 进程 + mojo 通信），自动发现本机微信（注册表/安装目录/用户 OCR 插件目录），
// 不下载不重分发任何腾讯文件。SDK 二进制在**仓库外** `OCR/wxocr-sdk/bin/`（AGPLv3 传染，
// 不得入 git / 不得随应用分发，见该目录 README），运行时逐级查找 + PETALSNAP_WXOCR_SDK 覆盖。
// 本机实测（微信 4.2.0.13 + 插件 8096）：protocol=4，官方 smoke 3/3 通过，热调用 p50 ≈ 211ms。
// 兜底顺序：18766 挂 → **wxocr（微信，中文质量高）→ wmocr（WinRT 系统 OCR）**。

use std::ffi::CString;
use std::os::raw::c_char;

const WCO_ABI_VERSION: u32 = 1;
const WCO_PIXEL_BGRA: u32 = 2;

#[repr(C)]
struct WcoOptions {
    struct_size: u32,
    abi_version: u32,
    runtime_dir: *const c_char,
    ocr_path: *const c_char,
    worker_path: *const c_char,
    temp_dir: *const c_char,
    protocol: u32,
    startup_timeout_ms: u32,
    max_pending_requests: u32,
}

#[repr(C)]
struct WcoDiscoveryOptions {
    struct_size: u32,
    flags: u32,
    search_roots: *const *const c_char,
    search_root_count: u32,
}

#[repr(C)]
struct WcoRuntimeInfo {
    struct_size: u32,
    protocol: u32,
    runtime_dir: *const c_char,
    ocr_path: *const c_char,
    version: *const c_char,
    source: *const c_char,
}

#[repr(C)]
struct WcoImageView {
    struct_size: u32,
    format: u32,
    data: *const u8,
    data_size: u64,
    width: u32,
    height: u32,
    stride: u64,
}

#[repr(C)]
struct WcoLine {
    struct_size: u32,
    has_confidence: u32,
    quad: [f32; 8], // 顺时针四角：TL,TR,BR,BL
    confidence: f32,
    text: *const c_char,
    text_length: u64,
}

/// SDK 句柄库 + 引擎（Mutex 串行化；wco_recognize 本身线程安全，低频兜底无需并发）
struct WxocrState {
    lib: Option<libloading::Library>,
    engine: *mut std::ffi::c_void,
    worker_path: Option<CString>,
}
unsafe impl Send for WxocrState {}

static WXOCR_STATE: Mutex<Option<WxocrState>> = Mutex::new(None);

/// SDK 目录解析：环境变量 PETALSNAP_WXOCR_SDK（指 bin 目录）→ 从 exe 逐级向上找
/// `wxocr-sdk/bin/WeChatOCR.dll`（本地部署在 OCR 工作区根，不在 git 仓库内）。
fn resolve_wxocr_sdk_dir() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("PETALSNAP_WXOCR_SDK") {
        let p = PathBuf::from(&v);
        if p.join("WeChatOCR.dll").exists() {
            return Some(p);
        }
        logln(&format!("[wxocr] env PETALSNAP_WXOCR_SDK 指向的目录缺 WeChatOCR.dll: {}", p.display()));
    }
    resolve_resource("", "wxocr-sdk/bin/WeChatOCR.dll").map(|p| {
        p.parent()
            .map(|d| d.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
    })
}

fn wxocr_last_error(lib: &libloading::Library) -> String {
    let sym = unsafe { lib.get::<unsafe extern "system" fn() -> *const c_char>(b"wco_last_error\0") };
    if let Ok(f) = sym {
        let p = unsafe { f() };
        if !p.is_null() {
            return unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned();
        }
    }
    String::new()
}

/// 懒加载 SDK + 创建引擎（对齐官方 smoke：wco_create_auto + 默认 discovery；worker 显式指向 bin/）
fn wxocr_ensure(state: &mut WxocrState) -> Result<(), String> {
    if state.engine.is_null() {
        let dir = resolve_wxocr_sdk_dir().ok_or_else(|| {
            "未找到 wxocr-sdk（本地部署 OCR/wxocr-sdk/bin/，或设 PETALSNAP_WXOCR_SDK）".to_string()
        })?;
        let dll = dir.join("WeChatOCR.dll");
        let lib = unsafe { libloading::Library::new(&dll) }.map_err(|e| format!("加载 {} 失败: {e}", dll.display()))?;
        type WcoCreateAutoFn = unsafe extern "system" fn(
            *const WcoOptions,
            *const WcoDiscoveryOptions,
            *mut *mut std::ffi::c_void,
        ) -> i32;
        let create_auto: WcoCreateAutoFn = unsafe {
            *lib.get(b"wco_create_auto\0").map_err(|e| format!("缺符号 wco_create_auto: {e}"))?
        };
        let options_init: unsafe extern "system" fn(*mut WcoOptions) = unsafe {
            *lib.get(b"wco_options_init\0").map_err(|e| format!("缺符号 wco_options_init: {e}"))?
        };
        let discovery_init: unsafe extern "system" fn(*mut WcoDiscoveryOptions) = unsafe {
            *lib.get(b"wco_discovery_options_init\0").map_err(|e| format!("缺符号 wco_discovery_options_init: {e}"))?
        };
        let worker = dir.join("wechatocr-worker.exe");
        let worker_c = if worker.exists() {
            Some(CString::new(worker.to_string_lossy().into_owned()).map_err(|_| "worker 路径含 NUL".to_string())?)
        } else {
            None
        };
        let mut opts = WcoOptions {
            struct_size: std::mem::size_of::<WcoOptions>() as u32,
            abi_version: WCO_ABI_VERSION,
            runtime_dir: std::ptr::null(),
            ocr_path: std::ptr::null(),
            worker_path: worker_c.as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null()),
            temp_dir: std::ptr::null(),
            protocol: 0, // 自动（3.x / 4.x 都认）
            startup_timeout_ms: 10000,
            max_pending_requests: 0,
        };
        unsafe { options_init(&mut opts) }; // SDK 兜底默认值
        let mut discovery = WcoDiscoveryOptions {
            struct_size: std::mem::size_of::<WcoDiscoveryOptions>() as u32,
            flags: 0,
            search_roots: std::ptr::null(),
            search_root_count: 0,
        };
        unsafe { discovery_init(&mut discovery) };
        let mut engine: *mut std::ffi::c_void = std::ptr::null_mut();
        let status = unsafe { create_auto(&opts, &discovery, &mut engine) };
        if status != 0 || engine.is_null() {
            let err = wxocr_last_error(&lib);
            return Err(format!("wco_create_auto 失败 status={status}: {err}"));
        }
        // 诊断：创建后立刻查 runtime（引擎无效时这里就会暴露）
        let get_rt: unsafe extern "system" fn(*mut std::ffi::c_void, *mut WcoRuntimeInfo) -> i32 = unsafe {
            *lib.get(b"wco_engine_get_runtime\0").map_err(|e| format!("缺符号 wco_engine_get_runtime: {e}"))?
        };
        let mut rt = WcoRuntimeInfo {
            struct_size: std::mem::size_of::<WcoRuntimeInfo>() as u32,
            protocol: 0,
            runtime_dir: std::ptr::null(),
            ocr_path: std::ptr::null(),
            version: std::ptr::null(),
            source: std::ptr::null(),
        };
        let rt_status = unsafe { get_rt(engine, &mut rt) };
        let ocr_path_str = if rt.ocr_path.is_null() {
            "(null)".to_string()
        } else {
            unsafe { std::ffi::CStr::from_ptr(rt.ocr_path) }.to_string_lossy().into_owned()
        };
        logln(&format!(
            "[wxocr] engine ready status={rt_status} protocol={} ocr={ocr_path_str}",
            rt.protocol,
        ));
        state.lib = Some(lib);
        state.worker_path = worker_c;
        state.engine = engine;
    }
    Ok(())
}

/// 微信 OCR 一张 PNG：返回 (行文本(已做 CJK 空格除噪), 行 bbox[x1,y1,x2,y2]（图内像素）) 列表
fn wxocr_png(png: &[u8]) -> Result<Vec<(String, [f64; 4])>, String> {
    mta_thread_init();
    // 解 PNG → BGRA（SDK 接受内存图像，免落盘）
    let img = image::load_from_memory(png).map_err(|e| format!("PNG 解码失败: {e}"))?;
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    let mut bgra = rgba.into_raw();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }

    let mut guard = WXOCR_STATE
        .lock()
        .map_err(|_| "wxocr 状态锁中毒".to_string())?;
    let state = guard.get_or_insert(WxocrState {
        lib: None,
        engine: std::ptr::null_mut(),
        worker_path: None,
    });
    wxocr_ensure(state)?;
    let lib = state.lib.as_ref().ok_or("SDK 未加载")?;

    let recognize: unsafe extern "system" fn(*mut std::ffi::c_void, *const WcoImageView, u32, *mut *mut std::ffi::c_void) -> i32 =
        unsafe { *lib.get(b"wco_recognize\0").map_err(|e| format!("缺符号 wco_recognize: {e}"))? };
    let line_count: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32 =
        unsafe { *lib.get(b"wco_result_line_count\0").map_err(|e| format!("缺符号 wco_result_line_count: {e}"))? };
    let get_line: unsafe extern "system" fn(*mut std::ffi::c_void, u32, *mut WcoLine) -> i32 =
        unsafe { *lib.get(b"wco_result_get_line\0").map_err(|e| format!("缺符号 wco_result_get_line: {e}"))? };
    let result_destroy: unsafe extern "system" fn(*mut std::ffi::c_void) =
        unsafe { *lib.get(b"wco_result_destroy\0").map_err(|e| format!("缺符号 wco_result_destroy: {e}"))? };

    // ⚠️ view 必须走官方 wco_image_view_init 填充（它会写入 C 侧真实 struct_size；
    //    手填的 Rust sizeof 若小于 C sizeof（保留字段），recognize 会报 invalid image）
    let iv_init: unsafe extern "system" fn(*mut WcoImageView, u32, *const u8, u64, u32, u32, u64) -> i32 =
        unsafe { *lib.get(b"wco_image_view_init\0").map_err(|e| format!("缺符号 wco_image_view_init: {e}"))? };
    let mut view: WcoImageView = unsafe { std::mem::zeroed() };
    let iv_status = unsafe {
        iv_init(&mut view, WCO_PIXEL_BGRA, bgra.as_ptr(), bgra.len() as u64, w, h, 0) // stride 0 = 紧密排列
    };
    if iv_status != 0 {
        return Err(format!("wco_image_view_init 失败 status={iv_status}: {}", wxocr_last_error(lib)));
    }
    let mut result: *mut std::ffi::c_void = std::ptr::null_mut();
    let status = unsafe { recognize(state.engine, &view, 15000, &mut result) };
    if status != 0 {
        return Err(format!("wco_recognize 失败 status={status}: {}", wxocr_last_error(lib)));
    }

    let mut out: Vec<(String, [f64; 4])> = Vec::new();
    if !result.is_null() {
        let n = unsafe { line_count(result) };
        for i in 0..n {
            let mut line = WcoLine {
                struct_size: std::mem::size_of::<WcoLine>() as u32,
                has_confidence: 0,
                quad: [0.0; 8],
                confidence: 0.0,
                text: std::ptr::null(),
                text_length: 0,
            };
            if unsafe { get_line(result, i, &mut line) } == 0 && !line.text.is_null() && line.text_length > 0 {
                let bytes = unsafe { std::slice::from_raw_parts(line.text as *const u8, line.text_length as usize) };
                let text = collapse_cjk_spaces(&String::from_utf8_lossy(bytes));
                let xs = [line.quad[0] as f64, line.quad[2] as f64, line.quad[4] as f64, line.quad[6] as f64];
                let ys = [line.quad[1] as f64, line.quad[3] as f64, line.quad[5] as f64, line.quad[7] as f64];
                out.push((
                    text,
                    [
                        xs.iter().cloned().fold(f64::INFINITY, f64::min),
                        ys.iter().cloned().fold(f64::INFINITY, f64::min),
                        xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
                        ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
                    ],
                ));
            }
        }
        unsafe { result_destroy(result) };
    }
    Ok(out)
}

/// 应用退出时销毁引擎（正常退出路径由 SDK 回收 worker/子进程；强杀场景与 llama 孤儿同风险，
/// 由 _stop_app 的清扫兜底——后续可在 _sweep_orphans.ps1 补 wechatocr-worker 名单）
fn wxocr_shutdown() {
    if let Ok(mut guard) = WXOCR_STATE.lock() {
        if let Some(state) = guard.as_mut() {
            if !state.engine.is_null() {
                if let Some(lib) = &state.lib {
                    if let Ok(destroy) = unsafe { lib.get::<unsafe extern "system" fn(*mut std::ffi::c_void)>(b"wco_destroy\0") } {
                        unsafe { destroy(state.engine) };
                    }
                }
                state.engine = std::ptr::null_mut();
            }
            state.lib = None;
        }
    }
}

/// 兜底开关（设置窗 2026-11-21）：store 键缺省=开，显式 false 才关
fn fallback_enabled(key: &str) -> bool {
    store_load()
        .get(key)
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// OCR 预热三档（对齐 F1 readOcrWarmupMode）：resident / on-demand / capture-prewarm（默认）
fn read_ocr_warmup_mode() -> String {
    let v = store_load()
        .get("screenshot-ocr-warmup")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default();
    if v == "resident" || v == "on-demand" || v == "capture-prewarm" {
        v
    } else {
        "capture-prewarm".to_string()
    }
}

/// 预热去抖（F1 prewarmOcr 同款 200ms 排队；ensure 幂等，健康则复用）
static PREWARM_LAST_MS: AtomicU64 = AtomicU64::new(0);

fn prewarm_ocr() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if now.saturating_sub(PREWARM_LAST_MS.load(Ordering::Relaxed)) < 200 {
        return;
    }
    PREWARM_LAST_MS.store(now, Ordering::Relaxed);
    logln("[ocr] prewarm queued");
    tauri::async_runtime::spawn(async move {
        let _ = ensure_py_service().await;
    });
}

/// 兜底链文本源：微信 OCR（wxocr）优先 → WinRT 系统 OCR（wmocr）保底。
/// 两级均可被设置窗开关（screenshot-fallback-wxocr / -wmocr，缺省开）。
/// 返回 (行文本列表, 引擎标签)。
async fn ocr_fallback_lines(png: &[u8]) -> Result<(Vec<String>, &'static str), String> {
    let wx_on = fallback_enabled("screenshot-fallback-wxocr");
    let wm_on = fallback_enabled("screenshot-fallback-wmocr");
    if wx_on {
        let owned = png.to_vec();
        let wx = tauri::async_runtime::spawn_blocking(move || wxocr_png(&owned)).await;
        if let Ok(Ok(lines)) = wx {
            let texts: Vec<String> = lines
                .into_iter()
                .map(|(t, _)| t)
                .filter(|t| !t.trim().is_empty())
                .collect();
            if !texts.is_empty() {
                return Ok((texts, "wxocr"));
            }
        }
    }
    if !wm_on {
        return Err("兜底 OCR 已在设置中全部关闭".to_string());
    }
    let owned = png.to_vec();
    let wm = tauri::async_runtime::spawn_blocking(move || {
        mta_thread_init();
        wmocr_png(&owned).map(|l| l.into_iter().map(|(t, _)| t).collect::<Vec<_>>())
    })
    .await;
    match wm {
        Ok(Ok(lines)) => {
            let texts: Vec<String> = lines.into_iter().filter(|t| !t.trim().is_empty()).collect();
            if texts.is_empty() {
                Err("两条兜底 OCR 都未识别出文字".to_string())
            } else {
                Ok((texts, "wmocr"))
            }
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("兜底 OCR 线程失败".to_string()),
    }
}

/// 18766 /ocr|/smart JSON → 渲染端契约（对齐 F1 finalizeRapidText）。
/// 返回 None = 服务报错/空结果 → 调用方走兜底。
fn map_ocr_service_json(res: &Value) -> Option<Value> {
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let markdown = res.get("markdown").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());
    let paragraphs = res.get("paragraphs").and_then(|v| v.as_array()).filter(|a| !a.is_empty());
    let lines = res.get("lines").and_then(|v| v.as_array()).filter(|a| !a.is_empty());
    let text = if let Some(md) = markdown {
        md.to_string()
    } else if let Some(p) = paragraphs {
        p.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("\n\n")
    } else if let Some(l) = lines {
        l.iter().filter_map(|x| x.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n")
    } else {
        String::new()
    };
    if text.trim().is_empty() {
        return None;
    }
    let mut out = json!({ "success": true, "text": text, "engine": "rapidocr" });
    // 行框透传（2026-11-25 隐私快速打码）：渲染端需要 text+box 才能定位命中子矩形
    if let Some(l) = lines {
        let kept: Vec<Value> = l
            .iter()
            .filter(|x| {
                x.get("text").and_then(|t| t.as_str()).is_some()
                    && x.get("box").and_then(|b| b.as_array()).map(|a| a.len() >= 4).unwrap_or(false)
            })
            .cloned()
            .collect();
        if !kept.is_empty() {
            out["lines"] = Value::Array(kept);
        }
    }
    let modules = res.get("modules").and_then(|v| v.as_array()).filter(|a| a.len() > 1);
    if let Some(m) = modules {
        out["modules"] = Value::Array(m.clone());
    }
    if let Some(ms) = res.get("ms") {
        out["ms"] = ms.clone();
    }
    Some(out)
}

/// 18766 /table JSON → 渲染端契约（{success, html, rows}）
fn map_table_service_json(res: &Value) -> Option<Value> {
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let html = res.get("html").and_then(|v| v.as_str())?.to_string();
    let mut out = json!({ "success": true, "html": html });
    if let Some(rows) = res.get("rows") {
        out["rows"] = rows.clone();
    }
    if let Some(ms) = res.get("ms") {
        out["ms"] = ms.clone();
    }
    Some(out)
}

/// 18766 /translate_image JSON → 渲染端契约（对齐 F1 translateImageWithRapid）
fn map_translate_service_json(res: &Value) -> Option<Value> {
    if res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let image = res.get("image").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let text = res.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if image.is_empty() && text.trim().is_empty() {
        return None;
    }
    let mut out = json!({ "success": true, "translatedImage": image, "translatedText": text, "engine": "rapidocr+llama" });
    let modules = res.get("modules").and_then(|v| v.as_array()).filter(|a| a.len() > 1);
    if let Some(m) = modules {
        out["modules"] = Value::Array(m.clone());
    }
    if let Some(f) = res.get("fallback") {
        out["fallback"] = f.clone();
    }
    if let Some(ms) = res.get("ms") {
        out["ms"] = ms.clone();
    }
    Some(out)
}

/// 系统 OCR 中文语言包探测：AvailableRecognizerLanguages 里是否有 zh（供设置页状态显示）
fn wmocr_langpack_available() -> bool {
    use windows::Media::Ocr::OcrEngine;
    mta_thread_init();
    match OcrEngine::AvailableRecognizerLanguages() {
        Ok(langs) => langs.into_iter().any(|l| {
            l.LanguageTag()
                .map(|t| format!("{t}").to_lowercase().starts_with("zh"))
                .unwrap_or(false)
        }),
        Err(_) => false,
    }
}

/// OCR 引擎优先级链（2026-11-22）：与 F1 同 store 键 `screenshot-ocr-engine-chain`，
/// 按用户排列顺序逐个尝试、失败自动降级（替代固定 18766→wxocr→wmocr）。
/// F2 可执行子集 = rapidocr(18766 代理) / paddle(18765 代理) / wxocr / wmocr；
/// tesseract/server 由 F1 处理，F2 跳过。wxocr/wmocr 仍受设置窗开关约束（关 = 从链中剔除）。
fn read_ocr_chain() -> Vec<String> {
    const DEFAULT_CHAIN: [&str; 5] = ["rapidocr", "wxocr", "wmocr", "tesseract", "paddle"];
    let mut out: Vec<String> = Vec::new();
    if let Some(Value::Array(arr)) = store_load().get("screenshot-ocr-engine-chain") {
        for item in arr {
            if let Some(s) = item.as_str() {
                let s = s.to_string();
                if matches!(s.as_str(), "rapidocr" | "paddle" | "wxocr" | "wmocr") && !out.contains(&s) {
                    out.push(s);
                }
            }
        }
    }
    if out.is_empty() {
        out = DEFAULT_CHAIN.iter().map(|s| s.to_string()).collect();
    }
    out
}

/// 18765 Paddle 侧车 /ocr 代理（F2 不拉起 18765——须 F1 侧车在线或用户先开过 F1；
/// 响应 {ok, text}，与 F1 recognizeWithPaddleOcr 同形）
async fn proxy_paddle_ocr(png: &[u8]) -> Option<Value> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    let body = json!({ "image": format!("data:image/png;base64,{b64}"), "model_tier": "fast" });
    let client = reqwest::Client::builder().timeout(Duration::from_secs(90)).build().ok()?;
    let res = client.post("http://127.0.0.1:18765/ocr").json(&body).send().await.ok()?;
    let v: Value = res.json().await.ok()?;
    if v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        return None;
    }
    let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("");
    if text.trim().is_empty() {
        return None;
    }
    Some(json!({ "success": true, "text": text, "engine": "paddle" }))
}

/// 引擎优先级链执行器：按链序逐个尝试，全部失败返回聚合错误（对齐 F1 capture-ocr-local 契约）。
/// 可用性沉底（2026-11-22）：侧车端口不在线的引擎排到最后尝试——保留 ensure 自愈机会，
/// 不让故障引擎挡在可用引擎前面。
async fn ocr_chain_value(png: Option<&[u8]>) -> Value {
    let Some(png) = png else {
        return json!({ "success": false, "code": "invalidData", "message": "选区图像无效" });
    };
    let mut failures: Vec<String> = Vec::new();
    let raw_chain = read_ocr_chain();
    let mut ready: Vec<&String> = Vec::new();
    let mut deferred: Vec<&String> = Vec::new();
    for engine in &raw_chain {
        let is_ready = match engine.as_str() {
            "rapidocr" => port_listening(18766),
            "paddle" => port_listening(18765),
            _ => true,
        };
        if is_ready { ready.push(engine); } else { deferred.push(engine); }
    }
    ready.extend(deferred);
    for engine in ready {
        match engine.as_str() {
            "rapidocr" => {
                if !ensure_py_service().await {
                    failures.push("RapidOCR: 服务不可用".into());
                    continue;
                }
                let res = proxy_18766_bytes("/ocr", png, Duration::from_secs(60)).await;
                match map_ocr_service_json(&res) {
                    Some(v) => return v,
                    None => failures.push("RapidOCR: 服务无响应或未识别出文字".into()),
                }
            }
            "paddle" => {
                match proxy_paddle_ocr(png).await {
                    Some(v) => return v,
                    None => failures.push("PaddleOCR: 侧车 18765 不在线或识别失败".into()),
                }
            }
            "wxocr" => {
                let owned = png.to_vec();
                let r = tauri::async_runtime::spawn_blocking(move || wxocr_png(&owned)).await;
                match r {
                    Ok(Ok(lines)) => {
                        let texts: Vec<String> = lines
                            .into_iter()
                            .map(|(t, _)| t)
                            .filter(|t| !t.trim().is_empty())
                            .collect();
                        if texts.is_empty() {
                            failures.push("微信 OCR: 未识别出文字".into());
                        } else {
                            return json!({ "success": true, "text": texts.join("\n"), "engine": "wxocr" });
                        }
                    }
                    Ok(Err(e)) => failures.push(format!("微信 OCR: {e}")),
                    Err(_) => failures.push("微信 OCR: 线程失败".into()),
                }
            }
            "wmocr" => {
                let owned = png.to_vec();
                let r = tauri::async_runtime::spawn_blocking(move || {
                    mta_thread_init();
                    wmocr_png(&owned).map(|l| l.into_iter().map(|(t, _)| t).collect::<Vec<_>>())
                })
                .await;
                match r {
                    Ok(Ok(lines)) => {
                        let texts: Vec<String> = lines.into_iter().filter(|t| !t.trim().is_empty()).collect();
                        if texts.is_empty() {
                            failures.push("系统 OCR: 未识别出文字".into());
                        } else {
                            return json!({ "success": true, "text": texts.join("\n"), "engine": "wmocr" });
                        }
                    }
                    Ok(Err(e)) => failures.push(format!("系统 OCR: {e}")),
                    Err(_) => failures.push("系统 OCR: 线程失败".into()),
                }
            }
            _ => {} // tesseract / server：F2 不实现，跳过
        }
    }
    let message = if failures.is_empty() {
        "未配置可用的本机识别引擎（设置 → OCR 优先级）".to_string()
    } else {
        format!("所有本地识别引擎均不可用 — {}", failures.join("；"))
    };
    json!({ "success": false, "code": "ocrAllEnginesFailed", "message": message })
}

/// 兜底②：兜底 OCR 文本（wxocr 优先）+ 免 key 翻译 → 面板纯文本契约（translatedImage 留空）
/// （2026-11-22 起识别链改走引擎优先级链 ocr_chain_value；本函数仍服务于翻译兜底路径）
async fn ocr_fallback_translate_value(png: Option<&[u8]>, target_code: &str) -> Value {
    let Some(png) = png else {
        return json!({ "success": false, "code": "serviceDown", "message": "本地翻译服务不可用，且选区图像无效" });
    };
    let (lines, ocr_engine) = match ocr_fallback_lines(png).await {
        Ok(v) => v,
        Err(e) => return json!({ "success": false, "message": format!("本地翻译服务不可用，兜底 OCR 也不可用：{e}") }),
    };
    if lines.is_empty() {
        return json!({ "success": false, "message": "本地翻译服务不可用，选区内也未识别出文字" });
    }
    if !fallback_enabled("screenshot-fallback-freetranslate") {
        return json!({ "success": false, "message": "本地翻译服务不可用，且免 key 翻译兜底已在设置中关闭" });
    }
    match free_translate_batch(&lines, target_code).await {
        Ok((engine, translations)) => {
            let text = translations.iter().filter(|t| !t.trim().is_empty()).cloned().collect::<Vec<_>>().join("\n");
            if text.trim().is_empty() {
                json!({ "success": false, "message": "本地翻译服务不可用，免 key 兜底翻译返回为空" })
            } else {
                json!({ "success": true, "translatedImage": "", "translatedText": text, "engine": format!("{ocr_engine}+{engine}") })
            }
        }
        Err(e) => json!({ "success": false, "message": format!("本地翻译服务不可用，免 key 兜底翻译也失败：{e}") }),
    }
}

// ── Edge 免 key 翻译（青蛙实锤端点）────────────────────────────────
static EDGE_TOKEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);
const EDGE_TOKEN_TTL: Duration = Duration::from_secs(480);
const EDGE_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PetalSnap/1.0";

async fn edge_auth_token() -> Result<String, String> {
    if let Ok(guard) = EDGE_TOKEN.lock() {
        if let Some((tok, at)) = guard.as_ref() {
            if at.elapsed() < EDGE_TOKEN_TTL {
                return Ok(tok.clone());
            }
        }
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap();
    let resp = client
        .post("https://edge.microsoft.com/translate/auth")
        .header(reqwest::header::USER_AGENT, EDGE_UA)
        // 该端点是 HTTP/1.1 严格实现：POST 空体也要 Content-Length，否则 411 Length Required
        .body("")
        .send()
        .await
        .map_err(|e| format!("Edge auth 连接失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Edge auth HTTP {}", resp.status()));
    }
    let tok = resp.text().await.map_err(|e| format!("Edge auth 读取失败: {e}"))?;
    let tok = tok.trim().to_string();
    if tok.is_empty() {
        return Err("Edge auth 返回空 token".to_string());
    }
    if let Ok(mut g) = EDGE_TOKEN.lock() {
        *g = Some((tok.clone(), Instant::now()));
    }
    Ok(tok)
}

/// Edge 批量翻译：texts 与返回一一对应；token 401 过期自动刷新重试一次。
async fn edge_translate_batch(texts: &[String], to: &str) -> Result<Vec<String>, String> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    let body: Vec<Value> = texts.iter().map(|t| json!({ "Text": t })).collect();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().unwrap();
    for attempt in 0..2u8 {
        let tok = edge_auth_token().await?;
        let url = format!("https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to={to}");
        let resp = client
            .post(&url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {tok}"))
            .header(reqwest::header::USER_AGENT, EDGE_UA)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await;
        let resp = match resp {
            Ok(r) => r,
            Err(e) => return Err(format!("Edge 翻译连接失败: {e}")),
        };
        let status = resp.status();
        if status.as_u16() == 401 {
            if let Ok(mut g) = EDGE_TOKEN.lock() {
                *g = None;
            }
            if attempt == 0 {
                continue; // token 过期 → 刷新重试一次
            }
            return Err("Edge 翻译 HTTP 401（token 重试后仍失败）".to_string());
        }
        if !status.is_success() {
            return Err(format!("Edge 翻译 HTTP {status}"));
        }
        let arr: Vec<Value> = resp.json().await.map_err(|e| format!("Edge 翻译解析失败: {e}"))?;
        return Ok(arr
            .iter()
            .map(|o| {
                o.get("translations")
                    .and_then(|t| t.get(0))
                    .and_then(|t| t.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect());
    }
    Err("Edge 翻译重试失败".to_string())
}

/// MyMemory 免 key 翻译（青蛙第三通道）：GET /get?q=&langpair=src|tgt。
/// ⚠️ 2026-11-19 本机实测：Edge auth 端点对本机网络恒 404（geo/策略限制），
/// Google gtx 超时（被墙）——MyMemory 是本机**唯一实测可用**的免 key 通道，
/// 故链路为 Edge（优先，质量好）→ MyMemory（保底）。MyMemory 无源语言自动检测，
/// 按文字脚本猜源语言；每段 ≤450 字符、最多 8 段（匿名每日配额有限）。
fn mymemory_to_code(code: &str) -> &'static str {
    match code {
        "zh" => "zh-CN",
        "en" => "en", "ja" => "ja", "ko" => "ko", "fr" => "fr",
        "de" => "de", "es" => "es", "ru" => "ru",
        _ => "zh-CN",
    }
}

/// 按文字脚本猜源语言；源==目标 → None（无需翻译）
fn mymemory_src_for(text: &str, to: &str) -> Option<&'static str> {
    let has_kana = text.chars().any(|c| ('\u{3040}'..='\u{30FF}').contains(&c));
    let has_hangul = text.chars().any(|c| ('\u{AC00}'..='\u{D7AF}').contains(&c));
    let has_han = text.chars().any(|c| ('\u{4E00}'..='\u{9FFF}').contains(&c) || ('\u{3400}'..='\u{4DBF}').contains(&c));
    let src = if has_kana {
        "ja"
    } else if has_hangul {
        "ko"
    } else if has_han {
        "zh-CN"
    } else {
        "en"
    };
    if src == to { None } else { Some(src) }
}

async fn mymemory_translate_batch(texts: &[String], target_code: &str) -> Result<Vec<String>, String> {
    let to = mymemory_to_code(target_code);
    let client = reqwest::Client::builder().timeout(Duration::from_secs(20)).build().unwrap();
    let mut out = Vec::with_capacity(texts.len());
    for t in texts.iter().take(8) {
        let src = mymemory_src_for(t, to)
            .ok_or_else(|| format!("源语言与目标语言相同（{to}），无需翻译"))?;
        let q: String = t.chars().take(450).collect();
        let url = format!("https://api.mymemory.translated.net/get?q={}&langpair={}|{}", urlencode(&q), src, to);
        let resp = client
            .get(&url)
            .header(reqwest::header::USER_AGENT, EDGE_UA)
            .send()
            .await
            .map_err(|e| format!("MyMemory 连接失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("MyMemory HTTP {}", resp.status()));
        }
        let v: Value = resp.json().await.map_err(|e| format!("MyMemory 解析失败: {e}"))?;
        let translated = v
            .get("responseData")
            .and_then(|d| d.get("translatedText"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if translated.trim().is_empty() || translated.contains("MYMEMORY WARNING") {
            return Err("MyMemory 返回为空或配额告警".to_string());
        }
        out.push(translated.to_string());
    }
    Ok(out)
}

/// 百分号编码（仅 UTF-8 百分号大写 hex，够 q 参数用）
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 免 key 翻译链：Edge（质量好，部分网络不可用）→ MyMemory（保底）。
/// 返回 (引擎标签, 与 texts 一一对应的译文)。
async fn free_translate_batch(texts: &[String], target_code: &str) -> Result<(String, Vec<String>), String> {
    if texts.is_empty() {
        return Ok(("edge".to_string(), vec![]));
    }
    match edge_translate_batch(texts, edge_to_code(target_code)).await {
        Ok(v) => return Ok(("edge".to_string(), v)),
        Err(edge_err) => {
            logln(&format!("[translate] Edge 兜底不可用（{edge_err}）→ 尝试 MyMemory"));
        }
    }
    mymemory_translate_batch(texts, target_code).await.map(|v| ("mymemory".to_string(), v))
}

// ── 问 AI（用户自配置 OpenAI 兼容接口 + 模板）──────────────────────
/// F1 store 只读继承：F2 自己的 store 没有 → 读 F1 的
/// %APPDATA%\petalsnap\eIsland_store\<key>.json（迁移方案 §4.3 store 互通方向）。
fn f1_store_string(key: &str) -> Option<String> {
    let appdata = std::env::var("APPDATA").ok()?;
    let p = PathBuf::from(appdata).join("petalsnap").join("eIsland_store").join(format!("{key}.json"));
    let s = std::fs::read_to_string(p).ok()?;
    let v: Value = serde_json::from_str(&s).ok()?;
    v.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn store_read_string_inherit(key: &str) -> Option<String> {
    if let Some(v) = store_load().get(key).and_then(|v| v.as_str()) {
        if !v.trim().is_empty() {
            return Some(v.trim().to_string());
        }
    }
    f1_store_string(key)
}

/// (baseUrl, apiKey, model)；缺 key/model = 未配置
fn ask_ai_config() -> Result<(String, String, String), ()> {
    let api_key = store_read_string_inherit("screenshot-ask-ai-key");
    let model = store_read_string_inherit("screenshot-ask-ai-model");
    let base_url = store_read_string_inherit("screenshot-ask-ai-base-url")
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    match (api_key, model) {
        (Some(k), Some(m)) if !k.trim().is_empty() && !m.trim().is_empty() => Ok((base_url, k, m)),
        _ => Err(()),
    }
}

/// 内置默认模板（resources/ask-ai-modes.json 缺失/损坏时的兜底，内容与文件一致）
const DEFAULT_ASK_AI_MODES: &str = r#"{
  "modes": [
    { "id": "explain",   "label": "解读图片", "labelEn": "Explain image",
      "prompt": "请用中文详细解释这张截图的内容。" },
    { "id": "latex",     "label": "公式识别 LaTeX", "labelEn": "Formula → LaTeX",
      "prompt": "将图片中的数学公式转换为 LaTeX 源码：行内公式用 $...$，独立公式用 $$...$$。只输出 LaTeX 代码，不要任何解释和代码块标记。",
      "system": "你是数学公式 OCR 引擎。" },
    { "id": "table-md",  "label": "表格转 Markdown", "labelEn": "Table → Markdown",
      "prompt": "将图片中的表格转换为 Markdown 表格源码。只输出表格内容，不要代码块标记和任何解释。" },
    { "id": "table-csv", "label": "表格转 CSV", "labelEn": "Table → CSV",
      "prompt": "将图片中的表格转换为 CSV（英文逗号分隔，一行一行输出）。只输出数据流，便于直接粘贴进 Excel。" },
    { "id": "translate", "label": "图片翻译", "labelEn": "Translate image",
      "prompt": "识别图片中的文字并翻译为中文。自动检测原语言；只输出译文，不要原文和解释。",
      "system": "你是专业翻译引擎。" },
    { "id": "summarize", "label": "图片总结", "labelEn": "Summarize image",
      "prompt": "简要总结这张图片的核心信息，用简洁的要点列出，不要开场白。",
      "system": "你是视觉内容分析师。", "temperature": 0.5 }
  ]
}"#;

fn load_ask_ai_modes() -> Vec<Value> {
    if let Some(p) = resolve_resource("", "ask-ai-modes.json") {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                if let Some(arr) = v.get("modes").and_then(|m| m.as_array()) {
                    return arr.clone();
                }
            }
        }
    }
    serde_json::from_str::<Value>(DEFAULT_ASK_AI_MODES)
        .ok()
        .and_then(|v| v.get("modes").and_then(|m| m.as_array()).cloned())
        .unwrap_or_default()
}

/// 问 AI 请求体构造（拆出来便于 mock 测试：模板解析 / system 消息 / temperature）
fn ask_ai_request_body(
    cfg: (String, String, String),
    data_url: &str,
    question: &str,
    mode: &str,
) -> Result<(String, Value), Value> {
    if !data_url.starts_with("data:image/") {
        return Err(json!({ "success": false, "message": "选区图像无效" }));
    }
    let mut system = String::new();
    let mut prompt = String::new();
    let mut temperature: Option<f64> = None;
    if !mode.is_empty() {
        if let Some(m) = load_ask_ai_modes()
            .iter()
            .find(|m| m.get("id").and_then(|v| v.as_str()) == Some(mode))
        {
            prompt = m.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
            system = m.get("system").and_then(|v| v.as_str()).unwrap_or("").to_string();
            temperature = m.get("temperature").and_then(|v| v.as_f64());
        }
    }
    if prompt.trim().is_empty() {
        prompt = if question.trim().is_empty() {
            "请用中文详细解释这张截图的内容。".to_string()
        } else {
            question.trim().to_string()
        };
    }
    let mut messages: Vec<Value> = Vec::new();
    if !system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.push(json!({
        "role": "user",
        "content": [
            { "type": "text", "text": prompt },
            { "type": "image_url", "image_url": { "url": data_url } }
        ]
    }));
    let mut body = json!({ "model": cfg.2, "stream": false, "messages": messages });
    if let Some(t) = temperature {
        body["temperature"] = json!(t);
    }
    let url = format!("{}/chat/completions", cfg.0.trim_end_matches('/'));
    Ok((url, body))
}

/// 发送问 AI 请求并按 F1 askAiService.ts 同款口径映射结果/错误。
async fn send_ask_ai(cfg: (String, String, String), url: String, body: Value) -> Value {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(120)).build().unwrap();
    let resp = match client
        .post(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", cfg.1))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return json!({ "success": false, "message": "无法连接 API，请检查地址与网络" }),
    };
    let status = resp.status();
    if !status.is_success() {
        let detail = resp
            .json::<Value>()
            .await
            .ok()
            .and_then(|b| b.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()).map(|s| s.to_string()))
            .unwrap_or_default();
        let hint = match status.as_u16() {
            401 | 403 => "密钥无效或无权限，请检查 API 密钥",
            404 => "地址或模型不存在：确认 API 地址以 /v1 结尾、模型名拼写正确",
            429 => "请求过于频繁或额度不足",
            _ => "API 返回错误",
        };
        let msg = if detail.is_empty() {
            format!("{hint}（HTTP {status}）")
        } else {
            format!("{hint}（{}）", detail.chars().take(160).collect::<String>())
        };
        return json!({ "success": false, "message": msg });
    }
    let data: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return json!({ "success": false, "message": "接口返回解析失败" }),
    };
    let text = data
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    if text.trim().is_empty() {
        json!({ "success": false, "message": "接口返回为空（该模型可能不支持图片输入，请换视觉模型）" })
    } else {
        json!({ "success": true, "text": text.trim() })
    }
}

async fn ask_ai_invoke(data_url: &str, question: &str, mode: &str) -> Value {
    let cfg = match ask_ai_config() {
        Ok(c) => c,
        Err(()) => {
            return json!({
                "success": false,
                "code": "askAiNotConfigured",
                "message": "请先在 设置 → AI 问答 填写 API 地址、密钥与模型名（F2 继承 F1 的配置）"
            })
        }
    };
    match ask_ai_request_body(cfg.clone(), data_url, question, mode) {
        Ok((url, body)) => send_ask_ai(cfg, url, body).await,
        Err(v) => v,
    }
}

// ── 设置窗支持（2026-11-21 设置窗整体迁移，契约对齐 F1 app/main.ts）────────────
// 开机自启 = HKCU Run 键（Electron setLoginItemSettings 同款语义）；目录打开 = explorer；
// 可配置热键 = 全局快捷键重注册（F1/F2 固定键 + Alt+C 保留，set 只管「可配置档」）。

const SETTINGS_RUN_VALUE: &str = "PetalsnapSpike";

fn run_key() -> winreg::RegKey {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            winreg::enums::KEY_READ | winreg::enums::KEY_QUERY_VALUE,
        )
        .unwrap_or_else(|_| winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER))
}

/// 开机自启当前状态：Run 键存在且指向当前 exe
fn login_item_get() -> bool {
    let exe = std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned());
    match (run_key().get_value::<String, _>(SETTINGS_RUN_VALUE), exe) {
        (Ok(v), Some(exe)) => v.replace('/', "\\").eq_ignore_ascii_case(&exe.replace('/', "\\")),
        _ => false,
    }
}

// ── 设置备份（2026-11-23 通用页「保存」分组）：与 F1 settingsBackupService 同语义 ──

/// 备份目录：设置可配，空 = 文档\petalsnap-backup
fn settings_backup_dir() -> PathBuf {
    let custom = store_load()
        .get("settings-backup-dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from);
    custom.unwrap_or_else(|| {
        std::env::var("USERPROFILE")
            .map(|u| PathBuf::from(u).join("Documents").join("petalsnap-backup"))
            .unwrap_or_else(|_| std::env::temp_dir().join("petalsnap-backup"))
    })
}

fn settings_backup_stamp() -> String {
    // UTC 时间戳文件名（本地时区换算略——文件名唯一性是目的，展示走资源管理器 mtime）
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let days = now / 86400;
    let secs = now % 86400;
    // 简易 civil-from-days（Howard Hinnant 算法）
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = doe.div_euclid(36524);
    let doy = doe.rem_euclid(36524);
    let y = doy.div_euclid(365);
    let year = era * 400 + yoe + 1 + (doy == 365 && y == 3) as i64;
    let mp = doy.rem_euclid(365).div_euclid(30);
    let month = (mp + 2) % 12 + 1;
    let day = doy.rem_euclid(365).rem_euclid(30) + 1;
    format!("{:04}-{:02}-{:02}-{:02}-{:02}-{:02}", year, month, day, secs / 3600, (secs % 3600) / 60, secs % 60)
}

const BACKUP_PREFIX: &str = "settings-";
const BACKUP_KEEP: usize = 10;
/// 不进备份的键：账号凭据（隐私；换机器也不该带过去）
const BACKUP_EXCLUDE: [&str; 1] = ["user-account-token"];

fn settings_store_dir() -> PathBuf {
    // F2 store = %APPDATA%\petalsnap-spike\store.json（与 F1 的 eIsland_store 目录不同构；
    // 备份统一打包 store.json 单文件，导入也按单文件整体替换）
    std::env::var("APPDATA")
        .map(|a| PathBuf::from(a).join("petalsnap-spike"))
        .unwrap_or_else(|_| std::env::temp_dir().join("petalsnap-spike"))
}

/// 打包 store 全部 JSON 为 {__format, key: value}；单文件损坏跳过留痕
fn settings_backup_pack() -> Result<String, String> {
    let dir = settings_store_dir();
    let mut out = serde_json::Map::new();
    out.insert("__format".into(), json!("petalsnap-settings-backup/1"));
    // F2：store.json 单文件整体打包（键级排除在读取后做）
    let fp = dir.join("store.json");
    if fp.exists() {
        let txt = std::fs::read_to_string(&fp).map_err(|e| format!("读取 store 失败: {e}"))?;
        if let Ok(obj) = serde_json::from_str::<serde_json::Map<String, Value>>(&txt) {
            for (k, v) in obj {
                if !BACKUP_EXCLUDE.contains(&k.as_str()) {
                    out.insert(k, v);
                }
            }
        }
    }
    Ok(Value::Object(out).to_string())
}

fn settings_backup_prune(dir: &std::path::Path) {
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default();
    files.retain(|f| f.starts_with(BACKUP_PREFIX) && f.ends_with(".json"));
    files.sort();
    files.reverse();
    for f in files.iter().take(files.len().saturating_sub(BACKUP_KEEP)) {
        let _ = std::fs::remove_file(dir.join(f));
    }
}

/// 导入（整体替换）：校验 __format → 写「导入前备份」→ 清空 store（排除凭据键）→ 写入
fn settings_import_replace(path: &std::path::Path) -> Result<usize, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("读取失败: {e}"))?;
    let data: Value = serde_json::from_str(&raw).map_err(|e| format!("不是有效的 JSON：{e}"))?;
    let obj = data.as_object().ok_or("不是有效的拾花设置备份文件")?;
    if obj.get("__format").and_then(|v| v.as_str()) != Some("petalsnap-settings-backup/1") {
        return Err("不是有效的拾花设置备份文件".into());
    }
    // 导入前备份
    if let Ok(pre) = settings_backup_pack() {
        let dir = settings_backup_dir();
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(format!("{}{}-pre-import.json", BACKUP_PREFIX, settings_backup_stamp())), pre);
        settings_backup_prune(&dir);
    }
    let mut count = 0usize;
    // 整体替换：F2 单文件 store.json 全量重写（保留文件内已存在的非设置键如 host 标记除外——
    // 备份里没有的键视为废弃，与 F1 目录语义对齐）
    let dir = settings_store_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let mut next = serde_json::Map::new();
    for (key, value) in obj {
        if key == "__format" || BACKUP_EXCLUDE.contains(&key.as_str()) {
            continue;
        }
        next.insert(key.clone(), value.clone());
        count += 1;
    }
    std::fs::write(dir.join("store.json"), Value::Object(next).to_string())
        .map_err(|e| format!("写入 store 失败: {e}"))?;
    Ok(count)
}

fn login_item_set(enable: bool) {
    let hk = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let run = hk.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        winreg::enums::KEY_SET_VALUE | winreg::enums::KEY_QUERY_VALUE,
    );
    let Ok(run) = run else { return };
    if enable {
        if let Ok(exe) = std::env::current_exe() {
            let _ = run.set_value(SETTINGS_RUN_VALUE, &exe.to_string_lossy().into_owned());
        }
    } else {
        let _ = run.delete_value(SETTINGS_RUN_VALUE);
    }
    logln(&format!("[settings] 开机自启={enable}"));
}

/// openPath 目标解析（纯函数，可单测）：logs → F2 日志目录（%TEMP%）；
/// videos → 用户视频目录；screenshots → 截图保存目录；空 → 日志目录；其它 = 绝对路径原样。
pub(crate) fn settings_target_dir(which: &str) -> PathBuf {
    match which.trim() {
        "logs" | "" => std::env::temp_dir(),
        "videos" => std::env::var("USERPROFILE")
            .map(|p| PathBuf::from(p).join("Videos"))
            .unwrap_or_else(|_| std::env::temp_dir()),
        // 截图目录读设置（通用页「保存」分组）；空 = 系统「图片」
        "screenshots" => store_load()
            .get("screenshot-save-dir")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var("USERPROFILE")
                    .map(|u| PathBuf::from(u).join("Pictures"))
                    .unwrap_or_else(|_| std::env::temp_dir())
            }),
        other => PathBuf::from(other),
    }
}

/// 设置窗 openPath：解析目录（不存在先建）→ explorer 打开
fn settings_open_path(which: &str) -> bool {
    let target = settings_target_dir(which);
    if !target.exists() {
        let _ = std::fs::create_dir_all(&target);
    }
    // 同路径 1.5s 去重：用户连击「打开目录」只开一个窗口（重复 spawn explorer 的投诉点）
    static LAST_OPEN: std::sync::Mutex<Option<(std::path::PathBuf, std::time::Instant)>> =
        std::sync::Mutex::new(None);
    if let Ok(mut g) = LAST_OPEN.lock() {
        if let Some((last, t)) = g.as_ref() {
            if *last == target && t.elapsed() < std::time::Duration::from_millis(1500) {
                return true;
            }
        }
        *g = Some((target.clone(), std::time::Instant::now()));
    }
    // explorer 直接 spawn：open::that 在本机实测阻塞 ~2s（等 shell 链）；spawn 立即返回
    use std::os::windows::process::CommandExt;
    let ok = std::process::Command::new("explorer")
        .arg(target.as_os_str())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .spawn()
        .is_ok();
    if !ok {
        logln(&format!("[settings] openPath 失败: {}", target.display()));
    }
    ok
}

/// 可配置截图热键（F1/F2 固定键 + Alt+C 之外的一档，默认 Alt+Q）。
/// set：保留键拒绝 → 注销旧可配置键 → 注册新键（触发截图）→ 成功才写 store。
static CONFIGURED_HOTKEY: Mutex<Option<String>> = Mutex::new(None);

async fn set_configured_hotkey(app: &AppHandle, accel: &str) -> bool {
    let accel = accel.trim().to_string();
    if accel.is_empty() {
        return false;
    }
    let reserved = ["F1", "F2", "Alt+C"];
    if reserved.iter().any(|r| r.eq_ignore_ascii_case(&accel)) {
        logln(&format!("[settings] 热键 {accel} 是保留键，拒绝"));
        return false;
    }
    if !accel.contains('+') || accel.len() > 40 {
        return false;
    }
    let gs = app.global_shortcut();
    // 先注销旧的（F1/F2/Alt+C 不动）
    let old = CONFIGURED_HOTKEY.lock().ok().and_then(|g| g.clone());
    if let Some(old) = old {
        if let Ok(sc) = old.parse::<Shortcut>() {
            let _ = gs.unregister(sc);
        }
    }
    let Ok(sc) = accel.parse::<Shortcut>() else {
        return false;
    };
    if gs.register(sc).is_err() {
        logln(&format!("[settings] 热键 {accel} 注册失败（被其它程序占用）"));
        return false;
    }
    let app_c = app.clone();
    let accel_c = accel.clone();
    let _ = gs.on_shortcut(accel.as_str(), move |_app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            logln(&format!("[hotkey] {accel_c} fired"));
            start_session_ex(&app_c, false);
        }
    });
    if let Ok(mut g) = CONFIGURED_HOTKEY.lock() {
        *g = Some(accel.clone());
    }
    let mut map = store_load();
    map.insert("screenshot-hotkey".to_string(), json!(accel));
    store_save(&map);
    logln(&format!("[settings] 热键已切换为 {accel}"));
    true
}

/// 18766 /health 透传（对齐 F1 getRapidOcrHealth 返回契约 {ok,port,build,backend,models}）
async fn ocr_health_value() -> Value {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(4)).build().unwrap();
    match client.get("http://127.0.0.1:18766/health").send().await {
        Ok(r) => {
            let mut v: Value = r.json().await.unwrap_or(json!({ "ok": false }));
            if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
                v["port"] = json!(18766);
            }
            v
        }
        Err(_) => json!({ "ok": false, "port": 18766 }),
    }
}

/// P1 自测钩子（PETALSNAP_IPC_SELFTEST=1）：绕过 UI 直接走真实 IPC 分发链，
/// 结果全量落 %TEMP%\petalsnap-spike.log。仅诊断用，默认关。
async fn run_ipc_selftest(app: AppHandle) {
    if std::env::var("PETALSNAP_IPC_SELFTEST").unwrap_or_default() != "1" {
        return;
    }
    logln("[selftest] start");
    let img = std::env::var("PETALSNAP_IPC_SELFTEST_IMG")
        .ok()
        .map(PathBuf::from)
        .or_else(|| resolve_resource("", "temp/bench_text.png"));
    match img {
        Some(p) => match std::fs::read(&p) {
            Ok(bytes) => {
                logln(&format!("[selftest] img={} {}B", p.display(), bytes.len()));
                // (1) wmocr 直调（真实 WinRT 引擎 + 真图）
                let bytes1 = bytes.clone();
                let r = tauri::async_runtime::spawn_blocking(move || {
                    mta_thread_init();
                    wmocr_png(&bytes1)
                })
                .await;
                match r {
                    Ok(Ok(lines)) => logln(&format!(
                        "[selftest] wmocr ok lines={} first={:?}",
                        lines.len(),
                        lines.first().map(|(t, _)| t.chars().take(40).collect::<String>())
                    )),
                    Ok(Err(e)) => logln(&format!("[selftest] wmocr FAIL {e}")),
                    Err(_) => logln("[selftest] wmocr join FAIL"),
                }
                // (1b) wxocr 直调（微信 OCR，SDK 自动发现本机 runtime；引擎复用随进程常驻）
                let bytes_wx = bytes.clone();
                let rw = tauri::async_runtime::spawn_blocking(move || wxocr_png(&bytes_wx)).await;
                match rw {
                    Ok(Ok(lines)) => logln(&format!(
                        "[selftest] wxocr ok lines={} first={:?}",
                        lines.len(),
                        lines.first().map(|(t, _)| t.chars().take(40).collect::<String>())
                    )),
                    Ok(Err(e)) => logln(&format!("[selftest] wxocr FAIL {e}")),
                    Err(_) => logln("[selftest] wxocr join FAIL"),
                }
                // (2) 完整 OCR 链（服务优先，失败自动 wmocr 兜底）
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let url = format!("data:image/png;base64,{b64}");
                match ipc_invoke_inner(app.clone(), "capture-ocr-local".to_string(), vec![json!({ "dataURL": url })]).await {
                    Ok(v) => logln(&format!(
                        "[selftest] ocr-local success={} engine={} text={:?}",
                        v.get("success").and_then(|s| s.as_bool()).unwrap_or(false),
                        v.get("engine").and_then(|e| e.as_str()).unwrap_or("-"),
                        v.get("text").and_then(|t| t.as_str()).map(|s| s.chars().take(80).collect::<String>())
                    )),
                    Err(e) => logln(&format!("[selftest] ocr-local ERR {e}")),
                }
            }
            Err(e) => logln(&format!("[selftest] 读测试图失败 {e}")),
        },
        None => logln("[selftest] 找不到测试图（设 PETALSNAP_IPC_SELFTEST_IMG）"),
    }
    // (3) 纯文本翻译（服务批量优先 → Edge 兜底，哪条通算哪条）
    match ipc_invoke_inner(
        app.clone(),
        "capture-translate-text".to_string(),
        vec![json!({ "text": "Hello world, this is a PetalSnap fallback test.", "targetLanguage": "zh" })],
    )
    .await
    {
        Ok(v) => logln(&format!(
            "[selftest] translate-text success={} text={:?}",
            v.get("success").and_then(|s| s.as_bool()).unwrap_or(false),
            v.get("text").and_then(|t| t.as_str()).map(|s| s.chars().take(80).collect::<String>())
        )),
        Err(e) => logln(&format!("[selftest] translate-text ERR {e}")),
    }
    // (4) 模板清单
    match ipc_invoke_inner(app.clone(), "ask-ai-modes".to_string(), vec![]).await {
        Ok(v) => logln(&format!("[selftest] ask-ai-modes n={}", v.as_array().map(|a| a.len()).unwrap_or(0))),
        Err(e) => logln(&format!("[selftest] ask-ai-modes ERR {e}")),
    }
    // (4b) 设置窗通道冒烟（对齐 F1 契约）
    for (ch, args) in [
        ("settings:appInfo", vec![]),
        ("settings:getLoginItem", vec![]),
        ("screenshot-hotkey:get", vec![]),
        ("ocr:health", vec![]),
        ("ocr:chain-status", vec![]),
        ("settings:capabilities", vec![]),
    ] {
        match ipc_invoke_inner(app.clone(), ch.to_string(), args).await {
            Ok(v) => logln(&format!("[selftest] {ch} {}", v.to_string().chars().take(120).collect::<String>())),
            Err(e) => logln(&format!("[selftest] {ch} ERR {e}")),
        }
    }
    // (4c) 设置窗渲染冒烟：打开 → 等 settings.js 跑一轮 → 关闭（结果看 [js]/[settings] 日志行）
    if std::env::var("PETALSNAP_SETTINGS_SMOKE").unwrap_or_default() == "1" {
        logln("[selftest] settings window smoke start");
        open_settings(&app);
        let app_s = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_secs(4))).await;
            if let Some(w) = app_s.get_webview_window("settings") {
                let _ = w.close();
                logln("[selftest] settings window smoke closed");
            }
        });
    }
    // (5) 问 AI（需真实凭据；PETALSNAP_ASKAI_E2E=1 才跑）
    if std::env::var("PETALSNAP_ASKAI_E2E").unwrap_or_default() == "1" {
        match ipc_invoke_inner(
            app.clone(),
            "capture-ask-ai".to_string(),
            vec![json!({ "dataURL": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "question": "这张图是什么颜色？", "mode": "" })],
        )
        .await
        {
            Ok(v) => logln(&format!("[selftest] ask-ai {v}")),
            Err(e) => logln(&format!("[selftest] ask-ai ERR {e}")),
        }
    }
    logln("[selftest] end");
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
        .plugin(tauri_plugin_dialog::init())
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
            // 启动即清扫「父进程已死」的侧车 / llama-server 孤儿（2026-11-02 事故）：
            // 上一次崩溃或被强杀会留下一个 python 侧车 + 一个 llama-server（~1.2GB 显存）
            // 继续占着显存；不清的话，多开关几次就逼近 8GB 卡的极限。
            sweep_orphan_sidecars();
            // OCR 预热三档（对齐 F1 app/main.ts）：resident=启动 600ms 后拉起常驻；
            // capture-prewarm=会话触发时预热（见 start_session_ex）；on-demand=识别时才拉
            {
                let warm = read_ocr_warmup_mode();
                if warm == "resident" {
                    tauri::async_runtime::spawn(async move {
                        let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(600))).await;
                        logln("[ocr] 预热模式=resident（启动常驻）");
                        let _ = ensure_py_service().await;
                    });
                } else {
                    logln(&format!("[ocr] 预热模式={warm}（{}）", if warm == "on-demand" { "识别时才加载" } else { "会话触发时预热" }));
                }
            }
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

            // P1 自测钩子（PETALSNAP_IPC_SELFTEST=1）：绕过 UI 直接走真实 IPC 分发链，
            // 结果全量落 %TEMP%\petalsnap-spike.log。诊断专用，默认关。
            {
                let st_app = app.handle().clone();
                tauri::async_runtime::spawn(async move { run_ipc_selftest(st_app).await; });
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
            //   · PETALSNAP_SMART_TRIM 是像素收边的**负向开关**（2026-11-04）：
            //     0=关（退回纯 UIA 元素矩形），其它=开。默认开（capture.js 侧
            //     `process.env.PETALSNAP_SMART_TRIM !== '0'` ⇒ 不设即开），
            //     这里只放行 "0" 之外的值会让「关」传不过去 ⇒ 必须放行 "0"。
            //   · PETALSNAP_SMART_PREVIEW 是**预览层级口径**的负向开关（2026-11-05）：
            //     0=旧口径（默认最小元素框 + 滚轮绝对下标 + 换元素回落），
            //     其它=新口径（默认窗口级预览 + 相对深度）。同样必须放行 "0"。
            //   · 其余是布尔开关，只放行 0/1。
            let env_allow: [(&str, &[&str]); 6] = [
                ("PETALSNAP_SMART_DEBUG", &["1", "0"]),
                ("PETALSNAP_SMART_HOVER_MODE", &["1", "2", "0"]),
                ("PETALSNAP_SMART_TRIM", &["1", "0"]),
                ("PETALSNAP_SMART_PREVIEW", &["1", "0"]),
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

            // 托盘（2026-11-22 扩充）：截图入口 + 开机自启 + 直达识别设置/关于
            let snip_i = MenuItem::with_id(app, "snip", "立即截图 (F2)", true, None::<&str>)?;
            let snip_copy_i = MenuItem::with_id(app, "snipcopy", "截图并复制 (Alt+C)", true, None::<&str>)?;
            let autostart_i = CheckMenuItem::with_id(app, "autostart", "开机自启", true, login_item_get(), None::<&str>)?;
            let ocr_set_i = MenuItem::with_id(app, "settings-ocr", "识别设置…", true, None::<&str>)?;
            let set_i = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
            let about_i = MenuItem::with_id(app, "about", "关于拾花", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&snip_i, &snip_copy_i, &sep1, &autostart_i, &ocr_set_i, &set_i, &sep2, &about_i, &quit_i])?;
            let mut tray = TrayIconBuilder::with_id("spike-tray").menu(&menu).on_menu_event(|app, event| {
                match event.id().as_ref() {
                    "snip" => start_session(app),
                    "snipcopy" => start_session_ex(app, true),
                    "autostart" => {
                        let next = !login_item_get();
                        login_item_set(next);
                        logln(&format!("[tray] 开机自启 → {next}"));
                    }
                    "settings-ocr" => open_settings_page(app, "ocr"),
                    "settings" => open_settings(app),
                    "about" => open_settings_page(app, "about"),
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
            longshot::ls_gdi_raw,
            set_webview_dpr,
            clip_write_text,
            clip_write_image,
            open_external,
            js_log,
            win_close_self
        ])
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            match event {
                tauri::WindowEvent::Destroyed => {
                    if label.starts_with("pin-") {
                        PIN_LABELS.lock().unwrap().retain(|l| l != &label);
                        PIN_DRAGS.lock().unwrap().remove(&label);
                    }
                }
                // 设置窗关而不销毁：重开 = show 瞬时（WebView2 冷启动 ~1-2s 是「打开慢」主因）
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if label == "settings" {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                kill_py_service();
                wxocr_shutdown(); // 正常退出由 SDK 回收 worker/微信 OCR 子进程（强杀靠清扫兜底）
                logln("[app] exit");
            }
        });
}

fn open_settings(app: &AppHandle) {
    open_settings_page(app, "");
}

/// 打开设置窗（可带 ?page= 直达分区：托盘「识别设置…」「关于拾花」用）；
/// 窗口已存在时仅聚焦（不切换分区——避免打断正在填的表单）。
fn open_settings_page(app: &AppHandle, page: &str) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.unminimize();
        return;
    }
    let url = if page.is_empty() {
        "settings.html".to_string()
    } else {
        format!("settings.html?page={page}")
    };
    // F1 同款：880×660（min 760×560）、无边框（页面内标题栏）、背景色防白闪
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App(url.into()))
        .title("拾花 设置")
        .inner_size(880.0, 660.0)
        .min_inner_size(760.0, 560.0)
        .resizable(true)
        .decorations(false)
        .background_color(tauri::window::Color(0xfa, 0xf7, 0xf8, 0xff))
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
        // ── OCR/翻译：先确保 Python 侧车在线（复用 F1 实例或自拉起）；服务不可用/报错
        //    时走宿主内兜底（2026-11-19 P1 借鉴：wmocr = WinRT 系统 OCR，Edge = 免 key 翻译）。
        //    ⚠️ 修复 F2 两个现存 bug：① payload 键名 image → image_b64（原样发服务端读到空）；
        //    ② 本地翻译打到不存在的 /translate 路由（F1 走的是 /translate_image）。──
        "capture-ocr-local" | "capture-ocr" => {
            let data_url = a0.get("dataURL").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let png = data_url_png(&data_url);
            // 引擎优先级链（2026-11-22）：按用户排列顺序自动降级，替代固定 18766→wxocr→wmocr
            Ok(ocr_chain_value(png.as_deref()).await)
        }
        "capture-ocr-table" => {
            let data_url = a0.get("dataURL").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let png = data_url_png(&data_url);
            if let Some(png) = png.as_deref() {
                if ensure_py_service().await {
                    let res = proxy_18766_bytes("/table", png, Duration::from_secs(60)).await;
                    if let Some(mapped) = map_table_service_json(&res) {
                        return Ok(mapped);
                    }
                }
            }
            Ok(json!({ "success": false, "message": "本地识别服务不可用（表格识别无兜底引擎）" }))
        }
        "capture-ocr-smart" => {
            let data_url = a0.get("dataURL").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let png = data_url_png(&data_url);
            if let Some(png) = png.as_deref() {
                if ensure_py_service().await {
                    let res = proxy_18766_bytes("/smart", png, Duration::from_secs(120)).await;
                    if let Some(mapped) = map_ocr_service_json(&res) {
                        return Ok(mapped);
                    }
                }
            }
            Ok(json!({ "success": false, "message": "智能识别服务不可用（版面识别无兜底引擎）" }))
        }
        "capture-translate-local" => {
            let data_url = a0.get("dataURL").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let target = a0.get("targetLanguage").and_then(|v| v.as_str()).unwrap_or("zh").to_string();
            let png = data_url_png(&data_url);
            if png.as_deref().is_some() {
                if ensure_py_service().await {
                    let body = json!({ "image_b64": data_url, "target": to_target_name(&target) });
                    let res = proxy_18766_with("/translate_image", body, Duration::from_secs(300)).await;
                    if let Some(mapped) = map_translate_service_json(&res) {
                        return Ok(mapped);
                    }
                }
            }
            // 兜底②：兜底 OCR（wxocr 优先）文本 + 免 key 翻译（面板纯文本模式；translatedImage 留空）
            Ok(ocr_fallback_translate_value(png.as_deref(), &target).await)
        }
        // capture-translate = 云端引擎（需账号 token + F1 云 OCR/翻译 API，整链未迁）。
        // F2 原把它代理到 18766/translate —— 服务端没有该路由，恒 404；改为干净的
        // notPorted，渲染端按未迁移口径提示，而不是吞一个假错误。
        "capture-translate" => Ok(json!({ "success": false, "code": "notPorted" })),
        "capture-translate-text" => {
            let text = a0.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let target = a0.get("targetLanguage").and_then(|v| v.as_str()).unwrap_or("zh").to_string();
            let segments: Option<Vec<String>> = a0
                .get("segments")
                .and_then(|v| v.as_array())
                .filter(|a| a.len() > 1)
                .map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.to_string()).collect::<Vec<_>>());
            let texts = segments.clone().unwrap_or_else(|| vec![text.clone()]);
            let has_content = texts.iter().any(|t| !t.trim().is_empty());
            // 1) 服务批量（板块一一对应，llama 连续批处理）
            if has_content && ensure_py_service().await {
                let res = proxy_18766_with(
                    "/translate_batch",
                    json!({ "texts": texts, "target": to_target_name(&target) }),
                    Duration::from_secs(300),
                )
                .await;
                if res.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                    if let Some(arr) = res.get("translations").and_then(|v| v.as_array()) {
                        let translations: Vec<String> =
                            arr.iter().map(|x| x.as_str().unwrap_or("").to_string()).collect();
                        if translations.len() == texts.len() {
                            let joined = translations
                                .iter()
                                .map(|t| t.trim().to_string())
                                .filter(|t| !t.is_empty())
                                .collect::<Vec<_>>()
                                .join("\n\n");
                            if !joined.is_empty() {
                                return Ok(json!({ "success": true, "translations": translations, "text": joined }));
                            }
                        }
                    }
                }
            }
            // 2) 兜底②：免 key 翻译链 Edge → MyMemory（无需 18766 / llama；设置窗可关）
            if !has_content {
                return Ok(json!({ "success": false, "message": "没有可翻译的内容" }));
            }
            if !fallback_enabled("screenshot-fallback-freetranslate") {
                return Ok(json!({ "success": false, "message": "本地翻译服务不可用，且免 key 翻译兜底已在设置中关闭" }));
            }
            match free_translate_batch(&texts, &target).await {
                Ok((engine, translations)) => {
                    let joined = translations
                        .iter()
                        .map(|t| t.trim().to_string())
                        .filter(|t| !t.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    if joined.is_empty() {
                        Ok(json!({ "success": false, "message": "免 key 兜底翻译返回为空" }))
                    } else {
                        Ok(json!({ "success": true, "translations": translations, "text": joined, "engine": engine }))
                    }
                }
                Err(e) => Ok(json!({ "success": false, "message": e })),
            }
        }
        // ── 有意未迁移 / 已废弃的通道（2026-10-31 用户决定，非遗漏）──────────
        //  code 区分两种性质，渲染端才能给出正确提示而不是泛化报错：
        //  · notPorted  = 本轮不迁（录屏：见 Tauri迁移收尾方案 §4.1）
        //  · deprecated = 已废弃（PP-StructureV3 版面通道，主线已改 RapidOCR 路线）
        "capture-desktop-sources" => Ok(json!([])),
        "capture-desktop-source-for-window" => Ok(Value::Null),
        // ── 长截图（2026-11-24 迁移，宿主实现见 longshot.rs）──────────────
        // capture-longshot-gdi 走 ls_gdi_raw 二进制 command（shim 拦截转发），
        // 若仍有调用漏到 JSON 通道必须报错而不是返回空帧——渲染端会静默走回退路径。
        "capture-longshot-gdi" => Ok(json!({ "success": false, "code": "useRawCommand" })),
        "capture-longshot-frame" => Ok(longshot::frame_value(&app, &a0)),
        "capture-ls-autoscroll" => Ok(longshot::autoscroll(&app, &a0)),
        "capture-record-save" | "capture-record-ignore-mouse" => {
            Ok(json!({ "success": false, "code": "notPorted" }))
        }
        // 问 AI 移植 + 模板（2026-11-19 P1 借鉴）：选区图 + 问题/模板 → 用户自配置
        // OpenAI 兼容接口；凭据只读继承 F1 store（%APPDATA%\petalsnap）。
        "capture-ask-ai" => {
            let data_url = a0.get("dataURL").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let question = a0.get("question").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mode = a0.get("mode").and_then(|v| v.as_str()).unwrap_or("").to_string();
            Ok(ask_ai_invoke(&data_url, &question, &mode).await)
        }
        // 模板清单（resources/ask-ai-modes.json，用户可编辑；渲染端据此动态渲染问 AI 子菜单）
        "ask-ai-modes" => Ok(json!(load_ask_ai_modes())),
        // ── 宿主能力探测（2026-11-21 设置窗 F2 专属行开关）────────────────
        // Electron 主线无此通道 → settings.js 的 f2Only 行自动隐藏（双份同源不受影响）
        "settings:backup-now" => {
            // 立即备份：store 全部 JSON 打包单文件，滚动保留 10 份（同 F1 settingsBackupService 语义）
            match settings_backup_pack() {
                Ok(content) => {
                    let dir = settings_backup_dir();
                    let _ = std::fs::create_dir_all(&dir);
                    let fp = dir.join(format!("settings-{}.json", settings_backup_stamp()));
                    match std::fs::write(&fp, &content) {
                        Ok(_) => {
                            settings_backup_prune(&dir);
                            logln(&format!("[backup] {} ({}B)", fp.display(), content.len()));
                            Ok(json!({ "ok": true, "path": fp.display().to_string() }))
                        }
                        Err(e) => Ok(json!({ "ok": false, "message": format!("写入失败: {e}") })),
                    }
                }
                Err(e) => Ok(json!({ "ok": false, "message": e })),
            }
        }
        "settings:export" => {
            match settings_backup_pack() {
                Ok(content) => {
                    use tauri_plugin_dialog::DialogExt;
                    let file = {
                        let mut d = app.dialog()
                            .file()
                            .add_filter("JSON", &["json"])
                            .set_file_name(format!("petalsnap-settings-{}.json", settings_backup_stamp()));
                        if let Some(w) = app.get_webview_window("settings") {
                            d = d.set_parent(&w);
                        }
                        d.blocking_save_file()
                    };
                    match file {
                        Some(p) => match p.into_path() {
                            Ok(path) => match std::fs::write(&path, &content) {
                                Ok(_) => Ok(json!({ "ok": true, "path": path.display().to_string() })),
                                Err(e) => Ok(json!({ "ok": false, "message": format!("写入失败: {e}") })),
                            },
                            Err(e) => Ok(json!({ "ok": false, "message": format!("路径无效: {e}") })),
                        },
                        None => Ok(json!({ "ok": false, "message": "canceled" })),
                    }
                }
                Err(e) => Ok(json!({ "ok": false, "message": e })),
            }
        }
        "settings:import" => {
            use tauri_plugin_dialog::DialogExt;
            let file = {
                let mut d = app.dialog()
                    .file()
                    .add_filter("JSON", &["json"]);
                if let Some(w) = app.get_webview_window("settings") {
                    d = d.set_parent(&w);
                }
                d.blocking_pick_file()
            };
            let Some(p) = file else { return Ok(json!({ "ok": false, "message": "canceled" })) };
            let path = match p.into_path() {
                Ok(v) => v,
                Err(e) => return Ok(json!({ "ok": false, "message": format!("路径无效: {e}") })),
            };
            match settings_import_replace(&path) {
                Ok(count) => {
                    logln(&format!("[backup] imported {} keys from {}", count, path.display()));
                    Ok(json!({ "ok": true, "count": count, "needRestart": true }))
                }
                Err(e) => Ok(json!({ "ok": false, "message": e })),
            }
        }
        "settings:backup-dir" => {
            let dir = settings_backup_dir();
            let _ = std::fs::create_dir_all(&dir);
            Ok(json!(dir.display().to_string()))
        }
        "settings:backup-list" => {
            // 备份列表（新→旧）：{name, size, mtime}
            let dir = settings_backup_dir();
            let mut items: Vec<Value> = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if !(name.starts_with(BACKUP_PREFIX) && name.ends_with(".json")) {
                        continue;
                    }
                    let (size, mtime) = match e.metadata() {
                        Ok(m) => (
                            m.len(),
                            m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0),
                        ),
                        Err(_) => (0, 0),
                    };
                    items.push(json!({ "name": name, "size": size, "mtime": mtime }));
                }
            }
            items.sort_by(|a, b| b["mtime"].as_u64().cmp(&a["mtime"].as_u64()));
            Ok(json!(items))
        }
        "settings:backup-restore" => {
            // 恢复到指定备份：安全校验（仅文件名，防路径穿越）→ 复用整体替换（自带导入前备份）
            let name = a0.as_str().map(String::from)
                .or_else(|| a0.get("name").and_then(|v| v.as_str()).map(String::from))
                .unwrap_or_default();
            if name.is_empty() || name.contains('/') || name.contains(char::from_u32(92).unwrap()) || name.contains("..") {
                return Ok(json!({ "ok": false, "message": "非法备份文件名" }));
            }
            let path = settings_backup_dir().join(&name);
            match settings_import_replace(&path) {
                Ok(count) => {
                    logln(&format!("[backup] restored {} keys from {}", count, name));
                    Ok(json!({ "ok": true, "count": count, "needRestart": true }))
                }
                Err(e) => Ok(json!({ "ok": false, "message": e })),
            }
        }
        "settings:capabilities" => {
            let ask_modes = resolve_resource("", "ask-ai-modes.json")
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            Ok(json!({
                "host": "f2",
                "wxocrFallback": true,
                "wmocrFallback": true,
                "freeTranslate": true,
                "longshot": true,   // 2026-11-24 已迁移（longshot.rs）：GDI 抓帧/滚轮注入/透传轮询/编辑器/拆分保存
                "record": false,    // 同上（录屏）
                "askModesPath": ask_modes,
            }))
        }
        // ── 设置窗通道组（2026-11-21 设置窗整体迁移，契约对齐 F1 app/main.ts）──
        "screenshot-hotkey:get" => {
            Ok(store_load()
                .get("screenshot-hotkey")
                .cloned()
                .unwrap_or_else(|| store_default("screenshot-hotkey")))
        }
        "screenshot-hotkey:set" => {
            let accel = a0.as_str().unwrap_or("").trim().to_string();
            Ok(json!(set_configured_hotkey(&app, &accel).await))
        }
        "settings:getLoginItem" => Ok(json!(login_item_get())),
        "settings:setLoginItem" => {
            let enable = a0.as_bool().unwrap_or(false);
            login_item_set(enable);
            Ok(json!(true))
        }
        "settings:openPath" => {
            let which = a0.as_str().unwrap_or("").to_string();
            Ok(json!(tauri::async_runtime::spawn_blocking(move || settings_open_path(&which))
                .await
                .unwrap_or(false)))
        }
        "settings:pickFolder" => {
            use tauri_plugin_dialog::{DialogExt, FilePath};
            let app2 = app.clone();
            // set_parent(设置窗) → 模态：父窗被禁用，点击它 Windows 自动把对话框带回前台
            //（此前无父窗=非模态，连击可弹多个）
            let picked = tauri::async_runtime::spawn_blocking(move || {
                let mut d = app2.dialog().file().set_title("选择目录");
                if let Some(w) = app2.get_webview_window("settings") {
                    d = d.set_parent(&w);
                }
                d.blocking_pick_folder()
            })
            .await
            .ok()
            .flatten()
            .and_then(|p| match p {
                FilePath::Path(pb) => Some(pb.to_string_lossy().into_owned()),
                _ => None,
            });
            Ok(json!(picked))
        }
        "settings:appInfo" => {
            let h = ocr_health_value().await;
            let ocr = if h.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                format!(
                    "{} · {} · :{}",
                    h.get("backend").and_then(|v| v.as_str()).unwrap_or("GPU"),
                    h.get("build").and_then(|v| v.as_str()).unwrap_or("ready"),
                    h.get("port").and_then(|v| v.as_u64()).unwrap_or(18766)
                )
            } else {
                "未运行".to_string()
            };
            Ok(json!({ "version": env!("CARGO_PKG_VERSION"), "ocr": ocr }))
        }
        "ocr:health" => Ok(ocr_health_value().await),
        "ocr:asset-status" => {
            // 可选资产状态（设置窗 modelsList）：服务模型 + langPack=null（F2 无 Tesseract 引擎）
            let h = ocr_health_value().await;
            let models = h.get("models").cloned().unwrap_or(json!({}));
            Ok(json!({ "models": models, "langPack": Value::Null }))
        }
        "ocr:chain-status" => {
            // 引擎优先级链状态（设置页灰/红/下载图标；探测不拉起服务）。
            // wmocr 语言包真实探测：系统识别语言里有没有中文（spawn_blocking + MTA）。
            let rapid = port_listening(18766);
            let paddle = port_listening(18765);
            let wx_sdk = resolve_wxocr_sdk_dir().is_some();
            let wm_lang = tauri::async_runtime::spawn_blocking(wmocr_langpack_available).await
                .unwrap_or(false);
            Ok(json!({
                "rapidocr": if rapid { json!({"state": "ready", "reason": ""}) } else { json!({"state": "off", "reason": "未运行 · 识别时自动拉起（约 2s）"}) },
                "paddle": if paddle { json!({"state": "ready", "reason": ""}) } else { json!({"state": "off", "reason": "侧车未运行 · 识别时自动尝试拉起"}) },
                "tesseract": json!({"state": "off", "reason": "当前版本不可用"}),
                "wxocr": if wx_sdk { json!({"state": "ready", "reason": ""}) } else { json!({"state": "missing", "reason": "引擎组件缺失 · 重新安装应用可修复"}) },
                "wmocr": if wm_lang { json!({"state": "ready", "reason": ""}) } else { json!({"state": "missing", "reason": "缺系统语言包 · Windows 设置 → 时间和语言 → 语言 → 添加「中文(简体)」的光学字符识别"}) },
                "server": json!({"state": "off", "reason": "当前版本不可用"})
            }))
        }
        "ocr:restart" => {
            kill_py_service();
            Ok(json!(ensure_py_service().await))
        }
        "ocr:model-download" => {
            // 可选模型手动下载（2026-11-22 缺口1）：转发 18766 /models/download
            // 渲染端 invoke('ocr:model-download', id) 传的是位置字符串，a0 即字符串；
            // 兼容对象形态 {id}，否则恒空 id → 恒「未知模型 id」
            let id = a0.as_str().map(String::from)
                .or_else(|| a0.get("id").and_then(|v| v.as_str()).map(String::from))
                .unwrap_or_default();
            match reqwest::Client::builder()
                .timeout(Duration::from_secs(600))
                .build()
            {
                Ok(client) => {
                    match client
                        .post("http://127.0.0.1:18766/models/download")
                        .json(&json!({ "id": id }))
                        .send()
                        .await
                    {
                        Ok(r) => Ok(r.json().await.unwrap_or(json!({ "ok": false, "message": "下载响应解析失败" }))),
                        Err(e) => Ok(json!({ "ok": false, "message": format!("下载请求失败: {e}") })),
                    }
                }
                Err(e) => Ok(json!({ "ok": false, "message": format!("HTTP 客户端构建失败: {e}") })),
            }
        }
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
        // ── 设置窗窗口控制（无边框窗的页面内标题栏，2026-11-21 设置窗迁移）──
        "settings:minimize" => {
            let _ = window.minimize();
        }
        "settings:toggle-max" => {
            if window.is_maximized().unwrap_or(false) {
                let _ = window.unmaximize();
            } else {
                let _ = window.maximize();
            }
        }
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
        // ── 长截图（2026-11-24 迁移，见 longshot.rs）────────────────────
        "capture-ls-active" => longshot::set_active(&app, &a0),
        "capture-ls-debug" => longshot::debug_dump(&a0),
        "capture-longshot-save" => longshot::save_tiles(&a0),
        "capture-longshot-editor" => longshot::editor(&app, &a0),
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
                        // 默认目录读设置（通用页「保存」分组）；空 = 系统「图片」
                        let save_dir_cfg = store_load()
                            .get("screenshot-save-dir")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.trim().is_empty())
                            .map(PathBuf::from);
                        let pics = save_dir_cfg.unwrap_or_else(|| {
                            std::env::var("USERPROFILE")
                                .map(|u| PathBuf::from(u).join("Pictures"))
                                .unwrap_or_else(|_| std::env::temp_dir())
                        });
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

/// CF_HTML（注册名 "HTML Format"）包装：Windows 剪贴板富文本不是裸 HTML，而是
/// 「定长偏移头 + UTF-8 文档」，Excel/WPS 靠 Start/EndFragment 定位真正的表格片段。
/// 偏移按**字节**计（不是字符数），头里的数字是定长 10 位十进制——替换必须等长，
/// 否则后面所有偏移一起错位（粘贴出来就是纯文本或乱码）。
fn build_cf_html(html: &str) -> Vec<u8> {
    const HEADER: &str = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
    const FRAG_OPEN: &str = "<!--StartFragment-->";
    const FRAG_CLOSE: &str = "<!--EndFragment-->";
    let mut body = html.to_string();
    // 先圈片段、再包文档：让 Start/EndFragment 恰好框住调用方给的表格本身，
    // 而不是整个 <html> 文档（否则 Excel 会把文档标记一起当内容处理）
    if !body.contains(FRAG_OPEN) {
        body = format!("{FRAG_OPEN}{body}{FRAG_CLOSE}");
    }
    if !body.to_ascii_lowercase().contains("<html") {
        body = format!("<html><body>{body}</body></html>");
    }
    let sf = body.find(FRAG_OPEN).map(|i| i + FRAG_OPEN.len()).unwrap_or(0);
    let ef = body.find(FRAG_CLOSE).unwrap_or(body.len());
    let start_html = HEADER.len();
    let mut head = HEADER.to_string();
    for (k, v) in [
        ("StartHTML", start_html),
        ("EndHTML", start_html + body.len()),
        ("StartFragment", start_html + sf),
        ("EndFragment", start_html + ef),
    ] {
        head = head.replacen(&format!("{k}:0000000000"), &format!("{k}:{v:010}"), 1);
    }
    let mut out = head.into_bytes();
    out.extend_from_slice(body.as_bytes());
    out.push(0); // 剪贴板文本格式以 NUL 结尾
    out
}

unsafe fn set_clipboard_html(html: &str) {
    use windows::Win32::System::DataExchange::{
        CloseClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::Foundation::HANDLE;
    let bytes = build_cf_html(html);
    let cf = unsafe { RegisterClipboardFormatW(w!("HTML Format")) };
    if cf == 0 {
        logln("[clip] RegisterClipboardFormatW(HTML Format) 失败，本次仅纯文本");
        return;
    }
    // 剪贴板可能被其它程序短暂占用（截图/同步工具常见），重试 5×50ms
    let mut opened = false;
    for _ in 0..5 {
        if unsafe { OpenClipboard(HWND::default()) }.is_ok() {
            opened = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if !opened {
        logln("[clip] OpenClipboard 被占用，本次仅纯文本");
        return;
    }
    // ⚠️ 不 EmptyClipboard：纯文本已由 clipboard 插件写入，这里只**追加** CF_HTML 一种格式
    if let Ok(hg) = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) } {
        let p = unsafe { GlobalLock(hg) };
        if !p.is_null() {
            unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, bytes.len()) };
            let _ = unsafe { GlobalUnlock(hg) };
            // 成功后内存所有权移交系统，不能 GlobalFree
            if unsafe { SetClipboardData(cf, HANDLE(hg.0)) }.is_err() {
                logln("[clip] SetClipboardData(CF_HTML) 失败");
            }
        }
    }
    let _ = unsafe { CloseClipboard() };
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

// ── 回归测试（2026-11-02「整机崩溃」事故）────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;

    /// CF_HTML 偏移必须指向**字节**位置：头里数字等长替换、中文按 UTF-8 字节计。
    /// 任何一处错位，Excel/WPS 粘贴就退化成纯文本——这正是本功能唯一的故障模式。
    #[test]
    fn cf_html_offsets_point_at_fragment_bytes() {
        let html = "<table><tr><td>甲</td></tr></table>";
        let bytes = build_cf_html(html);
        assert_eq!(bytes.last(), Some(&0), "剪贴板文本必须 NUL 结尾");
        let text = String::from_utf8_lossy(&bytes);
        let get = |k: &str| -> usize {
            let pat = format!("{k}:");
            let i = text.find(&pat).unwrap() + pat.len();
            text[i..i + 10].parse::<usize>().unwrap()
        };
        let (sh, eh, sf, ef) = (
            get("StartHTML"),
            get("EndHTML"),
            get("StartFragment"),
            get("EndFragment"),
        );
        assert!(bytes[sh..].starts_with(b"<html>"), "StartHTML 未落在头部之后");
        assert_eq!(&bytes[sf..ef], html.as_bytes(), "片段偏移与真实表格字节不一致");
        assert_eq!(eh, bytes.len() - 1);
        // 片段区间必须在文档区间内，且头部长度未被替换撑变
        assert!(sh < sf && sf < ef && ef <= eh);
    }

    /// Job Object 回归测试：侧车必须能被「宿主消失」连树带走。
    ///
    /// 验证两件事：
    ///   ① AssignProcessToJobObject 真的把子进程收进了 Job
    ///      （否则 terminate/close 杀不到它 → 侧车会变孤儿）；
    ///   ② 关掉 Job 句柄（KILL_ON_JOB_CLOSE）会把整棵树带走 —— 这与
    ///      「宿主进程被强杀」是 OS 走的**同一条路径**（宿主死 → 它的句柄关闭
    ///      → Job 连树陪葬）。
    ///
    /// 回归意义：哪天 Job 创建/赋值失效了，这个测试就会红 —— 那正是侧车
    /// 变孤儿、显存被吃光、整机崩溃的起点。
    #[test]
    fn job_object_kills_process_tree_on_close() {
        let Some(job) = create_kill_on_close_job() else {
            panic!("CreateJobObjectW 失败：本机不支持 Job Object");
        };
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "ping -n 120 127.0.0.1 > nul"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .expect("spawn child");
        let pid = child.id();
        assert!(assign_to_job(job, pid), "AssignProcessToJobObject 失败");

        // 子进程此刻应仍在运行（cmd 会等 ping 结束）
        assert!(child.try_wait().unwrap().is_none(), "子进程应仍在运行");

        // 关闭 Job 句柄 → KILL_ON_JOB_CLOSE → 连树杀
        close_job(job);

        let mut died = false;
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(20));
            if child.try_wait().unwrap().is_some() {
                died = true;
                break;
            }
        }
        let _ = child.kill();
        assert!(died, "关闭 Job 句柄后子进程仍未被杀 —— Job Object 机制失效，侧车会变孤儿");
    }

    /// 用一次 PowerShell 调用查出一组 PID 里**仍然存活**的。
    /// （wmic 在 Win11 已被移除，只能用 Get-Process / Get-CimInstance。）
    fn alive_pids(pids: &[u32]) -> Vec<u32> {
        if pids.is_empty() {
            return Vec::new();
        }
        let list = pids
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let script = format!(
            "$out=@(); foreach($i in @({})){{ if (Get-Process -Id $i -EA SilentlyContinue) {{ $out += $i }} }}; $out -join ','",
            list
        );
        let Ok(o) = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
        else {
            return pids.to_vec();
        };
        String::from_utf8_lossy(&o.stdout)
            .split(',')
            .filter_map(|s| s.trim().parse::<u32>().ok())
            .collect()
    }

    /// 列出某个 PID 的**直接子进程**（Get-CimInstance 的 ParentProcessId）。
    fn children_of(parent: u32) -> Vec<u32> {
        let script = format!(
            "(Get-CimInstance Win32_Process -Filter \"ParentProcessId={}\" | ForEach-Object {{ $_.ProcessId }}) -join ','",
            parent
        );
        let Ok(o) = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
        else {
            return Vec::new();
        };
        String::from_utf8_lossy(&o.stdout)
            .split(',')
            .filter_map(|s| s.trim().parse::<u32>().ok())
            .collect()
    }

    /// 生产路径回归：侧车**必须**被收进 kill-on-close Job，且**连孙进程一起**。
    ///
    /// 用一份 dummy 脚本冒充 rapidocr_service.py（不加载任何模型，秒起），
    /// 走**与生产完全相同**的 spawn_py_sidecar()，然后验证：
    ///   ① 侧车活着；
    ///   ② PY_JOB 拿到了句柄（= assign 成功）；
    ///   ③ terminate_job 之后转发器**和它的子进程**都必须死。
    ///
    /// ③ 为什么必须查孙进程：本机 venv 的 `Scripts\python.exe` 是**转发器**——它自己
    /// 再拉起一个真正的解释器进程来跑我们的脚本。也就是说宿主 spawn 出来的是转发器，
    /// 真正跑侧车逻辑的是**孙进程**。若孙进程没继承 Job，Job 就只护住了转发器，
    /// 侧车本体照样会变孤儿（正是 2026-11-02 整机崩溃事故的成因）。
    /// 判据是决定性的：Windows 上父进程被 kill **不会**连带杀子进程 →
    /// 孙进程死了就只可能是被 Job 连带杀的。
    #[test]
    fn production_spawn_puts_sidecar_into_kill_on_close_job() {
        let dummy = std::env::temp_dir().join("petalsnap-test-sidecar.py");
        std::fs::write(&dummy, "import time\ntime.sleep(300)\n").expect("write dummy sidecar");
        std::env::set_var("PETALSNAP_RAPIDOCR_SCRIPT", &dummy);

        assert!(spawn_py_sidecar(), "spawn_py_sidecar 失败（python 解释器或脚本找不到？）");

        let job = PY_JOB.lock().unwrap().take();
        let job = job.expect("侧车没有被收进 Job（PY_JOB 为空）—— 它会变成孤儿");

        let launcher_pid = PY_CHILD.lock().unwrap().as_ref().map(|c| c.id()).unwrap_or(0);
        assert!(launcher_pid > 0, "拿不到侧车 PID");

        // 转发器的子进程 = 真正在跑我们脚本的解释器
        let mut grandchildren = Vec::new();
        for _ in 0..40 {
            grandchildren = children_of(launcher_pid);
            if !grandchildren.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !grandchildren.is_empty(),
            "没找到转发器的子进程（真解释器）—— 测试前提不成立（venv python 可能不再是转发器）"
        );

        assert!(terminate_job(job), "terminate_job 失败");

        // 转发器必须死
        let mut launcher_dead = false;
        for _ in 0..150 {
            std::thread::sleep(Duration::from_millis(20));
            if alive_pids(&[launcher_pid]).is_empty() {
                launcher_dead = true;
                break;
            }
        }
        // 孙进程（真解释器）也必须死 → 证明它在同一个 Job 里
        let mut grandchild_dead = false;
        for _ in 0..150 {
            std::thread::sleep(Duration::from_millis(20));
            if alive_pids(&grandchildren).is_empty() {
                grandchild_dead = true;
                break;
            }
        }

        // 清理（测试失败也别留残留进程）
        if let Some(mut c) = PY_CHILD.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        close_job(job);
        for g in &grandchildren {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &g.to_string()])
                .creation_flags(0x0800_0000)
                .output();
        }
        let _ = std::fs::remove_file(&dummy);
        assert!(launcher_dead, "terminate_job 后转发器仍存活");
        assert!(
            grandchild_dead,
            "terminate_job 后孙进程（真解释器）仍存活 —— 它没继承 Job，侧车本体还是会变孤儿！"
        );
    }

    /// 「端口有人监听但不健康」时不能再拉第二个侧车（否则多出一个 llama-server）。
    #[test]
    fn port_listening_detects_bound_socket() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = l.local_addr().unwrap().port();
        assert!(port_listening(port), "已监听端口应被判定为在监听");
        drop(l);
    }

    // ── P1 借鉴（2026-11-19）：OCR 兜底 / Edge 翻译 / 问 AI 模板 ──────────────

    #[test]
    fn data_url_png_parses_and_rejects() {
        use base64::Engine as _;
        let png = [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        let url = format!("data:image/png;base64,{b64}");
        assert_eq!(data_url_png(&url).unwrap(), png);
        assert!(data_url_png("not-a-dataurl").is_none());
        assert!(data_url_png("data:text/plain;base64,AAAA").is_none());
    }

    #[test]
    fn language_code_maps() {
        assert_eq!(to_target_name("zh"), "中文");
        assert_eq!(to_target_name("ja"), "日语");
        assert_eq!(to_target_name("xx"), "中文");
        assert_eq!(edge_to_code("zh"), "zh-Hans");
        assert_eq!(edge_to_code("en"), "en");
        assert_eq!(edge_to_code("xx"), "zh-Hans");
    }

    #[test]
    fn ocr_service_json_mapping() {
        let res = json!({ "ok": true, "ms": 12, "markdown": "# 标题\n正文",
                          "modules": [ { "box": [0.0, 0.0, 1.0, 1.0], "text": "a" },
                                       { "box": [0.0, 1.0, 2.0, 2.0], "text": "b" } ] });
        let v = map_ocr_service_json(&res).unwrap();
        assert_eq!(v["success"], true);
        assert_eq!(v["text"], "# 标题\n正文");
        assert_eq!(v["engine"], "rapidocr");
        assert_eq!(v["modules"].as_array().unwrap().len(), 2);
        // 单板块不外发 modules（F1 finalizeRapidText 同口径）
        let res2 = json!({ "ok": true, "paragraphs": ["段落一", "段落二"],
                           "modules": [ { "box": [0.0, 0.0, 1.0, 1.0], "text": "a" } ] });
        let v2 = map_ocr_service_json(&res2).unwrap();
        assert_eq!(v2["text"], "段落一\n\n段落二");
        assert!(v2.get("modules").is_none());
        // paragraphs 缺失 → lines 兜底；服务报错/空 → None（触发宿主兜底）
        let res3 = json!({ "ok": true, "lines": [ { "text": "行一" }, { "text": "行二" } ] });
        assert_eq!(map_ocr_service_json(&res3).unwrap()["text"], "行一\n行二");
        assert!(map_ocr_service_json(&json!({ "ok": false, "error": "boom" })).is_none());
        assert!(map_ocr_service_json(&json!({ "ok": true, "lines": [] })).is_none());
        // 行框透传（隐私打码）：带 box 的行外发，缺 box 的行丢弃；全缺则不带 lines 字段
        let res4 = json!({ "ok": true, "lines": [
            { "text": "电话13812345678", "box": [10.0, 20.0, 300.0, 44.0] },
            { "text": "无框行" } ] });
        let v4 = map_ocr_service_json(&res4).unwrap();
        assert_eq!(v4["lines"].as_array().unwrap().len(), 1);
        assert_eq!(v4["lines"][0]["box"][2], 300.0);
        assert!(map_ocr_service_json(&res3).unwrap().get("lines").is_none());
    }

    #[test]
    fn table_and_translate_service_json_mapping() {
        let t = json!({ "ok": true, "html": "<table><tr><td>1</td></tr></table>", "rows": 1 });
        let v = map_table_service_json(&t).unwrap();
        assert_eq!(v["success"], true);
        assert!(v["html"].as_str().unwrap().contains("<table>"));
        assert!(map_table_service_json(&json!({ "ok": false })).is_none());
        let tr = json!({ "ok": true, "image": "data:image/png;base64,AAA", "text": "你好" });
        let v2 = map_translate_service_json(&tr).unwrap();
        assert_eq!(v2["translatedText"], "你好");
        assert!(v2["translatedImage"].as_str().unwrap().starts_with("data:image/"));
        assert!(map_translate_service_json(&json!({ "ok": true, "image": "", "text": "" })).is_none());
    }

    #[test]
    fn ask_ai_modes_load_and_have_unique_ids() {
        let modes = load_ask_ai_modes();
        assert!(!modes.is_empty(), "模板清单不应为空（文件缺失时也有内置默认）");
        let mut ids: Vec<&str> = modes.iter().filter_map(|m| m.get("id").and_then(|v| v.as_str())).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "模板 id 不得重复");
        assert!(modes.iter().all(|m| m
            .get("prompt")
            .and_then(|v| v.as_str())
            .map(|p| !p.trim().is_empty())
            .unwrap_or(false)));
    }

    #[test]
    fn ask_ai_request_body_resolves_template() {
        let cfg = ("https://api.example.com/v1".to_string(), "sk-test".to_string(), "test-model".to_string());
        let tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        // 无 mode → 默认问题 + 无 system 消息
        let (url, body) = ask_ai_request_body(cfg.clone(), tiny, "", "").unwrap();
        assert!(url.ends_with("/chat/completions"));
        assert_eq!(body["model"], "test-model");
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1, "无模板时不应有 system 消息");
        assert_eq!(msgs[0]["role"], "user");
        // latex 模板 → 注入 system 消息 + 模板 prompt
        let (_u2, body2) = ask_ai_request_body(cfg.clone(), tiny, "", "latex").unwrap();
        let msgs2 = body2["messages"].as_array().unwrap();
        assert_eq!(msgs2.len(), 2, "latex 模板应注入 system 消息");
        assert_eq!(msgs2[0]["role"], "system");
        assert!(msgs2[1]["content"][0]["text"].as_str().unwrap().contains("LaTeX"));
        // summarize 模板带 temperature；图像无效 → Err
        let (_u3, body3) = ask_ai_request_body(cfg.clone(), tiny, "", "summarize").unwrap();
        assert_eq!(body3["temperature"], 0.5);
        assert!(ask_ai_request_body(cfg, "http://not-a-data-url", "", "").is_err());
    }

    /// send_ask_ai 对 mock OpenAI 兼容端点的成功路径（真实 reqwest + 真实 HTTP 往返）
    #[test]
    fn send_ask_ai_against_mock_endpoint() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            use std::io::{BufRead, BufReader, Write};
            let (stream, _) = listener.accept().expect("accept");
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            loop {
                line.clear();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                if line == "\r\n" || line == "\n" {
                    break;
                }
            }
            let body = r#"{"choices":[{"message":{"content":"这是一张测试图片。"}}]}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let mut s = stream;
            s.write_all(resp.as_bytes()).unwrap();
            s.flush().unwrap();
        });
        let cfg = (format!("http://{addr}/v1"), "sk-test".to_string(), "test-model".to_string());
        let tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let (_url, body) = ask_ai_request_body(cfg.clone(), tiny, "", "").unwrap();
        let v = tauri::async_runtime::block_on(send_ask_ai(cfg, format!("http://{addr}/v1/chat/completions"), body));
        assert_eq!(v["success"], true, "mock 端点应成功: {v}");
        assert_eq!(v["text"], "这是一张测试图片。");
        handle.join().unwrap();
    }

    /// 真实 WinRT OCR + 真图（本机已装 zh-Hans-CN 语言包）。测试图缺失时跳过。
    #[test]
    fn wmocr_real_image() {
        let Some(p) = resolve_resource("", "temp/bench_text.png") else {
            eprintln!("测试图缺失，跳过");
            return;
        };
        let png = std::fs::read(&p).expect("read png");
        let lines = wmocr_png(&png).expect("wmocr 执行失败");
        assert!(!lines.is_empty(), "bench_text.png 应识别出文字行");
        // CJK 空格除噪生效：首行不应再有「深 度 学 习」式逐字空格
        let first = &lines[0].0;
        assert!(!first.contains("深 度"), "CJK 间空格应被合并: {first:?}");
        println!("wmocr lines={} first={:?}", lines.len(), lines.first().map(|(t, _)| t.clone()));
    }

    /// 真实微信 OCR（MaaXYZ SDK + 本机微信 4.x runtime，AGPL SDK 在仓库外 wxocr-sdk/）。
    /// SDK/微信缺失时跳过。
    #[test]
    fn wxocr_real_image() {
        if resolve_wxocr_sdk_dir().is_none() {
            eprintln!("wxocr-sdk 未部署，跳过");
            return;
        }
        let Some(p) = resolve_resource("", "temp/bench_text.png") else {
            eprintln!("测试图缺失，跳过");
            return;
        };
        let png = std::fs::read(&p).expect("read png");
        let lines = wxocr_png(&png).expect("wxocr 执行失败");
        assert!(!lines.is_empty(), "bench_text.png 应识别出文字行");
        println!("wxocr lines={} first={:?}", lines.len(), lines.first().map(|(t, _)| t.clone()));
    }

    #[test]
    fn collapse_cjk_spaces_merges_only_between_cjk() {
        assert_eq!(collapse_cjk_spaces("深 度 学 习"), "深度学习");
        assert_eq!(collapse_cjk_spaces("深度学习"), "深度学习");
        // 中英文边界空格保留
        assert_eq!(collapse_cjk_spaces("深度学习 AI"), "深度学习 AI");
        assert_eq!(collapse_cjk_spaces("a b c"), "a b c");
        assert_eq!(collapse_cjk_spaces("你好，世 界！"), "你好，世界！");
    }

    /// 真网 Edge 免 key 翻译（默认忽略，手动跑：cargo test edge_live -- --ignored）
    #[test]
    #[ignore = "真实外网请求（Microsoft Edge 免 key 翻译）"]
    fn edge_live_translate() {
        let texts = vec!["Hello world".to_string(), "Screenshot tool".to_string()];
        let out = tauri::async_runtime::block_on(edge_translate_batch(&texts, "zh-Hans")).expect("edge translate");
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|t| !t.trim().is_empty()), "Edge 译文不应为空");
        println!("edge zh: {out:?}");
    }

    /// 免 key 翻译链真网验证（Edge → MyMemory；本机 Edge auth 404 → 应落 MyMemory 成功）
    #[test]
    #[ignore = "真实外网请求（免 key 翻译链）"]
    fn free_translate_chain_live() {
        let texts = vec!["Hello world".to_string(), "Screenshot tool".to_string()];
        let (engine, out) = tauri::async_runtime::block_on(free_translate_batch(&texts, "zh")).expect("free translate");
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|t| !t.trim().is_empty()), "译文不应为空");
        println!("chain engine={engine} out={out:?}");
        // MyMemory 源语言猜测试
        assert_eq!(mymemory_src_for("hello", "zh-CN"), Some("en"));
        assert_eq!(mymemory_src_for("你好世界", "zh-CN"), None);
        assert_eq!(mymemory_src_for("こんにちは", "zh-CN"), Some("ja"));
    }
}
