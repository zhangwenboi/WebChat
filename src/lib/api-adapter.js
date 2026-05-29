import { PROVIDERS } from './providers.js';

/**
 * API 适配器 — 统一不同提供商的请求和响应格式
 */
export class ApiAdapter {
  constructor(providerKey, config) {
    this.providerKey = providerKey;
    this.provider = PROVIDERS[providerKey];
    this.config = config; // { apiKey, apiBase, model }
  }

  /**
   * 构建请求 URL
   *
   * 对 OpenAI 兼容协议（openai / deepseek / custom）做容错：
   * 用户只填 https://api.deepseek.com 或 https://api.deepseek.com/v1
   * 会被自动补全为 https://api.deepseek.com/v1/chat/completions。
   */
  buildUrl() {
    let url = this.config.apiBase || this.provider.apiBase;

    if (this.provider.requestFormat === 'gemini') {
      url = url.replace('{model}', this.config.model);
      url += `?key=${this.config.apiKey}&alt=sse`;
      return url;
    }

    if (this.provider.requestFormat === 'openai') {
      url = normalizeOpenAIBase(url);
    }

    return url;
  }

  /**
   * 构建请求头
   */
  buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };

    if (this.provider.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    } else if (this.provider.authType === 'x-api-key') {
      headers['x-api-key'] = this.config.apiKey;
    }
    // authType === 'query' 或 'none' 不需要 header 认证

    if (this.provider.extraHeaders) {
      Object.assign(headers, this.provider.extraHeaders);
    }

    return headers;
  }

  /**
   * 构建请求体
   *
   * messages[i].content 可能是字符串，也可能是 multimodal 数组：
   *   [{type:'text', text:'...'}, {type:'image', dataUrl:'data:image/jpeg;base64,...'}]
   * 由各 provider 分支转换成对应格式。
   */
  buildRequestBody(messages, options = {}) {
    const { maxTokens = 2048, temperature = 0.7 } = options;
    const format = this.provider.requestFormat;

    if (format === 'openai') {
      return {
        model: this.config.model,
        messages: messages.map(m => ({
          role: m.role,
          content: toOpenAIContent(m.content)
        })),
        max_tokens: maxTokens,
        temperature,
        stream: true
      };
    }

    if (format === 'anthropic') {
      // Claude 要求 system 单独传，不在 messages 数组中
      const systemMsg = messages.find(m => m.role === 'system');
      const chatMessages = messages.filter(m => m.role !== 'system');

      return {
        model: this.config.model,
        system: contentToText(systemMsg?.content) || '',
        messages: chatMessages.map(m => ({
          role: m.role,
          content: toAnthropicContent(m.content)
        })),
        max_tokens: maxTokens,
        temperature,
        stream: true
      };
    }

    if (format === 'gemini') {
      // Gemini 使用完全不同的格式
      const systemMsg = messages.find(m => m.role === 'system');
      const chatMessages = messages.filter(m => m.role !== 'system');

      const contents = chatMessages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: toGeminiParts(msg.content)
      }));

      const body = {
        contents,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature
        }
      };

      if (systemMsg) {
        body.systemInstruction = { parts: [{ text: contentToText(systemMsg.content) }] };
      }

      return body;
    }

    if (format === 'ollama') {
      // Ollama 不支持视觉（除少数模型），统一降级为纯文本
      return {
        model: this.config.model,
        messages: messages.map(m => ({ role: m.role, content: contentToText(m.content) })),
        stream: true,
        options: {
          temperature,
          num_predict: maxTokens
        }
      };
    }

    // 默认使用 openai 格式
    return {
      model: this.config.model,
      messages: messages.map(m => ({ role: m.role, content: toOpenAIContent(m.content) })),
      max_tokens: maxTokens,
      temperature,
      stream: true
    };
  }

  /**
   * 解析流式响应的一行数据，返回文本内容或 null
   */
  parseStreamLine(line) {
    const format = this.provider.streamFormat;

    if (format === 'sse') {
      return this._parseSSELine(line);
    }

    if (format === 'ndjson') {
      return this._parseNDJSONLine(line);
    }

    if (format === 'json-stream') {
      return this._parseSSELine(line);
    }

    return null;
  }

  _parseSSELine(line) {
    if (!line.startsWith('data: ')) return null;

    const data = line.slice(6).trim();
    if (data === '[DONE]') return { done: true };

    try {
      const parsed = JSON.parse(data);
      return { done: false, content: this._extractContent(parsed) };
    } catch {
      return null;
    }
  }

  _parseNDJSONLine(line) {
    if (!line.trim()) return null;

    try {
      const parsed = JSON.parse(line);

      if (parsed.done) return { done: true };

      return { done: false, content: this._extractContent(parsed) };
    } catch {
      return null;
    }
  }

  /**
   * 从解析后的 JSON 中提取文本内容
   */
  _extractContent(parsed) {
    const format = this.provider.requestFormat;

    if (format === 'openai') {
      return parsed.choices?.[0]?.delta?.content || '';
    }

    if (format === 'anthropic') {
      // Claude SSE 有多种事件类型
      if (parsed.type === 'content_block_delta') {
        return parsed.delta?.text || '';
      }
      return '';
    }

    if (format === 'gemini') {
      return parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    if (format === 'ollama') {
      return parsed.message?.content || '';
    }

    return '';
  }

  /**
   * 判断流是否结束
   */
  isStreamEnd(parsed) {
    const format = this.provider.requestFormat;

    if (format === 'anthropic') {
      return parsed.type === 'message_stop';
    }

    if (format === 'ollama') {
      return parsed.done === true;
    }

    return false;
  }

  /**
   * 非流式一次性调用：用于视觉副模型把图转文字这种"问一下要结果"的场景。
   * 复用 buildHeaders/buildRequestBody，但强制 stream:false，并自行解析单次响应。
   * 返回 { text } 或抛出 Error。
   */
  async callOnce(messages, options = {}, { signal } = {}) {
    const headers = this.buildHeaders();
    const body = this.buildRequestBody(messages, options);

    // 关掉 stream
    if ('stream' in body) body.stream = false;

    // URL 调整：Gemini 流式 URL 形如 .../models/{m}:streamGenerateContent?...&alt=sse
    let url = this.buildUrl();
    if (this.provider.requestFormat === 'gemini') {
      url = url.replace(':streamGenerateContent', ':generateContent').replace('&alt=sse', '');
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 300)}`);
    }

    const json = await response.json();
    const text = extractFullText(this.provider.requestFormat, json);
    if (!text) throw new Error('副模型返回空内容');
    return { text };
  }
}

function extractFullText(format, json) {
  if (format === 'openai') {
    return json?.choices?.[0]?.message?.content || '';
  }
  if (format === 'anthropic') {
    const parts = json?.content || [];
    return parts.map(p => (p.type === 'text' ? p.text : '')).join('').trim();
  }
  if (format === 'gemini') {
    const parts = json?.candidates?.[0]?.content?.parts || [];
    return parts.map(p => p.text || '').join('').trim();
  }
  if (format === 'ollama') {
    return json?.message?.content || '';
  }
  return '';
}

/**
 * 测试 API 配置是否可用
 */
export async function testApiConnection(providerKey, config) {
  const adapter = new ApiAdapter(providerKey, config);

  const messages = [
    { role: 'system', content: '你是一个帮助理解网页内容的AI助手。' },
    { role: 'user', content: '请回复：API配置测试成功' }
  ];

  const url = adapter.buildUrl();
  const headers = adapter.buildHeaders();
  const body = adapter.buildRequestBody(messages, { maxTokens: 50 });

  // 测试时不使用流式
  if (body.stream !== undefined) body.stream = false;

  const response = await fetch(url.replace('&alt=sse', ''), {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    try {
      const errorJson = JSON.parse(errorText);
      throw new Error(errorJson.error?.message || `请求失败 (${response.status})`);
    } catch (e) {
      if (e.message.includes('请求失败')) throw e;
      throw new Error(`请求失败 (${response.status}): ${errorText.slice(0, 200)}`);
    }
  }

  return true;
}

/**
 * 获取 Ollama 已安装的模型列表
 */
export async function fetchOllamaModels(apiBase = 'http://127.0.0.1:11434') {
  try {
    const response = await fetch(`${apiBase}/api/tags`);
    if (!response.ok) throw new Error('无法连接到 Ollama');

    const data = await response.json();
    return (data.models || []).map(m => m.name);
  } catch {
    throw new Error('无法获取 Ollama 模型列表，请确保 Ollama 服务已启动');
  }
}

// ====================================================================
// multimodal content 转换辅助
// ====================================================================
// 上层传入的 message.content 统一格式：
//   string                                    // 纯文本
//   | Array<{type:'text', text} | {type:'image', dataUrl}>   // 多模态
//
// 各 provider 的 wire format 不同，下面的 helper 把统一格式转成对应 wire 形式。

/**
 * 把用户填写的 OpenAI 兼容 base URL 归一化到带 /chat/completions 的完整地址。
 * 兼容这些写法：
 *   https://api.deepseek.com                    → https://api.deepseek.com/v1/chat/completions
 *   https://api.deepseek.com/                   → https://api.deepseek.com/v1/chat/completions
 *   https://api.deepseek.com/v1                 → https://api.deepseek.com/v1/chat/completions
 *   https://api.deepseek.com/v1/                → https://api.deepseek.com/v1/chat/completions
 *   https://api.deepseek.com/chat/completions   → 原样保留
 *   https://api.openai.com/v1/chat/completions  → 原样保留
 */
function normalizeOpenAIBase(raw) {
  if (!raw) return raw;
  let url = raw.trim().replace(/\/+$/, '');
  // 已经是完整 endpoint
  if (/\/chat\/completions(\?|$)/.test(url)) return url;
  // 已经带 /v1（或其它版本号），直接拼 /chat/completions
  if (/\/v\d+$/.test(url)) return url + '/chat/completions';
  // 否则按 OpenAI 兼容默认补 /v1/chat/completions
  return url + '/v1/chat/completions';
}

function isMultimodalArray(content) {
  return Array.isArray(content);
}

function contentToText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!isMultimodalArray(content)) return String(content);
  return content
    .map(part => part.type === 'text' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

function toOpenAIContent(content) {
  if (!isMultimodalArray(content)) return content || '';
  return content.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') return { type: 'image_url', image_url: { url: part.dataUrl } };
    return null;
  }).filter(Boolean);
}

function toAnthropicContent(content) {
  if (!isMultimodalArray(content)) return content || '';
  return content.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') {
      const m = /^data:(image\/[a-zA-Z]+);base64,(.+)$/.exec(part.dataUrl || '');
      if (!m) return null;
      return {
        type: 'image',
        source: { type: 'base64', media_type: m[1], data: m[2] }
      };
    }
    return null;
  }).filter(Boolean);
}

function toGeminiParts(content) {
  if (!isMultimodalArray(content)) return [{ text: content || '' }];
  return content.map(part => {
    if (part.type === 'text') return { text: part.text };
    if (part.type === 'image') {
      const m = /^data:(image\/[a-zA-Z]+);base64,(.+)$/.exec(part.dataUrl || '');
      if (!m) return null;
      return { inline_data: { mime_type: m[1], data: m[2] } };
    }
    return null;
  }).filter(Boolean);
}
