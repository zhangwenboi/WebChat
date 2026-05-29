// 页面元素选取器：高亮悬停元素 + 显示候选 locator + Shift+点击挑选 primary
import Selector from './selector-generator.js';

class ElementPicker {
    constructor() {
        this.active = false;
        this.overlay = null;
        this.tooltip = null;
        this.popup = null;
        this.lastHovered = null;
        this.callback = null;
        this._handlers = {};
        this._currentTargets = null; // 悬停元素当前的 [[locator, name], ...]
    }

    start(callback) {
        if (this.active) return;
        this.active = true;
        this.callback = callback;

        this.overlay = document.createElement('div');
        this.overlay.id = 'webchat-script-picker-overlay';
        document.body.appendChild(this.overlay);

        this.tooltip = document.createElement('div');
        this.tooltip.id = 'webchat-script-picker-tooltip';
        document.body.appendChild(this.tooltip);

        this._handlers.move = (e) => this._onMove(e);
        this._handlers.click = (e) => this._onClick(e);
        this._handlers.mousedown = (e) => this._onMouseDown(e);
        this._handlers.key = (e) => this._onKey(e);

        document.addEventListener('mousemove', this._handlers.move, true);
        document.addEventListener('mousedown', this._handlers.mousedown, true);
        document.addEventListener('click', this._handlers.click, true);
        document.addEventListener('keydown', this._handlers.key, true);
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        document.removeEventListener('mousemove', this._handlers.move, true);
        document.removeEventListener('mousedown', this._handlers.mousedown, true);
        document.removeEventListener('click', this._handlers.click, true);
        document.removeEventListener('keydown', this._handlers.key, true);
        if (this.overlay) this.overlay.remove();
        if (this.tooltip) this.tooltip.remove();
        if (this.popup) this.popup.remove();
        this.overlay = null;
        this.tooltip = null;
        this.popup = null;
        this.lastHovered = null;
        this._currentTargets = null;
    }

    _onMove(e) {
        // popup 打开时不再跟随鼠标移动
        if (this.popup) return;
        const target = document.elementFromPoint(e.clientX, e.clientY);
        if (!target || target === this.overlay || target === this.tooltip) return;
        if (Selector.isWebChatElement(target)) {
            this.overlay.style.display = 'none';
            this.tooltip.style.display = 'none';
            return;
        }
        this.lastHovered = target;
        const rect = target.getBoundingClientRect();
        this.overlay.style.display = 'block';
        this.overlay.style.left = `${rect.left + window.scrollX}px`;
        this.overlay.style.top = `${rect.top + window.scrollY}px`;
        this.overlay.style.width = `${rect.width}px`;
        this.overlay.style.height = `${rect.height}px`;

        const sel = Selector.generate(target);
        this._currentTargets = sel.targets || [];
        const total = this._currentTargets.length;
        const head = sel.primary || sel.xpath || '(无法生成选择器)';
        const extra = total > 1 ? ` ｜ +${total - 1} 候选 (Shift+点击查看)` : '';
        this.tooltip.style.display = 'block';
        this.tooltip.style.left = `${rect.left + window.scrollX}px`;
        this.tooltip.style.top = `${rect.bottom + window.scrollY + 4}px`;
        this.tooltip.textContent = head + extra;
    }

    _onMouseDown(e) {
        // popup 打开时拦掉所有 mousedown，避免页面元素抢焦点导致 popup 被关闭
        if (!this.active) return;
        if (this.popup && this.popup.contains(e.target)) {
            // 落在 popup 内部的 mousedown：阻止冒泡给页面，但不阻止 popup 自己接收
            e.stopPropagation();
            e.stopImmediatePropagation();
            return;
        }
        // 选取过程中页面其他位置的 mousedown 也吃掉，避免触发页面 focus/blur
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }

    _onClick(e) {
        if (!this.active) return;

        // popup 已打开：捕获阶段先于任何页面监听器触发，统一在这里分流
        if (this.popup) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const li = e.target.closest && e.target.closest('#webchat-script-picker-popup li[data-idx]');
            if (li) {
                const idx = Number(li.dataset.idx);
                const target = this.lastHovered;
                this._finish(target, idx);
                return;
            }
            // 点在 popup 内部其他区域（标题/底注）：忽略，等用户继续选
            if (this.popup.contains(e.target)) return;
            // 点在 popup 外：关闭 popup，回到悬停选择状态，不 finish
            this.popup.remove();
            this.popup = null;
            return;
        }

        if (!this.lastHovered) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (e.shiftKey && this._currentTargets && this._currentTargets.length > 1) {
            this._showPopup(this.lastHovered, this._currentTargets);
            return;
        }

        this._finish(this.lastHovered, null);
    }

    _showPopup(target, targets) {
        const rect = target.getBoundingClientRect();
        const popup = document.createElement('div');
        popup.id = 'webchat-script-picker-popup';
        popup.style.left = `${rect.left + window.scrollX}px`;
        popup.style.top = `${rect.bottom + window.scrollY + 4}px`;
        popup.innerHTML = `
            <div class="wc-pick-pop-title">挑选要作为 primary 的 locator</div>
            <ul class="wc-pick-pop-list">
                ${targets.map(([loc, name], i) => `
                    <li data-idx="${i}" tabindex="0">
                        <span class="wc-pick-pop-tag">${escapeHtml(name)}</span>
                        <code>${escapeHtml(loc)}</code>
                    </li>
                `).join('')}
            </ul>
            <div class="wc-pick-pop-foot">Esc 取消 ｜ 点击候选项即应用 ｜ 点击外部关闭</div>
        `;
        document.body.appendChild(popup);
        this.popup = popup;
    }

    _finish(target, primaryIdx) {
        const sel = Selector.generate(target);
        let targets = sel.targets || [];
        // 用户挑选了某条候选时，把它放到首位
        if (primaryIdx != null && primaryIdx > 0 && primaryIdx < targets.length) {
            const picked = targets[primaryIdx];
            targets = [picked, ...targets.filter((_, i) => i !== primaryIdx)];
        }
        const cb = this.callback;
        this.stop();
        if (cb) cb({
            selector: sel.primary,
            fallbacks: sel.fallbacks,
            xpath: sel.xpath,
            targets,
            element: target
        });
    }

    _onKey(e) {
        if (e.key === 'Escape') {
            const cb = this.callback;
            this.stop();
            if (cb) cb(null);
        }
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
}

export default new ElementPicker();
