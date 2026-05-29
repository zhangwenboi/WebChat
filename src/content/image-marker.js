/**
 * 图片标记：当前 tab 内存里的“已标记图片”集合 + UI 缩略图条带
 *
 * 入口：右键 <img>、区域截图、工具栏清空、本地文件和粘贴图片。
 * chat-controller.js 初始化对话框后调用 attachMarker(dialog)，发送时调用 getMarked()。
 */

import { imgElementToDataURL } from '../lib/page-parser.js';
import {
  addImageDataUrl,
  blobToDataUrl as readBlobAsDataUrl,
  clearManualImages,
  createImageAttachmentStore,
  getManualImages,
  imageFileToDataUrl,
  removeManualImage
} from './image-attachments.js';

const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.7;

// id -> entry
const store = createImageAttachmentStore();
let stripEl = null;
let clearBtn = null;

const listeners = new Set();
function emit() { listeners.forEach(fn => { try { fn(); } catch {} }); }

export function attachMarker(dialog) {
  stripEl = dialog.querySelector('#markedImagesStrip');
  clearBtn = dialog.querySelector('#clearMarkedImagesBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => clearMarked());
  }
  if (!attachMarker._messageBound) {
    attachMarker._messageBound = true;
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request?.action === 'imageMark/addByUrl') {
        addByUrl(request.srcUrl).then(
          (entry) => sendResponse({ ok: !!entry, id: entry?.id }),
          (err) => sendResponse({ ok: false, error: err?.message || String(err) })
        );
        return true;
      }
      return false;
    });
  }
  render();
}

export function getMarked() {
  return getManualImages(store);
}

export function clearMarked() {
  clearManualImages(store);
  render();
  emit();
}

export function removeMarked(id) {
  if (removeManualImage(store, id)) {
    render();
    emit();
  }
}

export function addDataUrl(dataUrl, meta = {}) {
  const entry = addImageDataUrl(store, dataUrl, meta);
  if (!entry) return null;
  render();
  emit();
  return entry;
}

export async function addFile(file, meta = {}) {
  const dataUrl = await imageFileToDataUrl(file);
  if (!dataUrl) return null;
  return addDataUrl(dataUrl, {
    ...meta,
    alt: meta.alt || file.name || '',
    source: meta.source || 'file'
  });
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 根据右键传来的 srcUrl 在当前 DOM 找匹配 <img> 转 dataUrl；找不到或 canvas tainted 则退化到 fetch+FileReader。
 */
async function addByUrl(srcUrl) {
  if (!srcUrl) return null;

  const imgs = Array.from(document.querySelectorAll('img'));
  const match = imgs.find(im => im.currentSrc === srcUrl || im.src === srcUrl);
  if (match) {
    try {
      const dataUrl = await imgElementToDataURL(match, MAX_EDGE, JPEG_QUALITY);
      if (dataUrl) {
        return addDataUrl(dataUrl, {
          source: 'context-menu',
          alt: match.alt || '',
          width: match.naturalWidth,
          height: match.naturalHeight
        });
      }
    } catch { /* fallthrough */ }
  }

  // fetch fallback can still fail because of CORS.
  try {
    const resp = await fetch(srcUrl, { mode: 'cors' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const dataUrl = await readBlobAsDataUrl(blob);
    return addDataUrl(dataUrl, { source: 'context-menu', alt: '' });
  } catch (e) {
    notify(`Cannot read this image (${e?.message || 'CORS limit'}). Try region screenshot instead.`);
    return null;
  }
}


function render() {
  if (!stripEl) return;
  const items = getManualImages(store);
  stripEl.innerHTML = '';
  stripEl.dataset.count = String(items.length);
  if (items.length === 0) {
    stripEl.hidden = true;
    if (clearBtn) clearBtn.hidden = true;
    return;
  }
  stripEl.hidden = false;
  if (clearBtn) clearBtn.hidden = false;

  for (const entry of items) {
    const node = document.createElement('div');
    node.className = 'marked-thumb';
    node.title = `Source: ${entry.source}${entry.alt ? ' / ' + entry.alt : ''}`;
    node.dataset.id = entry.id;
    const img = document.createElement('img');
    img.src = entry.dataUrl;
    img.alt = entry.alt || '';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'marked-thumb-close';
    closeBtn.type = 'button';
    closeBtn.title = 'Remove';
    closeBtn.textContent = 'x';
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeMarked(entry.id);
    });
    node.appendChild(img);
    node.appendChild(closeBtn);
    stripEl.appendChild(node);
  }
}

// Minimal in-page notification, avoids pulling in a heavier toast system.
function notify(msg) {
  try {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#333;color:#fff;padding:8px 12px;border-radius:6px;font-size:13px;max-width:320px;box-shadow:0 4px 12px rgba(0,0,0,.2)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  } catch { /* noop */ }
}
