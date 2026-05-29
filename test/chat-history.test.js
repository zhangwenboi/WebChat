import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHistoryStore,
  getHistorySnapshot,
  recordAssistantMessage,
  recordUserMessage
} from '../src/background/chat-history.js';

test('records assistant replies even when context is disabled', () => {
  const store = createHistoryStore();

  recordUserMessage(store, 7, '总结这张图');
  recordAssistantMessage(store, 7, '这是一张产品截图', { enableContext: false });

  assert.deepEqual(getHistorySnapshot(store, 7), [
    { content: '总结这张图', isUser: true },
    {
      content: '这是一张产品截图',
      markdownContent: '这是一张产品截图',
      isUser: false
    }
  ]);
});

test('deduplicates repeated pending user question', () => {
  const store = createHistoryStore({
    7: [{ content: '页面讲了什么', isUser: true }]
  });

  recordUserMessage(store, 7, '页面讲了什么');

  assert.deepEqual(getHistorySnapshot(store, 7), [
    { content: '页面讲了什么', isUser: true }
  ]);
});
