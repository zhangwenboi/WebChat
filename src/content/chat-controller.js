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

// ========== 对话管理 ==========

// 格式化相对时间
function formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const now = Date.now();
    const diff = now - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前`;
    return new Date(timestamp).toLocaleDateString('zh-CN');
}

// 刷新对话选择器下拉列表
async function refreshConversationList({ dialog, tabId, onSwitch }) {
    const titleEl = dialog.querySelector('.conv-title-text');
    const listEl = dialog.querySelector('#convDropdownList');
    const dropdown = dialog.querySelector('#convDropdown');
    const backdrop = dialog.querySelector('#convDropdownBackdrop');

    try {
        const res = await sendMessageWithRetry({ action: 'listConversations', tabId });
        const conversations = res?.conversations || [];

        // 找到当前活跃对话
        const activeConv = conversations.find(c => c.isActive) || conversations[0];

        if (activeConv) {
            titleEl.textContent = activeConv.title || '新对话';
        } else {
            titleEl.textContent = '新对话';
        }

        // 渲染下拉列表
        listEl.innerHTML = '';
        if (conversations.length === 0) {
            listEl.innerHTML = '<div class="conv-dropdown-empty">还没有对话，发送一条消息开始吧</div>';
        } else {
            conversations.forEach(conv => {
                const isActive = conv.isActive;
                const row = document.createElement('div');
                row.className = 'conv-dropdown-row' + (isActive ? ' active' : '');
                row.dataset.convId = conv.id;
                const iconEmoji = isActive ? '💬' : '📝';
                row.innerHTML = `
                    <div class="conv-row-icon">${iconEmoji}</div>
                    <div class="conv-row-content">
                        <span class="conv-row-title">${escapeHtml(conv.title || '新对话')}</span>
                        <span class="conv-row-meta">
                            <span>${conv.messageCount || 0} 条消息</span>
                            <span class="conv-row-meta-dot"></span>
                            <span>${formatRelativeTime(conv.updatedAt)}</span>
                        </span>
                    </div>
                    <button class="conv-row-delete" data-conv-id="${conv.id}" title="删除对话">
                        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
                    </button>
                `;
                row.addEventListener('click', (e) => {
                    if (e.target.closest('.conv-row-delete')) return;
                    closeDropdown();
                    if (onSwitch) onSwitch(conv.id);
                });
                listEl.appendChild(row);
            });

            // 删除按钮事件
            listEl.querySelectorAll('.conv-row-delete').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const convId = btn.dataset.convId;
                    if (!confirm('确定删除此对话？该操作不可恢复。')) return;
                    try {
                        await sendMessageWithRetry({ action: 'deleteConversation', tabId, convId });
                    } catch (err) {
                        showNotification('删除失败: ' + err.message, 'error');
                    }
                    await refreshConversationList({ dialog, tabId, onSwitch });
                    const stillExists = listEl.querySelector(`[data-conv-id="${convId}"]`);
                    if (!stillExists && onSwitch) {
                        const firstRow = listEl.querySelector('.conv-dropdown-row');
                        if (firstRow) {
                            onSwitch(firstRow.dataset.convId);
                        } else {
                            onSwitch(null);
                        }
                    }
                });
            });
        }

        return conversations;
    } catch (err) {
        console.error('刷新对话列表失败:', err);
        return [];
    }
}

function closeDropdown() {
    const dropdown = document.querySelector('#ai-assistant-dialog #convDropdown');
    const backdrop = document.querySelector('#ai-assistant-dialog #convDropdownBackdrop');
    if (dropdown) dropdown.hidden = true;
    if (backdrop) backdrop.hidden = true;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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

async function exportHistory(tabId, dialog) {
    try {
        const response = await sendMessageWithRetry({ action: 'getHistory', tabId });
        const history = response?.history || [];
        if (!history.length) {
            showNotification('暂无对话可导出');
            return;
        }
        const convTitle = dialog?.querySelector('.conv-title-text')?.textContent || '对话';
        const lines = [`# WebChat 对话导出 — ${convTitle}`, `> ${document.title}`, `> ${location.href}`, ''];
        history.forEach(msg => {
            const who = msg.isUser ? '用户' : '助手';
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
        showNotification('导出失败: ' + e.message);
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
        let currentConvId = null;
        let generatingConvId = null; // 正在生成中的对话 ID（切换对话时不中断生成）

        // ===== 对话管理 UI =====
        const convSelectorBtn = dialog.querySelector('#convSelectorBtn');
        const convDropdown = dialog.querySelector('#convDropdown');
        const convTitleText = dialog.querySelector('.conv-title-text');

        // 切换对话（生成中切换时不中断 AI，只切换视图）
        async function switchToConversation(convId) {
            try {
                if (convId) {
                    await sendMessageWithRetry({ action: 'switchConversation', tabId, convId });
                } else {
                    // 新建对话
                    const res = await sendMessageWithRetry({ action: 'createConversation', tabId });
                    convId = res?.conversation?.id;
                }
                currentConvId = convId;

                // 清空当前界面并重新加载（不中断正在生成的对话）
                messagesContainer.innerHTML = '';
                totalTokens = 0;
                tokensCounter.textContent = 'Tokens: 0';
                chrome.storage.sync.set({ totalTokens: 0 });
                clearMarked();
                await loadHistory({ messagesContainer, markedInstance, tabId });
                await refreshConversationList({ dialog, tabId, onSwitch: switchToConversation });
                // 如果 AI 正在为其他对话生成，保持 UI 可用
                if (generatingConvId && generatingConvId !== currentConvId) {
                    isGenerating = false;
                    userInput.disabled = false;
                    askButton.classList.remove('generating');
                }
                userInput.focus();
            } catch (err) {
                showNotification('切换对话失败: ' + err.message, 'error');
            }
        }

        // 对话选择器按钮：切换下拉
        const convBackdrop = dialog.querySelector('#convDropdownBackdrop');
        function openDropdown() {
            convDropdown.hidden = false;
            convBackdrop.hidden = false;
            refreshConversationList({ dialog, tabId, onSwitch: switchToConversation });
        }

        convSelectorBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (convDropdown.hidden) {
                openDropdown();
            } else {
                convDropdown.hidden = true;
                convBackdrop.hidden = true;
            }
        });

        // 点击遮罩关闭下拉
        convBackdrop?.addEventListener('click', () => {
            convDropdown.hidden = true;
            convBackdrop.hidden = true;
        });

        // 下拉头部 + 按钮
        dialog.querySelector('#convDropdownAdd')?.addEventListener('click', () => {
            convDropdown.hidden = true;
            convBackdrop.hidden = true;
            switchToConversation(null);
        });

        // 新建对话按钮
        dialog.querySelector('#newChatBtn')?.addEventListener('click', () => {
            convDropdown.hidden = true;
            convBackdrop.hidden = true;
            switchToConversation(null);
        });

        // 刷新按钮
        dialog.querySelector('#refreshBtn')?.addEventListener('click', () => {
            if (!confirm('刷新将重新加载扩展，当前对话已自动保存。确定继续？')) return;
            sendMessageWithRetry({ action: 'reloadExtension' }).catch(() => {});
        });
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
            generatingConvId = currentConvId; // 记录本次生成归属的对话
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
                const thisPort = currentPort; // 捕获当前 port，防止后续生成覆盖

                const genConvId = generatingConvId; // 捕获本次生成归属
                bindAnswerStream({
                    port: thisPort,
                    messageDiv,
                    typingIndicator,
                    markedInstance,
                    onTokens: (n) => setTokens(n),
                    onDone: () => {
                        generatingConvId = null;
                        // 只有当用户仍在查看该对话时才更新 UI
                        if (currentConvId === genConvId) {
                            endGenerating();
                        }
                        thisPort?.disconnect();
                        if (currentPort === thisPort) currentPort = null;
                        scroll.resumeFollow();
                        chrome.storage.sync.set({ totalTokens });
                        refreshConversationList({ dialog, tabId, onSwitch: switchToConversation });
                    },
                    onError: (err) => {
                        generatingConvId = null;
                        if (currentConvId === genConvId) {
                            appendMessage('Error: ' + err, false);
                            endGenerating();
                        }
                        thisPort?.disconnect();
                        if (currentPort === thisPort) currentPort = null;
                    }
                });

                // 如果端口意外断开（如 Service Worker 终止），自动恢复 UI
                thisPort.onDisconnect.addListener(() => {
                    generatingConvId = null;
                    if (isGenerating) {
                        endGenerating();
                        const pending = document.querySelector('.message[data-pending="true"]');
                        if (pending) pending.remove();
                        const typing = document.querySelector('.typing-indicator');
                        if (typing) typing.remove();
                        currentPort = null;
                    }
                });

                try {
                    currentPort.postMessage({
                        action: 'generateAnswer',
                        tabId,
                        convId: genConvId,
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

        dialog.querySelector('#exportChatBtn')?.addEventListener('click', () => exportHistory(tabId, dialog));

        await loadHistory({ messagesContainer, markedInstance, tabId });
        // 初始化对话列表
        await refreshConversationList({ dialog, tabId, onSwitch: switchToConversation });
    } catch (error) {
        console.error('初始化对话框失败:', error);
        const div = document.createElement('div');
        div.className = 'welcome-message';
        div.innerHTML = '<p>初始化失败，请刷新页面后重试</p>';
        dialog.querySelector('.messages').appendChild(div);
    }
}

