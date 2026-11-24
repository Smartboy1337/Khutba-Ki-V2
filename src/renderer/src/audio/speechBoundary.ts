/**
 * Grenzerkennung für längere arabische Predigtsätze.
 *
 * Ein Zeitlimit ist KEINE Wortgrenze. Nach Erreichen der weichen Grenze
 * wartet die Erkennung deshalb auf eine kurze Atem-/Sprechpause, maximal
 * jedoch bis zur harten Sicherheitsgrenze. Die kurzen Zwischenpakete werden
 * weiterhin unabhängig davon ausgegeben.
 */
export const SEGMENT_POLICY = Object.freeze({
  trailingSilenceMs: 750,
  minUtteranceMs: 1300,
  // Ab hier wird bei einer kurzen Sprechpause geteilt, NICHT sofort.
  softMaxUtteranceMs: 6300,
  shortPauseAfterSoftLimitMs: 330,
  // Schutz vor unbegrenzt langen WAVs / steigender Google-Latenz.
  hardMaxUtteranceMs: 11000,
  forcedOverlapMs: 180
});

export type SpeechBoundary = 'continue' | 'natural-pause' | 'max-duration';

/** Zeiten sind Millisekunden, inklusive der tatsächlichen Stille im Puffer. */
export function decideSpeechBoundary(durationMs: number, silenceMs: number): SpeechBoundary {
  if (!Number.isFinite(durationMs) || !Number.isFinite(silenceMs)) return 'continue';
  if (durationMs < SEGMENT_POLICY.minUtteranceMs) return 'continue';

  // Ein normal abgeschlossener Satz hat Vorrang vor einem harten Schnitt.
  if (silenceMs >= SEGMENT_POLICY.trailingSilenceMs) return 'natural-pause';

  // Bei längerer Rede nur in einer nachgewiesenen kurzen Pause schneiden.
  if (durationMs >= SEGMENT_POLICY.softMaxUtteranceMs &&
      silenceMs >= SEGMENT_POLICY.shortPauseAfterSoftLimitMs) return 'natural-pause';

  // Wenn der Sprecher gar nicht pausiert, muss die synchrone API begrenzt bleiben.
  if (durationMs >= SEGMENT_POLICY.hardMaxUtteranceMs) return 'max-duration';
  return 'continue';
}

/** Hält nur die letzten sample-genauen Millisekunden als Audioüberhang. */
export function retainAudioTail(
  chunks: Float32Array[], sampleRate: number, overlapMs: number
): { chunks: Float32Array[]; durationMs: number } {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(overlapMs) || overlapMs <= 0 || chunks.length === 0) {
    return { chunks: [], durationMs: 0 };
  }
  let remaining = Math.max(0, Math.round(sampleRate * overlapMs / 1000));
  const tail: Float32Array[] = [];
  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index--) {
    const chunk = chunks[index];
    if (chunk.length <= remaining) {
      tail.unshift(chunk.slice());
      remaining -= chunk.length;
    } else {
      tail.unshift(chunk.slice(chunk.length - remaining));
      remaining = 0;
    }
  }
  const retainedSamples = tail.reduce((count, chunk) => count + chunk.length, 0);
  return { chunks: tail, durationMs: retainedSamples / sampleRate * 1000 };
}
