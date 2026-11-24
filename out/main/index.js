"use strict";
const electron = require("electron");
const node_fs = require("node:fs");
const node_path = require("node:path");
const node_http = require("node:http");
const DEFAULT_ISLAMIC_GLOSSARY = [
  { arabicPattern: "خطبة", germanReplacement: "Khutbah" },
  { arabicPattern: "الخطبة", germanReplacement: "die Khutbah" },
  { arabicPattern: "الجمعة", germanReplacement: "Jumu'ah (Freitag)" },
  { arabicPattern: "التقوى", germanReplacement: "Taqwa (Gottesfurcht)" },
  { arabicPattern: "تقوى الله", germanReplacement: "Taqwa (Gottesfurcht) vor Allah" },
  { arabicPattern: "السنة", germanReplacement: "Sunnah" },
  { arabicPattern: "القرآن", germanReplacement: "Koran" },
  { arabicPattern: "الإمام", germanReplacement: "Imam" },
  { arabicPattern: "الصلاة", germanReplacement: "Gebet (Salah)" },
  { arabicPattern: "الزكاة", germanReplacement: "Zakah" },
  { arabicPattern: "رمضان", germanReplacement: "Ramadan" },
  { arabicPattern: "الصحابة", germanReplacement: "Sahaba (Gefährten des Propheten)" },
  { arabicPattern: "إن شاء الله", germanReplacement: "in scha Allah" },
  { arabicPattern: "الحمد لله", germanReplacement: "Alhamdulillah (Alles Lob gebührt Allah)" },
  { arabicPattern: "سبحان الله", germanReplacement: "Subhanallah (Gepriesen sei Allah)" }
];
function applyIslamicTerminology(germanText, arabicSource, customRules = DEFAULT_ISLAMIC_GLOSSARY) {
  let result = germanText.trim();
  const postReplacements = [
    [/\bFreitagspredigt\b/gi, "Khutbah (Freitagspredigt)"],
    [/\bGottesfurcht\b/gi, "Taqwa (Gottesfurcht)"],
    [/\bAlmosensteuer\b/gi, "Zakah"],
    [/\bProphetengefährten\b/gi, "Sahaba (Gefährten des Propheten)"]
  ];
  for (const [pattern, replacement] of postReplacements) {
    if (pattern.test(result)) {
      result = result.replace(pattern, replacement);
    }
  }
  for (const rule of customRules) {
    if (rule.arabicPattern && rule.germanReplacement && arabicSource.includes(rule.arabicPattern) && !result.toLowerCase().includes(rule.germanReplacement.toLowerCase())) {
      if (rule.arabicPattern === "التقوى" && /Frömmigkeit/i.test(result)) {
        result = result.replace(/Frömmigkeit/gi, rule.germanReplacement);
      }
    }
  }
  return result;
}
var __freeze = Object.freeze;
var __defProp = Object.defineProperty;
var __template = (cooked, raw) => __freeze(__defProp(cooked, "raw", { value: __freeze(cooked.slice()) }));
var _a;
const DEFAULT_OBS_PORT = 47811;
const initialPayload = {
  blocks: [],
  mode: "both",
  visibleBlockCount: 5,
  maxWidthPercent: 92,
  fontSizeDe: 34,
  fontSizeAr: 42,
  lineHeight: 1.55,
  textAlign: "center",
  textColor: "#F5F2EB",
  arabicColor: "#F7D774"
};
class ObsOverlayServer {
  server = null;
  clients = /* @__PURE__ */ new Set();
  heartbeat = null;
  current = initialPayload;
  currentMessage = JSON.stringify(initialPayload);
  url = null;
  /**
   * Startet den lokalen OBS-Server. Es wird ein FESTER Port bevorzugt, damit die in OBS
   * eingetragenen Links auch nach einem Neustart des Programms weiter funktionieren.
   * Nur wenn der Port belegt ist, wird ein freier Port gewählt.
   */
  async start(preferredPort = DEFAULT_OBS_PORT) {
    if (this.url) return this.url;
    if (this.server) throw new Error("OBS-Server wird bereits gestartet.");
    const server = node_http.createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      if (path !== "/events") res.setHeader("Connection", "close");
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      if (path === "/obs" || path === "/captions") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors *");
        res.writeHead(200).end(OBS_PAGE);
        return;
      }
      if (path === "/events") {
        if (this.clients.size >= 12) {
          res.writeHead(503).end("Too many OBS clients");
          return;
        }
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Connection", "keep-alive");
        res.writeHead(200);
        req.socket.setNoDelay(true);
        req.socket.setKeepAlive(true);
        res.write(`retry: 1000
data: ${this.currentMessage}

`);
        this.clients.add(res);
        res.on("close", () => this.clients.delete(res));
        return;
      }
      res.writeHead(404).end("Not found");
    });
    this.server = server;
    server.keepAliveTimeout = 65e3;
    const listen = (port) => new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    try {
      try {
        await listen(preferredPort);
      } catch (error) {
        if (preferredPort === 0) throw error;
        await listen(0);
      }
    } catch (error) {
      this.server = null;
      server.close();
      throw error;
    }
    const address = server.address();
    this.url = `http://127.0.0.1:${address.port}/obs`;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (!client.destroyed) client.write(": heartbeat\n\n");
      }
    }, 15e3);
    return this.url;
  }
  getUrl() {
    return this.url;
  }
  publish(payload) {
    this.current = {
      blocks: payload.blocks.slice(-12).map(({ id, arabic, german, isLiveActive }) => ({
        id: String(id).slice(0, 100),
        arabic: String(arabic ?? "").slice(0, 15e3),
        german: String(german ?? "").slice(0, 15e3),
        isLiveActive: Boolean(isLiveActive)
      })),
      mode: ["de", "ar", "both"].includes(payload.mode) ? payload.mode : "de",
      visibleBlockCount: Number.isFinite(payload.visibleBlockCount) ? Math.max(1, Math.min(12, Math.round(payload.visibleBlockCount))) : 5,
      maxWidthPercent: Number.isFinite(payload.maxWidthPercent) ? Math.max(40, Math.min(100, payload.maxWidthPercent)) : 92,
      fontSizeDe: Number(payload.fontSizeDe) || 34,
      fontSizeAr: Number(payload.fontSizeAr) || 42,
      lineHeight: Number(payload.lineHeight) || 1.55,
      textAlign: ["left", "center", "right"].includes(payload.textAlign) ? payload.textAlign : "center",
      textColor: String(payload.textColor ?? "#F5F2EB").slice(0, 20),
      arabicColor: String(payload.arabicColor ?? "#F7D774").slice(0, 20)
    };
    const json = JSON.stringify(this.current);
    if (json === this.currentMessage) return;
    this.currentMessage = json;
    const message = `data: ${json}

`;
    for (const client of this.clients) {
      if (client.destroyed || client.writableEnded) {
        this.clients.delete(client);
        continue;
      }
      client.write(message);
    }
  }
  stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.server?.closeAllConnections?.();
    this.server?.close();
    this.server = null;
    this.url = null;
  }
}
const OBS_PAGE = String.raw(_a || (_a = __template([`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Khutbah AI – OBS</title>
<style>
  :root { color-scheme: light; }
  html,body { margin:0; width:100%; height:100%; overflow:hidden; background:transparent !important; }
  * { box-sizing:border-box; }
  #surface { position:absolute; inset:0; width:100%; height:100%; overflow:hidden; display:flex;
    flex-direction:column; align-items:center; justify-content:center; padding:4vw; }
  #content { display:flex; flex-direction:column; justify-content:flex-end; gap:26px; width:100%; max-height:90vh; overflow:hidden; }
  .entry { flex-shrink:0; min-width:0; padding-bottom:18px; border-bottom:1px solid rgba(255,255,255,.12); }
  .entry:last-child { padding-bottom:0; border-bottom:none; }
  .de,.ar { margin:0; font-family:'Segoe UI',Tahoma,Arial,sans-serif; font-weight:650;
    overflow-wrap:anywhere; white-space:pre-wrap; text-shadow:0 2px 5px rgba(0,0,0,.95),0 0 14px rgba(0,0,0,.85); }
  .ar { font-family:'Noto Naskh Arabic','Traditional Arabic','Segoe UI',sans-serif; direction:rtl; }
  .live-dot { display:inline-block; height:6px; width:6px; border-radius:50%; background:#d4af37;
    margin-inline-start:8px; vertical-align:middle; }
  /* Stream captions: transparent browser source over the camera, readable on phones. */
  body.captions #surface { justify-content:flex-end; align-items:center; padding:0 4% 5%; }
  body.captions #content { width:100% !important; max-height:none; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; gap:0; }
  body.captions .caption-box { max-width:96%; min-width:0; border-radius:10px; padding:10px 22px;
    display:flex; flex-direction:column; align-items:center; gap:4px;
    box-decoration-break:clone; -webkit-box-decoration-break:clone; }
  body.captions .caption-text { font-family:'Segoe UI',Arial,sans-serif; font-weight:700;
    text-align:center !important; overflow:hidden; overflow-wrap:break-word; white-space:pre-wrap;
    display:-webkit-box; -webkit-box-orient:vertical; text-overflow:ellipsis;
    text-shadow:0 2px 5px rgba(0,0,0,.95),0 0 10px rgba(0,0,0,.8); }
  body.captions .caption-text:empty { display:none; }
  body.lower #surface { justify-content:flex-end; padding:28px 48px 44px; }
  body.lower #content { gap:12px; max-height:75vh; }
  body.lower .entry { padding-bottom:6px; }
</style>
</head><body>
<div id="surface"><div id="content" aria-live="polite"></div></div>
<script>
(() => {
  'use strict';
  const qs = new URLSearchParams(location.search);
  // Unless explicitly overridden, OBS follows the application's projector options.
  const selectedMode = qs.get('mode');
  const selectedLines = qs.get('lines');
  // Livestream subtitles are the safe default; the mosque-style output is opt-in.
  const layout = qs.get('layout') === 'full' ? 'full' : qs.get('layout') === 'lower' ? 'lower' : 'captions';
  const scaleQuery = Number(qs.get('scale'));
  const scale = qs.has('scale') && Number.isFinite(scaleQuery) ? Math.max(.5,Math.min(3,scaleQuery)) : 1;
  document.body.classList.toggle('lower',layout === 'lower');
  document.body.classList.toggle('captions',layout === 'captions');
  const captionLines = Math.round(Math.max(1,Math.min(3,Number(qs.get('captionLines')) || 2)));
  const bgValue = Number(qs.get('captionBg'));
  const captionBg = qs.has('captionBg') && Number.isFinite(bgValue) ? Math.max(0,Math.min(.9,bgValue)) : .65;
  const captionBottom = Math.max(1,Math.min(20,Number(qs.get('captionBottom')) || 5));
  let captionElements = [];
  let captionBox = null;
  const content = document.getElementById('content');
  const color = (value,fallback) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
  const safeNum = (value,low,high,fallback) => Number.isFinite(Number(value)) ? Math.max(low,Math.min(high,Number(value))) : fallback;
  function paragraph(text,cls,c,size,lh,align,live) {
    const p = document.createElement('p');
    p.className = cls;
    p.textContent = text; // Never interpret transcription as HTML.
    p.style.color = c;
    p.style.fontSize = (size * scale) + 'px';
    p.style.lineHeight = String(lh);
    p.style.textAlign = align;
    if (live) { const dot = document.createElement('span'); dot.className = 'live-dot'; p.appendChild(dot); }
    return p;
  }
  function render(data) {
    if (layout === 'captions') {
      // Two subtitle lines mean up to two recent German translation segments,
      // not just a two-line word wrap of the latest single segment.
      // Older entries remain before the current one, as in normal subtitles.
      const blocks = Array.isArray(data.blocks) ? data.blocks : [];
      const recent = blocks
        .filter(block => typeof block?.german === 'string' && block.german.trim())
        .slice(-captionLines)
        .map(block => block.german.trim());
      if (!captionBox) {
        captionBox = document.createElement('div');
        captionBox.className = 'caption-box';
        content.replaceChildren(captionBox);
      }
      while (captionElements.length < captionLines) {
        const line = document.createElement('p');
        line.className = 'caption-text';
        line.style.margin = '0';
        captionElements.push(line);
        captionBox.appendChild(line);
      }
      document.getElementById('surface').style.paddingBottom = captionBottom + '%';
      captionBox.style.backgroundColor = 'rgba(0,0,0,' + captionBg + ')';
      captionBox.style.visibility = recent.length ? 'visible' : 'hidden';
      captionElements.forEach((element, index) => {
        const text = recent[index] ?? '';
        element.style.display = text ? '-webkit-box' : 'none';
        // One existing segment can use both lines. With multiple segments,
        // allocate one line to each so two translations are actually visible.
        element.style.webkitLineClamp = String(recent.length === 1 ? captionLines : 1);
        element.style.lineHeight = '1.3';
        element.style.fontSize = 'clamp(22px, ' + (2.6 * scale) + 'vw, 62px)';
        element.style.color = color(data.textColor,'#ffffff');
        if (element.textContent !== text) element.textContent = text;
      });
      return;
    }
    const mode = ['de','ar','both'].includes(selectedMode) ? selectedMode :
      (['de','ar','both'].includes(data.mode) ? data.mode : 'de');
    const lines = qs.has('lines') ? safeNum(selectedLines,1,12,5) : safeNum(data.visibleBlockCount,1,12,5);
    const blocks = Array.isArray(data.blocks) ? data.blocks.slice(-Math.round(lines)) : [];
    const align = ['left','right','center'].includes(data.textAlign) ? data.textAlign : 'center';
    const lh = safeNum(data.lineHeight,1,2.5,1.55);
    const deSize = safeNum(data.fontSizeDe,16,110,34);
    const arSize = safeNum(data.fontSizeAr,16,120,42);
    content.style.width = safeNum(data.maxWidthPercent,40,100,92) + '%';
    content.style.textAlign = align;
    const frag = document.createDocumentFragment();
    blocks.forEach((block) => {
      if (!block || (mode === 'de' && !block.german) || (mode === 'ar' && !block.arabic)) return;
      const entry = document.createElement('div'); entry.className = 'entry';
      const live = Boolean(block.isLiveActive);
      if (mode !== 'de' && block.arabic) entry.appendChild(paragraph(block.arabic,'ar',color(data.arabicColor,'#F7D774'),arSize,lh,align,live && mode === 'ar'));
      if (mode !== 'ar' && block.german) {
        const de = paragraph(block.german,'de',color(data.textColor,'#F5F2EB'),deSize,lh,align,live);
        if (mode === 'both') de.style.marginTop = '10px';
        entry.appendChild(de);
      }
      if (entry.childNodes.length) frag.appendChild(entry);
    });
    content.replaceChildren(frag);
  }
  // Robuste Verbindung: Bei Abbruch (Programm-Neustart, Standby) automatisch neu verbinden.
  let stream = null;
  let lastData = '';
  function connect() {
    if (stream) { try { stream.close(); } catch {} }
    stream = new EventSource('/events');
    stream.onmessage = e => {
      if (e.data === lastData) return;
      lastData = e.data;
      try { render(JSON.parse(e.data)); } catch { /* Ignore invalid packets. */ }
    };
    stream.onerror = () => {
      if (stream && stream.readyState === EventSource.CLOSED) setTimeout(connect, 2000);
    };
  }
  connect();
})();
<\/script>
</body></html>`])));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));
const NUMERIC_PARAMS = {
  // name: [min, max, Nachkommastellen]
  scale: [0.5, 3, 2],
  lines: [1, 12, 0],
  captionLines: [1, 3, 0],
  captionBg: [0, 0.9, 2],
  captionBottom: [1, 20, 0]
};
function buildObsUrl(base, options) {
  const url = new URL(base);
  url.search = "";
  url.hash = "";
  url.searchParams.set("layout", options.layout);
  if (options.mode) url.searchParams.set("mode", options.mode);
  for (const [name, [low, high, digits]] of Object.entries(NUMERIC_PARAMS)) {
    const value = options[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      url.searchParams.set(name, String(round(clamp(value, low, high), digits)));
    }
  }
  return url.toString();
}
function sanitizeObsUrl(requested, base) {
  try {
    const allowed = new URL(base);
    const parsed = new URL(requested || base);
    if (parsed.origin !== allowed.origin) return null;
    if (parsed.pathname !== "/obs" && parsed.pathname !== "/captions") return null;
    if (parsed.username || parsed.password) return null;
    const layoutRaw = parsed.searchParams.get("layout");
    const layout = layoutRaw === "full" || layoutRaw === "lower" || layoutRaw === "captions" ? layoutRaw : "captions";
    const modeRaw = parsed.searchParams.get("mode");
    const options = { layout };
    if (modeRaw === "de" || modeRaw === "ar" || modeRaw === "both") options.mode = modeRaw;
    for (const name of Object.keys(NUMERIC_PARAMS)) {
      if (!parsed.searchParams.has(name)) continue;
      const value = Number(parsed.searchParams.get(name));
      if (Number.isFinite(value)) options[name] = value;
    }
    return buildObsUrl(base, options);
  } catch {
    return null;
  }
}
const FINAL_TIMEOUT_MS = 1e4;
const PREVIEW_TIMEOUT_MS = 6e3;
const RAW_CACHE_LIMIT = 300;
let fetchImpl = null;
function setFetchImplementation(fn) {
  fetchImpl = fn;
}
class GoogleHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
  status;
}
class GoogleNetworkError extends Error {
}
async function googleFetch(url, body, timeoutMs) {
  const doFetch = fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  try {
    return await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new GoogleNetworkError("Google Cloud antwortet nicht rechtzeitig. Internetverbindung prüfen.");
    }
    throw new GoogleNetworkError("Google Cloud ist nicht erreichbar. Internetverbindung prüfen.");
  }
}
async function readGoogleError(response, fallback) {
  let message = `${fallback} (${response.status})`;
  try {
    const parsed = JSON.parse(await response.text());
    if (parsed?.error?.message) message = parsed.error.message;
  } catch {
  }
  return new GoogleHttpError(message, response.status);
}
function isTransient(err) {
  if (err instanceof GoogleNetworkError) return true;
  if (err instanceof GoogleHttpError) return err.status === 429 || err.status >= 500;
  return false;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function withRetry(retries, action) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (err) {
      if (attempt >= retries || !isTransient(err)) throw err;
      await sleep(250 * (attempt + 1));
    }
  }
}
function resolveRecognitionLanguages(profile, alternatives) {
  const languageCode = profile === "ar-EG-only" ? "ar-EG" : profile === "ar-SA-only" ? "ar-SA" : profile || "ar-SA";
  const defaults = profile === "ar-EG-only" || profile === "ar-SA-only" ? [] : languageCode === "ar-EG" ? ["ar-SA"] : ["ar-EG", "ar-AE", "ar-JO"];
  return { languageCode, alternativeLanguageCodes: [...new Set(alternatives ?? defaults)].filter((code) => code !== languageCode).slice(0, 3) };
}
const STT_VARIANTS = [
  { model: "latest_short", withAlternatives: true },
  { model: "default", withAlternatives: true },
  { model: "default", withAlternatives: false }
];
const workingVariant = /* @__PURE__ */ new Map();
async function recognizeSpeech(wavBuffer, config, timeoutMs) {
  const key = config.apiKey.trim();
  const sttUrl = `https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(key)}`;
  const language = resolveRecognitionLanguages(config.languageCode, config.alternativeLanguageCodes);
  const audioBase64 = wavBuffer.toString("base64");
  const cacheKey = `${key}|${language.languageCode}|${language.alternativeLanguageCodes.join(",")}`;
  let index = workingVariant.get(cacheKey) ?? 0;
  let lastError = null;
  while (index < STT_VARIANTS.length) {
    const variant = STT_VARIANTS[index];
    if (!variant.withAlternatives && language.alternativeLanguageCodes.length === 0) {
      index++;
      continue;
    }
    const sttConfig = {
      encoding: "LINEAR16",
      sampleRateHertz: 16e3,
      languageCode: language.languageCode,
      ...variant.withAlternatives ? { alternativeLanguageCodes: language.alternativeLanguageCodes } : {},
      enableAutomaticPunctuation: true,
      model: variant.model
    };
    const response = await googleFetch(sttUrl, { config: sttConfig, audio: { content: audioBase64 } }, timeoutMs);
    if (response.ok) {
      workingVariant.set(cacheKey, index);
      const sttJson = await response.json();
      const transcripts = [];
      let confidenceSum = 0;
      let confidenceCount = 0;
      for (const r of sttJson.results ?? []) {
        const alt = r.alternatives?.[0];
        if (alt?.transcript?.trim()) {
          transcripts.push(alt.transcript.trim());
          if (typeof alt.confidence === "number") {
            confidenceSum += alt.confidence;
            confidenceCount += 1;
          }
        }
      }
      return {
        arabic: transcripts.join(" ").trim(),
        confidence: confidenceCount > 0 ? Number((confidenceSum / confidenceCount).toFixed(2)) : void 0
      };
    }
    const error = await readGoogleError(response, "Google Speech API Fehler");
    if (response.status !== 400) throw error;
    lastError = error;
    index++;
  }
  throw lastError ?? new Error("Google Speech API: keine passende Konfiguration gefunden.");
}
async function transcribeAndTranslateWav(wavBuffer, config, options = {}) {
  const startTime = Date.now();
  if (!config.apiKey.trim()) {
    throw new Error("Kein Google Cloud API-Schlüssel hinterlegt.");
  }
  const isFinal = options.isFinal ?? true;
  const timeoutMs = isFinal ? FINAL_TIMEOUT_MS : PREVIEW_TIMEOUT_MS;
  const retries = isFinal ? 2 : 0;
  const { arabic, confidence } = await withRetry(retries, () => recognizeSpeech(wavBuffer, config, timeoutMs));
  if (!arabic) return null;
  const german = await withRetry(retries, () => translateArabicToGerman(arabic, config, false, timeoutMs));
  return { arabic, german, latencyMs: Date.now() - startTime, confidence };
}
let cacheCredential = "";
const rawTranslationCache = /* @__PURE__ */ new Map();
const inflightTranslations = /* @__PURE__ */ new Map();
async function translateArabicToGerman(arabicText, config, bypassCache = false, timeoutMs = FINAL_TIMEOUT_MS) {
  const key = config.apiKey.trim();
  if (!key) {
    throw new Error("Kein Google Cloud API-Schlüssel hinterlegt.");
  }
  if (cacheCredential !== key) {
    cacheCredential = key;
    rawTranslationCache.clear();
    inflightTranslations.clear();
  }
  let rawGerman = bypassCache ? void 0 : rawTranslationCache.get(arabicText);
  if (rawGerman !== void 0) {
    rawTranslationCache.delete(arabicText);
    rawTranslationCache.set(arabicText, rawGerman);
  } else {
    let pending = bypassCache ? void 0 : inflightTranslations.get(arabicText);
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
    if (!rawGerman) return "";
    if (cacheCredential === key) {
      if (rawTranslationCache.size >= RAW_CACHE_LIMIT) {
        const oldest = rawTranslationCache.keys().next().value;
        if (oldest !== void 0) rawTranslationCache.delete(oldest);
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
async function requestTranslation(arabicText, key, timeoutMs) {
  const translateUrl = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`;
  const trResponse = await googleFetch(
    translateUrl,
    { q: arabicText, source: "ar", target: "de", format: "text" },
    timeoutMs
  );
  if (!trResponse.ok) {
    throw await readGoogleError(trResponse, "Google Translation API Fehler");
  }
  const trJson = await trResponse.json();
  return trJson.data?.translations?.[0]?.translatedText?.trim() ?? "";
}
async function verifyGoogleApiKey(apiKey) {
  try {
    const translated = await translateArabicToGerman("السلام عليكم", {
      apiKey,
      languageCode: "ar-SA",
      enableIslamicGlossary: false,
      customGlossary: []
    }, true);
    if (!translated) {
      return { ok: false, message: "API antwortete ohne Übersetzungstext." };
    }
    return {
      ok: true,
      message: `Verbindung erfolgreich! Testübersetzung: „السلام عليكم“ → „${translated}“`
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Verbindung zu Google Cloud fehlgeschlagen."
    };
  }
}
async function warmUpGoogleConnections() {
  const doFetch = fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  await Promise.allSettled(
    ["https://speech.googleapis.com/", "https://translation.googleapis.com/"].map(
      (url) => doFetch(url, { method: "HEAD", signal: AbortSignal.timeout(4e3) })
    )
  );
}
const obsOverlay = new ObsOverlayServer();
let obsUrlError = null;
let controlWindow = null;
let projectorWindow = null;
let latestPayload = {
  mode: "both",
  blocks: [],
  arabic: "",
  german: "",
  fontSizeDe: 34,
  fontSizeAr: 42,
  lineHeight: 1.55,
  maxWidthPercent: 92,
  textAlign: "center",
  textColor: "#F5F2EB",
  arabicColor: "#F7D774",
  backgroundColor: "#030304"
};
const DEFAULT_SETTINGS = {
  apiKey: "",
  languageCode: "ar-SA",
  enableIslamicGlossary: true,
  customGlossary: DEFAULT_ISLAMIC_GLOSSARY,
  visibleBlockCount: 5,
  chunkIntervalMs: 1200
};
let settingsCache = null;
function getSettingsFilePath() {
  return node_path.join(electron.app.getPath("userData"), "khutbah-ai-settings.json");
}
function readSettingsFromDisk() {
  const file = getSettingsFilePath();
  if (!node_fs.existsSync(file)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(node_fs.readFileSync(file, "utf-8"));
    let apiKey = "";
    try {
      if (raw.encryptedApiKey && electron.safeStorage.isEncryptionAvailable()) {
        apiKey = electron.safeStorage.decryptString(Buffer.from(raw.encryptedApiKey, "base64"));
      } else if (raw.plainApiKey) {
        apiKey = raw.plainApiKey;
      }
    } catch (error) {
      console.error("API-Schlüssel konnte nicht entschlüsselt werden:", error);
    }
    return {
      apiKey,
      languageCode: raw.languageCode || "ar-SA",
      enableIslamicGlossary: raw.enableIslamicGlossary ?? true,
      customGlossary: Array.isArray(raw.customGlossary) ? raw.customGlossary : DEFAULT_ISLAMIC_GLOSSARY,
      visibleBlockCount: raw.visibleBlockCount ?? 5,
      chunkIntervalMs: raw.chunkIntervalMs ?? 1200
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function loadSettings() {
  if (!settingsCache) settingsCache = readSettingsFromDisk();
  return settingsCache;
}
function writeSettingsToDisk(settings) {
  const file = getSettingsFilePath();
  const data = {
    languageCode: settings.languageCode,
    enableIslamicGlossary: settings.enableIslamicGlossary,
    customGlossary: settings.customGlossary,
    visibleBlockCount: settings.visibleBlockCount,
    chunkIntervalMs: settings.chunkIntervalMs
  };
  if (settings.apiKey.trim()) {
    if (electron.safeStorage.isEncryptionAvailable()) {
      data.encryptedApiKey = electron.safeStorage.encryptString(settings.apiKey.trim()).toString("base64");
    } else {
      data.plainApiKey = settings.apiKey.trim();
    }
  }
  const tmp = `${file}.tmp`;
  node_fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  node_fs.renameSync(tmp, file);
}
function saveSettings(input, options = {}) {
  const current = loadSettings();
  const next = {
    apiKey: options.keepApiKey ? current.apiKey : String(input.apiKey ?? current.apiKey).trim(),
    languageCode: typeof input.languageCode === "string" && input.languageCode ? input.languageCode : current.languageCode,
    enableIslamicGlossary: typeof input.enableIslamicGlossary === "boolean" ? input.enableIslamicGlossary : current.enableIslamicGlossary,
    customGlossary: Array.isArray(input.customGlossary) ? input.customGlossary : current.customGlossary,
    visibleBlockCount: Number.isFinite(input.visibleBlockCount) ? Number(input.visibleBlockCount) : current.visibleBlockCount,
    chunkIntervalMs: Number.isFinite(input.chunkIntervalMs) ? Number(input.chunkIntervalMs) : current.chunkIntervalMs
  };
  settingsCache = next;
  writeSettingsToDisk(next);
}
function getDisplayList() {
  const primaryId = electron.screen.getPrimaryDisplay().id;
  return electron.screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.id === primaryId ? `Bildschirm ${i + 1} (Hauptmonitor)` : `Bildschirm ${i + 1}${d.label ? ` – ${d.label}` : ""}`,
    width: d.size.width,
    height: d.size.height,
    primary: d.id === primaryId
  }));
}
function broadcastDisplays() {
  const list = getDisplayList();
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send("displays:changed", list);
  }
}
function attachCrashRecovery(win, name) {
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`${name}-Fenster abgestürzt:`, details.reason);
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload();
    }, 500);
  });
  win.on("unresponsive", () => {
    console.error(`${name}-Fenster reagiert nicht.`);
  });
}
let powerBlockerId = null;
function setKeepAwake(active) {
  if (active && powerBlockerId === null) {
    powerBlockerId = electron.powerSaveBlocker.start("prevent-display-sleep");
  } else if (!active && powerBlockerId !== null) {
    electron.powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}
function createControlWindow() {
  controlWindow = new electron.BrowserWindow({
    width: 1460,
    height: 950,
    minWidth: 1050,
    minHeight: 720,
    title: "Khutbah AI – Moschee Al Badr",
    backgroundColor: "#060607",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Audio-Aufnahme & Übersetzung dürfen nicht gedrosselt werden, wenn das Fenster
      // hinter OBS liegt oder minimiert ist.
      backgroundThrottling: false
    }
  });
  attachCrashRecovery(controlWindow, "Steuerung");
  if (process.env.ELECTRON_RENDERER_URL) {
    controlWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    controlWindow.loadFile(node_path.join(__dirname, "../renderer/index.html"));
  }
  controlWindow.on("closed", () => {
    controlWindow = null;
    if (projectorWindow && !projectorWindow.isDestroyed()) {
      projectorWindow.close();
    }
  });
}
function openProjector(displayId) {
  const displays = electron.screen.getAllDisplays();
  const target = displays.find((d) => d.id === displayId) ?? displays.find((d) => d.id !== electron.screen.getPrimaryDisplay().id) ?? electron.screen.getPrimaryDisplay();
  if (projectorWindow && !projectorWindow.isDestroyed()) {
    projectorWindow.setFullScreen(false);
    projectorWindow.setBounds(target.bounds);
    projectorWindow.setFullScreen(true);
    projectorWindow.focus();
    projectorWindow.webContents.send("content:update", latestPayload);
    return;
  }
  projectorWindow = new electron.BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    fullscreen: true,
    frame: false,
    backgroundColor: latestPayload.backgroundColor,
    autoHideMenuBar: true,
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  attachCrashRecovery(projectorWindow, "Beamer");
  if (process.env.ELECTRON_RENDERER_URL) {
    projectorWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/projector`);
  } else {
    projectorWindow.loadFile(node_path.join(__dirname, "../renderer/index.html"), {
      hash: "/projector"
    });
  }
  projectorWindow.webContents.on("did-finish-load", () => {
    if (projectorWindow && !projectorWindow.isDestroyed()) {
      projectorWindow.webContents.send("content:update", latestPayload);
    }
  });
  projectorWindow.on("closed", () => {
    projectorWindow = null;
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send("projector:status", false);
    }
  });
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send("projector:status", true);
  }
}
const gotSingleInstanceLock = electron.app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      if (controlWindow.isMinimized()) controlWindow.restore();
      controlWindow.focus();
    }
  });
}
electron.app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  setFetchImplementation((url, init) => electron.net.fetch(url, init));
  loadSettings();
  void warmUpGoogleConnections();
  try {
    await obsOverlay.start();
  } catch (error) {
    obsUrlError = error instanceof Error ? error.message : String(error);
    console.error("OBS overlay could not start:", obsUrlError);
  }
  electron.session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  electron.session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === "media";
  });
  electron.ipcMain.handle("obs:getUrl", () => ({ url: obsOverlay.getUrl(), error: obsUrlError }));
  electron.ipcMain.handle("obs:copyUrl", (_event, requestedUrl) => {
    const base = obsOverlay.getUrl();
    if (!base) return false;
    const clean = sanitizeObsUrl(requestedUrl, base);
    if (!clean) return false;
    try {
      electron.clipboard.writeText(clean);
      return electron.clipboard.readText() === clean ? clean : false;
    } catch {
      return false;
    }
  });
  electron.ipcMain.handle("power:keepAwake", (_event, active) => {
    setKeepAwake(Boolean(active));
    return true;
  });
  electron.ipcMain.handle("displays:list", () => getDisplayList());
  electron.ipcMain.handle("content:getInitial", () => latestPayload);
  electron.ipcMain.handle("projector:isOpen", () => Boolean(projectorWindow && !projectorWindow.isDestroyed()));
  electron.ipcMain.handle("projector:open", (_event, displayId) => {
    openProjector(displayId);
    return true;
  });
  electron.ipcMain.handle("projector:close", () => {
    if (projectorWindow && !projectorWindow.isDestroyed()) {
      projectorWindow.close();
    }
    return true;
  });
  electron.ipcMain.on("content:update", (_event, payload) => {
    latestPayload = payload;
    obsOverlay.publish(payload);
    if (projectorWindow && !projectorWindow.isDestroyed()) {
      projectorWindow.webContents.send("content:update", payload);
    }
  });
  electron.ipcMain.handle("settings:load", () => loadSettings());
  electron.ipcMain.handle("settings:save", (_event, settings) => {
    saveSettings(settings);
    return true;
  });
  electron.ipcMain.handle("settings:update", (_event, settings) => {
    saveSettings(settings, { keepApiKey: true });
    return true;
  });
  electron.ipcMain.handle("cloud:verifyKey", async (_event, apiKey) => {
    return verifyGoogleApiKey(apiKey);
  });
  electron.ipcMain.handle(
    "cloud:processAudioSegment",
    async (_event, wavArrayBuffer, meta) => {
      const stored = loadSettings();
      const config = {
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
  electron.ipcMain.handle("cloud:translateText", async (_event, arabicText) => {
    const stored = loadSettings();
    return translateArabicToGerman(arabicText, stored);
  });
  electron.screen.on("display-added", broadcastDisplays);
  electron.screen.on("display-removed", broadcastDisplays);
  electron.screen.on("display-metrics-changed", broadcastDisplays);
  createControlWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createControlWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
electron.app.on("before-quit", () => {
  setKeepAwake(false);
  obsOverlay.stop();
});
process.on("uncaughtException", (error) => {
  console.error("Unerwarteter Fehler im Hauptprozess:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unbehandelte Promise-Ablehnung:", reason);
});
