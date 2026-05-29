import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGenerateScriptPrompts,
  normalizeGeneratedScript
} from '../src/background/ai-script-prompts.js';

test('generate prompt requires complete form filling, popup waits, and input formats', () => {
  const { systemPrompt, userPrompt } = buildGenerateScriptPrompts({
    prompt: '填写时间范围、本月预算和联系人，然后提交',
    pageInfo: {
      url: 'https://example.test/report',
      title: '报表',
      elements: [
        {
          tag: 'input',
          type: 'text',
          label: '时间范围',
          placeholder: '开始日期 ~ 结束日期',
          formatHint: 'YYYY-MM-DD ~ YYYY-MM-DD',
          selector: '#range'
        },
        {
          tag: 'input',
          type: 'number',
          label: '本月预算',
          formatHint: 'number',
          selector: '#budget'
        }
      ]
    }
  });

  assert.match(systemPrompt, /所有.*表单项|表单项.*全部/);
  assert.match(systemPrompt, /弹窗|下拉|日期选择器/);
  assert.match(systemPrompt, /格式/);
  assert.match(userPrompt, /YYYY-MM-DD ~ YYYY-MM-DD/);
});

test('normalizeGeneratedScript keeps all fields and adds wait after popup trigger click', () => {
  const script = normalizeGeneratedScript({
    meta: { name: '填报表' },
    variables: {},
    steps: [
      {
        type: 'click',
        description: '打开时间范围弹窗',
        params: { selector: '#range' }
      },
      {
        type: 'input',
        description: '填写时间范围',
        params: { selector: '#range', value: '2026/05/01-2026/05/31' }
      }
    ]
  }, {
    elements: [
      { label: '时间范围', selector: '#range', formatHint: 'YYYY-MM-DD ~ YYYY-MM-DD' },
      { label: '联系人', selector: '#contact' }
    ]
  });

  assert.equal(script.meta.name, '填报表');
  assert.equal(script.steps[1].type, 'wait');
  assert.equal(script.steps[1].params.state, 'visible');
  assert.equal(script.steps[2].params.value, '2026-05-01 ~ 2026-05-31');
  assert.ok(
    script.steps.some(step => step.params?.selector === '#contact'),
    'missing visible form fields should be represented for manual review'
  );
});
