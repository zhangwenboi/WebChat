import { showNotification } from './notification.js';
import { createFloatingBall } from './floating-ball.js';
import { createDialog } from './dialog.js';
import { initializeDialog } from './chat-controller.js';

// 确保悬浮球和对话框存在；脚本注入或扩展更新后会被多次触发，所以做存在性检查
export async function checkAndSetBallVisibility() {
    try {
        if (!chrome.runtime) {
            showNotification('扩展已更新，请刷新页面以继续使用');
            return;
        }
        const existingBall = document.getElementById('ai-assistant-ball');
        const existingDialog = document.getElementById('ai-assistant-dialog');

        if (!existingBall) {
            createFloatingBall();
        } else if (!existingDialog) {
            const dialog = createDialog();
            initializeDialog(dialog);
        }
    } catch (error) {
        if (error.message.includes('Extension context invalidated')) {
            showNotification('扩展已更新，请刷新页面以继续使用');
        }
    }
}
