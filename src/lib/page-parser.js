/**
 * 网页内容抽取
 *  - 优先抽取 <main> / <article>，回退到 body
 *  - 移除 script/style/header/nav/footer/aside/广告等噪声
 *  - 保留标题/列表/段落的基本结构（以换行分隔）
 *  - 按字符数截断，避免 prompt 超限
 *  - 用户有选区时优先使用选区内容
 */

const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'link[rel="stylesheet"]',
  'header', 'nav', 'footer', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '.ad', '.ads', '.advert', '[class*="advertisement"]',
  '[aria-hidden="true"]'
];

const MAX_CONTENT_CHARS = 12000;

function extractStructuredText(root) {
  if (!root) return '';

  const lines = [];

  const blockSep = (text) => {
    const t = text.trim();
    if (t) lines.push(t);
  };

  const visit = (node) => {
    if (node.nodeType === 3) {
      // text node
      const text = node.nodeValue.replace(/\s+/g, ' ');
      if (text.trim()) lines.push(text);
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'template'].includes(tag)) return;

    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1], 10);
      blockSep('\n' + '#'.repeat(level) + ' ' + node.textContent.trim() + '\n');
      return;
    }

    if (tag === 'li') {
      blockSep('- ' + node.textContent.trim());
      return;
    }

    if (['p', 'br', 'div', 'section', 'article', 'tr', 'pre', 'blockquote'].includes(tag)) {
      const before = lines.length;
      for (const child of node.childNodes) visit(child);
      // 段落分隔符
      if (lines.length > before) lines.push('');
      return;
    }

    for (const child of node.childNodes) visit(child);
  };

  visit(root);

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 抽取页面主要内容
 * @param {object} opts
 * @param {boolean} opts.preferSelection 是否优先用选区
 * @param {number} opts.maxChars 最大字符数（默认 12000）
 */
export function parseWebContent(opts = {}) {
  const { preferSelection = true, maxChars = MAX_CONTENT_CHARS } = opts;

  // 1. 选区优先
  if (preferSelection) {
    const sel = window.getSelection?.();
    if (sel && sel.toString().trim().length > 30) {
      const selText = sel.toString().replace(/\s+/g, ' ').trim();
      return truncate(selText, maxChars);
    }
  }

  // 2. 克隆并清理噪声
  const clone = document.body?.cloneNode(true);
  if (!clone) return '';

  NOISE_SELECTORS.forEach(sel => {
    clone.querySelectorAll(sel).forEach(el => el.remove());
  });

  // 3. 优先 main/article
  const main = clone.querySelector('main') || clone.querySelector('article') || clone;

  const text = extractStructuredText(main);
  return truncate(text, maxChars);
}

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + `\n\n[内容已截断，原文共 ${text.length} 字]`;
}

/**
 * 抽取页面图片并转 base64，供多模态模型识别
 * - 跨域图（无 CORS 头）转 base64 时会抛 SecurityError，跳过
 * - 体积过小、role=presentation、纯装饰图忽略
 * - 按可见面积倒序取前 maxCount 张
 *
 * @param {object} opts
 * @param {number} opts.maxCount    最多返回几张
 * @param {number} opts.minSize     宽高最小阈值
 * @param {number} opts.maxEdge     长边压缩到该像素以内（节省 token）
 * @param {number} opts.quality     JPEG 质量 0-1
 * @returns {Promise<Array<{dataUrl:string, alt:string, width:number, height:number}>>}
 */
export async function extractPageImages(opts = {}) {
  const {
    maxCount = 4,
    minSize = 150,
    maxEdge = 1024,
    quality = 0.7
  } = opts;

  if (typeof document === 'undefined') return [];

  const candidates = [];
  const imgs = document.querySelectorAll('img');
  for (const img of imgs) {
    if (!img.src) continue;
    if (img.getAttribute('role') === 'presentation') continue;
    if (img.getAttribute('aria-hidden') === 'true') continue;

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h || w < minSize || h < minSize) continue;

    candidates.push({ el: img, area: w * h, w, h });
  }

  candidates.sort((a, b) => b.area - a.area);
  const top = candidates.slice(0, maxCount * 2); // 多取一倍，绕过 CORS 失败

  const results = [];
  for (const c of top) {
    if (results.length >= maxCount) break;
    try {
      const dataUrl = await imgElementToDataURL(c.el, maxEdge, quality);
      if (!dataUrl) continue;
      results.push({
        dataUrl,
        alt: (c.el.alt || '').slice(0, 200),
        width: c.w,
        height: c.h
      });
    } catch {
      // CORS 或其它错误，跳过
    }
  }
  return results;
}

export function imgElementToDataURL(img, maxEdge, quality) {
  return new Promise((resolve) => {
    const draw = (source) => {
      try {
        const w = source.naturalWidth || source.width;
        const h = source.naturalHeight || source.height;
        const scale = Math.min(1, maxEdge / Math.max(w, h));
        const tw = Math.max(1, Math.round(w * scale));
        const th = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(source, 0, 0, tw, th);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch {
        resolve(null);
      }
    };

    if (img.complete && img.naturalWidth > 0) {
      draw(img);
      return;
    }
    // 未加载完成则克隆一份开 crossOrigin 重试
    const clone = new Image();
    clone.crossOrigin = 'anonymous';
    clone.onload = () => draw(clone);
    clone.onerror = () => resolve(null);
    clone.src = img.src;
  });
}
