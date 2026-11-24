const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const filename = path.join(__dirname, '../src/renderer/src/audio/speechBoundary.ts');
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = module.paths;
mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, filename);
const { decideSpeechBoundary, retainAudioTail, SEGMENT_POLICY: P } = mod.exports;

test('short silence in mid-word does not end a chunk', () => {
  assert.equal(decideSpeechBoundary(4000, 120), 'continue');
  assert.equal(decideSpeechBoundary(6200, 320), 'continue');
});
test('old forced 6.3 second cut is removed', () => {
  assert.equal(decideSpeechBoundary(6300, 0), 'continue');
  assert.equal(decideSpeechBoundary(7400, 200), 'continue');
});
test('short natural breath after soft limit ends the chunk', () => {
  assert.equal(decideSpeechBoundary(6700, P.shortPauseAfterSoftLimitMs), 'natural-pause');
});
test('full sentence pause still ends the chunk before soft limit', () => {
  assert.equal(decideSpeechBoundary(3200, P.trailingSilenceMs), 'natural-pause');
});
test('hard safety cap prevents unlimited packets', () => {
  assert.equal(decideSpeechBoundary(P.hardMaxUtteranceMs, 0), 'max-duration');
});
test('tail duration correct at real sample rates', () => {
  for (const rate of [44100, 48000, 16000]) {
    const a = [new Float32Array(rate / 5), new Float32Array(rate / 5)];
    const tail = retainAudioTail(a, rate, P.forcedOverlapMs);
    assert.ok(Math.abs(tail.durationMs - P.forcedOverlapMs) < 0.02);
    assert.equal(tail.chunks.reduce((n,c)=>n+c.length,0),Math.round(rate * P.forcedOverlapMs / 1000));
  }
});
test('invalid rates and buffers stay safe', () => {
  assert.deepEqual(retainAudioTail([], 44100, 250), { chunks: [], durationMs: 0 });
  assert.deepEqual(retainAudioTail([new Float32Array(10)], 0, 250), { chunks: [], durationMs: 0 });
  assert.equal(decideSpeechBoundary(Number.NaN, 0), 'continue');
});
