import { PROVIDERS, DEFAULT_SETTINGS } from '../lib/providers.js';
import { testApiConnection, fetchOllamaModels } from '../lib/api-adapter.js';
import { migrateSettings } from '../lib/storage.js';

let currentProvider = 'openai';

// 显示状态消息
function showStatus(message, type = 'success') {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status ${type}`;
  status.style.display = 'block';

  if (message === '正在测试API配置...') {
    setTimeout(() => {
      if (status.textContent === message) status.style.display = 'none';
    }, 2000);
  }
}

// 更新提供商 Tab UI
function switchProvider(providerKey) {
  currentProvider = providerKey;
  const provider = PROVIDERS[providerKey];

  // 更新 tab 激活状态
  document.querySelectorAll('.provider-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.provider === providerKey);
  });

  // 更新 API Key 显示
  const apiKeyGroup = document.querySelector('.api-key-group');
  apiKeyGroup.style.display = provider.requiresKey ? 'block' : 'none';
  document.getElementById('apiKey').placeholder = provider.apiKeyPlaceholder;

  // 更新模型下拉框
  const modelSelect = document.getElementById('modelSelect');
  modelSelect.innerHTML = '<option value="">手动输入...</option>';
  if (provider.models.length > 0) {
    provider.models.forEach(model => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      modelSelect.appendChild(option);
    });
    modelSelect.style.display = 'block';
  } else if (provider.fetchModels) {
    modelSelect.style.display = 'block';
    loadOllamaModels();
  } else {
    modelSelect.style.display = providerKey === 'custom' ? 'none' : 'block';
  }

  // 更新帮助文本
  document.getElementById('modelHelp').textContent = provider.modelHelp;
  document.getElementById('apiBaseHelp').textContent =
    providerKey === 'ollama' ? '本地 API 接口地址' : 'API 接口地址';

  // 从存储加载该提供商的配置
  chrome.storage.sync.get({ providers: DEFAULT_SETTINGS.providers }, (items) => {
    const config = items.providers[providerKey] || {};
    document.getElementById('apiKey').value = config.apiKey || '';
    document.getElementById('apiBase').value = config.apiBase || provider.apiBase;

    const model = config.model || provider.defaultModel;
    document.getElementById('modelInput').value = model;

    // 同步下拉框选中状态
    if (provider.models.includes(model)) {
      modelSelect.value = model;
    } else {
      modelSelect.value = '';
    }

    // 同步当前 provider 的视觉支持开关
    const visionEl = document.getElementById('modelSupportsVision');
    if (visionEl) {
      const protocolOk = provider.visionCapable !== false;
      if (!protocolOk) {
        visionEl.checked = false;
        visionEl.disabled = true;
        visionEl.title = '当前提供商协议不支持视觉输入（如 DeepSeek）';
      } else {
        visionEl.disabled = false;
        visionEl.title = '';
        const stored = config.supportsVision;
        visionEl.checked = typeof stored === 'boolean' ? stored : !!provider.defaultSupportsVision;
      }
    }
  });
}

// 加载 Ollama 模型列表
async function loadOllamaModels() {
  const modelSelect = document.getElementById('modelSelect');
  try {
    const apiBase = document.getElementById('apiBase').value || PROVIDERS.ollama.apiBase;
    const baseUrl = apiBase.replace(/\/api\/chat$/, '');
    const models = await fetchOllamaModels(baseUrl);

    modelSelect.innerHTML = '<option value="">手动输入...</option>';
    models.forEach(model => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      modelSelect.appendChild(option);
    });

    // 选中当前模型
    const currentModel = document.getElementById('modelInput').value;
    if (models.includes(currentModel)) {
      modelSelect.value = currentModel;
    }
  } catch {
    modelSelect.innerHTML = '<option value="">无法获取模型列表</option>';
  }
}

// 保存设置
async function saveOptions() {
  const providerKey = currentProvider;
  const apiKey = document.getElementById('apiKey').value.trim();
  const apiBase = document.getElementById('apiBase').value.trim() || PROVIDERS[providerKey].apiBase;
  const model = document.getElementById('modelInput').value.trim();

  // 验证
  const provider = PROVIDERS[providerKey];
  if (provider.requiresKey && !apiKey) {
    showStatus('API 密钥是必填项', 'error');
    return;
  }
  if (!model) {
    showStatus('请选择或输入模型名称', 'error');
    return;
  }

  const config = { apiKey, apiBase, model };

  showStatus('正在测试API配置...');

  try {
    await testApiConnection(providerKey, config);

    // 保存到存储（保留已有 supportsVision 等字段）
    const { providers = DEFAULT_SETTINGS.providers } = await chrome.storage.sync.get('providers');
    const prev = providers[providerKey] || {};
    providers[providerKey] = { ...prev, ...config };

    await chrome.storage.sync.set({
      activeProvider: providerKey,
      providers
    });

    showStatus('✅ API 配置测试成功，设置已保存');
  } catch (error) {
    showStatus(`测试失败: ${error.message}`, 'error');
  }
}

// 加载设置
async function loadOptions() {
  await migrateSettings();

  const settings = await chrome.storage.sync.get({
    activeProvider: DEFAULT_SETTINGS.activeProvider,
    providers: DEFAULT_SETTINGS.providers,
    maxTokens: DEFAULT_SETTINGS.maxTokens,
    temperature: DEFAULT_SETTINGS.temperature,
    enableContext: DEFAULT_SETTINGS.enableContext,
    maxContextRounds: DEFAULT_SETTINGS.maxContextRounds,
    systemPrompt: DEFAULT_SETTINGS.systemPrompt,
    autoHideDialog: DEFAULT_SETTINGS.autoHideDialog,
    displayMode: DEFAULT_SETTINGS.displayMode,
    sidebarWidth: DEFAULT_SETTINGS.sidebarWidth,
    enableImageRecognition: DEFAULT_SETTINGS.enableImageRecognition,
    maxImagesPerPage: DEFAULT_SETTINGS.maxImagesPerPage,
    autoCollectPageImages: DEFAULT_SETTINGS.autoCollectPageImages,
    visionFallbackProvider: DEFAULT_SETTINGS.visionFallbackProvider,
    enableTabCompression: DEFAULT_SETTINGS.enableTabCompression,
    tabCompressMaxChars: DEFAULT_SETTINGS.tabCompressMaxChars,
    tabCompressMode: DEFAULT_SETTINGS.tabCompressMode
  });

  // 常规设置
  document.getElementById('autoHideDialog').checked = settings.autoHideDialog;
  document.getElementById('enableContext').checked = settings.enableContext;
  document.getElementById('maxContextRounds').value = settings.maxContextRounds;
  document.getElementById('systemPrompt').value = settings.systemPrompt;
  document.getElementById('contextSettings').style.display =
    settings.enableContext ? 'block' : 'none';

  // 图片识别 / 引用 tab 相关
  const imgEl = document.getElementById('enableImageRecognition');
  const imgSettings = document.getElementById('imageSettings');
  const maxImagesEl = document.getElementById('maxImagesPerPage');
  const visionEl = document.getElementById('modelSupportsVision');
  const autoCollectEl = document.getElementById('autoCollectPageImages');
  const fallbackEl = document.getElementById('visionFallbackProvider');
  const refMaxEl = document.getElementById('referencedTabMaxChars');
  const refModeEl = document.getElementById('referencedTabCompressMode');
  if (imgEl) imgEl.checked = !!settings.enableImageRecognition;
  if (maxImagesEl) maxImagesEl.value = settings.maxImagesPerPage;
  if (autoCollectEl) autoCollectEl.checked = !!settings.autoCollectPageImages;
  if (fallbackEl) fallbackEl.value = settings.visionFallbackProvider || '';
  // modelSupportsVision 跟随当前 provider 的 supportsVision，在 switchProvider 中再同步
  if (refMaxEl) refMaxEl.value = settings.tabCompressMaxChars;
  if (refModeEl) refModeEl.value = settings.tabCompressMode || 'hybrid';
  if (imgSettings) imgSettings.style.display = settings.enableImageRecognition ? 'block' : 'none';

  // 显示模式
  const modeEl = document.getElementById('displayMode');
  const sidebarWidthEl = document.getElementById('sidebarWidth');
  const sidebarSettings = document.getElementById('sidebarSettings');
  if (modeEl) modeEl.value = settings.displayMode || 'floating';
  if (sidebarWidthEl) sidebarWidthEl.value = settings.sidebarWidth || 380;
  if (sidebarSettings) {
    sidebarSettings.style.display = (settings.displayMode && settings.displayMode !== 'floating') ? 'block' : 'none';
  }

  // 模型参数
  document.getElementById('maxTokensRange').value = settings.maxTokens;
  document.getElementById('maxTokensInput').value = settings.maxTokens;
  document.getElementById('temperatureRange').value = settings.temperature;
  document.getElementById('temperatureInput').value = settings.temperature;

  // 切换到当前活跃的提供商
  switchProvider(settings.activeProvider);
}

// 还原默认设置
async function resetOptions() {
  if (!confirm('确定要还原所有设置到默认值吗？')) return;

  await chrome.storage.sync.set(DEFAULT_SETTINGS);
  await loadOptions();
  showStatus('已还原默认设置', 'warning');
}

// 事件绑定
document.addEventListener('DOMContentLoaded', async () => {
  await loadOptions();

  // 提供商 Tab 切换
  document.getElementById('providerTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.provider-tab');
    if (tab) switchProvider(tab.dataset.provider);
  });

  // 模型下拉框变化
  document.getElementById('modelSelect').addEventListener('change', (e) => {
    if (e.target.value) {
      document.getElementById('modelInput').value = e.target.value;
    }
  });

  // 模型输入框变化时同步下拉框
  document.getElementById('modelInput').addEventListener('input', (e) => {
    const modelSelect = document.getElementById('modelSelect');
    const provider = PROVIDERS[currentProvider];
    if (provider.models.includes(e.target.value)) {
      modelSelect.value = e.target.value;
    } else {
      modelSelect.value = '';
    }
  });

  // 滑块同步
  document.getElementById('maxTokensRange').addEventListener('input', (e) => {
    document.getElementById('maxTokensInput').value = e.target.value;
  });
  document.getElementById('maxTokensInput').addEventListener('input', (e) => {
    document.getElementById('maxTokensRange').value = e.target.value;
  });
  document.getElementById('temperatureRange').addEventListener('input', (e) => {
    document.getElementById('temperatureInput').value = e.target.value;
  });
  document.getElementById('temperatureInput').addEventListener('input', (e) => {
    document.getElementById('temperatureRange').value = e.target.value;
  });

  // 保存按钮
  document.getElementById('save').addEventListener('click', saveOptions);
  document.getElementById('reset').addEventListener('click', resetOptions);

  // API Key 可见性切换
  const toggleBtn = document.getElementById('toggleApiKey');
  const apiKeyInput = document.getElementById('apiKey');
  toggleBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    toggleBtn.title = isPassword ? '点击隐藏' : '点击显示';
  });

  // 常规设置即时保存
  const debounceSave = (fn, delay = 1000) => {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
  };

  document.getElementById('autoHideDialog').addEventListener('change', (e) => {
    chrome.storage.sync.set({ autoHideDialog: e.target.checked });
  });

  const enableContext = document.getElementById('enableContext');
  enableContext.addEventListener('change', (e) => {
    chrome.storage.sync.set({ enableContext: e.target.checked });
    document.getElementById('contextSettings').style.display = e.target.checked ? 'block' : 'none';
  });

  document.getElementById('maxContextRounds').addEventListener('change', (e) => {
    const value = Math.max(1, Math.min(10, parseInt(e.target.value) || 3));
    e.target.value = value;
    chrome.storage.sync.set({ maxContextRounds: value });
  });

  document.getElementById('systemPrompt').addEventListener('input', debounceSave((e) => {
    chrome.storage.sync.set({
      systemPrompt: e.target.value || DEFAULT_SETTINGS.systemPrompt
    });
  }));

  // 显示模式 / 侧边栏宽度
  const modeEl = document.getElementById('displayMode');
  if (modeEl) {
    modeEl.addEventListener('change', (e) => {
      const mode = e.target.value || 'floating';
      chrome.storage.sync.set({ displayMode: mode });
      const sub = document.getElementById('sidebarSettings');
      if (sub) sub.style.display = mode === 'floating' ? 'none' : 'block';
    });
  }
  const sidebarWidthEl = document.getElementById('sidebarWidth');
  if (sidebarWidthEl) {
    sidebarWidthEl.addEventListener('change', (e) => {
      const v = Math.max(280, Math.min(720, parseInt(e.target.value) || 380));
      e.target.value = v;
      chrome.storage.sync.set({ sidebarWidth: v });
    });
  }

  // maxTokens 和 temperature 保存
  const saveModelParams = debounceSave(() => {
    chrome.storage.sync.set({
      maxTokens: parseInt(document.getElementById('maxTokensInput').value),
      temperature: parseFloat(document.getElementById('temperatureInput').value)
    });
  }, 500);

  document.getElementById('maxTokensInput').addEventListener('input', saveModelParams);
  document.getElementById('temperatureInput').addEventListener('input', saveModelParams);

  // 图片识别开关
  const enableImg = document.getElementById('enableImageRecognition');
  if (enableImg) {
    enableImg.addEventListener('change', (e) => {
      chrome.storage.sync.set({ enableImageRecognition: e.target.checked });
      const sub = document.getElementById('imageSettings');
      if (sub) sub.style.display = e.target.checked ? 'block' : 'none';
    });
  }
  const maxImagesEl = document.getElementById('maxImagesPerPage');
  if (maxImagesEl) {
    maxImagesEl.addEventListener('change', (e) => {
      const v = Math.max(1, Math.min(8, parseInt(e.target.value) || 3));
      e.target.value = v;
      chrome.storage.sync.set({ maxImagesPerPage: v });
    });
  }
  const autoCollectEl = document.getElementById('autoCollectPageImages');
  if (autoCollectEl) {
    autoCollectEl.addEventListener('change', (e) => {
      chrome.storage.sync.set({ autoCollectPageImages: e.target.checked });
    });
  }
  const fallbackEl = document.getElementById('visionFallbackProvider');
  if (fallbackEl) {
    fallbackEl.addEventListener('change', (e) => {
      chrome.storage.sync.set({ visionFallbackProvider: e.target.value || '' });
    });
  }
  const visionEl = document.getElementById('modelSupportsVision');
  if (visionEl) {
    visionEl.addEventListener('change', async (e) => {
      const { providers = DEFAULT_SETTINGS.providers } = await chrome.storage.sync.get('providers');
      const cur = providers[currentProvider] || {};
      providers[currentProvider] = { ...cur, supportsVision: e.target.checked };
      await chrome.storage.sync.set({ providers });
    });
  }
  const refMaxEl = document.getElementById('referencedTabMaxChars');
  if (refMaxEl) {
    refMaxEl.addEventListener('change', (e) => {
      const v = Math.max(500, Math.min(20000, parseInt(e.target.value) || 4000));
      e.target.value = v;
      chrome.storage.sync.set({ tabCompressMaxChars: v });
    });
  }
  const refModeEl = document.getElementById('referencedTabCompressMode');
  if (refModeEl) {
    refModeEl.addEventListener('change', (e) => {
      chrome.storage.sync.set({ tabCompressMode: e.target.value });
    });
  }
});
