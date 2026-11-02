// F1 worker 内核原样运行（提取自 smartUiaNative.ts，逻辑零改动；宿主桩见文首）
const EventEmitter = require('events');
const fakePP = new EventEmitter();
fakePP.postMessage = function (msg) {
  try { process.stdout.write(JSON.stringify(msg) + String.fromCharCode(10)); } catch (e) {}
};
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'worker_threads') return { parentPort: fakePP };
  return origLoad.apply(this, arguments);
};
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', function (line) {
  var msg; try { msg = JSON.parse(line); } catch (e) { return; }
  fakePP.emit('message', msg);
});
process.stderr.write('[f1_kernel] ready pid=' + process.pid + String.fromCharCode(10));

      const { parentPort } = require('worker_threads');
      const koffi = require("F:/Work/Create/OCR/screenshot/node_modules/koffi");

      // ── DPI 感知：必须是 Per-Monitor-V2，否则 UIA 返回的是**虚拟化**矩形 ──────
      // 2026-10-31 实测（F1 Electron vs F2 Tauri 同点对照，同一坐标、静止光标）：
      //   F1 框 1080×710@376,238   F2 框 864×568@308,186
      // 尺寸比 864/1080 = 0.800、568/710 = 0.800 —— **恰好 = 1/1.25**（96/120 DPI
      // 的虚拟化系数），且位置也严格等比：F2.x = (F1.x − vs)/1.25 + vs、F2.y = F1.y/1.25。
      // → 本进程不是 Per-Monitor-V2 感知 → UIA 的 BoundingRectangle 返回的是
      //   **逻辑(DIP)坐标**；Rust 侧又按「物理 ÷ dpr」除了一遍 → 所有元素框缩成
      //   0.8 倍并整体偏移 = 用户报的「选框错位」。
      // Electron 侧是 PMv2（Electron 自己设的），故 F1 正确 —— 这也是两版唯一的差异来源。
      // 修法：加载 smart_uia.dll **之前**把本进程设为 Per-Monitor-Aware-V2。
      //   SetProcessDpiAwarenessContext 若被 manifest 抢先（node.exe 的 manifest
      //   可能已声明 awareness）会返回 0（ERROR_ACCESS_DENIED），此时退到
      //   SetThreadDpiAwarenessContext（UIA 调用都发生在本线程，逐线程设置同样有效）。
      try {
        const u32 = koffi.load('user32.dll');
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = (HANDLE)-4
        const spdac = u32.func('int SetProcessDpiAwarenessContext(int64 ctx)');
        const okProc = spdac(BigInt(-4));
        let ok = okProc;
        if (!okProc) {
          const stdac = u32.func('int SetThreadDpiAwarenessContext(int64 ctx)');
          ok = stdac(BigInt(-4));
          process.stderr.write('[f1_kernel] DPI PMv2: SetProcess failed, SetThread -> ' + ok + String.fromCharCode(10));
        } else {
          process.stderr.write('[f1_kernel] DPI PMv2: SetProcess -> ' + ok + String.fromCharCode(10));
        }
      } catch (e) {
        process.stderr.write('[f1_kernel] DPI PMv2 setup failed: ' + (e && e.message) + String.fromCharCode(10));
      }

      const lib = koffi.load("F:/Work/Create/OCR/screenshot/native/smart_uia/smart_uia.dll");
      const rawGetLevels = lib.func('int SmartUiaGetLevels(int32_t physX, int32_t physY, char *outJson, int32_t outCap)');
      const rawSnapshot = lib.func('int SmartUiaSnapshot(int32_t physX, int32_t physY, char *outJson, int32_t outCap)');
      const pokeFn = lib.func('int SmartUiaPoke(int32_t physX, int32_t physY)');
      const setOwnerPidFn = lib.func('int32_t SmartUiaSetOwnerPid(int32_t pid)');

      // ── 诊断探针（2026-11-01，宿主桩段）：量「谁把 node 事件循环堵住了」─────
      // 背景：Rust 侧实测到 `dll=0/0ms total=245/397ms` —— worker 自身处理 0ms，
      // Rust 却等了 245ms → 只能解释为 **node 事件循环被别的任务占住**，
      // 而本 worker 里唯一能占住事件循环的就是**同步的 DLL 调用**
      // （tryRefresh 的整窗快照 / 交叉校验的 EFP）。这两个都是宿主桩能包住的，
      // 所以在这里计时打点（不改内核逻辑，只包一层）。
      // 另加事件循环漂移探针：setInterval 预期 50ms，漂移 = 被阻塞时长。
      const dbg = (tag, ms) => {
        if (ms > 50) {
          process.stderr.write('[f1_kernel] blocked ' + tag + ' ' + ms + 'ms' + String.fromCharCode(10));
        }
      };
      const fn = function (x, y, buf, cap) {
        const t = Date.now();
        const n = rawGetLevels(x, y, buf, cap);
        dbg('efp', Date.now() - t);
        return n;
      };
      const snapFn = function (x, y, buf, cap) {
        const t = Date.now();
        const n = rawSnapshot(x, y, buf, cap);
        dbg('snapshot', Date.now() - t);
        return n;
      };
      (function loopLagProbe() {
        let last = Date.now();
        setInterval(function () {
          const now = Date.now();
          const lag = now - last - 50;
          last = now;
          if (lag > 100) {
            process.stderr.write('[f1_kernel] loop-lag ' + lag + 'ms' + String.fromCharCode(10));
          }
        }, 50).unref();
      })();

      // ── 宿主进程 PID 注册（2026-11-01）────────────────────────────────────
      // 为什么 F2 需要、而 F1 不需要：
      //   F1 的 UIA 查询跑在 **worker_threads（同进程不同线程）** → DLL 里
      //     GetCurrentProcessId() 就是 Electron 的 PID = 截图遮罩的 PID
      //     → 「自家遮罩」判得出 → 跳过 → 查询落到下层应用 → 元素级框。
      //   F2 的 UIA 查询跑在**独立 node 进程** → GetCurrentProcessId() 是 node 的 PID，
      //     与 Tauri 进程的遮罩对不上 → is_capture_mask_hwnd 放行 →
      //     find_target_window 把**自家全屏遮罩**当成命中目标 → UIA 钻进自家
      //     WebView2 DOM → 智能框 = 遮罩的 Web 内容区（实测 3413x960 = 占屏 69.44%）
      //     = 用户报的「识别还是不够准」。
      // 修法：宿主（Tauri）把自己的 PID 经环境变量传进来，DLL 据此把宿主也当「自家」。
      //   F1 走 worker_threads 不注册（环境变量不存在 → 行为与从前完全一致）。
      const ownerPid = parseInt(process.env.PETALSNAP_OWNER_PID || '0', 10);
      if (ownerPid > 0) {
        try {
          const applied = setOwnerPidFn(ownerPid);
          process.stderr.write('[f1_kernel] owner pid=' + applied + String.fromCharCode(10));
        } catch (e) {
          process.stderr.write('[f1_kernel] owner pid set failed: ' + ((e && e.message) || e) + String.fromCharCode(10));
        }
      }
      // 未捕获异常兜底：stderr 管道在进程退出竞态下会丢数据（实测 code=1 死亡但无堆栈），
      // 走 message 通道把堆栈可靠带回主进程，随后自尽由主进程重建
      process.on('uncaughtException', (e) => {
        try { parentPort.postMessage({ type: 'crash', stack: (e && e.stack) || String(e) }); } catch (_) {}
        process.exit(1);
      });
      // 快照 + 本地命中测试：进窗一次全子树快照（1 次跨进程调用，微信 Qt provider 这一次要
      // ~200ms），之后每帧"光标在哪个元素里"纯本地计算——跟手性与提供者速度彻底解耦。
      // 这是 Shotera"整树缓存请求"的同款架构。
      // 2026-09-28 多槽缓存：按窗口矩形 key 存 4 个槽（LRU），双屏来回切窗不再反复重建地图
      //（旧单槽模型下每次跨窗都是一次 60-900ms 的建图 + 建图期 EFP 慢通道兜底）。
      const snapSlots = new Map();  // winKey -> { json, win:{x,y,width,height}, t }
      const SNAP_SLOTS_MAX = 4;
      const winKeyOf = (win) => (win ? (win.x + ',' + win.y + ',' + win.width + ',' + win.height) : '');
      const findSlot = (x, y) => {
        let best = null;
        for (const s of snapSlots.values()) {
          if (inRect(s.win, x, y, 2) && (!best || s.t > best.t)) best = s;
        }
        return best;
      };
      // ── 地图外发（2026-09-30，方案 A：查询下沉渲染端）──
      // 动机（[SMART-DIAG] 实锤）：dll=0ms、map 命中 0ms，但 total=678-1635ms —— 时间全耗在
      // 「等 worker」。worker 是单线程串行队列，而「全部识别」那几笔同步调用（快照 ~200ms、
      // SmartUiaPoke 最坏 ~120ms、EFP 240-400ms、交叉校验探针）全在同一个线程里，
      // 建图期间所有悬停查询排队 → 表现为「识别钝、卡顿」。
      //
      // 解法：建好的图**外发一份给渲染端**，悬停时渲染端本地查表出框，不进 worker、不走 IPC。
      // worker 仍按原逻辑应答（保持地图新鲜度：rowMissing 重拍 / 600ms EFP 交叉校验照跑），
      // 回包到达后作为权威值覆盖本地预测——两者落在同一元素时无可见差异。
      const MAP_PUSH_MS = 400;
      const lastPushAt = new Map();
      // ★ 负向测试开关（2026-11-01）：PETALSNAP_SMART_THIN_MAP=0 → 退回旧口径
      //   （items<3 一律不下发），用于 A/B 对照「瘦图外发」这一处改动的前后差异。
      const THIN_MAP_ON = process.env.PETALSNAP_SMART_THIN_MAP !== '0';
      const publishMap = (key, json) => {
        const items = json.items || [];
        // 瘦图不下发：地图建好之前交给现有 IPC 路径，避免把「首帧只有窗/面板级」的粗图
        // 当成精确元素推给渲染端（那正是 rowMissing 要解决的问题）。
        // ★ 2026-11-01 延迟专项 P0-a：整窗级窗口（无 UIA 树的自绘面板等，实测 items=1）
        //   永远命中 items<3 → 图永远不发布 → 主进程手里没有图 → 渲染端 0ms 本地查表旁路
        //   结构性失效 → 用户直接吃到 worker 的排队延迟（实测 dll=0ms 而 total=482ms）。
        //   放宽口径：**仅当 worker 自己已判定「该应用确实没有细元素」时才下发瘦图** ——
        //   判据 rowMissingCount > 3，与 worker 既有的降级口径**完全一致**（同一条件下
        //   worker 本来就用瘦图应答，见下方「EFP 也无果/已过唤醒窗口」分支），
        //   所以渲染端画出的窗级大框与 worker 的权威回包**是同一个答案**，
        //   不存在「粗图冒充精确元素」的回归；唤醒期（rowMissingCount<=3）维持旧口径。
        if (!json.window || !items.length) return;
        const thin = items.length < 3;
        if (thin && !(THIN_MAP_ON && rowMissingCount > 3)) return;
        const now = Date.now();
        if (now - (lastPushAt.get(key) || 0) < MAP_PUSH_MS) return;
        lastPushAt.set(key, now);
        if (thin) {
          try {
            process.stderr.write('[f1_kernel] publish thin map items=' + items.length
              + ' key=' + key + String.fromCharCode(10));
          } catch (_) {}
        }
        try { parentPort.postMessage({ type: 'map', key, win: json.window, items }); } catch (_) {}
      };
      let lastSnapAttempt = 0;
      let refreshing = false;
      let lastRowMissingAt = 0;
      const inRect = (r, x, y, m) => x >= r.x - m && x <= r.x + r.width + m
        && y >= r.y - m && y <= r.y + r.height + m;
      const REFRESH_MS = 5000;    // 安全网：稳定时不再周期重拍（每次重拍 60-900ms worker 阻塞，
                                  // 1.2s 无条件重拍就是"周期性卡顿"的来源；滚动/换窗由 rowMissing 触发）
      const RETRY_MS = 120;       // 进窗唤醒/过期重拍限频
      const ROWMISSING_MS = 300;  // 行级缺失重拍限频（唤醒期）
      let rowMissingCount = 0;    // 连续行缺失次数：唤醒期 300ms×3 次后回落 1.5s（防小窗口上
                                  // 永远 rowMissing → 永远 300ms 重拍 → 永远卡）
      let lastWinKey = '';
      let lastPokeAt = 0;
      let pokeCount = 0;
      // 地图 EFP 交叉校验（2026-09-30 副屏行错位修复）：map 命中后低频用 EFP 探针
      // 验证光标处元素矩形，与地图偏差 >24px（行错位/滚动滞后）立即重拍地图。
      let lastVerifyAt = 0;
      let verifying = false;
      // 后台异步重拍：快照本身 ~200ms 同步调用，绝不在消息处理内联执行（否则每拍都
      // 卡住响应——"移动卡顿"的来源）。当前消息立即用现有快照应答，新快照下一帧生效。
      const tryRefresh = (x, y, verifyAgainst = null) => {
        const now = Date.now();
        if (refreshing || now - lastSnapAttempt < RETRY_MS) return;
        lastSnapAttempt = now;
        refreshing = true;
        setImmediate(() => {
          try {
            // EFP 交叉校验：verifyAgainst=地图当前最小命中矩形。EFP 探针与地图偏差
            // 大 → 说明地图过期（滚动/重排滞后），本次 setImmediate 内直接重拍。
            if (verifyAgainst) {
              try {
                const vbuf = Buffer.alloc(16384);
                const vn = fn(x, y, vbuf, vbuf.length);
                if (vn > 0) {
                  const vj = JSON.parse(vbuf.toString('utf8', 0, vn));
                  const v0 = vj.levels && vj.levels[0];
                  if (v0) {
                    const dx = Math.abs(v0.x - verifyAgainst.x);
                    const dy = Math.abs(v0.y - verifyAgainst.y);
                    if (dx > 24 || dy > 24) {
                      const rbuf = Buffer.alloc(262144);
                      const rn = snapFn(x, y, rbuf, rbuf.length);
                      if (rn > 0) {
                        const rj = JSON.parse(rbuf.toString('utf8', 0, rn));
                        if (rj.ok && rj.window) {
                          snapSlots.set(winKeyOf(rj.window), { json: rj, win: rj.window, t: Date.now() });
                          publishMap(winKeyOf(rj.window), rj);
                        }
                      }
                    }
                  }
                }
              } catch (e) { /* 校验失败不影响原重拍流程 */ }
            }
            const buf = Buffer.alloc(262144);
            const n = snapFn(x, y, buf, buf.length);
            if (n > 0) {
              const json = JSON.parse(buf.toString('utf8', 0, n));
              if (json.ok && json.window) {
                const key = winKeyOf(json.window);
                snapSlots.set(key, { json, win: json.window, t: Date.now() });
                publishMap(key, json);
                if (snapSlots.size > SNAP_SLOTS_MAX) {
                  let oldestKey = null;
                  let oldestT = Infinity;
                  for (const [k, s] of snapSlots) {
                    if (s.t < oldestT) { oldestT = s.t; oldestKey = k; }
                  }
                  if (oldestKey) snapSlots.delete(oldestKey);
                }
              }
            }
          } catch (e) { /* 快照失败沿用旧快照 */ }
          refreshing = false;
        });
      };
      parentPort.on('message', (msg) => {
        if (!msg || msg.type !== 'uia') return;
        // 2026-09-23：消息处理内任何未捕获异常都不允许杀死 worker —— code=1 静默死亡
        // 曾致整个会话跌回主线程同步 EFP（单次 200-1100ms 阻塞 = 用户实测卡顿）。
        try {
        const now = Date.now();
        const x = msg.x | 0, y = msg.y | 0;
        const t0 = Date.now();

        // ── 主路径：元素地图命中（2026-09-27 地图优先，用户方案）──
        // 快照 = 整树批量拉取的一次性成本（进窗 ~60-900ms，tryRefresh 异步执行不阻塞应答），
        // 命中 = 纯本地查表（0ms）——移动中每个位置都命中真实元素、真实几何：
        // 跟手性与提供者速度彻底解耦（Shotera 整树缓存同款；此前 EFP 优先时慢提供者
        // 应用上移动中只能靠像素链几何切块冒充元素 = "误窗口"的根源）。
        // EFP 降级为地图未覆盖时的权威补充（首帧/出窗/地图缺项）。
        // 光标所在窗口的地图槽：findSlot 已做包含性判定（矩形含光标即命中），无需 winKey 预判
        const snap = findSlot(x, y);
        const winKey = winKeyOf(snap && snap.win);
        if (winKey !== lastWinKey) {
          lastWinKey = winKey;
          rowMissingCount = 0;
        }
        if (!snap || now - snap.t > REFRESH_MS) {
          tryRefresh(x, y);
        }
        let levels = [];
        let rowMissing = false;
        const pick = (s) => {
          const out = [];
          for (const it of (s.json.items || [])) {
            if (inRect(it, x, y, 3)) out.push(it);
          }
          out.sort((a, b) => (a.width * a.height) - (b.width * b.height));
          return out;
        };
        if (snap) {
          levels = pick(snap);
          const win = snap.win;
          const smallest = levels[0];
          rowMissing = !!(smallest
            && (smallest.width * smallest.height) > (win.width * win.height) / 6);
          if (rowMissing) {
            const gap = rowMissingCount < 3 ? RETRY_MS : 1500;
            if (now - lastRowMissingAt >= gap) {
              lastRowMissingAt = now;
              rowMissingCount++;
              tryRefresh(x, y);
            }
          } else {
            rowMissingCount = 0;
          }
        }
        // 地图命中且饱满 → 本地查表应答（0ms）。
        // 瘦图（rowMissing：最小命中块 > 窗口 1/6——首图与微信等懒加载树的唤醒竞态特征，
        // 实测首图可能只有窗/面板级）**不直接应答**：落到 EFP 拿真实行级，tryRefresh 已在
        // 并行重拍，图拍满后 map 应答自动接管（2026-09-28 首次识别稳定性修复）。
        if (levels.length && !rowMissing && snap) {
          const win = snap.win;
          const last = levels[levels.length - 1];
          const sameAsWin = last && Math.abs(last.x - win.x) <= 2 && Math.abs(last.y - win.y) <= 2
            && Math.abs(last.width - win.width) <= 2 && Math.abs(last.height - win.height) <= 2;
          if (!sameAsWin) {
            levels.push({ x: win.x, y: win.y, width: win.width, height: win.height, name: snap.json.window.name, controlType: 'Screen' });
          }
          // 低频交叉校验（600ms）：立即应答地图结果（0ms），异步验证矩形是否过期
          const smallest = levels[0];
          if (!verifying && now - lastVerifyAt > 600) {
            lastVerifyAt = now;
            verifying = true;
            setImmediate(() => {
              try {
                const vbuf = Buffer.alloc(16384);
                const vn = fn(x, y, vbuf, vbuf.length);
                verifying = false;
                if (vn > 0) {
                  const vj = JSON.parse(vbuf.toString('utf8', 0, vn));
                  const v0 = vj.levels && vj.levels[0];
                  if (v0 && (Math.abs(v0.x - smallest.x) > 24 || Math.abs(v0.y - smallest.y) > 24
                    || v0.width !== smallest.width || v0.height !== smallest.height)) {
                    tryRefresh(x, y, smallest); // 带校验的重拍：地图过期 → 立即更新
                  }
                }
              } catch (e) { verifying = false; }
            });
          }
          parentPort.postMessage({
            id: msg.id,
            json: { ok: true, levels, window: snap.json.window, diag: { ms: Date.now() - t0, src: 'map' } },
          });
          return;
        }

        // ── 地图未覆盖/瘦图 → 爬坡期处理 ──
        // Chromium 系应用（Electron/VS Code/Zcode/Trae）懒加载树：首拍必瘦，EFP 单次
        // 240-400ms（Chromium provider 慢），逐帧打 EFP = 爬坡期每拍卡 0.4s。
        // 爬坡期（rowMissing 中）改打 SmartUiaPoke（WM_GETOBJECT 激活戳，毫秒级）主动催树，
        // EFP 限频 120ms 一次（瘦图期间它又慢又堵 worker，少打）；树醒后 rowMissing 消失，
        // map 应答自动接管，全速恢复。
        let efpSkippedThrottle = false;
        if (rowMissing) {
          // 主动催树但**严禁每帧戳**（2026-09-28 回归修复）：SmartUiaPoke 是同步调用
          // （z 序找窗 + ≤16 子窗 × 2 条消息，最坏 ~120ms），逐帧戳 = worker 被堵、
          // 查询排队 = 「识别变钝/小框不出」的回归源。限频 500ms、每窗最多 8 次
          // （树在头几次戳内就会醒；应用本来就粗的场景戳 8 次后放弃）。
          if (now - lastPokeAt >= 500 && pokeCount < 8) {
            lastPokeAt = now;
            pokeCount++;
            try { pokeFn(x, y); } catch { /* poke 失败忽略 */ }
          }
          if (!levels.length || now - lastRowMissingAt < 120) {
            efpSkippedThrottle = !levels.length ? false : true;
          }
        } else {
          pokeCount = 0; // 地图恢复饱满：poke 计数清零，下次进新窗重新计数
        }

        // ── 地图未覆盖/瘦图 → EFP 权威命中 ──
        // 遮罩在悬停态是 click-through（WS_EX_TRANSPARENT），UIA ElementFromPoint 会跳过它，
        // 直接返回目标应用"这个点上最深层的元素"。diag.ms = DLL 调用耗时。
        // 唤醒窗口期限制：rowMissing 超 3 次重拍仍瘦（应用本来就粗）后不再每帧付 EFP 的
        // 13-250ms，接受现状用瘦图应答（5s 安全网继续重拍）。
        const efpWanted = !levels.length || rowMissingCount <= 3;
        if (efpWanted && !efpSkippedThrottle) {
          try {
            const buf = Buffer.alloc(16384);
            const n = fn(x, y, buf, buf.length);
            const ms = Date.now() - t0;
            if (n > 0) {
              const json = JSON.parse(buf.toString('utf8', 0, n));
              if (json.ok && Array.isArray(json.levels) && json.levels.length) {
                json.diag = { ms, src: 'efp' };
                parentPort.postMessage({ id: msg.id, json });
                return;
              }
            }
          } catch (e) { /* 落入快照应答 */ }
        }

        // ── EFP 也无果/已过唤醒窗口：瘦图或空应答 ──
        if (levels.length && snap) {
          const win = snap.win;
          const last = levels[levels.length - 1];
          const sameAsWin = last && Math.abs(last.x - win.x) <= 2 && Math.abs(last.y - win.y) <= 2
            && Math.abs(last.width - win.width) <= 2 && Math.abs(last.height - win.height) <= 2;
          if (!sameAsWin) {
            levels.push({ x: win.x, y: win.y, width: win.width, height: win.height, name: snap.json.window.name, controlType: 'Screen' });
          }
          parentPort.postMessage({
            id: msg.id,
            json: { ok: true, levels, window: snap.json.window, diag: { ms: Date.now() - t0, src: 'map' } },
          });
          return;
        }
        parentPort.postMessage({
          id: msg.id,
          json: { ok: false, levels: [], window: snap ? snap.json.window : null, diag: { ms: Date.now() - t0, src: 'snap' } },
        });
        } catch (e) {
          try {
            parentPort.postMessage({ id: msg.id, json: { ok: false, levels: [], window: null, error: 'handler:' + ((e && e.message) || String(e)) } });
          } catch (_) { /* ignore */ }
        }
      });
    
