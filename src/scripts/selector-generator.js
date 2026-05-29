// 选择器生成器 —— 兼容旧 API，内部委托给 locator-builders.js（多策略）
// 旧 API:
//   generateSelector(el) -> { primary, fallbacks, xpath }
//   querySelector(selector, fallbacks) -> Element | null
//   isWebChatElement(el) -> boolean
//   cssEscape(str) -> string
// 新 API:
//   buildAllTargets(el)  -> [[locator, builderName], ...]   // selenium-ide 风格 target 数组
//   findFromTargets(targets) -> Element | null
import {
    buildAll,
    findElement,
    findFromTargets,
    parseLocator,
    cssEscape as lbCssEscape,
    isWebChatElement as lbIsWebChatElement
} from './locator-builders.js';

export const cssEscape = lbCssEscape;
export const isWebChatElement = lbIsWebChatElement;

/** 录制时使用：返回 [[locator, builderName], ...]，每条 locator 形如 id=xxx / css=... / xpath=... */
export function buildAllTargets(el) {
    return buildAll(el);
}

/**
 * 旧 API：返回 { primary, fallbacks, xpath }
 *  - primary：第一条命中的 locator（不带 prefix 时是裸 CSS，带 prefix 时保持 selenium 形式）
 *  - fallbacks：剩余 locator 数组
 *  - xpath：xpath:position 兜底路径（保持原行为）
 *
 * 注意：为了兼容旧脚本的 querySelector(selector, fallbacks) 直接用 doc.querySelector，
 * 我们对 primary/fallbacks 做格式归一：
 *   - id=foo  ->  #foo
 *   - name=bar -> [name="bar"]
 *   - css=...  -> 去掉 css= 前缀
 *   - xpath=.. -> 保留原值，querySelector 时由 query() 自动用 evaluate
 */
function locatorToCssOrXPath(loc) {
    const p = parseLocator(loc);
    if (!p) return loc;
    if (p.type === 'id') return '#' + cssEscape(p.string);
    if (p.type === 'name') return `[name="${p.string.replace(/"/g, '\\"')}"]`;
    if (p.type === 'linkText' || p.type === 'partialLinkText') return loc; // 保留 selenium 形式
    if (p.type === 'css' || p.type.startsWith('css')) return p.string;
    if (p.type === 'xpath' || p.type.startsWith('xpath')) return 'xpath=' + p.string;
    return loc;
}

export function generateSelector(el) {
    if (!el || el.nodeType !== 1) {
        return { primary: null, fallbacks: [], xpath: null };
    }
    const targets = buildAll(el);
    if (!targets.length) return { primary: null, fallbacks: [], xpath: null };

    const cssLike = targets
        .filter(([, name]) => name === 'id' || name.startsWith('css'))
        .map(([loc]) => locatorToCssOrXPath(loc));

    const xpathLike = targets
        .filter(([, name]) => name.startsWith('xpath') || name === 'linkText')
        .map(([loc]) => locatorToCssOrXPath(loc));

    const primary = cssLike[0] || xpathLike[0] || locatorToCssOrXPath(targets[0][0]);
    const seen = new Set([primary]);
    const fallbacks = [];
    for (const c of [...cssLike, ...xpathLike]) {
        if (!seen.has(c)) { seen.add(c); fallbacks.push(c); }
    }
    const xpathTarget = targets.find(([, n]) => n === 'xpath:position') || targets.find(([, n]) => n.startsWith('xpath'));
    const xpath = xpathTarget ? locatorToCssOrXPath(xpathTarget[0]) : null;
    return { primary, fallbacks, xpath, targets };
}

/**
 * 旧 API：兼容裸 CSS 选择器、xpath= 前缀、selenium 风格 locator
 */
export function querySelector(selector, fallbacks = []) {
    const tryOne = (s) => {
        if (!s) return null;
        // selenium 风格：id= / name= / css= / xpath= / linkText=
        if (/^[A-Za-z][A-Za-z0-9_:-]*=/.test(s)) return findElement(s);
        // xpath 裸路径
        if (s.startsWith('/') || s.startsWith('(/')) return findElement('xpath=' + s);
        // 裸 CSS
        try { return document.querySelector(s); } catch (e) { return null; }
    };
    const el = tryOne(selector);
    if (el) return el;
    for (const f of fallbacks) {
        const r = tryOne(f);
        if (r) return r;
    }
    return null;
}

export default {
    generate: generateSelector,
    query: querySelector,
    buildAllTargets,
    findFromTargets,
    isWebChatElement,
    cssEscape
};
