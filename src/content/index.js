// content script 入口：装好全局错误处理，注册来自 sidepanel/background 的消息路由
import { parseWebContent } from '../lib/page-parser.js';
import { installGlobalErrorHandlers } from './notification.js';
import './xhs-board-extractor.js';

function getPageContent() {
    return parseWebContent({ preferSelection: true });
}

installGlobalErrorHandlers();

// sidepanel / background 通过 sendMessage 调用以下能力：
//   ping              - 健康检查
//   getPageContent    - 提取当前页面正文
//   openScriptPanel   - 打开脚本自动化面板
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
        if (request.action === 'ping') {
            sendResponse({ status: 'ok' });
        } else if (request.action === 'getPageContent') {
            sendResponse({ content: getPageContent() });
        } else if (request.action === 'openScriptPanel') {
            import('../scripts/panel.js').then(mod => {
                mod.openPanel();
                sendResponse({ status: 'ok' });
            }).catch(err => {
                sendResponse({ error: err.message });
            });
            return true; // 异步响应
        }
    } catch (error) {
        console.error('处理消息时出错:', error);
        sendResponse({ error: error.message });
    }
    return true;
});
