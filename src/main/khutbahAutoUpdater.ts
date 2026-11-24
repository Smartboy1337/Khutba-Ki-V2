/**
 * Safe, unattended update checks for installed Windows NSIS versions.
 * Downloads occur in the background. Installation is deliberately deferred
 * until normal app exit so a sermon/OBS session is never interrupted.
 */
import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error' | 'development';
export interface UpdateStatus {
  version: string;
  phase: UpdatePhase;
  message: string;
  progress: number | null;
  availableVersion: string | null;
  lastCheckedAt: string | null;
  installOnQuit: boolean;
}

let initialized = false;
let checking = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let intervalTimer: ReturnType<typeof setInterval> | undefined;
let initialTimer: ReturnType<typeof setTimeout> | undefined;
let status: UpdateStatus = {
  version: app.getVersion(),
  phase: app.isPackaged ? 'idle' : 'development',
  message: app.isPackaged ? 'Automatische Updates bereit' : 'Updates nur in installierter EXE',
  progress: null,
  availableVersion: null,
  lastCheckedAt: null,
  installOnQuit: false
};

function writeLog(message: string): void {
  try {
    const directory = app.getPath('userData');
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, 'khutbah-updates.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // File logging may fail, but live operation must continue.
  }
}

function publish(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch, version: app.getVersion() };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('updater:status', { ...status });
    }
  }
}

export function getKhutbahUpdateStatus(): UpdateStatus {
  return { ...status };
}

function canAutoUpdate(): boolean {
  return app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE;
}

function scheduleRetry(): void {
  if (retryTimer || status.installOnQuit) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void checkKhutbahUpdates();
  }, 2 * 60 * 1000);
}

export async function checkKhutbahUpdates(): Promise<UpdateStatus> {
  if (!canAutoUpdate()) {
    publish({ phase: 'development', message: 'Updates nur in installierter Windows-Version' });
    return getKhutbahUpdateStatus();
  }
  if (checking || status.phase === 'downloading' || status.installOnQuit) return getKhutbahUpdateStatus();
  checking = true;
  publish({ phase: 'checking', message: 'Suche nach neuer Version …', lastCheckedAt: new Date().toISOString(), progress: null });
  try {
    // autoDownload=true ensures no additional user interaction is required.
    await autoUpdater.checkForUpdates();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLog(`Aktualisierungsprüfung fehlgeschlagen: ${message}`);
    publish({ phase: 'error', message: `Update-Prüfung fehlgeschlagen: ${message}` });
    scheduleRetry();
  } finally {
    checking = false;
  }
  return getKhutbahUpdateStatus();
}

export function startKhutbahAutoUpdates(): void {
  if (initialized) return;
  initialized = true;
  if (!canAutoUpdate()) {
    publish({ phase: 'development', message: 'Updates nur mit dem Windows-Setup' });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    writeLog('Suche nach Updates');
    publish({ phase: 'checking', message: 'GitHub wird geprüft …' });
  });
  autoUpdater.on('update-available', (info) => {
    writeLog(`Update vorhanden: ${info.version}`);
    publish({ phase: 'available', availableVersion: info.version, message: `Version ${info.version} gefunden – Download startet` });
  });
  autoUpdater.on('update-not-available', () => {
    writeLog('Aktuelle Version ist aktuell');
    publish({ phase: 'up-to-date', message: 'Du verwendest die neueste Version', progress: null });
  });
  autoUpdater.on('download-progress', (info) => {
    publish({ phase: 'downloading', message: `Update wird heruntergeladen (${Math.round(info.percent)} %)`, progress: Math.round(info.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    writeLog(`Version ${info.version} heruntergeladen; Installation beim Beenden`);
    publish({ phase: 'downloaded', availableVersion: info.version, progress: 100, installOnQuit: true, message: `Version ${info.version} bereit – wird beim normalen Beenden installiert` });
    if (retryTimer) clearTimeout(retryTimer);
  });
  autoUpdater.on('error', (error) => {
    writeLog(`Update-Fehler: ${error.message}`);
    publish({ phase: 'error', message: `Update-Fehler: ${error.message}`, progress: null });
    scheduleRetry();
  });

  // First check quickly enough to feel automatic; then periodic checks and retry on network failure.
  initialTimer = setTimeout(() => void checkKhutbahUpdates(), 5_000);
  intervalTimer = setInterval(() => void checkKhutbahUpdates(), 15 * 60 * 1000);
  app.once('before-quit', () => {
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    if (retryTimer) clearTimeout(retryTimer);
    // electron-updater's own on-quit handler runs the NSIS installer.
  });
}
