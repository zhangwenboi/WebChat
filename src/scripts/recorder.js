// 操作录制器（P0 升级）
// - 仿 selenium-ide 状态机：typeLock / preventClick / preventClickTwice / preventType / enterTarget / focus / tabCheck
// - 每一步存 target 数组：[[locator, builderName], ...]，回放端按顺序兜底
// - 兼容旧字段：同时写 selector + selectorFallbacks，旧脚本旧执行器都能跑
// - isTrusted 过滤：屏蔽脚本注入事件（如执行器自己 dispatch 的 click），避免自录
import LB, { buildAll, isWebChatElement } from './locator-builders.js';

const INPUT_TYPES = [
    'text', 'password', 'file', 'datetime', 'datetime-local', 'date',
    'month', 'time', 'week', 'number', 'range', 'email', 'url',
    'search', 'tel', 'color'
];

function nowId() {
    return 'step_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
}

// 把 [[locator, builderName], ...] 拆成给执行器用的 selector + selectorFallbacks
// 优先把"最像 CSS 选择器"的放主 selector，剩下的全部填进 fallbacks（包含 xpath= 前缀的项）
function targetsToLegacyPair(targets) {
    if (!Array.isArray(targets) || !targets.length) return { selector: null, selectorFallbacks: [] };
    const toLegacy = (loc) => {
        // id=foo -> #foo
        let m = loc.match(/^id=(.+)$/);
        if (m) {
            const id = m[1];
            if (/^[A-Za-z_][\w-]*$/.test(id)) return '#' + id;
            return `[id="${id.replace(/"/g, '\\"')}"]`;
        }
        // name=bar -> [name="bar"]
        m = loc.match(/^name=(.+)$/);
        if (m) return `[name="${m[1].replace(/"/g, '\\"')}"]`;
        // css=...  -> 去前缀
        m = loc.match(/^css(?::[^=]+)?=([\s\S]+)$/);
        if (m) return m[1];
        // xpath=...  -> 保留 xpath= 让 query() 走 evaluate
        m = loc.match(/^xpath(?::[^=]+)?=([\s\S]+)$/);
        if (m) return 'xpath=' + m[1];
        // linkText=...  -> 保留原值
        return loc;
    };
    const all = targets.map(([loc]) => toLegacy(loc));
    const seen = new Set();
    const dedup = [];
    for (const s of all) {
        if (s && !seen.has(s)) { seen.add(s); dedup.push(s); }
    }
    // 主 selector 取第一个 CSS 类（非 xpath= 开头）
    const cssIdx = dedup.findIndex(s => !s.startsWith('xpath=') && !s.startsWith('linkText='));
    const mainIdx = cssIdx >= 0 ? cssIdx : 0;
    const selector = dedup[mainIdx];
    const fallbacks = dedup.filter((_, i) => i !== mainIdx);
    return { selector, selectorFallbacks: fallbacks };
}

// 给步骤同时写 targets 和 selector/selectorFallbacks
function attachLocators(stepParams, el) {
    const targets = buildAll(el);
    const legacy = targetsToLegacyPair(targets);
    stepParams.targets = targets;                // 新字段（首选）
    stepParams.selector = legacy.selector;       // 旧字段（兼容）
    stepParams.selectorFallbacks = legacy.selectorFallbacks;
    return stepParams;
}

// 采集"点击的命中点"+ 当时的 viewport / 滚动位置 / 元素几何，作为坐标兜底依据。
// 回放时若 selector / targets 全部找不到元素，executor 会用这些信息做 elementFromPoint 命中。
// 关键设计：
//   - 存元素相对自身的命中比例 (rx, ry)，对元素尺寸变化更鲁棒
//   - 同时存录制时元素的视口绝对坐标 (vx, vy)，用于"页面布局没动"时的快路径
//   - 存元素 tag/role/text 摘要，命中后做语义校验，避免点到浮层挡住的别的元素
function attachHitPoint(stepParams, el, event) {
    if (!el || el.nodeType !== 1) return stepParams;
    let rect;
    try { rect = el.getBoundingClientRect(); } catch { return stepParams; }
    if (!rect || rect.width === 0 && rect.height === 0) return stepParams;

    const ev = event || {};
    let cx = typeof ev.clientX === 'number' ? ev.clientX : null;
    let cy = typeof ev.clientY === 'number' ? ev.clientY : null;
    // 没有事件坐标（来自 picker / 程序化触发）就用元素中心点
    if (cx === null || cy === null) {
        cx = rect.left + rect.width / 2;
        cy = rect.top + rect.height / 2;
    }
    // 命中点在元素内的相对比例，clamp 到 [0,1]，避免越界
    const rx = rect.width > 0 ? Math.max(0, Math.min(1, (cx - rect.left) / rect.width)) : 0.5;
    const ry = rect.height > 0 ? Math.max(0, Math.min(1, (cy - rect.top) / rect.height)) : 0.5;

    const tagName = el.tagName ? el.tagName.toLowerCase() : '';
    stepParams.hitPoint = {
        rx: Number(rx.toFixed(4)),
        ry: Number(ry.toFixed(4)),
        vx: Math.round(cx),    // 视口坐标
        vy: Math.round(cy),
        rect: {                // 录制时元素的几何（视口坐标系）
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
        // 语义校验依据
        sig: {
            tag: tagName,
            role: el.getAttribute?.('role') || '',
            type: el.getAttribute?.('type') || '',
            text: shortLabel(el, 60)
        }
    };
    return stepParams;
}

function shortLabel(el, maxLen = 30) {
    const text = (el.textContent || el.value || el.placeholder || el.getAttribute?.('aria-label') || '')
        .replace(/\s+/g, ' ').trim();
    return text.slice(0, maxLen);
}

export class Recorder {
    constructor(opts = {}) {
        this.steps = [];
        this.recording = false;
        this.paused = false;
        this.onChange = opts.onChange || (() => { });
        this.handlers = {};
        this.scrollTimer = null;
        this.lastScrollAt = 0;

        // selenium-ide 风格状态机
        this.state = {
            typeTarget: null,
            typeLock: 0,
            focusTarget: null,
            focusValue: null,
            tempValue: null,
            preventType: false,
            preventClick: false,
            preventClickTwice: false,
            enterTarget: null,
            enterValue: null,
            tabCheck: null,
            lastInputStep: null,
            lastInputAt: 0
        };
    }

    start() {
        if (this.recording) return;
        this.steps = [];
        this.recording = true;
        this.paused = false;

        const bind = (k, fn, capture = true) => {
            this.handlers[k] = (e) => fn.call(this, e);
            if (k === 'scroll') window.addEventListener('scroll', this.handlers[k], capture);
            else document.addEventListener(k, this.handlers[k], capture);
        };
        bind('click', this._onClick);
        bind('dblclick', this._onDblClick);
        bind('input', this._onInput);
        bind('change', this._onChange);
        bind('keydown', this._onKeyDown);
        bind('focus', this._onFocus);
        bind('blur', this._onBlur);
        bind('submit', this._onSubmit);
        bind('scroll', this._onScroll);

        this._addStep({
            type: 'navigate',
            description: '当前页面',
            params: { url: location.href },
            options: { waitUntil: 'domcontentloaded', timeout: 10000 }
        });
    }

    stop() {
        if (!this.recording) return this.steps;
        this.recording = false;
        for (const k of Object.keys(this.handlers)) {
            if (k === 'scroll') window.removeEventListener('scroll', this.handlers[k], true);
            else document.removeEventListener(k, this.handlers[k], true);
        }
        this.handlers = {};
        return this.steps;
    }

    pause() { this.paused = true; }
    resume() { this.paused = false; }

    _ignored(target, event) {
        if (!target || target.nodeType !== 1) return true;
        if (event && event.isTrusted === false) return true; // 屏蔽脚本注入事件
        if (isWebChatElement(target)) return true;
        return false;
    }

    _addStep(step) {
        step.id = step.id || nowId();
        this.steps.push(step);
        this.onChange(this.steps.slice());
    }

    _replaceLast(step) {
        if (!this.steps.length) return this._addStep(step);
        step.id = step.id || this.steps[this.steps.length - 1].id || nowId();
        this.steps[this.steps.length - 1] = step;
        this.onChange(this.steps.slice());
    }

    // ---------- focus / blur ----------
    _onFocus(event) {
        const t = event.target;
        if (!t || t.nodeType !== 1) return;
        const tag = t.tagName ? t.tagName.toLowerCase() : '';
        if (tag !== 'input' && tag !== 'textarea' && t.isContentEditable !== true) return;
        this.state.focusTarget = t;
        this.state.focusValue = t.value || '';
        this.state.tempValue = this.state.focusValue;
        this.state.preventType = false;
    }

    _onBlur() {
        this.state.focusTarget = null;
        this.state.focusValue = null;
        this.state.tempValue = null;
    }

    // ---------- click ----------
    _onClick(event) {
        if (!this.recording || this.paused) return;
        if (this._ignored(event.target, event)) return;
        if (event.button !== 0) return;
        if (this.state.preventClick) return;

        const target = event.target;
        const tag = target.tagName ? target.tagName.toLowerCase() : '';

        // 紧接 input/type 的同元素 click 抑制（避免文本框被点两次记录）
        const last = this.steps[this.steps.length - 1];
        if (last && last.type === 'input' && tag === 'input') {
            const lastSel = last.params?.selector;
            const built = LB.buildAll(target);
            if (built.length && built[0][0]) {
                const sameId = lastSel && (lastSel === built[0][0] || lastSel === '#' + (target.id || ''));
                if (sameId) return;
            }
        }

        if (!this.state.preventClickTwice) {
            const params = attachLocators({}, target);
            attachHitPoint(params, target, event);
            this._addStep({
                type: 'click',
                description: `点击 ${tag}${shortLabel(target) ? ' "' + shortLabel(target) + '"' : ''}`,
                params
            });
            this.state.preventClickTwice = true;
            setTimeout(() => { this.state.preventClickTwice = false; }, 30);
        }
    }

    _onDblClick(event) {
        if (!this.recording || this.paused) return;
        if (this._ignored(event.target, event)) return;
        // 抹掉前置的两次 click（dblclick 总会先来 click click）
        const popClickIfMatch = () => {
            const last = this.steps[this.steps.length - 1];
            if (last && last.type === 'click') this.steps.pop();
        };
        popClickIfMatch();
        popClickIfMatch();

        const params = attachLocators({}, event.target);
        attachHitPoint(params, event.target, event);
        this._addStep({
            type: 'dblclick',
            description: `双击 ${event.target.tagName.toLowerCase()}`,
            params
        });
    }

    // ---------- input / change (type) ----------
    _onInput(event) {
        if (!this.recording || this.paused) return;
        const target = event.target;
        if (this._ignored(target, event)) return;
        const tag = target.tagName ? target.tagName.toLowerCase() : '';
        if (tag !== 'input' && tag !== 'textarea' && !target.isContentEditable) return;

        this.state.typeTarget = target;
        const isPassword = tag === 'input' && target.type === 'password';
        const value = target.isContentEditable ? target.innerText : (target.value || '');
        const params = attachLocators({}, target);
        const sel = params.selector;
        const now = Date.now();

        // 同一目标 1.5s 内连续输入 -> 合并为一条
        const last = this.state.lastInputStep;
        if (last && last.params.selector === sel && now - this.state.lastInputAt < 1500) {
            last.params.value = isPassword ? '{{password}}' : value;
            last.description = `输入到 ${sel || tag}`;
            this.state.lastInputAt = now;
            this.onChange(this.steps.slice());
            return;
        }

        const step = {
            type: 'input',
            description: `输入到 ${sel || tag}`,
            params: {
                ...params,
                value: isPassword ? '{{password}}' : value,
                clearBefore: true,
                inputType: isPassword ? 'password' : 'text'
            }
        };
        this._addStep(step);
        this.state.lastInputStep = step;
        this.state.lastInputAt = now;
    }

    _onChange(event) {
        if (!this.recording || this.paused) return;
        const target = event.target;
        if (this._ignored(target, event)) return;
        const tag = target.tagName ? target.tagName.toLowerCase() : '';

        if (tag === 'select') {
            const params = attachLocators({}, target);
            const opt = target.options?.[target.selectedIndex];
            this._addStep({
                type: 'select',
                description: `选择 ${opt?.text || target.value}`,
                params: { ...params, value: target.value }
            });
        } else if (tag === 'input' && (target.type === 'checkbox' || target.type === 'radio')) {
            const params = attachLocators({}, target);
            this._addStep({
                type: 'checkbox',
                description: (target.checked ? '勾选 ' : '取消勾选 ') + (params.selector || tag),
                params: { ...params, checked: target.checked }
            });
        }
    }

    // ---------- keydown ----------
    _onKeyDown(event) {
        if (!this.recording || this.paused) return;
        if (this._ignored(event.target, event)) return;

        const target = event.target;
        const tag = target.tagName ? target.tagName.toLowerCase() : '';
        const key = event.key;
        const isEnter = key === 'Enter';
        const isTab = key === 'Tab';

        // Enter on input/textarea —— 标记 enterTarget，配合 change 事件再决定是否产出 sendKeys
        if (isEnter && (tag === 'input' || tag === 'textarea') && INPUT_TYPES.includes(target.type || 'text')) {
            this.state.enterTarget = target;
            this.state.enterValue = target.value;
        }
        if (isTab) {
            this.state.tabCheck = target;
        }

        const SPECIAL = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'];
        const isSpecial = SPECIAL.includes(key);
        const hasMod = event.ctrlKey || event.altKey || event.metaKey;
        if (!isSpecial && !hasMod) return;

        // 在文本输入控件里按 Enter / Tab —— 已由 enterTarget 流程处理，不重复记 keypress
        if ((isEnter || isTab) && (tag === 'input' || tag === 'textarea')) {
            const params = attachLocators({}, target);
            this._addStep({
                type: 'keypress',
                description: `按下 ${key}`,
                params: { ...params, key, modifiers: this._modifiers(event) }
            });
            return;
        }

        const modifiers = this._modifiers(event);
        if (hasMod && key.length === 1) {
            this._addStep({
                type: 'hotkey',
                description: `快捷键 ${[...modifiers, key].join('+')}`,
                params: { keys: [...modifiers.map(m => m[0].toUpperCase() + m.slice(1)), key.toUpperCase()] }
            });
        } else {
            this._addStep({
                type: 'keypress',
                description: `按下 ${key}`,
                params: { key, modifiers }
            });
        }
    }

    _modifiers(e) {
        const m = [];
        if (e.ctrlKey) m.push('ctrl');
        if (e.shiftKey) m.push('shift');
        if (e.altKey) m.push('alt');
        if (e.metaKey) m.push('meta');
        return m;
    }

    _onSubmit() { /* 由 click 提交按钮覆盖 */ }

    // ---------- scroll ----------
    _onScroll() {
        if (!this.recording || this.paused) return;
        const now = Date.now();
        if (now - this.lastScrollAt < 500) return;
        this.lastScrollAt = now;
        clearTimeout(this.scrollTimer);
        this.scrollTimer = setTimeout(() => {
            if (!this.recording) return;
            const last = this.steps[this.steps.length - 1];
            const x = window.scrollX;
            const y = window.scrollY;
            if (last && last.type === 'scroll') {
                last.params.x = x;
                last.params.y = y;
                this.onChange(this.steps.slice());
            } else {
                this._addStep({
                    type: 'scroll',
                    description: `滚动到 (${x}, ${y})`,
                    params: { x, y, behavior: 'smooth' }
                });
            }
        }, 600);
    }

    getScript(meta = {}) {
        return {
            meta: {
                id: 'script_' + Date.now(),
                name: meta.name || '未命名脚本',
                description: meta.description || '',
                version: '1.0',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                author: 'user',
                source: 'record',
                targetUrl: location.href,
                ...meta
            },
            variables: {},
            steps: this.steps.slice()
        };
    }
}

export default { Recorder };
