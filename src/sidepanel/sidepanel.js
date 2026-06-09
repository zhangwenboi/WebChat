import { getMarkdownRenderer } from '../lib/markdown.js';
import { sanitizeHTML, setSafeHTML } from '../lib/sanitize.js';
import { createMentionDropdown } from '../content/mention-dropdown.js';
import { POST_SYSTEM_PROMPT, POST_COMMANDS } from '../rewrite/prompts.js';

let markedInstance;

async function initMarked() {
    try {
        markedInstance = await getMarkdownRenderer();
        console.log('Marked初始化成功');
    } catch (error) {
        console.error('Marked初始化失败:', error);
        markedInstance = text => text;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await initPanel();
    } catch (err) {
        console.error('SidePanel 初始化失败:', err);
        const messages = document.getElementById('messages');
        if (messages) {
            const div = document.createElement('div');
            div.className = 'welcome-message';
            div.textContent = '初始化失败：' + (err?.message || err);
            messages.appendChild(div);
        }
    }
});

async function initPanel() {
    await initMarked();

    const userInput = document.getElementById('userInput');
    const askButton = document.getElementById('askButton');
    const messagesContainer = document.getElementById('messages');
    const mentionContainer = document.getElementById('mentionDropdown');
    let isGenerating = false;
    let generatingConvId = null;
    let currentConvId = null;

    // 获取当前活动标签页（后续通过 onActivated 保持同步）
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let tabId = tab.id;

    // ===== 对话管理 =====
    const convSelectorBtn = document.getElementById('convSelectorBtn');
    const convDropdown = document.getElementById('convDropdown');
    const convDropdownList = document.getElementById('convDropdownList');
    const convTitleText = document.querySelector('.conv-title-text');

    function formatTime(timestamp) {
        if (!timestamp) return '';
        const diff = Date.now() - timestamp;
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return '刚刚';
        if (mins < 60) return `${mins} 分钟前`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours} 小时前`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `${days} 天前`;
        return new Date(timestamp).toLocaleDateString('zh-CN');
    }

    async function refreshConversationList() {
        try {
            const res = await chrome.runtime.sendMessage({ action: 'listConversations', tabId });
            const conversations = res?.conversations || [];
            const activeConv = conversations.find(c => c.isActive) || conversations[0];

            if (activeConv) {
                convTitleText.textContent = activeConv.title || '新对话';
                if (!currentConvId) currentConvId = activeConv.id;
            } else {
                convTitleText.textContent = '新对话';
            }

            convDropdownList.innerHTML = '';
            if (conversations.length === 0) {
                convDropdownList.innerHTML = '<div class="conv-dropdown-empty">还没有对话，发送一条消息开始吧</div>';
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
                            <span class="conv-row-title">${escapeHtmlSP(conv.title || '新对话')}</span>
                            <span class="conv-row-meta">
                                <span>${conv.messageCount || 0} 条</span>
                                <span class="conv-row-meta-dot"></span>
                                <span>${formatTime(conv.updatedAt)}</span>
                            </span>
                        </div>
                        <button class="conv-row-delete" data-conv-id="${conv.id}" title="删除">🗑</button>
                    `;
                    row.addEventListener('click', (e) => {
                        if (e.target.closest('.conv-row-delete')) return;
                        convDropdown.hidden = true;
                        switchToConversation(conv.id);
                    });
                    convDropdownList.appendChild(row);
                });

                convDropdownList.querySelectorAll('.conv-row-delete').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const convId = btn.dataset.convId;
                        if (!confirm('确定删除此对话？该操作不可恢复。')) return;
                        await chrome.runtime.sendMessage({ action: 'deleteConversation', tabId, convId });
                        await refreshConversationList();
                        await loadHistory();
                    });
                });
            }
        } catch (err) {
            console.error('刷新对话列表失败:', err);
        }
    }

    function escapeHtmlSP(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    async function switchToConversation(convId) {
        try {
            if (convId) {
                await chrome.runtime.sendMessage({ action: 'switchConversation', tabId, convId });
            } else {
                const res = await chrome.runtime.sendMessage({ action: 'createConversation', tabId });
                convId = res?.conversation?.id;
            }
            currentConvId = convId;
            await loadHistory();
            await refreshConversationList();
            // 如果 AI 正在为其他对话生成，保持 UI 可用
            if (generatingConvId && convId !== generatingConvId) {
                isGenerating = false;
                userInput.disabled = false;
                askButton.disabled = false;
            }
            userInput.focus();
        } catch (err) {
            console.error('切换对话失败:', err);
        }
    }

    convSelectorBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        convDropdown.hidden = !convDropdown.hidden;
        if (!convDropdown.hidden) refreshConversationList();
    });

    // 下拉头部 + 按钮
    document.getElementById('convDropdownAdd')?.addEventListener('click', (e) => {
        e.stopPropagation();
        convDropdown.hidden = true;
        switchToConversation(null);
    });

    document.addEventListener('click', (e) => {
        if (!convDropdown.hidden && !convDropdown.contains(e.target) && e.target !== convSelectorBtn) {
            convDropdown.hidden = true;
        }
    });

    document.getElementById('newChatBtn')?.addEventListener('click', () => {
        convDropdown.hidden = true;
        switchToConversation(null);
    });

    document.getElementById('refreshBtn')?.addEventListener('click', () => {
        if (!confirm('刷新将重新加载扩展，当前对话已自动保存。确定继续？')) return;
        chrome.runtime.sendMessage({ action: 'reloadExtension' }).catch(() => {});
    });

    // 初始化 @ 提及下拉菜单
    const mention = createMentionDropdown(userInput, mentionContainer);

    // 小红书重写开关
    const toggleXHS = document.getElementById('toggleXHS');
    const xhsCommands = document.getElementById('xhsCommands');
    let xhsEnabled = false;

    toggleXHS.addEventListener('change', () => {
        xhsEnabled = toggleXHS.checked;
        xhsCommands.style.display = xhsEnabled ? 'flex' : 'none';
        userInput.placeholder = xhsEnabled
            ? '输入改写指令（或点击下方快捷按钮），回车发送...'
            : '输入 @ 引用其他标签页，输入问题后回车发送...';
    });

    // 小红书快捷指令按钮
    xhsCommands.addEventListener('click', (e) => {
        const btn = e.target.closest('.xhs-cmd');
        if (!btn) return;
        const cmdId = btn.dataset.cmd;
        const cmd = POST_COMMANDS.find(c => c.id === cmdId);
        if (cmd) {
            userInput.value = cmd.command;
            userInput.dispatchEvent(new Event('input', { bubbles: true }));
            handleUserInput();
        }
    });

    // 监听标签页切换，自动更新上下文
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
        if (activeInfo.tabId === tabId) return;
        tabId = activeInfo.tabId;
        try {
            tab = await chrome.tabs.get(tabId);
        } catch { /* 标签页可能已关闭 */ }
        await loadHistory();
        await refreshConversationList();
    });

    // 监听当前标签页 URL 变化
    chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.url) {
            tab.url = changeInfo.url;
            if (changeInfo.title) tab.title = changeInfo.title;
        }
    });

    // 加载历史会话
    async function loadHistory() {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getHistory',
                tabId: tabId
            });

            messagesContainer.innerHTML = '';

            if (!response || !response.history || response.history.length === 0) {
                const welcomeDiv = document.createElement('div');
                welcomeDiv.className = 'welcome-message';
                welcomeDiv.innerHTML = '<p>👋 你好！我是AI助手，可以帮你理解和分析当前网页的内容。</p>';
                messagesContainer.appendChild(welcomeDiv);
            } else {
                response.history.forEach(msg => {
                    const messageDiv = document.createElement('div');
                    messageDiv.className = `message ${msg.isUser ? 'user-message' : 'assistant-message'}`;
                    if (msg.isUser) {
                        messageDiv.textContent = msg.content;
                    } else {
                        try {
                            setSafeHTML(messageDiv, markedInstance(msg.content));
                        } catch (error) {
                            console.error('Markdown渲染失败:', error);
                            messageDiv.textContent = msg.content;
                        }
                    }
                    messagesContainer.appendChild(messageDiv);
                });

                if (response.isGenerating) {
                    isGenerating = true;
                    userInput.disabled = true;
                    askButton.disabled = true;

                    const lastMessage = response.history[response.history.length - 1];
                    if (!lastMessage || !lastMessage.isUser) {
                        const userQuestion = response.pendingQuestion;
                        if (userQuestion) {
                            const questionDiv = document.createElement('div');
                            questionDiv.className = 'message user-message';
                            questionDiv.textContent = userQuestion;
                            messagesContainer.appendChild(questionDiv);
                        }
                    }

                    const messageDiv = addMessage('', false);
                    const typingIndicator = addTypingIndicator();

                    const port = chrome.runtime.connect({ name: "answerStream" });
                    let answer = response.currentAnswer || '';
                    const genConvId = currentConvId; // 重连时绑定当前对话

                    if (answer) {
                        try {
                            setSafeHTML(messageDiv, markedInstance(answer));
                        } catch (error) {
                            console.error('Markdown渲染失败:', error);
                            messageDiv.textContent = answer;
                        }
                    }

                    port.onMessage.addListener(async (msg) => {
                        if (msg.type === 'answer-chunk') {
                            answer += msg.content;
                            try {
                                setSafeHTML(messageDiv, markedInstance(answer));
                            } catch (error) {
                                console.error('Markdown渲染失败:', error);
                                messageDiv.textContent = answer;
                            }
                            messagesContainer.scrollTop = messagesContainer.scrollHeight;
                        } else if (msg.type === 'answer-end') {
                            generatingConvId = null;
                            if (currentConvId === genConvId) {
                                messageDiv.removeAttribute('data-pending');
                                isGenerating = false;
                                userInput.disabled = false;
                                askButton.disabled = false;
                                userInput.focus();
                            }
                            typingIndicator.remove();
                            port.disconnect();
                            refreshConversationList();
                        } else if (msg.type === 'error') {
                            generatingConvId = null;
                            if (currentConvId === genConvId) {
                                messageDiv.remove();
                                addMessage('发生错误：' + msg.error, false);
                                isGenerating = false;
                                userInput.disabled = false;
                                askButton.disabled = false;
                                userInput.focus();
                            }
                            typingIndicator.remove();
                            port.disconnect();
                        }
                    });

                    port.onDisconnect.addListener(() => {
                        generatingConvId = null;
                        if (isGenerating && currentConvId === genConvId) {
                            isGenerating = false;
                            userInput.disabled = false;
                            askButton.disabled = false;
                            userInput.focus();
                            const pending = document.querySelector('.message[data-pending="true"]');
                            if (pending) pending.remove();
                            const typing = document.querySelector('.typing-indicator');
                            if (typing) typing.remove();
                        }
                    });

                    port.postMessage({
                        action: 'reconnectStream',
                        tabId: tabId
                    });
                }
            }
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        } catch (error) {
            console.error('加载历史记录失败:', error);
            messagesContainer.innerHTML = `
                <div class="welcome-message">
                    <p>👋 你好！我是AI助手，可以帮你理解和分析当前网页的内容。</p>
                </div>
            `;
        }
    }

    // 保存历史会话
    async function saveHistory() {
        try {
            const messages = Array.from(messagesContainer.children)
                .filter(el => el.classList.contains('message') && !el.hasAttribute('data-pending'))
                .map(el => ({
                    content: el.textContent,
                    isUser: el.classList.contains('user-message')
                }));

            await chrome.runtime.sendMessage({
                action: 'saveHistory',
                tabId: tabId,
                history: messages
            });
        } catch (error) {
            console.error('保存历史记录失败:', error);
        }
    }

    // 检查 URL 是否为 Chrome 受限页面（无法注入 content script）
    function isRestrictedUrl(url) {
        if (!url) return false;
        return /^(chrome|chrome-extension|about|edge|brave):/.test(url)
            || url.startsWith('https://chrome.google.com/webstore/');
    }

    // 检查content script是否已加载
    async function ensureContentScriptLoaded(tabId) {
        // 先检查页面是否可注入，避免无意义的重试
        try {
            const tabInfo = await chrome.tabs.get(tabId);
            if (isRestrictedUrl(tabInfo.url)) {
                return false; // 受限页面，无法注入
            }
        } catch { /* 获取标签页信息失败，继续尝试 */ }

        try {
            await chrome.tabs.sendMessage(tabId, { action: 'ping' });
            return true;
        } catch (error) {
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['content.js']
                });
                await new Promise(resolve => setTimeout(resolve, 100));
                return true;
            } catch (error) {
                console.error('Failed to inject content script:', error);
                return false;
            }
        }
    }

    // 获取页面内容的函数
    async function getPageContent(targetTab, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                const ok = await ensureContentScriptLoaded(targetTab.id);
                if (!ok) throw new Error('当前页面不支持扩展功能，请切换到普通网页');
                const response = await chrome.tabs.sendMessage(targetTab.id, { action: 'getPageContent' });
                return response.content;
            } catch (error) {
                if (error.message.includes('当前页面不支持')) throw error;
                if (i === maxRetries - 1) {
                    throw new Error('无法获取页面内容，请刷新页面后重试');
                }
                await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
            }
        }
    }

    // 添加消息到聊天界面
    function addMessage(content, isUser = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isUser ? 'user-message' : 'assistant-message'}`;

        if (!isUser && content === '') {
            messageDiv.setAttribute('data-pending', 'true');
        } else {
            if (isUser) {
                messageDiv.textContent = content;
            } else {
                try {
                    setSafeHTML(messageDiv, markedInstance(content));
                } catch (error) {
                    console.error('Markdown渲染失败:', error);
                    messageDiv.textContent = content;
                }
            }
        }

        messagesContainer.appendChild(messageDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;

        if (content !== '' || isUser) {
            saveHistory();
        }

        return messageDiv;
    }

    // 添加打字指示器
    function addTypingIndicator() {
        const indicatorDiv = document.createElement('div');
        indicatorDiv.className = 'message assistant-message typing-indicator';
        indicatorDiv.innerHTML = '<span></span><span></span><span></span>';
        messagesContainer.appendChild(indicatorDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        return indicatorDiv;
    }

    // 处理用户输入（含 @ 标签页引用）
    async function handleUserInput() {
        if (isGenerating) return;

        const rawQuestion = userInput.value.trim();
        if (!rawQuestion) return;

        // 收集 @ 引用的标签页 ID
        const referencedTabIds = mention.getReferencedTabIds();
        let referencedTabs = [];
        if (referencedTabIds.length) {
            try {
                const res = await chrome.runtime.sendMessage({
                    action: 'extractTabs',
                    tabIds: referencedTabIds
                });
                referencedTabs = (res && res.tabs) || [];
            } catch (e) {
                console.warn('extractTabs 失败:', e);
            }
        }

        // 去掉 @[标题] 标记，得到纯净问题
        const question = rawQuestion.replace(/@\[[^\]]+\]\s?/g, '').trim() || rawQuestion;

        isGenerating = true;
        generatingConvId = currentConvId;
        userInput.disabled = true;
        askButton.disabled = true;
        userInput.value = '';
        const genConvId = generatingConvId;

        // 发送后清掉本轮引用
        mention.clearReferences();

        try {
            // 从当前标签页获取内容
            const pageContent = await getPageContent(tab);

            // 添加用户消息（显示原始输入含 @ 标记）
            addMessage(rawQuestion, true);

            const messageDiv = addMessage('', false);
            const typingIndicator = addTypingIndicator();

            const port = chrome.runtime.connect({ name: "answerStream" });
            let answer = '';

            port.onMessage.addListener(async (msg) => {
                if (msg.type === 'answer-chunk') {
                    answer += msg.content;
                    try {
                        setSafeHTML(messageDiv, markedInstance(answer));
                    } catch (error) {
                        console.error('Markdown渲染失败:', error);
                        messageDiv.textContent = answer;
                    }
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                } else if (msg.type === 'answer-end') {
                    generatingConvId = null;
                    if (currentConvId === genConvId) {
                        messageDiv.removeAttribute('data-pending');
                        isGenerating = false;
                        userInput.disabled = false;
                        askButton.disabled = false;
                        userInput.focus();
                    }
                    typingIndicator.remove();
                    port.disconnect();
                    refreshConversationList();
                } else if (msg.type === 'error') {
                    generatingConvId = null;
                    if (currentConvId === genConvId) {
                        messageDiv.remove();
                        addMessage('发生错误：' + msg.error, false);
                        isGenerating = false;
                        userInput.disabled = false;
                        askButton.disabled = false;
                        userInput.focus();
                    }
                    typingIndicator.remove();
                    port.disconnect();
                }
            });

            port.onDisconnect.addListener(() => {
                generatingConvId = null;
                if (isGenerating && currentConvId === genConvId) {
                    isGenerating = false;
                    userInput.disabled = false;
                    askButton.disabled = false;
                    userInput.focus();
                    const pending = document.querySelector('.message[data-pending="true"]');
                    if (pending) pending.remove();
                    const typing = document.querySelector('.typing-indicator');
                    if (typing) typing.remove();
                }
            });

            // 小红书重写模式：覆盖 system prompt，改写用户指令格式
            const postPayload = {
                action: 'generateAnswer',
                tabId: tabId,
                convId: genConvId,
                pageContent: pageContent,
                question: xhsEnabled
                    ? `请根据以下内容进行改写：\n\n【原始内容】\n${pageContent}\n\n改写指令：${question}`
                    : question,
                referencedTabs: referencedTabs
            };
            if (xhsEnabled) {
                postPayload.systemPromptOverride = POST_SYSTEM_PROMPT;
            }
            port.postMessage(postPayload);

        } catch (error) {
            addMessage('发生错误：' + error.message, false);
            isGenerating = false;
            userInput.disabled = false;
            askButton.disabled = false;
            userInput.focus();
        }
    }

    // 发送按钮
    askButton.addEventListener('click', handleUserInput);

    // 输入框回车（Shift+Enter 换行），但 @ 下拉打开时不拦截
    userInput.addEventListener('keydown', (e) => {
        // 如果 @ 下拉菜单可见，由 mention-dropdown 处理方向键/Enter/Esc
        if (mention.isOpen()) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleUserInput();
        }
    });

    // 自动调整输入框高度
    userInput.addEventListener('input', () => {
        userInput.style.height = 'auto';
        userInput.style.height = Math.min(userInput.scrollHeight, 100) + 'px';
    });

    // 清空对话
    document.getElementById('clearChatBtn')?.addEventListener('click', async () => {
        if (!confirm('确定要清空当前对话吗？')) return;
        await chrome.runtime.sendMessage({ action: 'clearHistory', tabId });
        messagesContainer.innerHTML = '';
        const welcomeDiv = document.createElement('div');
        welcomeDiv.className = 'welcome-message';
        welcomeDiv.innerHTML = '<p>👋 你好！我是AI助手，可以帮你理解和分析当前网页的内容。</p>';
        messagesContainer.appendChild(welcomeDiv);
    });

    // 导出对话
    document.getElementById('exportChatBtn')?.addEventListener('click', async () => {
        const response = await chrome.runtime.sendMessage({ action: 'getHistory', tabId });
        const history = response?.history || [];
        if (!history.length) {
            alert('暂无对话可导出');
            return;
        }
        const currentTab = tab || {};
        const lines = [`# WebChat 对话导出`, `> ${currentTab.title || ''}`, `> ${currentTab.url || ''}`, ''];
        history.forEach(msg => {
            const who = msg.isUser ? '🙋 用户' : '🤖 助手';
            const content = msg.markdownContent || msg.content || '';
            lines.push(`## ${who}`);
            lines.push('');
            lines.push(content);
            lines.push('');
        });
        const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `webchat-${Date.now()}.md`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    // 打开脚本面板
    document.getElementById('scriptBtn')?.addEventListener('click', async () => {
        try {
            const ok = await ensureContentScriptLoaded(tabId);
            if (!ok) throw new Error('当前页面不支持扩展功能，请切换到普通网页');
            await chrome.tabs.sendMessage(tabId, { action: 'openScriptPanel' });
        } catch (err) {
            alert('无法在当前页面打开脚本面板。请确认：\n1. 当前不是 chrome:// 或 chrome-extension:// 页面\n2. 页面已完全加载\n\n错误：' + (err?.message || err));
        }
    });

    // 打开设置页
    document.getElementById('openOptionsBtn')?.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // 初始加载
    await loadHistory();
    await refreshConversationList();
}
