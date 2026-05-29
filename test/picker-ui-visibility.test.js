import test from 'node:test';
import assert from 'node:assert/strict';

import { hideScriptUiForPicking } from '../src/scripts/picker-ui-visibility.js';

function makeClassList(el) {
  return {
    add(name) {
      const names = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
      names.add(name);
      el.className = Array.from(names).join(' ');
    }
  };
}

function makeElement(className = '') {
  const attrs = new Map();
  const el = {
    className,
    style: { display: '', pointerEvents: '' },
    classList: null,
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    removeAttribute(name) {
      attrs.delete(name);
    }
  };
  el.classList = makeClassList(el);
  return el;
}

test('hideScriptUiForPicking hides panel and modal then restores previous state', () => {
  const panel = makeElement('webchat-script-panel-open custom');
  const modal = makeElement('webchat-script-modal');
  modal.style.display = 'block';
  modal.style.pointerEvents = 'auto';
  modal.setAttribute('aria-hidden', 'false');

  const restore = hideScriptUiForPicking({
    panelEl: panel,
    root: {
      querySelectorAll(selector) {
        assert.equal(selector, '.webchat-script-modal');
        return [modal];
      }
    }
  });

  assert.match(panel.className, /webchat-script-panel-hidden/);
  assert.equal(modal.style.display, 'none');
  assert.equal(modal.style.pointerEvents, 'none');
  assert.equal(modal.getAttribute('aria-hidden'), 'true');

  restore();
  assert.equal(panel.className, 'webchat-script-panel-open custom');
  assert.equal(modal.style.display, 'block');
  assert.equal(modal.style.pointerEvents, 'auto');
  assert.equal(modal.getAttribute('aria-hidden'), 'false');
});
