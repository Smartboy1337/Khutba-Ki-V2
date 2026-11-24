const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
let ts; try { ts = require('typescript'); } catch { ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript'); }
const source = fs.readFileSync(path.join(__dirname, '../src/main/khutbahAutoUpdater.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }}).outputText;
const messages = [];
const events = new EventEmitter();
let checks = 0;
const updater = Object.assign(events, { checkForUpdates: async () => { checks++; } });
const app = Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '1.1.10', getPath: () => os.tmpdir() });
const timers = [];
const sandbox = {
  module: { exports: {} }, exports: {}, process: { platform: 'win32', env: {} },
  setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
  setInterval: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
  clearTimeout: () => {}, clearInterval: () => {},
  require: (id) => id === 'electron' ? { app, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_channel, status) => messages.push(status) } }] } } : id === 'electron-updater' ? {autoUpdater: updater} : require(id),
};
sandbox.exports = sandbox.module.exports;
vm.runInNewContext(js, sandbox);
const m = sandbox.module.exports;
m.startKhutbahAutoUpdates();
assert.equal(updater.autoDownload, true);
assert.equal(updater.autoInstallOnAppQuit, true);
assert.ok(timers.some(x=>x.ms === 5000));
assert.ok(timers.some(x=>x.ms === 900000));
events.emit('checking-for-update');
events.emit('update-available', { version: '1.1.11' });
events.emit('download-progress', { percent: 44 });
assert.equal(m.getKhutbahUpdateStatus().progress, 44);
events.emit('update-downloaded', {version:'1.1.11'});
assert.equal(m.getKhutbahUpdateStatus().installOnQuit, true);
assert.equal(m.getKhutbahUpdateStatus().availableVersion, '1.1.11');
m.checkKhutbahUpdates().then(() => {
 assert.equal(checks, 0, 'A downloaded update must not start another check');
 assert.ok(messages.some(s=>s.phase==='downloaded'));
 console.log('Updater-Simulation OK: automatischer Download, Downloadfortschritt, Installation beim Beenden, keine Mehrfachsuche.');
});
