// 多策略定位器：仿 selenium-ide 的注册式 LocatorBuilders
// 录制时一次性产出 [locator, builderName][]，回放时按顺序尝试，第一个命中即用
// locator 形如：
//   id=foo
//   name=bar
//   css=.foo > .bar
//   xpath=//div[@id='x']
//   linkText=点我
import { finder } from '@medv/finder';

const SCRIPT_UI_PREFIX = 'webchat-script-';
const AI_ASSISTANT_IDS = ['ai-assistant-ball', 'ai-assistant-dialog'];

export function isWebChatElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const id = el.id || '';
    if (AI_ASSISTANT_IDS.includes(id)) return true;
    if (id.startsWith(SCRIPT_UI_PREFIX)) return true;
    const cls = el.className || '';
    if (typeof cls === 'string' && (cls.includes('webchat-script-') || cls.includes('ball-container'))) return true;
    return !!(el.closest && (
        el.closest('#ai-assistant-ball') ||
        el.closest('#ai-assistant-dialog') ||
        el.closest('[id^="webchat-script-"]')
    ));
}

export function cssEscape(str) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(str);
    return String(str).replace(/([!"#$%&'()*+,./:;<=>?@\[\\\]^`{|}~])/g, '\\$1');
}

// ====== 解析 / 查找 ======

export function parseLocator(loc) {
    if (!loc) return null;
    const m = String(loc).match(/^([A-Za-z][A-Za-z0-9_:-]*)=([\s\S]+)$/);
    if (m) return { type: m[1], string: m[2] };
    // 无前缀：兼容旧脚本里裸 CSS 选择器
    if (loc.startsWith('/') || loc.startsWith('(')) return { type: 'xpath', string: loc };
    return { type: 'css', string: loc };
}

export function findElement(loc, doc = document) {
    const parsed = parseLocator(loc);
    if (!parsed) return null;
    const { type, string } = parsed;
    try {
        switch (type) {
            case 'id':
                return doc.getElementById(string);
            case 'name': {
                const els = doc.getElementsByName(string);
                return els && els.length ? els[0] : null;
            }
            case 'linkText':
            case 'link': {
                const anchors = doc.querySelectorAll('a');
                for (const a of anchors) {
                    if ((a.textContent || '').replace(/\s+/g, ' ').trim() === string) return a;
                }
                return null;
            }
            case 'partialLinkText': {
                const anchors = doc.querySelectorAll('a');
                for (const a of anchors) {
                    if ((a.textContent || '').includes(string)) return a;
                }
                return null;
            }
            case 'css':
                return doc.querySelector(string);
            case 'xpath': {
                const r = doc.evaluate(string, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                return r.singleNodeValue || null;
            }
            default:
                // 形如 css:data-test-id / xpath:idRelative —— 截 type 前缀
                if (type.startsWith('css')) return doc.querySelector(string);
                if (type.startsWith('xpath')) {
                    const r = doc.evaluate(string, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    return r.singleNodeValue || null;
                }
                return doc.querySelector(string);
        }
    } catch (e) {
        return null;
    }
}

// 按 [locator, builderName] 数组顺序尝试
export function findFromTargets(targets, doc = document) {
    if (!Array.isArray(targets)) return null;
    for (const item of targets) {
        const loc = Array.isArray(item) ? item[0] : item;
        const el = findElement(loc, doc);
        if (el) return el;
    }
    return null;
}

// ====== 工具：xpath 编码 / 节点序号 / 精确化 ======

function attributeValue(value) {
    const v = String(value);
    if (v.indexOf("'") < 0) return `'${v}'`;
    if (v.indexOf('"') < 0) return `"${v}"`;
    // 同时含单双引号 → concat()
    let result = 'concat(';
    let rest = v;
    let first = true;
    while (rest.length > 0) {
        const apos = rest.indexOf("'");
        const quot = rest.indexOf('"');
        let part;
        if (apos < 0) { part = `'${rest}'`; rest = ''; }
        else if (quot < 0) { part = `"${rest}"`; rest = ''; }
        else if (quot < apos) { part = `'${rest.substring(0, quot)}'`; rest = rest.substring(quot); }
        else { part = `"${rest.substring(0, apos)}"`; rest = rest.substring(apos); }
        result += (first ? '' : ',') + part;
        first = false;
    }
    return result + ')';
}

function xpathHtmlElement(name) {
    if (document.contentType === 'application/xhtml+xml') return 'x:' + name;
    return name;
}

function getNodeIndex(el) {
    const siblings = el.parentNode?.childNodes || [];
    let total = 0, index = -1;
    for (let i = 0; i < siblings.length; i++) {
        const c = siblings[i];
        if (c.nodeName === el.nodeName) {
            if (c === el) index = total;
            total++;
        }
    }
    return total > 1 ? index : -1; // 只一个就不需要下标
}

function relativeXPathFromParent(current) {
    const idx = getNodeIndex(current);
    let part = '/' + xpathHtmlElement(current.nodeName.toLowerCase());
    if (idx >= 0) part += `[${idx + 1}]`;
    return part;
}

function preciseXPath(xpath, el) {
    if (findElement('xpath=' + xpath) === el) return 'xpath=' + xpath;
    try {
        const r = el.ownerDocument.evaluate(
            xpath, el.ownerDocument, null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
        );
        for (let i = 0, len = r.snapshotLength; i < len; i++) {
            const candidate = `xpath=(${xpath})[${i + 1}]`;
            if (findElement(candidate) === el) return candidate;
        }
    } catch (e) { /* ignore */ }
    return 'xpath=' + xpath;
}

// ====== 注册式 builder ======

const builders = []; // [{ name, fn }]
const order = [];    // 默认优先级
const builderMap = {};

function add(name, fn) {
    builders.push({ name, fn });
    order.push(name);
    builderMap[name] = fn;
}

// id
add('id', (e) => {
    if (e.id && !/\s/.test(e.id)) return 'id=' + e.id;
    return null;
});

// css:data-test-id
add('css:data-test-id', (e) => {
    const attrs = ['data-test-id', 'data-testid', 'data-test', 'data-cy', 'data-qa'];
    for (const a of attrs) {
        const v = e.getAttribute && e.getAttribute(a);
        if (v) return `css=[${a}="${String(v).replace(/"/g, '\\"')}"]`;
    }
    return null;
});

// linkText (anchor only)
add('linkText', (e) => {
    if (e.nodeName !== 'A') return null;
    const text = (e.textContent || '').replace(/\xA0/g, ' ').trim();
    if (!text) return null;
    return 'linkText=' + text;
});

// name
add('name', (e) => {
    const n = e.getAttribute && e.getAttribute('name');
    if (!n) return null;
    return 'name=' + n;
});

// css:data-attr
add('css:data-attr', (e) => {
    const ds = e.dataset || {};
    const keys = Object.keys(ds);
    if (!keys.length) return null;
    const attr = keys[0];
    const value = ds[attr];
    const htmlAttr = 'data-' + attr.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    if (!value || value === 'true') return `css=[${htmlAttr}]`;
    return `css=[${htmlAttr}="${String(value).replace(/"/g, '\\"')}"]`;
});

// aria-label
add('css:aria-label', (e) => {
    const v = e.getAttribute && e.getAttribute('aria-label');
    if (!v) return null;
    return `css=${e.tagName.toLowerCase()}[aria-label="${String(v).replace(/"/g, '\\"')}"]`;
});

// role + name (按 aria-label / textContent 任一即可)
add('css:role', (e) => {
    const role = e.getAttribute && e.getAttribute('role');
    if (!role) return null;
    return `css=[role="${String(role).replace(/"/g, '\\"')}"]`;
});

// css:title —— 例：ant-select option 在外层 div 上有 title="中"，比 active 类稳
add('css:title', (e) => {
    const t = e.getAttribute && e.getAttribute('title');
    if (!t || t.length > 60) return null;
    const tag = e.tagName.toLowerCase();
    return `css=${tag}[title="${String(t).replace(/"/g, '\\"')}"]`;
});

// ant-design 表单控件：按左侧 label 锚定到当前 form-item 内的具体控件。
// 这比 .ant-select-selector / .ant-picker 这种全局重复类稳定得多。
add('xpath:ant-form-label-control', (e) => {
    const item = e.closest && e.closest('.ant-form-item');
    if (!item) return null;
    const label = item.querySelector('.ant-form-item-label label, label');
    const labelText = (label?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!labelText || labelText.length > 60) return null;

    const controlPath = antControlPath(e, item);
    if (!controlPath) return null;

    const xp = `//div[contains(@class,'ant-form-item')][.//label[normalize-space(.)=${attributeValue(labelText)}]]${controlPath}`;
    return preciseXPath(xp, e);
});

function antControlPath(e, item) {
    const control = item.querySelector('.ant-form-item-control');
    if (!control || !control.contains(e)) return null;

    if (e.matches('.ant-select-selector')) return `//*[contains(@class,'ant-select-selector')]`;
    if (e.matches('.ant-picker')) return `//*[contains(concat(' ', normalize-space(@class), ' '),' ant-picker ') and not(contains(@class,'ant-picker-dropdown'))]`;
    if (e.matches('.ant-upload, .ant-upload-wrapper')) return `//*[contains(@class,'ant-upload')]`;
    if (e.matches('.ant-radio-group')) return `//*[contains(@class,'ant-radio-group')]`;
    if (e.matches('.ant-checkbox-wrapper')) return `//*[contains(@class,'ant-checkbox-wrapper')]`;
    if (e.matches('button')) return `//button`;

    const tag = xpathHtmlElement(e.nodeName.toLowerCase());
    if (e.id && !isUnstableId(e.id)) return `//${tag}[@id=${attributeValue(e.id)}]`;
    const placeholder = e.getAttribute && e.getAttribute('placeholder');
    if (placeholder) return `//${tag}[@placeholder=${attributeValue(placeholder)}]`;
    const role = e.getAttribute && e.getAttribute('role');
    if (role) return `//${tag}[@role=${attributeValue(role)}]`;
    return null;
}

// ant-design 日期/时间范围选择器常把可点击内容放在 td 内层 div 上，真正稳定的日期在祖先 td[title]。
// 优先生成 td[title="YYYY-MM-DD"]，避免录到 range-start/range-end/active 这类状态 class。
add('css:date-cell-title', (e) => {
    const cell = e.closest && e.closest('td[title]');
    if (!cell) return null;
    const t = cell.getAttribute('title');
    if (!t || t.length > 60) return null;
    return `css=td[title="${String(t).replace(/"/g, '\\"')}"]`;
});

// 检测最近的 popup / portal / dropdown 祖先，返回该容器的稳定类锚点 (eg .ant-select-dropdown)
// 这类容器一般 portal 到 body 末尾，div 序号每次都变，所以必须按 class 锚而不是 nth-of-type
const POPUP_CLASS_RE = /(^|\s)(ant-[a-z-]+-(dropdown|popup|popover|tooltip)|ant-picker-dropdown|el-(select|picker|dropdown|popover|popper)-?[a-z-]*|rc-virtual-list|MuiPopover-|MuiMenu-)/i;
function findPopupAncestor(el) {
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
        const cls = (cur.className && typeof cur.className === 'string') ? cur.className : '';
        if (cls && POPUP_CLASS_RE.test(cls)) {
            // 挑稳定的：匹配 POPUP_CLASS_RE 且不含 stateful（hidden/open/placement-* 等）
            const tokens = cls.split(/\s+/).filter(Boolean)
                .filter(t => POPUP_CLASS_RE.test(t))
                .filter(t => !isStatefulClass(t) && !/-(placement|position|align)-/.test(t));
            if (tokens.length) {
                // 最短的更通用
                tokens.sort((a, b) => a.length - b.length);
                return { node: cur, klass: tokens[0] };
            }
        }
        cur = cur.parentElement;
    }
    return null;
}

// xpath:innerText:scoped —— 锚到最近的 popup/dropdown 容器，对 ant-design / element-plus 这种动态 portal 有救
// 例：xpath=//div[contains(@class,'ant-select-dropdown')]//div[normalize-space(.)='资源滥用']
add('xpath:innerText:scoped', (e) => {
    const text = (e.innerText || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 30) return null;
    const ancestor = findPopupAncestor(e);
    if (!ancestor) return null;
    const tag = xpathHtmlElement(e.nodeName.toLowerCase());
    const isLeaf = !Array.from(e.children || []).length;
    const eq = isLeaf
        ? `normalize-space(.)=${attributeValue(text)}`
        : `contains(normalize-space(.),${attributeValue(text)})`;
    const xp = `//div[contains(@class,${attributeValue(ancestor.klass)})]//${tag}[${eq}]`;
    const built = preciseXPath(xp, e);
    if (findElement(built) === e) return built;
    return null;
});

// xpath:innerText —— 含直接文本的可读 xpath（叶子节点优先）
// 提到 finder 之前是因为对动态 UI（ant-select / DatePicker / 菜单）按文字找最准
add('xpath:innerText', (e) => {
    const text = (e.innerText || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 30) return null;
    // 叶子节点（无元素子节点）才用精确等于；非叶子用 contains 容错
    const isLeaf = !Array.from(e.children || []).length;
    const xp = isLeaf
        ? `//${xpathHtmlElement(e.nodeName.toLowerCase())}[normalize-space(.)=${attributeValue(text)}]`
        : `//${xpathHtmlElement(e.nodeName.toLowerCase())}[contains(normalize-space(.),${attributeValue(text)})]`;
    const built = preciseXPath(xp, e);
    if (findElement(built) === e) return built;
    return null;
});

// xpath:innerText:any —— 不加下标，全局第一个匹配。对 popup 已关闭只剩一处文字的回放最稳
add('xpath:innerText:any', (e) => {
    const text = (e.innerText || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 30) return null;
    const tag = xpathHtmlElement(e.nodeName.toLowerCase());
    const isLeaf = !Array.from(e.children || []).length;
    const xp = isLeaf
        ? `xpath=//${tag}[normalize-space(.)=${attributeValue(text)}]`
        : `xpath=//${tag}[contains(normalize-space(.),${attributeValue(text)})]`;
    // 不要求回找命中（findFirst 命中谁都行）；buildAll 那边的回找校验会决定要不要保留
    return xp;
});

// css:finder —— 用 @medv/finder 评分式生成
// 注意：必须屏蔽所有 stateful class（active/hover/focus/selected/open 等），
// 否则在 ant-design / element-plus 这种动态 UI 里录到的就是"当前高亮项"，
// 回放时高亮位置变了就命中错元素（典型：select 下拉默认 active 第一项）
const STATEFUL_CLASS_RE = [
    /(^|-)active$/i, /(^|-)hover(ed|ing)?$/i,
    /(^|-)focus(ed|-visible|-within)?$/i,
    /(^|-)selected$/i, /(^|-)checked$/i,
    /(^|-)open(ed)?$/i, /(^|-)expanded$/i, /(^|-)collapsed$/i,
    /(^|-)disabled$/i, /(^|-)loading$/i,
    /(^|-)error(ed)?$/i, /(^|-)invalid$/i, /(^|-)valid$/i,
    /(^|-)dragging$/i, /(^|-)draggable-over$/i,
    /(^|-)current$/i, /(^|-)now$/i, /(^|-)today$/i,
    /^is-/i, /^has-/i,
    // ant-design / element-plus 状态后缀
    /^ant-.*-(active|selected|focused|hover|open|disabled|loading|error|highlight)$/i,
    /^ant-picker-cell-(range-start|range-end|in-range|range-hover|today)$/i,
    /^el-.*-(active|selected|focus|hover|open|disabled|loading|highlight)$/i
];
function isStatefulClass(name) {
    if (!name) return false;
    return STATEFUL_CLASS_RE.some(re => re.test(name));
}

// 自动生成的 id（如 react/hooks 的 :r1: / __next_id__123）也别用
const UNSTABLE_ID_RE = /^[a-z]+-\d+$|^:r[0-9a-z]+:$|^id-\d+$|^__|\d{4,}/i;
function isUnstableId(name) {
    return !!name && UNSTABLE_ID_RE.test(name);
}

add('css:finder', (e) => {
    try {
        const sel = finder(e, {
            root: document.body,
            seedMinLength: 1,
            optimizedMinLength: 2,
            attr: () => false,
            className: (name) => !isStatefulClass(name),
            idName: (name) => !isUnstableId(name)
        });
        return 'css=' + sel;
    } catch (err) {
        return null;
    }
});

// xpath:link (含部分文字的 a)
add('xpath:link', (e) => {
    if (e.nodeName !== 'A') return null;
    const text = (e.textContent || '').trim();
    if (!text) return null;
    return preciseXPath(`//${xpathHtmlElement('a')}[contains(text(),${attributeValue(text)})]`, e);
});

// xpath:img
add('xpath:img', (e) => {
    if (e.nodeName !== 'IMG') return null;
    if (e.alt) return preciseXPath(`//${xpathHtmlElement('img')}[@alt=${attributeValue(e.alt)}]`, e);
    if (e.title) return preciseXPath(`//${xpathHtmlElement('img')}[@title=${attributeValue(e.title)}]`, e);
    if (e.src) return preciseXPath(`//${xpathHtmlElement('img')}[contains(@src,${attributeValue(e.src)})]`, e);
    return null;
});

// xpath:attributes —— 优选 id/name/value/type/action/onclick
add('xpath:attributes', (e) => {
    const PREFER = ['id', 'name', 'value', 'type', 'action', 'onclick'];
    if (!e.attributes) return null;
    const map = {};
    for (let i = 0; i < e.attributes.length; i++) {
        const a = e.attributes[i];
        map[a.name] = a.value;
    }
    const tagName = e.nodeName.toLowerCase();
    const used = [];
    for (const name of PREFER) {
        if (map[name] != null) {
            used.push(name);
            const conds = used.map((n) => `@${n}=${attributeValue(map[n])}`);
            if (e.textContent && name === 'type') {
                conds.push(`text()=${attributeValue(e.textContent)}`);
            }
            const xp = `//${xpathHtmlElement(tagName)}[${conds.join(' and ')}]`;
            const built = preciseXPath(xp, e);
            if (findElement(built) === e) return built;
        }
    }
    return null;
});

// xpath:idRelative —— 沿父级走到最近的 id 锚点
add('xpath:idRelative', (e) => {
    let path = '';
    let current = e;
    while (current && current.parentNode) {
        path = relativeXPathFromParent(current) + path;
        const parent = current.parentNode;
        if (parent.nodeType === 1 && parent.getAttribute && parent.getAttribute('id')) {
            const idVal = parent.getAttribute('id');
            const xp = `//${xpathHtmlElement(parent.nodeName.toLowerCase())}[@id=${attributeValue(idVal)}]${path}`;
            return preciseXPath(xp, e);
        }
        current = parent;
    }
    return null;
});

// xpath:href
add('xpath:href', (e) => {
    if (!e.hasAttribute || !e.hasAttribute('href')) return null;
    const href = e.getAttribute('href');
    const isAbs = /^https?:\/\//.test(href);
    const xp = isAbs
        ? `//${xpathHtmlElement('a')}[@href=${attributeValue(href)}]`
        : `//${xpathHtmlElement('a')}[contains(@href,${attributeValue(href)})]`;
    return preciseXPath(xp, e);
});

// xpath:position —— 兜底完整路径
add('xpath:position', (e) => {
    let path = '';
    let current = e;
    while (current && current.parentNode) {
        path = relativeXPathFromParent(current) + path;
        const built = 'xpath=/' + path.replace(/^\//, '');
        if (findElement(built) === e) return built;
        current = current.parentNode;
        if (!current || current.nodeType !== 1) break;
    }
    return null;
});

// ====== 公共 API ======

/**
 * 录制器调用：返回 [[locator, builderName], ...] —— 已校验回找命中元素
 */
export function buildAll(el) {
    if (!el || el.nodeType !== 1) return [];
    const out = [];
    for (const { name, fn } of builders) {
        try {
            const loc = fn(el);
            if (!loc) continue;
            // 校验：解析 + 回找必须命中同一元素
            const found = findElement(loc);
            if (found === el) out.push([loc, name]);
        } catch (e) { /* ignore one builder */ }
    }
    return out;
}

/** 录制器调用：单个最优 locator（出错则返回 LOCATOR_DETECTION_FAILED） */
export function build(el) {
    const all = buildAll(el);
    return all.length ? all[0][0] : 'LOCATOR_DETECTION_FAILED';
}

export const LOCATOR_BUILDER_ORDER = order.slice();

export default {
    build,
    buildAll,
    findElement,
    findFromTargets,
    parseLocator,
    cssEscape,
    isWebChatElement,
    LOCATOR_BUILDER_ORDER
};
