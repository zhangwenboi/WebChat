/**
 * 小红书合集工具箱
 *
 * 当浏览小红书合集页面（/board/*）时：
 *   1. 提取合集名称 + 笔记作者的用户 ID → 一键复制
 *   2. 提取所有笔记封面图 + 标题 → 一键下载（文件名 = 笔记标题）
 *
 * 复制格式：
 *   合集名
 *   @user_id_1
 *   @user_id_2
 *   ...
 */

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════

/** 从 user profile URL 中提取用户 ID */
function extractUserId(url) {
  const match = url.match(/\/user\/profile\/([^?&#]+)/);
  return match ? match[1] : null;
}

/** 从页面提取合集名称 */
function extractBoardName() {
  const nameEl = document.querySelector('.board-info .name');
  if (nameEl) {
    return nameEl.textContent.trim();
  }
  // 备选：从标题或 breadcrumb 提取
  const titleEl = document.querySelector('title');
  if (titleEl) {
    const title = titleEl.textContent.trim();
    // 尝试从标题中提取，例如 "黑色拼贴 - 小红书"
    const m = title.match(/^(.+?)\s*[-–—|]\s*小红书/);
    if (m) return m[1];
  }
  return '合集';
}

/** 从页面提取所有唯一的用户 ID（仅笔记作者，排除合集创建者） */
function extractUserIds() {
  const links = document.querySelectorAll('.note-item a[href*="/user/profile/"]');
  const ids = new Set();
  for (const link of links) {
    const id = extractUserId(link.getAttribute('href'));
    if (id) ids.add(id);
  }
  return [...ids];
}

/** 生成复制文本 */
function formatOutput(boardName, userIds) {
  const lines = [boardName];
  for (const id of userIds) {
    lines.push(`@${id}`);
  }
  // 最后一行末尾只保留一个空格，无换行
  return lines.join('\n') + ' ';
}

/** 提取所有笔记的封面图 URL 与标题 */
function extractCoverItems() {
  const items = [];
  const sections = document.querySelectorAll('.note-item');
  for (const sec of sections) {
    const img = sec.querySelector('.cover img');
    const titleEl = sec.querySelector('.footer .title span');
    const url = img?.getAttribute('src') || img?.currentSrc || '';
    const title = titleEl?.textContent?.trim() || '';
    if (url && title) {
      items.push({ url, title });
    }
  }
  return items;
}

/** 将标题转为合法文件名（保留中文，去掉非法字符，限长 80 字） */
function sanitizeFilename(title) {
  return title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 80);
}

// ═══════════════════════════════════════════════════════════
// 按钮 UI
// ═══════════════════════════════════════════════════════════

const BUTTON_ID = 'xhs-board-extract-btn';

/** 当前按钮关联的数据（SPA 切换合集时更新） */
let currentBoardName = '';
let currentUserIds = [];

/** 注入或更新按钮 */
function upsertButton(boardName, userIds) {
  currentBoardName = boardName;
  currentUserIds = userIds;

  let btn = document.getElementById(BUTTON_ID);

  if (!btn) {
    btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.title = '将合集用户ID复制到剪贴板';

    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      zIndex: '99999',
      padding: '10px 20px',
      background: '#ff2442',
      color: '#fff',
      border: 'none',
      borderRadius: '20px',
      fontSize: '14px',
      fontWeight: '600',
      cursor: 'pointer',
      boxShadow: '0 4px 12px rgba(255,36,66,0.35)',
      transition: 'transform 0.15s, box-shadow 0.15s',
      fontFamily: 'inherit'
    });

    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.05)';
      btn.style.boxShadow = '0 6px 18px rgba(255,36,66,0.45)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.boxShadow = '0 4px 12px rgba(255,36,66,0.35)';
    });

    btn.addEventListener('click', async () => {
      const text = formatOutput(currentBoardName, currentUserIds);
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '✓ 已复制!';
        btn.style.background = '#2ecc71';
        btn.style.boxShadow = '0 4px 12px rgba(46,204,113,0.35)';
        setTimeout(() => {
          btn.textContent = `复制 ${currentUserIds.length} 个用户ID`;
          btn.style.background = '#ff2442';
          btn.style.boxShadow = '0 4px 12px rgba(255,36,66,0.35)';
        }, 1500);
      } catch (err) {
        // 降级：用 textarea 兜底
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.textContent = '✓ 已复制!';
        setTimeout(() => {
          btn.textContent = `复制 ${currentUserIds.length} 个用户ID`;
        }, 1500);
      }
    });

    document.body.appendChild(btn);
  }

  // 更新按钮文案
  btn.textContent = `复制 ${userIds.length} 个用户ID`;
  // 如果正在显示「已复制」，不覆盖
  if (btn.style.background === 'rgb(46, 204, 113)') {
    btn.style.background = '#ff2442';
  }
}

// ═══════════════════════════════════════════════════════════
// 下载封面按钮 + 格式选择
// ═══════════════════════════════════════════════════════════

const DOWNLOAD_CONTAINER_ID = 'xhs-board-download-ctr';
const DOWNLOAD_BTN_ID = 'xhs-board-download-btn';
const FORMAT_SELECT_ID = 'xhs-board-format-select';
let currentCoverItems = [];
let currentFormat = 'webp';

const SELECT_STYLE = `
  border: none;
  border-radius: 14px;
  padding: 6px 10px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  background: rgba(24,144,255,0.12);
  color: #1890ff;
  cursor: pointer;
  outline: none;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%231890ff'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 6px center;
  padding-right: 22px;
`;

function upsertDownloadButton(coverItems) {
  currentCoverItems = coverItems;

  let ctr = document.getElementById(DOWNLOAD_CONTAINER_ID);

  if (!ctr) {
    ctr = document.createElement('div');
    ctr.id = DOWNLOAD_CONTAINER_ID;
    Object.assign(ctr.style, {
      position: 'fixed',
      bottom: '70px',
      right: '20px',
      zIndex: '99999',
      display: 'flex',
      alignItems: 'center',
      gap: '8px'
    });

    // 格式选择器
    const select = document.createElement('select');
    select.id = FORMAT_SELECT_ID;
    select.title = '选择下载格式';
    select.style.cssText = SELECT_STYLE;
    select.innerHTML = '<option value="webp">WebP</option><option value="png">PNG</option>';
    select.addEventListener('change', () => {
      currentFormat = select.value;
    });

    // 下载按钮
    const btn = document.createElement('button');
    btn.id = DOWNLOAD_BTN_ID;
    btn.title = '下载当前合集所有封面图';
    Object.assign(btn.style, {
      padding: '10px 20px',
      background: '#1890ff',
      color: '#fff',
      border: 'none',
      borderRadius: '20px',
      fontSize: '14px',
      fontWeight: '600',
      cursor: 'pointer',
      boxShadow: '0 4px 12px rgba(24,144,255,0.35)',
      transition: 'transform 0.15s, box-shadow 0.15s',
      fontFamily: 'inherit'
    });

    [btn, select].forEach(el => {
      el.addEventListener('mouseenter', () => {
        btn.style.transform = 'scale(1.05)';
        btn.style.boxShadow = '0 6px 18px rgba(24,144,255,0.45)';
      });
      el.addEventListener('mouseleave', () => {
        btn.style.transform = 'scale(1)';
        btn.style.boxShadow = '0 4px 12px rgba(24,144,255,0.35)';
      });
    });

    btn.addEventListener('click', () => {
      downloadAllCovers(currentCoverItems, btn, select);
    });

    ctr.appendChild(select);
    ctr.appendChild(btn);
    document.body.appendChild(ctr);
  }

  const btn = document.getElementById(DOWNLOAD_BTN_ID);
  btn.textContent = `下载 ${coverItems.length} 张封面`;
}

/** 获取图片 data URL：优先读浏览器缓存（force-cache），失败则注入页面主世界 fetch */
async function fetchImageAsDataUrl(url) {
  // 方案 A：从浏览器缓存读取（图片已在页面展示，缓存中一定有）
  try {
    const resp = await fetch(url, { cache: 'force-cache' });
    if (resp.ok) {
      const blob = await resp.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取图片数据失败'));
        reader.readAsDataURL(blob);
      });
    }
  } catch (_) { /* 降级到方案 B */ }

  // 方案 B：注入页面主世界脚本发起 fetch（携带天然 Referer + Cookie）
  return new Promise((resolve, reject) => {
    const msgId = 'xhs_img_' + Math.random().toString(36).slice(2);

    const handler = (e) => {
      if (e.data?.id !== msgId) return;
      window.removeEventListener('message', handler);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.dataUrl);
    };
    window.addEventListener('message', handler);

    const code =
      `(function(){var i=${JSON.stringify(msgId)};fetch(${JSON.stringify(url)})` +
      `.then(function(r){return r.blob()})` +
      `.then(function(b){var r=new FileReader();r.onload=function(){window.postMessage({id:i,dataUrl:r.result},'*')};r.onerror=function(){window.postMessage({id:i,error:'read failed'},'*')};r.readAsDataURL(b)})` +
      `.catch(function(e){window.postMessage({id:i,error:e.message},'*')})})();`;

    const script = document.createElement('script');
    script.textContent = code;
    document.documentElement.appendChild(script);
    script.remove();

    setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('fetch timeout'));
    }, 15000);
  });
}

/** 将图片 data URL 转为 PNG 格式（canvas 重编码，兼容不支持 WebP 的手机） */
function convertDataUrlToPng(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('图片加载失败，无法转换格式'));
    img.src = dataUrl;
  });
}

/** 通过 background 逐张下载封面 */
async function downloadAllCovers(coverItems, btn, select) {
  const total = coverItems.length;
  const fmt = select ? select.value : currentFormat;
  const ext = fmt === 'png' ? '.png' : '.webp';
  let done = 0;
  btn.textContent = `0 / ${total}`;
  btn.style.background = '#fa8c16';
  select && (select.disabled = true);

  for (const item of coverItems) {
    const filename = sanitizeFilename(item.title) + ext;
    try {
      let dataUrl = await fetchImageAsDataUrl(item.url);
      // 如果选了 PNG，通过 canvas 转换格式
      if (fmt === 'png') {
        dataUrl = await convertDataUrlToPng(dataUrl);
      }
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: 'downloadImage', dataUrl, filename },
          (resp) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (resp?.ok) resolve(resp);
            else reject(new Error(resp?.error || '下载失败'));
          }
        );
      });
    } catch (err) {
      console.warn(`下载封面失败: ${filename}`, err);
    }
    done++;
    btn.textContent = `${done} / ${total}`;
  }

  select && (select.disabled = false);
  // 完成提示
  btn.textContent = `✓ 已下载 ${done} 张`;
  btn.style.background = '#2ecc71';
  btn.style.boxShadow = '0 4px 12px rgba(46,204,113,0.35)';
  setTimeout(() => {
    btn.textContent = `下载 ${currentCoverItems.length} 张封面`;
    btn.style.background = '#1890ff';
    btn.style.boxShadow = '0 4px 12px rgba(24,144,255,0.35)';
  }, 2000);
}

// ═══════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════

/** 判断当前页面是否为小红书合集页 */
function isBoardPage() {
  const host = location.hostname;
  const path = location.pathname;
  return (
    (host === 'www.xiaohongshu.com' || host.endsWith('.xiaohongshu.com')) &&
    path.startsWith('/board/')
  );
}

/** 初始化：等待页面内容加载完成后提取数据并注入按钮 */
function init() {
  if (!isBoardPage()) return;

  // 等待合集内容区出现（feed 容器），最多等 8 秒
  const maxWait = 8000;
  const start = Date.now();

  function tryExtract() {
    const userIds = extractUserIds();
    const coverItems = extractCoverItems();
    if (userIds.length > 0 || coverItems.length > 0) {
      const boardName = extractBoardName();
      if (userIds.length > 0) upsertButton(boardName, userIds);
      if (coverItems.length > 0) upsertDownloadButton(coverItems);
      if (userIds.length > 0 || coverItems.length > 0) return;
    }
    if (Date.now() - start < maxWait) {
      // 页面可能是动态渲染的，用 MutationObserver 或轮询等待
      setTimeout(tryExtract, 500);
    }
  }

  // 先检查 DOM 是否已就绪
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // 再等一小会儿让 Vue 渲染
      setTimeout(tryExtract, 1000);
    });
  } else {
    tryExtract();
  }

  // MutationObserver 持续监听 DOM 变化：
  //   - 初次加载时注入按钮
  //   - 切换合集（SPA 路由）后自动更新按钮数据
  let pendingUpdate = null;
  const observer = new MutationObserver(() => {
    if (pendingUpdate) return; // 防抖
    pendingUpdate = requestAnimationFrame(() => {
      pendingUpdate = null;
      const userIds = extractUserIds();
      const coverItems = extractCoverItems();
      const boardName = extractBoardName();
      if (userIds.length > 0) upsertButton(boardName, userIds);
      if (coverItems.length > 0) upsertDownloadButton(coverItems);
    });
  });

  // body 出现后挂 observer，长期运行不自动断开
  const bodyCheck = setInterval(() => {
    if (document.body) {
      clearInterval(bodyCheck);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }, 200);
}

init();
