import { describe, it, expect } from 'vitest';
import { buildObsUrl, sanitizeObsUrl } from '../src/shared/obsUrl';

const base = 'http://127.0.0.1:47811/obs';

describe('OBS-Link', () => {
  it('Kopie entspricht exakt dem angezeigten Livestream-Link', () => {
    const shown = buildObsUrl(base, { layout: 'captions', mode: 'de', scale: 1.4, captionLines: 2, captionBg: 0.65, captionBottom: 5 });
    expect(sanitizeObsUrl(shown, base)).toBe(shown);
    const q = new URL(shown).searchParams;
    expect(q.get('layout')).toBe('captions');
    expect(q.get('captionBg')).toBe('0.65');
  });

  it('Raum-Link behält layout=full (früher ging das verloren)', () => {
    const shown = buildObsUrl(base, { layout: 'full', scale: 1.1 });
    const copied = sanitizeObsUrl(shown, base)!;
    expect(new URL(copied).searchParams.get('layout')).toBe('full');
    expect(new URL(copied).searchParams.get('scale')).toBe('1.1');
  });

  it('lehnt fremde Hosts, Zugangsdaten und unbekannte Pfade ab', () => {
    expect(sanitizeObsUrl('http://evil.example/obs', base)).toBeNull();
    expect(sanitizeObsUrl('http://user:pw@127.0.0.1:47811/obs', base)).toBeNull();
    expect(sanitizeObsUrl('http://127.0.0.1:47811/events', base)).toBeNull();
  });

  it('begrenzt Zahlenwerte und verwirft unbekannte Parameter', () => {
    const out = new URL(sanitizeObsUrl(`${base}?layout=full&scale=99&evil=1`, base)!);
    expect(out.searchParams.get('scale')).toBe('3');
    expect(out.searchParams.has('evil')).toBe(false);
  });
});
