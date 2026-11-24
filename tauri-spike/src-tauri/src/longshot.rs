// 长截图宿主（F2）：对齐 F1 `main/ipc/window/capture.ts` 的 7 条通道语义。
//
// 与 F1 的两点本质差异（由 F2 的坐标模型决定，不是简化）：
//  1. F1 的洞/选区是 **DIP**，要 dipToScreenPoint 换算；F2 是「单一 dpr 表面」
//     （窗口 CSS = 桌面物理 ÷ 主屏 dpr，见 main.rs start_session_ex），所以这里
//     **全程物理像素**：洞 = 窗口物理原点 + sel(CSS) × 主屏 dpr，不做逐屏 DIP 换算。
//  2. `capture-longshot-gdi` 的返回是 w*h*4 字节的 BGRA——**绝不能走 JSON 通道**
//     （2026-10-31 的 29.5MB 摊平事故）。F2 改走 `ls_gdi_raw` 二进制 command
//     （tauri::ipc::Response），由 ui/shim.js 解包成渲染端期望的 {buf,w,h}。
//
// 滚轮策略与 F1 r49 方案B 完全一致：PostMessageW WM_MOUSEWHEEL 直达选区中心下方的
// 窗口（Chromium 优先 Chrome_RenderWidgetHostHWND 子窗口，前台/焦点/光标位置均无关），
// 失败才退回 mouse_event（此时需要光标在洞内 + 窗口透传）。绝不移动用户光标。

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateDCW, DeleteDC, DeleteObject, GetDIBits,
    GetMonitorInfoW, MonitorFromPoint, SelectObject, BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT,
    DIB_RGB_COLORS, HDC, HGDIOBJ, MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{mouse_event, MOUSEEVENTF_WHEEL};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, GetAncestor, GetClassNameW, GetCursorPos, IsWindow, PostMessageW,
    SetForegroundWindow, WindowFromPoint, GA_ROOT, WM_MOUSEWHEEL,
};

use crate::{logln, primary_scale_factor, settings_target_dir};

/// 选区洞（**物理**屏幕坐标 x,y,w,h），active on 时写入，off/会话结束清空
static LS_HOLE: Mutex<Option<(i32, i32, i32, i32)>> = Mutex::new(None);
/// 滚轮目标窗口缓存（会话内解析一次；IsWindow 校验失败自动重解析）
static LS_TARGET: Mutex<Option<(isize, bool)>> = Mutex::new(None); // (hwnd, viaRender)
static LS_POLL: AtomicBool = AtomicBool::new(false);
static LS_AUTOSCROLL: AtomicBool = AtomicBool::new(false);
static LS_FOCUS_OK: AtomicBool = AtomicBool::new(false);

fn hole() -> Option<(i32, i32, i32, i32)> {
    *LS_HOLE.lock().ok()?
}

fn hole_center() -> Option<(i32, i32)> {
    hole().map(|(x, y, w, h)| (x + w / 2, y + h / 2))
}

unsafe fn class_of(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    if n <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..n as usize])
}

/// 递归（≤3 层）找最深的 Chromium 渲染子窗口：滚轮直达渲染层，前台无关（F1 实测结论）
unsafe fn find_render_child(root: HWND, depth: i32) -> Option<HWND> {
    if depth > 3 {
        return None;
    }
    let mut found: Option<HWND> = None;
    let mut prev = HWND::default();
    for _ in 0..40 {
        let c = unsafe { FindWindowExW(root, prev, PCWSTR::null(), PCWSTR::null()) }.unwrap_or_default();
        if c.0.is_null() {
            break;
        }
        if unsafe { class_of(c) } == "Chrome_RenderWidgetHostHWND" {
            found = Some(c);
        }
        if let Some(deeper) = unsafe { find_render_child(c, depth + 1) } {
            found = Some(deeper);
        }
        prev = c;
    }
    found
}

fn capture_hwnd(app: &AppHandle) -> isize {
    app.get_webview_window("capture")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .unwrap_or(0)
}

/// 把截图窗透传状态按「光标是否在洞内」同步一次（F1 的 30ms 轮询同款判据）
fn sync_click_through(app: &AppHandle) {
    let Some(win) = app.get_webview_window("capture") else { return };
    let Some((x, y, w, h)) = hole() else { return };
    let inside = unsafe {
        let mut pt = POINT::default();
        GetCursorPos(&mut pt).is_ok() && pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + h
    };
    let _ = win.set_ignore_cursor_events(inside);
}

/// 焦点让渡：把前台交给选区下方的**别的**应用窗口（mouse_event 回退路径需要；
/// Windows 前台锁可能让首次调用失败 → 轮询里每 400ms 重试，与 F1 一致）
unsafe fn transfer_focus(app: &AppHandle) {
    let Some((cx, cy)) = hole_center() else { return };
    let hit = unsafe { WindowFromPoint(POINT { x: cx, y: cy }) };
    if hit.0.is_null() {
        return;
    }
    let mut root = unsafe { GetAncestor(hit, GA_ROOT) };
    if root.0.is_null() {
        root = hit;
    }
    if root.0 as isize == capture_hwnd(app) {
        return; // 命中自己截图窗：不能把焦点让给自己
    }
    let ok = unsafe { SetForegroundWindow(root) }.as_bool();
    if ok {
        LS_FOCUS_OK.store(true, Ordering::SeqCst);
    }
}

/// 解析滚轮目标：命中自己截图窗时临时透传再命中一次（F1 lsResolveWheelTarget 同款）
unsafe fn resolve_wheel_target(app: &AppHandle) -> bool {
    let Some((cx, cy)) = hole_center() else { return false };
    let own = capture_hwnd(app);
    let mut hit = unsafe { WindowFromPoint(POINT { x: cx, y: cy }) };
    if hit.0.is_null() {
        return false;
    }
    let mut root = unsafe { GetAncestor(hit, GA_ROOT) };
    if root.0.is_null() {
        root = hit;
    }
    if root.0 as isize == own {
        if let Some(win) = app.get_webview_window("capture") {
            let _ = win.set_ignore_cursor_events(true);
            hit = unsafe { WindowFromPoint(POINT { x: cx, y: cy }) };
            // 立刻恢复并交还给轮询按光标位置重设（F1 的 lsResetClickThroughState 同款）
            sync_click_through(app);
        }
        if hit.0.is_null() {
            return false;
        }
        root = unsafe { GetAncestor(hit, GA_ROOT) };
        if root.0.is_null() {
            root = hit;
        }
        if root.0 as isize == own {
            logln("[LS] resolve-wheel: still self after passthrough");
            return false;
        }
    }
    if let Some(render) = unsafe { find_render_child(root, 0) } {
        if let Ok(mut g) = LS_TARGET.lock() {
            *g = Some((render.0 as isize, true));
        }
        logln(&format!("[LS] wheel-target render=0x{:x}", render.0 as isize));
        return true;
    }
    let cls = unsafe { class_of(hit) };
    if let Ok(mut g) = LS_TARGET.lock() {
        *g = Some((hit.0 as isize, false));
    }
    logln(&format!("[LS] wheel-target hit=0x{:x} cls={} (no render child)", hit.0 as isize, cls));
    true
}

/// WM_MOUSEWHEEL 的参数打包：wParam 高 16 位 = 有符号 delta，lParam = 选区中心**物理**屏幕坐标。
/// 负 delta（向下翻页）必须按位截断成 0xFFxx，负数坐标（主屏左/上的副屏）同理——
/// 这两处若按有符号数直接移位，滚轮会变成「向上滚」或「滚到别的窗口」。
fn wheel_params(delta: i32, cx: i32, cy: i32) -> (usize, isize) {
    let wparam = (((delta as u32) & 0xffff) << 16) as usize;
    let lparam = ((((cy as u32) & 0xffff) << 16) | ((cx as u32) & 0xffff)) as isize;
    (wparam, lparam)
}

/// 洞 = 截图窗物理原点 + 选区(CSS) × 主屏 dpr（F2 单一 dpr 表面；F1 是 DIP→物理逐屏换算）
fn hole_from_sel(ox: i32, oy: i32, sel: (f64, f64, f64, f64), dpr: f64) -> (i32, i32, i32, i32) {
    (
        ox + (sel.0 * dpr).round() as i32,
        oy + (sel.1 * dpr).round() as i32,
        (sel.2 * dpr).round() as i32,
        (sel.3 * dpr).round() as i32,
    )
}

unsafe fn post_wheel(app: &AppHandle, delta: i32) -> bool {
    let Some((cx, cy)) = hole_center() else { return false };
    let cached = LS_TARGET.lock().ok().and_then(|g| *g);
    let valid = cached
        .map(|(h, _)| unsafe { IsWindow(HWND(h as *mut _)).as_bool() })
        .unwrap_or(false);
    if !valid && !unsafe { resolve_wheel_target(app) } {
        return false;
    }
    let Some((hwnd, _)) = LS_TARGET.lock().ok().and_then(|g| *g) else { return false };
    // wParam 高 16 位 = delta（有符号），lParam = 选区中心物理屏幕坐标
    let (wp, lp) = wheel_params(delta, cx, cy);
    let ok = unsafe {
        PostMessageW(
            HWND(hwnd as *mut _),
            WM_MOUSEWHEEL,
            WPARAM(wp),
            LPARAM(lp),
        )
    }
    .is_ok();
    if !ok {
        if let Ok(mut g) = LS_TARGET.lock() {
            *g = None; // 目标失效，下次重解析
        }
    }
    ok
}

/// 滚轮统一入口：PostMessage 优先 → mouse_event 保底（负值向下翻页）
pub fn wheel(app: &AppHandle, delta: i32) -> bool {
    if unsafe { post_wheel(app, delta) } {
        return true;
    }
    logln(&format!("[LS] fallback mouse_event delta={delta}"));
    unsafe { mouse_event(MOUSEEVENTF_WHEEL, 0, 0, delta, 0) };
    true
}

/// capture-ls-autoscroll：start / stop / step（step = 步进制，渲染端等画面静止后再发下一格）
pub fn autoscroll(app: &AppHandle, a0: &Value) -> Value {
    let action = a0.get("action").and_then(|v| v.as_str()).unwrap_or("stop");
    match action {
        "step" => json!(wheel(app, a0.get("delta").and_then(|v| v.as_i64()).unwrap_or(-40) as i32)),
        "start" => {
            let interval = a0.get("intervalMs").and_then(|v| v.as_u64()).unwrap_or(600).max(30);
            let delta = a0.get("delta").and_then(|v| v.as_i64()).unwrap_or(-40) as i32;
            LS_AUTOSCROLL.store(true, Ordering::SeqCst);
            let app_c = app.clone();
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(180); // 安全阀（F1 同款 3 分钟）
                logln(&format!("[LS] autoscroll start interval={interval}ms delta={delta}"));
                while LS_AUTOSCROLL.load(Ordering::SeqCst) && Instant::now() < deadline {
                    if !wheel(&app_c, delta) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(interval));
                }
                LS_AUTOSCROLL.store(false, Ordering::SeqCst);
                logln("[LS] autoscroll stop");
            });
            json!(true)
        }
        _ => {
            LS_AUTOSCROLL.store(false, Ordering::SeqCst);
            json!(true)
        }
    }
}

fn register_hotkeys(app: &AppHandle) {
    let gs = app.global_shortcut();
    for (accel, save) in [("Enter", true), ("Escape", false)] {
        if let Ok(sc) = accel.parse::<Shortcut>() {
            let _ = gs.register(sc);
        }
        let app_c = app.clone();
        let _ = gs.on_shortcut(accel, move |_a, _s, ev| {
            if ev.state() == ShortcutState::Pressed {
                if let Some(w) = app_c.get_webview_window("capture") {
                    let _ = w.emit("ipc-event", json!({ "ch": "capture-ls-finish", "args": save }));
                }
            }
        });
    }
    logln("[LS] hotkeys registered (Enter=finish, Esc=cancel)");
}

fn unregister_hotkeys(app: &AppHandle) {
    let gs = app.global_shortcut();
    for accel in ["Enter", "Escape"] {
        if let Ok(sc) = accel.parse::<Shortcut>() {
            let _ = gs.unregister(sc);
        }
    }
}

/// capture-ls-active（on/off）：开 = 记录洞 + 起 30ms 透传轮询 + 注册 Enter/Esc + 预解析滚轮目标；
/// 关 = **先恢复可交互**再清状态（F1 的顺序铁律：反了会让窗口永久 click-through 且焦点已让渡 = 卡死）
pub fn set_active(app: &AppHandle, a0: &Value) {
    let on = a0.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
    let Some(win) = app.get_webview_window("capture") else { return };
    if on {
        let sel = a0.get("sel").cloned().unwrap_or(Value::Null);
        let (sx, sy, sw, sh) = (
            sel.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0),
            sel.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0),
            sel.get("w").and_then(|v| v.as_f64()).unwrap_or(0.0),
            sel.get("h").and_then(|v| v.as_f64()).unwrap_or(0.0),
        );
        if sw < 1.0 || sh < 1.0 {
            logln("[LS] active: invalid sel");
            return;
        }
        let dpr = unsafe { primary_scale_factor() };
        let origin = win.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
        let hole_rect = hole_from_sel(origin.x, origin.y, (sx, sy, sw, sh), dpr);
        if let Ok(mut g) = LS_HOLE.lock() {
            *g = Some(hole_rect);
        }
        if let Ok(mut g) = LS_TARGET.lock() {
            *g = None;
        }
        LS_FOCUS_OK.store(false, Ordering::SeqCst);
        LS_POLL.store(true, Ordering::SeqCst);
        register_hotkeys(app);
        sync_click_through(app); // 初始态按光标位置，不无脑透传（F1 同款）
        let app_c = app.clone();
        std::thread::spawn(move || {
            let mut last_focus = Instant::now() - Duration::from_secs(1);
            while LS_POLL.load(Ordering::SeqCst) {
                sync_click_through(&app_c);
                if !LS_FOCUS_OK.load(Ordering::SeqCst) && last_focus.elapsed() > Duration::from_millis(400) {
                    last_focus = Instant::now();
                    unsafe { transfer_focus(&app_c) };
                }
                std::thread::sleep(Duration::from_millis(30));
            }
        });
        let resolved = unsafe { resolve_wheel_target(app) };
        logln(&format!("[LS] active on hole={hole_rect:?} dpr={dpr:.3} wheelTarget={resolved}"));
    } else {
        LS_POLL.store(false, Ordering::SeqCst);
        LS_AUTOSCROLL.store(false, Ordering::SeqCst);
        let _ = win.set_ignore_cursor_events(false);
        unregister_hotkeys(app);
        if let Ok(mut g) = LS_HOLE.lock() {
            *g = None;
        }
        if let Ok(mut g) = LS_TARGET.lock() {
            *g = None;
        }
        logln("[LS] active off");
    }
}

/// 会话结束兜底：渲染端漏发 active off / autoscroll stop 时也不能把滚轮和热键留在系统里
pub fn on_session_end(app: &AppHandle) {
    LS_POLL.store(false, Ordering::SeqCst);
    LS_AUTOSCROLL.store(false, Ordering::SeqCst);
    if hole().is_some() {
        if let Some(win) = app.get_webview_window("capture") {
            let _ = win.set_ignore_cursor_events(false);
        }
        if let Ok(mut g) = LS_HOLE.lock() {
            *g = None;
        }
    }
    if let Ok(mut g) = LS_TARGET.lock() {
        *g = None;
    }
    unregister_hotkeys(app);
}

/// 物理像素矩形 BitBlt → top-down BGRA（F1 capture-longshot-gdi 同款；负坐标合法 = 虚拟桌面）
fn capture_rect_phys(sx: i32, sy: i32, w: i32, h: i32) -> Option<(Vec<u8>, u32, u32)> {
    if w < 4 || h < 4 || w > 8192 || h > 8192 {
        return None;
    }
    unsafe {
        let hdc_screen: HDC = CreateDCW(w!("DISPLAY"), None, None, None);
        let hdc_mem = CreateCompatibleDC(hdc_screen);
        let hbm = CreateCompatibleBitmap(hdc_screen, w, h);
        if hdc_mem.0.is_null() || hbm.0.is_null() {
            let _ = DeleteDC(hdc_mem);
            let _ = DeleteDC(hdc_screen);
            return None;
        }
        let old = SelectObject(hdc_mem, HGDIOBJ(hbm.0));
        let mut out: Option<Vec<u8>> = None;
        if BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, sx, sy, SRCCOPY | CAPTUREBLT).is_ok() {
            let mut bi = BITMAPINFO::default();
            bi.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // 负值 = top-down 行序
                biPlanes: 1,
                biBitCount: 32,
                biSizeImage: (w * h * 4) as u32,
                ..Default::default()
            };
            let mut buf = vec![0u8; (w * h * 4) as usize];
            // GetDIBits 要求位图未被选入 DC → 先还原旧位图（F1 注释：违规会间歇性失败）
            if !old.0.is_null() {
                SelectObject(hdc_mem, old);
            }
            let lines = GetDIBits(
                hdc_mem,
                hbm,
                0,
                h as u32,
                Some(buf.as_mut_ptr() as *mut _),
                &mut bi,
                DIB_RGB_COLORS,
            );
            if lines == h {
                out = Some(buf);
            }
        }
        let _ = DeleteObject(HGDIOBJ(hbm.0));
        let _ = DeleteDC(hdc_mem);
        let _ = DeleteDC(hdc_screen);
        out.map(|b| (b, w as u32, h as u32))
    }
}

/// ls_gdi_raw 二进制返回：[w:u32 LE][h:u32 LE][BGRA…]，由 shim 解包成 {buf,w,h}
pub fn gdi_raw_bytes(gx: f64, gy: f64, gw: f64, gh: f64, vsx: Option<f64>, vsy: Option<f64>) -> Vec<u8> {
    let dpr = unsafe { primary_scale_factor() };
    // vsX/vsY 是「物理 ÷ 主屏 dpr」空间的窗口原点（F1 注释：勿用 dipToScreenPoint，屏外点不可靠）
    let sx = gx.round() as i32 + (vsx.unwrap_or(0.0) * dpr).round() as i32;
    let sy = gy.round() as i32 + (vsy.unwrap_or(0.0) * dpr).round() as i32;
    let Some((bgra, w, h)) = capture_rect_phys(sx, sy, gw.round() as i32, gh.round() as i32) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(8 + bgra.len());
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(&bgra);
    out
}

#[tauri::command(rename_all = "camelCase")]
pub fn ls_gdi_raw(gx: f64, gy: f64, gw: f64, gh: f64, vs_x: Option<f64>, vs_y: Option<f64>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(gdi_raw_bytes(gx, gy, gw, gh, vs_x, vs_y))
}

/// capture-longshot-frame（GDI 失败时的回退路径）：选区 → PNG dataURL。
/// F1 走 desktopCapturer thumbnail；F2 没有该 API，直接用同一张 GDI 帧，清晰度更高且同源。
pub fn frame_value(app: &AppHandle, a0: &Value) -> Value {
    let dpr = unsafe { primary_scale_factor() };
    let get = |k: &str| a0.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let origin = app
        .get_webview_window("capture")
        .and_then(|w| w.outer_position().ok())
        .unwrap_or(PhysicalPosition::new(0, 0));
    let sx = origin.x + (get("selX") * dpr).round() as i32;
    let sy = origin.y + (get("selY") * dpr).round() as i32;
    let w = (get("selW") * dpr).round() as i32;
    let h = (get("selH") * dpr).round() as i32;
    let Some((bgra, w, h)) = capture_rect_phys(sx, sy, w, h) else { return Value::Null };
    let mut rgba = Vec::with_capacity((w * h * 4) as usize);
    for px in bgra.chunks_exact(4) {
        rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
    }
    let Some(img) = image::RgbaImage::from_raw(w, h, rgba) else { return Value::Null };
    let mut png = std::io::Cursor::new(Vec::new());
    if image::DynamicImage::ImageRgba8(img)
        .write_to(&mut png, image::ImageFormat::Png)
        .is_err()
    {
        return Value::Null;
    }
    use base64::Engine;
    json!({ "url": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.into_inner())) })
}

fn data_url_bytes(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let idx = s.find(',')?;
    base64::engine::general_purpose::STANDARD.decode(&s[idx + 1..]).ok()
}

/// capture-ls-debug：被拒帧/关键帧落盘供离线取证（与 F1 同目录 %TEMP%\xiyue-ls-debug）
pub fn debug_dump(a0: &Value) {
    let name = a0.get("name").and_then(|v| v.as_str()).unwrap_or("");
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return;
    }
    let Some(bytes) = data_url_bytes(a0.get("dataURL").and_then(|v| v.as_str()).unwrap_or("")) else { return };
    let dir = std::env::temp_dir().join("xiyue-ls-debug");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(name), bytes);
}

/// capture-longshot-save：超限拆分瓦片直接写保存目录（多文件不走对话框，F1 同款）
pub fn save_tiles(a0: &Value) {
    let images = a0.get("images").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let base = a0.get("baseName").and_then(|v| v.as_str()).unwrap_or("长截图");
    let dir = settings_target_dir("screenshots");
    let _ = std::fs::create_dir_all(&dir);
    let mut n = 0;
    for (i, item) in images.iter().enumerate() {
        let Some(bytes) = data_url_bytes(item.as_str().unwrap_or("")) else { continue };
        if std::fs::write(dir.join(format!("{base}_{}.png", i + 1)), bytes).is_ok() {
            n += 1;
        }
    }
    logln(&format!("[LS] saved {n}/{} tiles -> {}", images.len(), dir.display()));
}

/// capture-longshot-editor：窗口贴住结果图尺寸并居中（F1 r56：窗口比图大的露底区域会被
/// 感知为灰色阴影区）。payload 的 w/h 是**图像 CSS 尺寸**，F2 窗口物理 = CSS × 主屏 dpr。
/// F1 的 lsEditorSharpnessGuard 是 Electron setBounds 后栅格尺度失效的专属 workaround，
/// WebView2 无此路径，先不做——若实测编辑态发虚再补。
pub fn editor(app: &AppHandle, a0: &Value) {
    let Some(win) = app.get_webview_window("capture") else { return };
    let w = a0.get("w").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let h = a0.get("h").and_then(|v| v.as_f64()).unwrap_or(0.0);
    if w < 1.0 || h < 1.0 {
        return;
    }
    let dpr = unsafe { primary_scale_factor() };
    let (wx, wy, ww, wh) = unsafe {
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let center = win.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
        let mon = MonitorFromPoint(POINT { x: center.x + 10, y: center.y + 10 }, MONITOR_DEFAULTTONEAREST);
        if GetMonitorInfoW(mon, &mut mi).as_bool() {
            let r = mi.rcWork;
            (r.left, r.top, r.right - r.left, r.bottom - r.top)
        } else {
            (0, 0, 1920, 1080)
        }
    };
    let wa_w = ww as f64 / dpr;
    let wa_h = wh as f64 / dpr;
    // 底部给工具栏预留 170 + 安全距 24（F1 同款）；图高于屏幕时工具栏悬浮属常规编辑器行为
    let eh = (h + 194.0).clamp(240.0, (wa_h - 40.0).max(240.0));
    let needs_vscroll = h + 194.0 > wa_h - 40.0;
    let ew = (w + if needs_vscroll { 24.0 } else { 0.0 }).clamp(320.0, (wa_w - 40.0).max(320.0));
    let bx = wx as f64 + ((wa_w - ew) / 2.0).max(0.0);
    let by = wy as f64 + ((wa_h - eh) / 2.0).max(0.0);
    let _ = win.set_resizable(true);
    let _ = win.set_size(PhysicalSize::new((ew * dpr).round() as u32, (eh * dpr).round() as u32));
    let _ = win.set_position(PhysicalPosition::new(
        (wx as f64 + ((ww as f64 - ew * dpr) / 2.0).max(0.0)).round() as i32,
        (wy as f64 + ((wh as f64 - eh * dpr) / 2.0).max(0.0)).round() as i32,
    ));
    logln(&format!("[LS] editor window {ew:.0}x{eh:.0} css @({bx:.0},{by:.0}) dpr={dpr:.3}"));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 负 delta = 向下翻页，必须截断成 0xFFxx 高 16 位；写反方向是长截图最隐蔽的故障
    #[test]
    fn wheel_param_packs_signed_delta() {
        let (wp, _lp) = wheel_params(-120, 0, 0);
        assert_eq!((wp >> 16) as u16, 0xff88); // -120 的 16 位补码（0xFF80 是 -128）
        let (wp2, _lp2) = wheel_params(120, 0, 0);
        assert_eq!((wp2 >> 16) as u16, 0x0078);
    }

    /// lParam 低 16 位 = X、高 16 位 = Y；副屏在主屏左/上时坐标为负，不能算成巨大正数
    #[test]
    fn wheel_param_packs_physical_point_including_negative() {
        let (_wp, lp) = wheel_params(-40, 100, 200);
        assert_eq!(lp as u32, (200u32 << 16) | 100);
        let (_wp2, lp2) = wheel_params(-40, -2560, -100);
        assert_eq!((lp2 as u32) & 0xffff, ((-2560i32) as u32) & 0xffff);
        assert_eq!(((lp2 as u32) >> 16) & 0xffff, ((-100i32) as u32) & 0xffff);
    }

    /// 洞换算：CSS 选区 × 主屏 dpr + 窗口物理原点（副屏原点为负也必须成立）
    #[test]
    fn hole_uses_physical_origin_and_primary_dpr() {
        let h = hole_from_sel(-2560, 0, (100.0, 50.0, 400.0, 300.0), 1.25);
        assert_eq!(h, (-2435, 63, 500, 375));
    }

    /// GDI 抓帧硬测试：尺寸、缓冲长度、非全零（空帧=拼接全黑但无任何报错）
    #[test]
    fn gdi_rect_capture_returns_real_pixels() {
        let (buf, w, h) = capture_rect_phys(0, 0, 64, 64).expect("BitBlt 64x64");
        assert_eq!((w, h), (64, 64));
        assert_eq!(buf.len(), 64 * 64 * 4);
        assert!(buf.iter().any(|&b| b != 0), "抓回全零帧 = 抓到了空白");
    }

    /// 非法尺寸必须被拒（渲染端传 0/负值时不能分配巨型缓冲）
    #[test]
    fn gdi_rect_capture_rejects_bad_size() {
        assert!(capture_rect_phys(0, 0, 0, 100).is_none());
        assert!(capture_rect_phys(0, 0, 100, -5).is_none());
        assert!(capture_rect_phys(0, 0, 100000, 100).is_none());
    }

    /// 二进制通道契约：[w][h][BGRA…]，shim 按同一布局解包
    #[test]
    fn gdi_raw_bytes_layout_matches_shim() {
        let out = gdi_raw_bytes(0.0, 0.0, 16.0, 16.0, Some(0.0), Some(0.0));
        assert!(out.len() >= 8 + 16 * 16 * 4, "payload too small: {}", out.len());
        let w = u32::from_le_bytes([out[0], out[1], out[2], out[3]]);
        let h = u32::from_le_bytes([out[4], out[5], out[6], out[7]]);
        assert_eq!((w, h), (16, 16));
        assert_eq!(out.len(), 8 + (w * h * 4) as usize);
    }
}
