import { applyIslamicTerminology, DEFAULT_ISLAMIC_GLOSSARY, type GlossaryRule } from './glossary';

// ---------------------------------------------------------------------------
// HTTP-Schicht
// ---------------------------------------------------------------------------

// Live-Vorschauen veralten schnell; fertige Abschnitte dürfen etwas länger brauchen.
const FINAL_TIMEOUT_MS = 10000;
const PREVIEW_TIMEOUT_MS = 6000;
const RAW_CACHE_LIMIT = 300;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// Im Electron-Main-Prozess wird net.fetch (Chromium-Netzwerk: HTTP/2, Verbindungs-Pool,
// System-Proxy) gesetzt. In Tests bleibt globalThis.fetch (mockbar).
let fetchImpl: FetchLike | null = null;
export function setFetchImplementation(fn: FetchLike | null) {
  fetchImpl = fn;
}

class GoogleHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

class GoogleNetworkError extends Error {}

async function googleFetch(url: string, body: unknown, timeoutMs: number): Promise<Response> {
  const doFetch: FetchLike = fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  try {
    return await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new GoogleNetworkError('Google Cloud antwortet nicht rechtzeitig. Internetverbindung prüfen.');
    }
    // URL nie ausgeben – sie enthält den API-Schlüssel.
    throw new GoogleNetworkError('Google Cloud ist nicht erreichbar. Internetverbindung prüfen.');
  }
}

async function readGoogleError(response: Response, fallback: string): Promise<GoogleHttpError> {
  let message = `${fallback} (${response.status})`;
  try {
    const parsed = JSON.parse(await response.text());
    if (parsed?.error?.message) message = parsed.error.message;
  } catch {
    /* Fallback behalten */
  }
  return new GoogleHttpError(message, response.status);
}

function isTransient(err: unknown): boolean {
  if (err instanceof GoogleNetworkError) return true;
  if (err instanceof GoogleHttpError) return err.status === 429 || err.status >= 500;
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wiederholt vorübergehende Fehler (Netz, 429, 5xx) mit kurzer Pause. */
async function withRetry<T>(retries: number, action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (err) {
      if (attempt >= retries || !isTransient(err)) throw err;
      await sleep(250 * (attempt + 1));
    }
  }
}

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

export interface CloudTranslationConfig {
  apiKey: string;
  languageCode: string;
  alternativeLanguageCodes?: string[];
  enableIslamicGlossary: boolean;
  customGlossary: GlossaryRule[];
}

export interface PipelineSegmentResult {
  arabic: string;
  german: string;
  latencyMs: number;
  confidence?: number;
}

export interface SegmentOptions {
  /** Fertiger Abschnitt (true) oder Live-Vorschau (false). */
  isFinal?: boolean;
}

// Ein gespeichertes Profil ist kein BCP-47-Code. Vor dem Google-Aufruf umwandeln.
export function resolveRecognitionLanguages(profile: string, alternatives?: string[]) {
  const languageCode = profile === 'ar-EG-only' ? 'ar-EG' : profile === 'ar-SA-only' ? 'ar-SA' : profile || 'ar-SA';
  const defaults = profile === 'ar-EG-only' || profile === 'ar-SA-only'
    ? [] : languageCode === 'ar-EG' ? ['ar-SA'] : ['ar-EG', 'ar-AE', 'ar-JO'];
  return { languageCode, alternativeLanguageCodes: [...new Set(alternatives ?? defaults)].filter(code => code !== languageCode).slice(0, 3) };
}

// ---------------------------------------------------------------------------
// Spracherkennung
// ---------------------------------------------------------------------------

interface SttVariant {
  model: string;
  withAlternatives: boolean;
}

// Reihenfolge der Versuche. Die erste funktionierende Variante wird gemerkt, damit
// nicht bei JEDEM Paket erst ein 400-Fehler abgewartet wird (das verdoppelte früher die Latenz).
const STT_VARIANTS: SttVariant[] = [
  { model: 'latest_short', withAlternatives: true },
  { model: 'default', withAlternatives: true },
  { model: 'default', withAlternatives: false }
];
const workingVariant = new Map<string, number>();

/** Nur für Tests. */
export function resetSpeechVariantCache() {
  workingVariant.clear();
}

async function recognizeSpeech(
  wavBuffer: Buffer,
  config: CloudTranslationConfig,
  timeoutMs: number
): Promise<{ arabic: string; confidence?: number }> {
  const key = config.apiKey.trim();
  const sttUrl = `https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(key)}`;
  const language = resolveRecognitionLanguages(config.languageCode, config.alternativeLanguageCodes);
  const audioBase64 = wavBuffer.toString('base64');
  const cacheKey = `${key}|${language.languageCode}|${language.alternativeLanguageCodes.join(',')}`;

  let index = workingVariant.get(cacheKey) ?? 0;
  let lastError: GoogleHttpError | null = null;

  while (index < STT_VARIANTS.length) {
    const variant = STT_VARIANTS[index];
    // Ohne Alternativsprachen ist die Variante identisch zur vorherigen – überspringen.
    if (!variant.withAlternatives && language.alternativeLanguageCodes.length === 0) {
      index++;
      continue;
    }
    const sttConfig: Record<string, unknown> = {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
      languageCode: language.languageCode,
      ...(variant.withAlternatives ? { alternativeLanguageCodes: language.alternativeLanguageCodes } : {}),
      enableAutomaticPunctuation: true,
      model: variant.model
    };
    const response = await googleFetch(sttUrl, { config: sttConfig, audio: { content: audioBase64 } }, timeoutMs);

    if (response.ok) {
      workingVariant.set(cacheKey, index);
      const sttJson = (await response.json()) as {
        results?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }> }>;
      };
      const transcripts: string[] = [];
      let confidenceSum = 0;
      let confidenceCount = 0;
      for (const r of sttJson.results ?? []) {
        const alt = r.alternatives?.[0];
        if (alt?.transcript?.trim()) {
          transcripts.push(alt.transcript.trim());
          if (typeof alt.confidence === 'number') {
            confidenceSum += alt.confidence;
            confidenceCount += 1;
          }
        }
      }
      return {
        arabic: transcripts.join(' ').trim(),
        confidence: confidenceCount > 0 ? Number((confidenceSum / confidenceCount).toFixed(2)) : undefined
      };
    }

    const error = await readGoogleError(response, 'Google Speech API Fehler');
    // Nur bei 400 (Modell/Sprache nicht unterstützt) die nächste Variante probieren.
    if (response.status !== 400) throw error;
    lastError = error;
    index++;
  }
  throw lastError ?? new Error('Google Speech API: keine passende Konfiguration gefunden.');
}

/**
 * Erkennung & Übersetzung eines Audio-Pakets (16 kHz Mono WAV).
 */
export async function transcribeAndTranslateWav(
  wavBuffer: Buffer,
  config: CloudTranslationConfig,
  options: SegmentOptions = {}
): Promise<PipelineSegmentResult | null> {
  const startTime = Date.now();
  if (!config.apiKey.trim()) {
    throw new Error('Kein Google Cloud API-Schlüssel hinterlegt.');
  }
  const isFinal = options.isFinal ?? true;
  const timeoutMs = isFinal ? FINAL_TIMEOUT_MS : PREVIEW_TIMEOUT_MS;
  // Fertige Abschnitte dürfen nicht verloren gehen -> bis zu 2 Wiederholungen.
  // Vorschauen werden nicht wiederholt (die nächste Vorschau kommt ohnehin gleich).
  const retries = isFinal ? 2 : 0;

  const { arabic, confidence } = await withRetry(retries, () => recognizeSpeech(wavBuffer, config, timeoutMs));
  if (!arabic) return null;

  const german = await withRetry(retries, () => translateArabicToGerman(arabic, config, false, timeoutMs));

  return { arabic, german, latencyMs: Date.now() - startTime, confidence };
}

// ---------------------------------------------------------------------------
// Übersetzung
// ---------------------------------------------------------------------------

let cacheCredential = '';
const rawTranslationCache = new Map<string, string>();
const inflightTranslations = new Map<string, Promise<string>>();

export async function translateArabicToGerman(
  arabicText: string,
  config: CloudTranslationConfig,
  bypassCache = false,
  timeoutMs = FINAL_TIMEOUT_MS
): Promise<string> {
  const key = config.apiKey.trim();
  if (!key) {
    throw new Error('Kein Google Cloud API-Schlüssel hinterlegt.');
  }

  // Nur exakter arabischer Text -> rohe Google-Antwort wird gecacht.
  // Glossar wird bei jedem Aufruf frisch angewendet.
  if (cacheCredential !== key) {
    cacheCredential = key;
    rawTranslationCache.clear();
    inflightTranslations.clear();
  }

  let rawGerman = bypassCache ? undefined : rawTranslationCache.get(arabicText);
  if (rawGerman !== undefined) {
    // LRU: Eintrag nach hinten schieben
    rawTranslationCache.delete(arabicText);
    rawTranslationCache.set(arabicText, rawGerman);
  } else {
    // Gleicher Text gleichzeitig angefragt (Vorschau + Final)? -> nur eine Anfrage.
    let pending = bypassCache ? undefined : inflightTranslations.get(arabicText);
    if (!pending) {
      pending = requestTranslation(arabicText, key, timeoutMs);
      if (!bypassCache) {
        inflightTranslations.set(arabicText, pending);
        const cleanup = () => {
          if (inflightTranslations.get(arabicText) === pending) inflightTranslations.delete(arabicText);
        };
        pending.then(cleanup, cleanup);
      }
    }
    rawGerman = await pending;
    if (!rawGerman) return '';
    // Kein Wiederverwenden über Schlüsselwechsel hinweg.
    if (cacheCredential === key) {
      if (rawTranslationCache.size >= RAW_CACHE_LIMIT) {
        const oldest = rawTranslationCache.keys().next().value;
        if (oldest !== undefined) rawTranslationCache.delete(oldest);
      }
      rawTranslationCache.set(arabicText, rawGerman);
    }
  }

  if (config.enableIslamicGlossary) {
    return applyIslamicTerminology(
      rawGerman,
      arabicText,
      config.customGlossary.length > 0 ? config.customGlossary : DEFAULT_ISLAMIC_GLOSSARY
    );
  }
  return rawGerman;
}

async function requestTranslation(arabicText: string, key: string, timeoutMs: number): Promise<string> {
  const translateUrl = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`;
  const trResponse = await googleFetch(
    translateUrl,
    { q: arabicText, source: 'ar', target: 'de', format: 'text' },
    timeoutMs
  );
  if (!trResponse.ok) {
    throw await readGoogleError(trResponse, 'Google Translation API Fehler');
  }
  const trJson = (await trResponse.json()) as {
    data?: { translations?: Array<{ translatedText?: string }> };
  };
  return trJson.data?.translations?.[0]?.translatedText?.trim() ?? '';
}

export async function verifyGoogleApiKey(apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    const translated = await translateArabicToGerman('السلام عليكم', {
      apiKey,
      languageCode: 'ar-SA',
      enableIslamicGlossary: false,
      customGlossary: []
    }, true);
    if (!translated) {
      return { ok: false, message: 'API antwortete ohne Übersetzungstext.' };
    }
    return {
      ok: true,
      message: `Verbindung erfolgreich! Testübersetzung: „السلام عليكم“ → „${translated}“`
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Verbindung zu Google Cloud fehlgeschlagen.'
    };
  }
}

/**
 * Baut die TLS-Verbindungen zu Google schon vor der Predigt auf (spart beim ersten
 * Paket einige hundert Millisekunden). Fehler werden ignoriert.
 */
export async function warmUpGoogleConnections(): Promise<void> {
  const doFetch: FetchLike = fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  await Promise.allSettled(
    ['https://speech.googleapis.com/', 'https://translation.googleapis.com/'].map((url) =>
      doFetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) } as RequestInit)
    )
  );
}
