// 脚本执行器：解析并执行脚本步骤
import Selector from './selector-generator.js';
import { findFromTargets, findElement } from './locator-builders.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const POPUP_WAIT_SELECTOR = '[role="dialog"], [role="listbox"], [role="menu"], .ant-picker-dropdown, .ant-select-dropdown, .el-picker-panel, .el-select-dropdown, .el-popper, .MuiPopover-root, .MuiMenu-root';

// 把 params 里所有 locator 来源展平成统一格式：[{ locator, source, find }]
// - source 仅做日志/调试用
// - find 是闭包：调用即返回当前 DOM 命中的元素（每次都重新查）
function enumerateCandidates(params) {
    if (!params) return [];
    const out = [];
    const seen = new Set();
    const push = (key, source, finder) => {
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push({ locator: key, source, find: finder });
    };

    if (Array.isArray(params.targets)) {
        for (const item of params.targets) {
            const loc = Array.isArray(item) ? item[0] : item;
            const builder = Array.isArray(item) ? (item[1] || 'target') : 'target';
            if (!loc) continue;
            push(loc, `target:${builder}`, () => findElement(loc));
        }
    }
    if (params.selector) {
        push(params.selector, 'selector', () => Selector.query(params.selector));
    }
    if (Array.isArray(params.selectorFallbacks)) {
        for (const f of params.selectorFallbacks) {
            if (!f) continue;
            push(f, 'fallback', () => Selector.query(f));
        }
    }
    // 坐标兜底：所有 selector / targets 都失效时，靠录制时存的 hitPoint 做 elementFromPoint。
    // 按"先用录制时的 viewport 绝对坐标"+"再用元素中心点比例换算"两种策略尝试。
    if (params.hitPoint) {
        push('hitPoint', 'hitPoint:absolute', () => findByHitPoint(params.hitPoint, 'absolute'));
        push('hitPoint', 'hitPoint:scaled', () => findByHitPoint(params.hitPoint, 'scaled'));
    }
    return out;
}

// 统一的元素查找：优先 step.params.targets（[[locator, builderName], ...]），
// 否则回退到 selector + selectorFallbacks。
function findByParams(params) {
    if (!params) return null;
    if (Array.isArray(params.targets) && params.targets.length) {
        const el = findFromTargets(params.targets);
        if (el) return el;
    }
    const bySel = Selector.query(params.selector, params.selectorFallbacks || []);
    if (bySel) return bySel;
    if (params.hitPoint) {
        return findByHitPoint(params.hitPoint, 'absolute') || findByHitPoint(params.hitPoint, 'scaled');
    }
    return null;
}

// 坐标兜底：根据录制时记录的 hitPoint 信息找元素。
// mode = 'absolute'：用录制时的视口坐标 (vx, vy) 直接命中——页面布局没变时最准。
// mode = 'scaled'：按当前 viewport 与录制 viewport 的比例缩放后命中——抗 viewport 尺寸变化。
// 命中后必须通过 sigMatch 校验语义（tag/role/text），否则视为找错元素，避免点到浮层挡住的别的对象。
function findByHitPoint(hp, mode) {
    if (!hp || typeof hp !== 'object') return null;
    let x, y;
    if (mode === 'absolute') {
        x = hp.vx;
        y = hp.vy;
    } else if (mode === 'scaled') {
        const recW = hp.viewport?.w || window.innerWidth;
        const recH = hp.viewport?.h || window.innerHeight;
        if (!recW || !recH) return null;
        const scaleX = window.innerWidth / recW;
        const scaleY = window.innerHeight / recH;
        x = Math.round(hp.vx * scaleX);
        y = Math.round(hp.vy * scaleY);
    } else {
        return null;
    }
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;

    let el;
    try { el = document.elementFromPoint(x, y); }
    catch { return null; }
    if (!el) return null;

    // 命中点落在了我们自己的浮层 / picker / panel 上时，跳过这一层继续往下找
    el = climbToInteractive(el);
    if (!el) return null;

    if (!sigMatch(el, hp.sig)) return null;
    return el;
}

function climbToInteractive(el) {
    let cur = el;
    let safety = 0;
    while (cur && safety < 8) {
        if (cur.nodeType !== 1) return null;
        // 跳过 webchat 自己的 UI 节点（picker 浮层、面板等）
        if (cur.id === 'webchat-script-panel' || cur.closest?.('#webchat-script-panel')) {
            cur = cur.parentElement;
            safety++;
            continue;
        }
        if (cur.classList && (cur.classList.contains('webchat-picker-overlay') || cur.classList.contains('webchat-picker-popup'))) {
            cur = cur.parentElement;
            safety++;
            continue;
        }
        return cur;
    }
    return null;
}

function sigMatch(el, sig) {
    if (!sig) return true; // 老脚本没有 sig，宽松通过
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (sig.tag && tag !== sig.tag) {
        // tag 不一致时再放一刀机会：录制时 button，实际命中包了一层 span 之类
        // 用 closest 同 tag 兜一次
        try {
            const fix = el.closest(sig.tag);
            if (fix) el = fix;
            else return false;
        } catch { return false; }
    }
    if (sig.role) {
        const role = el.getAttribute?.('role') || '';
        if (role && sig.role && role !== sig.role) return false;
    }
    if (sig.text) {
        const text = (el.textContent || el.value || el.placeholder || el.getAttribute?.('aria-label') || '')
            .replace(/\s+/g, ' ').trim();
        // 用包含关系即可——录制时 shortLabel 截了 60 字，重放时可能更长或更短
        const a = text.slice(0, 80).toLowerCase();
        const b = sig.text.slice(0, 80).toLowerCase();
        if (a && b && !a.includes(b) && !b.includes(a)) return false;
    }
    return true;
}

function countPopups() {
    try { return document.querySelectorAll(POPUP_WAIT_SELECTOR).length; }
    catch (e) { return 0; }
}

async function waitForPopupAppeared(baseline, timeout = 800) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (countPopups() > baseline) return true;
        await sleep(50);
    }
    return false;
}

// 用候选 locator 列表逐个尝试执行 action(el)：返回 ok=true 即成功；
// 全部失败时再抛错。action 失败有两种途径：返回 { ok:false } 或抛异常。
async function tryWithCandidates(params, action, { timeout = 5000, label = 'action' } = {}) {
    const candidates = enumerateCandidates(params);
    if (!candidates.length) {
        throw new Error(`${label}: 缺少 selector/targets`);
    }
    const errors = [];
    // 先等到至少有一个候选能命中元素，否则没必要 N 次轮询
    const firstHit = await (async () => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            for (const c of candidates) {
                const el = c.find();
                if (el) return true;
            }
            await sleep(100);
        }
        return false;
    })();
    if (!firstHit) {
        throw new Error(`${label}: 等待元素超时 ${candidates[0].locator}`);
    }

    for (const c of candidates) {
        const el = c.find();
        if (!el) { errors.push(`${c.source}:not-found`); continue; }
        try {
            const res = await action(el, c);
            if (res && res.ok === false) {
                errors.push(`${c.source}:${res.reason || 'reject'}`);
                continue;
            }
            return { el, candidate: c, result: res };
        } catch (err) {
            errors.push(`${c.source}:${err.message}`);
        }
    }
    throw new Error(`${label} 全部候选失败：${errors.join(' | ')}`);
}

async function waitForElement(params, timeout = 5000) {
    // 兼容旧调用：waitForElement(selectorString, fallbacksArray, timeout)
    let pms;
    if (typeof params === 'string') pms = { selector: params, selectorFallbacks: arguments[1] || [] };
    else pms = params;
    const realTimeout = (typeof params === 'string') ? (arguments[2] ?? 5000) : timeout;

    const start = Date.now();
    let nudged = false;
    while (Date.now() - start < realTimeout) {
        const el = findByParams(pms);
        if (el) return el;
        if (!nudged && Date.now() - start > Math.min(800, realTimeout / 3)) {
            nudged = true;
            try { nudgeOpenDropdown(); } catch (e) { /* ignore */ }
        }
        await sleep(100);
    }
    throw new Error(`等待元素超时：${pms.selector || (pms.targets && pms.targets[0]?.[0]) || '?'}`);
}

function nudgeOpenDropdown() {
    const el = document.activeElement;
    if (!el || el === document.body) return;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag !== 'input' && tag !== 'textarea' && el.contentEditable !== 'true') return;
    const init = { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
}

async function waitForElementState(params, state, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const el = findByParams(params);
        if (state === 'visible') {
            if (el && isVisible(el)) return el;
        } else if (state === 'hidden') {
            if (!el || !isVisible(el)) return el;
        } else if (state === 'attached') {
            if (el) return el;
        } else if (state === 'detached') {
            if (!el) return null;
        }
        await sleep(100);
    }
    throw new Error(`等待元素状态(${state})超时：${params.selector || (params.targets && params.targets[0]?.[0]) || '?'}`);
}

function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
}

function getElementCenter(el) {
    const rect = el.getBoundingClientRect();
    return {
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2)
    };
}

function dispatchPointerLike(el, type, coords, button = 0) {
    const { clientX, clientY } = coords;
    const common = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        button,
        buttons: type === 'mousedown' || type === 'pointerdown' ? 1 : 0
    };
    const pointerMap = {
        mousedown: 'pointerdown',
        mouseup: 'pointerup',
        mousemove: 'pointermove',
        mouseover: 'pointerover',
        mouseenter: 'pointerenter',
        mouseout: 'pointerout',
        mouseleave: 'pointerleave'
    };
    const pointerType = pointerMap[type];
    if (pointerType && typeof PointerEvent === 'function') {
        try {
            el.dispatchEvent(new PointerEvent(pointerType, {
                ...common,
                pointerId: 1,
                pointerType: 'mouse',
                isPrimary: true,
                width: 1,
                height: 1,
                pressure: type === 'mousedown' || type === 'pointerdown' ? 0.5 : 0
            }));
        } catch (e) { /* ignore */ }
    }
    el.dispatchEvent(new MouseEvent(type, common));
}

async function performClick(el, { button = 0, count = 1 } = {}) {
    const coords = getElementCenter(el);
    dispatchPointerLike(el, 'mouseover', coords, button);
    dispatchPointerLike(el, 'mouseenter', coords, button);
    dispatchPointerLike(el, 'mousemove', coords, button);
    for (let i = 0; i < count; i++) {
        dispatchPointerLike(el, 'mousedown', coords, button);
        if (typeof el.focus === 'function') {
            try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (_) { } }
        }
        dispatchPointerLike(el, 'mouseup', coords, button);
        el.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: coords.clientX, clientY: coords.clientY,
            screenX: coords.clientX, screenY: coords.clientY,
            button, buttons: 0, detail: i + 1
        }));
        if (count > 1) await sleep(50);
    }
}

const HIGHLIGHT_CLASS = 'webchat-script-highlight';
const HIGHLIGHT_STYLE_ID = 'webchat-script-highlight-style';

function ensureHighlightStyle() {
    if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `
        .${HIGHLIGHT_CLASS} {
            outline: 2px solid #ff7a00 !important;
            outline-offset: 2px !important;
            box-shadow: 0 0 0 4px rgba(255, 122, 0, 0.25), 0 0 12px rgba(255, 122, 0, 0.6) !important;
            transition: outline-color 0.2s, box-shadow 0.2s !important;
            animation: webchat-script-pulse 1s ease-in-out infinite !important;
        }
        @keyframes webchat-script-pulse {
            0%, 100% { box-shadow: 0 0 0 4px rgba(255, 122, 0, 0.25), 0 0 12px rgba(255, 122, 0, 0.6); }
            50%      { box-shadow: 0 0 0 6px rgba(255, 122, 0, 0.45), 0 0 18px rgba(255, 122, 0, 0.9); }
        }
    `;
    document.documentElement.appendChild(style);
}

function highlightElement(el, durationMs = 0) {
    if (!el || !el.classList) return () => { };
    ensureHighlightStyle();
    el.classList.add(HIGHLIGHT_CLASS);
    let removed = false;
    const remove = () => {
        if (removed) return;
        removed = true;
        try { el.classList.remove(HIGHLIGHT_CLASS); } catch (e) { /* ignore */ }
    };
    if (durationMs > 0) setTimeout(remove, durationMs);
    return remove;
}

async function waitForUiSettled({ quietMs = 250, maxMs = 1500 } = {}) {
    return new Promise((resolve) => {
        const start = Date.now();
        let lastChange = Date.now();
        const observer = new MutationObserver(() => {
            lastChange = Date.now();
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'aria-hidden', 'aria-expanded', 'data-state']
        });
        const tick = () => {
            const now = Date.now();
            if (now - lastChange >= quietMs || now - start >= maxMs) {
                observer.disconnect();
                resolve();
            } else {
                setTimeout(tick, 50);
            }
        };
        setTimeout(tick, 50);
    });
}

function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const protoSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter && setter !== protoSetter) {
        protoSetter.call(el, value);
    } else if (setter) {
        setter.call(el, value);
    } else {
        el.value = value;
    }
}

function findVisibleOption(text) {
    const normalized = String(text).replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    const selectors = [
        '.ant-select-dropdown [role="option"]',
        '.ant-select-dropdown .ant-select-item-option-content',
        '[role="listbox"] [role="option"]',
        '.el-select-dropdown__item',
        '.MuiMenu-paper [role="option"]',
        '.MuiMenu-paper [role="menuitem"]'
    ];
    const candidates = [];
    for (const selector of selectors) {
        try { candidates.push(...document.querySelectorAll(selector)); } catch (e) { /* ignore */ }
    }
    for (const el of candidates) {
        if (!isVisible(el)) continue;
        const value = (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
        if (value === normalized) return el;
    }
    for (const el of candidates) {
        if (!isVisible(el)) continue;
        const value = (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
        if (value.includes(normalized)) return el;
    }
    return null;
}

// 特殊键映射（仿 selenium-ide）：${KEY_ENTER} / ${KEY_TAB} 等
const SPECIAL_KEY_MAP = {
    KEY_ENTER: '', KEY_RETURN: '',
    KEY_TAB: '',
    KEY_ESC: '', KEY_ESCAPE: '',
    KEY_BACKSPACE: '', KEY_BKSP: '',
    KEY_DELETE: '', KEY_DEL: '',
    KEY_SPACE: ' ', KEY_SPC: ' ',
    KEY_UP: '', KEY_DOWN: '',
    KEY_LEFT: '', KEY_RIGHT: '',
    KEY_HOME: '', KEY_END: '',
    KEY_PAGE_UP: '', KEY_PAGE_DOWN: ''
};

// 反查：给 input handler 用，把  还原为 'Enter' 这种 KeyboardEvent.key
const UNICODE_TO_KEY = {
    '': 'Enter', '': 'Tab', '': 'Escape',
    '': 'Backspace', '': 'Delete',
    '': 'ArrowUp', '': 'ArrowDown',
    '': 'ArrowLeft', '': 'ArrowRight',
    '': 'Home', '': 'End',
    '': 'PageUp', '': 'PageDown'
};

function splitSpecialKeys(value) {
    if (!value) return [{ kind: 'text', text: '' }];
    const out = [];
    let buf = '';
    for (const ch of String(value)) {
        if (UNICODE_TO_KEY[ch]) {
            if (buf) { out.push({ kind: 'text', text: buf }); buf = ''; }
            out.push({ kind: 'key', key: UNICODE_TO_KEY[ch] });
        } else {
            buf += ch;
        }
    }
    if (buf) out.push({ kind: 'text', text: buf });
    return out;
}

function interpolate(text, variables) {
    if (typeof text !== 'string') return text;
    // 先替换 ${...}：先尝试特殊键，再变量；变量支持 a.b.c
    let out = text.replace(/\$\{\s*([^}]+?)\s*\}/g, (m, key) => {
        if (Object.prototype.hasOwnProperty.call(SPECIAL_KEY_MAP, key)) return SPECIAL_KEY_MAP[key];
        const parts = key.split('.');
        let val = variables;
        for (const p of parts) {
            if (val == null) return m;
            val = val[p];
        }
        return val == null ? m : String(val);
    });
    // 兼容旧 {{var}}
    out = out.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, key) => {
        const parts = key.split('.');
        let val = variables;
        for (const p of parts) {
            if (val == null) return m;
            val = val[p];
        }
        return val == null ? m : String(val);
    });
    return out;
}

function resolveStep(step, variables) {
    const cloned = JSON.parse(JSON.stringify(step));
    const walk = (obj) => {
        if (obj == null) return;
        if (Array.isArray(obj)) {
            obj.forEach((v, i) => {
                if (typeof v === 'string') obj[i] = interpolate(v, variables);
                else walk(v);
            });
        } else if (typeof obj === 'object') {
            for (const k of Object.keys(obj)) {
                if (typeof obj[k] === 'string') obj[k] = interpolate(obj[k], variables);
                else walk(obj[k]);
            }
        }
    };
    walk(cloned);
    return cloned;
}

export const actions = {
    async navigate(params) {
        // 如果已在目标页面（忽略末尾斜杠），跳过导航避免刷新导致脚本中断
        const target = String(params.url || '').replace(/\/+$/, '');
        const current = window.location.href.replace(/\/+$/, '');
        if (target && current === target) {
            return;
        }
        window.location.href = params.url;
        await sleep(200);
    },
    async reload() { window.location.reload(); await sleep(200); },
    async back() { window.history.back(); await sleep(200); },
    async forward() { window.history.forward(); await sleep(200); },

    async wait(params, options) {
        const timeout = options?.timeout ?? 5000;
        const state = params.state || 'visible';
        await waitForElementState(params, state, timeout);
    },
    async waitTime(params) { await sleep(params.duration || 1000); },

    async click(params, options) {
        const timeout = options?.timeout ?? 5000;
        const button = params.button === 'right' ? 2 : params.button === 'middle' ? 1 : 0;
        const count = params.clickCount || 1;
        // expect: 'popup' 表示这一步语义是"打开下拉/弹层"，点完要校验 popup 数量增加；
        // 未指定时按"无期望"处理，等价于历史行为
        const expect = params.expect || 'auto';
        const wantPopup = expect === 'popup';

        await tryWithCandidates(params, async (el) => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(150);
            const baseline = wantPopup ? countPopups() : 0;
            await performClick(el, { button, count });
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            await waitForUiSettled();
            if (wantPopup) {
                const opened = await waitForPopupAppeared(baseline, 800);
                if (!opened) return { ok: false, reason: 'popup-not-opened' };
            }
            return { ok: true };
        }, { timeout, label: 'click' });

        return { ok: true };
    },

    async dblclick(params, options) {
        const timeout = options?.timeout ?? 5000;
        const el = await waitForElement(params, timeout);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(150);
        await performClick(el, { count: 2 });
        const coords = getElementCenter(el);
        el.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: coords.clientX, clientY: coords.clientY, detail: 2
        }));
        await waitForUiSettled();
    },

    async input(params, options) {
        const timeout = options?.timeout ?? 5000;
        const el = await waitForElement(params, timeout);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(80);
        const coords = getElementCenter(el);
        dispatchPointerLike(el, 'mouseover', coords);
        dispatchPointerLike(el, 'mousemove', coords);
        dispatchPointerLike(el, 'mousedown', coords);
        try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (_) { } }
        dispatchPointerLike(el, 'mouseup', coords);
        el.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: coords.clientX, clientY: coords.clientY, button: 0, detail: 1
        }));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        if (params.clearBefore) {
            setNativeValue(el, '');
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const value = String(params.value ?? '');
        // 把 unicode 特殊键（如  Enter）切成 [{kind:'text', text}, {kind:'key', key:'Enter'}, ...]
        const segments = splitSpecialKeys(value);
        if (params.simulateTyping === false) {
            // 非模拟：只把文本段拼回 value，键段单独 dispatch keydown/keyup
            let plain = '';
            for (const seg of segments) if (seg.kind === 'text') plain += seg.text;
            setNativeValue(el, (params.clearBefore ? '' : el.value || '') + plain);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            for (const seg of segments) {
                if (seg.kind === 'key') {
                    el.dispatchEvent(new KeyboardEvent('keydown', { key: seg.key, bubbles: true, cancelable: true }));
                    el.dispatchEvent(new KeyboardEvent('keyup', { key: seg.key, bubbles: true, cancelable: true }));
                }
            }
        } else {
            let current = params.clearBefore ? '' : (el.value || '');
            for (const seg of segments) {
                if (seg.kind === 'text') {
                    for (const ch of seg.text) {
                        current += ch;
                        setNativeValue(el, current);
                        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, cancelable: true }));
                        if (params.delay) await sleep(params.delay);
                    }
                } else {
                    el.dispatchEvent(new KeyboardEvent('keydown', { key: seg.key, bubbles: true, cancelable: true }));
                    el.dispatchEvent(new KeyboardEvent('keyup', { key: seg.key, bubbles: true, cancelable: true }));
                    if (params.delay) await sleep(params.delay);
                }
            }
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await waitForUiSettled();
    },

    async type(params, options) {
        return actions.input({
            selector: params.selector,
            value: params.text,
            delay: params.delay ?? 50,
            clearBefore: !!params.clearBefore
        }, options);
    },

    async select(params, options) {
        const timeout = options?.timeout ?? 5000;
        const el = await waitForElement(params, timeout);
        if (el.tagName?.toLowerCase() !== 'select') {
            const text = params.text ?? params.value ?? params.label;
            if (text == null) throw new Error('select 缺少 value/text');
            // 点 trigger：要求 popup 真的弹出来；不弹就换候选 locator
            await actions.click({ ...params, expect: 'popup' }, options);
            const popupSel = params.popupSelector || POPUP_WAIT_SELECTOR;
            await waitForElementState({ selector: popupSel }, 'visible', timeout).catch(() => null);
            const option = findVisibleOption(String(text));
            if (!option) throw new Error(`未找到选项：${text}`);
            await performClick(option);
            await waitForUiSettled();
            return { ok: true };
        }
        if (params.value != null) el.value = params.value;
        else if (params.text != null) {
            const opt = Array.from(el.options || []).find(o => o.text === params.text);
            if (opt) el.value = opt.value;
        } else if (params.index != null) el.selectedIndex = params.index;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    },

    async checkbox(params, options) {
        const timeout = options?.timeout ?? 5000;
        const el = await waitForElement(params, timeout);
        if (el.checked !== !!params.checked) el.click();
    },

    async scroll(params) {
        if (params.selector || (Array.isArray(params.targets) && params.targets.length)) {
            const el = findByParams(params);
            if (el) el.scrollTo({ left: params.x || 0, top: params.y || 0, behavior: params.behavior || 'smooth' });
        } else {
            window.scrollTo({ left: params.x || 0, top: params.y || 0, behavior: params.behavior || 'smooth' });
        }
        await sleep(200);
    },

    async hover(params, options) {
        const timeout = options?.timeout ?? 5000;
        const el = await waitForElement(params, timeout);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(100);
        const coords = getElementCenter(el);
        dispatchPointerLike(el, 'mouseover', coords);
        dispatchPointerLike(el, 'mouseenter', coords);
        dispatchPointerLike(el, 'mousemove', coords);
        if (params.duration) await sleep(params.duration);
    },

    async keypress(params, options) {
        const target = params.selector
            ? await waitForElement(params.selector, params.selectorFallbacks || [], options?.timeout ?? 5000)
            : document.activeElement || document.body;
        const init = {
            key: params.key,
            code: params.key,
            bubbles: true,
            cancelable: true,
            ctrlKey: !!(params.modifiers && params.modifiers.includes('ctrl')),
            shiftKey: !!(params.modifiers && params.modifiers.includes('shift')),
            altKey: !!(params.modifiers && params.modifiers.includes('alt')),
            metaKey: !!(params.modifiers && params.modifiers.includes('meta'))
        };
        target.dispatchEvent(new KeyboardEvent('keydown', init));
        target.dispatchEvent(new KeyboardEvent('keypress', init));
        target.dispatchEvent(new KeyboardEvent('keyup', init));
    },

    async hotkey(params) {
        const keys = params.keys || [];
        const modifiers = keys.slice(0, -1).map(k => k.toLowerCase());
        const key = keys[keys.length - 1];
        return actions.keypress({ key, modifiers });
    },

    async drag(params, options) {
        const timeout = options?.timeout ?? 5000;
        const source = await waitForElement(params.sourceSelector, params.sourceFallbacks || [], timeout);
        const sRect = source.getBoundingClientRect();
        const sX = sRect.left + sRect.width / 2;
        const sY = sRect.top + sRect.height / 2;
        let tX, tY;
        if (params.targetSelector) {
            const target = await waitForElement(params.targetSelector, params.targetFallbacks || [], timeout);
            const tRect = target.getBoundingClientRect();
            tX = tRect.left + tRect.width / 2;
            tY = tRect.top + tRect.height / 2;
        } else if (params.targetPosition) {
            tX = params.targetPosition.x;
            tY = params.targetPosition.y;
        } else {
            throw new Error('drag 缺少目标参数');
        }
        const dt = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, clientX: sX, clientY: sY, dataTransfer: dt }));
        source.dispatchEvent(new DragEvent('drag', { bubbles: true, clientX: sX, clientY: sY, dataTransfer: dt }));
        const overTarget = document.elementFromPoint(tX, tY) || document.body;
        overTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, clientX: tX, clientY: tY, dataTransfer: dt }));
        overTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, clientX: tX, clientY: tY, dataTransfer: dt }));
        overTarget.dispatchEvent(new DragEvent('drop', { bubbles: true, clientX: tX, clientY: tY, dataTransfer: dt }));
        source.dispatchEvent(new DragEvent('dragend', { bubbles: true, clientX: tX, clientY: tY, dataTransfer: dt }));
    },

    async screenshot(params) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                action: 'captureScreenshot',
                options: { format: params.format || 'png' }
            }, (resp) => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else if (resp && resp.dataUrl) resolve({ dataUrl: resp.dataUrl });
                else reject(new Error('截图失败'));
            });
        });
    },

    async extract(params, options, ctx) {
        const timeout = options?.timeout ?? 5000;
        const el = await waitForElement(params, timeout);
        let value;
        const attr = params.attribute || 'text';
        if (attr === 'text') value = el.textContent.trim();
        else if (attr === 'html') value = el.innerHTML;
        else if (attr === 'value') value = el.value;
        else value = el.getAttribute(attr);
        if (params.saveTo && ctx) ctx.variables[params.saveTo] = value;
        return { value };
    },

    async extractList(params, options, ctx) {
        const timeout = options?.timeout ?? 5000;
        await waitForElement(params, timeout).catch(() => null);
        const items = Array.from(document.querySelectorAll(params.selector));
        const fields = params.fields || [];
        const result = items.map(item => {
            const row = {};
            for (const field of fields) {
                const sub = field.subSelector ? item.querySelector(field.subSelector) : item;
                if (!sub) { row[field.name] = null; continue; }
                const a = field.attribute || 'text';
                if (a === 'text') row[field.name] = sub.textContent.trim();
                else if (a === 'html') row[field.name] = sub.innerHTML;
                else row[field.name] = sub.getAttribute(a);
            }
            return row;
        });
        if (params.saveTo && ctx) ctx.variables[params.saveTo] = result;
        return { value: result };
    },

    async extractTable(params, options, ctx) {
        const timeout = options?.timeout ?? 5000;
        const table = await waitForElement(params, timeout);
        const rows = Array.from(table.querySelectorAll('tr'));
        let headers = [];
        let dataRows = rows;
        if (params.headers !== false) {
            const headerRow = rows[0];
            if (headerRow) {
                headers = Array.from(headerRow.querySelectorAll('th, td')).map(c => c.textContent.trim());
                dataRows = rows.slice(1);
            }
        }
        const result = dataRows.map(row => {
            const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.textContent.trim());
            if (headers.length) {
                const obj = {};
                headers.forEach((h, i) => { obj[h] = cells[i] ?? null; });
                return obj;
            }
            return cells;
        });
        if (params.saveTo && ctx) ctx.variables[params.saveTo] = result;
        return { value: result };
    },

    async assert(params, options) {
        const onFail = options?.onFail || 'stop';
        const timeout = options?.timeout ?? 5000;
        const condition = params.condition;
        let pass = false;
        try {
            if (condition === 'elementVisible') {
                const el = await waitForElementState(params, 'visible', timeout);
                pass = !!el;
            } else if (condition === 'elementHidden') {
                await waitForElementState(params, 'hidden', timeout);
                pass = true;
            } else if (condition === 'textEquals') {
                const el = await waitForElement(params, timeout);
                pass = el.textContent.trim() === params.expected;
            } else if (condition === 'textContains') {
                const el = await waitForElement(params, timeout);
                pass = el.textContent.includes(params.expected);
            } else if (condition === 'urlContains') {
                pass = location.href.includes(params.expected);
            }
        } catch (e) {
            pass = false;
        }
        if (!pass) {
            const message = params.message || `断言失败：${condition}`;
            if (onFail === 'stop') throw new Error(message);
            if (onFail === 'warn') console.warn('[WebChat]', message);
        }
        return { pass };
    },

    async setVariable(params, options, ctx) {
        if (!ctx) return;
        ctx.variables[params.name] = params.value;
    },

    async log(params) {
        const level = params.level || 'info';
        (console[level] || console.log)('[WebChat脚本]', params.message);
    },

    async condition(params, options, ctx, runner) {
        const expr = params.if;
        let result = false;
        try {
            const text = interpolate(expr, ctx.variables || {});
            const eqMatch = text.match(/^\s*(.+?)\s*(==|!=)\s*(.+?)\s*$/);
            if (eqMatch) {
                const [, a, op, b] = eqMatch;
                result = op === '==' ? a === b : a !== b;
            } else {
                result = !!text && text !== 'false' && text !== '0';
            }
        } catch (e) {
            result = false;
        }
        const branch = result ? params.then : params.else;
        if (Array.isArray(branch)) await runner(branch);
    },

    async loop(params, options, ctx, runner) {
        const type = params.type || 'count';
        if (type === 'count') {
            const n = Number(params.count) || 0;
            for (let i = 0; i < n; i++) {
                ctx.variables.$index = i;
                await runner(params.steps || []);
            }
        } else if (type === 'forEach') {
            const items = Array.isArray(params.items) ? params.items
                : (typeof params.items === 'string' && ctx.variables[params.items]) || [];
            for (let i = 0; i < items.length; i++) {
                ctx.variables.$item = items[i];
                ctx.variables.$index = i;
                await runner(params.steps || []);
            }
        } else if (type === 'while') {
            let safety = params.maxIterations || 100;
            while (safety-- > 0) {
                const expr = interpolate(params.condition || '', ctx.variables);
                if (!expr || expr === 'false' || expr === '0') break;
                await runner(params.steps || []);
            }
        }
    },

    async aiRead(params, options, ctx) {
        let content = '';
        if (params.selector || (Array.isArray(params.targets) && params.targets.length)) {
            const el = findByParams(params);
            content = el ? el.innerText : '';
        } else {
            content = document.body.innerText.slice(0, 5000);
        }
        const result = await chrome.runtime.sendMessage({
            action: 'aiAssist',
            mode: 'read',
            prompt: params.prompt,
            content
        });
        if (result && params.saveTo && ctx) ctx.variables[params.saveTo] = result.text;
        return result;
    },

    async aiLocate(params) {
        const elements = collectInteractiveElements();
        const result = await chrome.runtime.sendMessage({
            action: 'aiAssist',
            mode: 'locate',
            description: params.description,
            elements
        });
        if (result && result.selector) {
            const el = Selector.query(result.selector);
            if (el) {
                if (params.action === 'click') return actions.click({ selector: result.selector });
                return { selector: result.selector };
            }
        }
        throw new Error('AI 未能定位到元素');
    },

    // ====== P1: 存值 / 调试动作 ======
    async storeText(params, options, ctx) {
        const timeout = options?.timeout ?? 5000;
        const el = await waitForElement(params, timeout);
        const text = (el.textContent || '').trim();
        if (params.saveTo && ctx) ctx.variables[params.saveTo] = text;
        return { value: text };
    },

    async storeValue(params, options, ctx) {
        const timeout = options?.timeout ?? 5000;
        const el = await waitForElement(params, timeout);
        const v = el.value ?? el.getAttribute('value') ?? '';
        if (params.saveTo && ctx) ctx.variables[params.saveTo] = v;
        return { value: v };
    },

    async storeAttribute(params, options, ctx) {
        const timeout = options?.timeout ?? 5000;
        const el = await waitForElement(params, timeout);
        const v = el.getAttribute(params.attribute) ?? '';
        if (params.saveTo && ctx) ctx.variables[params.saveTo] = v;
        return { value: v };
    },

    async storeCount(params, options, ctx) {
        // 不要求元素存在；查不到就存 0
        let n = 0;
        try {
            if (Array.isArray(params.targets) && params.targets.length) {
                // targets 数组目前只返回第一个匹配；回退到 selector 查全部
                const sel = params.selector;
                if (sel) n = document.querySelectorAll(sel).length;
                else n = findByParams(params) ? 1 : 0;
            } else if (params.selector) {
                n = document.querySelectorAll(params.selector).length;
            }
        } catch (e) { n = 0; }
        if (params.saveTo && ctx) ctx.variables[params.saveTo] = n;
        return { count: n };
    },

    async executeScript(params, options, ctx) {
        // 在页面里执行一段 JS；可访问 ctx.variables 作为 vars
        // 安全限制：只执行用户脚本里写死的函数体，不接受 eval 用户输入字符串以外的来源
        const fn = new Function('vars', 'utils', `"use strict"; return (async () => { ${params.code || 'return null;'} })();`);
        const result = await fn(ctx ? ctx.variables : {}, { sleep, isVisible });
        if (params.saveTo && ctx) ctx.variables[params.saveTo] = result;
        return { value: result };
    },

    async echo(params, options, ctx) {
        const msg = String(params.message ?? '');
        // 主流程上的 onLog 会接到
        if (ctx && ctx._onLog) ctx._onLog({ level: 'info', message: msg });
        else console.log('[WebChat echo]', msg);
        return { message: msg };
    },

    async pause(params) {
        const ms = Number(params.duration) || 0;
        if (ms > 0) await sleep(ms);
        return { paused: ms };
    }
};

function collectInteractiveElements() {
    return collectInteractiveElementsImpl({ async: false });
}

async function collectInteractiveElementsAsync({ onProgress, batchSize = 24 } = {}) {
    return collectInteractiveElementsImpl({ async: true, onProgress, batchSize });
}

function collectInteractiveElementsImpl({ async: isAsync, onProgress, batchSize = 24 }) {
    const fieldElements = collectFormFieldElements();
    const fieldElementSet = new Set(fieldElements);
    const els = [
        ...fieldElements,
        ...document.querySelectorAll('a, button, input, select, textarea, [role], [onclick], [tabindex], [contenteditable="true"]')
    ];
    const out = [];
    const limit = 140;
    let count = 0;
    let scanned = 0;
    const seen = new Set();
    const total = Math.min(els.length, limit + 200); // 上限粗估，主要给进度条用
    const yieldFrame = () => new Promise(r => setTimeout(r, 0));

    const processOne = (el) => {
        scanned++;
        if (count >= limit) return false;
        if (seen.has(el)) return true;
        seen.add(el);
        if (Selector.isWebChatElement(el)) return true;
        if (!fieldElementSet.has(el) && isInsideCollectedField(el, fieldElements)) return true;
        if (isDecorativeRole(el)) return true;
        if (!isVisible(el)) return true;
        const sel = Selector.generate(el);
        const options = collectOptions(el);
        out.push({
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            role: el.getAttribute('role') || null,
            id: el.id || null,
            name: el.name || null,
            label: getElementLabel(el),
            text: (el.textContent || '').trim().slice(0, 50),
            placeholder: el.placeholder || null,
            ariaLabel: el.getAttribute('aria-label') || null,
            title: el.getAttribute('title') || null,
            value: el.value || el.getAttribute('value') || null,
            required: !!(el.required || el.getAttribute('aria-required') === 'true'),
            disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
            readOnly: !!(el.readOnly || el.getAttribute('aria-readonly') === 'true'),
            contentEditable: el.isContentEditable === true,
            pattern: el.getAttribute('pattern') || null,
            min: el.getAttribute('min') || null,
            max: el.getAttribute('max') || null,
            step: el.getAttribute('step') || null,
            inputMode: el.getAttribute('inputmode') || null,
            autocomplete: el.getAttribute('autocomplete') || null,
            formatHint: inferFormatHint(el),
            options,
            ariaHasPopup: el.getAttribute('aria-haspopup') || null,
            ariaExpanded: el.getAttribute('aria-expanded') || null,
            popupSelector: inferPopupSelector(el),
            selector: sel.primary,
            selectorFallbacks: sel.fallbacks || [],
            targets: sel.targets || []
        });
        count++;
        return true;
    };

    if (!isAsync) {
        for (const el of els) {
            if (!processOne(el)) break;
        }
        return out;
    }
    // 异步：分批 yield，定时上报进度
    return (async () => {
        for (let i = 0; i < els.length; i += batchSize) {
            const slice = els.slice(i, i + batchSize);
            for (const el of slice) {
                if (!processOne(el)) {
                    if (onProgress) onProgress({ scanned, total: els.length, kept: count, done: true });
                    return out;
                }
            }
            if (onProgress) onProgress({ scanned, total: els.length, kept: count, done: false });
            await yieldFrame();
        }
        if (onProgress) onProgress({ scanned, total: els.length, kept: count, done: true });
        return out;
    })();
}

function isInsideCollectedField(el, fieldElements) {
    return fieldElements.some(field => field !== el && field.contains && field.contains(el));
}

function isDecorativeRole(el) {
    const role = el.getAttribute && el.getAttribute('role');
    if (role !== 'img' && role !== 'presentation' && role !== 'none') return false;
    return !el.getAttribute('aria-controls') && !el.getAttribute('aria-haspopup') && !el.onclick;
}

function collectFormFieldElements() {
    const fields = [];
    const items = document.querySelectorAll('.ant-form-item, .el-form-item, .form-item');
    for (const item of items) {
        if (Selector.isWebChatElement(item) || !isVisibleEnough(item)) continue;
        const control = getBestFieldControl(item);
        if (control && !fields.includes(control)) fields.push(control);
    }
    return fields;
}

function getBestFieldControl(item) {
    return item.querySelector('.ant-select-selector')
        || item.querySelector('.ant-picker')
        || item.querySelector('.ant-upload, .ant-upload-wrapper')
        || item.querySelector('.ant-radio-group')
        || item.querySelector('.ant-checkbox-wrapper')
        || item.querySelector('.el-select, .el-date-editor')
        || item.querySelector('textarea, input:not([type="hidden"]), select, button, [contenteditable="true"]');
}

function isVisibleEnough(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}

function getElementLabel(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
        const text = labelledBy.split(/\s+/)
            .map(id => document.getElementById(id)?.textContent || '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (text) return text.slice(0, 80);
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 80);
    if (el.id) {
        const label = document.querySelector(`label[for="${cssStringEscape(el.id)}"]`);
        if (label?.textContent?.trim()) return label.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    const wrappingLabel = el.closest('label');
    if (wrappingLabel?.textContent?.trim()) return wrappingLabel.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
    const title = el.getAttribute('title');
    if (title) return title.trim().slice(0, 80);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder.trim().slice(0, 80);
    return nearbyLabelText(el);
}

function nearbyLabelText(el) {
    const candidates = [];
    let cur = el.parentElement;
    for (let depth = 0; cur && depth < 3; depth++, cur = cur.parentElement) {
        const label = cur.querySelector('label');
        if (label && !label.contains(el)) candidates.push(label.textContent || '');
        for (const cls of ['.ant-form-item-label', '.el-form-item__label', '.form-label', '.label']) {
            const node = cur.querySelector(cls);
            if (node && !node.contains(el)) candidates.push(node.textContent || '');
        }
        const prev = cur.previousElementSibling;
        if (prev) candidates.push(prev.textContent || '');
    }
    const text = candidates.map(s => String(s).replace(/\s+/g, ' ').trim()).find(Boolean);
    return text ? text.slice(0, 80) : null;
}

function collectOptions(el) {
    const searchInput = findRelatedComboboxInput(el);
    if (searchInput?.getAttribute('aria-controls')) {
        return collectPortalOptions(searchInput.getAttribute('aria-controls'));
    }
    if (el.tagName?.toLowerCase() === 'select') {
        return Array.from(el.options || []).slice(0, 30).map(option => ({
            value: option.value,
            text: option.textContent.trim()
        }));
    }
    const listId = el.getAttribute('list');
    if (listId) {
        const datalist = document.getElementById(listId);
        if (datalist) {
            return Array.from(datalist.querySelectorAll('option')).slice(0, 30).map(option => ({
                value: option.value,
                text: option.label || option.textContent.trim()
            }));
        }
    }
    return [];
}

function findRelatedComboboxInput(el) {
    if (el.getAttribute('role') === 'combobox') return el;
    const item = el.closest('.ant-form-item, .el-form-item, .form-item') || el.parentElement;
    return item?.querySelector('input[role="combobox"][aria-controls]') || null;
}

function collectPortalOptions(id) {
    const root = document.getElementById(id);
    if (!root) return [];
    return Array.from(root.querySelectorAll('[role="option"], .ant-select-item-option-content, .el-select-dropdown__item'))
        .slice(0, 30)
        .map(option => ({
            value: option.getAttribute('title') || option.getAttribute('data-value') || option.textContent.trim(),
            text: option.textContent.trim()
        }))
        .filter(option => option.text || option.value);
}

function inferFormatHint(el) {
    const explicit = el.getAttribute('data-format')
        || el.getAttribute('data-format-hint')
        || el.getAttribute('format')
        || '';
    if (explicit) return explicit;
    const type = (el.type || '').toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/ant-picker-range|date-range|range-picker/i.test(cls)) return 'YYYY-MM-DD ~ YYYY-MM-DD';
    if (/ant-picker|date-picker/i.test(cls)) return 'YYYY-MM-DD';
    if (type === 'date') return 'YYYY-MM-DD';
    if (type === 'datetime-local') return 'YYYY-MM-DDTHH:mm';
    if (type === 'time') return 'HH:mm';
    if (type === 'month') return 'YYYY-MM';
    if (type === 'number' || type === 'range') return 'number';
    const placeholder = el.getAttribute('placeholder') || '';
    if (/yyyy-mm-dd\s*[~至到-]\s*yyyy-mm-dd/i.test(placeholder)) return 'YYYY-MM-DD ~ YYYY-MM-DD';
    if (/yyyy-mm-dd/i.test(placeholder)) return 'YYYY-MM-DD';
    if (/\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*[~至到-]\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(placeholder)) return 'YYYY-MM-DD ~ YYYY-MM-DD';
    if (/\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(placeholder)) return 'YYYY-MM-DD';
    return null;
}

function inferPopupSelector(el) {
    const relatedCombo = findRelatedComboboxInput(el);
    if (relatedCombo?.getAttribute('aria-controls')) return `#${cssStringEscape(relatedCombo.getAttribute('aria-controls'))}`;
    const controls = el.getAttribute('aria-controls');
    if (controls) return `#${cssStringEscape(controls)}`;
    const owns = el.getAttribute('aria-owns');
    if (owns) return `#${cssStringEscape(owns)}`;
    const role = el.getAttribute('role');
    const type = (el.type || '').toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : '';
    if (
        el.getAttribute('aria-haspopup') ||
        role === 'combobox' ||
        type === 'date' ||
        type === 'datetime-local' ||
        /picker|select|dropdown|range/i.test(cls)
    ) {
        return '[role="dialog"], [role="listbox"], [role="menu"], .ant-picker-dropdown, .ant-select-dropdown, .el-picker-panel, .el-select-dropdown, .el-popper, .MuiPopover-root, .MuiMenu-root';
    }
    return null;
}

function cssStringEscape(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class ScriptExecutor {
    constructor(opts = {}) {
        this.mode = opts.mode || 'run';
        this.onBeforeStep = opts.onBeforeStep || (async () => { });
        this.onAfterStep = opts.onAfterStep || (async () => { });
        this.onError = opts.onError || (async () => { });
        this.onLog = opts.onLog || (() => { });
        this.aborted = false;
        this.stepDelay = Number.isFinite(opts.stepDelay) ? opts.stepDelay : 600;
        this.highlight = opts.highlight !== false;
        this.highlightLeadMs = Number.isFinite(opts.highlightLeadMs) ? opts.highlightLeadMs : 250;
    }

    abort() { this.aborted = true; }

    async _previewStep(step) {
        if (!this.highlight) return () => { };
        const sel = step?.params?.selector;
        if (!sel) return () => { };
        const fallbacks = step?.params?.selectorFallbacks || [];
        const el = Selector.query(sel, fallbacks);
        if (!el) return () => { };
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
        const remove = highlightElement(el);
        if (this.highlightLeadMs > 0) await sleep(this.highlightLeadMs);
        return remove;
    }

    async execute(script) {
        const ctx = {
            variables: { ...(script.variables || {}) },
            results: [],
            _onLog: (entry) => this.onLog(entry)
        };
        // 嗅探：当前是 click/未声明 expect，且下一步是 wait 一个 popup 类 selector
        // → 自动给 click 注入 expect:'popup'，让候选切换机制接管
        const looksLikePopupSelector = (sel) => {
            if (!sel) return false;
            return /role=["']?(dialog|listbox|menu)|ant-(picker|select|cascader)-dropdown|el-(picker|select|dropdown|popper)|MuiPopover|MuiMenu/i.test(sel);
        };
        const inferExpect = (step, next) => {
            if (!step || step.type !== 'click') return;
            if (step.params && step.params.expect) return;
            if (!next) return;
            if (next.type !== 'wait') return;
            const sel = next.params?.selector;
            if (looksLikePopupSelector(sel)) {
                step.params = step.params || {};
                step.params.expect = 'popup';
            }
        };
        const runSteps = async (steps) => {
            for (let idx = 0; idx < steps.length; idx++) {
                const step = steps[idx];
                if (this.aborted) throw new Error('已中止');
                const resolved = resolveStep(step, ctx.variables);
                inferExpect(resolved, steps[idx + 1]);
                await this.onBeforeStep(resolved);
                const removeHighlight = await this._previewStep(resolved);
                const handler = actions[resolved.type];
                if (!handler) {
                    this.onLog({ level: 'warn', step: resolved, message: `未知动作类型：${resolved.type}` });
                    removeHighlight();
                    continue;
                }
                try {
                    const result = await handler(resolved.params || {}, resolved.options || {}, ctx, runSteps);
                    ctx.results.push({ step: resolved, result, ok: true });
                    await this.onAfterStep(resolved, { ok: true, result });
                } catch (err) {
                    ctx.results.push({ step: resolved, error: err.message, ok: false });
                    await this.onAfterStep(resolved, { ok: false, error: err.message });
                    const policy = (resolved.options && resolved.options.onFail) || 'stop';
                    await this.onError(resolved, err);
                    removeHighlight();
                    if (policy === 'stop') throw err;
                    if (policy === 'skip') continue;
                }
                removeHighlight();
                if (this.mode === 'debug') {
                    await new Promise(r => setTimeout(r, 0));
                }
                if (idx < steps.length - 1 && this.stepDelay > 0) {
                    await sleep(this.stepDelay);
                }
            }
        };
        await runSteps(script.steps || []);
        return ctx;
    }
}

export const utils = { sleep, isVisible, interpolate, waitForElement, collectInteractiveElements, collectInteractiveElementsAsync };

// 暴露到 window 供导出的独立 JS 脚本使用
if (typeof window !== 'undefined') {
    window.WebChatExecutor = { ScriptExecutor, actions, utils };
}

export default { ScriptExecutor, actions, utils };
