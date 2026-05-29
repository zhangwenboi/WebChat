import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createImageAttachmentStore,
  getManualImages,
  addImageDataUrl,
  collectImagesForSend
} from '../src/content/image-attachments.js';

test('adds screenshot data URLs to the manual image queue for thumbnail rendering', () => {
  const store = createImageAttachmentStore();

  const entry = addImageDataUrl(store, 'data:image/png;base64,abc', {
    source: 'region-screenshot',
    width: 320,
    height: 180
  });

  assert.equal(entry.source, 'region-screenshot');
  assert.equal(entry.width, 320);
  assert.equal(getManualImages(store).length, 1);
  assert.equal(getManualImages(store)[0].dataUrl, 'data:image/png;base64,abc');
});

test('manual images are sent without auto-collected page images', async () => {
  const store = createImageAttachmentStore();
  addImageDataUrl(store, 'data:image/jpeg;base64,manual', { source: 'paste' });

  const images = await collectImagesForSend({
    store,
    getSettings: async () => ({
      enableImageRecognition: true,
      autoCollectPageImages: true,
      maxImagesPerPage: 3
    }),
    extractPageImages: async () => [
      { dataUrl: 'data:image/jpeg;base64,auto', source: 'page' }
    ]
  });

  assert.deepEqual(images.map(image => image.dataUrl), ['data:image/jpeg;base64,manual']);
});

test('auto-collects page images only when no manual image is selected', async () => {
  const store = createImageAttachmentStore();

  const images = await collectImagesForSend({
    store,
    getSettings: async () => ({
      enableImageRecognition: true,
      autoCollectPageImages: true,
      maxImagesPerPage: 2
    }),
    extractPageImages: async ({ maxCount }) => [
      { dataUrl: `page-${maxCount}`, source: 'page' }
    ]
  });

  assert.deepEqual(images, [{ dataUrl: 'page-2', source: 'page' }]);
});
