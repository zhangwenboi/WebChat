import { ApiAdapter } from '../lib/api-adapter.js';
import { migrateSettings, getActiveProviderConfig } from '../lib/storage.js';
import { DEFAULT_SETTINGS, PROVIDERS } from '../lib/providers.js';
import { estimateTokens } from '../lib/tokens.js';
import { friendlyError } from '../lib/errors.js';
import { buildGenerateScriptPrompts, normalizeGeneratedScript } from './ai-script-prompts.js';
import {
  clearAllHistories,
  clearHistoryForTab,
  createHistoryStore,
  getHistorySnapshot,
  recordAssistantMessage,
  recordUserMessage,
  setHistorySnapshot
} from './chat-history.js';
import { listAvailableTabs, extractTabContent, compressContent } from '../lib/tab-content.js';
import { pickFallbackProvider, describeImages, formatImageDescriptions } from '../lib/vision-fallback.js';

const REQUEST_TIMEOUT_MS = 60000;

// 存储会话历史的对象，键是标签ID
let sessionHistories = createHistoryStore();
let generatingStates = {};
let currentAnswers = {};
let activePorts = {};
let activeAborts = {};
let completedAnswers = {};

// 扩展安装时执行迁移
chrome.runtime.onInstalled.addListener(async () => {
  await migrateSettings();
  console.log('WebChat 扩展已安装/更新，设置已迁移');

  // 注册右键菜单：图片 → 添加到 WebChat 图片标记
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'webchat-mark-image',
        title: '添加到 WebChat 图片标记',
        contexts: ['image']
      });
    });
  } catch (e) {
    console.warn('注册右键菜单失败：', e?.message || e);
  }
});

// 右键菜单：把图片 srcUrl 转给 content script
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'webchat-mark-image' || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, {
    action: 'imageMark/addByUrl',
    srcUrl: info.srcUrl,
    pageUrl: info.pageUrl,
    frameUrl: info.frameUrl
  }).catch(() => {
    // content script 未注入或页面不允许注入
  });
});

// 处理来自 popup/content 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveHistory') {
    setHistorySnapshot(sessionHistories, request.tabId, request.history);
    sendResponse({ status: 'ok' });
  } else if (request.action === 'getHistory') {
    const history = getHistorySnapshot(sessionHistories, request.tabId);
    const state = generatingStates[request.tabId] || { isGenerating: false };

    if (state.isGenerating && state.pendingQuestion) {
      const lastMessage = history[history.length - 1];
      if (!lastMessage || !lastMessage.isUser || lastMessage.content !== state.pendingQuestion) {
        const updatedHistory = [...history, { content: state.pendingQuestion, isUser: true }];
        sendResponse({
          history: updatedHistory,
          isGenerating: state.isGenerating,
          pendingQuestion: state.pendingQuestion,
          currentAnswer: currentAnswers[request.tabId] || ''
        });
        return true;
      }
    }

    sendResponse({
      history,
      isGenerating: state.isGenerating,
      pendingQuestion: state.pendingQuestion,
      currentAnswer: currentAnswers[request.tabId] || ''
    });
  } else if (request.action === 'clearHistory') {
    clearHistoryForTab(sessionHistories, request.tabId);
    delete generatingStates[request.tabId];
    delete currentAnswers[request.tabId];
    delete completedAnswers[request.tabId];
    sendResponse({ status: 'ok' });
  } else if (request.action === 'getCurrentTab') {
    sendResponse({ tabId: sender.tab.id });
  } else if (request.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ status: 'ok' });
  } else if (request.action === 'downloadScript') {
    handleDownloadScript(request).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  } else if (request.action === 'captureScreenshot') {
    handleCaptureScreenshot(sender).then(sendResponse, (err) => sendResponse({ error: err.message }));
    return true;
  } else if (request.action === 'captureRegion') {
    // 区域截图：返回整页截图，由 content 自己 crop
    handleCaptureScreenshot(sender).then(sendResponse, (err) => sendResponse({ error: err.message }));
    return true;
  } else if (request.action === 'aiAssist') {
    handleAiAssist(request).then(sendResponse, (err) => sendResponse({ error: err.message }));
    return true;
  } else if (request.action === 'listTabs') {
    listAvailableTabs().then(
      (tabs) => sendResponse({ tabs }),
      (err) => sendResponse({ error: err.message })
    );
    return true;
  } else if (request.action === 'extractTabs') {
    handleExtractTabs(request).then(sendResponse, (err) => sendResponse({ error: err.message }));
    return true;
  }
  // 默认不返回 true，避免对未识别的 action 把通道挂着等不到 sendResponse，
  // 触发 "A listener indicated an asynchronous response..." 误报
  return false;
});

// ============ 脚本相关辅助函数 ============

async function handleDownloadScript({ content, filename, mime }) {
  const dataUrl = 'data:' + (mime || 'application/octet-stream') + ';charset=utf-8,' + encodeURIComponent(content);
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: dataUrl,
      filename: filename || 'webchat-script.json',
      saveAs: false
    }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve({ ok: true, id });
    });
  });
}

async function handleCaptureScreenshot(sender) {
  return new Promise((resolve, reject) => {
    const windowId = sender?.tab?.windowId;
    chrome.tabs.captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve({ dataUrl });
    });
  });
}

async function handleAiAssist(request) {
  const active = await getActiveProviderConfig();
  const { providerKey, apiKey, apiBase, model } = active;
  if (!apiBase) throw new Error('未配置 API 地址，请在扩展选项中完成配置');
  if (!model) throw new Error('未配置模型，请在扩展选项中完成配置');
  const adapter = new ApiAdapter(providerKey, { apiKey, apiBase, model });

  let systemPrompt = '';
  let userPrompt = '';
  if (request.mode === 'read') {
    systemPrompt = '你是网页内容理解助手。根据用户的需求，从给出的页面内容中提取信息或回答问题，仅输出结果文本。';
    userPrompt = `指令：${request.prompt}\n\n页面内容：\n${request.content || ''}`;
  } else if (request.mode === 'locate') {
    systemPrompt = '你是网页元素定位助手。根据描述与候选元素列表，返回最匹配元素的 selector。仅输出 JSON：{"selector":"..."}';
    userPrompt = `描述：${request.description}\n\n候选元素：\n${JSON.stringify(request.elements || [], null, 2)}`;
} else if (request.mode === 'generate') {
    ({ systemPrompt, userPrompt } = buildGenerateScriptPrompts({
      prompt: request.prompt,
      pageInfo: request.pageInfo
    }));
  } else {
    throw new Error('未知的 aiAssist 模式：' + request.mode);
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];
  const url = adapter.buildUrl();
  const headers = adapter.buildHeaders();
  const body = adapter.buildRequestBody(messages, { maxTokens: 2000 });
  if (body.stream !== undefined) body.stream = false;

  const response = await fetch(url.replace('&alt=sse', ''), {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const txt = await response.text().catch(() => '');
    throw new Error(`AI 请求失败 (${response.status}): ${txt.slice(0, 200)}`);
  }
  const json = await response.json();
  const text = extractAiText(json);

  if (request.mode === 'read') return { text };
  if (request.mode === 'locate') {
    try { return JSON.parse(extractJsonBlock(text)); } catch { return { selector: null, raw: text }; }
  }
  if (request.mode === 'generate') {
    try {
      const parsed = JSON.parse(extractJsonBlock(text));
      return { script: normalizeGeneratedScript(parsed, request.pageInfo || {}) };
    }
    catch (e) { return { error: '生成结果非 JSON：' + e.message, raw: text }; }
  }
  return { text };
}

// 处理 extractTabs 请求 — 并发抓取选中 tab 的正文、按用户压缩设置压缩
async function handleExtractTabs(request) {
  const { tabIds = [] } = request;
  const settings = await chrome.storage.sync.get({
    enableTabCompression: DEFAULT_SETTINGS.enableTabCompression,
    tabCompressMaxChars: DEFAULT_SETTINGS.tabCompressMaxChars,
    tabCompressMode: DEFAULT_SETTINGS.tabCompressMode
  });

  const summarizer = createAiSummarizer();

  const results = await Promise.all(
    tabIds.map(async (tabId) => {
      const raw = await extractTabContent(tabId);
      if (raw.error || !raw.content) return raw;
      if (!settings.enableTabCompression) {
        return { ...raw, truncated: false, compressMode: 'noop' };
      }
      const compressed = await compressContent(raw.content, {
        mode: settings.tabCompressMode,
        maxChars: settings.tabCompressMaxChars,
        summarizer
      });
      return {
        ...raw,
        content: compressed.content,
        truncated: compressed.truncated,
        compressMode: compressed.mode
      };
    })
  );

  return { tabs: results };
}

// 用当前 provider 给一段长文本做摘要 — 与 handleAiAssist 的 read 模式同款（非流式）
function createAiSummarizer() {
  return async (text, target) => {
    const active = await getActiveProviderConfig();
    const { providerKey, apiKey, apiBase, model } = active;
    if (!apiBase || !model) throw new Error('AI 摘要不可用：未完成 provider 配置');
    const adapter = new ApiAdapter(providerKey, { apiKey, apiBase, model });

    const messages = [
      { role: 'system', content: '你是网页内容压缩助手。请在保留关键事实的前提下，把页面正文压缩到指定字数以内，输出纯文本，不要添加任何解释或前后缀。' },
      { role: 'user', content: `目标字数：约 ${target} 字。\n\n内容：\n${text}` }
    ];

    const url = adapter.buildUrl();
    const headers = adapter.buildHeaders();
    const body = adapter.buildRequestBody(messages, { maxTokens: Math.min(2048, Math.ceil(target / 1.5)) });
    if (body.stream !== undefined) body.stream = false;

    const response = await fetch(url.replace('&alt=sse', ''), {
      method: 'POST', headers, body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`摘要请求失败 (${response.status})`);
    const json = await response.json();
    return extractAiText(json) || '';
  };
}

function extractAiText(json) {
  // OpenAI / Anthropic / Gemini 兼容
  if (json.choices?.[0]?.message?.content) return json.choices[0].message.content;
  if (json.choices?.[0]?.text) return json.choices[0].text;
  if (json.content?.[0]?.text) return json.content[0].text;
  if (json.candidates?.[0]?.content?.parts?.[0]?.text) return json.candidates[0].content.parts[0].text;
  if (typeof json.response === 'string') return json.response;
  return JSON.stringify(json);
}

function extractJsonBlock(text) {
  if (!text) return '';
  // 去掉 ```json 包裹
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  // 直接定位首个 { ... } 完整片段
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

// 长连接处理 — 流式生成
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'scriptGenerateStream') {
    handleScriptGenerateStream(port);
    return;
  }
  if (port.name !== 'answerStream') return;

  port.onMessage.addListener(async (request) => {
    const tabId = request.tabId;

    if (request.action === 'generateAnswer') {
      activePorts[tabId] = port;
      try {
        await handleAnswerGeneration(port, tabId, {
          pageContent: request.pageContent,
          question: request.question,
          images: request.images || [],
          referencedTabs: request.referencedTabs || []
        });
      } catch (error) {
        if (port === activePorts[tabId]) {
          try { port.postMessage({ type: 'error', error: error.message }); } catch {}
        }
      }
    } else if (request.action === 'reconnectStream') {
      if (completedAnswers[tabId]) {
        port.postMessage({ type: 'answer-chunk', content: completedAnswers[tabId] });
        port.postMessage({ type: 'answer-end' });
        delete completedAnswers[tabId];
      } else if (currentAnswers[tabId]) {
        port.postMessage({ type: 'answer-chunk', content: currentAnswers[tabId] });
        activePorts[tabId] = port;
      } else if (generatingStates[tabId]?.isGenerating) {
        activePorts[tabId] = port;
      } else {
        port.postMessage({ type: 'answer-end' });
      }
    }
  });

  port.onDisconnect.addListener(() => {
    for (const tabId in activePorts) {
      if (activePorts[tabId] === port) {
        delete activePorts[tabId];
        // 端口断开 = 用户主动停止生成，立刻 abort 正在进行的 fetch
        const ctrl = activeAborts[tabId];
        if (ctrl) {
          try { ctrl.abort(); } catch {}
          delete activeAborts[tabId];
        }
        break;
      }
    }
  });
});

// 拼接 user message 文本：主页面 + 引用 tab + 图片状态提示 + 副模型描述
function buildUserPrompt({
  pageContent, question, referencedTabs,
  imageCount, visionEnabled,
  fallbackUsed = false, fallbackProviderName = '', fallbackDescriptions = ''
}) {
  const parts = ['基于以下网页内容回答问题：', '', '【主页面】', pageContent || '(无内容)'];

  if (Array.isArray(referencedTabs) && referencedTabs.length) {
    referencedTabs.forEach((tab, i) => {
      parts.push('', `【引用页面 ${i + 1}】${tab.title || ''}`);
      if (tab.url) parts.push(`URL：${tab.url}`);
      if (tab.error) {
        parts.push(`(抓取失败：${tab.error})`);
      } else {
        parts.push(tab.content || '');
        if (tab.truncated) parts.push(`[已${tab.compressMode === 'ai' ? 'AI 压缩' : '截断'}]`);
      }
    });
  }

  if (imageCount > 0 && visionEnabled) {
    parts.push('', `（已附带 ${imageCount} 张图片，请结合图片内容分析）`);
  } else if (imageCount > 0 && fallbackUsed && fallbackDescriptions) {
    parts.push(
      '',
      `（当前模型不支持视觉，已用 ${fallbackProviderName} 视觉副模型把 ${imageCount} 张图片转写为下列文字描述，请基于这些描述回答）`,
      fallbackDescriptions
    );
  } else if (imageCount > 0) {
    parts.push('', `[包含 ${imageCount} 张图片，但当前模型不支持视觉、且未配置可用的视觉副模型，已忽略]`);
  }

  parts.push('', `问题：${question}`);
  return parts.join('\n');
}

// 核心：流式生成回答
async function handleAnswerGeneration(port, tabId, payload) {
  const { pageContent, question, images = [], referencedTabs = [] } = payload;
  const abortCtrl = new AbortController();
  activeAborts[tabId] = abortCtrl;

  try {
    // 保存用户问题到历史
    recordUserMessage(sessionHistories, tabId, question);

    currentAnswers[tabId] = '';
    completedAnswers[tabId] = null;
    generatingStates[tabId] = { isGenerating: true, pendingQuestion: question };

    // 获取设置
    const settings = await chrome.storage.sync.get({
      activeProvider: DEFAULT_SETTINGS.activeProvider,
      providers: DEFAULT_SETTINGS.providers,
      maxTokens: DEFAULT_SETTINGS.maxTokens,
      temperature: DEFAULT_SETTINGS.temperature,
      enableContext: DEFAULT_SETTINGS.enableContext,
      maxContextRounds: DEFAULT_SETTINGS.maxContextRounds,
      systemPrompt: DEFAULT_SETTINGS.systemPrompt,
      enableImageRecognition: DEFAULT_SETTINGS.enableImageRecognition,
      visionFallbackProvider: DEFAULT_SETTINGS.visionFallbackProvider
    });

    // 获取当前提供商配置
    const providerKey = settings.activeProvider;
    const providerConfig = settings.providers[providerKey] || {};
    const adapter = new ApiAdapter(providerKey, providerConfig);

    // 构建消息
    let messages = [{ role: 'system', content: settings.systemPrompt }];

    // 添加历史上下文（注意：不重复包含本轮的 user question，下面单独追加）
    if (settings.enableContext) {
      const history = getHistorySnapshot(sessionHistories, tabId);
      const maxMessages = settings.maxContextRounds * 2;
      const recentHistory = history.slice(-(maxMessages));
      // 去掉末尾刚 push 的 user question，避免下方重复添加
      const trimmed = recentHistory.length && recentHistory[recentHistory.length - 1].isUser && recentHistory[recentHistory.length - 1].content === question
        ? recentHistory.slice(0, -1)
        : recentHistory;
      trimmed.forEach(msg => {
        messages.push({
          role: msg.isUser ? 'user' : 'assistant',
          content: msg.content
        });
      });
    }

    // 拼接当前问题（含网页内容 + 引用 tab + 图片占位提示）
    // 视觉硬门：协议本身不支持（如 DeepSeek 的 visionCapable=false），即便用户勾了开关也忽略
    const protocolVisionOk = PROVIDERS[providerKey]?.visionCapable !== false;
    const visionEnabled = settings.enableImageRecognition
      && !!providerConfig.supportsVision
      && protocolVisionOk;

    // 视觉副模型 fallback：主模型不支持视觉、但用户标记了图片 → 用副模型把图转文字
    let fallbackDescriptions = '';
    let fallbackUsed = false;
    let fallbackProviderName = '';
    if (!visionEnabled && images.length > 0 && settings.enableImageRecognition !== false) {
      const fb = pickFallbackProvider(settings);
      if (fb) {
        fallbackUsed = true;
        fallbackProviderName = PROVIDERS[fb.providerKey]?.name || fb.providerKey;
        try {
          if (port) try { port.postMessage({ type: 'status', message: `正在用 ${fallbackProviderName} 识别 ${images.length} 张图片...` }); } catch {}
          const results = await describeImages(images, fb.providerKey, fb.providerConfig);
          fallbackDescriptions = formatImageDescriptions(images, results);
        } catch (e) {
          console.warn('视觉副模型调用失败：', e);
          fallbackDescriptions = `\n[视觉副模型调用失败：${e?.message || e}]`;
        }
      }
    }

    const userText = buildUserPrompt({
      pageContent,
      question,
      referencedTabs,
      imageCount: images.length,
      visionEnabled,
      fallbackUsed,
      fallbackProviderName,
      fallbackDescriptions
    });

    if (visionEnabled && images.length) {
      const parts = [{ type: 'text', text: userText }];
      for (const img of images.slice(0, 8)) {
        if (img && img.dataUrl) parts.push({ type: 'image', dataUrl: img.dataUrl });
      }
      messages.push({ role: 'user', content: parts });
    } else {
      messages.push({ role: 'user', content: userText });
    }

    // 构建请求
    const url = adapter.buildUrl();
    const headers = adapter.buildHeaders();
    const body = adapter.buildRequestBody(messages, {
      maxTokens: settings.maxTokens,
      temperature: settings.temperature
    });

    // 估算输入 tokens；图片每张按 1500 估
    const textTokens = messages.reduce((sum, m) => {
      if (typeof m.content === 'string') return sum + estimateTokens(m.content);
      if (Array.isArray(m.content)) {
        return sum + m.content.reduce((s, p) => s + (p.type === 'text' ? estimateTokens(p.text) : 0), 0);
      }
      return sum;
    }, 0);
    const imageTokens = visionEnabled ? images.length * 1500 : 0;
    const inputTokens = textTokens + imageTokens;
    if (port) {
      try { port.postMessage({ type: 'input-tokens', tokens: inputTokens }); } catch {}
    }

    // 超时处理
    const timeoutId = setTimeout(() => {
      try { abortCtrl.abort(new DOMException('timeout', 'TimeoutError')); } catch {}
    }, REQUEST_TIMEOUT_MS);

    // 发起流式请求
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortCtrl.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errorText = await response.text();
      let providerMsg = '';
      try {
        const errorJson = JSON.parse(errorText);
        providerMsg = errorJson.error?.message || errorJson.message || '';
      } catch {}
      throw friendlyError({ status: response.status, providerMessage: providerMsg, providerKey });
    }

    // 读取流式响应
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedResponse = '';
    let buffer = '';

    while (true) {
      if (!activePorts[tabId]) {
        try { await reader.cancel(); } catch {}
        break;
      }

      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (abortCtrl.signal.aborted) break;
        throw err;
      }
      const { done, value } = chunk;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        const result = adapter.parseStreamLine(line);
        if (!result) continue;

        if (result.done) continue;

        if (result.content && port) {
          accumulatedResponse += result.content;
          currentAnswers[tabId] = accumulatedResponse;
          const outputTokens = estimateTokens(result.content);
          try {
            port.postMessage({
              type: 'answer-chunk',
              content: result.content,
              markdownContent: accumulatedResponse,
              tokens: outputTokens
            });
          } catch {
            try { await reader.cancel(); } catch {}
            return;
          }
        }
      }
    }

    // 完成
    if (activePorts[tabId] === port) {
      try {
        port.postMessage({ type: 'answer-end', markdownContent: accumulatedResponse });
      } catch {}

      recordAssistantMessage(sessionHistories, tabId, accumulatedResponse);
    } else {
      completedAnswers[tabId] = accumulatedResponse;
    }

  } catch (error) {
    if (error?.name === 'AbortError' || abortCtrl.signal.aborted) {
      // 用户主动停止 / 超时取消，不当作错误对外抛
      if (error?.name === 'TimeoutError' || error?.message === 'timeout') {
        if (port) try { port.postMessage({ type: 'error', error: '请求超时，请检查网络或稍后重试' }); } catch {}
      }
    } else {
      console.error('生成回答时出错:', error);
      if (port) {
        try { port.postMessage({ type: 'error', error: error.message }); } catch {}
      }
    }
  } finally {
    generatingStates[tabId] = { isGenerating: false };
    delete currentAnswers[tabId];
    if (activeAborts[tabId] === abortCtrl) {
      delete activeAborts[tabId];
    }
  }
}

// 监听设置变更
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync') {
    if (changes.enableContext && !changes.enableContext.newValue) {
      clearAllHistories(sessionHistories);
    }
  }
});

// 标签页更新/关闭时清理
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    clearHistoryForTab(sessionHistories, tabId);
    delete generatingStates[tabId];
    delete currentAnswers[tabId];
    delete activePorts[tabId];
    delete completedAnswers[tabId];
    const ctrl = activeAborts[tabId];
    if (ctrl) {
      try { ctrl.abort(); } catch {}
      delete activeAborts[tabId];
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearHistoryForTab(sessionHistories, tabId);
  delete generatingStates[tabId];
  delete currentAnswers[tabId];
  delete activePorts[tabId];
  delete completedAnswers[tabId];
  const ctrl = activeAborts[tabId];
  if (ctrl) {
    try { ctrl.abort(); } catch {}
    delete activeAborts[tabId];
  }
});

// ========================================================================
// 流式 AI 脚本生成
// ========================================================================
// 区别于 handleAiAssist 的非流式实现：把 stream:true 打开，每收到一个 chunk
// 就推送给 panel 端，让 UI 能显示"正在生成中"的实时文本，最后再做 JSON 解析
// 与 normalizeGeneratedScript 处理。
async function handleScriptGenerateStream(port) {
  const abortCtrl = new AbortController();
  let aborted = false;
  // 每 20s 推一条 ping，目的有两个：
  //  1) MV3 service worker 在 30s 内没有 port 活动会被回收，端口断开后我们的
  //     fetch 会被 abort，进而被 panel 看到一条似是而非的 "channel closed" 错误。
  //     持续在 port 上发消息能让 worker 保活。
  //  2) 网络中断时 panel 也能更早察觉。
  const keepalive = setInterval(() => {
    try { port.postMessage({ type: 'ping' }); } catch { /* port closed */ }
  }, 20000);
  port.onDisconnect.addListener(() => {
    aborted = true;
    clearInterval(keepalive);
    try { abortCtrl.abort(); } catch {}
  });

  port.onMessage.addListener(async (request) => {
    if (request.action !== 'generateScript') return;
    try {
      await runScriptGenerateStream(port, request, abortCtrl, () => aborted);
    } catch (err) {
      if (!aborted) {
        const msg = (err && err.name === 'AbortError') ? '请求被取消（可能因超时或服务被回收）' : (err.message || String(err));
        try { port.postMessage({ type: 'error', error: msg }); } catch {}
      }
    } finally {
      clearInterval(keepalive);
    }
  });
}

async function runScriptGenerateStream(port, request, abortCtrl, isAborted) {
  const active = await getActiveProviderConfig();
  const { providerKey, apiKey, apiBase, model } = active;
  if (!apiBase) throw new Error('未配置 API 地址，请在扩展选项中完成配置');
  if (!model) throw new Error('未配置模型，请在扩展选项中完成配置');
  const adapter = new ApiAdapter(providerKey, { apiKey, apiBase, model });

  const { systemPrompt, userPrompt } = buildGenerateScriptPrompts({
    prompt: request.prompt,
    pageInfo: request.pageInfo
  });

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];
  const url = adapter.buildUrl();
  const headers = adapter.buildHeaders();
  const body = adapter.buildRequestBody(messages, { maxTokens: 2000 });
  // 显式确保 stream 开启（adapter 默认就是 true，这里防御性写一下）
  body.stream = true;

  // 首字节超时：等服务端开始返回的最长时间。模型排队/慢启动时给充足时间。
  const FIRST_BYTE_TIMEOUT_MS = 90000;
  // 空闲超时：两次 chunk 之间最长间隔。流一开就缩短到这个值，长生成也不会被误杀。
  const IDLE_TIMEOUT_MS = 45000;

  let stallTimer = setTimeout(() => {
    try { abortCtrl.abort(new DOMException('first-byte-timeout', 'TimeoutError')); } catch {}
  }, FIRST_BYTE_TIMEOUT_MS);
  let lastTimeoutKind = 'first-byte';
  const armIdle = () => {
    clearTimeout(stallTimer);
    lastTimeoutKind = 'idle';
    stallTimer = setTimeout(() => {
      try { abortCtrl.abort(new DOMException('idle-timeout', 'TimeoutError')); } catch {}
    }, IDLE_TIMEOUT_MS);
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortCtrl.signal
    });
  } catch (err) {
    clearTimeout(stallTimer);
    if (err?.name === 'AbortError' && abortCtrl.signal.aborted) {
      throw new Error(`AI 请求${lastTimeoutKind === 'first-byte' ? '首字节超时' : '中断'}（${FIRST_BYTE_TIMEOUT_MS / 1000}s 内未响应）`);
    }
    throw err;
  }

  if (!response.ok) {
    clearTimeout(stallTimer);
    const txt = await response.text().catch(() => '');
    throw new Error(`AI 请求失败 (${response.status}): ${txt.slice(0, 200)}`);
  }

  try { port.postMessage({ type: 'stream-start' }); } catch {}

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  let buffer = '';

  try {
    while (true) {
      if (isAborted()) {
        try { await reader.cancel(); } catch {}
        return;
      }
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (abortCtrl.signal.aborted) {
          throw new Error(`AI 流式响应${lastTimeoutKind === 'idle' ? `空闲超时（${IDLE_TIMEOUT_MS / 1000}s 无新增内容）` : '被中断'}`);
        }
        throw err;
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      let gotChunk = false;
      for (const line of lines) {
        if (!line.trim()) continue;
        const result = adapter.parseStreamLine(line);
        if (!result || result.done) continue;
        if (result.content) {
          accumulated += result.content;
          gotChunk = true;
          try {
            port.postMessage({ type: 'chunk', content: result.content, accumulated });
          } catch {
            try { await reader.cancel(); } catch {}
            return;
          }
        }
      }
      // 只要拿到了内容就重置空闲计时器
      if (gotChunk) armIdle();
    }
  } finally {
    clearTimeout(stallTimer);
  }

  // 解析最终 JSON
  try {
    const parsed = JSON.parse(extractJsonBlock(accumulated));
    const script = normalizeGeneratedScript(parsed, request.pageInfo || {});
    try { port.postMessage({ type: 'done', script, raw: accumulated }); } catch {}
  } catch (e) {
    try { port.postMessage({ type: 'error', error: '生成结果非 JSON：' + e.message, raw: accumulated }); } catch {}
  }
}
