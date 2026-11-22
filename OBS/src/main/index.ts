import { app, BrowserWindow, clipboard, ipcMain, net, powerSaveBlocker, safeStorage, screen, session } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ISLAMIC_GLOSSARY, type GlossaryRule } from './glossary';
import { ObsOverlayServer } from './obsOverlay';
import { sanitizeObsUrl } from '../shared/obsUrl';
import {
  setFetchImplementation,
  transcribeAndTranslateWav,
  translateArabicToGerman,
  verifyGoogleApiKey,
  warmUpGoogleConnections,
  type CloudTranslationConfig
} from './googleCloudService';

export interface LiveTranscriptBlock {
  id: string;
  arabic: string;
  german: string;
  isLiveActive?: boolean;
}

export interface ProjectorPayload {
  mode: 'de' | 'ar' | 'both';
  blocks: LiveTranscriptBlock[];
  arabic: string;
  german: string;
  fontSizeDe: number;
  fontSizeAr: number;
  lineHeight: number;
  maxWidthPercent: number;
  visibleBlockCount?: number;
  textAlign: 'left' | 'center' | 'right';
  textColor: string;
  arabicColor: string;
  backgroundColor: string;
}

interface PersistedSettings {
  encryptedApiKey?: string;
  plainApiKey?: string;
  languageCode: string;
  enableIslamicGlossary: boolean;
  customGlossary: GlossaryRule[];
  visibleBlockCount?: number;
  chunkIntervalMs?: number;
}

const obsOverlay = new ObsOverlayServer();
let obsUrlError: string | null = null;
let controlWindow: BrowserWindow | null = null;
let projectorWindow: BrowserWindow | null = null;

let latestPayload: ProjectorPayload = {
  mode: 'both',
  blocks: [],
  arabic: '',
  german: '',
  fontSizeDe: 34,
  fontSizeAr: 42,
  lineHeight: 1.55,
  maxWidthPercent: 92,
  textAlign: 'center',
  textColor: '#F5F2EB',
  arabicColor: '#F7D774',
  backgroundColor: '#030304'
};

interface AppSettings {
  apiKey: string;
  languageCode: string;
  enableIslamicGlossary: boolean;
  customGlossary: GlossaryRule[];
  visibleBlockCount: number;
  chunkIntervalMs: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  languageCode: 'ar-SA',
  enableIslamicGlossary: true,
  customGlossary: DEFAULT_ISLAMIC_GLOSSARY,
  visibleBlockCount: 5,
  chunkIntervalMs: 1200
};

// Einstellungen werden EINMAL geladen und im Speicher gehalten. Früher wurde die Datei
// bei jedem Audio-Paket gelesen und der Schlüssel entschlüsselt.
let settingsCache: AppSettings | null = null;

function getSettingsFilePath(): string {
  return join(app.getPath('userData'), 'khutbah-ai-settings.json');
}

function readSettingsFromDisk(): AppSettings {
  const file = getSettingsFilePath();
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as PersistedSettings;
    let apiKey = '';
    try {
      if (raw.encryptedApiKey && safeStorage.isEncryptionAvailable()) {
        apiKey = safeStorage.decryptString(Buffer.from(raw.encryptedApiKey, 'base64'));
      } else if (raw.plainApiKey) {
        apiKey = raw.plainApiKey;
      }
    } catch (error) {
      console.error('API-Schlüssel konnte nicht entschlüsselt werden:', error);
    }
    return {
      apiKey,
      languageCode: raw.languageCode || 'ar-SA',
      enableIslamicGlossary: raw.enableIslamicGlossary ?? true,
      customGlossary: Array.isArray(raw.customGlossary) ? raw.customGlossary : DEFAULT_ISLAMIC_GLOSSARY,
      visibleBlockCount: raw.visibleBlockCount ?? 5,
      chunkIntervalMs: raw.chunkIntervalMs ?? 1200
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function loadSettings(): AppSettings {
  if (!settingsCache) settingsCache = readSettingsFromDisk();
  return settingsCache;
}

function writeSettingsToDisk(settings: AppSettings) {
  const file = getSettingsFilePath();
  const data: PersistedSettings = {
    languageCode: settings.languageCode,
    enableIslamicGlossary: settings.enableIslamicGlossary,
    customGlossary: settings.customGlossary,
    visibleBlockCount: settings.visibleBlockCount,
    chunkIntervalMs: settings.chunkIntervalMs
  };
  if (settings.apiKey.trim()) {
    if (safeStorage.isEncryptionAvailable()) {
      data.encryptedApiKey = safeStorage.encryptString(settings.apiKey.trim()).toString('base64');
    } else {
      data.plainApiKey = settings.apiKey.trim();
    }
  }
  // Atomar schreiben: erst Temp-Datei, dann umbenennen. Ein Stromausfall während
  // des Speicherns kann die Einstellungsdatei so nicht mehr zerstören.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, file);
}

function saveSettings(input: Partial<AppSettings>, options: { keepApiKey?: boolean } = {}) {
  const current = loadSettings();
  const next: AppSettings = {
    apiKey: options.keepApiKey ? current.apiKey : String(input.apiKey ?? current.apiKey).trim(),
    languageCode: typeof input.languageCode === 'string' && input.languageCode ? input.languageCode : current.languageCode,
    enableIslamicGlossary: typeof input.enableIslamicGlossary === 'boolean' ? input.enableIslamicGlossary : current.enableIslamicGlossary,
    customGlossary: Array.isArray(input.customGlossary) ? input.customGlossary : current.customGlossary,
    visibleBlockCount: Number.isFinite(input.visibleBlockCount) ? Number(input.visibleBlockCount) : current.visibleBlockCount,
    chunkIntervalMs: Number.isFinite(input.chunkIntervalMs) ? Number(input.chunkIntervalMs) : current.chunkIntervalMs
  };
  settingsCache = next;
  writeSettingsToDisk(next);
}

function getDisplayList() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label:
      d.id === primaryId
        ? `Bildschirm ${i + 1} (Hauptmonitor)`
        : `Bildschirm ${i + 1}${d.label ? ` – ${d.label}` : ''}`,
    width: d.size.width,
    height: d.size.height,
    primary: d.id === primaryId
  }));
}

function broadcastDisplays() {
  const list = getDisplayList();
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('displays:changed', list);
  }
}

/** Lädt ein abgestürztes oder hängendes Fenster automatisch neu, statt schwarz zu bleiben. */
function attachCrashRecovery(win: BrowserWindow, name: string) {
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`${name}-Fenster abgestürzt:`, details.reason);
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload();
    }, 500);
  });
  win.on('unresponsive', () => {
    console.error(`${name}-Fenster reagiert nicht.`);
  });
}

let powerBlockerId: number | null = null;
function setKeepAwake(active: boolean) {
  if (active && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!active && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 1460,
    height: 950,
    minWidth: 1050,
    minHeight: 720,
    title: 'Khutbah AI – Moschee Al Badr',
    backgroundColor: '#060607',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Audio-Aufnahme & Übersetzung dürfen nicht gedrosselt werden, wenn das Fenster
      // hinter OBS liegt oder minimiert ist.
      backgroundThrottling: false
    }
  });
  attachCrashRecovery(controlWindow, 'Steuerung');

  if (process.env.ELECTRON_RENDERER_URL) {
    controlWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    controlWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  controlWindow.on('closed', () => {
    controlWindow = null;
    if (projectorWindow && !projectorWindow.isDestroyed()) {
      projectorWindow.close();
    }
  });
}

function openProjector(displayId?: number) {
  const displays = screen.getAllDisplays();
  const target =
    displays.find((d) => d.id === displayId) ??
    displays.find((d) => d.id !== screen.getPrimaryDisplay().id) ??
    screen.getPrimaryDisplay();

  if (projectorWindow && !projectorWindow.isDestroyed()) {
    projectorWindow.setFullScreen(false);
    projectorWindow.setBounds(target.bounds);
    projectorWindow.setFullScreen(true);
    projectorWindow.focus();
    projectorWindow.webContents.send('content:update', latestPayload);
    return;
  }

  projectorWindow = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    fullscreen: true,
    frame: false,
    backgroundColor: latestPayload.backgroundColor,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  attachCrashRecovery(projectorWindow, 'Beamer');

  if (process.env.ELECTRON_RENDERER_URL) {
    projectorWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/projector`);
  } else {
    projectorWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: '/projector'
    });
  }

  projectorWindow.webContents.on('did-finish-load', () => {
    if (projectorWindow && !projectorWindow.isDestroyed()) {
      projectorWindow.webContents.send('content:update', latestPayload);
    }
  });

  projectorWindow.on('closed', () => {
    projectorWindow = null;
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('projector:status', false);
    }
  });

  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('projector:status', true);
  }
}

// Nur eine Instanz: verhindert doppelte Mikrofon-Aufnahme und Port-Konflikte für OBS.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      if (controlWindow.isMinimized()) controlWindow.restore();
      controlWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  // Chromium-Netzwerkstack für Google-Anfragen (HTTP/2, Verbindungs-Wiederverwendung, Proxy).
  setFetchImplementation((url, init) => net.fetch(url, init));
  loadSettings();
  void warmUpGoogleConnections();
  try {
    await obsOverlay.start();
  } catch (error) {
    obsUrlError = error instanceof Error ? error.message : String(error);
    console.error('OBS overlay could not start:', obsUrlError);
  }
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media';
  });

  ipcMain.handle('obs:getUrl', () => ({ url: obsOverlay.getUrl(), error: obsUrlError }));
  ipcMain.handle('obs:copyUrl', (_event, requestedUrl?: string) => {
    const base = obsOverlay.getUrl();
    if (!base) return false;
    // Alle Parameter des angezeigten Links (Layout, Größe, Zeilen, Hintergrund, Abstand)
    // werden übernommen. Früher gingen sie verloren -> falscher Link in der Zwischenablage.
    const clean = sanitizeObsUrl(requestedUrl, base);
    if (!clean) return false;
    try {
      clipboard.writeText(clean);
      return clipboard.readText() === clean ? clean : false;
    } catch {
      return false;
    }
  });
  ipcMain.handle('power:keepAwake', (_event, active: boolean) => {
    setKeepAwake(Boolean(active));
    return true;
  });
  ipcMain.handle('displays:list', () => getDisplayList());
  ipcMain.handle('content:getInitial', () => latestPayload);
  ipcMain.handle('projector:isOpen', () => Boolean(projectorWindow && !projectorWindow.isDestroyed()));

  ipcMain.handle('projector:open', (_event, displayId?: number) => {
    openProjector(displayId);
    return true;
  });

  ipcMain.handle('projector:close', () => {
    if (projectorWindow && !projectorWindow.isDestroyed()) {
      projectorWindow.close();
    }
    return true;
  });

  ipcMain.on('content:update', (_event, payload: ProjectorPayload) => {
    latestPayload = payload;
    obsOverlay.publish(payload);
    if (projectorWindow && !projectorWindow.isDestroyed()) {
      projectorWindow.webContents.send('content:update', payload);
    }
  });

  ipcMain.handle('settings:load', () => loadSettings());

  ipcMain.handle('settings:save', (_event, settings: Partial<AppSettings>) => {
    saveSettings(settings);
    return true;
  });

  // Automatisches Speichern von Sprache, Glossar, Tempo usw. – ohne den API-Schlüssel anzufassen.
  ipcMain.handle('settings:update', (_event, settings: Partial<AppSettings>) => {
    saveSettings(settings, { keepApiKey: true });
    return true;
  });

  ipcMain.handle('cloud:verifyKey', async (_event, apiKey: string) => {
    return verifyGoogleApiKey(apiKey);
  });

  ipcMain.handle(
    'cloud:processAudioSegment',
    async (
      _event,
      wavArrayBuffer: ArrayBuffer,
      meta?: { utteranceId?: number; isFinalPacket?: boolean }
    ) => {
      const stored = loadSettings();
      const config: CloudTranslationConfig = {
        apiKey: stored.apiKey,
        languageCode: stored.languageCode,
        enableIslamicGlossary: stored.enableIslamicGlossary,
        customGlossary: stored.customGlossary
      };
      return transcribeAndTranslateWav(Buffer.from(wavArrayBuffer), config, {
        isFinal: meta?.isFinalPacket !== false
      });
    }
  );

  ipcMain.handle('cloud:translateText', async (_event, arabicText: string) => {
    const stored = loadSettings();
    return translateArabicToGerman(arabicText, stored);
  });

  screen.on('display-added', broadcastDisplays);
  screen.on('display-removed', broadcastDisplays);
  screen.on('display-metrics-changed', broadcastDisplays);

  createControlWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createControlWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  setKeepAwake(false);
  obsOverlay.stop();
});

process.on('uncaughtException', (error) => {
  // Ein unerwarteter Fehler darf die Live-Übersetzung nicht beenden.
  console.error('Unerwarteter Fehler im Hauptprozess:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unbehandelte Promise-Ablehnung:', reason);
});
