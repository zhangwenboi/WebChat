/**
 * @ 提示下拉菜单
 *
 *  - 输入框中输入 '@' 触发 → 异步向 background 拉取可用 tab 列表
 *  - 后续字符按 title + url 模糊匹配，最多 8 项
 *  - 上下键 / Enter 选中、Esc 关闭、Tab 同 Enter
 *  - 选中后将 textarea 中 @query 替换成 @[标题]，并登记 tabId
 *  - 特殊关键字：@all 一次性引用所有可用 tab
 *
 * 暴露 API：
 *   const m = createMentionDropdown(textarea, container)
 *   m.getReferencedTabIds()  → number[]   发送时调用
 *   m.clearReferences()                   清空已选引用
 *   m.handleKeydown(e)                    供外部 keydown handler 优先转发
 */
import { sendMessageWithRetry } from './runtime-message.js';

const MAX_ITEMS = 8;

export function createMentionDropdown(textarea, container) {
  // 已选引用：tabId -> { title, url }
  const referenced = new Map();
  // 当前下拉状态
  let visible = false;
  let activeIndex = 0;
  let items = [];
  let cachedTabs = null;
  let cacheAt = 0;
  let queryStart = -1; // textarea 中 '@' 的位置

  container.classList.add('webchat-mention-dropdown');
  container.hidden = true;

  const getTabs = async () => {
    // 1.5s 内复用一次列表，避免每次按键都打 background
    if (cachedTabs && Date.now() - cacheAt < 1500) return cachedTabs;
    try {
      const res = await sendMessageWithRetry({ action: 'listTabs' });
      cachedTabs = (res && res.tabs) || [];
      cacheAt = Date.now();
    } catch {
      cachedTabs = [];
    }
    return cachedTabs;
  };

  const close = () => {
    visible = false;
    container.hidden = true;
    container.innerHTML = '';
    queryStart = -1;
  };

  const render = () => {
    container.innerHTML = '';
    if (!items.length) {
      container.hidden = true;
      return;
    }
    items.forEach((it, idx) => {
      const row = document.createElement('div');
      row.className = 'mention-row' + (idx === activeIndex ? ' active' : '');
      row.dataset.idx = String(idx);

      const icon = document.createElement('img');
      icon.className = 'mention-favicon';
      icon.alt = '';
      icon.src = it.favIconUrl || '';
      icon.onerror = () => { icon.style.visibility = 'hidden'; };

      const text = document.createElement('div');
      text.className = 'mention-text';
      const title = document.createElement('div');
      title.className = 'mention-title';
      title.textContent = it._label || it.title || '(无标题)';
      const url = document.createElement('div');
      url.className = 'mention-url';
      url.textContent = it.url || '';
      text.append(title, url);

      row.append(icon, text);
      row.addEventListener('mousedown', (e) => {
        // mousedown 而非 click：避免 textarea 失焦后 selection 丢失
        // stopPropagation 阻止冒泡到 document，避免触发对话框的"点击外部关闭"
        e.preventDefault();
        e.stopPropagation();
        select(idx);
      });
      container.appendChild(row);
    });
    container.hidden = false;
    visible = true;
  };

  // 解析 textarea 中 caret 之前的 @query；返回 {start, query} 或 null
  const parseQueryAtCaret = () => {
    const value = textarea.value;
    const caret = textarea.selectionStart;
    if (caret == null) return null;
    let i = caret - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === '@') {
        // '@' 必须在行首或前一个字符是空白
        if (i === 0 || /\s/.test(value[i - 1])) {
          return { start: i, query: value.slice(i + 1, caret) };
        }
        return null;
      }
      if (/\s/.test(ch)) return null;
      i--;
    }
    return null;
  };

  const score = (tab, q) => {
    if (!q) return 1;
    const ql = q.toLowerCase();
    const t = (tab.title || '').toLowerCase();
    const u = (tab.url || '').toLowerCase();
    if (t === ql) return 100;
    if (t.startsWith(ql)) return 80;
    if (t.includes(ql)) return 60;
    if (u.includes(ql)) return 30;
    return 0;
  };

  const buildItems = (tabs, q) => {
    if (q.toLowerCase() === 'all') {
      return [{
        special: 'all',
        _label: `引用所有可用 tab（${tabs.length} 个）`,
        url: tabs.map(t => t.title).slice(0, 3).join(' / '),
        favIconUrl: ''
      }];
    }
    const scored = tabs
      .map(t => ({ ...t, _score: score(t, q) }))
      .filter(t => t._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, MAX_ITEMS);
    return scored;
  };

  const refresh = async () => {
    const parsed = parseQueryAtCaret();
    if (!parsed) {
      close();
      return;
    }
    queryStart = parsed.start;
    const tabs = await getTabs();
    items = buildItems(tabs, parsed.query);
    activeIndex = 0;
    if (!items.length) {
      // 仍显示一个无结果占位
      container.innerHTML = '<div class="mention-empty">无匹配 tab</div>';
      container.hidden = false;
      visible = true;
      return;
    }
    render();
  };

  const replaceMentionText = (label) => {
    if (queryStart < 0) return;
    const value = textarea.value;
    const caret = textarea.selectionStart;
    const before = value.slice(0, queryStart);
    const after = value.slice(caret);
    const insert = `@[${label}] `;
    textarea.value = before + insert + after;
    const newCaret = before.length + insert.length;
    textarea.selectionStart = textarea.selectionEnd = newCaret;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const select = (idx) => {
    const it = items[idx];
    if (!it) return;
    if (it.special === 'all') {
      // 引用全部
      (cachedTabs || []).forEach(t => referenced.set(t.id, { title: t.title, url: t.url }));
      replaceMentionText('全部 tab');
    } else {
      referenced.set(it.id, { title: it.title, url: it.url });
      replaceMentionText(it.title || '未命名');
    }
    close();
  };

  // 事件
  textarea.addEventListener('input', () => {
    refresh();
  });
  textarea.addEventListener('blur', () => {
    // 延迟关闭，等 mousedown 处理完
    setTimeout(close, 150);
  });
  textarea.addEventListener('keydown', (e) => {
    if (!visible || !items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      render();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      select(activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }, true); // capture：抢在 chat-controller 的 Enter 之前

  return {
    getReferencedTabIds() {
      return Array.from(referenced.keys());
    },
    getReferencedTabs() {
      return Array.from(referenced.entries()).map(([id, v]) => ({ id, ...v }));
    },
    clearReferences() {
      referenced.clear();
    },
    isOpen() {
      return visible;
    }
  };
}
