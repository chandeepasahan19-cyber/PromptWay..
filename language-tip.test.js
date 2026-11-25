'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('Multilingual_AI_Prompt_Generation_Mobile_Application11.html', 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(code => code.includes('const preferenceKey ='));
const key = 'promptway.languageAccuracyTip.dismissed';

function openTip({ saved, blocked = false, priorFocus = false } = {}) {
  const storage = new Map(saved ? [[key, 'true']] : []);
  const classes = new Set();
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      events: {}, checked: false, open: false, isConnected: true,
      addEventListener(name, handler) { this.events[name] = handler; },
      showModal() { this.open = true; },
      close() { this.open = false; this.events.close(); },
      focus() { document.activeElement = this; }
    });
    return elements.get(id);
  };
  const document = {
    body: {}, activeElement: null,
    documentElement: { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } },
    getElementById: element,
    addEventListener(name, handler) { this.ready = handler; }
  };
  document.activeElement = priorFocus ? element('previous') : document.body;
  const localStorage = {
    getItem(name) { if (blocked) throw new Error('Storage blocked'); return storage.get(name); },
    setItem(name, value) { if (blocked) throw new Error('Storage blocked'); storage.set(name, value); }
  };
  // No fetch or application state is supplied: the popup must be independent of both.
  vm.runInNewContext(script, { document, localStorage });
  document.ready();
  return { document, element, storage, classes, dialog: element('language-accuracy-tip') };
}

test('shows on a fresh visit and skips only when the preference was saved', () => {
  const fresh = openTip();
  assert.equal(fresh.dialog.open, true);
  assert(fresh.classes.has('language-tip-open'));
  assert.equal(fresh.storage.size, 0);
  assert.equal(openTip({ saved: true }).dialog.open, false);
});

for (const action of ['language-tip-close', 'language-tip-start', 'Escape']) {
  test(`${action} dismisses, restores focus, and persists only when checked`, () => {
    for (const checked of [false, true]) {
      const app = openTip();
      app.element('language-tip-remember').checked = checked;
      if (action === 'Escape') {
        let prevented = false;
        app.dialog.events.cancel({ preventDefault() { prevented = true; } });
        assert(prevented);
      } else app.element(action).events.click();
      assert.equal(app.dialog.open, false);
      assert.equal(app.classes.size, 0);
      assert.equal(app.storage.get(key), checked ? 'true' : undefined);
      assert.equal(app.document.activeElement, app.element('idea-textarea'));
      assert.equal(openTip({ saved: app.storage.has(key) }).dialog.open, !checked);
    }
  });
}

test('blocked LocalStorage still allows opening and dismissal', () => {
  const app = openTip({ blocked: true });
  assert(app.dialog.open);
  app.element('language-tip-remember').checked = true;
  app.element('language-tip-start').events.click();
  assert.equal(app.dialog.open, false);
  assert.equal(app.classes.size, 0);
});

test('returns focus to the previously focused control when available', () => {
  const app = openTip({ priorFocus: true });
  app.element('language-tip-close').events.click();
  assert.equal(app.document.activeElement, app.element('previous'));
});
