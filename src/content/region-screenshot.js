/**
 * 区域截图 — 在页面上盖一层半透明遮罩，用户拖框选区，
 * 选区释放后请求 background 截全屏，再在 canvas 里按选区 crop。
 *
 * 使用方法：
 *   import { startRegionScreenshot } from './region-screenshot.js';
 *   startRegionScreenshot().then(dataUrl => { ... });
 */

const Z = 2147483646; // 比对话框低 1，避免覆盖 toast

export function startRegionScreenshot() {
  return new Promise((resolve, reject) => {
    if (document.querySelector('.webchat-region-overlay')) {
      reject(new Error('区域截图已在进行中'));
      return;
    }

    // 先记录设备像素比，截图返回是物理像素
    const dpr = window.devicePixelRatio || 1;

    const overlay = document.createElement('div');
    overlay.className = 'webchat-region-overlay';
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: String(Z),
      cursor: 'crosshair',
      background: 'rgba(0,0,0,0.25)',
      userSelect: 'none'
    });

    const hint = document.createElement('div');
    hint.textContent = '拖动鼠标选择截图区域，按 Esc 取消';
    Object.assign(hint.style, {
      position: 'fixed',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,0.7)',
      color: '#fff',
      padding: '6px 12px',
      borderRadius: '4px',
      fontSize: '13px',
      zIndex: String(Z + 1)
    });
    overlay.appendChild(hint);

    const sel = document.createElement('div');
    Object.assign(sel.style, {
      position: 'fixed',
      border: '1px dashed #fff',
      background: 'rgba(255,255,255,0.1)',
      pointerEvents: 'none',
      display: 'none'
    });
    overlay.appendChild(sel);

    document.body.appendChild(overlay);

    let startX = 0, startY = 0, dragging = false;
    let endX = 0, endY = 0;

    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        cleanup();
        reject(new Error('已取消'));
      }
    }

    overlay.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      sel.style.display = 'block';
      sel.style.left = startX + 'px';
      sel.style.top = startY + 'px';
      sel.style.width = '0px';
      sel.style.height = '0px';
    });

    overlay.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      endX = e.clientX;
      endY = e.clientY;
      const x = Math.min(startX, endX);
      const y = Math.min(startY, endY);
      const w = Math.abs(endX - startX);
      const h = Math.abs(endY - startY);
      sel.style.left = x + 'px';
      sel.style.top = y + 'px';
      sel.style.width = w + 'px';
      sel.style.height = h + 'px';
    });

    overlay.addEventListener('mouseup', async (e) => {
      if (!dragging) return;
      dragging = false;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);

      cleanup();

      if (w < 5 || h < 5) {
        reject(new Error('选区过小'));
        return;
      }

      try {
        // 请求 background 截全屏（必须在 overlay 已经销毁后再截，否则把遮罩拍进去）
        // 等浏览器渲染完一次再调
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const resp = await chrome.runtime.sendMessage({ action: 'captureRegion' });
        if (!resp || resp.error || !resp.dataUrl) {
          throw new Error(resp?.error || '截图失败');
        }
        const cropped = await cropDataUrl(resp.dataUrl, x, y, w, h, dpr);
        resolve({ dataUrl: cropped, width: Math.round(w * dpr), height: Math.round(h * dpr) });
      } catch (err) {
        reject(err);
      }
    });

    document.addEventListener('keydown', onKey, true);
  });
}

function cropDataUrl(dataUrl, x, y, w, h, dpr) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const sx = Math.round(x * dpr);
        const sy = Math.round(y * dpr);
        const sw = Math.round(w * dpr);
        const sh = Math.round(h * dpr);
        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error('截图解码失败'));
    img.src = dataUrl;
  });
}
