/*
 * eIsland - A sleek, Apple Dynamic Island inspired floating widget for Windows, built with Electron.
 * https://github.com/JNTMTMTM/eIsland
 *
 * Copyright (C) 2026 JNTMTMTM
 * Copyright (C) 2026 pyisland.com
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * @file ocrAssetsService.ts
 * @description OCR 可选资产（表格/智能版面模型、Tesseract 语言包）的状态与手动下载。
 *   2026-11-22 起「按需自动下载」全部改为设置窗显式下载（缺口1/2）：
 *   - 表格(7.4MB)/智能版面(124.5MB)：18766 服务 POST /models/download，落 venv 包目录；
 *     服务端 /smart /table 对缺失模型直接报 modelMissing，不再静默联网。
 *   - Tesseract 语言包 chi_sim+eng(7.4MB)：主进程下载到 userData/tessdata 并解压 gzip；
 *     captureLocalOcrService 的 cachePath 指向该目录，就绪前优先级链跳过 Tesseract。
 */
import { app, net } from 'electron';
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { ensureRapidOcrService } from './rapidOcrService';
import { getTessdataDir, isLangPackReady } from './captureLocalOcrService';

const SERVICE_PORT = 18766;

/** 18766 服务端点（与 rapidocr_service.py /models/download 一致） */
const SERVICE_MODEL_URLS: Record<string, { name: string; url: string }> = {
  layout: { name: '智能版面 PP-DocLayoutV3', url: 'https://www.modelscope.cn/models/RapidAI/RapidLayout/resolve/v1.2.0/onnx/pp_doc_layout/pp_doc_layoutv3.onnx' },
  table: { name: '表格结构 SLANet-plus', url: 'https://www.modelscope.cn/models/RapidAI/RapidTable/resolve/v2.0.0/slanet-plus.onnx' },
};

/** Tesseract 语言包（jsdelivr CDN，与 tesseract.js 内置默认同源，4.0.0 为 legacy+LSTM 全量档） */
const LANG_PACK_URLS: Record<string, string> = {
  chi_sim: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim/4.0.0/chi_sim.traineddata.gz',
  eng: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz',
};

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** 正在进行的下载（并发去重：重复点击只跑一次） */
const inFlight = new Map<string, Promise<{ ok: boolean; message?: string }>>();

export type OcrAssetStatus = {
  id: string;
  name: string;
  ok: boolean;
  sizeMb?: number;
  message?: string;
};

function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET' });
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      try { req.abort(); } catch { /* ignore */ }
      done(() => reject(new Error('下载超时')));
    }, DOWNLOAD_TIMEOUT_MS);
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        done(() => reject(new Error(`HTTP ${res.statusCode}`)));
        return;
      }
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        done(() => resolve(Buffer.concat(chunks)));
      });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      done(() => reject(e));
    });
    req.end();
  });
}

/** Tesseract 语言包状态（chi_sim+eng 是否已就绪） */
export function getLangPackStatus(): OcrAssetStatus {
  const ready = isLangPackReady();
  let sizeMb = 0;
  try {
    for (const lang of Object.keys(LANG_PACK_URLS)) {
      const fp = join(getTessdataDir(), `${lang}.traineddata`);
      if (existsSync(fp)) sizeMb += statSync(fp).size / 1024 / 1024;
    }
  } catch { /* ignore */ }
  return {
    id: 'tessdata',
    name: 'Tesseract 语言包（chi_sim + eng）',
    ok: ready,
    sizeMb: sizeMb > 0 ? Math.round(sizeMb * 10) / 10 : undefined,
    message: ready
      ? '兜底引擎语言包已就绪，可离线使用'
      : '兜底引擎不可用；下载后 Tesseract 兜底离线生效（约 7.4MB）',
  };
}

/** 下载 Tesseract 语言包（重复点击复用在途请求） */
export function downloadLangPack(): Promise<{ ok: boolean; message?: string }> {
  const existing = inFlight.get('tessdata');
  if (existing) return existing;
  const task = (async () => {
    const dir = getTessdataDir();
    mkdirSync(dir, { recursive: true });
    const results: string[] = [];
    for (const [lang, url] of Object.entries(LANG_PACK_URLS)) {
      const fp = join(dir, `${lang}.traineddata`);
      try {
        const gz = await fetchBuffer(url);
        const raw = gunzipSync(gz);
        const tmp = `${fp}.part`;
        writeFileSync(tmp, raw);
        // 已存在则覆盖（重新下载 = 更新）
        try { unlinkSync(fp); } catch { /* not exists */ }
        try {
          renameSync(tmp, fp);
        } catch {
          copyFileSync(tmp, fp); // 跨卷 rename 失败时退回复制
          try { unlinkSync(tmp); } catch { /* ignore */ }
        }
        results.push(`${lang} ${(raw.length / 1024 / 1024).toFixed(1)}MB`);
      } catch (e) {
        return { ok: false, message: `${lang} 下载失败：${e instanceof Error ? e.message : String(e)}` };
      }
    }
    return { ok: true, message: `已下载 ${results.join(' + ')}` };
  })();
  inFlight.set('tessdata', task);
  void task.finally(() => inFlight.delete('tessdata'));
  return task;
}

/** 表格/智能版面模型状态（来自 18766 /health，服务不可用时标缺失） */
export async function getServiceModelStatuses(): Promise<OcrAssetStatus[]> {
  try {
    const ok = await ensureRapidOcrService();
    if (!ok) {
      return Object.entries(SERVICE_MODEL_URLS).map(([id, m]) => ({
        id, name: m.name, ok: false, message: '本地识别服务未运行，无法读取模型状态',
      }));
    }
    const res = await fetchBuffer(`http://127.0.0.1:${SERVICE_PORT}/health`);
    const health = JSON.parse(res.toString('utf-8')) as { models?: Record<string, { id?: string; name?: string; ok?: boolean; size_mb?: number; note?: string }> };
    const out: OcrAssetStatus[] = [];
    for (const id of Object.keys(SERVICE_MODEL_URLS)) {
      const m = health.models?.[id];
      out.push({
        id,
        name: m?.name || SERVICE_MODEL_URLS[id].name,
        ok: !!m?.ok,
        sizeMb: m?.size_mb,
        message: m?.ok ? undefined : (m?.note || '未下载；点击下载后「表格识别/智能识别」可用'),
      });
    }
    return out;
  } catch (e) {
    return Object.entries(SERVICE_MODEL_URLS).map(([id, m]) => ({
      id, name: m.name, ok: false,
      message: `状态读取失败：${e instanceof Error ? e.message : String(e)}`,
    }));
  }
}

/** 手动下载表格/智能版面模型：转发给 18766 /models/download（服务端落盘到 venv 包目录） */
export async function downloadServiceModel(id: string): Promise<{ ok: boolean; message?: string }> {
  const target = SERVICE_MODEL_URLS[id];
  if (!target) return { ok: false, message: `未知模型 id：${id}` };
  const key = `service:${id}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = (async () => {
    try {
      const okService = await ensureRapidOcrService();
      if (!okService) return { ok: false, message: '本地识别服务未运行' };
      return await postServiceJson(`/models/download`, { id });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  })();
  inFlight.set(key, task);
  void task.finally(() => inFlight.delete(key));
  return task;
}

/** POST JSON 到 18766 并解析响应（大模型下载可达百秒级，超时 10 分钟） */
function postServiceJson(path: string, body: unknown): Promise<{ ok: boolean; message?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const req = net.request({
      url: `http://127.0.0.1:${SERVICE_PORT}${path}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    let settled = false;
    const timer = setTimeout(() => {
      try { req.abort(); } catch { /* ignore */ }
      if (!settled) { settled = true; reject(new Error('下载超时（模型较大请耐心等待后重试状态）')); }
    }, DOWNLOAD_TIMEOUT_MS);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(e); }
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ===== 引擎优先级链状态（2026-11-22 第二批：设置页状态化 + 执行时可用性沉底）=====

export type OcrChainEngineState = 'ready' | 'off' | 'missing' | 'error';

export type OcrChainEngineStatus = {
  state: OcrChainEngineState;
  reason: string;
  downloadable?: boolean;
};

/** 快速 HTTP 探测（超时即不可达；用于链状态与执行排序，不拉起服务） */
export function probeHttpOk(url: string, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) { settled = true; resolve(v); }
    };
    try {
      const req = net.request({ url, method: 'GET' });
      const timer = setTimeout(() => {
        try { req.abort(); } catch { /* ignore */ }
        done(false);
      }, timeoutMs);
      req.on('response', (res) => {
        clearTimeout(timer);
        done(res.statusCode === 200);
      });
      req.on('error', () => {
        clearTimeout(timer);
        done(false);
      });
      req.end();
    } catch {
      done(false);
    }
  });
}

/** 各引擎当前状态（设置页展示用；探测不拉起服务，"off"=可恢复的暂不可用） */
export async function getOcrChainStatus(getLoggedIn: () => boolean, paddleModelsOk: () => boolean): Promise<Record<string, OcrChainEngineStatus>> {
  const [rapid, paddle] = await Promise.all([
    probeHttpOk('http://127.0.0.1:18766/health'),
    probeHttpOk('http://127.0.0.1:18765/health'),
  ]);
  const status: Record<string, OcrChainEngineStatus> = {
    rapidocr: rapid
      ? { state: 'ready', reason: '' }
      : { state: 'off', reason: '识别服务未运行（识别时自动拉起，约 2s）' },
    paddle: paddle
      ? { state: 'ready', reason: '' }
      : (paddleModelsOk()
        ? { state: 'off', reason: '侧车未运行（识别时自动拉起，首次约 7-10s）' }
        : { state: 'missing', reason: '模型未部署（约 4.1GB，随安装器选装）' }),
    tesseract: isLangPackReady()
      ? { state: 'ready', reason: '' }
      : { state: 'missing', reason: '语言包未下载（约 7.4MB）', downloadable: true },
    wxocr: { state: 'off', reason: '仅 F2 宿主（Tauri 壳）可用' },
    wmocr: { state: 'off', reason: '仅 F2 宿主（Tauri 壳）可用' },
    server: getLoggedIn()
      ? { state: 'ready', reason: '' }
      : { state: 'off', reason: '需登录账号' },
  };
  return status;
}

/**
 * 按当前可用性把链稳定分区排序：可用在前（保持用户相对顺序），不可用沉底（仍会尝试——
 * 保留服务自愈与"稍后恢复"的可能，只是不让故障引擎挡在可用引擎前面）。
 */
export async function orderChainByAvailability(chain: string[], status: Record<string, OcrChainEngineStatus>): Promise<string[]> {
  const ready: string[] = [];
  const deferred: string[] = [];
  for (const id of chain) {
    const s = status[id];
    if (s && s.state !== 'ready') deferred.push(id);
    else ready.push(id);
  }
  return [...ready, ...deferred];
}
