/**
 * 多模型提供商配置
 *
 * - visionCapable：该提供商的协议本身是否支持图像消息。为 false 的 provider
 *   即使用户在 UI 勾选"当前模型支持视觉"也会被忽略，避免发出对端不接受的 payload。
 * - defaultSupportsVision：visionCapable=true 时，"未被用户手动调整"前的默认值。
 *   用户可在 options 中针对当前选中的模型单独覆盖，存储在 providers[key].supportsVision。
 */
export const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    apiBase: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    defaultModel: 'gpt-4o-mini',
    requiresKey: true,
    authType: 'bearer',
    requestFormat: 'openai',
    streamFormat: 'sse',
    visionCapable: true,
    defaultSupportsVision: true,
    apiKeyPlaceholder: '请输入 OpenAI API Key',
    modelHelp: '推荐：gpt-4o-mini（性价比高）、gpt-4o（最强）'
  },
  deepseek: {
    name: 'DeepSeek',
    apiBase: 'https://api.deepseek.com/chat/completions',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    requiresKey: true,
    authType: 'bearer',
    requestFormat: 'openai',
    streamFormat: 'sse',
    visionCapable: false,
    defaultSupportsVision: false,
    apiKeyPlaceholder: '请输入 DeepSeek API Key',
    modelHelp: '推荐：deepseek-chat（通用）、deepseek-reasoner（推理）'
  },
  claude: {
    name: 'Claude',
    apiBase: 'https://api.anthropic.com/v1/messages',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414', 'claude-opus-4-20250514'],
    defaultModel: 'claude-sonnet-4-20250514',
    requiresKey: true,
    authType: 'x-api-key',
    requestFormat: 'anthropic',
    streamFormat: 'sse',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
    visionCapable: true,
    defaultSupportsVision: true,
    apiKeyPlaceholder: '请输入 Anthropic API Key',
    modelHelp: '推荐：claude-sonnet-4（均衡）、claude-opus-4（最强）'
  },
  gemini: {
    name: 'Gemini',
    apiBase: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    defaultModel: 'gemini-2.5-flash',
    requiresKey: true,
    authType: 'query',
    requestFormat: 'gemini',
    streamFormat: 'json-stream',
    visionCapable: true,
    defaultSupportsVision: true,
    apiKeyPlaceholder: '请输入 Google AI API Key',
    modelHelp: '推荐：gemini-2.5-flash（快速）、gemini-2.5-pro（最强）'
  },
  ollama: {
    name: '本地模型 (Ollama)',
    apiBase: 'http://127.0.0.1:11434/api/chat',
    models: [],
    defaultModel: 'qwen2.5',
    requiresKey: false,
    authType: 'none',
    requestFormat: 'ollama',
    streamFormat: 'ndjson',
    fetchModels: true,
    visionCapable: true, // ollama 视模型而定，由用户开关决定
    defaultSupportsVision: false,
    apiKeyPlaceholder: '本地模型无需 API 密钥',
    modelHelp: '使用前请确保已安装模型：ollama pull qwen2.5'
  },
  custom: {
    name: '自定义 API',
    apiBase: '',
    models: [],
    defaultModel: '',
    requiresKey: true,
    authType: 'bearer',
    requestFormat: 'openai',
    streamFormat: 'sse',
    visionCapable: true, // 自定义 OpenAI 兼容端点，由用户开关决定
    defaultSupportsVision: false,
    apiKeyPlaceholder: '请输入 API 密钥',
    modelHelp: '支持 OpenAI 兼容的 API 接口'
  }
};

export const DEFAULT_SETTINGS = {
  activeProvider: 'openai',
  maxTokens: 2048,
  temperature: 0.7,
  enableContext: true,
  maxContextRounds: 3,
  systemPrompt: '你是一个帮助理解网页内容的AI助手。请使用Markdown格式回复。',
  autoHideDialog: true,
  // 显示模式：'floating'（悬浮，可拖动） | 'sidebar-left' | 'sidebar-right'
  displayMode: 'floating',
  // 侧边栏宽度（px）
  sidebarWidth: 380,
  // 图片识别（多模态）
  enableImageRecognition: false,
  maxImagesPerPage: 3,
  // 视觉副模型 fallback：主模型不支持视觉时把图片转文字描述再喂给主模型
  // 空字符串 = 自动从已配 key 的 visionCapable provider 中挑选
  visionFallbackProvider: '',
  // 旧行为兜底：未标记任何图片时是否自动抓取页面图片（默认关，鼓励用户显式标记）
  autoCollectPageImages: false,
  // 多 tab 引用压缩
  enableTabCompression: true,
  tabCompressMaxChars: 3000,
  tabCompressMode: 'hybrid', // 'truncate' | 'ai' | 'hybrid'
  providers: Object.fromEntries(
    Object.entries(PROVIDERS).map(([key, config]) => [
      key,
      {
        apiKey: '',
        apiBase: config.apiBase,
        model: config.defaultModel,
        supportsVision: !!config.defaultSupportsVision
      }
    ])
  )
};
