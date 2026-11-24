/**
 * Khutbah AI: updates from a public GitHub Releases repository.
 * Only installed NSIS builds update automatically. Development and portable builds do not.
 * Updates download silently, and install only after the program exits.
 */
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let configured = false;
let checking = false;

function logUpdate(message: string): void {
  try {
    const directory = app.getPath('userData');
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, 'khutbah-updates.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // Updates must never break the sermon or the main app.
  }
}

export function startKhutbahAutoUpdates(): void {
  if (configured || !app.isPackaged || process.platform !== 'win32' || process.env.PORTABLE_EXECUTABLE_FILE) return;
  configured = true;

  // Prevent interruption: never force a restart during the Khutbah.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => logUpdate('Suche nach Updates'));
  autoUpdater.on('update-available', (info) => logUpdate(`Update vorhanden: ${info.version}`));
  autoUpdater.on('update-not-available', () => logUpdate('Aktuelle Version ist aktuell'));
  autoUpdater.on('download-progress', (progress) => {
    if (progress.percent >= 99) logUpdate('Download nahezu abgeschlossen');
  });
  autoUpdater.on('update-downloaded', (info) => {
    logUpdate(`Version ${info.version} heruntergeladen; Installation beim Beenden`);
  });
  autoUpdater.on('error', (error) => logUpdate(`Update-Fehler: ${error.message}`));

  const check = async (): Promise<void> => {
    if (checking) return;
    checking = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      logUpdate(`Aktualisierungsprüfung fehlgeschlagen: ${String(error)}`);
    } finally {
      checking = false;
    }
  };

  // Check shortly after launch, then every six hours. Neither restarts nor closes the app.
  setTimeout(() => void check(), 20_000).unref();
  setInterval(() => void check(), 6 * 60 * 60 * 1000).unref();
}
