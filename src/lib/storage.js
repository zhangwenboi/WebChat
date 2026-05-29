import { DEFAULT_SETTINGS, PROVIDERS } from './providers.js';

/**
 * 存储迁移 — 将旧格式配置迁移到新的多提供商格式
 */
export async function migrateSettings() {
  const oldSettings = await chrome.storage.sync.get(null);

  // 如果已经是新格式，跳过迁移
  if (oldSettings.activeProvider && oldSettings.providers) {
    return oldSettings;
  }

  // 检测旧格式标志
  if (!oldSettings.apiType) {
    // 全新安装，使用默认设置
    await chrome.storage.sync.set(DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }

  // 执行迁移
  const newSettings = { ...DEFAULT_SETTINGS };

  // 映射旧的 apiType 到新的 activeProvider
  if (oldSettings.apiType === 'custom') {
    newSettings.activeProvider = 'openai';
  } else if (oldSettings.apiType === 'ollama') {
    newSettings.activeProvider = 'ollama';
  }

  // 迁移通用设置
  if (oldSettings.maxTokens) newSettings.maxTokens = oldSettings.maxTokens;
  if (oldSettings.temperature !== undefined) newSettings.temperature = oldSettings.temperature;
  if (oldSettings.enableContext !== undefined) newSettings.enableContext = oldSettings.enableContext;
  if (oldSettings.maxContextRounds) newSettings.maxContextRounds = oldSettings.maxContextRounds;
  if (oldSettings.systemPrompt) newSettings.systemPrompt = oldSettings.systemPrompt;
  if (oldSettings.autoHideDialog !== undefined) newSettings.autoHideDialog = oldSettings.autoHideDialog;

  // 迁移 custom API 配置到 openai provider
  if (oldSettings.custom_apiKey || oldSettings.custom_apiBase || oldSettings.custom_model) {
    newSettings.providers.openai = {
      apiKey: oldSettings.custom_apiKey || '',
      apiBase: oldSettings.custom_apiBase || PROVIDERS.openai.apiBase,
      model: oldSettings.custom_model || PROVIDERS.openai.defaultModel
    };
    // 同时保留到 custom provider
    newSettings.providers.custom = {
      apiKey: oldSettings.custom_apiKey || '',
      apiBase: oldSettings.custom_apiBase || '',
      model: oldSettings.custom_model || ''
    };
  }

  // 迁移 ollama 配置
  if (oldSettings.ollama_apiBase || oldSettings.ollama_model) {
    newSettings.providers.ollama = {
      apiKey: '',
      apiBase: oldSettings.ollama_apiBase || PROVIDERS.ollama.apiBase,
      model: oldSettings.ollama_model || PROVIDERS.ollama.defaultModel
    };
  }

  // 保留 UI 状态
  if (oldSettings.showFloatingBall !== undefined) newSettings.showFloatingBall = oldSettings.showFloatingBall;
  if (oldSettings.dialogPosition) newSettings.dialogPosition = oldSettings.dialogPosition;
  if (oldSettings.dialogSize) newSettings.dialogSize = oldSettings.dialogSize;
  if (oldSettings.ballPosition) newSettings.ballPosition = oldSettings.ballPosition;
  if (oldSettings.totalTokens) newSettings.totalTokens = oldSettings.totalTokens;

  // 清除旧格式的 key，写入新格式
  const keysToRemove = [
    'apiType', 'custom_apiKey', 'custom_apiBase', 'custom_model',
    'ollama_apiKey', 'ollama_apiBase', 'ollama_model', 'activeConfig'
  ];
  await chrome.storage.sync.remove(keysToRemove);
  await chrome.storage.sync.set(newSettings);

  return newSettings;
}

/**
 * 获取当前活跃提供商的配置
 */
export async function getActiveProviderConfig() {
  const settings = await chrome.storage.sync.get(['activeProvider', 'providers']);
  const providerKey = settings.activeProvider || DEFAULT_SETTINGS.activeProvider;
  const providers = settings.providers || DEFAULT_SETTINGS.providers;
  const config = providers[providerKey] || {};

  return {
    providerKey,
    apiKey: config.apiKey || '',
    apiBase: config.apiBase || PROVIDERS[providerKey]?.apiBase || '',
    model: config.model || PROVIDERS[providerKey]?.defaultModel || ''
  };
}
