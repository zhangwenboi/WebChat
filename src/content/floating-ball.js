import ScriptPanel from '../scripts/panel.js';
import { createDialog } from './dialog.js';
import { initializeDialog } from './chat-controller.js';

// 悬浮球本体 SVG
const BALL_SVG = `<svg t="1731757557572" class="icon" width="32" height="32" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1317" width="128" height="128">
    <path d="M200 935.744a39.517867 39.517867 0 0 1-14.122667-7.185067c-12.906667-10.295467-18.602667-27.2896-14.741333-43.4688a1295.863467 1295.863467 0 0 0 17.207467-520c-5.6448-33.216 0.418133-66.760533 17.5488-96.443733 17.156267-29.563733 43.498667-51.648 75.656533-60.497067h0.008533l417.591467-114.24c66.0352-19.434667 144.533333 49.792 162.602667 156.258134a1978.666667 1978.666667 0 0 1 27.144533 397.806933c-3.4432 107.592533-71.6928 186.248533-139.758933 176.008533l-64.823467-8.494933c-22.203733-3.042133-36.8768-29.952-33.8944-60.1984 3.008-30.2336 22.664533-53.713067 45.038933-52.343467 21.7472 1.463467 43.485867 2.922667 65.233067 4.3776 24.170667 1.783467 45.969067-26.0096 47.133867-62.007466a1897.941333 1897.941333 0 0 0-26.030934-381.499734c-6.062933-35.618133-31.466667-60.3136-55.168-55.2576l-424.0128 87.466667c-11.4176 2.363733-21.1584 9.570133-27.6096 20.078933-6.4512 10.530133-8.802133 22.993067-6.698666 35.345067a1377.0368 1377.0368 0 0 1 2.346666 449.117867 1341.696 1341.696 0 0 0 118.4512-104.448c8.251733-8.1792 18.862933-12.475733 29.602134-11.758934l293.009066 19.6736c22.340267 1.365333 38.839467 28.650667 35.639467 60.842667-3.1744 32.200533-24.704 55.765333-46.882133 52.7232l-274.5216-35.972267c-62.229333 57.1136-127.6544 106.965333-194.973867 149.384534-9.629867 6.071467-20.8 7.522133-30.976 4.731733z" p-id="1318" fill="white"></path>
    <path d="M635.733333 488.533333m-59.733333 0a59.733333 59.733333 0 1 0 119.466667 0 59.733333 59.733333 0 1 0-119.466667 0Z" p-id="1319" fill="white"></path>
    <path d="M460.864 507.733333m-50.133333 0a50.133333 50.133333 0 1 0 100.266666 0 50.133333 50.133333 0 1 0-100.266666 0Z" p-id="1320" fill="white"></path>
</svg>`;

const SETTINGS_SVG = `<svg t="1731757768104" class="icon" width="24" height="24" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1612" width="128" height="128"><path d="M550.4 924.404h-49.1c-57.7 0-104.6-46.9-104.6-104.6-0.1-7.2-2.1-14.5-5.9-20.9-6.6-11.2-16.3-18.6-27.9-21.7-11.6-3.1-23.7-1.5-34.1 4.6-51.6 28.6-115.3 10.1-143.2-40.4l-24.5-42.2c-0.1-0.1-0.1-0.2-0.2-0.3v-0.1c-28.5-49.8-11.2-113.5 38.5-142 14-8.1 22.8-23.3 22.8-39.5s-8.7-31.4-22.9-39.6c-49.8-28.8-67-92.8-38.3-142.6l26.6-43.8c28.5-49.3 92.5-66.3 142.3-37.7 6.7 4 14.1 6 21.6 6.1h0.1c24.6 0 45.1-20.2 45.4-45.1 0-57.5 46.7-104.2 104-104.2h49.3c61 1.9 106.4 50.3 104.6 107.9 0.1 6.3 2.1 13.6 5.9 20 6.4 10.8 16.2 18.2 27.9 21.2s23.8 1.2 34.2-4.9c50-28.8 114.1-11.7 143 38l24.5 42.5 1.5 3c26.2 49.3 8.8 111.3-39.7 139.6-7.1 4-12.8 9.7-16.7 16.7-6.4 11.1-7.9 23.3-4.7 34.9 3.2 11.6 10.7 21.3 21.2 27.3 25 14.6 42.1 37.1 49.2 64 7.1 26.9 3.2 54.9-10.8 78.9l-26 43.5c-28.7 49.3-92.6 66.5-142.6 37.8-6.6-3.8-14.3-6-22.1-6.2-12 0.1-23.4 4.9-31.8 13.5-8.5 8.6-13.1 20-13 32-0.4 57.7-47.3 104.3-104.5 104.3z m-199.2-207.6c8.9 0 17.9 1.2 26.7 3.5 26.8 7.1 49.3 24.2 63.2 48.2 9.3 15.7 14.2 33.2 14.4 51 0 25.5 20.5 46 45.7 46h49.1c25 0 45.5-20.4 45.7-45.4-0.2-27.4 10.4-53.6 30-73.4 19.5-19.8 45.6-30.8 73.4-31 19.4 0.5 36.6 5.3 51.7 14 21.9 12.5 49.8 5 62.4-16.7l26.1-43.6c5.9-10.1 7.6-22.3 4.5-34-3.1-11.7-10.5-21.4-20.9-27.5-24.6-14-42-36.4-49.3-63.2-7.3-26.8-3.8-54.9 10-79 9.6-16.8 22.9-30.1 38.9-39.2 21.3-12.4 28.8-40.3 16.5-62-0.5-0.8-0.8-1.6-1.2-2.4l-23.2-40.2c-12.5-21.6-40.5-29.2-62.2-16.7-23.6 14-51.6 17.9-78.5 11.1-26.9-6.9-49.5-23.9-63.7-47.8-9.3-15.7-14.2-33.2-14.4-51.1 0.8-26.4-19-47.5-44.2-48.3h-50.8c-24.9 0-45.1 20.3-45.1 45.2-0.8 57.8-47.7 104.1-104.6 104.1h-0.2c-18.1-0.2-35.5-5.1-50.9-14.2-21.5-12.4-49.4-4.8-62 16.9l-26.6 43.7c-12.1 21.1-4.6 49.1 17.1 61.7 32.2 18.6 52.3 53.3 52.3 90.6s-20.1 72-52.3 90.6c-21.7 12.4-29.2 40.1-16.8 61.7 0 0.1 0.1 0.1 0.1 0.2l24.8 42.8c12.5 22.6 40.3 30.6 62.4 18.5 16-9.3 33.8-14.1 51.9-14.1zM525.9 650.204c-73.3 0-133-59.7-133-133s59.7-133 133-133 133 59.7 133 133c0 73.4-59.7 133-133 133z m0-207c-40.8 0-74.1 33.2-74.1 74.1s33.2 74.1 74.1 74.1 74.1-33.2 74.1-74.1-33.3-74.1-74.1-74.1z" p-id="1613" fill="#ffffff"></path></svg>`;

const SCRIPT_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/></svg>';

// 计算对话框相对悬浮球的最佳位置（先尝试左侧，再右侧，再向中央兜底）
function calcDialogPosition(ball, dialog) {
    const ballRect = ball.getBoundingClientRect();
    const ww = window.innerWidth;
    const wh = window.innerHeight;
    const dw = dialog.offsetWidth || 400;
    const dh = dialog.offsetHeight || 500;

    let left = ballRect.left - dw - 20;
    let top = Math.min(ballRect.top, wh - dh - 20);

    if (left < 20) {
        left = ballRect.right + 20;
        if (left + dw > ww - 20) {
            left = ballRect.left > ww / 2 ? 20 : ww - dw - 20;
        }
    }
    if (top < 20) {
        top = Math.min(ballRect.bottom + 20, wh - dh - 20);
    }

    left = Math.max(20, Math.min(left, ww - dw - 20));
    top = Math.max(20, Math.min(top, wh - dh - 20));
    return { left, top };
}

// 拖动悬浮球容器；靠近屏幕边缘时吸附并加 edge-* 类，同步持久化
function enableBallDragging(ball, container) {
    let isDragging = false;
    let initialX = 0;
    let initialY = 0;

    ball.addEventListener('mousedown', (e) => {
        isDragging = true;
        const rect = container.getBoundingClientRect();
        initialX = e.clientX - rect.left;
        initialY = e.clientY - rect.top;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        let x = e.clientX - initialX;
        let y = e.clientY - initialY;

        const maxX = window.innerWidth - container.offsetWidth;
        const maxY = window.innerHeight - container.offsetHeight;
        const edge = ball.offsetWidth / 2;

        ball.classList.remove('edge-left', 'edge-right', 'edge-top', 'edge-bottom');

        let position;
        if (x <= edge) {
            ball.classList.add('edge-left');
            position = { left: '0px', top: `${y}px`, right: 'auto', bottom: 'auto', edge: 'left' };
        } else if (x >= maxX - edge) {
            ball.classList.add('edge-right');
            position = { right: '0px', top: `${y}px`, left: 'auto', bottom: 'auto', edge: 'right' };
        } else if (y <= edge) {
            ball.classList.add('edge-top');
            position = { top: '0px', left: `${x}px`, right: 'auto', bottom: 'auto', edge: 'top' };
        } else if (y >= maxY - edge) {
            ball.classList.add('edge-bottom');
            position = { bottom: '0px', left: `${x}px`, right: 'auto', top: 'auto', edge: 'bottom' };
        } else {
            position = { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto', edge: null };
        }

        Object.assign(container.style, position);
        chrome.storage.sync.set({ ballPosition: position });
    });

    document.addEventListener('mouseup', () => { isDragging = false; });
}

// 启动时根据 storage 还原悬浮球位置，并夹紧到当前可视区域
function restoreBallPosition(ball, container) {
    chrome.storage.sync.get({
        ballPosition: { right: '20px', bottom: '20px', left: 'auto', top: 'auto', edge: null }
    }, (items) => {
        const rect = container.getBoundingClientRect();
        const ww = window.innerWidth;
        const wh = window.innerHeight;

        let position = items.ballPosition;
        let left = position.left !== 'auto' ? parseInt(position.left) : null;
        let right = position.right !== 'auto' ? parseInt(position.right) : null;
        let top = position.top !== 'auto' ? parseInt(position.top) : null;
        let bottom = position.bottom !== 'auto' ? parseInt(position.bottom) : null;

        if (left !== null) {
            left = Math.min(Math.max(0, left), ww - rect.width);
            position = { ...position, left: `${left}px`, right: 'auto' };
        } else if (right !== null) {
            right = Math.min(Math.max(0, right), ww - rect.width);
            position = { ...position, right: `${right}px`, left: 'auto' };
        }

        if (top !== null) {
            top = Math.min(Math.max(0, top), wh - rect.height);
            position = { ...position, top: `${top}px`, bottom: 'auto' };
        } else if (bottom !== null) {
            bottom = Math.min(Math.max(0, bottom), wh - rect.height);
            position = { ...position, bottom: `${bottom}px`, top: 'auto' };
        }

        Object.assign(container.style, position);
        if (position.edge) ball.classList.add(`edge-${position.edge}`);
        chrome.storage.sync.set({ ballPosition: position });
    });
}

// 窗口尺寸变化时把悬浮球拉回可见范围，并重算边缘吸附状态
function bindWindowResize(ball, container) {
    window.addEventListener('resize', () => {
        const rect = container.getBoundingClientRect();
        const ww = window.innerWidth;
        const wh = window.innerHeight;

        let left = Math.max(0, Math.min(rect.left, ww - rect.width));
        let top = Math.max(0, Math.min(rect.top, wh - rect.height));

        const position = {
            left: `${left}px`,
            top: `${top}px`,
            right: 'auto',
            bottom: 'auto',
            edge: null
        };
        Object.assign(container.style, position);

        const edge = ball.offsetWidth / 2;
        ball.classList.remove('edge-left', 'edge-right', 'edge-top', 'edge-bottom');
        if (left <= edge) { ball.classList.add('edge-left'); position.edge = 'left'; }
        else if (left >= ww - rect.width - edge) { ball.classList.add('edge-right'); position.edge = 'right'; }
        if (top <= edge) { ball.classList.add('edge-top'); position.edge = 'top'; }
        else if (top >= wh - rect.height - edge) { ball.classList.add('edge-bottom'); position.edge = 'bottom'; }

        chrome.storage.sync.set({ ballPosition: position });
    });
}

// 创建悬浮球（含设置/脚本入口），点击展开对话框
export function createFloatingBall() {
    const container = document.createElement('div');
    container.className = 'ball-container';

    const ball = document.createElement('div');
    ball.id = 'ai-assistant-ball';
    ball.innerHTML = BALL_SVG;

    const settingsButton = document.createElement('div');
    settingsButton.className = 'settings-button';
    settingsButton.innerHTML = SETTINGS_SVG;
    settingsButton.title = '设置';

    const scriptButton = document.createElement('div');
    scriptButton.className = 'script-button';
    scriptButton.title = '脚本自动化';
    scriptButton.innerHTML = SCRIPT_SVG;
    scriptButton.addEventListener('click', (e) => {
        e.stopPropagation();
        try {
            ScriptPanel.open();
        } catch (err) {
            console.error('[WebChat] 打开脚本面板失败', err);
            alert('脚本面板打开失败：' + err.message);
        }
    });

    // 对话框是单例：第一次创建时绑定聊天逻辑，后续复用同一个实例
    let dialog = document.getElementById('ai-assistant-dialog');
    if (!dialog) {
        dialog = createDialog();
        initializeDialog(dialog);
    }

    settingsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ action: 'openOptions' });
    });

    ball.addEventListener('click', () => {
        const visible = dialog.classList.contains('show');
        if (visible) {
            dialog.classList.remove('show');
            return;
        }
        const { left, top } = calcDialogPosition(ball, dialog);
        dialog.style.left = `${left}px`;
        dialog.style.top = `${top}px`;
        dialog.style.right = 'auto';
        dialog.style.bottom = 'auto';
        dialog.classList.add('show');
    });

    container.appendChild(ball);
    container.appendChild(settingsButton);
    container.appendChild(scriptButton);

    enableBallDragging(ball, container);
    restoreBallPosition(ball, container);
    bindWindowResize(ball, container);

    document.body.appendChild(container);
    return ball;
}
