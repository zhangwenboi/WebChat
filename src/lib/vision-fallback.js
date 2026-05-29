/**
 * 视觉副模型 fallback
 *
 * 主模型不支持视觉时（visionCapable=false 或用户未勾 supportsVision），
 * 用一个用户指定/自动选定的、视觉能力齐全的副模型把每张图片转成文字描述，
 * 再把描述拼回主模型的 user message 里一起回答。
 *
 * 调用方在 background 上下文。导出两个函数：
 *   - pickFallbackProvider(settings)
 *   - describeImages(images, providerKey, providerConfig)
 */

import { PROVIDERS } from './providers.js';
import { ApiAdapter } from './api-adapter.js';

const PROMPT = '请用一段不超过 200 字的中文描述这张图片的客观内容；如有可读文字请原文摘录关键句。不要主观评价，不要发挥联想。';
const CONCURRENCY = 3;
// 自动挑选时的优先级：先云端再本地
const AUTO_PICK_ORDER = ['openai', 'claude', 'gemini', 'ollama'];

/**
 * 在 settings 中挑一个可用的视觉副模型
 * @returns {{ providerKey: string, providerConfig: object } | null}
 */
export function pickFallbackProvider(settings) {
  const providers = settings?.providers || {};
  const candidates = [];

  // 1) 用户指定优先
  const explicit = settings?.visionFallbackProvider;
  if (explicit && PROVIDERS[explicit]?.visionCapable !== false) {
    candidates.push(explicit);
  }

  // 2) 自动挑：按 AUTO_PICK_ORDER 顺序补充
  for (const key of AUTO_PICK_ORDER) {
    if (!candidates.includes(key) && PROVIDERS[key]?.visionCapable) {
      candidates.push(key);
    }
  }

  for (const key of candidates) {
    const provider = PROVIDERS[key];
    const config = providers[key];
    if (!provider || !config) continue;
    // ollama 不需要 key
    if (provider.requiresKey && !config.apiKey) continue;
    return { providerKey: key, providerConfig: config };
  }

  return null;
}

/**
 * 把一组图片逐张转成文字描述
 * @param {Array<{id?:string, dataUrl:string, alt?:string, source?:string}>} images
 * @param {string} providerKey
 * @param {object} providerConfig
 * @returns {Promise<Array<{id?:string, ok:boolean, description:string, error?:string}>>}
 */
export async function describeImages(images, providerKey, providerConfig) {
  if (!Array.isArray(images) || images.length === 0) return [];

  const adapter = new ApiAdapter(providerKey, providerConfig);
  const results = new Array(images.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= images.length) return;
      const img = images[i];
      try {
        const messages = [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image', dataUrl: img.dataUrl }
            ]
          }
        ];
        const { text } = await adapter.callOnce(messages, { maxTokens: 400, temperature: 0.2 });
        results[i] = {
          id: img.id,
          ok: true,
          description: (text || '').trim()
        };
      } catch (err) {
        results[i] = {
          id: img.id,
          ok: false,
          description: '',
          error: err?.message || String(err)
        };
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, images.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * 把 describeImages 的结果格式化成主模型可读的中文段落
 */
export function formatImageDescriptions(images, descriptions) {
  const lines = ['', '【图片描述（来自视觉副模型）】'];
  descriptions.forEach((r, i) => {
    const src = images[i]?.source || 'unknown';
    if (r.ok) {
      lines.push(`图片 ${i + 1}（来源：${src}）：${r.description}`);
    } else {
      lines.push(`图片 ${i + 1}（来源：${src}）：[描述获取失败：${r.error || '未知错误'}]`);
    }
  });
  return lines.join('\n');
}
