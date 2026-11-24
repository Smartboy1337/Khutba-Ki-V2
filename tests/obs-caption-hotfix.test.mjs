import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../src/renderer/src/ui/App.tsx', import.meta.url), 'utf8');

test('room source uses the /obs endpoint in full layout', () => {
  assert.match(ui, /const obsRoomUrl = .*buildObsUrl\(obsUrl, \{ layout: 'full'/);
});

test('livestream source uses the same /obs endpoint with caption layout', () => {
  const block = ui.slice(ui.indexOf('const obsStreamUrl ='), ui.indexOf('const visibleText'));
  assert.match(block, /buildObsUrl\(obsUrl/);
  assert.match(block, /layout: 'captions'/);
  assert.match(block, /mode: 'de'/);
  assert.doesNotMatch(block, /'\/captions'/);
});

test('each source has own copy button and scale', () => {
  assert.match(ui, /obsRoomScale/);
  assert.match(ui, /obsStreamScale/);
  assert.match(ui, /Raum-Link kopieren/);
  assert.match(ui, /Livestream-Link kopieren/);
});
