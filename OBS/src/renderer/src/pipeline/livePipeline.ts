// Live-Pipeline: verarbeitet Audio-Pakete parallel, zeigt Ergebnisse aber in der
// richtigen Reihenfolge an.
//
// Früher wurden fertige Abschnitte strikt nacheinander an Google geschickt
// (Erkennung -> Übersetzung -> nächster Abschnitt). Bei 1–2 s pro Anfrage staute sich
// das schnell auf, und die Vorschau war blockiert, solange ein Abschnitt lief.
//
// Jetzt:
//  * Fertige Abschnitte ("final") laufen bis zu `maxParallelFinals` gleichzeitig.
//    Ergebnisse werden trotzdem streng in Sprechreihenfolge übernommen.
//  * Vorschauen ("interim") laufen unabhängig davon; es wird immer nur die neueste
//    Vorschau gesendet (latest wins), veraltete Ergebnisse werden verworfen.
//  * Schlägt ein fertiger Abschnitt endgültig fehl, bleibt die letzte Vorschau stehen,
//    statt dass der Text verschwindet.

export interface PipelinePacket {
  wavBuffer: ArrayBuffer;
  utteranceId: number;
  isFinalPacket: boolean;
}

export interface PipelineResult {
  arabic: string;
  german: string;
  latencyMs: number;
}

export interface LivePipelineHandlers {
  process: (packet: PipelinePacket) => Promise<PipelineResult | null>;
  /** Text für einen Abschnitt anzeigen / aktualisieren. */
  onText: (utteranceId: number, arabic: string, german: string, isFinal: boolean) => void;
  /** Fertiger Abschnitt war leer (keine Sprache erkannt). */
  onFinalEmpty: (utteranceId: number) => void;
  /** Fertiger Abschnitt ist endgültig fehlgeschlagen. */
  onFinalFailed: (utteranceId: number, error: unknown) => void;
  onPreviewError?: (error: unknown) => void;
  onSuccess?: (latencyMs: number) => void;
  onStateChange?: (state: PipelineState) => void;
}

export interface PipelineState {
  busy: boolean;
  pendingFinals: number;
}

interface FinalJob {
  packet: PipelinePacket;
  queuedAt: number;
  started: boolean;
  done: boolean;
  result?: PipelineResult | null;
  error?: unknown;
}

export class LivePipeline {
  private finals: FinalJob[] = [];
  private runningFinals = 0;
  private latestPreview: { packet: PipelinePacket; queuedAt: number } | null = null;
  private previewInFlight = false;
  private newestFinalId = 0;
  private generation = 0;
  private lastState: PipelineState = { busy: false, pendingFinals: 0 };

  constructor(
    private readonly handlers: LivePipelineHandlers,
    private readonly options: { maxParallelFinals?: number; skipPreviewsAboveBacklog?: number } = {}
  ) {}

  private get maxParallel() {
    return Math.max(1, this.options.maxParallelFinals ?? 3);
  }

  push(packet: PipelinePacket) {
    const now = Date.now();
    if (packet.isFinalPacket) {
      this.newestFinalId = Math.max(this.newestFinalId, packet.utteranceId);
      if (this.latestPreview && this.latestPreview.packet.utteranceId <= packet.utteranceId) {
        this.latestPreview = null;
      }
      this.finals.push({ packet, queuedAt: now, started: false, done: false });
    } else {
      if (packet.utteranceId <= this.newestFinalId) return;
      this.latestPreview = { packet, queuedAt: now };
    }
    this.pump();
  }

  /** Verwirft alles (z. B. "Bildschirm leeren"). Laufende Anfragen werden ignoriert. */
  reset() {
    this.generation += 1;
    this.finals = [];
    this.runningFinals = 0;
    this.latestPreview = null;
    this.previewInFlight = false;
    this.emitState();
  }

  /** Nur ausstehende Vorschau verwerfen (z. B. bei Pause/Stop). Fertige Abschnitte laufen weiter. */
  dropPreview() {
    this.latestPreview = null;
    this.emitState();
  }

  get pendingFinals() {
    return this.finals.length;
  }

  private emitState() {
    const state: PipelineState = {
      busy: this.runningFinals > 0 || this.previewInFlight,
      pendingFinals: this.finals.length
    };
    if (state.busy !== this.lastState.busy || state.pendingFinals !== this.lastState.pendingFinals) {
      this.lastState = state;
      this.handlers.onStateChange?.(state);
    }
  }

  private pump() {
    // 1) Fertige Abschnitte starten (parallel, begrenzt).
    for (const job of this.finals) {
      if (this.runningFinals >= this.maxParallel) break;
      if (!job.started) this.startFinal(job);
    }

    // 2) Vorschau starten – nicht, wenn sich fertige Abschnitte stauen (Bandbreite sparen).
    const backlogLimit = this.options.skipPreviewsAboveBacklog ?? this.maxParallel;
    if (!this.previewInFlight && this.latestPreview && this.finals.length < backlogLimit) {
      const { packet, queuedAt } = this.latestPreview;
      this.latestPreview = null;
      if (packet.utteranceId > this.newestFinalId) this.startPreview(packet, queuedAt);
    }
    this.emitState();
  }

  private startFinal(job: FinalJob) {
    job.started = true;
    this.runningFinals += 1;
    const generation = this.generation;
    this.handlers
      .process(job.packet)
      .then(
        (result) => {
          job.result = result;
        },
        (error) => {
          job.error = error ?? new Error('Unbekannter Fehler');
        }
      )
      .finally(() => {
        if (generation !== this.generation) return;
        job.done = true;
        this.runningFinals -= 1;
        this.commitFinals();
        this.pump();
      });
  }

  /** Übernimmt fertige Ergebnisse streng in Reihenfolge. */
  private commitFinals() {
    while (this.finals.length > 0 && this.finals[0].done) {
      const job = this.finals.shift()!;
      const id = job.packet.utteranceId;
      if (job.error !== undefined) {
        this.handlers.onFinalFailed(id, job.error);
      } else if (job.result && job.result.arabic && job.result.german) {
        this.handlers.onText(id, job.result.arabic, job.result.german, true);
        this.handlers.onSuccess?.(Date.now() - job.queuedAt);
      } else {
        this.handlers.onFinalEmpty(id);
      }
    }
  }

  private startPreview(packet: PipelinePacket, queuedAt: number) {
    this.previewInFlight = true;
    const generation = this.generation;
    this.handlers
      .process(packet)
      .then(
        (result) => {
          if (generation !== this.generation) return;
          // Inzwischen ist der fertige Abschnitt unterwegs/da -> Vorschau ist veraltet.
          if (packet.utteranceId <= this.newestFinalId) return;
          if (result?.arabic && result.german) {
            this.handlers.onText(packet.utteranceId, result.arabic, result.german, false);
            this.handlers.onSuccess?.(Date.now() - queuedAt);
          }
        },
        (error) => {
          if (generation !== this.generation) return;
          this.handlers.onPreviewError?.(error);
        }
      )
      .finally(() => {
        if (generation !== this.generation) return;
        this.previewInFlight = false;
        this.pump();
      });
  }
}
