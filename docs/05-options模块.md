# options/ — 设置页面模块

## 职责

提供扩展的配置界面，包括常规设置和 API 配置，所有设置通过 `chrome.storage.sync` 持久化。

## 文件组成

- `options.html` — 设置页面结构
- `options.js` — 设置逻辑
- `options.css` — 设置页面样式

## 设置项

### 常规设置（立即生效）

| 设置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `autoHideDialog` | boolean | true | 点击对话框外部时自动隐藏 |
| `enableContext` | boolean | true | 启用上下文聊天 |
| `maxContextRounds` | number | 3 | 保留最近对话轮数（1-10） |
| `systemPrompt` | string | 默认提示词 | AI 助手的系统提示词 |

### API 配置（需保存并测试）

| 设置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `apiType` | string | 'custom' | API 类型 |
| `${apiType}_apiKey` | string | '' | API 密钥 |
| `${apiType}_apiBase` | string | 见下方 | 请求 URL |
| `${apiType}_model` | string | 见下方 | 模型名称 |
| `maxTokens` | number | 2048 | 最大回复长度（128-4096） |
| `temperature` | number | 0.7 | 温度/创造性（0-1） |

## 支持的 API 类型

| 类型 | 默认地址 | 需要密钥 | 默认模型 |
|------|----------|----------|----------|
| `custom` | `https://api.openai.com/v1/chat/completions` | 是 | gpt-3.5-turbo |
| `ollama` | `http://127.0.0.1:11434/api/chat` | 否 | qwen2.5 |

## API_CONFIGS 结构

```javascript
const API_CONFIGS = {
    custom: {
        apiBase: 'https://api.openai.com/v1/chat/completions',
        modelPlaceholder: 'gpt-3.5-turbo',
        requiresKey: true,
        apiBasePlaceholder: '...',
        apiKeyPlaceholder: '请输入API密钥',
        modelHelp: '例如：gpt-3.5-turbo、gpt-4等'
    },
    ollama: {
        apiBase: 'http://127.0.0.1:11434/api/chat',
        modelPlaceholder: 'qwen2.5',
        requiresKey: false,
        apiBasePlaceholder: '...',
        apiKeyPlaceholder: '本地模型无需API密钥',
        modelHelp: '常用模型：qwen2.5, llama2, mistral...'
    }
};
```

## 核心函数

| 函数 | 功能 |
|------|------|
| `testApiConfig(settings)` | 发送测试请求验证 API 配置 |
| `updateApiTypeUI(apiType)` | 切换 API 类型时更新表单 |
| `showStatus(message, type)` | 显示操作状态提示 |
| `validateSettings(settings)` | 验证必填项 |
| `validateNumberInput(input, min, max, isFloat)` | 验证数值范围 |
| `updateTemperatureDisplay(value)` | 同步温度滑块和输入框 |
| `updateMaxTokensDisplay(value)` | 同步长度滑块和输入框 |
| `saveOptions()` | 验证 → 测试 → 保存设置 |
| `loadOptions()` | 从 storage 加载设置到 UI |
| `resetOptions()` | 还原所有设置为默认值 |

## 保存流程

```
用户点击"保存并测试"
    ↓
validateSettings() — 验证必填项
    ↓
showStatus('正在测试API配置...')
    ↓
testApiConfig() — 发送测试请求
    ↓ 成功
chrome.storage.sync.set(settings)
    ↓
showStatus('✅ API配置测试成功，设置已保存')
```

## 交互细节

- API 密钥输入框支持显示/隐藏切换（眼睛图标）
- 滑块和数字输入框双向同步
- 常规设置使用防抖保存（1秒延迟）
- 系统提示词使用防抖保存（1秒延迟）
- 还原默认设置需 `confirm()` 二次确认
- 温度输入支持小数，失去焦点时格式化

## chrome.storage.sync 完整 Schema

```javascript
{
    // API 配置
    apiType: 'custom' | 'ollama',
    maxTokens: 2048,
    temperature: 0.7,
    custom_apiKey: '',
    custom_apiBase: 'https://api.openai.com/v1/chat/completions',
    custom_model: 'gpt-3.5-turbo',
    ollama_apiKey: '',
    ollama_apiBase: 'http://127.0.0.1:11434/api/chat',
    ollama_model: 'qwen2.5',
    activeConfig: { apiKey, apiBase, model },

    // 常规设置
    autoHideDialog: true,
    enableContext: true,
    maxContextRounds: 3,
    systemPrompt: '你是一个帮助理解网页内容的AI助手。请使用Markdown格式回复。',

    // UI 状态
    showFloatingBall: true,
    dialogPosition: { left, top, isCustomPosition },
    dialogSize: { width: 400, height: 500 },
    ballPosition: { left, right, top, bottom, edge },
    totalTokens: 0
}
```
