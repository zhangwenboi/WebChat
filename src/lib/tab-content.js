/**
 * 跨 tab 内容抓取与压缩 — 仅在 background 上下文使用
 *
 *  - listAvailableTabs    枚举当前可注入的 tab（过滤 chrome:// 等）
 *  - extractTabContent    向目标 tab 注入精简版 parser 抓正文
 *  - compressContent      根据用户设置截断/AI 摘要
 *
 * 注意：chrome.scripting.executeScript 的 func 必须是自包含函数，
 * 不能引用外层 import，所以下方 inlinePageParser 把 page-parser 的核心逻辑内联了一份。
 */

const UNSUPPORTED_PROTOCOLS = [
  'chrome:', 'edge:', 'about:', 'chrome-extension:', 'moz-extension:',
  'view-source:', 'devtools:', 'chrome-search:', 'chrome-untrusted:'
];

function isSupportedUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (UNSUPPORTED_PROTOCOLS.includes(u.protocol)) return false;
    // 扩展商店页面注入会被浏览器拦截
    if (/chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function listAvailableTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter(t => isSupportedUrl(t.url))
    .map(t => ({
      id: t.id,
      title: t.title || '',
      url: t.url || '',
      favIconUrl: t.favIconUrl || '',
      windowId: t.windowId,
      active: t.active
    }));
}

export async function extractTabContent(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: inlinePageParser,
      args: [{ maxChars: 30000 }] // 抓取阶段不强压缩，留给 compressContent 决定
    });
    if (!result || !result.result) {
      return { tabId, error: '注入失败：无返回值' };
    }
    return { tabId, ...result.result };
  } catch (e) {
    return { tabId, error: e.message || String(e) };
  }
}

/**
 * @param {string} text
 * @param {object} opts
 * @param {'truncate'|'ai'|'hybrid'} opts.mode
 * @param {number} opts.maxChars
 * @param {(text:string, target:number)=>Promise<string>} opts.summarizer
 * @param {number} [opts.aiThreshold] hybrid 模式下超过该长度才走 AI 摘要
 */
export async function compressContent(text, opts) {
  const { mode = 'hybrid', maxChars = 3000, summarizer, aiThreshold = 8000 } = opts || {};
  if (!text) return { content: '', truncated: false, mode: 'noop' };
  if (text.length <= maxChars) return { content: text, truncated: false, mode: 'noop' };

  if (mode === 'truncate') {
    return {
      content: text.slice(0, maxChars) + `\n[已截断，原文 ${text.length} 字]`,
      truncated: true,
      mode: 'truncate'
    };
  }

  const shouldAI = mode === 'ai' || (mode === 'hybrid' && text.length >= aiThreshold);
  if (shouldAI && typeof summarizer === 'function') {
    try {
      const summary = await summarizer(text, maxChars);
      if (summary && summary.length) {
        return {
          content: summary.slice(0, maxChars + 500),
          truncated: true,
          mode: 'ai'
        };
      }
    } catch {
      // AI 摘要失败时继续走截断
    }
  }
  return {
    content: text.slice(0, maxChars) + `\n[已截断，原文 ${text.length} 字]`,
    truncated: true,
    mode: 'truncate'
  };
}

// ============================================================
// 注入到目标 tab 执行的精简 parser（自包含、无 import）
// ============================================================
function inlinePageParser({ maxChars = 30000 } = {}) {
  const NOISE = [
    'script', 'style', 'noscript', 'template',
    'header', 'nav', 'footer', 'aside',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '.ad', '.ads', '.advert', '[class*="advertisement"]',
    '[aria-hidden="true"]'
  ];

  function extract(root) {
    const lines = [];
    const visit = (node) => {
      if (node.nodeType === 3) {
        const t = node.nodeValue.replace(/\s+/g, ' ');
        if (t.trim()) lines.push(t);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'template'].includes(tag)) return;
      if (/^h[1-6]$/.test(tag)) {
        lines.push('\n' + '#'.repeat(+tag[1]) + ' ' + node.textContent.trim() + '\n');
        return;
      }
      if (tag === 'li') {
        lines.push('- ' + node.textContent.trim());
        return;
      }
      if (['p', 'br', 'div', 'section', 'article', 'tr', 'pre', 'blockquote'].includes(tag)) {
        const before = lines.length;
        for (const c of node.childNodes) visit(c);
        if (lines.length > before) lines.push('');
        return;
      }
      for (const c of node.childNodes) visit(c);
    };
    visit(root);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  try {
    const clone = document.body?.cloneNode(true);
    if (!clone) return { title: document.title, url: location.href, content: '', error: 'no body' };
    NOISE.forEach(sel => clone.querySelectorAll(sel).forEach(el => el.remove()));
    const main = clone.querySelector('main') || clone.querySelector('article') || clone;
    let text = extract(main);
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + `\n[原始截断 ${text.length} 字]`;
    }
    return { title: document.title, url: location.href, content: text };
  } catch (e) {
    return { title: document.title, url: location.href, content: '', error: e.message };
  }
}
