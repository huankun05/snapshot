/*
 * 拾花 PetalSnap —— 问 AI 服务（2026-10-27）
 *
 * 把选区截图 + 用户问题发给用户自配置的 OpenAI 兼容接口
 * （POST {baseUrl}/chat/completions，视觉消息格式），结果以 Markdown 文本返回。
 * 凭据仅存本机（userData/eIsland_store/*.json），经主进程直连服务商，不经过任何中转。
 */

import { readScreenshotAskAiConfig } from '../config/storeConfig';

/** 单次请求超时：视觉大模型首响应可能较慢，给足余量 */
const ASK_AI_TIMEOUT_MS = 120_000;

export type AskAiResult =
  | { success: true; text: string }
  | { success: false; code?: string; message: string };

/**
 * 发起「问 AI」请求。
 * @param dataURL 选区截图（PNG dataURL，含标注）
 * @param question 用户问题；为空时用默认提示词
 */
export async function askAiAboutImage(dataURL: string, question: string): Promise<AskAiResult> {
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
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataURL } },
            ],
          },
        ],
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
