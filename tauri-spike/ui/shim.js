// Electron → Tauri 兼容垫片：让 capture.js 一字不改跑在 WebView2 里。
// 提供 require('electron')（ipcRenderer/clipboard/shell/nativeImage）+ process.env。
// 通道转发：invoke → Rust ipc_invoke(ipc_send)；Rust → JS 事件走 'ipc-event' 分发。
(function () {
  if (window.__petalShim) return;
  window.__petalShim = true;
  var T = window.__TAURI__;
  var invoke = T.core.invoke;

  var listeners = {}; // ch -> [fn(ev, args)]

  function dispatch(ch, args) {
    var arr = listeners[ch];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      try { arr[i]({}, args); } catch (e) { console.error('[shim] listener ' + ch + ' threw', e); }
    }
  }

  // 大帧二进制走专用命令（capture-image 的 rawFrame.bgra）：meta 事件先到，
  // shim 拉取 ArrayBuffer 后合成完整 payload 再分发给 capture.js。
  T.event.listen('ipc-event', function (e) {
    var p = e.payload || {};
    if (p.ch === '__frame_meta') {
      var tMeta = Date.now();
      // dpr 交叉校验（2026-10-31）：Rust 下发的 winDpr 必须等于 WebView2 的 devicePixelRatio。
      // 两者不等 → 整条坐标链（virtualScreen / cursor / visibleWindows / 裁剪）用的换算
      // 系数不是同一个，"查得准"与"画得对"必然对不上（框整体偏移/缩放）。
      // 当场喊出来，别等用户看到框偏了才去猜。
      var wd = p.args && p.args.winDpr;
      var webdpr = window.devicePixelRatio;
      if (typeof wd === 'number' && wd > 0 && Math.abs(wd - webdpr) > 0.01) {
        console.error('[shim] DPR MISMATCH rust=' + wd + ' webview=' + webdpr);
      }
      // 上报渲染端实际用的 dpr（供 Rust 校验权威来源；本身不参与换算）
      invoke('set_webview_dpr', { dpr: webdpr }).catch(function () {});
      // 帧取数：走 IPC Response 的二进制通道（tauri::ipc::Response，不经 JSON 序列化）。
      // 2026-10-31 实测否决了 asset:// 直读方案（Rust 落盘 + fetch(convertFileSrc)）：
      //   IPC   → 渲染端 meta→buf 214ms，buf→dispatch 62ms；Rust 侧 0 额外开销
      //   asset → 渲染端 meta→buf 249ms（headers 215 + body 34），buf→dispatch 136ms；
      //           Rust 侧**额外**写盘 13~232ms（负载高时更差）
      // 两端都不占优 → 净亏 35~150ms + 13~232ms，已回退。
      // ⚠️ 天花板是架构性的：WebView2 没有 Chromium 的 shared-memory IPC，
      //    29.5MB 原始像素过桥 ~200ms 不可再压缩（Electron 同帧只需 ~26ms）。
      var tFetch0 = Date.now();
      invoke('get_frame_raw')
        .then(function (buf) {
          var tBuf = Date.now();
          var u8 = new Uint8Array(buf);
          var tU8 = Date.now();
          p.args.rawFrame = { bgra: u8, width: p.args.frameW, height: p.args.frameH };
          delete p.args.frameW; delete p.args.frameH;
          dispatch('capture-image', p.args);
          // 首帧真正被浏览器绘制的时刻（rAF 之后的下一帧 ≈ 合成完成）：
          // 与 Rust 侧 reveal 打点对照 → 量出「窗口可见但画面还没出来」的延迟。
          try {
            var tDispatch = Date.now();
            requestAnimationFrame(function () {
              console.error('[probe] post-frame rAF +' + (Date.now() - tDispatch) + 'ms');
            });
          } catch (_) { /* ignore */ }
          // 帧传输分段耗时：meta→取帧 / 取帧→派发，用来定位"出窗慢"到底卡在哪一段
          console.error('[shim] frame IPC headers ' + (tFetch0 - tMeta) + 'ms'
            + ' meta->buf=' + (tBuf - tMeta) + 'ms (u8=' + (tU8 - tBuf)
            + 'ms) buf->dispatch=' + (Date.now() - tBuf) + 'ms bytes=' + u8.length);
        }).catch(function (err) {
          console.error('[shim] frame fetch failed', err);
        });
      return;
    }
    dispatch(p.ch, p.args);
  });

  // ── 大二进制载荷拦截（2026-10-31）──────────────────────────────────────
  // 背景：Electron 的 ipcRenderer.send 走**结构化克隆**，Uint8Array 是原生二进制，
  // 29.5MB 只要 ~26ms。WebView2 的 postMessage 只接受「可 JSON 序列化」的对象 →
  // Uint8Array 被摊平成「每个元素一个键」的 JSON 对象（29.5MB ≈ 两千万个键 /
  // 约 600MB 文本）：渲染端主线程 marshaling 阻塞 ~3.1s（实测 longtask 3090ms），
  // Rust 主线程 serde_json 再解析一遍阻塞 ~2.2s（实测 main-thread stall 2193ms），
  // 再叠上「ESC 键事件排在长任务后面」= 用户实测的「刚进截图就卡 + ESC 退不出」。
  //
  // 为什么可以拦：F2 像素链已停用（渲染端 PIXEL_CHAIN_FOR_BOX=false，Rust
  // smart:pixel-at 恒返回空 levels）→ 这份帧**没有任何消费方**。Rust 侧那条
  // "smart:frame" 分支本来也只是收下就扔。
  //
  // 双保险：Rust meta 的 framePrepared=true 让渲染端**根本不发**；这里是第二道，
  // 防止任一侧被回退后又把 29.5MB 塞进 JSON 通道。
  //
  // 阈值 1MB：现行所有「活」通道的参数都是小对象或字符串（dataURL 走 base64 文本，
  // 不算二进制）；带二进制数组的通道（capture-record-save / capture-ls-debug）
  // 在 Rust 侧本就是 notPorted 空实现，拦掉无副作用。
  var BIG_BINARY_LIMIT = 1024 * 1024;

  function typedBytes(v, depth) {
    if (!v || depth > 2) return 0;
    try {
      if (v instanceof ArrayBuffer) return v.byteLength;
      if (ArrayBuffer.isView(v)) return v.byteLength;
    } catch (_) { /* ignore */ }
    if (Array.isArray(v)) {
      // 数组只探前 8 项：避免对巨型普通数组做无界遍历
      var n = 0;
      for (var i = 0; i < v.length && i < 8; i++) n += typedBytes(v[i], depth + 1);
      return n;
    }
    if (typeof v === 'object') {
      var total = 0;
      for (var k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        total += typedBytes(v[k], depth + 1);
      }
      return total;
    }
    return 0;
  }

  function bigBinaryArgs(args) {
    var bytes = 0;
    for (var i = 0; i < args.length; i++) bytes += typedBytes(args[i], 0);
    if (bytes <= BIG_BINARY_LIMIT) return false;
    console.error('[shim] BLOCK oversized payload (' + bytes + ' bytes) —— 走 JSON 通道会拖垮主线程');
    return true;
  }

  var ipcRenderer = {
    invoke: function (ch) {
      var args = Array.prototype.slice.call(arguments, 1);
      if (bigBinaryArgs(args)) return Promise.reject(new Error('blocked oversized payload: ' + ch));
      return invoke('ipc_invoke', { ch: ch, args: args });
    },
    send: function (ch) {
      var args = Array.prototype.slice.call(arguments, 1);
      // ── 大二进制载荷拦截（2026-10-31，详见 bigBinaryArgs 的注释）────────
      // smart:frame 这一发是 29.5MB 的 Uint8Array，WebView2 走 JSON 通道会把它
      // 摊平成「两千万个键」的对象 → 渲染端堵 ~3s、Rust 主线程再堵 ~2.2s。
      // 像素链已停用 → 没有消费方 → 在源头掐掉。
      if (bigBinaryArgs(args)) return;
      invoke('ipc_send', { ch: ch, args: args }).catch(function () { /* ignore */ });
    },
    sendSync: function () { return null; },
    on: function (ch, fn) {
      (listeners[ch] = listeners[ch] || []).push(fn);
    },
    once: function (ch, fn) {
      var w = function (ev, a) {
        if (listeners[ch]) listeners[ch] = listeners[ch].filter(function (x) { return x !== w; });
        fn(ev, a);
      };
      ipcRenderer.on(ch, w);
    },
    removeAllListeners: function (ch) { delete listeners[ch]; },
    removeListener: function (ch, fn) {
      if (listeners[ch]) listeners[ch] = listeners[ch].filter(function (x) { return x !== fn; });
    },
  };

  var clipboard = {
    writeText: function (t) { return invoke('clip_write_text', { text: String(t) }); },
    readText: function () { return Promise.resolve(''); },
    writeImage: function (img) {
      var b64 = img && img.__pngB64;
      if (!b64) return Promise.reject(new Error('no image'));
      return invoke('clip_write_image', { pngB64: b64 });
    },
    write: function (o) {
      // {text, html}：写入富文本（含 HTML 版本）
      return invoke('clip_write_text', { text: (o && o.text) || '', html: (o && o.html) || null });
    },
  };

  var nativeImage = {
    createFromDataURL: function (u) {
      var s = String(u);
      return {
        __pngB64: s.indexOf(',') >= 0 ? s.slice(s.indexOf(',') + 1) : '',
        toDataURL: function () { return s; },
        getSize: function () { return { width: 0, height: 0 }; },
      };
    },
    createFromPath: function () { return nativeImage.createFromDataURL('data:image/png;base64,'); },
  };

  var shell = {
    openExternal: function (u) { return invoke('open_external', { url: String(u) }); },
  };

  // 调试期日志总开关。
  // ⚠️ 此前这里写死 PETALSNAP_SMART_DEBUG='1'（调试期临时值忘了收回）→ Tauri 侧
  // **所有**诊断日志常开（Electron 侧默认关）：每帧 mousemove 的 PERF 探针、每次
  // smart 回包的 [TXT] 打点、每次会话 5 次全画布 getImageData 抽样（≈55ms）
  // ……日常白白付，且两版性能不可比。
  // 现在改由 URL 参数决定（Rust 侧读 PETALSNAP_SMART_DEBUG 环境变量决定是否加
  // ?smart_debug=1）→ 默认关，与 Electron 侧完全一致；排查时设环境变量重启即可开。
  var SMART_DEBUG = /[?&]smart_debug=1/.test(window.location.search || '');
  window.process = {
    env: { PETALSNAP_SMART_DEBUG: SMART_DEBUG ? '1' : '' },
    platform: 'win32',
    versions: {},
  };
  window.require = function (m) {
    if (m === 'electron') return { ipcRenderer: ipcRenderer, clipboard: clipboard, shell: shell, nativeImage: nativeImage };
    throw new Error('[shim] module not available: ' + m);
  };

  // Electron 里 window.close() 会关掉 BrowserWindow（pin 窗的 Esc/关闭按钮用）；
  // WebView2 原生 close 只对脚本开的窗有效 → 转发 Rust 关掉所属窗口
  window.close = function () {
    invoke('win_close_self').catch(function () { /* ignore */ });
  };

  // console 转发（capture.js 的 [cap]/[SMART-*] 诊断行进 Rust 日志，排障不断线）
  var origErr = console.error.bind(console);
  console.error = function () {
    try {
      invoke('js_log', { msg: Array.prototype.slice.call(arguments).map(String).join(' ') });
    } catch (_) { /* ignore */ }
    origErr.apply(null, arguments);
  };
  // WebView2 原生 <select> 弹出层在跨 DPI 窗口上会错位（平台级行为，JS 无法修正其位置）
  // → 给字体下拉做 DOM 替身：点开自绘菜单，选中后回写 select.value 并派发 change
  (function fontSelectPolyfill() {
    var sel = document.getElementById('textFontSelect');
    if (!sel) return;
    var menu = document.createElement('div');
    menu.style.cssText = 'position:fixed;display:none;z-index:99999;background:rgba(28,28,30,.97);' +
      'color:#fff;border-radius:8px;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,.45);' +
      'max-height:320px;overflow-y:auto;min-width:160px;font:13px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;';
    document.body.appendChild(menu);
    function closeMenu() { menu.style.display = 'none'; }
    function openMenu() {
      menu.innerHTML = '';
      Array.prototype.forEach.call(sel.options, function (o) {
        var row = document.createElement('div');
        row.textContent = o.text;
        row.style.cssText = 'padding:7px 14px;border-radius:6px;cursor:pointer;white-space:nowrap;' +
          (o.value === sel.value ? 'background:rgba(64,156,255,.9);' : '');
        row.addEventListener('mouseenter', function () { row.style.background = 'rgba(255,255,255,.12)'; });
        row.addEventListener('mouseleave', function () {
          row.style.background = o.value === sel.value ? 'rgba(64,156,255,.9)' : 'transparent';
        });
        row.addEventListener('click', function () {
          sel.value = o.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          closeMenu();
        });
        menu.appendChild(row);
      });
      var r = sel.getBoundingClientRect();
      menu.style.left = Math.max(4, r.left) + 'px';
      menu.style.top = Math.min(window.innerHeight - 60, r.bottom + 4) + 'px';
      menu.style.display = 'block';
    }
    sel.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (menu.style.display === 'block') closeMenu(); else openMenu();
    });
    document.addEventListener('mousedown', function (e) {
      if (menu.style.display === 'block' && e.target !== sel && !menu.contains(e.target)) closeMenu();
    }, true);
  })();

  // 渲染端 dpr 自检（2026-10-31 P0-2）：与 Rust 侧的 [dpr] 主屏DPI 行核对。
  // 两者不等 → 坐标链的换算系数不统一，选框/裁剪会整体偏。
  invoke('js_log', { msg: '[shim] devicePixelRatio = ' + window.devicePixelRatio });
  invoke('set_webview_dpr', { dpr: window.devicePixelRatio }).catch(function () {});

  // ═══════════════════════════════════════════════════════════════════════════
  // 诊断探针（2026-10-31 用户实测报障：F2「卡顿」+「ESC 退不出」）
  //
  // 为什么加：之前的自动化测试把光标**钉死**了，等于绕开了真正的触发条件
  //（人一移动鼠标，悬停查询就成串发出去）。日志里 8 秒只有 1 条查询回包，
  // 说明「查询发不出去 / 回不来」，但旧日志没有一项能区分这两种情况。
  //
  // 四个探针各自回答一个问题：
  //   ① longtask   —— 渲染端主线程被谁阻塞、阻塞多久（Chromium 原生指标，最硬）
  //   ② keydown    —— ESC 到底有没有到达渲染端（区分「按键没收到」vs「收到了但处理不动」）
  //   ③ mousemove  —— 每秒鼠标事件数与最大间隔（悬停查询的洪水强度）
  //   ④ IPC 往返   —— 每条 invoke/send 的耗时（谁把 Promise 挂住了）
  // 健康时几乎零输出（只有慢调用和 longtask 才打），异常时给出可定位的数字。
  // ═══════════════════════════════════════════════════════════════════════════
  (function diagProbes() {
    var mm = { n: 0, last: 0, maxGap: 0 };
    var ipcCount = 0;

    // ① longtask：主线程连续被占 >50ms 就会有一条记录（Chromium 原生）
    try {
      if (typeof PerformanceObserver === 'function') {
        var po = new PerformanceObserver(function (list) {
          var es = list.getEntries();
          for (var i = 0; i < es.length; i++) {
            var e = es[i];
            console.error('[probe] longtask ' + e.duration.toFixed(0)
              + 'ms start=+' + e.startTime.toFixed(0) + 'ms');
          }
        });
        po.observe({ entryTypes: ['longtask'] });
        console.error('[probe] longtask observer armed');
      } else {
        console.error('[probe] longtask observer UNAVAILABLE');
      }
    } catch (err) {
      console.error('[probe] longtask observer failed: ' + err);
    }

    // ② 键盘：ESC 有没有真的进到渲染端
    window.addEventListener('keydown', function (e) {
      console.error('[probe] keydown code=' + e.code + ' key=' + e.key
        + ' repeat=' + e.repeat + ' target=' + (e.target && e.target.tagName));
    }, true);

    // ③ 鼠标事件洪水强度
    window.addEventListener('mousemove', function () {
      var now = Date.now();
      mm.n++;
      if (mm.last) {
        var gap = now - mm.last;
        if (gap > mm.maxGap) mm.maxGap = gap;
      }
      mm.last = now;
    }, { passive: true });

    // ④ IPC 往返计时（包装 invoke；ipcRenderer.invoke/send 都走这里）
    var origInvoke = invoke;
    invoke = function (ch, args) {
      var s = Date.now();
      return origInvoke(ch, args).then(function (r) {
        var d = Date.now() - s;
        // js_log 自身走这里，必须排除，否则探针会自我触发（计数恒 ≥1、且会递归打日志）
        if (ch !== 'js_log') {
          ipcCount++;
          if (d > 60) {
            console.error('[probe] invoke ' + ch + ' took ' + d + 'ms');
          }
        }
        return r;
      }, function (e) {
        if (ch !== 'js_log') {
          console.error('[probe] invoke ' + ch + ' FAILED in '
            + (Date.now() - s) + 'ms: ' + e);
        }
        throw e;
      });
    };

    // 每秒汇总一次：鼠标事件数 / 最大间隔 / IPC 次数
    setInterval(function () {
      if (mm.n > 0 || ipcCount > 0) {
        console.error('[probe] 1s mouse=' + mm.n + ' maxGap=' + mm.maxGap
          + 'ms ipc=' + ipcCount);
      }
      mm.n = 0; mm.maxGap = 0; ipcCount = 0;
    }, 1000);

    // 焦点状态：前台锁拿不到时窗口会失焦 → ESC 根本收不到
    window.addEventListener('focus', function () { console.error('[probe] window focus'); });
    window.addEventListener('blur', function () { console.error('[probe] window blur'); });
    document.addEventListener('visibilitychange', function () {
      console.error('[probe] visibility=' + document.visibilityState);
    });
  })();

  console.log('[shim] electron compat ready');
})();
