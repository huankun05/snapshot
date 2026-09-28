/*
 * GDI 抓帧 worker（2026-09-28 优化专项）：把 captureVirtualScreenComposite 的
 * 逐屏 BitBlt+GetDIBits+行拷贝（双屏 5120×1440 实测 68-100ms）挪出主进程——
 * 期间主进程事件循环不再被堵（smart IPC/托盘/日志全停曾是连锁卡顿源）。
 * koffi 在 worker 内单例加载（同 smartUiaNative 模式）；结果 Buffer 走
 * 结构化克隆传回（30MB 级一次拷贝，远小于主线程被堵的代价）。
 */
import { Worker } from 'worker_threads';
import * as path from 'path';

export interface CompositeFrame {
  bgra: Buffer;
  width: number;
  height: number;
  ms: number;
}

interface CompositeRequest {
  layouts: Array<{ physicalBounds: Electron.Rectangle }>;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, {
  resolve: (f: CompositeFrame | null) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  try {
    // koffi 原生模块必须在 worker 的 CJS require 下可见：打包产物在 app/dist，
    // node_modules 借道 Xiyue（同 build-host.js 的 external 约定）
    const script = `
      const { parentPort } = require('worker_threads');
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      const gdi32 = koffi.load('gdi32.dll');
      const api = {
        GetDC: user32.func('uint64_t GetDC(uint64_t hWnd)'),
        ReleaseDC: user32.func('int ReleaseDC(uint64_t hWnd, uint64_t hdc)'),
        CreateCompatibleDC: gdi32.func('uint64_t CreateCompatibleDC(uint64_t hdc)'),
        DeleteDC: gdi32.func('int DeleteDC(uint64_t hdc)'),
        CreateCompatibleBitmap: gdi32.func('uint64_t CreateCompatibleBitmap(uint64_t hdc, int w, int h)'),
        SelectObject: gdi32.func('uint64_t SelectObject(uint64_t hdc, uint64_t obj)'),
        BitBlt: gdi32.func('int BitBlt(uint64_t hdc, int x, int y, int w, int h, uint64_t hdcSrc, int x1, int y1, uint32_t rop)'),
        GetDIBits: gdi32.func('int GetDIBits(uint64_t hdc, uint64_t hbmp, uint32_t start, uint32_t lines, _Out_ uint8_t *bits, _Inout_ uint8_t *lpbi, uint32_t usage)'),
        DeleteObject: gdi32.func('int DeleteObject(uint64_t obj)'),
      };
      function gdiGrabRect(x, y, w, h) {
        const hdcScreen = api.GetDC(0);
        if (!hdcScreen) return null;
        let hdcMem = 0, hbm = 0, oldBmp = 0;
        let out = null;
        try {
          hdcMem = api.CreateCompatibleDC(hdcScreen);
          hbm = api.CreateCompatibleBitmap(hdcScreen, w, h);
          if (!hdcMem || !hbm) return null;
          oldBmp = api.SelectObject(hdcMem, hbm);
          if (!api.BitBlt(hdcMem, 0, 0, w, h, hdcScreen, Math.round(x), Math.round(y), 0x00cc0020)) return null;
          const bi = Buffer.alloc(40);
          bi.writeUInt32LE(40, 0);
          bi.writeInt32LE(w, 4);
          bi.writeInt32LE(-h, 8);       // top-down
          bi.writeUInt16LE(1, 12);
          bi.writeUInt16LE(32, 14);
          bi.writeUInt32LE(0, 16);      // BI_RGB
          bi.writeUInt32LE(w * h * 4, 20);
          out = Buffer.allocUnsafe(w * h * 4);
          // MSDN：GetDIBits 要求 hbm 未被选入 DC → 先还原旧位图
          if (oldBmp) api.SelectObject(hdcMem, oldBmp);
          const lines = api.GetDIBits(hdcMem, hbm, 0, h, out, bi, 0);
          if (lines !== h) return null;
          return out;
        } finally {
          if (hbm) api.DeleteObject(hbm);
          if (hdcMem) api.DeleteDC(hdcMem);
          api.ReleaseDC(0, hdcScreen);
        }
      }
      parentPort.on('message', (msg) => {
        if (!msg || msg.type !== 'composite') return;
        const t0 = Date.now();
        try {
          const layouts = msg.layouts || [];
          if (!layouts.length) { parentPort.postMessage({ id: msg.id, frame: null }); return; }
          const ox = Math.min(...layouts.map((l) => l.physicalBounds.x));
          const oy = Math.min(...layouts.map((l) => l.physicalBounds.y));
          const width = Math.max(...layouts.map((l) => l.physicalBounds.x + l.physicalBounds.width)) - ox;
          const height = Math.max(...layouts.map((l) => l.physicalBounds.y + l.physicalBounds.height)) - oy;
          if (width < 4 || height < 4 || width > 16384 || height > 16384) {
            parentPort.postMessage({ id: msg.id, frame: null });
            return;
          }
          const out = Buffer.alloc(width * height * 4, 0xff);
          for (const l of layouts) {
            const pb = l.physicalBounds;
            const piece = gdiGrabRect(pb.x, pb.y, pb.width, pb.height);
            if (!piece) { parentPort.postMessage({ id: msg.id, frame: null }); return; }
            const dx = pb.x - ox, dy = pb.y - oy;
            const rowBytes = pb.width * 4;
            for (let row = 0; row < pb.height; row++) {
              piece.copy(out, ((dy + row) * width + dx) * 4, row * rowBytes, (row + 1) * rowBytes);
            }
          }
          parentPort.postMessage({ id: msg.id, frame: { bgra: out, width, height, ms: Date.now() - t0 } });
        } catch (e) {
          parentPort.postMessage({ id: msg.id, frame: null, error: (e && e.message) || String(e) });
        }
      });
    `;
    worker = new Worker(script, { eval: true });
    worker.unref();
    worker.on('message', (m: { id: number; frame: CompositeFrame | null; error?: string }) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) console.warn('[GdiGrabWorker] error:', m.error);
      p.resolve(m.frame);
    });
    worker.on('error', (err: unknown) => {
      console.warn('[GdiGrabWorker] worker error:', (err as Error)?.message || err);
      for (const [, p] of pending) { clearTimeout(p.timer); p.resolve(null); }
      pending.clear();
      worker = null;
    });
    worker.on('exit', (code) => {
      if (code !== 0) console.warn('[GdiGrabWorker] exited code =', code);
      for (const [, p] of pending) { clearTimeout(p.timer); p.resolve(null); }
      pending.clear();
      if (worker) { worker = null; }
    });
    return worker;
  } catch (err) {
    console.warn('[GdiGrabWorker] init failed:', (err as Error)?.message || err);
    worker = null;
    return null;
  }
}

/**
 * 异步全虚拟屏合成抓帧（worker 内执行，不堵主进程）。
 * 失败/超时返回 null（调用方走 desktopCapturer 回退）。
 */
export function captureVirtualScreenCompositeAsync(
  layouts: Array<{ physicalBounds: Electron.Rectangle }>,
  timeoutMs = 2000,
): Promise<CompositeFrame | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  const req: CompositeRequest = { layouts };
  return new Promise<CompositeFrame | null>((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve(null);
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    w.postMessage({ type: 'composite', id, ...req });
  });
}

/** 供路径引用（worker 的 koffi require 解析基于编译产物所在目录） */
export const GDIGRAB_WORKER_DIR = path.join(__dirname);
