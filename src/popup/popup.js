import { getMarkdownRenderer } from '../lib/markdown.js';
import { sanitizeHTML, setSafeHTML } from '../lib/sanitize.js';

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
        await initPopup();
    } catch (err) {
        console.error('Popup 初始化失败:', err);
        const messages = document.getElementById('messages');
        if (messages) {
            const div = document.createElement('div');
            div.className = 'welcome-message';
            div.textContent = '初始化失败：' + (err?.message || err);
            messages.appendChild(div);
        }
    }
});

async function initPopup() {
    // 在其他代码执行前先初始化marked
    await initMarked();

    const userInput = document.getElementById('userInput');
    const askButton = document.getElementById('askButton');
    const messagesContainer = document.getElementById('messages');
    let isGenerating = false;

    // 获取当前标签页ID
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab.id;

    // 初始化悬浮球开关状态
    const toggleBall = document.getElementById('toggleBall');
    const { showFloatingBall = true } = await chrome.storage.sync.get('showFloatingBall');
    toggleBall.checked = showFloatingBall;

    // 监听开关变化
    toggleBall.addEventListener('change', async () => {
        await chrome.storage.sync.set({ showFloatingBall: toggleBall.checked });
        // 向content script发送消息以更新悬浮球状态
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
            chrome.tabs.sendMessage(tab.id, { action: 'toggleFloatingBall' });
        }
    });

    // 加载历史会话
    async function loadHistory() {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getHistory',
                tabId: tabId
            });

            // 清空现有消息
            messagesContainer.innerHTML = '';

            if (!response || !response.history || response.history.length === 0) {
                // 没有历史记录时，显示欢迎消息
                const welcomeDiv = document.createElement('div');
                welcomeDiv.className = 'welcome-message';
                welcomeDiv.innerHTML = '<p>👋 你好！我是AI助手，可以帮你理解和分析当前网页的内容。</p>';
                messagesContainer.appendChild(welcomeDiv);
            } else {
                // 显示历史消息
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

                // 如果正在生成回答，添加加载指示器并连接到流
                if (response.isGenerating) {
                    isGenerating = true;
                    userInput.disabled = true;
                    askButton.disabled = true;

                    // 添加最后一个用户问题（如果不存在）
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

                    // 添加空的回答消息和加载指示器
                    const messageDiv = addMessage('', false);
                    const typingIndicator = addTypingIndicator();

                    // 连接到流
                    const port = chrome.runtime.connect({ name: "answerStream" });
                    let answer = response.currentAnswer || ''; // 使用已生成的部分答案

                    // 如果有已生成的部分答案，立即显示
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
                            messageDiv.removeAttribute('data-pending');
                            isGenerating = false;
                            userInput.disabled = false;
                            askButton.disabled = false;
                            userInput.focus();
                            typingIndicator.remove();
                            port.disconnect();
                        } else if (msg.type === 'error') {
                            messageDiv.remove();
                            addMessage('发生错误：' + msg.error, false);
                            isGenerating = false;
                            userInput.disabled = false;
                            askButton.disabled = false;
                            userInput.focus();
                            typingIndicator.remove();
                            port.disconnect();
                        }
                    });

                    // 重新连接到现有的生成流
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

    // 检查content script是否已加载
    async function ensureContentScriptLoaded(tabId) {
        try {
            await chrome.tabs.sendMessage(tabId, { action: 'ping' });
            return true;
        } catch (error) {
            // 如果content script未加载，注入它
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['content.js']
                });
                // 等待content script初始化
                await new Promise(resolve => setTimeout(resolve, 100));
                return true;
            } catch (error) {
                console.error('Failed to inject content script:', error);
                return false;
            }
        }
    }

    // 获取页面内容的函数，包含重试逻辑
    async function getPageContent(tab, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                // 保content script已加载
                await ensureContentScriptLoaded(tab.id);

                // 尝试获取页面内容
                const response = await chrome.tabs.sendMessage(tab.id, { action: 'getPageContent' });
                return response.content;
            } catch (error) {
                if (i === maxRetries - 1) {
                    throw new Error('无法获取页面内容，请刷新页面后重试');
                }
                // 等待一段时间后重试
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

    // 流式输出文本
    async function streamText(text, messageDiv) {
        const delay = 20; // 每个字符的延迟时间（毫秒）
        let currentText = '';

        for (let char of text) {
            currentText += char;
            try {
                // 使用marked渲染Markdown
                messageDiv.innerHTML = markedInstance(currentText);
            } catch (error) {
                console.error('Markdown渲染失败:', error);
                messageDiv.textContent = currentText;
            }
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        // 移除pending标记并保存完整的历史记录
        messageDiv.removeAttribute('data-pending');
        saveHistory();
    }

    // 处理用户输入
    async function handleUserInput() {
        if (isGenerating) return;

        const question = userInput.value.trim();
        if (!question) return;

        // 禁用输入和发送按钮
        isGenerating = true;
        userInput.disabled = true;
        askButton.disabled = true;
        userInput.value = '';

        try {
            // 从content script获取网页内容
            const pageContent = await getPageContent(tab);

            // 先添加用户消息
            addMessage(question, true);

            // 添加空的回答消息和打字指示器
            const messageDiv = addMessage('', false);
            const typingIndicator = addTypingIndicator();

            // 开始监听答案更新
            const port = chrome.runtime.connect({ name: "answerStream" });
            let answer = '';

            port.onMessage.addListener(async (msg) => {
                if (msg.type === 'answer-chunk') {
                    // 流式更新答案
                    answer += msg.content;
                    try {
                        setSafeHTML(messageDiv, markedInstance(answer));
                    } catch (error) {
                        console.error('Markdown渲染失败:', error);
                        messageDiv.textContent = answer;
                    }
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                } else if (msg.type === 'answer-end') {
                    // 答案生成完成
                    messageDiv.removeAttribute('data-pending');
                    isGenerating = false;
                    userInput.disabled = false;
                    askButton.disabled = false;
                    userInput.focus();
                    typingIndicator.remove();
                    port.disconnect();
                } else if (msg.type === 'error') {
                    messageDiv.remove(); // 移除空的消息div
                    addMessage('发生错误：' + msg.error, false);
                    isGenerating = false;
                    userInput.disabled = false;
                    askButton.disabled = false;
                    userInput.focus();
                    typingIndicator.remove();
                    port.disconnect();
                }
            });

            // 发送生成请求到background
            port.postMessage({
                action: 'generateAnswer',
                tabId: tabId,
                pageContent: pageContent,
                question: question
            });

        } catch (error) {
            addMessage('发生错误：' + error.message, false);
            isGenerating = false;
            userInput.disabled = false;
            askButton.disabled = false;
            userInput.focus();
        }
    }

    // 发送按钮点击事件
    askButton.addEventListener('click', handleUserInput);

    // 输入框回车事件（Shift+Enter换行）
    userInput.addEventListener('keydown', (e) => {
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
        const lines = [`# WebChat 对话导出`, `> ${tab.title || ''}`, `> ${tab.url || ''}`, ''];
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

    // 打开设置页
    document.getElementById('openOptionsBtn')?.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // 初始化时加载历史会话
    await loadHistory();
}