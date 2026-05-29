// 顶部右侧轻量提示，以及扩展失效时的全局错误兜底

const NOTIFICATION_STYLE = `
    position: fixed;
    right: 20px;
    top: 20px;
    padding: 10px 20px;
    background: rgba(0, 0, 0, 0.8);
    color: white;
    border-radius: 4px;
    z-index: 10000;
    font-size: 14px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
`;

// 显示一条 3s 自动消失的通知，重复触发时会替换上一条
export function showNotification(message, { animated = true } = {}) {
    const existing = document.querySelector('.extension-notification');
    if (existing) existing.remove();

    const notification = document.createElement('div');
    notification.className = 'extension-notification';
    notification.style.cssText = NOTIFICATION_STYLE + (animated ? 'animation: fadeInOut 3s ease forwards;' : '');
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => notification.remove(), 3000);
    return notification;
}

// 拦截 Extension context invalidated 类错误，提示用户刷新页面，避免控制台噪音
export function installGlobalErrorHandlers() {
    const isContextInvalidated = (err) =>
        err && err.message && err.message.includes('Extension context invalidated');

    window.addEventListener('error', (event) => {
        if (isContextInvalidated(event.error)) {
            event.preventDefault();
            showNotification('扩展已更新，请刷新页面以继续使用', { animated: false });
        }
    });

    window.addEventListener('unhandledrejection', (event) => {
        if (isContextInvalidated(event.reason)) {
            event.preventDefault();
        }
    });
}
