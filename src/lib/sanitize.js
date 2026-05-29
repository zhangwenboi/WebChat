/**
 * 轻量级 HTML 净化器，专为 marked 渲染后的输出设计
 * 仅允许常见 markdown 输出标签和有限属性，移除 script/iframe/事件回调/javascript: URL
 * 不依赖外部库，避免给扩展打包带来负担
 */

const ALLOWED_TAGS = new Set([
  'a', 'p', 'br', 'hr',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark', 'small',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'img', 'span', 'div'
]);

const ALLOWED_ATTRS = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  '*': ['class']
};

const URL_ATTRS = new Set(['href', 'src']);

function isSafeUrl(value) {
  if (!value) return false;
  const trimmed = String(value).trim();
  // 拒绝 javascript: / data:text/html / vbscript:
  if (/^(javascript|vbscript):/i.test(trimmed)) return false;
  if (/^data:text\/html/i.test(trimmed)) return false;
  return true;
}

function cleanAttributes(el) {
  const tag = el.tagName.toLowerCase();
  const allowed = new Set([...(ALLOWED_ATTRS[tag] || []), ...(ALLOWED_ATTRS['*'] || [])]);

  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();

    // 移除事件处理属性
    if (name.startsWith('on')) {
      el.removeAttribute(attr.name);
      continue;
    }

    // 不在白名单内的属性删除
    if (!allowed.has(name)) {
      el.removeAttribute(attr.name);
      continue;
    }

    // URL 类属性做协议检查
    if (URL_ATTRS.has(name) && !isSafeUrl(attr.value)) {
      el.removeAttribute(attr.name);
    }
  }

  // 链接默认在新窗口打开 + 安全 rel
  if (tag === 'a') {
    if (el.hasAttribute('href')) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }
}

/**
 * 净化 HTML 字符串，返回安全的 HTML
 */
export function sanitizeHTML(dirty) {
  if (typeof dirty !== 'string' || !dirty) return '';

  const template = document.createElement('template');
  template.innerHTML = dirty;

  const walk = (node) => {
    const children = [...node.childNodes];
    for (const child of children) {
      if (child.nodeType === 1 /* element */) {
        const tag = child.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) {
          // 不允许的标签：保留其文本子节点
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
          continue;
        }
        cleanAttributes(child);
        walk(child);
      } else if (child.nodeType === 8 /* comment */) {
        node.removeChild(child);
      }
    }
  };

  walk(template.content);
  return template.innerHTML;
}

/**
 * 把净化后的 HTML 安全地写入元素
 */
export function setSafeHTML(el, dirty) {
  el.innerHTML = sanitizeHTML(dirty);
}
