#!/usr/bin/env node
// Run from the Khutbah AI folder (next to package.json).
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const root = process.cwd();
const inputDir = path.resolve(__dirname, '..');
const mainPath = path.join(root, 'src', 'main', 'index.ts');
const pkgPath = path.join(root, 'package.json');
const updaterPath = path.join(root, 'src', 'main', 'khutbahAutoUpdater.ts');
const owner = process.argv[2];
const repo = process.argv[3];

function fail(text) { console.error('FEHLER: ' + text); process.exit(1); }
const validName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
if (!validName.test(owner || '') || !validName.test(repo || '')) fail('Bitte gueltigen GitHub-Benutzernamen und Repository-Namen angeben.');
if (!fs.existsSync(pkgPath) || !fs.existsSync(mainPath)) fail('Bitte BAT im aktuellen Khutbah-AI-Projektordner neben package.json ausfuehren.');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
let main = fs.readFileSync(mainPath, 'utf8');
if (!main.includes('app.whenReady().then(')) fail('Die App-Struktur weicht ab; keine Dateien geaendert.');
if (!pkg.build || !pkg.build.win || !pkg.scripts) fail('Keine electron-builder Konfiguration gefunden; keine Dateien geaendert.');

// Don't accidentally overwrite the current app; back up both original files.
const updaterTemplate = path.join(inputDir, 'src', 'main', 'khutbahAutoUpdater.ts');
if (!fs.existsSync(updaterTemplate)) fail('Update-Modul fehlt im entpackten ZIP. Bitte gesamten Inhalt kopieren.');
const updaterSource = fs.readFileSync(updaterTemplate, 'utf8');
const backupDir = path.join(root, `backup-vor-auto-update-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(backupDir, { recursive: true });
fs.copyFileSync(pkgPath, path.join(backupDir, 'package.json'));
fs.copyFileSync(mainPath, path.join(backupDir, 'index.ts'));
if (fs.existsSync(updaterPath)) fs.copyFileSync(updaterPath, path.join(backupDir, 'khutbahAutoUpdater.ts'));

const importLine = "import { startKhutbahAutoUpdates } from './khutbahAutoUpdater';";
if (!main.includes(importLine)) main = importLine + '\n' + main;
const marker = '  startKhutbahAutoUpdates(); // KHUTBAH_AUTO_UPDATE_HOOK';
if (!main.includes('KHUTBAH_AUTO_UPDATE_HOOK')) {
  const pattern = /app\.whenReady\(\)\.then\(\(\)\s*=>\s*\{/;
  if (!pattern.test(main)) fail('Startposition fuer Auto-Updater nicht gefunden.');
  main = main.replace(pattern, (match) => `${match}\n${marker}`);
}

pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['electron-updater'] = '^6.8.11';
pkg.build.publish = [{ provider: 'github', owner, repo, releaseType: 'release' }];
pkg.build.electronUpdaterCompatibility = '>=6.0.0';
pkg.build.win.target = [
  { target: 'nsis', arch: ['x64'] },
  { target: 'portable', arch: ['x64'] }
];
pkg.build.nsis = {
  oneClick: false,
  perMachine: false,
  allowToChangeInstallationDirectory: false,
  createDesktopShortcut: true,
  createStartMenuShortcut: true
};
pkg.build.win.artifactName = 'Khutbah-AI-${version}-${arch}.${ext}';
pkg.scripts['package:update:win'] = 'npm run build && electron-builder --win nsis --x64 --publish never';

fs.writeFileSync(mainPath, main, 'utf8');
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
fs.writeFileSync(updaterPath, updaterSource, 'utf8');
console.log('Auto-Update eingebaut. Einstellungen gesichert in:', backupDir);
console.log(`Update-Repository: https://github.com/${owner}/${repo}/releases`);
console.log('WICHTIG: Fuer Auto-Updates den NSIS-Installer benutzen, nicht die portable EXE.');
