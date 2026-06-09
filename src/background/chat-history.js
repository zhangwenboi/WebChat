/**
 * 对话历史兼容层 — 委托给 conversation-manager.js
 *
 * 保留旧 API 签名，内部全部桥接到 chrome.storage.local 持久化。
 * 所有函数现在返回 Promise。
 */

import {
  getHistorySnapshot as _getHistory,
  setHistorySnapshot as _setHistory,
  addUserMessage,
  addAssistantMessage,
  addUserMessageToConv,
  addAssistantMessageToConv,
  getMessagesByConv,
  ensureActiveConversation,
  clearActiveConversation,
  setMessages,
  invalidateCache
} from './conversation-manager.js';

export function createHistoryStore(initial = {}) {
  // 不再使用内存 store，返回一个占位对象以保持兼容
  return {};
}

export async function getHistorySnapshot(_store, tabId) {
  return _getHistory(tabId);
}

export async function setHistorySnapshot(_store, tabId, history = []) {
  // 确保存在活跃对话后再写入
  await ensureActiveConversation(tabId);
  await setMessages(tabId, history);
}

export async function clearHistoryForTab(_store, tabId) {
  await clearActiveConversation(tabId);
}

export async function clearAllHistories(_store) {
  // 清空所有 tab 的活跃对话；简单干掉整个存储
  await chrome.storage.local.remove('webchat_conversations');
  invalidateCache();
}

export async function recordUserMessage(_store, tabId, content) {
  await ensureActiveConversation(tabId);
  await addUserMessage(tabId, content);
}

export async function recordAssistantMessage(_store, tabId, content) {
  await ensureActiveConversation(tabId);
  await addAssistantMessage(tabId, content);
}

/** 将用户消息写入指定对话（用于生成过程中切换对话时保留归属） */
export async function recordUserMessageToConv(_store, tabId, convId, content) {
  await addUserMessageToConv(tabId, convId, content);
}

/** 将助手消息写入指定对话 */
export async function recordAssistantMessageToConv(_store, tabId, convId, content) {
  await addAssistantMessageToConv(tabId, convId, content);
}

/** 获取指定对话的历史（用于生成过程中获取上下文） */
export async function getHistoryByConv(_store, tabId, convId) {
  return getMessagesByConv(tabId, convId);
}
