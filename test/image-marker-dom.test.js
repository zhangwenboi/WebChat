import test from 'node:test';
import assert from 'node:assert/strict';

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.hidden = false;
    this.className = '';
    this.type = '';
    this.title = '';
    this.textContent = '';
    this.src = '';
    this.alt = '';
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  querySelector(selector) {
    return this.map?.[selector] || null;
  }

  set innerHTML(value) {
    this.children = [];
    this._innerHTML = value;
  }

  get innerHTML() {
    return this._innerHTML || '';
  }
}

test('selected images render a visible thumbnail strip', async () => {
  const previousDocument = globalThis.document;
  const previousChrome = globalThis.chrome;

  globalThis.document = {
    createElement: tagName => new FakeElement(tagName),
    querySelectorAll: () => []
  };
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener() {}
      }
    }
  };

  const strip = new FakeElement('div');
  strip.hidden = true;
  const clearButton = new FakeElement('button');
  clearButton.hidden = true;
  const dialog = new FakeElement('div');
  dialog.map = {
    '#markedImagesStrip': strip,
    '#clearMarkedImagesBtn': clearButton
  };

  const marker = await import(`../src/content/image-marker.js?dom-test=${Date.now()}`);
  marker.attachMarker(dialog);
  marker.addDataUrl('data:image/png;base64,abc', {
    source: 'region-screenshot',
    width: 10,
    height: 10
  });

  assert.equal(strip.hidden, false);
  assert.equal(clearButton.hidden, false);
  assert.equal(strip.dataset.count, '1');
  assert.equal(strip.children.length, 1);
  assert.equal(strip.children[0].className, 'marked-thumb');
  assert.equal(strip.children[0].children[0].src, 'data:image/png;base64,abc');

  globalThis.document = previousDocument;
  globalThis.chrome = previousChrome;
});
