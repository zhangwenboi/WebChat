export function createHistoryStore(initial = {}) {
  return { ...initial };
}

export function getHistorySnapshot(store, tabId) {
  return [...(store[tabId] || [])];
}

export function setHistorySnapshot(store, tabId, history = []) {
  store[tabId] = Array.isArray(history) ? [...history] : [];
}

export function clearHistoryForTab(store, tabId) {
  delete store[tabId];
}

export function clearAllHistories(store) {
  for (const tabId of Object.keys(store)) {
    delete store[tabId];
  }
}

export function recordUserMessage(store, tabId, content) {
  const history = store[tabId] || [];
  const lastMessage = history[history.length - 1];
  if (!lastMessage || !lastMessage.isUser || lastMessage.content !== content) {
    history.push({ content, isUser: true });
    store[tabId] = history;
  }
  return history;
}

export function recordAssistantMessage(store, tabId, content) {
  if (!content) return store[tabId] || [];
  const history = store[tabId] || [];
  history.push({ isUser: false, content, markdownContent: content });
  store[tabId] = history;
  return history;
}
