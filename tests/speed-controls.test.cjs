const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
let ts;
try { ts = require('typescript'); } catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); }
const filename=path.join(__dirname,'../src/renderer/src/audio/speechBoundary.ts');
const mod=new Module(filename,module); mod.filename=filename; mod.paths=module.paths;
mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
const { getSegmentPolicy,decideSpeechBoundary } = mod.exports;
test('default: hard cut at 5.5s, not at 11s',()=>{
 const p=getSegmentPolicy();
 assert.equal(p.hardMaxUtteranceMs,5500);
 assert.equal(decideSpeechBoundary(5490,0,p),'continue');
 assert.equal(decideSpeechBoundary(5500,0,p),'max-duration');
});
test('slider adjusts maximum without restarting stream',()=>{
 for(const [selected,expected] of [[3500,3500],[4500,4500],[7000,7000],[8500,8500]]){
  const p=getSegmentPolicy(selected);
  assert.equal(p.hardMaxUtteranceMs,expected);
  assert.equal(decideSpeechBoundary(expected,0,p),'max-duration');
 }
});
test('natural silence closes earlier and unsafe values are clamped',()=>{
 const p=getSegmentPolicy(3500);
 assert.equal(decideSpeechBoundary(1800,500,p),'natural-pause');
 assert.equal(getSegmentPolicy(100).hardMaxUtteranceMs,3500);
 assert.equal(getSegmentPolicy(100000).hardMaxUtteranceMs,8500);
});
