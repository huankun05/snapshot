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
let worker: Worker | null | undefined; // undefined=未启动, null=不可用/待重建
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
      const hitFn = lib.func('int SmartUiaHitOnly(int32_t physX, int32_t physY, char *outJson, int32_t outCap)');
      // ── 连续采样（Shotera 机制）：后台线程对光标位置持续命中测试（~25ms 一次），
      // 树永远保温；查询到达时立即返回最新采样（0 等待）。新鲜窗 150ms / 位移 60px。
      let latest = null;   // { json, x, y, t }
      let hitting = false;
      let pendingHit = null;
      const kickHit = (x, y) => {
        pendingHit = { x, y };
        if (hitting) return;
        hitting = true;
        setImmediate(() => {
          while (pendingHit) {
            const p = pendingHit;
            pendingHit = null;
            try {
              const buf = Buffer.alloc(16384);
              const n = hitFn(p.x, p.y, buf, buf.length);
              if (n > 0) {
                let json = JSON.parse(buf.toString('utf8', 0, n));
                const l0 = (json.levels || [])[0];
                const w = json.window;
                // 粗框自动深挖（后台时间充裕）：HitOnly 首答大容器（微信 Qt 常态）→
                // HoverDeep 浅钻取出行/气泡，只缓存细结果——否则大框会霸占应答
                if (l0 && w && (l0.width * l0.height) > (w.width * w.height) / 8) {
                  const b2 = Buffer.alloc(16384);
                  const n2 = deepFn(p.x, p.y, b2, b2.length);
                  if (n2 > 0) {
                    const j2 = JSON.parse(b2.toString('utf8', 0, n2));
                    if (j2.ok && (j2.levels || []).length) json = j2;
                  }
                }
                if (json.ok && Array.isArray(json.levels) && json.levels.length) {
                  latest = { json, x: p.x, y: p.y, t: Date.now() };
                }
              }
            } catch (e) { /* 采样失败丢弃 */ }
          }
          hitting = false;
        });
      };
      const snapFn = lib.func('int SmartUiaSnapshot(int32_t physX, int32_t physY, char *outJson, int32_t outCap)');
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
        const now = Date.now();
        const x = msg.x | 0, y = msg.y | 0;

        // ── 连续采样：后台已在跑/立即开跑（树保温 + 结果常备）──
        kickHit(x, y);
        const l = latest;
        const llv = (l && l.json && l.json.levels || [])[0];
        const lwin = l && l.json && l.json.window;
        const lCoarse = !llv || !lwin || (llv.width * llv.height) > (lwin.width * lwin.height) / 8;
        if (l && !lCoarse && now - l.t < 150
          && Math.abs(l.x - x) <= 60 && Math.abs(l.y - y) <= 60) {
          parentPort.postMessage({ id: msg.id, json: l.json });
          return;
        }

        // ── 主路径：逐帧 EFP 权威命中（Shotera 机制）──
        // 遮罩在悬停态是 click-through（WS_EX_TRANSPARENT），UIA ElementFromPoint 会跳过它，
        // 直接返回目标应用"这个点上最深层的元素"——永远新鲜、永远最小，单次 5-30ms。
        // 无快照滞后 → 路径上不会出现"数据缺口跳大容器"的跳变。
        try {
          const buf = Buffer.alloc(16384);
          const n = fn(x, y, buf, buf.length);
          if (n > 0) {
            const json = JSON.parse(buf.toString('utf8', 0, n));
            if (json.ok && Array.isArray(json.levels) && json.levels.length) {
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
          json: { ok: !!snap && levels.length > 0, levels, window: snap ? snap.json.window : null },
        });
      });
    `;
    const w = new Worker(script, { eval: true });
    w.unref();
    w.on('message', (m: { id: number; json: any }) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(normalize(m.json));
    });
    w.on('error', (err) => {
      console.warn('[SmartUia] worker error:', err?.message || err);
      failAllPending();
      if (worker === w) worker = null;
    });
    w.on('exit', () => {
      failAllPending();
      if (worker === w) worker = null;
    });
    worker = w;
    return w;
  } catch (err) {
    console.warn('[SmartUia] worker init failed:', err?.message || err);
    worker = null;
    return null;
  }
}

function postQuery(x: number, y: number): Promise<SmartUiaResult> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(smartUiaGetLevels(x, y));
  return new Promise<SmartUiaResult>((resolve) => {
    const id = ++reqSeq;
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        resolve({ ...FAIL_RESULT, error: 'timeout' });
        // 卡死在跨进程调用上就终止重建；线程无法中断，只能换新
        if (worker === w) {
          try { w.terminate(); } catch { /* ignore */ }
          worker = null;
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
