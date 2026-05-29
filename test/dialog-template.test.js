import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dialogSource = readFileSync(new URL('../src/content/dialog.js', import.meta.url), 'utf8');
const chatControllerSource = readFileSync(new URL('../src/content/chat-controller.js', import.meta.url), 'utf8');
const imageMarkerSource = readFileSync(new URL('../src/content/image-marker.js', import.meta.url), 'utf8');

test('dialog toolbar buttons use valid closing tags and visible labels', () => {
  assert.match(dialogSource, /id="exportChatBtn"[\s\S]*?>\$\{ICONS\.export\}<\/button>/);
  assert.match(dialogSource, /id="sidebarToggleBtn"[\s\S]*?>\$\{ICONS\.sidebar\}<\/button>/);
  assert.match(dialogSource, /id="regionShotBtn"[\s\S]*?>\$\{ICONS\.shot\}<\/button>/);
  assert.match(dialogSource, /id="attachImageBtn"[\s\S]*?>\$\{ICONS\.image\}<\/button>/);
  assert.match(dialogSource, /id="clearMarkedImagesBtn"[\s\S]*hidden>\$\{ICONS\.clearImages\}<\/button>/);
  assert.match(dialogSource, /const ICONS = \{/);
});

test('dialog includes an in-panel sidebar toggle', () => {
  assert.match(dialogSource, /function bindSidebarToggle\(dialog\)/);
  assert.match(dialogSource, /chrome\.storage\.sync\.set\(\{ displayMode: next \}\)/);
});

test('chat send flow actively collects selected images before posting payload', () => {
  const line = chatControllerSource
    .split(/\r?\n/)
    .find(sourceLine => sourceLine.includes('const images = await collectSelectedImagesForSend();'));

  assert.ok(line, 'missing selected image collection call');
  assert.doesNotMatch(line, /^\s*\/\//);
});

test('chat controller declares tabId as executable code', () => {
  const line = chatControllerSource
    .split(/\r?\n/)
    .find(sourceLine => sourceLine.includes('let tabId;'));

  assert.ok(line, 'missing tabId declaration');
  assert.doesNotMatch(line, /^\s*\/\//);
});

test('image marker binds runtime image messages and DOM image lookup code is active', () => {
  const messageBoundLine = imageMarkerSource
    .split(/\r?\n/)
    .find(sourceLine => sourceLine.includes('if (!attachMarker._messageBound) {'));
  const imageLookupLine = imageMarkerSource
    .split(/\r?\n/)
    .find(sourceLine => sourceLine.includes("const imgs = Array.from(document.querySelectorAll('img'));"));

  assert.ok(messageBoundLine, 'missing runtime message binding guard');
  assert.ok(imageLookupLine, 'missing DOM image lookup');
  assert.doesNotMatch(messageBoundLine, /^\s*\/\//);
  assert.doesNotMatch(imageLookupLine, /^\s*\/\//);
});

test('dialog click-outside handler declares composed path as executable code', () => {
  const line = dialogSource
    .split(/\r?\n/)
    .find(sourceLine => sourceLine.includes("const path = typeof e.composedPath === 'function'"));

  assert.ok(line, 'missing composed path declaration');
  assert.doesNotMatch(line, /^\s*\/\//);
});
