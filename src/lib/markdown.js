/**
 * 统一的 marked 加载与配置；popup 和 content 共用
 * 假定 marked 已在 lib/marked.min.js 中通过 script 标签预加载
 */
export async function getMarkdownRenderer() {
  // 等待全局 marked 可用（最多 5s）
  if (typeof marked === 'undefined') {
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (typeof marked !== 'undefined') return resolve();
        if (Date.now() - start > 5000) return reject(new Error('marked 加载超时'));
        setTimeout(tick, 100);
      };
      tick();
    });
  }
  marked.setOptions({
    breaks: true,
    gfm: true,
    headerIds: false,
    mangle: false
  });
  return (text) => marked.parse(text || '');
}
