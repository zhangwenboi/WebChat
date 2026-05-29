import { setSafeHTML } from '../lib/sanitize.js';
import { parseWebContent, extractPageImages } from '../lib/page-parser.js';
import { initMarked } from './markdown-loader.js';
import { sendMessageWithRetry } from './runtime-message.js';
import { handleContextMenu } from './context-menu.js';
import { showNotification } from './notification.js';
import { createScrollController } from './scroll-controller.js';
import { createMentionDropdown } from './mention-dropdown.js';
import { attachMarker, getMarked, addDataUrl, clearMarked, addFile } from './image-marker.js';
import { collectImagesForSend as collectAttachmentImages } from './image-attachments.js';
import { startRegionScreenshot } from './region-screenshot.js';

const WELCOME_HTML = '<p>你好！我是 AI 助手，可以帮你理解和分析当前网页的内容。</p>';

function getPageContent() {
    return parseWebContent({ preferSelection: true });
}

async function collectSelectedImagesForSend() {
    const marked = getMarked();
    return collectAttachmentImages({
        store: { marked: new Map(marked.map(image => [image.id, image])), nextId: 1 },
        getSettings: () => new Promise(resolve => {
            chrome.storage.sync.get({
                enableImageRecognition: false,
                autoCollectPageImages: false,
                maxImagesPerPage: 3
            }, resolve);
        }),
        extractPageImages
    });
}

function showWelcomeMessage(messagesContainer) {
    const div = document.createElement('div');
    div.className = 'welcome-message';
    div.innerHTML = WELCOME_HTML;
    messagesContainer.appendChild(div);
}

// 创建消息节点并接入右键菜单；空内容代表占位/正在生成
function buildMessageNode(content, isUser, markedInstance) {
    const div = document.createElement('div');
    div.className = `message ${isUser ? 'user-message' : 'assistant-message'}`;

    if (!isUser && content === '') {
        div.setAttribute('data-pending', 'true');
        return div;
    }

    div.dataset.markdownContent = content;
    try {
        setSafeHTML(div, markedInstance(content));
        div.addEventListener('contextmenu', (e) => {
            handleContextMenu(e, div, div.dataset.markdownContent);
        });
    } catch (error) {
        console.error('Markdown 渲染失败:', error);
        div.textContent = content;
    }
    return div;
}

// 拉取历史并渲染；失败时退回欢迎语
async function loadHistory({ messagesContainer, markedInstance, tabId }) {
    try {
        const response = await sendMessageWithRetry({ action: 'getHistory', tabId });

        messagesContainer.innerHTML = '';
        const history = response?.history || [];

        if (!history.length) {
            showWelcomeMessage(messagesContainer);
        } else {
            history.forEach(msg => {
                const div = document.createElement('div');
                div.className = `message ${msg.isUser ? 'user-message' : 'assistant-message'}`;
                div.dataset.markdownContent = msg.markdownContent || msg.content;
                try {
                    setSafeHTML(div, markedInstance(msg.markdownContent || msg.content));
                    div.addEventListener('contextmenu', (e) => {
                        handleContextMenu(e, div, div.dataset.markdownContent);
                    });
                } catch (error) {
                    console.error('Markdown 渲染失败:', error);
                    div.textContent = msg.content;
                }
                messagesContainer.appendChild(div);
            });
        }
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    } catch (error) {
        console.error('加载历史记录失败:', error);
        messagesContainer.innerHTML = `<div class="welcome-message">${WELCOME_HTML}</div>`;
    }
}

// “回到底部”按钮（旧实现保留）：scroll-controller 已统一管理跟随逻辑，这里仅返回一个空 element 兼容 chat-container 结构
// 实际按钮由 createScrollController 注入

function bindShowFollow(dialog, scroll) {
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((m) => {
            if (m.target.classList.contains('show')) scroll.resumeFollow();
        });
    });
    observer.observe(dialog, { attributes: true, attributeFilter: ['class'] });
}

// 通过端口接收 background 流式回复，按 chunk 渲染并累积 tokens
function bindAnswerStream({
    port,
    messageDiv,
    typingIndicator,
    markedInstance,
    onTokens,
    onDone,
    onError
}) {
    let currentAnswer = '';

    port.onMessage.addListener(async (msg) => {
        try {
            if (msg.type === 'input-tokens') {
                onTokens(msg.tokens);
            } else if (msg.type === 'answer-chunk') {
                currentAnswer += msg.content;
                try {
                    messageDiv.dataset.markdownContent = msg.markdownContent || currentAnswer;
                    setSafeHTML(messageDiv, markedInstance(currentAnswer));
                } catch (error) {
                    messageDiv.textContent = currentAnswer;
                }
                if (msg.tokens) onTokens(msg.tokens);
            } else if (msg.type === 'answer-end') {
                messageDiv.removeAttribute('data-pending');
                messageDiv.dataset.markdownContent = msg.markdownContent || currentAnswer;
                messageDiv.addEventListener('contextmenu', (e) => {
                    handleContextMenu(e, messageDiv, messageDiv.dataset.markdownContent);
                });
                typingIndicator.remove();
                onDone();
            } else if (msg.type === 'error') {
                messageDiv.remove();
                typingIndicator.remove();
                onError(msg.error);
            }
        } catch (error) {
            console.error('处理消息时出错', error);
        }
    });
}

async function exportHistory(tabId) {
    try {
        const response = await sendMessageWithRetry({ action: 'getHistory', tabId });
        const history = response?.history || [];
        if (!history.length) {
            showNotification('No chat history to export');
            return;
        }
        const lines = [`# WebChat 对话导出`, `> ${document.title}`, `> ${location.href}`, ''];
        history.forEach(msg => {
            const who = msg.isUser ? 'User' : 'Assistant';
            const content = msg.markdownContent || msg.content || '';
            lines.push(`## ${who}`, '', content, '');
        });
        const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `webchat-${Date.now()}.md`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
        showNotification('Export failed: ' + e.message);
    }
}

// 装配整个对话框：聊天提交 / 流式渲染 / tokens / 清空 / 导出
export async function initializeDialog(dialog) {
    try {
        const userInput = dialog.querySelector('#userInput');
        const askButton = dialog.querySelector('#askButton');
        const mentionContainer = dialog.querySelector('#mentionDropdown');
        const mention = mentionContainer
            ? createMentionDropdown(userInput, mentionContainer)
            : { getReferencedTabIds: () => [], getReferencedTabs: () => [], clearReferences: () => {}, isOpen: () => false };
        const messagesContainer = dialog.querySelector('#messages');
        const chatContainer = dialog.querySelector('#chat-container');
        const tokensCounter = dialog.querySelector('.tokens-counter');

        // 接入图片标记 UI
        attachMarker(dialog);

        // 区域截图按钮：先关掉对话框，避免把对话框拍进截图
        const regionShotBtn = dialog.querySelector('#regionShotBtn');
        const attachImageBtn = dialog.querySelector('#attachImageBtn');
        const imageFileInput = dialog.querySelector('#imageFileInput');
        regionShotBtn?.addEventListener('click', async () => {
            const wasShown = dialog.classList.contains('show');
            if (wasShown) dialog.classList.remove('show');
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            try {
                const { dataUrl, width, height } = await startRegionScreenshot();
                addDataUrl(dataUrl, { source: 'region-screenshot', width, height });
            } catch (err) {
                if (err && err.message && err.message !== 'cancelled') {
                    showNotification('Region screenshot failed: ' + err.message, 'error');
                }
            } finally {
                if (wasShown) dialog.classList.add('show');
            }
        });

        attachImageBtn?.addEventListener('click', () => imageFileInput?.click());
        imageFileInput?.addEventListener('change', async () => {
            const files = Array.from(imageFileInput.files || []);
            for (const file of files) {
                try {
                    await addFile(file, { source: 'file', alt: file.name });
                } catch (err) {
                    showNotification('Add image failed: ' + (err?.message || err), 'error');
                }
            }
            imageFileInput.value = '';
        });

        userInput.addEventListener('paste', async (e) => {
            const files = Array.from(e.clipboardData?.files || [])
                .filter(file => file.type?.startsWith('image/'));
            if (!files.length) return;
            e.preventDefault();
            for (const file of files) {
                try {
                    await addFile(file, { source: 'paste', alt: file.name || 'pasted-image' });
                } catch (err) {
                    showNotification('Paste image failed: ' + (err?.message || err), 'error');
                }
            }
        });

        const scroll = createScrollController(messagesContainer, chatContainer);
        bindShowFollow(dialog, scroll);

        // 聊天会话状态：tabId 决定历史记录归属，currentPort 是当前流式端口
        let tabId;
        try {
            const response = await sendMessageWithRetry({ action: 'getCurrentTab' });
            if (!response) throw new Error('无法获取标签页 ID');
            tabId = response.tabId;
        } catch (error) {
            console.error('获取标签页 ID 失败:', error);
            return;
        }

        const markedInstance = await initMarked();

        let isGenerating = false;
        let currentPort = null;
        let totalTokens = 0;

        function setTokens(delta) {
            totalTokens += delta;
            tokensCounter.textContent = `Tokens: ${totalTokens}`;
        }

        function appendMessage(content, isUser) {
            const div = buildMessageNode(content, isUser, markedInstance);
            messagesContainer.appendChild(div);
            scroll.autoScroll();
            return div;
        }

        function appendTypingIndicator() {
            const indicator = document.createElement('div');
            indicator.className = 'message assistant-message typing-indicator';
            indicator.innerHTML = '<span></span><span></span><span></span>';
            messagesContainer.appendChild(indicator);
            scroll.autoScroll();
            return indicator;
        }

        function endGenerating() {
            isGenerating = false;
            scroll.setGenerating(false);
            userInput.disabled = false;
            askButton.classList.remove('generating');
            userInput.focus();
        }

        // 处理一次发送：未在生成则发问，否则中断当前生成
        async function handleUserInput() {
            if (isGenerating) {
                if (currentPort) {
                    currentPort.disconnect();
                    currentPort = null;
                }
                endGenerating();
                document.querySelector('.message[data-pending="true"]')?.remove();
                document.querySelector('.typing-indicator')?.remove();
                appendMessage('Stopped generating.', false);
                return;
            }

            const question = userInput.value.trim();
            if (!question) return;

            isGenerating = true;
            scroll.setGenerating(true);
            userInput.disabled = true;
            askButton.disabled = false;
            askButton.classList.add('generating');
            userInput.value = '';

            try {
                const pageContent = getPageContent();

                // 先把用户气泡显示出来，避免后续异步抽取期间界面无反馈
                appendMessage(question, true);
                const messageDiv = appendMessage('', false);
                const typingIndicator = appendTypingIndicator();

                // 收集被 @ 引用的 tab 内容（如有）
                const referencedTabIds = mention.getReferencedTabIds();
                let referencedTabs = [];
                if (referencedTabIds.length) {
                    try {
                        const res = await sendMessageWithRetry({
                            action: 'extractTabs',
                            tabIds: referencedTabIds
                        });
                        referencedTabs = (res && res.tabs) || [];
                    } catch (e) {
                        console.warn('extractTabs 失败:', e);
                    }
                }

                const images = await collectSelectedImagesForSend();

                const cleanedQuestion = question.replace(/@\[[^\]]+\]\s?/g, '').trim() || question;

                if (currentPort) currentPort.disconnect();
                currentPort = chrome.runtime.connect({ name: 'answerStream' });

                bindAnswerStream({
                    port: currentPort,
                    messageDiv,
                    typingIndicator,
                    markedInstance,
                    onTokens: (n) => setTokens(n),
                    onDone: () => {
                        endGenerating();
                        currentPort?.disconnect();
                        currentPort = null;
                        scroll.resumeFollow();
                        chrome.storage.sync.set({ totalTokens });
                    },
                    onError: (err) => {
                        appendMessage('Error: ' + err, false);
                        endGenerating();
                        currentPort?.disconnect();
                        currentPort = null;
                    }
                });

                try {
                    currentPort.postMessage({
                        action: 'generateAnswer',
                        tabId,
                        pageContent,
                        question: cleanedQuestion,
                        images,
                        referencedTabs
                    });
                    // 发送后清掉本轮引用，避免下次发送被误带
                    mention.clearReferences();
                } catch (error) {
                    console.error('Failed to send message', error);
                    throw error;
                }
            } catch (error) {
                appendMessage('Error: ' + error.message, false);
                endGenerating();
            }
        }

        askButton.addEventListener('click', handleUserInput);
        userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleUserInput();
            }
        });
        // textarea 自适应高度，最高 100px
        userInput.addEventListener('input', () => {
            userInput.style.height = 'auto';
            userInput.style.height = Math.min(userInput.scrollHeight, 100) + 'px';
        });

        chrome.storage.sync.get({ totalTokens: 0 }, (items) => {
            totalTokens = items.totalTokens;
            tokensCounter.textContent = `Tokens: ${totalTokens}`;
        });

        dialog.querySelector('#clearChatBtn')?.addEventListener('click', async () => {
            if (!confirm('Clear current chat?')) return;
            try {
                await sendMessageWithRetry({ action: 'clearHistory', tabId });
            } catch {}
            messagesContainer.innerHTML = '';
            showWelcomeMessage(messagesContainer);
            tokensCounter.textContent = 'Tokens: 0';
            totalTokens = 0;
            chrome.storage.sync.set({ totalTokens: 0 });
            clearMarked();
        });

        dialog.querySelector('#exportChatBtn')?.addEventListener('click', () => exportHistory(tabId));

        await loadHistory({ messagesContainer, markedInstance, tabId });
    } catch (error) {
        console.error('初始化对话框失败:', error);
        const div = document.createElement('div');
        div.className = 'welcome-message';
        div.innerHTML = '<p>初始化失败，请刷新页面后重试</p>';
        dialog.querySelector('.messages').appendChild(div);
    }
}

