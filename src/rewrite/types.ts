/**
 * Rewrite Module — 通用 AI 内容改写/生成处理模块
 *
 * 平台无关、UI 无关，可被任意插件引用。
 * 传入内容 + 指令 + 输出 Schema → 返回结构化 AI 结果。
 */

// ─── Provider ────────────────────────────────────────────
/** 支持的 AI 提供商 */
export type AIProvider = 'openai' | 'claude' | 'qwen';

// ─── Config ──────────────────────────────────────────────
export interface RewriteConfig {
  provider: AIProvider;
  apiKey: string;
  /** OpenAI 兼容的自定义端点（如通义千问、DeepSeek 等） */
  baseURL?: string;
  /** 模型名称，不填则使用各 provider 默认值 */
  model?: string;
}

// ─── Schema ──────────────────────────────────────────────
export interface JsonSchemaProperty {
  type: string;
  description?: string;
  maxLength?: number;
  enum?: string[];
  items?: JsonSchemaProperty;
}

/** 输出 JSON Schema —— AI 必须按此结构返回 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

// ─── I/O ─────────────────────────────────────────────────
export interface RewriteRequest {
  /** 改写指令，描述如何改写（如 "优化标题"、"丰富内容"） */
  instruction: string;
  /** 系统提示词，定义 AI 的角色和行为准则 */
  systemPrompt: string;
  /** 待改写的原始内容 */
  content: string;
  /** 可选的图片（base64 data URL 或 `data:image/...` 格式） */
  images?: string[];
  /** 期望的输出 JSON Schema */
  outputSchema: JsonSchema;
  /** 临时覆盖 provider（默认用 config 中的） */
  provider?: AIProvider;
  /** 临时覆盖 model */
  model?: string;
}

export interface RewriteResponse {
  /** 按 outputSchema 解析后的结构化数据 */
  data: Record<string, any>;
  /** 原始响应文本（降级时使用） */
  rawContent: string;
  /** Token 用量（部分 provider 支持） */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}
