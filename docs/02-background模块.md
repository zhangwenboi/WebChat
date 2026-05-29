# background.js — 后台 Service Worker

## 职责

作为扩展的中枢，管理会话状态、处理 AI API 请求、协调各组件通信。

## 核心数据结构

所有数据按 `tabId` 隔离：

| 变量 | 类型 | 说明 |
|------|------|------|
| `sessionHistories` | Object | 每个标签页的对话历史 |
| `generatingStates` | Object | 生成状态追踪 |
| `currentAnswers` | Object | 当前正在生成的回答 |
| `activePorts` | Object | 活跃的长连接端口 |
| `completedAnswers` | Object | 已完成的回答缓存 |

## 消息处理（chrome.runtime.onMessage）

| action | 功能 | 返回值 |
|--------|------|--------|
| `saveHistory` | 保存会话历史 | `{ status: 'ok' }` |
| `getHistory` | 获取会话历史和生成状态 | `{ history, isGenerating, pendingQuestion, currentAnswer }` |
| `clearHistory` | 清除会话历史 | `{ status: 'ok' }` |
| `generateAnswer` | 触发 AI 回答生成 | `{ status: 'started' }` |
| `getGeneratingState` | 查询当前生成状态 | `{ isGenerating, pendingQuestion }` |
| `openOptions` | 打开设置页面 | `{ status: 'ok' }` |
| `getCurrentTab` | 返回发送者的 tabId | `{ tabId }` |

## 长连接处理（Port: answerStream）

通过 `chrome.runtime.onConnect` 监听端口名为 `answerStream` 的连接：

### 接收的消息

| action | 功能 |
|--------|------|
| `generateAnswer` | 开始流式生成回答 |
| `reconnectStream` | 重连到正在进行的生成流 |

### 发送的消息类型

| type | 说明 | 附带数据 |
|------|------|----------|
| `input-tokens` | 输入 Token 数量 | `{ tokens }` |
| `answer-chunk` | 回答片段 | `{ content, markdownContent, tokens }` |
| `answer-end` | 生成完成 | `{ markdownContent }` |
| `error` | 错误信息 | `{ error }` |

## 核心函数：handleAnswerGeneration

```
参数: (port, tabId, pageContent, question)
```

流程：
1. 保存用户问题到历史记录
2. 从 `chrome.storage.sync` 读取最新配置
3. 根据 API 类型获取对应的 apiKey、apiBase、model
4. 构建消息数组：system prompt + 历史上下文 + 当前问题（含网页内容）
5. 根据 API 类型构建不同格式的请求体
6. 使用 `fetch` + `ReadableStream` 进行流式请求
7. 逐块解析 SSE 响应，通过 `port.postMessage` 实时推送
8. 完成后保存对话历史

### 请求体格式差异

**OpenAI 兼容格式（custom）：**
```json
{
  "model": "gpt-3.5-turbo",
  "messages": [...],
  "max_tokens": 2048,
  "temperature": 0.7,
  "stream": true
}
```

**Ollama 格式：**
```json
{
  "model": "qwen2.5",
  "messages": [...],
  "stream": true,
  "options": {
    "temperature": 0.7,
    "num_predict": 2048
  }
}
```

## 生命周期管理

- `tabs.onUpdated`（页面刷新）→ 清理对应 tabId 的所有状态
- `tabs.onRemoved`（标签关闭）→ 清理对应 tabId 的所有状态
- `storage.onChanged` → 监听设置变更（禁用上下文时清空历史）
