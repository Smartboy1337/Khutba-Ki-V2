const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const Module = require('node:module');
const filename = require('node:path').join(__dirname, '../src/renderer/src/audio/speechBoundary.ts');
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = module.paths;
mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, filename);
const { decideSpeechBoundary, retainAudioTail, SEGMENT_POLICY } = mod.exports;

test('short gaps within an Arabic syllable do not finalize a sentence', () => {
  assert.equal(decideSpeechBoundary(2200, 500), 'continue');
  assert.equal(decideSpeechBoundary(2200, 700), 'continue');
  assert.equal(decideSpeechBoundary(2200, SEGMENT_POLICY.trailingSilenceMs), 'natural-pause');
});
test('very short utterances are not flushed by a pause alone', () => {
  assert.equal(decideSpeechBoundary(600, 1200), 'continue');
});
test('a continuous long sentence is bounded without infinite growth', () => {
  assert.equal(decideSpeechBoundary(6300, 0), 'continue');
  assert.equal(decideSpeechBoundary(11000, 0), 'max-duration');
});
test('audio tail is retained by samples for both 48 kHz and 44.1 kHz', () => {
  for (const rate of [48000, 44100]) {
    const c = [new Float32Array(rate / 10 | 0).fill(1), new Float32Array(rate / 10 | 0).fill(2), new Float32Array(rate / 10 | 0).fill(3)];
    const tail = retainAudioTail(c, rate, 180);
    assert.ok(Math.abs(tail.durationMs - 180) < 0.1, String(rate));
    assert.equal(tail.chunks.at(-1).at(-1), 3);
    assert.equal(tail.chunks[0][0], 2);
  }
});
test('empty tail and invalid rate are handled safely', () => {
  assert.deepEqual(retainAudioTail([], 48000, 180), { chunks: [], durationMs: 0 });
  assert.deepEqual(retainAudioTail([new Float32Array(10)], 0, 180), { chunks: [], durationMs: 0 });
});
