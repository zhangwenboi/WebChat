# Rewrite Module — 使用文档

## 文件结构

```
rewrite/
  types.ts     — 类型定义（零外部依赖）
  prompts.ts   — 提示词库（仅依赖 ./types）
  index.ts     — RewriteEngine + re-export（依赖 openai、@anthropic-ai/sdk）
  README.md    — 本文档
```

## 复制到其他项目

### 方案 A：只要提示词（不需要 AI 调用能力）

复制 `types.ts` + `prompts.ts` 两个文件，**零 npm 依赖**。

```ts
import { POST_SYSTEM_PROMPT, XHS_CONTENT_SCHEMA, POST_COMMANDS } from './rewrite/prompts';
```

### 方案 B：完整模块（提示词 + 引擎）

三个文件全复制，在目标项目的 `package.json` 中加入：

```json
{
  "dependencies": {
    "openai": "^5.12.1",
    "@anthropic-ai/sdk": "^0.58.0"
  }
}
```

复制后保持目录结构不变：

```
<目标项目>/src/rewrite/
  types.ts
  prompts.ts
  index.ts
```

## 从哪个入口 import

所有内容都可以从 `./rewrite`（即 `index.ts`）统一导入：

```ts
import {
  // ── 提示词 & Schema ──
  XHS_CONTENT_SCHEMA,
  XHS_COMMENT_SCHEMA,
  POST_SYSTEM_PROMPT,
  COMMENT_SYSTEM_PROMPT,
  POST_INSTRUCTIONS_QWEN,
  COMMENT_INSTRUCTIONS_QWEN,

  // ── 快捷指令 ──
  POST_COMMANDS,
  COMMENT_COMMANDS,
  type QuickCommand,

  // ── 特殊指令 ──
  REGENERATE_PROMPT,

  // ── 场景预设 ──
  POST_PRESET,
  COMMENT_PRESET,
  type RewritePreset,

  // ── 辅助函数 ──
  getSystemPrompt,
  getOutputSchema,
  getCommands,

  // ── 类型 ──
  type AIProvider,
  type RewriteConfig,
  type RewriteRequest,
  type RewriteResponse,
  type JsonSchema,
  type JsonSchemaProperty,

  // ── 引擎（方案 B 才需要）──
  RewriteEngine,
  createRewriteEngine,
  rewriteWithPreset,
  type RewriteWithPresetInput,
} from './rewrite';
// 路径按实际调整，如 './rewrite'、'../rewrite'、'@/rewrite' 等
```

## 各导出的用途

### 1. 输出 Schema — 定义 AI 返回的 JSON 结构

| 导出 | 说明 |
|---|---|
| `XHS_CONTENT_SCHEMA` | `{ title: string, content: string }`，标题 ≤20 字符，内容 ≤1000 字符 |
| `XHS_COMMENT_SCHEMA` | `{ content: string }`，≤100 字符 |

### 2. 系统提示词 — 定义 AI 的角色和行为

| 导出 | 适用 Provider | 说明 |
|---|---|---|
| `POST_SYSTEM_PROMPT` | OpenAI / Claude | 笔记创作 System Prompt |
| `COMMENT_SYSTEM_PROMPT` | OpenAI / Claude | 评论创作 System Prompt |
| `POST_INSTRUCTIONS_QWEN` | Qwen（通义千问） | 笔记创作指令（更详细，含 JSON 格式描述） |
| `COMMENT_INSTRUCTIONS_QWEN` | Qwen（通义千问） | 评论创作指令 |

### 3. 快捷指令 — UI 中展示的优化命令

| 导出 | 条数 | 示例 id |
|---|---|---|
| `POST_COMMANDS` | 6 条 | `optimize-notes`, `improve-title`, `seo-optimize` … |
| `COMMENT_COMMANDS` | 4 条 | `generate-comment`, `praise-comment` … |

每条的结构：

```ts
interface QuickCommand {
  id: string;      // 唯一标识
  label: string;   // 展示名称，如 "优化笔记"
  icon: string;    // emoji 图标，如 "🔥"
  command: string; // 发送给 AI 的指令文本
}
```

### 4. 场景预设 — 一键获取完整配置

```ts
interface RewritePreset {
  systemPrompt: string;          // 系统提示词
  outputSchema: JsonSchema;      // 输出结构
  commands: QuickCommand[];      // 快捷指令列表
  regeneratePrompt: string;      // 重新生成指令
}
```

- `POST_PRESET` — 笔记创作场景
- `COMMENT_PRESET` — 评论生成场景

### 5. 辅助函数

```ts
// 根据 provider 自动选最优的系统提示词（Qwen 用 Instructions，其他用 System Prompt）
getSystemPrompt(provider: 'openai' | 'claude' | 'qwen', source: 'post' | 'comment'): string

// 根据 source 取对应的输出 Schema
getOutputSchema(source: 'post' | 'comment'): JsonSchema

// 根据 source 取对应的快捷指令列表
getCommands(source: 'post' | 'comment'): QuickCommand[]
```

### 6. 引擎（方案 B）

```ts
// 创建引擎实例
const engine = createRewriteEngine({
  provider: 'openai',                       // 'openai' | 'claude' | 'qwen'
  apiKey: 'sk-xxx',
  baseURL: 'https://custom.api.com/v1',     // 可选：接入任意 OpenAI 兼容 API
  model: 'gpt-4o',                          // 可选：覆盖默认模型
});

// 方式 1：手动拼参数
const { data } = await engine.rewrite({
  systemPrompt: POST_SYSTEM_PROMPT,
  outputSchema: XHS_CONTENT_SCHEMA,
  instruction: '请优化这个标题',
  content: '原始内容...',
  images: ['data:image/jpeg;base64,...'],   // 可选
});

// 方式 2：用预设一键调用
const { data } = await rewriteWithPreset(engine, {
  preset: POST_PRESET,
  content: '原始内容...',
  commandId: 'optimize-notes',              // 从 preset.commands 中选
  // 或直接用 instruction: '自定义指令',
});
```

## 如何扩展自定义场景

不需要改源码，组合现有导出即可：

```ts
import { type RewritePreset, type JsonSchema, POST_SYSTEM_PROMPT } from './rewrite';

// 自定义输出 Schema
const MY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '内容摘要', maxLength: 50 },
    tags: { type: 'string', description: '标签列表' },
  },
  required: ['summary', 'tags'],
};

// 组装自定义预设
const MY_PRESET: RewritePreset = {
  systemPrompt: POST_SYSTEM_PROMPT,  // 复用现有提示词
  outputSchema: MY_SCHEMA,           // 自定义 Schema
  commands: [
    { id: 'summarize', icon: '📋', label: '生成摘要', command: '请提取内容摘要' },
  ],
  regeneratePrompt: '请换一个角度重新生成',
};

// 使用
const { data } = await rewriteWithPreset(engine, {
  preset: MY_PRESET,
  content: '...',
  commandId: 'summarize',
});
```

## 注意事项

1. **`types.ts` 和 `prompts.ts` 是纯数据 + 纯函数，不依赖 React / 浏览器 API**，可在 Node.js、Chrome Extension、VSCode 插件等任何环境使用。
2. **`index.ts` 中的 `RewriteEngine` 使用了 `dangerouslyAllowBrowser: true`**，适合浏览器插件环境。如果在纯 Node.js 服务端使用，去掉这个选项。
3. **图片格式差异**：OpenAI 使用完整 data URL，Claude 使用剥离前缀的 base64。引擎内部自动处理，调用方统一传 data URL 即可。
4. **Qwen 不支持 tool calling**，引擎自动降级为 `response_format: json_object` 模式，配合 `POST_INSTRUCTIONS_QWEN` / `COMMENT_INSTRUCTIONS_QWEN` 使用。
5. **复制时保持三个文件在同一目录**，`prompts.ts` import 了 `./types`，`index.ts` import 了 `./types` 和 `./prompts`。
