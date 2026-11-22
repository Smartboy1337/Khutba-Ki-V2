import { useCallback, useEffect, useRef, useState } from 'react';
import { analyzeTimeDomainSamples, encodeFloat32To16kWav } from './audioMetrics';

export interface AudioDeviceOption {
  deviceId: string;
  label: string;
}

export interface SpeechChunkPacket {
  wavBuffer: ArrayBuffer;
  utteranceId: number;
  isFinalPacket: boolean;
}

export type InputProfile = 'headset' | 'mosque-mic';

export interface UseAudioMonitorOptions {
  chunkIntervalMs?: number;
  onSpeechPacketReady?: (packet: SpeechChunkPacket) => void;
}

export function useAudioMonitor(options?: UseAudioMonitorOptions) {
  const [devices, setDevices] = useState<AudioDeviceOption[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('default');
  const [inputProfile, setInputProfile] = useState<InputProfile>('headset');
  const [autoGainEnabled, setAutoGainEnabled] = useState<boolean>(true);
  const [isMonitoring, setIsMonitoring] = useState<boolean>(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  const [dbFs, setDbFs] = useState<number>(-60);
  const [meterPercent, setMeterPercent] = useState<number>(0);
  const [isClipping, setIsClipping] = useState<boolean>(false);
  const [noSignalWarning, setNoSignalWarning] = useState<boolean>(false);
  const [isAboveThreshold, setIsAboveThreshold] = useState<boolean>(false);

  const [gainPercent, setGainPercent] = useState<number>(175);
  const [thresholdDb, setThresholdDb] = useState<number>(-46);

  const [testState, setTestState] = useState<'idle' | 'recording' | 'playing' | 'done'>('idle');
  const [testReport, setTestReport] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const silentFramesRef = useRef<number>(0);
  const gainPercentRef = useRef<number>(gainPercent);
  const autoGainEnabledRef = useRef<boolean>(autoGainEnabled);
  const thresholdDbRef = useRef<number>(thresholdDb);
  const chunkIntervalMsRef = useRef<number>(options?.chunkIntervalMs ?? 1100);
  const testTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const wantMonitoringRef = useRef<boolean>(false);
  const startMonitoringRef = useRef<(id?: string) => Promise<void>>(async () => {});

  const isCapturingSpeechRef = useRef<boolean>(false);
  const isPausedRef = useRef<boolean>(false);
  const utteranceIdRef = useRef<number>(1);
  const utteranceChunksRef = useRef<Float32Array[]>([]);
  const utteranceDurationMsRef = useRef<number>(0);
  const msSinceLastEmitRef = useRef<number>(0);
  const silenceMsRef = useRef<number>(0);
  const hasSpeechInUtteranceRef = useRef<boolean>(false);
  const onPacketCallbackRef = useRef(options?.onSpeechPacketReady);

  useEffect(() => {
    onPacketCallbackRef.current = options?.onSpeechPacketReady;
  }, [options?.onSpeechPacketReady]);

  useEffect(() => {
    chunkIntervalMsRef.current = Math.max(750, Math.min(3000, options?.chunkIntervalMs ?? 1100));
  }, [options?.chunkIntervalMs]);

  useEffect(() => {
    thresholdDbRef.current = thresholdDb;
  }, [thresholdDb]);

  useEffect(() => {
    autoGainEnabledRef.current = autoGainEnabled;
  }, [autoGainEnabled]);

  useEffect(() => {
    gainPercentRef.current = gainPercent;
    if (gainNodeRef.current && audioCtxRef.current) {
      const linearGain = Math.max(0.1, Math.min(4.0, gainPercent / 100));
      gainNodeRef.current.gain.cancelScheduledValues(audioCtxRef.current.currentTime);
      gainNodeRef.current.gain.setValueAtTime(linearGain, audioCtxRef.current.currentTime);
    }
  }, [gainPercent]);

  const applyInputProfile = useCallback((profile: InputProfile) => {
    setInputProfile(profile);
    if (profile === 'headset') {
      setGainPercent(175);
      setThresholdDb(-46);
      setAutoGainEnabled(true);
    } else {
      setGainPercent(115);
      setThresholdDb(-39);
      setAutoGainEnabled(true);
    }
  }, []);

  const resetUtteranceBuffer = useCallback((advanceId: boolean, keepOverlap = false) => {
    if (keepOverlap && utteranceChunksRef.current.length > 0) {
      // Letzte ~450ms behalten -> verhindert abgeschnittene Wörter bei schnellem Sprechen
      const tail = utteranceChunksRef.current.slice(-11);
      utteranceChunksRef.current = [...tail];
      utteranceDurationMsRef.current = tail.length * 42;
      hasSpeechInUtteranceRef.current = true;
    } else {
      utteranceChunksRef.current = [];
      utteranceDurationMsRef.current = 0;
      hasSpeechInUtteranceRef.current = false;
    }
    msSinceLastEmitRef.current = 0;
    silenceMsRef.current = 0;
    if (advanceId) {
      utteranceIdRef.current += 1;
    }
  }, []);

  const flushCurrentSpeechSegment = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (
      utteranceChunksRef.current.length > 0 &&
      hasSpeechInUtteranceRef.current &&
      utteranceDurationMsRef.current >= 400
    ) {
      const wav = encodeFloat32To16kWav(utteranceChunksRef.current, ctx.sampleRate, {
        autoNormalize: autoGainEnabledRef.current
      });
      onPacketCallbackRef.current?.({
        wavBuffer: wav,
        utteranceId: utteranceIdRef.current,
        isFinalPacket: true
      });
    }
    resetUtteranceBuffer(true, false);
  }, [resetUtteranceBuffer]);

  const setSpeechCaptureActive = useCallback(
    (active: boolean, paused: boolean) => {
      if (!active && isCapturingSpeechRef.current) {
        flushCurrentSpeechSegment();
      }
      if (paused && !isPausedRef.current) resetUtteranceBuffer(true, false);
      isCapturingSpeechRef.current = active;
      isPausedRef.current = paused;
      if (!active) {
        resetUtteranceBuffer(true, false);
      }
    },
    [flushCurrentSpeechSegment, resetUtteranceBuffer]
  );

  const selectedDeviceIdRef = useRef<string>(selectedDeviceId);
  useEffect(() => {
    selectedDeviceIdRef.current = selectedDeviceId;
  }, [selectedDeviceId]);

  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all
        .filter((d) => d.kind === 'audioinput')
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label: d.label || `Audio-Eingang ${idx + 1}`
        }));
      setDevices(inputs);
      if (inputs.length > 0 && selectedDeviceIdRef.current === 'default') {
        const defaultDev = inputs.find((d) => d.deviceId === 'default') ?? inputs[0];
        if (defaultDev.deviceId !== selectedDeviceIdRef.current) setSelectedDeviceId(defaultDev.deviceId);
      }
    } catch (err) {
      setPermissionError(
        err instanceof Error ? err.message : 'Audio-Geräte konnten nicht abgerufen werden.'
      );
    }
  }, []);

  const stopMonitoring = useCallback((userInitiated = true) => {
    if (userInitiated) wantMonitoringRef.current = false;
    flushCurrentSpeechSegment();
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (compressorRef.current) {
      compressorRef.current.disconnect();
      compressorRef.current = null;
    }
    if (gainNodeRef.current) {
      gainNodeRef.current.disconnect();
      gainNodeRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    silentFramesRef.current = 0;
    setIsMonitoring(false);
    setDbFs(-60);
    setMeterPercent(0);
    setIsClipping(false);
    setNoSignalWarning(false);
    setIsAboveThreshold(false);
  }, [flushCurrentSpeechSegment]);

  const startMonitoring = useCallback(
    async (overrideDeviceId?: string) => {
      stopMonitoring(false);
      wantMonitoringRef.current = true;
      setPermissionError(null);
      const targetId = overrideDeviceId ?? selectedDeviceId;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: targetId && targetId !== 'default' ? { exact: targetId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });

        streamRef.current = stream;
        await refreshDevices();

        // Mikrofon getrennt / Gerät verschwunden -> automatisch neu verbinden.
        stream.getAudioTracks().forEach((track) => {
          track.onended = () => {
            if (streamRef.current !== stream || !wantMonitoringRef.current) return;
            setPermissionError('Mikrofon getrennt – Verbindung wird automatisch neu aufgebaut…');
            const attempt = ++reconnectAttemptsRef.current;
            const delay = Math.min(5000, 1000 * attempt);
            reconnectTimerRef.current = window.setTimeout(() => {
              void startMonitoringRef.current();
            }, delay);
          };
        });

        const ctx = new AudioContext({ latencyHint: 'interactive' });
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
        // Standby/Gerätewechsel kann den AudioContext anhalten -> sofort fortsetzen.
        ctx.onstatechange = () => {
          if (ctx.state === 'suspended' && audioCtxRef.current === ctx) void ctx.resume().catch(() => {});
        };
        audioCtxRef.current = ctx;
        reconnectAttemptsRef.current = 0;

        const source = ctx.createMediaStreamSource(stream);

        const gainNode = ctx.createGain();
        gainNode.gain.value = Math.max(0.1, Math.min(4.0, gainPercentRef.current / 100));

        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -10;
        compressor.knee.value = 12;
        compressor.ratio.value = 6;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.15;

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;

        const processor = ctx.createScriptProcessor(2048, 1, 1);
        const silentSink = ctx.createGain();
        silentSink.gain.value = 0;

        processor.onaudioprocess = (event) => {
          if (!isCapturingSpeechRef.current || isPausedRef.current) return;

          const inputData = event.inputBuffer.getChannelData(0);
          const copy = new Float32Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            const s = inputData[i];
            copy[i] = Math.abs(s) > 0.96 ? Math.tanh(s) : s;
          }

          const chunkMetrics = analyzeTimeDomainSamples(copy, thresholdDbRef.current);
          const chunkDurationMs = (copy.length / ctx.sampleRate) * 1000;

          if (chunkMetrics.isAboveThreshold) {
            hasSpeechInUtteranceRef.current = true;
            silenceMsRef.current = 0;
          } else {
            silenceMsRef.current += chunkDurationMs;
          }

          if (!hasSpeechInUtteranceRef.current) {
            utteranceChunksRef.current.push(copy);
            if (utteranceChunksRef.current.length > 8) {
              utteranceChunksRef.current.shift();
            }
            return;
          }

          utteranceChunksRef.current.push(copy);
          utteranceDurationMsRef.current += chunkDurationMs;
          msSinceLastEmitRef.current += chunkDurationMs;

          const intervalMs = chunkIntervalMsRef.current;

          const hitMaxDuration = utteranceDurationMsRef.current >= 5500;
          const hitNaturalPause =
            utteranceDurationMsRef.current >= 1300 && silenceMsRef.current >= 500;

          if (hitMaxDuration || hitNaturalPause) {
            const wav = encodeFloat32To16kWav(utteranceChunksRef.current, ctx.sampleRate, {
              autoNormalize: autoGainEnabledRef.current
            });
            const currentId = utteranceIdRef.current;
            resetUtteranceBuffer(true, hitMaxDuration);
            onPacketCallbackRef.current?.({
              wavBuffer: wav,
              utteranceId: currentId,
              isFinalPacket: true
            });
            return;
          }

          if (msSinceLastEmitRef.current >= intervalMs) {
            msSinceLastEmitRef.current = 0;
            const wav = encodeFloat32To16kWav(utteranceChunksRef.current, ctx.sampleRate, {
              autoNormalize: autoGainEnabledRef.current
            });
            onPacketCallbackRef.current?.({
              wavBuffer: wav,
              utteranceId: utteranceIdRef.current,
              isFinalPacket: false
            });
          }
        };

        source.connect(gainNode);
        gainNode.connect(compressor);
        compressor.connect(analyser);
        compressor.connect(processor);
        processor.connect(silentSink);
        silentSink.connect(ctx.destination);

        gainNodeRef.current = gainNode;
        compressorRef.current = compressor;
        analyserRef.current = analyser;
        processorRef.current = processor;
        setIsMonitoring(true);

        const buffer = new Float32Array(analyser.fftSize);

        // Pegelanzeige nur ca. 12x pro Sekunde und nur bei Änderung aktualisieren.
        // Früher: 60x pro Sekunde -> die komplette Oberfläche wurde ständig neu gezeichnet
        // und blockierte so die Audio-Verarbeitung.
        let lastMeterUpdate = 0;
        const tick = (now: number) => {
          if (!analyserRef.current) return;
          if (now - lastMeterUpdate < 80) {
            rafRef.current = requestAnimationFrame(tick);
            return;
          }
          lastMeterUpdate = now;
          analyserRef.current.getFloatTimeDomainData(buffer);
          const metrics = analyzeTimeDomainSamples(buffer, thresholdDbRef.current);

          setDbFs(metrics.dbFs);
          setMeterPercent(metrics.meterPercent);
          setIsClipping(metrics.isClipping);
          setIsAboveThreshold(metrics.isAboveThreshold);

          if (metrics.dbFs <= -58) {
            silentFramesRef.current += 1;
            if (silentFramesRef.current > 40) {
              setNoSignalWarning(true);
            }
          } else {
            silentFramesRef.current = 0;
            setNoSignalWarning(false);
          }

          rafRef.current = requestAnimationFrame(tick);
        };

        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        setPermissionError(
          err instanceof Error
            ? `Mikrofon-/Mischpult-Zugriff fehlgeschlagen: ${err.message}`
            : 'Audio-Eingang konnte nicht geöffnet werden.'
        );
        setIsMonitoring(false);
      }
    },
    [refreshDevices, resetUtteranceBuffer, selectedDeviceId, stopMonitoring]
  );

  startMonitoringRef.current = startMonitoring;

  const selectDevice = useCallback(
    async (deviceId: string) => {
      setSelectedDeviceId(deviceId);
      if (isMonitoring) {
        await startMonitoring(deviceId);
      }
    },
    [isMonitoring, startMonitoring]
  );

  const runAudioTest = useCallback(async () => {
    if (testState === 'recording' || testState === 'playing') return;

    if (!isMonitoring) {
      await startMonitoring();
    }
    if (!audioCtxRef.current || !compressorRef.current) return;

    setTestReport(null);
    setTestState('recording');

    // Nimmt NACH dem GainNode & Kompressor auf -> man hört den echten Gain-Effekt!
    const dest = audioCtxRef.current.createMediaStreamDestination();
    compressorRef.current.connect(dest);

    const chunks: BlobPart[] = [];
    let maxDbSeen = -60;
    let clippedDuringTest = false;

    const sampleInterval = window.setInterval(() => {
      if (analyserRef.current) {
        const tmp = new Float32Array(analyserRef.current.fftSize);
        analyserRef.current.getFloatTimeDomainData(tmp);
        const m = analyzeTimeDomainSamples(tmp, thresholdDbRef.current);
        if (m.dbFs > maxDbSeen) maxDbSeen = m.dbFs;
        if (m.isClipping) clippedDuringTest = true;
      }
    }, 80);

    try {
      const recorder = new MediaRecorder(dest.stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        window.clearInterval(sampleInterval);
        try {
          compressorRef.current?.disconnect(dest);
        } catch {
          // ignore
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);

        setTestState('playing');

        let summary = `Maximalpegel (inkl. ${gainPercentRef.current}% Gain): ${maxDbSeen} dBFS. `;
        if (clippedDuringTest) {
          summary += 'Warnung: Übersteuerung erkannt – Gain-Regler etwas reduzieren!';
        } else if (maxDbSeen < -48) {
          summary += 'Signal noch sehr leise – Gain weiter erhöhen oder Mikrofon prüfen.';
        } else {
          summary += 'Signalqualität optimal für die Spracherkennung.';
        }
        setTestReport(summary);

        audio.onended = () => {
          URL.revokeObjectURL(url);
          setTestState('done');
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          setTestState('done');
        };
        audio.play().catch(() => {
          URL.revokeObjectURL(url);
          setTestState('done');
        });
      };

      recorder.start();
      testTimerRef.current = window.setTimeout(() => {
        if (recorder.state === 'recording') {
          recorder.stop();
        }
      }, 3500);
    } catch {
      window.clearInterval(sampleInterval);
      try {
        compressorRef.current?.disconnect(dest);
      } catch {
        // ignore
      }
      setTestState('idle');
      setTestReport('Audiotest konnte mit diesem Gerät nicht gestartet werden.');
    }
  }, [isMonitoring, startMonitoring, testState]);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
    };
  }, [refreshDevices]);

  // Nur beim Schließen des Fensters aufräumen – NICHT bei jeder Änderung einer Callback-Referenz
  // (früher konnte das das Mikrofon mitten in der Predigt abschalten).
  const stopMonitoringRef = useRef(stopMonitoring);
  stopMonitoringRef.current = stopMonitoring;
  useEffect(() => {
    return () => {
      if (testTimerRef.current) window.clearTimeout(testTimerRef.current);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      stopMonitoringRef.current();
    };
  }, []);

  return {
    devices,
    selectedDeviceId,
    inputProfile,
    autoGainEnabled,
    isMonitoring,
    permissionError,
    dbFs,
    meterPercent,
    isClipping,
    noSignalWarning,
    isAboveThreshold,
    gainPercent,
    thresholdDb,
    testState,
    testReport,
    setGainPercent,
    setThresholdDb,
    setAutoGainEnabled,
    applyInputProfile,
    selectDevice,
    startMonitoring,
    stopMonitoring,
    runAudioTest,
    refreshDevices,
    setSpeechCaptureActive,
    flushCurrentSpeechSegment,
    discardCurrentSpeechSegment: () => resetUtteranceBuffer(true, false)
  };
}
