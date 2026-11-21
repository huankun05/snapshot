/*
 * 拾花 PetalSnap —— 问 AI 服务（2026-10-27）
 *
 * 把选区截图 + 用户问题发给用户自配置的 OpenAI 兼容接口
 * （POST {baseUrl}/chat/completions，视觉消息格式），结果以 Markdown 文本返回。
 * 凭据仅存本机（userData/eIsland_store/*.json），经主进程直连服务商，不经过任何中转。
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { readScreenshotAskAiConfig } from '../config/storeConfig';

/** 单次请求超时：视觉大模型首响应可能较慢，给足余量 */
const ASK_AI_TIMEOUT_MS = 120_000;

export type AskAiResult =
  | { success: true; text: string }
  | { success: false; code?: string; message: string };

/** 问 AI 模板（2026-11-19 借鉴天若 OCRModes.json）：预设问题 + 可选 system/temperature */
export interface AskAiTemplate {
  prompt: string;
  system?: string;
  temperature?: number;
}

/** 模板清单（resources/ask-ai-modes.json，可编辑；候选路径与 settings.html 同款）。
    与 Tauri 侧 load_ask_ai_modes 同源同文件 —— 两版共用一份模板资产。 */
export function loadAskAiModes(): Array<{
  id: string; label?: string; labelEn?: string; description?: string;
  prompt?: string; system?: string; temperature?: number;
}> {
  const candidates = [
    join(process.cwd(), 'resources', 'ask-ai-modes.json'),
    join(app.getAppPath(), 'resources', 'ask-ai-modes.json'),
    join(__dirname, '../../resources/ask-ai-modes.json'),
    join(__dirname, '../../../resources/ask-ai-modes.json'),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const v: unknown = JSON.parse(readFileSync(p, 'utf-8'));
      if (v && typeof v === 'object' && Array.isArray((v as { modes?: unknown }).modes)) {
        return (v as { modes: Array<{ id: string; label?: string; labelEn?: string; description?: string; prompt?: string; system?: string; temperature?: number }> }).modes;
      }
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return [];
}

/** 按模板 id 解析；找不到/无 prompt 返回 null（调用方退自由提问） */
export function resolveAskAiTemplate(mode: string): AskAiTemplate | null {
  if (!mode) return null;
  const m = loadAskAiModes().find((x) => x && x.id === mode);
  if (!m || typeof m.prompt !== 'string' || !m.prompt.trim()) return null;
  return {
    prompt: m.prompt,
    system: typeof m.system === 'string' ? m.system : '',
    temperature: typeof m.temperature === 'number' ? m.temperature : undefined,
  };
}

/**
 * 发起「问 AI」请求。
 * @param dataURL 选区截图（PNG dataURL，含标注）
 * @param question 用户问题；为空时用默认提示词
 * @param opts 模板注入：system 转为 system 消息，temperature 透传接口
 */
export async function askAiAboutImage(
  dataURL: string,
  question: string,
  opts?: { system?: string; temperature?: number },
): Promise<AskAiResult> {
  const config = readScreenshotAskAiConfig();
  if (!config) {
    return {
      success: false,
      code: 'askAiNotConfigured',
      message: '请先在 设置 → AI 问答 填写 API 地址、密钥与模型名',
    };
  }
  if (typeof dataURL !== 'string' || !dataURL.startsWith('data:image/')) {
    return { success: false, message: '选区图像无效' };
  }
  const prompt = typeof question === 'string' && question.trim() ? question.trim() : '请用中文详细解释这张截图的内容。';

  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASK_AI_TIMEOUT_MS);
  const messages: Array<{ role: string; content: unknown }> = [];
  if (opts?.system && opts.system.trim()) {
    messages.push({ role: 'system', content: opts.system });
  }
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: dataURL } },
    ],
  });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        messages,
        ...(typeof opts?.temperature === 'number' ? { temperature: opts.temperature } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const status = response.status;
      let detail = '';
      try {
        const body = await response.json();
        detail = typeof body?.error?.message === 'string' ? body.error.message : '';
      } catch {
        /* 响应体非 JSON 时忽略 */
      }
      const hint =
        status === 401 || status === 403
          ? '密钥无效或无权限，请检查 API 密钥'
          : status === 404
            ? '地址或模型不存在：确认 API 地址以 /v1 结尾、模型名拼写正确'
            : status === 429
              ? '请求过于频繁或额度不足'
              : `HTTP ${status}`;
      console.error(`[AskAI] HTTP ${status} ${detail ? ': ' + detail.slice(0, 200) : ''}`);
      return { success: false, message: detail ? `${hint}（${detail.slice(0, 160)}）` : hint };
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text.trim()) {
      return { success: true, text: text.trim() };
    }
    return { success: false, message: '接口返回为空（该模型可能不支持图片输入，请换视觉模型）' };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { success: false, message: '请求超时（120 秒），请检查网络或换更快的模型' };
    }
    console.error('[AskAI] request failed:', err);
    return { success: false, message: '无法连接 API，请检查地址与网络' };
  } finally {
    clearTimeout(timer);
  }
}
