// 脚本管理面板：列表、录制、编辑、执行、AI 生成、导入导出
import { Recorder } from './recorder.js';
import { ScriptExecutor, utils as ExecutorUtils } from './executor.js';
import ElementPicker from './element-picker.js';
import { exportToFile, importFromText } from './export.js';
import { hideScriptUiForPicking } from './picker-ui-visibility.js';

const STORAGE_KEY = 'webchat_scripts';
const PANEL_ID = 'webchat-script-panel';

// 与 recorder.js 中的 attachHitPoint 等价：picker 选元素后由 panel 调用，给 step 补
// 坐标兜底信息（hitPoint）。重放时若 selector / targets 都失效，executor 走该信息
// 做 elementFromPoint 命中。仅记录元素中心点（picker 没有真实点击事件坐标）。
function buildHitPointForElement(el) {
    if (!el || el.nodeType !== 1) return null;
    let rect;
    try { rect = el.getBoundingClientRect(); } catch { return null; }
    if (!rect) return null;
    if (rect.width === 0 && rect.height === 0) return null;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const text = (el.textContent || el.value || el.placeholder || el.getAttribute?.('aria-label') || '')
        .replace(/\s+/g, ' ').trim().slice(0, 60);
    return {
        rx: 0.5,
        ry: 0.5,
        vx: Math.round(cx),
        vy: Math.round(cy),
        rect: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
        },
        viewport: {
            w: window.innerWidth,
            h: window.innerHeight,
            sx: window.scrollX,
            sy: window.scrollY
        },
        sig: {
            tag: el.tagName ? el.tagName.toLowerCase() : '',
            role: el.getAttribute?.('role') || '',
            type: el.getAttribute?.('type') || '',
            text
        }
    };
}

// ====== 数据存储 ======

async function loadScripts() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function saveScripts(list) {
    await chrome.storage.local.set({ [STORAGE_KEY]: list });
}

async function upsertScript(script) {
    const list = await loadScripts();
    script.meta.updatedAt = new Date().toISOString();
    const idx = list.findIndex(s => s.meta.id === script.meta.id);
    if (idx >= 0) list[idx] = script;
    else list.unshift(script);
    await saveScripts(list);
    return list;
}

async function deleteScript(id) {
    const list = await loadScripts();
    const next = list.filter(s => s.meta.id !== id);
    await saveScripts(next);
    return next;
}

// ====== 面板 ======

let panelEl = null;
let recordingBarEl = null;
let currentView = 'list';
let currentScript = null;
let recorder = null;
let executor = null;

function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.id = PANEL_ID;
    panelEl.innerHTML = `
        <div class="webchat-script-panel-inner">
            <div class="webchat-script-panel-header">
                <span class="webchat-script-panel-title">脚本自动化</span>
                <div class="webchat-script-panel-actions">
                    <button data-act="back" class="webchat-script-btn webchat-script-btn-icon" title="返回">←</button>
                    <button data-act="close" class="webchat-script-btn webchat-script-btn-icon" title="关闭">×</button>
                </div>
            </div>
            <div class="webchat-script-panel-body"></div>
            <div class="webchat-script-panel-footer"></div>
        </div>
    `;
    document.body.appendChild(panelEl);

    panelEl.querySelector('[data-act="close"]').addEventListener('click', () => closePanel());
    panelEl.querySelector('[data-act="back"]').addEventListener('click', () => {
        if (currentView !== 'list') renderList();
        else closePanel();
    });

    const header = panelEl.querySelector('.webchat-script-panel-header');
    let dragging = false, dx = 0, dy = 0;
    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        dragging = true;
        const r = panelEl.getBoundingClientRect();
        dx = e.clientX - r.left;
        dy = e.clientY - r.top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panelEl.style.left = (e.clientX - dx) + 'px';
        panelEl.style.top = (e.clientY - dy) + 'px';
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    return panelEl;
}

function openPanel() {
    ensurePanel();
    panelEl.classList.add('webchat-script-panel-open');
    renderList();
}

function closePanel() {
    if (recorder?.recording) {
        recorder.stop();
        hideRecordingBar();
    }
    if (panelEl) panelEl.classList.remove('webchat-script-panel-open');
}

// 重新渲染前用 cloneNode(false) 替换容器：旧节点上累积的所有事件监听器
// 会随旧节点一起被丢弃，避免每次 render 给同一个容器叠加 click/input handler
// 而导致的"保存触发多次"等问题。
function refreshContainer(selector) {
    const old = panelEl.querySelector(selector);
    if (!old) return null;
    const fresh = old.cloneNode(false);
    old.replaceWith(fresh);
    return fresh;
}

function setBody(html) {
    const body = refreshContainer('.webchat-script-panel-body');
    if (body) body.innerHTML = html;
    return body;
}

function setFooter(html) {
    const f = refreshContainer('.webchat-script-panel-footer');
    if (f) f.innerHTML = html;
    return f;
}

// ====== 列表视图 ======

async function renderList() {
    currentView = 'list';
    currentScript = null;
    const list = await loadScripts();
    const items = list.length ? list.map(s => `
        <div class="webchat-script-item" data-id="${s.meta.id}">
            <div class="webchat-script-item-info">
                <div class="webchat-script-item-name">${escapeHtml(s.meta.name)}</div>
                <div class="webchat-script-item-meta">${s.steps.length} 步 · ${s.meta.source || 'manual'} · ${formatDate(s.meta.updatedAt)}</div>
            </div>
            <div class="webchat-script-item-actions">
                <button data-act="run" class="webchat-script-btn webchat-script-btn-primary">▶</button>
                <button data-act="edit" class="webchat-script-btn">编辑</button>
                <button data-act="export" class="webchat-script-btn">导出</button>
                <button data-act="delete" class="webchat-script-btn webchat-script-btn-danger">删除</button>
            </div>
        </div>
    `).join('') : `<div class="webchat-script-empty">暂无脚本，点击下方按钮创建</div>`;

    setBody(`<div class="webchat-script-list">${items}</div>`);
    setFooter(`
        <button data-act="record" class="webchat-script-btn webchat-script-btn-primary">● 开始录制</button>
        <button data-act="ai" class="webchat-script-btn">✨ AI 生成</button>
        <button data-act="manual" class="webchat-script-btn">+ 手动创建</button>
        <button data-act="import" class="webchat-script-btn">导入</button>
    `);

    panelEl.querySelector('.webchat-script-list').addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const item = e.target.closest('.webchat-script-item');
        const id = item?.dataset.id;
        const ls = await loadScripts();
        const script = ls.find(s => s.meta.id === id);
        if (!script) return;

        const act = btn.dataset.act;
        if (act === 'run') runScript(script);
        else if (act === 'edit') openEditor(script);
        else if (act === 'export') promptExport(script);
        else if (act === 'delete') {
            if (confirm(`删除脚本 "${script.meta.name}" ?`)) {
                await deleteScript(id);
                renderList();
            }
        }
    });

    panelEl.querySelector('.webchat-script-panel-footer').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'record') startRecording();
        else if (act === 'ai') openAIGenerator();
        else if (act === 'manual') openEditor(blankScript());
        else if (act === 'import') openImport();
    });
}

function blankScript() {
    return {
        meta: {
            id: 'script_' + Date.now(),
            name: '新脚本',
            description: '',
            version: '1.0',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            source: 'manual',
            targetUrl: location.href
        },
        variables: {},
        steps: []
    };
}

// ====== 录制视图 ======

function startRecording() {
    currentView = 'record';
    recorder = new Recorder({
        onChange: (steps) => updateRecordingBarCount(steps)
    });
    recorder.start();
    // 隐藏主面板，避免影响录制；改用顶部悬浮控制条
    if (panelEl) panelEl.classList.add('webchat-script-panel-hidden');
    showRecordingBar();
}

function ensureRecordingBar() {
    if (recordingBarEl) return recordingBarEl;
    const bar = document.createElement('div');
    bar.id = 'webchat-script-recording-bar';
    bar.innerHTML = `
        <div class="webchat-rec-bar-drag" title="拖动">⋮⋮</div>
        <span class="webchat-rec-bar-dot"></span>
        <span class="webchat-rec-bar-label">录制中</span>
        <span class="webchat-rec-bar-count" data-count>0 步</span>
        <button data-act="pause" class="webchat-rec-bar-btn">暂停</button>
        <button data-act="stop" class="webchat-rec-bar-btn webchat-rec-bar-btn-primary">停止并保存</button>
        <button data-act="cancel" class="webchat-rec-bar-btn webchat-rec-bar-btn-danger">取消</button>
    `;
    document.body.appendChild(bar);

    // 拖动
    const handle = bar.querySelector('.webchat-rec-bar-drag');
    let dragging = false, dx = 0, dy = 0;
    handle.addEventListener('mousedown', (e) => {
        dragging = true;
        const r = bar.getBoundingClientRect();
        dx = e.clientX - r.left;
        dy = e.clientY - r.top;
        bar.style.transition = 'none';
        e.preventDefault();
        e.stopPropagation();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        bar.style.left = (e.clientX - dx) + 'px';
        bar.style.top = (e.clientY - dy) + 'px';
        bar.style.right = 'auto';
        bar.style.transform = 'none';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    bar.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'pause') {
            if (recorder.paused) { recorder.resume(); btn.textContent = '暂停'; }
            else { recorder.pause(); btn.textContent = '继续'; }
        } else if (act === 'stop') {
            recorder.stop();
            hideRecordingBar();
            if (panelEl) panelEl.classList.remove('webchat-script-panel-hidden');
            const name = prompt('脚本名称：', '录制脚本 ' + new Date().toLocaleTimeString());
            if (!name) return renderList();
            const script = recorder.getScript({ name });
            await upsertScript(script);
            renderList();
        } else if (act === 'cancel') {
            recorder.stop();
            hideRecordingBar();
            if (panelEl) panelEl.classList.remove('webchat-script-panel-hidden');
            renderList();
        }
    });

    recordingBarEl = bar;
    return bar;
}

function showRecordingBar() {
    const bar = ensureRecordingBar();
    bar.classList.add('webchat-rec-bar-open');
    updateRecordingBarCount(recorder?.steps || []);
}

function hideRecordingBar() {
    if (recordingBarEl) recordingBarEl.classList.remove('webchat-rec-bar-open');
}

function updateRecordingBarCount(steps) {
    const el = recordingBarEl?.querySelector('[data-count]');
    if (el) el.textContent = `${steps.length} 步`;
}

// ====== 脚本编辑器 ======

function openEditor(script) {
    currentView = 'edit';
    currentScript = JSON.parse(JSON.stringify(script));
    renderEditor();
}

function renderEditor() {
    const s = currentScript;
    setBody(`
        <div class="webchat-script-editor">
            <div class="webchat-script-meta">
                <label>名称 <input type="text" data-field="name" value="${escapeAttr(s.meta.name)}"></label>
                <label>描述 <input type="text" data-field="description" value="${escapeAttr(s.meta.description || '')}"></label>
            </div>
            <div class="webchat-script-vars">
                <div class="webchat-script-section-title">变量</div>
                <div class="webchat-script-vars-list"></div>
                <button data-act="add-var" class="webchat-script-btn webchat-script-btn-small">+ 添加变量</button>
            </div>
            <div class="webchat-script-steps">
                <div class="webchat-script-section-title">步骤 (${s.steps.length})</div>
                <ol class="webchat-script-steps-list" data-list></ol>
                <button data-act="add-step" class="webchat-script-btn webchat-script-btn-small">+ 添加步骤</button>
            </div>
        </div>
    `);
    setFooter(`
        <button data-act="run" class="webchat-script-btn webchat-script-btn-primary">▶ 运行</button>
        <button data-act="save" class="webchat-script-btn webchat-script-btn-primary">保存</button>
        <button data-act="export-json" class="webchat-script-btn">导出 JSON</button>
    `);
    renderVarsList();
    renderStepsList();
    bindEditor();
}

function bindEditor() {
    const body = panelEl.querySelector('.webchat-script-panel-body');
    body.addEventListener('input', (e) => {
        const t = e.target.dataset.field;
        if (t && (t === 'name' || t === 'description')) {
            currentScript.meta[t] = e.target.value;
        }
    });
    body.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'add-var') {
            const name = prompt('变量名：');
            if (!name) return;
            currentScript.variables[name] = '';
            renderVarsList();
        } else if (act === 'remove-var') {
            const name = btn.dataset.name;
            delete currentScript.variables[name];
            renderVarsList();
        } else if (act === 'add-step') {
            addStepDialog();
        } else if (act === 'edit-step') {
            editStepDialog(Number(btn.dataset.idx));
        } else if (act === 'remove-step') {
            currentScript.steps.splice(Number(btn.dataset.idx), 1);
            renderStepsList();
        } else if (act === 'move-up') {
            const i = Number(btn.dataset.idx);
            if (i > 0) {
                [currentScript.steps[i - 1], currentScript.steps[i]] = [currentScript.steps[i], currentScript.steps[i - 1]];
                renderStepsList();
            }
        } else if (act === 'move-down') {
            const i = Number(btn.dataset.idx);
            if (i < currentScript.steps.length - 1) {
                [currentScript.steps[i + 1], currentScript.steps[i]] = [currentScript.steps[i], currentScript.steps[i + 1]];
                renderStepsList();
            }
        } else if (act === 'pick-element') {
            const idx = Number(btn.dataset.idx);
            pickElementForStep(idx);
        }
    });

    panelEl.querySelector('.webchat-script-panel-footer').addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'save') {
            await upsertScript(currentScript);
            alert('已保存');
            renderList();
        } else if (act === 'run') {
            await upsertScript(currentScript);
            runScript(currentScript);
        } else if (act === 'export-json') {
            promptExport(currentScript);
        }
    });
}

function renderVarsList() {
    // 用 clone 替换内层容器，丢掉上一次 render 时挂的 input 监听
    const old = panelEl.querySelector('.webchat-script-vars-list');
    if (!old) return;
    const wrap = old.cloneNode(false);
    old.replaceWith(wrap);

    const vars = currentScript.variables || {};
    wrap.innerHTML = Object.keys(vars).map(name => `
        <div class="webchat-script-var-row">
            <span class="webchat-script-var-name">${escapeHtml(name)}</span>
            <input type="text" data-var="${escapeAttr(name)}" value="${escapeAttr(vars[name] ?? '')}">
            <button data-act="remove-var" data-name="${escapeAttr(name)}" class="webchat-script-btn webchat-script-btn-small webchat-script-btn-danger">删</button>
        </div>
    `).join('') || '<div class="webchat-script-hint">暂无变量</div>';

    wrap.addEventListener('input', (e) => {
        const k = e.target.dataset.var;
        if (k != null) currentScript.variables[k] = e.target.value;
    });
}

function renderStepsList() {
    const list = panelEl.querySelector('[data-list]');
    list.innerHTML = currentScript.steps.map((s, i) => {
        const tCount = Array.isArray(s.params?.targets) ? s.params.targets.length : 0;
        const badge = tCount > 0
            ? `<span class="webchat-script-step-locators" title="${tCount} 条候选 locator">${tCount}</span>`
            : '';
        return `
        <li class="webchat-script-step" data-idx="${i}">
            <div class="webchat-script-step-head">
                <span class="webchat-script-step-type">${stepIcon(s.type)} ${s.type}</span>
                ${badge}
                <span class="webchat-script-step-desc">${escapeHtml(s.description || '')}</span>
            </div>
            <div class="webchat-script-step-body">
                <code>${escapeHtml(stepSummary(s))}</code>
            </div>
            <div class="webchat-script-step-actions">
                <button data-act="move-up" data-idx="${i}" class="webchat-script-btn webchat-script-btn-small">↑</button>
                <button data-act="move-down" data-idx="${i}" class="webchat-script-btn webchat-script-btn-small">↓</button>
                <button data-act="edit-step" data-idx="${i}" class="webchat-script-btn webchat-script-btn-small">编辑</button>
                <button data-act="remove-step" data-idx="${i}" class="webchat-script-btn webchat-script-btn-small webchat-script-btn-danger">删</button>
            </div>
        </li>`;
    }).join('') || '<li class="webchat-script-empty">暂无步骤</li>';
    const title = panelEl.querySelector('.webchat-script-steps .webchat-script-section-title');
    if (title) title.textContent = `步骤 (${currentScript.steps.length})`;
}

function stepSummary(s) {
    const p = s.params || {};
    if (p.selector) return `${p.selector}${p.value !== undefined ? ' = ' + JSON.stringify(p.value) : ''}`;
    if (p.url) return p.url;
    if (p.duration != null) return `等待 ${p.duration}ms`;
    if (p.message) return p.message;
    return JSON.stringify(p);
}

function stepIcon(type) {
    const map = {
        click: '👆', dblclick: '👆👆', input: '⌨️', type: '⌨️', select: '📋',
        checkbox: '☑️', scroll: '⬇️', hover: '🖱️', wait: '⏳', waitTime: '⏱️',
        navigate: '🌐', reload: '🔄', back: '⬅️', forward: '➡️',
        keypress: '🔤', hotkey: '⚡', drag: '✋', upload: '📤', screenshot: '📷',
        extract: '📥', extractList: '📋', extractTable: '📊',
        condition: '🔀', loop: '🔁', assert: '✓', setVariable: '📝', log: '📝',
        aiRead: '🤖', aiDecide: '🤖', aiLocate: '🤖'
    };
    return map[type] || '•';
}

// ====== 步骤编辑对话框 ======

function addStepDialog() { editStepDialog(-1); }

function editStepDialog(idx) {
    const isNew = idx < 0;
    const step = isNew
        ? { id: 'step_' + Date.now(), type: 'click', description: '', params: {}, options: {} }
        : JSON.parse(JSON.stringify(currentScript.steps[idx]));

    const dialog = document.createElement('div');
    dialog.className = 'webchat-script-modal';
    dialog.innerHTML = `
        <div class="webchat-script-modal-inner">
            <div class="webchat-script-modal-header">
                <span>${isNew ? '添加步骤' : '编辑步骤'}</span>
                <button data-act="close" class="webchat-script-btn webchat-script-btn-icon">×</button>
            </div>
            <div class="webchat-script-modal-body">
                <label>动作类型
                    <select data-field="type">
                        ${ACTION_TYPES.map(t => `<option value="${t}" ${step.type === t ? 'selected' : ''}>${t}</option>`).join('')}
                    </select>
                </label>
                <label>描述 <input type="text" data-field="description" value="${escapeAttr(step.description || '')}"></label>
                <div class="webchat-script-params" data-params></div>
                <details>
                    <summary>高级 (JSON)</summary>
                    <textarea data-field="raw" rows="8">${escapeAttr(JSON.stringify(step, null, 2))}</textarea>
                </details>
            </div>
            <div class="webchat-script-modal-footer">
                <button data-act="save" class="webchat-script-btn webchat-script-btn-primary">保存</button>
                <button data-act="close" class="webchat-script-btn">取消</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);

    const paramsBox = dialog.querySelector('[data-params]');
    renderStepParams(paramsBox, step);

    dialog.querySelector('[data-field="type"]').addEventListener('change', (e) => {
        step.type = e.target.value;
        renderStepParams(paramsBox, step);
        dialog.querySelector('[data-field="raw"]').value = JSON.stringify(step, null, 2);
    });

    paramsBox.addEventListener('input', (e) => {
        const k = e.target.dataset.param;
        if (!k) return;
        let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        if (e.target.dataset.parse === 'number') v = Number(v);
        step.params[k] = v;
        dialog.querySelector('[data-field="raw"]').value = JSON.stringify(step, null, 2);
    });

    paramsBox.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn || btn.dataset.act !== 'pick') return;
        startElementPicker(({ selector, fallbacks, targets, element }) => {
            if (!selector) return;
            step.params.selector = selector;
            step.params.selectorFallbacks = fallbacks;
            if (Array.isArray(targets)) step.params.targets = targets;
            const hp = buildHitPointForElement(element);
            if (hp) step.params.hitPoint = hp;
            renderStepParams(paramsBox, step);
            dialog.querySelector('[data-field="raw"]').value = JSON.stringify(step, null, 2);
        });
    });

    dialog.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'close') dialog.remove();
        else if (act === 'save') {
            try {
                const raw = dialog.querySelector('[data-field="raw"]').value;
                const parsed = JSON.parse(raw);
                parsed.description = dialog.querySelector('[data-field="description"]').value;
                parsed.id = parsed.id || step.id;
                if (isNew) currentScript.steps.push(parsed);
                else currentScript.steps[idx] = parsed;
                dialog.remove();
                renderStepsList();
            } catch (err) {
                alert('保存失败：' + err.message);
            }
        }
    });
}

const ACTION_TYPES = [
    'click', 'dblclick', 'input', 'type', 'select', 'checkbox', 'scroll', 'hover',
    'wait', 'waitTime', 'navigate', 'reload', 'back', 'forward',
    'keypress', 'hotkey', 'drag', 'screenshot',
    'extract', 'extractList', 'extractTable',
    'condition', 'loop', 'assert', 'setVariable', 'log',
    'aiRead', 'aiLocate'
];

function renderStepParams(box, step) {
    const t = step.type;
    const p = step.params || (step.params = {});
    const fields = paramFields(t);
    box.innerHTML = fields.map(f => {
        const val = p[f.key] ?? f.defaultValue ?? '';
        if (f.type === 'checkbox') {
            return `<label class="webchat-script-row"><input type="checkbox" data-param="${f.key}" ${val ? 'checked' : ''}> ${f.label}</label>`;
        }
        const inputAttr = f.parse === 'number' ? 'data-parse="number" type="number"' : 'type="text"';
        const pickBtn = f.key === 'selector' ? `<button class="webchat-script-btn webchat-script-btn-small" data-act="pick">🎯</button>` : '';
        return `<label class="webchat-script-row">${f.label}
            <div class="webchat-script-input-wrap">
                <input ${inputAttr} data-param="${f.key}" value="${escapeAttr(typeof val === 'object' ? JSON.stringify(val) : val)}">
                ${pickBtn}
            </div>
        </label>`;
    }).join('') || '<div class="webchat-script-hint">该动作无参数</div>';
}

function paramFields(type) {
    const SEL = { key: 'selector', label: '选择器' };
    const VAL = { key: 'value', label: '值' };
    switch (type) {
        case 'click': case 'dblclick': case 'hover': return [SEL];
        case 'input': return [SEL, VAL, { key: 'clearBefore', label: '清空原有', type: 'checkbox', defaultValue: true }];
        case 'type': return [SEL, { key: 'text', label: '文本' }, { key: 'delay', label: '每字延迟(ms)', parse: 'number', defaultValue: 50 }];
        case 'select': return [SEL, VAL];
        case 'checkbox': return [SEL, { key: 'checked', label: '勾选', type: 'checkbox' }];
        case 'scroll': return [{ key: 'selector', label: '选择器(可空)' }, { key: 'x', label: 'X', parse: 'number' }, { key: 'y', label: 'Y', parse: 'number' }];
        case 'wait': return [SEL, { key: 'state', label: '状态(visible/hidden)' }];
        case 'waitTime': return [{ key: 'duration', label: '等待时长(ms)', parse: 'number', defaultValue: 1000 }];
        case 'navigate': return [{ key: 'url', label: 'URL' }];
        case 'keypress': return [{ key: 'key', label: '按键' }];
        case 'hotkey': return [{ key: 'keys', label: '按键(JSON 数组，如 ["Ctrl","A"])' }];
        case 'drag': return [{ key: 'sourceSelector', label: '源选择器' }, { key: 'targetSelector', label: '目标选择器' }];
        case 'screenshot': return [{ key: 'selector', label: '选择器(可空)' }, { key: 'fullPage', label: '整页', type: 'checkbox' }];
        case 'extract': return [SEL, { key: 'attribute', label: '属性(text/html/value/...)' }, { key: 'saveTo', label: '保存到变量' }];
        case 'extractList': return [SEL, { key: 'fields', label: '字段(JSON)' }, { key: 'saveTo', label: '保存到变量' }];
        case 'extractTable': return [SEL, { key: 'headers', label: '首行为表头', type: 'checkbox', defaultValue: true }, { key: 'saveTo', label: '保存到变量' }];
        case 'assert': return [SEL, { key: 'condition', label: '条件(elementVisible/textEquals/...)' }, { key: 'expected', label: '期望值' }, { key: 'message', label: '失败信息' }];
        case 'setVariable': return [{ key: 'name', label: '变量名' }, VAL];
        case 'log': return [{ key: 'message', label: '消息' }, { key: 'level', label: '级别(info/warn/error)' }];
        case 'condition': return [{ key: 'if', label: '条件表达式' }, { key: 'then', label: 'then 步骤(JSON)' }, { key: 'else', label: 'else 步骤(JSON)' }];
        case 'loop': return [{ key: 'type', label: '类型(count/forEach/while)' }, { key: 'count', label: '次数', parse: 'number' }, { key: 'items', label: 'items 变量名/数组' }, { key: 'steps', label: '子步骤(JSON)' }];
        case 'aiRead': return [{ key: 'selector', label: '选择器(可空)' }, { key: 'prompt', label: '提示词' }, { key: 'saveTo', label: '保存到变量' }];
        case 'aiLocate': return [{ key: 'description', label: '元素描述' }, { key: 'action', label: '动作(click/...)' }];
        default: return [];
    }
}

// ====== 元素选取 ======

function startElementPicker(cb) {
    const restoreScriptUi = hideScriptUiForPicking({ panelEl });
    ElementPicker.start((res) => {
        restoreScriptUi();
        cb(res || {});
    });
}

function pickElementForStep(idx) {
    startElementPicker((res) => {
        if (!res || !res.selector) return;
        const step = currentScript.steps[idx];
        step.params = step.params || {};
        step.params.selector = res.selector;
        step.params.selectorFallbacks = res.fallbacks;
        if (Array.isArray(res.targets)) step.params.targets = res.targets;
        const hp = buildHitPointForElement(res.element);
        if (hp) step.params.hitPoint = hp;
        renderStepsList();
    });
}

// ====== AI 生成 ======

function openAIGenerator() {
    currentView = 'ai';
    setBody(`
        <div class="webchat-script-ai">
            <div class="webchat-script-section-title">AI 脚本生成</div>
            <div class="webchat-script-hint">用自然语言描述你想自动化的操作，AI 将基于当前页面结构生成脚本。</div>
            <textarea data-field="prompt" rows="6" placeholder="例如：填写用户名 admin、密码 123456，然后点击登录按钮"></textarea>
            <div class="webchat-script-ai-progress is-empty" data-progress></div>
            <pre class="webchat-script-ai-stream is-empty" data-stream></pre>
        </div>
    `);
    setFooter(`
        <button data-act="generate" class="webchat-script-btn webchat-script-btn-primary">生成脚本</button>
    `);
    panelEl.querySelector('.webchat-script-panel-footer').addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (btn?.dataset.act === 'generate') await runAIGeneration(btn);
    });
}

// 阶段进度 UI：把"扫描元素 → 调用模型 → 解析结果"分阶段反馈
// 关键点：
//   1. 点按钮立即把 UI 切到"已开始"状态，下一帧才开始重活，避免点击瞬间冻屏
//   2. 扫描阶段是真实进度（异步分批），模型阶段是不定长 indeterminate 动画
//   3. 计时器用 setInterval 每 200ms 更新一次"已用时"，结束后清掉
function createAIProgress(rootEl) {
    rootEl.classList.remove('is-empty');
    rootEl.innerHTML = `
        <div class="webchat-script-ai-prog-row">
            <span class="webchat-script-ai-prog-stage" data-stage>准备中...</span>
            <span class="webchat-script-ai-prog-time" data-time>0.0s</span>
        </div>
        <div class="webchat-script-ai-prog-bar"><div class="webchat-script-ai-prog-bar-fill" data-fill></div></div>
    `;
    const stageEl = rootEl.querySelector('[data-stage]');
    const timeEl = rootEl.querySelector('[data-time]');
    const fillEl = rootEl.querySelector('[data-fill]');
    const start = Date.now();
    const tick = () => { timeEl.textContent = ((Date.now() - start) / 1000).toFixed(1) + 's'; };
    const timer = setInterval(tick, 200);
    return {
        setStage(text, { indeterminate = false } = {}) {
            stageEl.textContent = text;
            stageEl.classList.remove('is-error', 'is-done');
            if (indeterminate) fillEl.classList.add('is-indeterminate');
            else fillEl.classList.remove('is-indeterminate');
        },
        setPercent(p) {
            fillEl.classList.remove('is-indeterminate');
            fillEl.style.width = Math.max(0, Math.min(100, p)) + '%';
        },
        done(text) {
            stageEl.textContent = text;
            stageEl.classList.add('is-done');
            fillEl.classList.remove('is-indeterminate');
            fillEl.classList.add('is-done');
            clearInterval(timer);
            tick();
        },
        fail(text) {
            stageEl.textContent = text;
            stageEl.classList.add('is-error');
            fillEl.classList.remove('is-indeterminate');
            fillEl.classList.add('is-error');
            clearInterval(timer);
            tick();
        }
    };
}

async function runAIGeneration(btn) {
    const promptEl = panelEl.querySelector('[data-field="prompt"]');
    const prompt = promptEl.value.trim();
    if (!prompt) return alert('请填写描述');
    const progressEl = panelEl.querySelector('[data-progress]');
    const streamEl = panelEl.querySelector('[data-stream]');

    // 1) 同步切到"已开始"状态、按钮禁用，避免重复点击
    if (btn) { btn.disabled = true; btn.textContent = '生成中...'; }
    promptEl.disabled = true;
    streamEl.classList.add('is-empty');
    streamEl.textContent = '';
    const prog = createAIProgress(progressEl);
    prog.setStage('扫描页面元素...');
    prog.setPercent(2);
    // 2) 让浏览器先把这帧画出来，再开始重活
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    let elements = [];
    try {
        elements = await ExecutorUtils.collectInteractiveElementsAsync({
            onProgress: ({ scanned, total, kept }) => {
                if (!total) return;
                const ratio = Math.min(1, scanned / total);
                prog.setPercent(2 + Math.round(ratio * 48));
                prog.setStage(`扫描页面元素 ${scanned}/${total}（已收集 ${kept}）`);
            }
        });
    } catch (err) {
        prog.fail('扫描失败：' + err.message);
        if (btn) { btn.disabled = false; btn.textContent = '生成脚本'; }
        promptEl.disabled = false;
        return;
    }

    prog.setStage(`AI 思考中（基于 ${elements.length} 个元素）`, { indeterminate: true });
    streamEl.classList.remove('is-empty');

    // 3) 通过 port 拿流式输出
    let port;
    try {
        port = chrome.runtime.connect({ name: 'scriptGenerateStream' });
    } catch (err) {
        prog.fail('无法连接 background：' + err.message);
        if (btn) { btn.disabled = false; btn.textContent = '生成脚本'; }
        promptEl.disabled = false;
        return;
    }

    const finish = (resetUI) => {
        try { port.disconnect(); } catch {}
        if (resetUI) {
            if (btn) { btn.disabled = false; btn.textContent = '生成脚本'; }
            promptEl.disabled = false;
        }
    };

    let totalChars = 0;
    let finished = false;
    port.onMessage.addListener(async (msg) => {
        if (msg.type === 'ping') {
            return; // 心跳，仅用于保活 service worker
        }
        if (msg.type === 'stream-start') {
            prog.setStage('AI 正在生成脚本...', { indeterminate: true });
        } else if (msg.type === 'chunk') {
            totalChars = msg.accumulated?.length ?? (totalChars + (msg.content?.length || 0));
            // 显示原文（含 ```json 包裹），用 textContent 避免任何 HTML 注入
            streamEl.textContent = msg.accumulated || (streamEl.textContent + (msg.content || ''));
            streamEl.scrollTop = streamEl.scrollHeight;
            prog.setStage(`AI 正在生成脚本 (${totalChars} 字)`, { indeterminate: true });
        } else if (msg.type === 'done') {
            finished = true;
            const script = msg.script;
            script.meta = {
                ...blankScript().meta,
                ...script.meta,
                source: 'ai',
                name: script.meta?.name || ('AI 脚本 ' + new Date().toLocaleTimeString())
            };
            currentScript = script;
            try { await upsertScript(script); } catch (e) { /* fallthrough */ }
            prog.setPercent(100);
            prog.done(`生成成功，共 ${script.steps?.length || 0} 步`);
            finish(false);
            setTimeout(() => openEditor(script), 400);
        } else if (msg.type === 'error') {
            finished = true;
            // 失败时把已积累的原文展示出来便于排错
            if (msg.raw) {
                streamEl.textContent = msg.raw;
                streamEl.scrollTop = streamEl.scrollHeight;
            }
            prog.fail('生成失败：' + msg.error);
            finish(true);
        }
    });

    port.onDisconnect.addListener(() => {
        if (finished) return;
        const lastErr = chrome.runtime.lastError?.message;
        prog.fail('连接已断开' + (lastErr ? '：' + lastErr : ''));
        finish(true);
    });

    port.postMessage({
        action: 'generateScript',
        prompt,
        pageInfo: {
            url: location.href,
            title: document.title,
            elements
        }
    });
}

// ====== 运行 ======

async function runScript(script) {
    currentView = 'run';
    currentScript = script;
    const savedDelay = Number(localStorage.getItem('webchat_script_step_delay'));
    const initialDelay = Number.isFinite(savedDelay) && savedDelay >= 0 ? savedDelay : 600;
    const initialHighlight = localStorage.getItem('webchat_script_highlight') !== '0';
    setBody(`
        <div class="webchat-script-run">
            <div class="webchat-script-section-title">运行 ${escapeHtml(script.meta.name)}</div>
            <div class="webchat-script-run-controls">
                <label>步骤间隔(ms)
                    <input type="number" min="0" step="100" data-step-delay value="${initialDelay}" class="webchat-script-input" style="width:80px;margin-left:6px"/>
                </label>
                <label style="margin-left:12px">
                    <input type="checkbox" data-highlight ${initialHighlight ? 'checked' : ''}/>
                    高亮当前元素
                </label>
            </div>
            <ul class="webchat-script-run-log" data-log></ul>
        </div>
    `);
    setFooter(`
        <button data-act="abort" class="webchat-script-btn webchat-script-btn-danger">中止</button>
        <button data-act="back-list" class="webchat-script-btn">返回</button>
    `);

    const logEl = panelEl.querySelector('[data-log]');
    const log = (msg, cls = '') => {
        const li = document.createElement('li');
        li.className = cls;
        li.textContent = msg;
        logEl.appendChild(li);
        logEl.scrollTop = logEl.scrollHeight;
    };

    const delayInput = panelEl.querySelector('[data-step-delay]');
    const highlightInput = panelEl.querySelector('[data-highlight]');
    delayInput.addEventListener('change', () => {
        const v = Math.max(0, Number(delayInput.value) || 0);
        localStorage.setItem('webchat_script_step_delay', String(v));
        if (executor) executor.stepDelay = v;
    });
    highlightInput.addEventListener('change', () => {
        localStorage.setItem('webchat_script_highlight', highlightInput.checked ? '1' : '0');
        if (executor) executor.highlight = highlightInput.checked;
    });

    executor = new ScriptExecutor({
        stepDelay: initialDelay,
        highlight: initialHighlight,
        onBeforeStep: (step) => log(`▶ ${step.type}：${step.description || ''}`),
        onAfterStep: (step, res) => {
            if (res.ok) log(`  ✓ 完成`, 'ok');
            else log(`  ✗ 失败：${res.error}`, 'err');
        },
        onError: (step, err) => log(`  ✗ 错误：${err.message}`, 'err'),
        onLog: (info) => log(`  ${info.message || ''}`, info.level === 'error' ? 'err' : '')
    });

    panelEl.querySelector('.webchat-script-panel-footer').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.act === 'abort') executor?.abort();
        if (btn.dataset.act === 'back-list') renderList();
    });

    try {
        await executor.execute(script);
        log('--- 脚本执行完成 ---', 'ok');
    } catch (err) {
        log('--- 脚本中断：' + err.message + ' ---', 'err');
    }
}

// ====== 导入/导出 ======

function promptExport(script) {
    const choice = confirm('选择"确定"导出 JSON，"取消"导出可独立运行的 JS');
    const fmt = choice ? 'json' : 'js';
    exportToFile(script, fmt).then(
        () => alert('已发起下载'),
        (e) => alert('导出失败：' + e.message)
    );
}

function openImport() {
    const dialog = document.createElement('div');
    dialog.className = 'webchat-script-modal';
    dialog.innerHTML = `
        <div class="webchat-script-modal-inner">
            <div class="webchat-script-modal-header">
                <span>导入脚本</span>
                <button data-act="close" class="webchat-script-btn webchat-script-btn-icon">×</button>
            </div>
            <div class="webchat-script-modal-body">
                <textarea data-field="raw" rows="14" placeholder="粘贴脚本 JSON"></textarea>
            </div>
            <div class="webchat-script-modal-footer">
                <button data-act="import" class="webchat-script-btn webchat-script-btn-primary">导入</button>
                <button data-act="close" class="webchat-script-btn">取消</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
    dialog.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.act === 'close') dialog.remove();
        else if (btn.dataset.act === 'import') {
            try {
                const raw = dialog.querySelector('[data-field="raw"]').value;
                const obj = importFromText(raw);
                obj.meta = { ...blankScript().meta, ...obj.meta, id: 'script_' + Date.now() };
                await upsertScript(obj);
                dialog.remove();
                renderList();
            } catch (err) {
                alert('导入失败：' + err.message);
            }
        }
    });
}

// ====== 工具 ======

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }
function formatDate(s) {
    if (!s) return '';
    try { return new Date(s).toLocaleString(); } catch { return s; }
}

export { openPanel, closePanel };
export default { open: openPanel, close: closePanel };
