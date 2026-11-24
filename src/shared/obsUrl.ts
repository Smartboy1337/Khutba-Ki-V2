// Gemeinsame Logik für OBS-Links (Main-Prozess + Oberfläche).
// Ein Link wird immer aus der Server-Basis-URL + erlaubten Parametern gebaut,
// damit der kopierte Link exakt dem angezeigten Link entspricht.

export type ObsLayout = 'full' | 'lower' | 'captions';

export interface ObsLinkOptions {
  layout: ObsLayout;
  mode?: 'de' | 'ar' | 'both';
  lines?: number;
  scale?: number;
  captionLines?: number;
  captionBg?: number;
  captionBottom?: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/** Erlaubte Parameter mit Wertebereich. Alles andere wird verworfen. */
const NUMERIC_PARAMS: Record<string, [number, number, number]> = {
  // name: [min, max, Nachkommastellen]
  scale: [0.5, 3, 2],
  lines: [1, 12, 0],
  captionLines: [1, 3, 0],
  captionBg: [0, 0.9, 2],
  captionBottom: [1, 20, 0]
};

export function buildObsUrl(base: string, options: ObsLinkOptions): string {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set('layout', options.layout);
  if (options.mode) url.searchParams.set('mode', options.mode);
  for (const [name, [low, high, digits]] of Object.entries(NUMERIC_PARAMS)) {
    const value = options[name as keyof ObsLinkOptions];
    if (typeof value === 'number' && Number.isFinite(value)) {
      url.searchParams.set(name, String(round(clamp(value, low, high), digits)));
    }
  }
  return url.toString();
}

/**
 * Prüft einen von der Oberfläche angefragten Link: gleicher Host/Port, Pfad /obs,
 * nur bekannte Parameter. Gibt den bereinigten Link zurück oder null.
 */
export function sanitizeObsUrl(requested: string | undefined, base: string): string | null {
  try {
    const allowed = new URL(base);
    const parsed = new URL(requested || base);
    if (parsed.origin !== allowed.origin) return null;
    if (parsed.pathname !== '/obs' && parsed.pathname !== '/captions') return null;
    if (parsed.username || parsed.password) return null;

    const layoutRaw = parsed.searchParams.get('layout');
    const layout: ObsLayout =
      layoutRaw === 'full' || layoutRaw === 'lower' || layoutRaw === 'captions' ? layoutRaw : 'captions';
    const modeRaw = parsed.searchParams.get('mode');
    const options: ObsLinkOptions = { layout };
    if (modeRaw === 'de' || modeRaw === 'ar' || modeRaw === 'both') options.mode = modeRaw;
    for (const name of Object.keys(NUMERIC_PARAMS)) {
      if (!parsed.searchParams.has(name)) continue;
      const value = Number(parsed.searchParams.get(name));
      if (Number.isFinite(value)) (options as unknown as Record<string, number>)[name] = value;
    }
    return buildObsUrl(base, options);
  } catch {
    return null;
  }
}
