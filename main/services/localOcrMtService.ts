/*
 * eIsland / Xiyue - 本地 OCR / 机器翻译服务桥接
 *
 * 拉起用户本机的 Python 服务（F:\Work\Create\OCR\local_capture_service.py），
 * 该服务复用用户已有的 PaddleOCR（高精度 OCR）与 llama.cpp + 腾讯混元 Hy-MT2
 * （端侧翻译模型）能力，全部本机运行、免费、无需账号 / 验证码。
 *
 * 主进程首次用到时按需 spawn（懒启动），带健康探测与进程保活；
 * 应用退出时调用 stopLocalOcrMtService 回收 Python 进程。
 *
 * ⚠️ 2026-11-02「整机崩溃」事故（详见 docs/功能状态清单.md）：
 *   侧车 python 会拉起 llama-server.exe（Hy-MT2 翻译模型，~1.2GB 显存/个）。
 *   Windows 上 proc.kill() 是 TerminateProcess → **不跑 python 的 atexit**
 *   → mt_engine.shutdown() 不执行 → llama-server 变孤儿继续占显存
 *   → 攒到 6~7 个（本机 RTX 4070 Laptop 只有 8GB）就打满 → CUDA 降级共享内存
 *   → 系统内存雪崩 → 整机崩溃。
 *   ⇒ 现在一律用 taskkill /T 连进程树一起杀；并在拉起前清扫「父进程已死」的残骸。
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { createConnection } from 'net';
import { readScreenshotLocalOcrDirConfig, DEFAULT_LOCAL_OCR_DIR } from '../config/storeConfig';

const LOCAL_OCR_MT_PORT = 18765;
const BASE_URL = `http://127.0.0.1:${LOCAL_OCR_MT_PORT}`;

/** Xiyue 翻译语言代码 → mt_engine 使用的中文全称 */
const LANG_CODE_TO_NAME: Record<string, string> = {
  zh: '中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  ru: '俄语',
};

export function toTargetName(code: string): string {
  return LANG_CODE_TO_NAME[code] ?? '中文';
}

let proc: ChildProcess | null = null;
let starting: Promise<string> | null = null;

function resolveDir(): string {
  const cfg = readScreenshotLocalOcrDirConfig();
  return cfg && cfg.trim() ? cfg.trim() : DEFAULT_LOCAL_OCR_DIR;
}

/** 优先用项目自带 venv，否则回退系统 python。 */
function findPython(dir: string): string {
  const venvWin = join(dir, 'venv_ocr', 'Scripts', 'python.exe');
  if (existsSync(venvWin)) return venvWin;
  const venvSh = join(dir, 'venv_ocr', 'bin', 'python');
  if (existsSync(venvSh)) return venvSh;
  return 'python';
}

/**
 * 连子进程树一起杀（Windows）：taskkill /PID <pid> /T /F。
 *
 * 只杀 python 本体是不够的 —— 它拉起的 llama-server.exe 会变孤儿继续占显存
 * （~1.2GB/个），这是 2026-11-02 整机崩溃事故的直接成因。
 */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10000,
    });
  } catch {
    /* ignore */
  }
}

/** 定位仓库内的孤儿清扫脚本（tools/_sweep_orphans.ps1）；找不到返回 null。 */
function resolveSweepScript(): string | null {
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {
    const p = join(cur, 'tools', '_sweep_orphans.ps1');
    if (existsSync(p)) return p;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * 清扫「父进程已死」的侧车 / llama-server 孤儿（上次崩溃 / 被强杀留下的残骸）。
 *
 * 判据：父进程已不存在 = 孤儿。用户手动 run.bat 起的实例父进程（cmd）存活 → 不动。
 * 脚本是仓库里的唯一事实源（tools/_sweep_orphans.ps1），判据详见其头注释。
 */
function sweepOrphanSidecars(): void {
  const script = resolveSweepScript();
  if (!script) {
    console.warn('[localOcrMt] 找不到 tools/_sweep_orphans.ps1 → 跳过孤儿清扫');
    return;
  }
  // 优先 pwsh 7（UTF-8 友好）；没装就退回 Windows PowerShell 5.1
  //（脚本文件本身已带 UTF-8 BOM，5.1 也能正确解码中文注释）。
  let lastErr = '';
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    try {
      const r = spawnSync(
        shell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { encoding: 'utf-8', windowsHide: true, timeout: 20000 },
      );
      if (r.error) {
        lastErr = `${shell}: ${r.error.message}`;
        continue;
      }
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
      if (out) console.log(`[localOcrMt] ${out}`);
      return;
    } catch (e) {
      lastErr = `${shell}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  console.error(`[localOcrMt] 孤儿清扫失败: ${lastErr}`);
}

/** 端口有没有人在监听。端口在听 = 已有实例在跑，绝不能再拉一个（会多出一个 llama-server）。 */
function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    const done = (v: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(400);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function waitReady(timeoutMs = 25000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return true;
    } catch {
      // 尚未就绪
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 确保本地 OCR/翻译服务已运行，返回其 base URL。
 * 端口可能已被本机其他进程（手动 run.bat / 上次残留的 Electron 实例）占用 ——
 * 优先探测并复用，避免重复 spawn 导致端口绑定失败；无人占用才拉起。
 */
export async function ensureLocalOcrMtService(): Promise<string> {
  touchIdleTimer();
  // 本进程拉起的实例且存活 → 直接复用
  if (proc && !proc.killed) {
    try {
      const r = await fetch(`${BASE_URL}/health`);
      if (r.ok) return BASE_URL;
    } catch {
      // 进程失联，下方重建
    }
  }
  // 端口已被外部实例占用（手动启动 / 上次残留）→ 探测复用，不重复拉起
  try {
    const r = await fetch(`${BASE_URL}/health`);
    if (r.ok) return BASE_URL;
  } catch {
    // 无人占用，需要拉起
  }
  // 端口有人监听但 /health 不通（侧车正忙：加载模型 / 处理请求）→ 绝不能再拉一个：
  // 第二个侧车会再拉一个 llama-server（~1.2GB 显存），8GB 卡上极易堆爆。
  if (await portListening(LOCAL_OCR_MT_PORT)) {
    console.log('[localOcrMt] 18765 已被占用但不健康 → 等待现有实例，不重复拉起');
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const r = await fetch(`${BASE_URL}/health`);
        if (r.ok) return BASE_URL;
      } catch {
        /* 继续等 */
      }
    }
    throw new Error('本地 OCR/翻译服务已在运行但暂不健康（请稍后重试）');
  }
  if (starting) return starting;

  starting = (async () => {
    const dir = resolveDir();
    const script = join(dir, 'local_capture_service.py');
    if (!existsSync(script)) {
      throw new Error(`未找到本地 OCR 服务脚本: ${script}（请在截图设置中指定正确的本地 OCR 目录）`);
    }
    // 拉起前先清扫「父进程已死」的残骸（上次崩溃 / 被强杀留下的侧车 + llama-server）
    sweepOrphanSidecars();
    const python = findPython(dir);
    proc = spawn(python, [script], {
      cwd: dir,
      env: {
        ...process.env,
        PADDLE_PDX_CACHE_HOME: join(dir, 'models'),
        LOCAL_OCR_MT_PORT: String(LOCAL_OCR_MT_PORT),
        // 侧车的「父进程死亡守护」要盯**宿主应用**的 PID。
        // ⚠️ 不能让侧车自己用 os.getppid()：本机 venv 的 Scripts\python.exe 是**转发器**
        //（它自己再拉起一个真正的解释器进程），侧车的直接父进程是那个转发器而不是本应用
        // → 宿主被强杀时转发器还活着（它在等侧车退出）→ 盯 getppid() 永远触发不了。
        PETALSNAP_OWNER_PID: String(process.pid),
        GLOG_minloglevel: '2',
        TF_ENABLE_ONEDNN_OPTS: '0',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.on('exit', () => { proc = null; });
    // Python 子进程 stderr 是 GBK 控制台编码：按 utf-8 硬解会把中文打成「��Ϣ」乱码。
    // 先按 utf-8 解，出现 U+FFFD 再退回 gbk 重解，保证日志可读（不影响功能，只影响排查）。
    proc.stderr?.on('data', (d: Buffer) => {
      let text = d.toString('utf-8');
      if (text.includes('\uFFFD')) {
        try { text = new TextDecoder('gbk').decode(d); } catch { /* 保持原样 */ }
      }
      console.error('[localOcrMt]', text.trimEnd());
    });

    const ok = await waitReady(25000);
    if (!ok) {
      // ⚠️ 必须连树杀：只 kill python 会把它拉起的 llama-server 留成孤儿（显存泄漏）
      killProcessTree(proc.pid);
      proc = null;
      throw new Error('本地 OCR/翻译服务启动超时（请确认 venv_ocr 与本地 OCR 目录配置正确）');
    }
    return BASE_URL;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/**
 * 应用退出时回收 Python 进程。
 *
 * ⚠️ 必须连子进程树一起杀：Windows 上 proc.kill('SIGTERM') 也是 TerminateProcess，
 * 不跑 python 的 atexit → mt_engine.shutdown() 不执行 → 它拉起的 llama-server
 * 变孤儿继续占显存（~1.2GB/个）→ 多次启停就把 8GB 显存打满 → 整机崩溃
 * （2026-11-02 事故）。taskkill /T 连树杀是唯一可靠做法。
 */
export function stopLocalOcrMtService(): void {
  stopIdleTimer();
  if (proc && !proc.killed) {
    killProcessTree(proc.pid);
  }
  proc = null;
}

// ── 空闲回收（2026-09-28）：PaddleOCR+CUDA 侧车 GB 级常驻曾是默认行为——首次截图预热后
// 永不回收（stopLocalOcrMtService 此前无任何调用点）。现改为 10 分钟无请求自动回收，
// 下次请求时 ensure 幂等重拉（waitReady 通道已有，配合「正在加载」提示）。
const IDLE_RECYCLE_MS = 10 * 60 * 1000;
let lastUsedAt = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function stopIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function touchIdleTimer(): void {
  lastUsedAt = Date.now();
  stopIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (proc && !proc.killed && Date.now() - lastUsedAt >= IDLE_RECYCLE_MS - 1000) {
      console.log('[LocalOcrMt] idle recycle (no request for 10min) → stopping python sidecar');
      stopLocalOcrMtService();
    }
  }, IDLE_RECYCLE_MS);
  idleTimer?.unref?.();
}

async function postJson(
  url: string,
  payload: unknown,
  signal: AbortSignal,
  timeoutMs = 300000,
): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = (): void => ctrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export type LocalOcrResult = { success: boolean; text?: string; code?: string; message?: string };

/** 用本机 PaddleOCR 识别截图文字。 */
export async function recognizeWithPaddleOcr(
  dataUrl: string,
  signal: AbortSignal,
  modelTier = 'fast',
): Promise<LocalOcrResult> {
  try {
    const base = await ensureLocalOcrMtService();
    const r = await postJson(`${base}/ocr`, { image: dataUrl, model_tier: modelTier }, signal);
    if (r?.ok) return { success: true, text: typeof r.text === 'string' ? r.text : '' };
    return { success: false, code: 'ocrFailed', message: r?.message || '本地 OCR 失败' };
  } catch (error) {
    return {
      success: false,
      code: 'ocrFailed',
      message: error instanceof Error ? error.message : '本地 OCR 服务不可用',
    };
  }
}

export type LocalOcrLayoutResult = {
  success: boolean;
  /** 内嵌图片（base64）的 markdown：图表/公式以图片呈现，表格/文本保留结构 */
  markdown?: string;
  code?: string;
  message?: string;
};

export type LocalOcrLayoutStatus = {
  success: boolean;
  /** PP-StructureV3 是否已加载就绪（未就绪 = 首次调用，正在下载数百 MB 模型） */
  ready?: boolean;
  building?: boolean;
  /** 版面模型是否已下载缓存于本地（true → 等待只是在“加载”，不会再下载） */
  cached?: boolean;
  /** 推理设备：'gpu' | 'cpu'（诊断用） */
  device?: string;
};

/** 当前版面 OCR 请求的可中断控制器（供取消用，单飞模型） */
let layoutOcrController: AbortController | null = null;

/** 中断进行中的版面 OCR（渲染端按 Esc 取消识别时调用）；python 侧会继续把模型加载完并缓存复用 */
export function cancelPendingLayoutOcr(): void {
  layoutOcrController?.abort();
  layoutOcrController = null;
}

/** 查询版面模型加载状态（是否还在下载/构建中），供前端展示友好提示而非干等 */
export async function getLayoutOcrStatus(signal: AbortSignal): Promise<LocalOcrLayoutStatus> {
  try {
    const base = await ensureLocalOcrMtService();
    const r = await postJson(`${base}/ocr_layout/status`, {}, signal, 5000);
    if (r?.ok) {
      return {
        success: true,
        ready: Boolean(r.ready),
        building: Boolean(r.building),
        cached: Boolean(r.cached),
        device: typeof r.device === 'string' ? r.device : 'cpu',
      };
    }
    return { success: false };
  } catch {
    return { success: false };
  }
}

/** 用本机 PP-StructureV3 做版面格式保留识别（图表/表格/公式 → 图 + 结构化文本）。
 *  首次调用需下载数百 MB 模型（数分钟），期间可被 cancelPendingLayoutOcr() 中断等待。 */
export async function recognizeWithPaddleOcrLayout(
  dataUrl: string,
  signal: AbortSignal,
  modelTier = 'fast',
): Promise<LocalOcrLayoutResult> {
  try {
    const base = await ensureLocalOcrMtService();
    const ctrl = new AbortController();
    layoutOcrController = ctrl;
    const onAbort = (): void => ctrl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await postJson(`${base}/ocr_layout`, { image: dataUrl, model_tier: modelTier }, ctrl.signal, 600000);
      if (r?.ok) return { success: true, markdown: typeof r.markdown === 'string' ? r.markdown : '' };
      return { success: false, code: 'ocrLayoutFailed', message: r?.message || '本地版面 OCR 失败' };
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (layoutOcrController === ctrl) layoutOcrController = null;
    }
  } catch (error) {
    const aborted = error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message));
    return {
      success: false,
      code: aborted ? 'ocrLayoutAborted' : 'ocrLayoutFailed',
      message: aborted ? '版面识别已取消' : (error instanceof Error ? error.message : '本地 OCR 服务不可用'),
    };
  }
}

export type LocalTranslateResult = {
  success: boolean;
  /** 图片覆盖模式：本地服务在字体可用时返回的"原文 + 译文叠加"图（PNG dataURL） */
  translatedImage?: string;
  /** 纯文本翻译结果（任意模式下都会返回，便于复制 / 浮窗展示） */
  translatedText?: string;
  /** OCR 提取的逐行文本，用于前端纯文本浮窗渲染（lines[].text + lines[].box） */
  lines?: Array<{ text: string; box: [number, number, number, number] }>;
  /** 图片路径不可用时的降级原因（'no-font' / 'empty-translation' / ...） */
  fallback?: string;
  code?: string;
  message?: string;
};

/** 用本机 Hy-MT2（或经服务转发的云端百度翻译）做图片内翻译：OCR + 段落翻译 + 绘回原图。 */
export async function translateWithLocalMt(
  dataUrl: string,
  targetLangCode: string,
  signal: AbortSignal,
  modelTier = 'fast',
  cloudCfg?: { appId: string; secretKey: string } | null,
): Promise<LocalTranslateResult> {
  try {
    const base = await ensureLocalOcrMtService();
    const body: Record<string, unknown> = {
      image: dataUrl,
      target_lang: toTargetName(targetLangCode),
      model_tier: modelTier,
      mt_provider: cloudCfg ? 'cloud' : 'local',
    };
    if (cloudCfg) {
      body.cloud = { app_id: cloudCfg.appId, secret_key: cloudCfg.secretKey };
    }
    const r = await postJson(`${base}/translate_image`, body, signal, 300000);
    if (r?.ok) {
      const image = typeof r.image === 'string' ? r.image : undefined;
      const text = typeof r.text === 'string' ? r.text : '';
      const fallback = typeof r.fallback === 'string' ? r.fallback : undefined;
      const lines = Array.isArray(r.lines)
        ? r.lines
            .map((l: any) => ({
              text: typeof l?.text === 'string' ? l.text : '',
              box: Array.isArray(l?.box) && l.box.length === 4
                ? [l.box[0], l.box[1], l.box[2], l.box[3]] as [number, number, number, number]
                : [0, 0, 0, 0] as [number, number, number, number],
            }))
            .filter((l: { text: string }) => l.text)
        : undefined;
      return {
        success: true,
        translatedImage: image,
        translatedText: text,
        lines,
        fallback,
      };
    }
    return { success: false, code: 'translationFailed', message: r?.message || '本地翻译失败' };
  } catch (error) {
    return {
      success: false,
      code: 'translationFailed',
      message: error instanceof Error ? error.message : '本地翻译服务不可用',
    };
  }
}

/** 仅翻译文本（不绘回图片），用于将来扩展或调试。 */
export async function translateTextWithLocalMt(
  text: string,
  targetLangCode: string,
  signal: AbortSignal,
  cloudCfg?: { appId: string; secretKey: string } | null,
): Promise<LocalOcrResult> {
  try {
    const base = await ensureLocalOcrMtService();
    const body: Record<string, unknown> = {
      text,
      target_lang: toTargetName(targetLangCode),
      mt_provider: cloudCfg ? 'cloud' : 'local',
    };
    if (cloudCfg) {
      body.cloud = { app_id: cloudCfg.appId, secret_key: cloudCfg.secretKey };
    }
    const r = await postJson(`${base}/translate`, body, signal, 120000);
    if (r?.ok) return { success: true, text: typeof r.text === 'string' ? r.text : '' };
    return { success: false, code: 'translationFailed', message: r?.message || '本地翻译失败' };
  } catch (error) {
    return {
      success: false,
      code: 'translationFailed',
      message: error instanceof Error ? error.message : '本地翻译服务不可用',
    };
  }
}
