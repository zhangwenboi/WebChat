// content script 入口：装好全局错误处理，注册来自 popup/background 的消息路由，启动悬浮球
import { parseWebContent } from '../lib/page-parser.js';
import { installGlobalErrorHandlers } from './notification.js';
import { checkAndSetBallVisibility } from './visibility.js';

function getPageContent() {
    return parseWebContent({ preferSelection: true });
}

installGlobalErrorHandlers();

// popup / background 通过 sendMessage 调用以下能力：
//   ping            - 健康检查
//   getPageContent  - 提取当前页面正文
//   toggleFloatingBall - 重新检查悬浮球是否就绪
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
        if (request.action === 'ping') {
            sendResponse({ status: 'ok' });
        } else if (request.action === 'getPageContent') {
            sendResponse({ content: getPageContent() });
        } else if (request.action === 'toggleFloatingBall') {
            checkAndSetBallVisibility();
            sendResponse({ status: 'ok' });
        }
    } catch (error) {
        console.error('处理消息时出错:', error);
        sendResponse({ error: error.message });
    }
    return true;
});

checkAndSetBallVisibility();
