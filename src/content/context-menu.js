// 消息右键菜单：复制单条消息内容（AI 回复优先复制原始 Markdown）

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        console.error('复制失败:', err);
        return false;
    }
}

function showCopyToast(x, y) {
    const toast = document.createElement('div');
    toast.className = 'copy-toast';
    toast.textContent = '✓ 已复制';
    toast.style.position = 'fixed';
    toast.style.left = `${x}px`;
    toast.style.top = `${y - 40}px`;
    toast.style.transform = 'translate(-50%, -50%)';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

// 在指定消息节点上挂右键菜单。content 为兜底文本，AI 回复会优先用 dataset.markdownContent
export function handleContextMenu(e, messageDiv, content) {
    e.preventDefault();
    e.stopPropagation();

    document.querySelector('.context-menu')?.remove();

    const textToCopy = messageDiv.classList.contains('assistant-message')
        ? messageDiv.dataset.markdownContent || content || messageDiv.textContent
        : content;

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    const copyOption = document.createElement('div');
    copyOption.className = 'context-menu-item';
    copyOption.innerHTML = '📋 复制该消息';
    copyOption.onclick = async (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        const ok = await copyToClipboard(textToCopy);
        if (ok) showCopyToast(clickEvent.clientX, clickEvent.clientY);
        menu.remove();
    };
    menu.appendChild(copyOption);

    document.body.appendChild(menu);

    const closeMenu = (event) => {
        if (!menu.contains(event.target)) {
            menu.remove();
            document.removeEventListener('mousedown', closeMenu);
        }
    };
    document.addEventListener('mousedown', closeMenu);
}
