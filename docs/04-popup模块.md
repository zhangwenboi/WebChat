# popup/ — 弹出窗口模块

## 职责

提供扩展图标点击后的弹出窗口界面，功能与 content.js 中的对话框类似，但运行在扩展 popup 环境中。

## 文件组成

- `popup.html` — 界面结构
- `popup.js` — 交互逻辑
- `../styles/popup.css` — 样式

## popup.html 结构

```html
<div class="container">
  <div class="header">
    <div class="toggle-ball">
      <!-- 悬浮球显示/隐藏开关 -->
      <input type="checkbox" id="toggleBall" checked>
      <span>显示悬浮球</span>
    </div>
  </div>
  <div id="chat-container" class="chat-container">
    <div id="messages" class="messages"></div>
  </div>
  <div class="input-container">
    <textarea id="userInput"></textarea>
    <button id="askButton" class="send-button"></button>
  </div>
</div>
```

## popup.js 核心功能

### 初始化流程

1. 初始化 marked.js（Markdown 渲染器）
2. 获取当前活动标签页 ID
3. 加载悬浮球开关状态
4. 加载历史会话记录

### 核心函数

| 函数 | 功能 |
|------|------|
| `initMarked()` | 初始化 Markdown 解析器，支持动态加载 |
| `loadHistory()` | 加载并渲染历史对话，支持重连生成流 |
| `saveHistory()` | 保存对话历史到 background |
| `ensureContentScriptLoaded()` | 确保 content script 已注入 |
| `getPageContent()` | 带重试逻辑获取页面内容（最多3次） |
| `addMessage()` | 添加消息到聊天界面 |
| `addTypingIndicator()` | 添加打字动画指示器 |
| `streamText()` | 逐字流式输出文本（备用方案） |
| `handleUserInput()` | 处理用户输入，建立流式连接 |

### 与 content.js 对话框的区别

| 特性 | popup.js | content.js 对话框 |
|------|----------|-------------------|
| 运行环境 | 扩展 popup 页面 | 网页内注入 |
| 生命周期 | 关闭 popup 即销毁 | 随页面存在 |
| 停止生成 | 不支持 | 支持（按钮切换） |
| 右键复制 | 不支持 | 支持（自定义菜单） |
| 悬浮球控制 | 有开关 | 无 |
| 重连机制 | 支持（reconnectStream） | 支持 |
| Token 计数 | 无 | 有 |

### 流式通信

与 background.js 的通信方式与 content.js 完全一致：

```javascript
const port = chrome.runtime.connect({ name: "answerStream" });

port.postMessage({
    action: 'generateAnswer',
    tabId: tabId,
    pageContent: pageContent,
    question: question
});

port.onMessage.addListener((msg) => {
    // answer-chunk / answer-end / error
});
```

### 重连机制

当 popup 重新打开时，如果有正在进行的生成：
1. `loadHistory()` 检测到 `response.isGenerating === true`
2. 建立新的 port 连接
3. 发送 `reconnectStream` 消息
4. background.js 将当前进度推送给新端口
