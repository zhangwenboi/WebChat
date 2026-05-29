// 聊天区滚动控制：跟随最新消息 + "回到当前消息"按钮
// 用户主动上滑后停止跟随；点击按钮或对话框重新打开时恢复跟随

export function createScrollController(messagesContainer, chatContainer) {
    let userHasScrolled = false;
    let isGenerating = false;
    let scrollPending = false;

    const isAtBottom = () => Math.abs(
        messagesContainer.scrollHeight -
        messagesContainer.clientHeight -
        messagesContainer.scrollTop
    ) < 30;

    const scrollButton = document.createElement('button');
    scrollButton.className = 'scroll-to-bottom-button';
    scrollButton.innerHTML = '↓ 回到当前消息';
    scrollButton.style.display = 'none';
    scrollButton.addEventListener('click', () => {
        messagesContainer.scrollTo({
            top: messagesContainer.scrollHeight,
            behavior: 'smooth'
        });
        userHasScrolled = false;
        scrollButton.style.display = 'none';
    });
    chatContainer.appendChild(scrollButton);

    // 滚动事件：判断按钮显隐 + 在非生成状态下记录用户意图
    messagesContainer.addEventListener('scroll', () => {
        const atBottom = isAtBottom();
        scrollButton.style.display = atBottom ? 'none' : 'block';
        if (!isGenerating) userHasScrolled = !atBottom;
    });

    function autoScroll(force = false) {
        if (!force && userHasScrolled) return;
        // 双层 rAF：等 DOM + 渲染都落定再滚，避免提前跳到旧位置
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const messages = messagesContainer.children;
                if (messages.length > 0) {
                    messages[messages.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
                }
            });
        });
    }

    // 监听消息容器的子节点/文本变化，节流触发自动滚动
    const contentObserver = new MutationObserver((mutations) => {
        const shouldScroll = mutations.some(m => m.type === 'childList' || m.type === 'characterData');
        if (shouldScroll && !scrollPending) {
            scrollPending = true;
            requestAnimationFrame(() => {
                autoScroll();
                scrollPending = false;
            });
        }
    });
    contentObserver.observe(messagesContainer, {
        childList: true,
        subtree: true,
        characterData: true
    });

    return {
        autoScroll,
        // 切换流式生成状态；生成中不更新 userHasScrolled，避免新消息塞入时误判
        setGenerating(value) { isGenerating = value; },
        // 重新跟随到底部（典型场景：对话框重新打开、流式回复结束）
        resumeFollow() {
            userHasScrolled = false;
            autoScroll(true);
        }
    };
}
