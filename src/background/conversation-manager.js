/**
 * 对话管理模块 — 基于 chrome.storage.local 持久化
 *
 * 数据模型 (chrome.storage.local key: "webchat_conversations"):
 * {
 *   "tab_<tabId>": {
 *     activeId: "uuid",
 *     conversations: {
 *       "uuid": {
 *         id, title, createdAt, updatedAt,
 *         messages: [{ content, isUser, markdownContent? }]
 *       }
 *     }
 *   }
 * }
 */

const STORAGE_KEY = 'webchat_conversations';

// —— 内存缓存，避免每次操作都读 storage ——
let cache = null;       // 完整的 storage dump
let cacheLoaded = false;

async function loadCache() {
  if (cacheLoaded) return cache;
  const result = await chrome.storage.local.get(STORAGE_KEY);
  cache = result[STORAGE_KEY] || {};
  cacheLoaded = true;
  return cache;
}

async function saveCache() {
  await chrome.storage.local.set({ [STORAGE_KEY]: cache });
}

function tabKey(tabId) {
  return `tab_${tabId}`;
}

function ensureTab(tabId) {
  const key = tabKey(tabId);
  if (!cache[key]) {
    cache[key] = { activeId: null, conversations: {} };
  }
  return cache[key];
}

function generateId() {
  // 简单的 UUID v4
  return 'conv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function makeTitle(content) {
  if (!content) return '新对话';
  const cleaned = content.replace(/\s+/g, ' ').trim();
  return cleaned.length > 30 ? cleaned.slice(0, 30) + '…' : cleaned;
}

// ==================== 对外 API ====================

/** 列出某个 tab 下的所有对话（按更新时间倒序） */
export async function listConversations(tabId) {
  await loadCache();
  const tab = ensureTab(tabId);
  const list = Object.values(tab.conversations);
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return list.map(c => ({
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: (c.messages || []).length,
    isActive: c.id === tab.activeId
  }));
}

/** 获取当前活跃对话 ID */
export async function getActiveConversationId(tabId) {
  await loadCache();
  const tab = ensureTab(tabId);
  return tab.activeId;
}

/** 获取活跃对话（含完整消息） */
export async function getActiveConversation(tabId) {
  await loadCache();
  const tab = ensureTab(tabId);
  if (!tab.activeId || !tab.conversations[tab.activeId]) return null;
  return { ...tab.conversations[tab.activeId] };
}

/** 创建新对话并设为活跃 */
export async function createConversation(tabId) {
  await loadCache();
  const tab = ensureTab(tabId);
  const id = generateId();
  const now = Date.now();
  const conversation = {
    id,
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  tab.conversations[id] = conversation;
  tab.activeId = id;
  await saveCache();
  return { id, title: conversation.title, createdAt: now, updatedAt: now, messageCount: 0 };
}

/** 删除对话；若删除的是活跃对话则自动切到最新对话 */
export async function deleteConversation(tabId, convId) {
  await loadCache();
  const tab = ensureTab(tabId);
  if (!tab.conversations[convId]) return false;
  delete tab.conversations[convId];
  if (tab.activeId === convId) {
    const remaining = Object.values(tab.conversations);
    remaining.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    tab.activeId = remaining.length > 0 ? remaining[0].id : null;
  }
  await saveCache();
  return true;
}

/** 切换活跃对话 */
export async function switchConversation(tabId, convId) {
  await loadCache();
  const tab = ensureTab(tabId);
  if (!tab.conversations[convId]) return false;
  tab.activeId = convId;
  await saveCache();
  return true;
}

/** 获取指定对话的消息 */
export async function getMessages(tabId, convId) {
  await loadCache();
  const tab = ensureTab(tabId);
  const conv = tab.conversations[convId || tab.activeId];
  if (!conv) return [];
  return [...conv.messages];
}

/** 添加用户消息到活跃对话（同时自动更新标题） */
export async function addUserMessage(tabId, content) {
  await loadCache();
  const tab = ensureTab(tabId);
  if (!tab.activeId || !tab.conversations[tab.activeId]) return;
  const conv = tab.conversations[tab.activeId];
  // 去重
  const last = conv.messages[conv.messages.length - 1];
  if (!last || !last.isUser || last.content !== content) {
    conv.messages.push({ content, isUser: true });
  }
  // 自动标题：取第一条用户消息
  if (conv.title === '新对话' || !conv.title) {
    const firstUser = conv.messages.find(m => m.isUser);
    if (firstUser) conv.title = makeTitle(firstUser.content);
  }
  conv.updatedAt = Date.now();
  await saveCache();
}

/** 添加用户消息到指定对话（不依赖活跃对话） */
export async function addUserMessageToConv(tabId, convId, content) {
  await loadCache();
  const tab = ensureTab(tabId);
  if (!convId || !tab.conversations[convId]) return;
  const conv = tab.conversations[convId];
  const last = conv.messages[conv.messages.length - 1];
  if (!last || !last.isUser || last.content !== content) {
    conv.messages.push({ content, isUser: true });
  }
  if (conv.title === '新对话' || !conv.title) {
    const firstUser = conv.messages.find(m => m.isUser);
    if (firstUser) conv.title = makeTitle(firstUser.content);
  }
  conv.updatedAt = Date.now();
  await saveCache();
}

/** 添加助手消息到指定对话（不依赖活跃对话） */
export async function addAssistantMessageToConv(tabId, convId, content) {
  if (!content) return;
  await loadCache();
  const tab = ensureTab(tabId);
  if (!convId || !tab.conversations[convId]) return;
  const conv = tab.conversations[convId];
  conv.messages.push({ isUser: false, content, markdownContent: content });
  conv.updatedAt = Date.now();
  await saveCache();
}

/** 获取指定对话的消息 */
export async function getMessagesByConv(tabId, convId) {
  await loadCache();
  const tab = ensureTab(tabId);
  if (!convId || !tab.conversations[convId]) return [];
  return [...tab.conversations[convId].messages];
}

/** 添加助手消息到活跃对话 */
export async function addAssistantMessage(tabId, content) {
  if (!content) return;
  await loadCache();
  const tab = ensureTab(tabId);
  if (!tab.activeId || !tab.conversations[tab.activeId]) return;
  const conv = tab.conversations[tab.activeId];
  conv.messages.push({ isUser: false, content, markdownContent: content });
  conv.updatedAt = Date.now();
  await saveCache();
}

/** 替换活跃对话的全部消息 */
export async function setMessages(tabId, messages) {
  await loadCache();
  const tab = ensureTab(tabId);
  if (!tab.activeId || !tab.conversations[tab.activeId]) return;
  tab.conversations[tab.activeId].messages = Array.isArray(messages) ? [...messages] : [];
  tab.conversations[tab.activeId].updatedAt = Date.now();
  await saveCache();
}

/** 清空活跃对话的消息（不删除对话本身） */
export async function clearActiveConversation(tabId) {
  await loadCache();
  const tab = ensureTab(tabId);
  if (!tab.activeId || !tab.conversations[tab.activeId]) return;
  tab.conversations[tab.activeId].messages = [];
  tab.conversations[tab.activeId].title = '新对话';
  tab.conversations[tab.activeId].updatedAt = Date.now();
  await saveCache();
}

/** 重命名对话 */
export async function renameConversation(tabId, convId, newTitle) {
  await loadCache();
  const tab = ensureTab(tabId);
  if (!tab.conversations[convId]) return false;
  tab.conversations[convId].title = newTitle || '新对话';
  tab.conversations[convId].updatedAt = Date.now();
  await saveCache();
  return true;
}

/**
 * 为保持向后兼容：chat-history.js 委托到这里。
 * 返回与旧 getHistorySnapshot 相同格式的数据。
 */
export async function getHistorySnapshot(tabId) {
  await loadCache();
  const tab = ensureTab(tabId);
  // 如果没有活跃对话，返回空
  if (!tab.activeId || !tab.conversations[tab.activeId]) {
    // 兼容：检查旧内存数据是否在 generateAnswer 中被写入了
    return [];
  }
  return [...tab.conversations[tab.activeId].messages];
}

/** 批量设置历史（兼容 saveHistory） */
export async function setHistorySnapshot(tabId, messages) {
  await loadCache();
  const tab = ensureTab(tabId);
  if (!tab.activeId || !tab.conversations[tab.activeId]) {
    // 如果还没有活跃对话，自动创建一个
    const id = generateId();
    const now = Date.now();
    tab.conversations[id] = {
      id,
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      messages: Array.isArray(messages) ? [...messages] : []
    };
    tab.activeId = id;
    // 自动标题
    const firstUser = tab.conversations[id].messages.find(m => m.isUser);
    if (firstUser) tab.conversations[id].title = makeTitle(firstUser.content);
  } else {
    tab.conversations[tab.activeId].messages = Array.isArray(messages) ? [...messages] : [];
    tab.conversations[tab.activeId].updatedAt = Date.now();
  }
  await saveCache();
}

/** 确保活跃对话存在（不存在则自动创建） */
export async function ensureActiveConversation(tabId) {
  await loadCache();
  const tab = ensureTab(tabId);
  if (!tab.activeId || !tab.conversations[tab.activeId]) {
    const id = generateId();
    const now = Date.now();
    tab.conversations[id] = {
      id,
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    tab.activeId = id;
    await saveCache();
  }
  return tab.activeId;
}

/**
 * 清除内存缓存 — 在 storage.onChanged 外部修改后同步
 * 或 Service Worker 被唤醒时重新加载
 */
export function invalidateCache() {
  cacheLoaded = false;
  cache = null;
}
