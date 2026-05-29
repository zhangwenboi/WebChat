const POPUP_WAIT_SELECTOR = [
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="menu"]',
  '.ant-picker-dropdown',
  '.ant-select-dropdown',
  '.el-picker-panel',
  '.el-select-dropdown',
  '.el-popper',
  '.MuiPopover-root',
  '.MuiMenu-root'
].join(', ');

const FORMAT_HINTS = [
  ['YYYY-MM-DD ~ YYYY-MM-DD', /\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s*(?:~|-|至|到)\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/g],
  ['YYYY-MM-DD', /\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/g]
];

export function buildGenerateScriptPrompts({ prompt, pageInfo }) {
  const systemPrompt = [
    '你是 WebChat 网页自动化脚本生成助手，只输出一个 JSON 对象，不要输出 Markdown。',
    '脚本格式必须是 { "meta": { "name": "..." }, "variables": {}, "steps": [{ "type": "...", "description": "...", "params": {}, "options": {} }] }。',
    '支持动作：click, input, select, checkbox, wait, waitTime, scroll, hover, keypress, hotkey, extract, assert, aiLocate。',
    '必须优先使用元素提供的 targets；如果没有 targets，再使用 selector 和 selectorFallbacks。',
    '所有用户提到或页面中明显相关的可见表单项都要全部填写，不要遗漏任何必填、可编辑、选择类字段。',
    '输入值必须匹配元素的 type、pattern、placeholder、formatHint、min/max 等格式要求。日期范围优先使用 YYYY-MM-DD ~ YYYY-MM-DD。',
    '点击会触发弹窗、下拉、日期选择器、时间范围选择器的元素后，必须添加 wait 步骤等待弹层可见，再点击或输入弹层中的目标元素。',
    '对于 select/combobox/date-range 这类控件，如果页面结构中有候选项、弹窗 selector 或格式提示，要生成打开控件、等待弹层、选择/输入值、确认的完整步骤。',
    '每个步骤都要有清晰中文 description；关键操作 options.timeout 使用 8000 到 12000 毫秒。',
    '不要臆造页面上不存在的 selector；无法确定值时使用变量占位符，并在 variables 中提供空字符串默认值。'
  ].join('\n');

  const userPrompt = [
    `用户需求：${prompt}`,
    '',
    '当前页面信息和交互元素如下。元素中的 label、formatHint、required、options、targets、popupHints 都是生成脚本的重要依据：',
    JSON.stringify(pageInfo || {}, null, 2)
  ].join('\n');

  return { systemPrompt, userPrompt };
}

export function normalizeGeneratedScript(rawScript, pageInfo = {}) {
  const script = rawScript && typeof rawScript === 'object' ? rawScript : {};
  const meta = {
    ...(script.meta && typeof script.meta === 'object' ? script.meta : {})
  };
  const variables = {
    ...(script.variables && typeof script.variables === 'object' ? script.variables : {})
  };
  const elements = Array.isArray(pageInfo.elements) ? pageInfo.elements : [];
  const steps = Array.isArray(script.steps) ? script.steps.map((step, index) => normalizeStep(step, index, elements)) : [];

  addMissingFieldSteps(steps, variables, elements);
  addPopupWaitSteps(steps, elements);
  normalizeInputValues(steps, elements);

  return {
    ...script,
    meta,
    variables,
    steps: steps.map((step, index) => ({
      id: step.id || `step_${Date.now()}_${index + 1}`,
      type: step.type,
      description: step.description || defaultDescription(step),
      params: step.params || {},
      options: step.options || {}
    }))
  };
}

function normalizeStep(step, index, elements) {
  const normalized = step && typeof step === 'object' ? { ...step } : {};
  normalized.type = normalizeActionType(normalized.type);
  normalized.description = normalized.description || '';
  normalized.params = normalized.params && typeof normalized.params === 'object' ? { ...normalized.params } : {};
  normalized.options = normalized.options && typeof normalized.options === 'object' ? { ...normalized.options } : {};

  const element = findElementForStep(normalized, elements);
  if (element) mergeLocatorParams(normalized.params, element);
  if (!normalized.id) normalized.id = `step_${index + 1}`;
  if (!normalized.options.timeout && needsTimeout(normalized.type)) normalized.options.timeout = 8000;
  return normalized;
}

function normalizeActionType(type) {
  const text = String(type || '').trim();
  const aliases = {
    fill: 'input',
    typeText: 'input',
    setValue: 'input',
    choose: 'select',
    check: 'checkbox'
  };
  return aliases[text] || text || 'click';
}

function needsTimeout(type) {
  return ['click', 'input', 'select', 'checkbox', 'wait', 'hover', 'assert'].includes(type);
}

function mergeLocatorParams(params, element) {
  if (!params.selector && element.selector) params.selector = element.selector;
  if (!params.selectorFallbacks && Array.isArray(element.selectorFallbacks)) params.selectorFallbacks = element.selectorFallbacks;
  if (!params.targets && Array.isArray(element.targets)) params.targets = element.targets;
}

function findElementForStep(step, elements) {
  const selector = step.params?.selector;
  if (selector) {
    const bySelector = elements.find(el => el.selector === selector || (Array.isArray(el.selectorFallbacks) && el.selectorFallbacks.includes(selector)));
    if (bySelector) return bySelector;
  }

  const text = `${step.description || ''} ${step.params?.label || ''}`.toLowerCase();
  return elements.find(el => {
    const label = String(el.label || el.text || el.placeholder || el.name || '').toLowerCase();
    return label && text.includes(label);
  }) || null;
}

function addMissingFieldSteps(steps, variables, elements) {
  const handled = new Set(steps.map(step => step.params?.selector).filter(Boolean));
  for (const element of elements) {
    if (!isRelevantFormElement(element)) continue;
    if (!element.selector || handled.has(element.selector)) continue;

    const variableName = variableNameForElement(element);
    if (!(variableName in variables)) variables[variableName] = element.exampleValue || '';
    const type = element.tag === 'select' || element.role === 'combobox' ? 'select' : 'input';
    const step = {
      type,
      description: `填写${element.label || element.placeholder || element.name || element.selector}`,
      params: {
        selector: element.selector,
        value: `{{${variableName}}}`,
        clearBefore: type === 'input'
      },
      options: { timeout: 8000 }
    };
    mergeLocatorParams(step.params, element);
    steps.push(step);
    handled.add(element.selector);
  }
}

function isRelevantFormElement(element) {
  if (!element || !element.selector) return false;
  if (element.disabled || element.readOnly || element.type === 'hidden') return false;
  if (['input', 'textarea', 'select'].includes(element.tag)) return true;
  if (['textbox', 'combobox', 'spinbutton', 'searchbox'].includes(element.role) || element.contentEditable === true) return true;
  if (element.label || element.placeholder || element.formatHint || element.name) return true;
  return false;
}

function variableNameForElement(element) {
  const source = element.name || element.id || element.label || element.placeholder || 'field';
  const ascii = String(source)
    .trim()
    .replace(/^[^A-Za-z_]+/, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return ascii || `field_${Math.abs(hashCode(String(source)))}`;
}

function hashCode(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash) + text.charCodeAt(i);
  return hash | 0;
}

function addPopupWaitSteps(steps, elements) {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.type !== 'click') continue;
    if (!looksLikePopupTrigger(step, elements)) continue;
    const next = steps[i + 1];
    if (next && next.type === 'wait') continue;
    steps.splice(i + 1, 0, {
      type: 'wait',
      description: '等待弹窗或下拉面板出现',
      params: { selector: popupSelectorForStep(step, elements), state: 'visible' },
      options: { timeout: 10000 }
    });
    i++;
  }
}

function looksLikePopupTrigger(step, elements) {
  const element = findElementForStep(step, elements);
  if (element?.opensPopup || element?.ariaHasPopup || element?.popupSelector) return true;
  const text = `${step.description || ''} ${element?.label || ''} ${element?.placeholder || ''}`.toLowerCase();
  return /弹窗|下拉|日期|时间|范围|选择器|picker|dropdown|select|range/.test(text);
}

function popupSelectorForStep(step, elements) {
  const element = findElementForStep(step, elements);
  return step.params.popupSelector || element?.popupSelector || POPUP_WAIT_SELECTOR;
}

function normalizeInputValues(steps, elements) {
  for (const step of steps) {
    if (step.type !== 'input' || step.params?.value == null) continue;
    const element = findElementForStep(step, elements);
    const hint = element?.formatHint || step.params.formatHint || '';
    if (!hint) continue;
    step.params.value = normalizeValueForFormat(step.params.value, hint);
  }
}

function normalizeValueForFormat(value, hint) {
  let out = String(value);
  if (/YYYY-MM-DD\s*~\s*YYYY-MM-DD/i.test(hint)) {
    out = out.replace(FORMAT_HINTS[0][1], (_, y1, m1, d1, y2, m2, d2) => {
      return `${y1}-${pad2(m1)}-${pad2(d1)} ~ ${y2}-${pad2(m2)}-${pad2(d2)}`;
    });
  } else if (/YYYY-MM-DD/i.test(hint)) {
    out = out.replace(FORMAT_HINTS[1][1], (_, y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`);
  } else if (/number|数字|金额|价格|预算/i.test(hint)) {
    out = out.replace(/,/g, '');
  }
  return out;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function defaultDescription(step) {
  const selector = step.params?.selector || '';
  if (step.type === 'input') return `输入 ${selector}`;
  if (step.type === 'click') return `点击 ${selector}`;
  if (step.type === 'wait') return `等待 ${selector}`;
  return step.type;
}
