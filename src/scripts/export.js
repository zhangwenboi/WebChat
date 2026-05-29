// 脚本导出：JSON 与可独立运行的 JS
export function exportJSON(script) {
    return JSON.stringify(script, null, 2);
}

export function exportJavaScript(script) {
    const json = JSON.stringify(script, null, 2);
    return `// WebChat 自动化脚本: ${script.meta?.name || '未命名'}
// 生成时间: ${new Date().toISOString()}
// 用法：在目标页面控制台粘贴运行（需先安装并启用 WebChat 扩展）
(function () {
    const script = ${json};
    if (!window.WebChatExecutor) {
        console.error('未找到 WebChatExecutor 运行时，请先安装/启用 WebChat 扩展');
        return;
    }
    const exec = new window.WebChatExecutor.ScriptExecutor({
        onLog: (info) => console.log('[WebChat]', info)
    });
    exec.execute(script).then(
        ctx => console.log('脚本执行完成', ctx),
        err => console.error('脚本执行失败', err)
    );
})();
`;
}

export async function exportToFile(script, format = 'json') {
    const content = format === 'js' ? exportJavaScript(script) : exportJSON(script);
    const filename = (script.meta?.name || 'script').replace(/[^\w一-龥-]+/g, '_');
    const ext = format === 'js' ? 'js' : 'json';

    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            action: 'downloadScript',
            content,
            filename: `webchat-scripts/${filename}.${ext}`,
            mime: format === 'js' ? 'application/javascript' : 'application/json'
        }, (resp) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else if (resp && resp.ok) {
                resolve(resp);
            } else {
                reject(new Error(resp?.error || '导出失败'));
            }
        });
    });
}

export function importFromText(text) {
    const obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.steps)) throw new Error('脚本格式不合法');
    return obj;
}

export default { exportJSON, exportJavaScript, exportToFile, importFromText };
