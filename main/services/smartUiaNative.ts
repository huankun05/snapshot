/*
 * @file smartUiaNative.ts
 * @description 智能选区 C++ 原生 UIA（smart_uia.dll）。
 * UIA 查询跑在 worker_threads 里（跨进程 COM 等待不再阻塞主进程，OCR/托盘零影响）；
 * 查询按"在跑 + 至多排一个最新"合并，防止悬停连发堆积。像素检测是 0.4ms 级本地计算，留在主线程。
 * 坐标：物理像素进出；DIP 换算由调用方完成。
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { Worker } from 'worker_threads';

interface SmartLevelJson {
  x: number; y: number; width: number; height: number;
  name?: string; controlType?: string;
}

export interface SmartUiaResult {
  ok: boolean;
  levels: SmartLevelJson[];
  window: SmartLevelJson | null;
  error?: string;
  /** 2026-09-23 延迟埋点:ms=worker 内 DLL 调用耗时;src=efp/snap */
  diag?: { ms?: number; src?: string };
}

const FAIL_RESULT: SmartUiaResult = { ok: false, levels: [], window: null, error: 'worker' };

let cachedFn: ((x: number, y: number, buf: Buffer, cap: number) => number) | null | undefined;
let cachedPrepare: ((data: Buffer, w: number, h: number, stride: number) => number) | null | undefined;
let cachedPixelDetect: ((px: number, py: number, bx: number, by: number, bw: number, bh: number, buf: Buffer, cap: number) => number) | null | undefined;

function findDll(): string | null {
  const candidates = [
    join(process.cwd(), 'native', 'smart_uia', 'smart_uia.dll'),
    join(process.cwd(), 'screenshot', 'native', 'smart_uia', 'smart_uia.dll'),
    join(__dirname, '../native/smart_uia/smart_uia.dll'),
    join(__dirname, '../../native/smart_uia/smart_uia.dll'),
    join(__dirname, '../../../native/smart_uia/smart_uia.dll'),
  ];
  return candidates.find((c) => existsSync(c)) || null;
}

function loadSmartUia() {
  if (cachedFn !== undefined) return cachedFn;
  try {
    const dll = findDll();
    if (!dll) {
      console.warn('[SmartUia] smart_uia.dll not found');
      cachedFn = null;
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const lib = koffi.load(dll);
    // int SmartUiaGetLevels(int x, int y, char* out, int cap)
    cachedFn = lib.func('int SmartUiaGetLevels(int32_t physX, int32_t physY, char *outJson, int32_t outCap)');
    // 像素矩形层级检测（docs/智能选区-技术方案对比与像素检测方案.md §五）
    cachedPrepare = lib.func('int SmartPixelFramePrepare(const uint8_t *rgba, int32_t w, int32_t h, int32_t stride)');
    cachedPixelDetect = lib.func('int SmartPixelDetectLevels(int32_t px, int32_t py, int32_t bx, int32_t by, int32_t bw, int32_t bh, char *outJson, int32_t outCap)');
    console.log('[SmartUia] loaded', dll);
  } catch (err) {
    console.error('[SmartUia] load failed:', err);
    cachedFn = null;
  }
  return cachedFn;
}

function normalize(json: any): SmartUiaResult {
  return {
    ok: !!json?.ok,
    levels: Array.isArray(json?.levels) ? json.levels : [],
    window: json?.window || null,
    error: json?.error,
    diag: json?.diag,
  };
}

/** 同步查询（主线程，worker 不可用时的回退） */
export function smartUiaGetLevels(physX: number, physY: number): SmartUiaResult {
  const fn = loadSmartUia();
  if (!fn) {
    return { ok: false, levels: [], window: null, error: 'dll-missing' };
  }
  try {
    const cap = 16384;
    const buf = Buffer.alloc(cap);
    const n = fn(Math.round(physX), Math.round(physY), buf, cap);
    if (n <= 0) {
      return { ok: false, levels: [], window: null, error: `n=${n}` };
    }
    return normalize(JSON.parse(buf.toString('utf-8', 0, n)));
  } catch (err) {
    console.error('[SmartUia] call failed:', err);
    return { ok: false, levels: [], window: null, error: String(err) };
  }
}

// ── worker 线程：UIA 查询不阻塞主进程 ──────────────────────────────
// DLL 的 COM 初始化按线程独立，worker 里加载的是独立 DLL 实例；超时 1.5s 杀掉重建
// （目标应用挂死时跨进程调用可能长时间不返回，不能拖住悬停刷新）。
let worker: Worker | null | undefined; // undefined=未启动/可重建, null=不可用（退避期内）
let workerRestartAt = 0;
const WORKER_RESTART_BACKOFF_MS = 300;
let reqSeq = 0;
let running = false;
let queued: Array<{ x: number; y: number; resolve: (r: SmartUiaResult) => void }> = [];
const pending = new Map<number, { resolve: (r: SmartUiaResult) => void; timer: NodeJS.Timeout }>();

function failAllPending() {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ...FAIL_RESULT, error: 'worker-gone' });
  }
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (worker !== undefined) return worker;
  // 崩溃/超时后的重建退避：期间快速失败（渲染端像素链兜底），绝不退回主线程同步 EFP
  if (Date.now() - workerRestartAt < WORKER_RESTART_BACKOFF_MS) return null;
  worker = null;
  try {
    const dllPath = findDll();
    if (!dllPath) return null;
    const koffiPath = require.resolve('koffi');
    const script = `
      const { parentPort } = require('worker_threads');
      const koffi = require(${JSON.stringify(koffiPath)});
      const lib = koffi.load(${JSON.stringify(dllPath)});
      const fn = lib.func('int SmartUiaGetLevels(int32_t physX, int32_t physY, char *outJson, int32_t outCap)');
      const snapFn = lib.func('int SmartUiaSnapshot(int32_t physX, int32_t physY, char *outJson, int32_t outCap)');
      // 未捕获异常兜底：stderr 管道在进程退出竞态下会丢数据（实测 code=1 死亡但无堆栈），
      // 走 message 通道把堆栈可靠带回主进程，随后自尽由主进程重建
      process.on('uncaughtException', (e) => {
        try { parentPort.postMessage({ type: 'crash', stack: (e && e.stack) || String(e) }); } catch (_) {}
        process.exit(1);
      });
      // 快照 + 本地命中测试：每 1.2s（或窗变化/光标出窗）做一次全子树快照（1 次跨进程调用，
      // 微信 Qt provider 这一次要 ~200ms），之后每帧"光标在哪个元素里"纯本地计算——
      // 跟手性与提供者速度彻底解耦。这是 Shotera"整树缓存请求"的同款架构。
      let snap = null;            // { json, win:{x,y,width,height}, t }
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
      // 后台异步重拍：快照本身 ~200ms 同步调用，绝不在消息处理内联执行（否则每拍都
      // 卡住响应——"移动卡顿"的来源）。当前消息立即用现有快照应答，新快照下一帧生效。
      const tryRefresh = (x, y) => {
        const now = Date.now();
        if (refreshing || now - lastSnapAttempt < RETRY_MS) return;
        lastSnapAttempt = now;
        refreshing = true;
        setImmediate(() => {
          try {
            const buf = Buffer.alloc(262144);
            const n = snapFn(x, y, buf, buf.length);
            if (n > 0) {
              const json = JSON.parse(buf.toString('utf8', 0, n));
              if (json.ok && json.window) {
                snap = { json, win: json.window, t: Date.now() };
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

        // ── 主路径：逐帧 EFP 权威命中（Shotera 机制）──
        // 遮罩在悬停态是 click-through（WS_EX_TRANSPARENT），UIA ElementFromPoint 会跳过它，
        // 直接返回目标应用"这个点上最深层的元素"——永远新鲜、永远最小，单次 5-30ms。
        // 无快照滞后 → 路径上不会出现"数据缺口跳大容器"的跳变。
        // diag.ms = DLL 调用耗时（2026-09-23 埋点：先前全链路无耗时数据，切换卡顿无从归因）
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
        } catch (e) { /* 落入快照回退 */ }

        // ── 回退：快照 + 本地命中（EFP 失败/被遮蔽时）──
        const win0 = snap && snap.win;
        const insideWin = win0 && inRect(win0, x, y, 2);
        const winKey = win0 ? (win0.x + ',' + win0.y + ',' + win0.width + ',' + win0.height) : '';
        if (winKey !== lastWinKey) {
          lastWinKey = winKey;
          rowMissingCount = 0;
        }
        if (!snap || !insideWin || now - snap.t > REFRESH_MS) {
          tryRefresh(x, y);
        }
        let levels = [];
        const pick = (s) => {
          const out = [];
          for (const it of (s.json.items || [])) {
            if (inRect(it, x, y, 3)) out.push(it);
          }
          out.sort((a, b) => (a.width * a.height) - (b.width * b.height));
          return out;
        };
        if (snap && insideWin) {
          levels = pick(snap);
          const win = snap.win;
          const smallest = levels[0];
          const rowMissing = smallest
            && (smallest.width * smallest.height) > (win.width * win.height) / 6;
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
        if (levels.length && snap) {
          const win = snap.win;
          const last = levels[levels.length - 1];
          const sameAsWin = last && Math.abs(last.x - win.x) <= 2 && Math.abs(last.y - win.y) <= 2
            && Math.abs(last.width - win.width) <= 2 && Math.abs(last.height - win.height) <= 2;
          if (!sameAsWin) {
            levels.push({ x: win.x, y: win.y, width: win.width, height: win.height, name: snap.json.window.name, controlType: 'Screen' });
          }
        }
        parentPort.postMessage({
          id: msg.id,
          json: { ok: !!snap && levels.length > 0, levels, window: snap ? snap.json.window : null, diag: { ms: Date.now() - t0, src: 'snap' } },
        });
        } catch (e) {
          try {
            parentPort.postMessage({ id: msg.id, json: { ok: false, levels: [], window: null, error: 'handler:' + ((e && e.message) || String(e)) } });
          } catch (_) { /* ignore */ }
        }
      });
    `;
    const w = new Worker(script, { eval: true, stdout: true, stderr: true });
    // worker stderr 收进主进程日志（应用以隐藏窗口启动，stderr 无人接收 → 崩溃堆栈一直丢失，
    // code=1 死因无法定位）。stdout 同理收编，避免 native 噪音直写孤儿句柄。
    w.stderr?.on('data', (d: Buffer) => console.error('[SmartUia][worker-stderr]', String(d).trim()));
    w.stdout?.on('data', (d: Buffer) => console.log('[SmartUia][worker-stdout]', String(d).trim()));
    w.unref();
    w.on('message', (m: { id: number; json: any; type?: string; stack?: string }) => {
      if (m && m.type === 'crash') {
        console.error('[SmartUia][worker-crash]\n' + (m.stack || '(no stack)'));
        return;
      }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(normalize(m.json));
    });
    w.on('error', (err) => {
      console.warn('[SmartUia] worker error:', (err as Error)?.message || String(err));
      failAllPending();
      if (worker === w) {
        worker = undefined;
        workerRestartAt = Date.now();
      }
    });
    w.on('exit', (code) => {
      // 2026-09-23：此前 worker 静默死亡（exit 无日志）→ 整个会话永跌主线程同步 EFP
      // （单次 200-1100ms 阻塞主进程 = 用户实测的「识别时快时慢 + 明显卡顿」）。
      // 现在必打日志留死因，且自动重建（300ms 退避），不再永久报废。
      console.warn('[SmartUia] worker exited, code =', code, '→ 将在退避后自动重建');
      failAllPending();
      if (worker === w) {
        worker = undefined;
        workerRestartAt = Date.now();
      }
    });
    worker = w;
    console.log('[SmartUia] worker started');
    return w;
  } catch (err) {
    console.warn('[SmartUia] worker init failed:', (err as Error)?.message || String(err));
    worker = null;
    return null;
  }
}

function postQuery(x: number, y: number): Promise<SmartUiaResult> {
  const w = ensureWorker();
  if (!w) {
    // 2026-09-23 铁律：主进程**永不**同步执行 EFP——单次 200-1100ms 的跨进程调用会把
    // 主进程整个卡住（渲染端像素链/窗口矩形的 IPC 回包全被堵死 = 卡顿的直接来源）。
    // worker 不可用（启动失败/崩溃退避期）→ 本次快速失败，像素链兜底出框，worker 稍后自动重建。
    return Promise.resolve({ ok: false, levels: [], window: null, error: 'worker-unavailable' });
  }
  return new Promise<SmartUiaResult>((resolve) => {
    const id = ++reqSeq;
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        resolve({ ...FAIL_RESULT, error: 'timeout' });
        // 卡死在跨进程调用上就终止重建；线程无法中断，只能换新
        if (worker === w) {
          try { w.terminate(); } catch { /* ignore */ }
          worker = undefined;
          workerRestartAt = Date.now();
        }
      }
    }, 1500);
    pending.set(id, { resolve, timer });
    w.postMessage({ type: 'uia', id, x, y });
  });
}

async function drain(x: number, y: number): Promise<SmartUiaResult> {
  let res = await postQuery(x, y);
  // 排队的帧只跑最后一个，其结果同时兑现给同批更早的等待者（光标已移走，给新框比给失败好）
  while (queued.length) {
    const batch = queued.splice(0);
    res = await postQuery(batch[batch.length - 1].x, batch[batch.length - 1].y);
    for (const w of batch) w.resolve(res);
  }
  return res;
}

/** 异步查询：worker 线程执行，主进程零阻塞；连发自动合并（在跑 + 至多排一个最新） */
export function smartUiaGetLevelsAsync(physX: number, physY: number): Promise<SmartUiaResult> {
  const x = Math.round(physX);
  const y = Math.round(physY);
  if (running) {
    return new Promise<SmartUiaResult>((resolve) => {
      if (queued.length >= 2) {
        const dropped = queued.shift();
        if (dropped) dropped.resolve({ ...FAIL_RESULT, error: 'superseded' });
      }
      queued.push({ x, y, resolve });
    });
  }
  running = true;
  return drain(x, y).finally(() => { running = false; });
}


/**
 * 像素矩形层级：会话帧缓存（截图帧 RGBA，物理像素）。
 * DLL 内部单槽缓存（前景掩码 + 积分图），重复 Prepare 直接覆盖。
 */
export function smartPixelFramePrepare(data: Uint8Array, w: number, h: number): boolean {
  const fn = loadSmartUia();
  if (!fn || !cachedPrepare) return false;
  try {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return cachedPrepare(buf, w, h, w * 4) === 1;
  } catch (err) {
    console.error('[SmartUia] frame prepare failed:', err);
    return false;
  }
}

export interface PixelDetectResult {
  ok: boolean;
  levels: SmartLevelJson[];
  error?: string;
}

/** 像素层级查询：物理像素进出；坐标/边界须在帧范围内 */
export function smartPixelDetectLevels(
  physX: number, physY: number, bx: number, by: number, bw: number, bh: number,
): PixelDetectResult {
  if (!cachedPixelDetect) {
    loadSmartUia();
    if (!cachedPixelDetect) return { ok: false, levels: [], error: 'dll-missing' };
  }
  try {
    const cap = 8192;
    const buf = Buffer.alloc(cap);
    const n = cachedPixelDetect(Math.round(physX), Math.round(physY),
      Math.round(bx), Math.round(by), Math.round(bw), Math.round(bh), buf, cap);
    if (n <= 0) return { ok: false, levels: [], error: `n=${n}` };
    const json = JSON.parse(buf.toString('utf-8', 0, n));
    return {
      ok: !!json.ok,
      levels: Array.isArray(json.levels) ? json.levels : [],
      error: json.error,
    };
  } catch (err) {
    console.error('[SmartUia] pixel detect failed:', err);
    return { ok: false, levels: [], error: String(err) };
  }
}
