import { describe, it, expect } from 'vitest';
import { LivePipeline, type PipelinePacket, type PipelineResult } from '../src/renderer/src/pipeline/livePipeline';

const packet = (id: number, isFinalPacket: boolean): PipelinePacket => ({ wavBuffer: new ArrayBuffer(1), utteranceId: id, isFinalPacket });
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(maxParallelFinals = 3) {
  const texts: Array<[number, string, boolean]> = [];
  const empty: number[] = [];
  const failed: number[] = [];
  const pending = new Map<string, { resolve: (r: PipelineResult | null) => void; reject: (e: unknown) => void }>();
  const started: string[] = [];
  const pipeline = new LivePipeline(
    {
      process: (p) => new Promise((resolve, reject) => {
        const key = `${p.isFinalPacket ? 'f' : 'i'}${p.utteranceId}`;
        started.push(key);
        pending.set(key, { resolve, reject });
      }),
      onText: (id, ar, de, fin) => texts.push([id, de, fin]),
      onFinalEmpty: (id) => empty.push(id),
      onFinalFailed: (id) => failed.push(id)
    },
    { maxParallelFinals }
  );
  const ok = (de: string): PipelineResult => ({ arabic: 'ع', german: de, latencyMs: 1 });
  return { pipeline, texts, empty, failed, pending, started, ok };
}

describe('LivePipeline', () => {
  it('verarbeitet fertige Abschnitte parallel, zeigt sie aber in Reihenfolge', async () => {
    const t = setup();
    t.pipeline.push(packet(1, true));
    t.pipeline.push(packet(2, true));
    expect(t.started).toEqual(['f1', 'f2']); // beide laufen gleichzeitig
    t.pending.get('f2')!.resolve(t.ok('zwei'));
    await tick();
    expect(t.texts).toEqual([]); // 2 wartet auf 1
    t.pending.get('f1')!.resolve(t.ok('eins'));
    await tick();
    expect(t.texts.map((x) => x[1])).toEqual(['eins', 'zwei']);
  });

  it('begrenzt die Parallelität', async () => {
    const t = setup(2);
    [1, 2, 3].forEach((i) => t.pipeline.push(packet(i, true)));
    expect(t.started).toEqual(['f1', 'f2']);
    t.pending.get('f1')!.resolve(t.ok('a'));
    await tick();
    expect(t.started).toEqual(['f1', 'f2', 'f3']);
  });

  it('sendet nur die neueste Vorschau (latest wins)', async () => {
    const t = setup();
    t.pipeline.push(packet(1, false));
    t.pipeline.push(packet(1, false));
    t.pipeline.push(packet(1, false));
    expect(t.started).toEqual(['i1']);
    t.pending.get('i1')!.resolve(t.ok('v1'));
    await tick();
    expect(t.started).toEqual(['i1', 'i1']); // nur eine weitere, nicht zwei
  });

  it('verwirft eine Vorschau, wenn der fertige Abschnitt schon da ist', async () => {
    const t = setup();
    t.pipeline.push(packet(1, false));
    t.pipeline.push(packet(1, true));
    t.pending.get('f1')!.resolve(t.ok('final'));
    await tick();
    t.pending.get('i1')!.resolve(t.ok('alt'));
    await tick();
    expect(t.texts).toEqual([[1, 'final', true]]);
  });

  it('meldet leere und fehlgeschlagene Abschnitte, ohne die Reihenfolge zu blockieren', async () => {
    const t = setup();
    t.pipeline.push(packet(1, true));
    t.pipeline.push(packet(2, true));
    t.pending.get('f1')!.reject(new Error('x'));
    t.pending.get('f2')!.resolve(null);
    await tick();
    expect(t.failed).toEqual([1]);
    expect(t.empty).toEqual([2]);
  });

  it('reset() ignoriert noch laufende Antworten', async () => {
    const t = setup();
    t.pipeline.push(packet(1, true));
    t.pipeline.reset();
    t.pending.get('f1')!.resolve(t.ok('spät'));
    await tick();
    expect(t.texts).toEqual([]);
  });
});
