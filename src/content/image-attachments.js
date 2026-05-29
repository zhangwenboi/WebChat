const DEFAULT_MAX_MANUAL_IMAGES = 8;

export function createImageAttachmentStore() {
  return {
    marked: new Map(),
    nextId: 1
  };
}

export function getManualImages(store, limit = DEFAULT_MAX_MANUAL_IMAGES) {
  return Array.from(store.marked.values()).slice(0, limit);
}

export function clearManualImages(store) {
  store.marked.clear();
}

export function removeManualImage(store, id) {
  return store.marked.delete(id);
}

export function addImageDataUrl(store, dataUrl, meta = {}) {
  if (!dataUrl) return null;
  const id = `img-${Date.now()}-${store.nextId++}`;
  const entry = {
    id,
    dataUrl,
    source: meta.source || 'manual',
    alt: meta.alt || '',
    width: meta.width || 0,
    height: meta.height || 0
  };
  store.marked.set(id, entry);
  return entry;
}

export async function collectImagesForSend({
  store,
  getSettings,
  extractPageImages
}) {
  const manualImages = getManualImages(store);
  if (manualImages.length > 0) return manualImages;

  try {
    const settings = await getSettings();
    if (!settings.enableImageRecognition) return [];
    if (!settings.autoCollectPageImages) return [];
    return await extractPageImages({
      maxCount: Math.max(1, Math.min(8, settings.maxImagesPerPage || 3))
    });
  } catch {
    return [];
  }
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Read failed'));
    reader.readAsDataURL(blob);
  });
}

export function imageFileToDataUrl(file) {
  if (!file || !file.type?.startsWith('image/')) return Promise.resolve(null);
  return blobToDataUrl(file);
}

