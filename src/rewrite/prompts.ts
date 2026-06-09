/**
 * Rewrite Prompts — 提示词库（平台无关、UI 无关）
 *
 * 从原小红书 AI 助手中提取的全部提示词资产：
 *   - 系统提示词（System Prompt）
 *   - 输出 JSON Schema
 *   - 快捷指令模板
 *   - 预设：一键获取某个场景的完整配置
 *
 * 其他插件可直接 import 使用，也可配合 RewriteEngine 执行。
 */

import type { JsonSchema } from './types';

// ═══════════════════════════════════════════════════════════
// 输出 Schema
// ═══════════════════════════════════════════════════════════

/** 小红书笔记内容的输出 Schema */
export const XHS_CONTENT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      maxLength: 20,
      description:
        '优化后的标题，要吸引人、有点击欲望，符合小红书风格，不超过20个字符',
    },
    content: {
      type: 'string',
      maxLength: 1000,
      description:
        '优化后的完整内容，可包含表情符号、话题标签、换行等，不超过1000个字符',
    },
  },
  required: ['title', 'content'],
  additionalProperties: false,
};

/** 小红书评论的输出 Schema */
export const XHS_COMMENT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    content: {
      type: 'string',
      maxLength: 100,
      description:
        '生成的评论内容，要有趣、有价值，可包含表情符号，不超过100个字符',
    },
  },
  required: ['content'],
  additionalProperties: false,
};

// ═══════════════════════════════════════════════════════════
// 系统提示词（给 Claude / ChatGPT 用）
// ═══════════════════════════════════════════════════════════

/** 小红书笔记创作的 System Prompt */
export const POST_SYSTEM_PROMPT = `你是一个专业的小红书内容创作专家，擅长创作吸引人的标题和内容。

请根据用户提供的图片和内容以及要求，生成符合小红书风格的标题和正文内容。

要求：
1. 标题要吸引人，有点击欲望，不超过20个字符
2. 内容要有价值，可读性强，符合小红书用户喜好
3. 适当使用表情符号和话题标签（#标签#）
4. 语言风格要亲切自然，贴近用户`;

/** 小红书评论创作的 System Prompt */
export const COMMENT_SYSTEM_PROMPT = `你是一个专业的小红书评论助手，擅长生成有趣、有价值的评论内容。

请根据用户提供的笔记图片和内容以及要求，生成一条简短的评论。

要求：
1. 评论要真诚自然，符合小红书社区氛围
2. 适当使用表情符号，让评论更生动
3. 字数控制在100字以内`;

// ═══════════════════════════════════════════════════════════
// Qwen 专用指令（更详细的规则描述，用于 json_object 模式）
// ═══════════════════════════════════════════════════════════

/** Qwen 通义千问 — 笔记内容生成指令 */
export const POST_INSTRUCTIONS_QWEN = `你是一个专业的小红书内容创作专家。请根据用户提供的信息和图片，生成符合小红书风格的标题和内容。

输出要求：严格按照JSON格式，包含title和content两个字符串字段。

创作规则：
1. 标题：吸引人、有点击欲望，不超过20个字符
2. 内容：真实有用、亲切自然，适当使用表情符号和话题标签
3. 语言风格：符合小红书用户喜好`;

/** Qwen 通义千问 — 评论生成指令 */
export const COMMENT_INSTRUCTIONS_QWEN = `你是一个专业的小红书评论助家。请根据用户提供的笔记内容和图片，生成一条简短的、有趣的评论。

输出要求：严格按照JSON格式，包含content一个字符串字段。

评论规则：
1. 语气：真诚自然、友好亲切，符合小红书社区氛围
2. 长度：控制在100字以内，适当使用表情符号`;

// ═══════════════════════════════════════════════════════════
// 快捷指令模板 — 笔记内容
// ═══════════════════════════════════════════════════════════

export interface QuickCommand {
  id: string;
  label: string;
  icon: string;
  /** 发送给 AI 的指令文本 */
  command: string;
}

/** 笔记内容创作 — 快捷指令 */
export const POST_COMMANDS: QuickCommand[] = [
  {
    id: 'optimize-notes',
    icon: '🔥',
    label: '优化笔记',
    command:
      '请基于当前的标题和内容进行全面的优化，包括优化标题让它更吸引人、丰富内容细节、添加合适的表情符号和话题标签，让整篇笔记更符合小红书的风格和传播效果',
  },
  {
    id: 'enhance-content',
    icon: '📝',
    label: '丰富内容',
    command:
      '请帮我丰富这个内容，增加更多细节描述、使用心得和实用建议，让内容更有价值',
  },
  {
    id: 'improve-title',
    icon: '✨',
    label: '优化标题',
    command:
      '请帮我优化这个标题，让它更吸引人、更有点击欲望，符合小红书的风格',
  },
  {
    id: 'add-hashtags',
    icon: '#️⃣',
    label: '生成话题标签',
    command:
      '请为这篇内容生成5-8个合适的小红书话题标签，包括热门标签和精准标签',
  },
  {
    id: 'add-emoji',
    icon: '😊',
    label: '添加表情符号',
    command:
      '请在内容中适当添加表情符号，让文案更生动活泼，符合小红书的风格',
  },
  {
    id: 'seo-optimize',
    icon: '🔍',
    label: 'SEO优化',
    command:
      '请优化这个内容的关键词分布，提高在小红书搜索中的曝光率',
  },
];

/** 评论生成 — 快捷指令 */
export const COMMENT_COMMANDS: QuickCommand[] = [
  {
    id: 'generate-comment',
    icon: '💬',
    label: '生成评论',
    command:
      '请基于这篇笔记的图片和内容生成一条评论',
  },
  {
    id: 'ask-question',
    icon: '❓',
    label: '提问互动',
    command:
      '请基于这篇笔记的图片和内容生成提问式的评论，促进与博主的互动',
  },
  {
    id: 'praise-comment',
    icon: '👏',
    label: '夸赞评论',
    command:
      '请基于这篇笔记的图片和内容生成一条夸赞评论',
  },
  {
    id: 'emoji-comment',
    icon: '😊',
    label: '表情评论',
    command:
      '请基于这篇笔记的图片和内容生成一条带有很多表情的评论',
  },
];

// ═══════════════════════════════════════════════════════════
// 特殊指令
// ═══════════════════════════════════════════════════════════

/** 重新生成指令（要求 AI 给出不同于上一轮的创意版本） */
export const REGENERATE_PROMPT = `请基于之前的要求重新生成一个不同的版本。要求：
1. 提供与之前不同的创意角度和表达方式
2. 保持相同的主题和核心信息

请生成一个全新的、有创意的版本。`;

// ═══════════════════════════════════════════════════════════
// 场景预设（一键获取完整配置）
// ═══════════════════════════════════════════════════════════

export interface RewritePreset {
  systemPrompt: string;
  outputSchema: JsonSchema;
  commands: QuickCommand[];
  regeneratePrompt: string;
}

/** 笔记内容创作场景的完整预设 */
export const POST_PRESET: RewritePreset = {
  systemPrompt: POST_SYSTEM_PROMPT,
  outputSchema: XHS_CONTENT_SCHEMA,
  commands: POST_COMMANDS,
  regeneratePrompt: REGENERATE_PROMPT,
};

/** 评论生成场景的完整预设 */
export const COMMENT_PRESET: RewritePreset = {
  systemPrompt: COMMENT_SYSTEM_PROMPT,
  outputSchema: XHS_COMMENT_SCHEMA,
  commands: COMMENT_COMMANDS,
  regeneratePrompt: REGENERATE_PROMPT,
};

// ═══════════════════════════════════════════════════════════
// 辅助：根据 provider 获取最优的指令文本
// ═══════════════════════════════════════════════════════════

/**
 * 根据 AI provider 选择最合适的系统提示词版本。
 *
 * Qwen 使用更详细的 instructions（内嵌 Schema 描述），
 * 其他 provider 使用标准 System Prompt（依赖 tool calling 强约束）。
 */
export function getSystemPrompt(
  provider: 'openai' | 'claude' | 'qwen',
  source: 'post' | 'comment'
): string {
  if (provider === 'qwen') {
    return source === 'post' ? POST_INSTRUCTIONS_QWEN : COMMENT_INSTRUCTIONS_QWEN;
  }
  return source === 'post' ? POST_SYSTEM_PROMPT : COMMENT_SYSTEM_PROMPT;
}

/**
 * 根据 source 获取对应的输出 Schema。
 */
export function getOutputSchema(source: 'post' | 'comment'): JsonSchema {
  return source === 'post' ? XHS_CONTENT_SCHEMA : XHS_COMMENT_SCHEMA;
}

/**
 * 根据 source 获取对应的快捷指令列表。
 */
export function getCommands(source: 'post' | 'comment'): QuickCommand[] {
  return source === 'post' ? POST_COMMANDS : COMMENT_COMMANDS;
}
