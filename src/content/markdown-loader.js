import { getMarkdownRenderer } from '../lib/markdown.js';

// 加载 marked 渲染器；失败时回退为原样输出，保证消息总能展示
export async function initMarked() {
    try {
        return await getMarkdownRenderer();
    } catch (error) {
        console.error('Marked初始化失败:', error);
        return text => text;
    }
}
