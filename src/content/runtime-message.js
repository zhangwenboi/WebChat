import { showNotification } from './notification.js';

// 向 background 发消息的带退避重试封装
// - 扩展上下文失效时只提示一次，并返回 undefined（调用方需自行处理空值）
// - 其余错误指数退避后重抛给调用方
export async function sendMessageWithRetry(message, maxRetries = 3) {
    let notified = false;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await chrome.runtime.sendMessage(message);
        } catch (error) {
            if (error.message.includes('Extension context invalidated')) {
                if (!notified) {
                    console.log('Extension context invalidated, reloading page...');
                    showNotification('扩展已更新，请刷新页面以继续使用', { animated: false });
                    notified = true;
                }
                return;
            }
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 100));
        }
    }
}
