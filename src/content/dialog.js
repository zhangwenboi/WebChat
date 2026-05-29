// 对话框容器：DOM 创建 + 拖动 + 边角缩放 + 位置/尺寸持久化 + 点击外部自动隐藏

const ICONS = {
    clear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>',
    export: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>',
    sidebar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="M7 9h4"/><path d="M7 13h4"/></svg>',
    shot: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3"/><path d="M16 4h3a1 1 0 0 1 1 1v3"/><path d="M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M8 20H5a1 1 0 0 1-1-1v-3"/><circle cx="12" cy="12" r="3"/></svg>',
    image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="2"/><path d="M21 16l-5-5L5 19"/></svg>',
    clearImages: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M10 11v5"/><path d="M14 11v5"/><path d="M19 6l-1 14H6L5 6"/></svg>'
};

const DIALOG_HTML = `
    <div class="container">
        <div class="header">
            <div class="tokens-counter">Tokens: 0</div>
            <div class="header-actions">
                <button class="header-btn" id="clearChatBtn" title="Clear chat" aria-label="Clear chat">${ICONS.clear}</button>
                <button class="header-btn" id="exportChatBtn" title="Export chat" aria-label="Export chat">${ICONS.export}</button>
                <button class="header-btn" id="sidebarToggleBtn" title="Toggle sidebar" aria-label="Toggle sidebar">${ICONS.sidebar}</button>
            </div>
        </div>
        <div id="chat-container" class="chat-container">
            <div id="messages" class="messages"></div>
        </div>
        <div class="input-container">
            <div id="markedImagesStrip" class="marked-images-strip" hidden></div>
            <div id="mentionDropdown" class="mention-dropdown" hidden></div>
            <textarea id="userInput" placeholder="可以使用 @ 引用其他 tab..." rows="2"></textarea>
            <div class="input-toolbar">
                <button class="toolbar-btn" id="regionShotBtn" type="button" title="Region screenshot" aria-label="Region screenshot">${ICONS.shot}</button>
                <button class="toolbar-btn" id="attachImageBtn" type="button" title="Attach image" aria-label="Attach image">${ICONS.image}</button>
                <button class="toolbar-btn" id="clearMarkedImagesBtn" type="button" title="Clear images" aria-label="Clear images" hidden>${ICONS.clearImages}</button>
            </div>
            <input id="imageFileInput" type="file" accept="image/*" multiple hidden>
            <button id="askButton" class="send-button"></button>
        </div>
    </div>
    <div class="resize-handle"></div>
`;

const MIN_WIDTH = 300;
const MIN_HEIGHT = 400;

// 拖动 header 改变对话框位置；用遮罩层避免 iframe 抢占 mousemove
function enableDragging(dialog) {
    const header = dialog.querySelector('.header');

    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    document.body.appendChild(overlay);

    let isDragging = false;
    let initialX = 0;
    let initialY = 0;
    let frame = null;

    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('.toggle-ball')) return;
        // 侧边栏模式下不允许通过 header 拖动改变位置
        if (dialog.dataset.mode && dialog.dataset.mode !== 'floating') return;
        isDragging = true;
        dialog.style.transition = 'none';
        const rect = dialog.getBoundingClientRect();
        initialX = e.clientX - rect.left;
        initialY = e.clientY - rect.top;
        overlay.classList.add('dragging');
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            let x = e.clientX - initialX;
            let y = e.clientY - initialY;
            const maxX = window.innerWidth - dialog.offsetWidth;
            const maxY = window.innerHeight - dialog.offsetHeight;
            x = Math.max(0, Math.min(x, maxX));
            y = Math.max(0, Math.min(y, maxY));
            dialog.style.left = `${x}px`;
            dialog.style.top = `${y}px`;
        });
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        dialog.style.transition = '';
        overlay.classList.remove('dragging');
        if (frame) cancelAnimationFrame(frame);

        chrome.storage.sync.set({
            dialogPosition: {
                left: dialog.style.left,
                top: dialog.style.top,
                isCustomPosition: true
            }
        });
    });

    chrome.storage.sync.get({
        dialogPosition: { left: 'auto', top: 'auto', isCustomPosition: false }
    }, (items) => {
        if (items.dialogPosition.isCustomPosition) {
            dialog.style.left = items.dialogPosition.left;
            dialog.style.top = items.dialogPosition.top;
        }
    });
}

function enableResizing(dialog) {
    const handle = dialog.querySelector('.resize-handle');

    let isResizing = false;
    let startW = 0;
    let startH = 0;
    let startX = 0;
    let startY = 0;
    let frame = null;

    function onMove(e) {
        if (!isResizing) return;
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            const newW = Math.max(MIN_WIDTH, startW + (e.clientX - startX));
            const newH = Math.max(MIN_HEIGHT, startH + (e.clientY - startY));
            const rect = dialog.getBoundingClientRect();
            const maxW = window.innerWidth - rect.left - 20;
            const maxH = window.innerHeight - rect.top - 20;
            const w = Math.min(newW, maxW);
            const h = Math.min(newH, maxH);
            dialog.style.width = `${w}px`;
            dialog.style.height = `${h}px`;
            chrome.storage.sync.set({ dialogSize: { width: w, height: h } });
        });
    }

    function onUp() {
        if (!isResizing) return;
        isResizing = false;
        dialog.style.transition = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (frame) cancelAnimationFrame(frame);
    }

    handle.addEventListener('mousedown', (e) => {
        if (dialog.dataset.mode && dialog.dataset.mode !== 'floating') return;
        isResizing = true;
        dialog.style.transition = 'none';
        startW = dialog.offsetWidth;
        startH = dialog.offsetHeight;
        startX = e.clientX;
        startY = e.clientY;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
        e.stopPropagation();
    });

    chrome.storage.sync.get({
        dialogSize: { width: 400, height: 500 }
    }, (items) => {
        // 仅浮动模式应用持久化尺寸；侧边栏模式由 applyDisplayMode 控制
        if (dialog.dataset.mode && dialog.dataset.mode !== 'floating') return;
        dialog.style.width = `${items.dialogSize.width}px`;
        dialog.style.height = `${items.dialogSize.height}px`;
    });
}

// 点击对话框、悬浮球、右键菜单、@ 下拉之外时，按设置自动收起
function enableClickOutsideToClose(dialog) {
    document.addEventListener('mousedown', async (e) => {
        const ball = document.getElementById('ai-assistant-ball');
        const contextMenu = document.querySelector('.context-menu');

        // 用 composedPath 识别已经被脚本移除的祖先，避免点击 @ 下拉项后误判为外部点击
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        const fromMention = path.some(n => n && n.classList && (
            n.classList.contains('mention-dropdown') ||
            n.classList.contains('mention-row')
        ));
        if (fromMention) return;

        const settings = await chrome.storage.sync.get({ autoHideDialog: true });

        if (settings.autoHideDialog &&
            dialog.classList.contains('show') &&
            !dialog.contains(e.target) &&
            (!ball || !ball.contains(e.target)) &&
            (!contextMenu || !contextMenu.contains(e.target))) {
            dialog.classList.remove('show');
        }
    });
}

// 应用显示模式：floating / sidebar-left / sidebar-right
function applyDisplayMode(dialog, mode, width) {
    const valid = ['floating', 'sidebar-left', 'sidebar-right'];
    const m = valid.includes(mode) ? mode : 'floating';
    dialog.dataset.mode = m;

    document.body.classList.remove('webchat-sidebar-left', 'webchat-sidebar-right');
    if (m === 'sidebar-left' || m === 'sidebar-right') {
        const w = Math.max(280, Math.min(720, parseInt(width) || 380));
        document.body.style.setProperty('--webchat-sidebar-w', w + 'px');
        dialog.style.width = w + 'px';
        // 侧边栏模式下清掉浮动模式的内联 left/top/height，避免覆盖 CSS 布局
        dialog.style.left = '';
        dialog.style.top = '';
        dialog.style.height = '';
        document.body.classList.add('webchat-' + m);
    } else {
        document.body.style.removeProperty('--webchat-sidebar-w');
    }
}

function watchDisplayModeChanges(dialog) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.displayMode || changes.sidebarWidth) {
            chrome.storage.sync.get({
                displayMode: 'floating',
                sidebarWidth: 380
            }, (s) => applyDisplayMode(dialog, s.displayMode, s.sidebarWidth));
        }
    });
}

function bindSidebarToggle(dialog) {
    const toggle = dialog.querySelector('#sidebarToggleBtn');
    toggle?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const current = dialog.dataset.mode || 'floating';
        const next = current === 'sidebar-right' ? 'floating' : 'sidebar-right';
        chrome.storage.sync.set({ displayMode: next });
    });
}

export function createDialog() {
    document.getElementById('ai-assistant-dialog')?.remove();

    const dialog = document.createElement('div');
    dialog.id = 'ai-assistant-dialog';
    dialog.innerHTML = DIALOG_HTML;

    enableDragging(dialog);
    enableResizing(dialog);
    document.body.appendChild(dialog);
    enableClickOutsideToClose(dialog);
    bindSidebarToggle(dialog);

    // 应用显示模式，并监听设置变化即时切换
    chrome.storage.sync.get({
        displayMode: 'floating',
        sidebarWidth: 380
    }, (s) => applyDisplayMode(dialog, s.displayMode, s.sidebarWidth));
    watchDisplayModeChanges(dialog);

    return dialog;
}
