# content.js — 内容脚本

## 职责

注入到每个网页中，负责页面内容提取、悬浮球 UI、对话框 UI 及交互逻辑。

## 模块划分

### 1. 网页内容解析 — parseWebContent()

**技术方案：DOM 克隆 + 文本提取**

```javascript
function parseWebContent() {
    const docClone = document.cloneNode(true);
    // 移除无关元素
    // 提取 body.innerText
    // 清理空白字符
}
```

处理步骤：
1. `document.cloneNode(true)` 克隆整个文档（不影响原始页面渲染）
2. 移除 `<script>`、`<style>`、`<link[rel=stylesheet]>`、`<header>`、`<nav>`、`<footer>`
3. 获取 `<body>` 的 `innerText`（自动过滤隐藏元素）
4. `replace(/\s+/g, ' ').trim()` 清理多余空白

**优点：** 轻量、无依赖、不影响原始页面
**局限：** 无法提取图片内容、动态加载内容可能遗漏

---

### 2. 悬浮球 — createFloatingBall()

**功能：**
- 50x50px 圆形按钮，SVG 图标
- 可拖拽，支持边缘吸附（左/右/上/下）
- 点击打开/关闭对话框
- 附带设置按钮（hover 时显示）
- 位置通过 `chrome.storage.sync` 持久化
- 窗口 resize 时自动调整位置

**边缘吸附逻辑：**
- 拖拽到屏幕边缘时自动吸附
- 添加对应 CSS 类：`edge-left`、`edge-right`、`edge-top`、`edge-bottom`
- 吸附阈值为悬浮球宽度的一半

**对话框弹出位置计算：**
- 优先放在悬浮球左侧
- 左侧放不下则尝试右侧
- 都放不下则根据悬浮球位置选择屏幕左半或右半
- 最终边界检查确保不超出视口

---

### 3. 对话框 — createDialog()

**功能：**
- 可拖拽（通过 header 区域）
- 可调整大小（右下角 resize-handle）
- 点击外部自动隐藏（可配置）
- 尺寸和位置持久化
- 使用 `requestAnimationFrame` 优化性能

**DOM 结构：**
```html
<div id="ai-assistant-dialog">
  <div class="container">
    <div class="header">
      <div class="tokens-counter">Tokens: 0</div>
    </div>
    <div id="chat-container" class="chat-container">
      <div id="messages" class="messages"></div>
    </div>
    <div class="input-container">
      <textarea id="userInput"></textarea>
      <button id="askButton" class="send-button"></button>
    </div>
  </div>
  <div class="resize-handle"></div>
</div>
```

---

### 4. 对话交互 — initializeDialog()

**核心功能：**
- 通过 `chrome.runtime.connect` 建立长连接实现流式接收
- Markdown 实时渲染（marked.js）
- 自动滚动（用户手动滚动时暂停）
- "回到当前消息"按钮
- 右键菜单复制消息（复制原始 Markdown）
- 支持停止生成（断开端口连接）
- Token 计数显示
- 历史会话加载

**自动滚动策略：**
- 默认自动滚动到最新消息
- 用户手动向上滚动时暂停自动滚动
- 生成完成后强制滚动到底部
- MutationObserver 监听消息容器变化触发滚动

**停止生成：**
- 生成中点击发送按钮变为停止按钮
- 断开 port 连接即可停止
- 移除未完成的消息，显示"已停止回复"

---

### 5. 辅助功能

| 函数 | 功能 |
|------|------|
| `initMarked()` | 初始化 Markdown 解析器，带超时和降级 |
| `sendMessageWithRetry()` | 带重试的消息发送（指数退避，最多3次） |
| `showNotification()` | 页面内通知提示（3秒自动消失） |
| `checkAndSetBallVisibility()` | 检查并恢复悬浮球状态 |
| `createScrollToBottomButton()` | 创建"回到当前消息"按钮 |

---

### 6. 错误处理

- 扩展上下文失效（Extension context invalidated）时显示友好提示
- 全局 `error` 和 `unhandledrejection` 事件监听，阻止错误传播
- 消息发送失败时指数退避重试

## 消息监听

| action | 功能 |
|--------|------|
| `ping` | 健康检查 |
| `getPageContent` | 返回解析后的网页文本 |
| `toggleFloatingBall` | 切换悬浮球显示状态 |
