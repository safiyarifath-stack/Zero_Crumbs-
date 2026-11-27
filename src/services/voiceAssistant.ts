export type VoiceStage =
  | 'idle'
  | 'requesting_permission'
  | 'listening'
  | 'transcribing'
  | 'processing'
  | 'speaking'
  | 'error';

export type VoiceRecognitionMode = 'browser-speech' | 'server-transcribe';

export type MicrophonePermissionStatus =
  | 'allowed'
  | 'blocked'
  | 'not_requested'
  | 'unsupported';

export interface VoiceSupportInfo {
  secureContext: boolean;
  microphoneApi: boolean;
  speechRecognition: boolean;
  mediaRecorder: boolean;
  speechSynthesis: boolean;
  supported: boolean;
  preferredMode: VoiceRecognitionMode | null;
  unsupportedReason?: string;
}

export interface VoiceEnvironmentDiagnostics {
  isSecureContext: boolean;
  origin: string;
  protocol: string;
  inIframe: boolean;
  mediaDevicesAvailable: boolean;
  permissionsApiAvailable: boolean;
  speechRecognitionAvailable: boolean;
  mediaRecorderAvailable: boolean;
  speechSynthesisAvailable: boolean;
  userAgent: string;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}

export interface SpeechRecognitionInstanceLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onaudiostart: ((ev: Event) => void) | null;
  onspeechstart: ((ev: Event) => void) | null;
  onspeechend: ((ev: Event) => void) | null;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((ev: Event) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export type SpeechRecognitionConstructorLike = new () => SpeechRecognitionInstanceLike;

export function logVoiceDiagnostic(
  stage: string,
  details?: Record<string, unknown>,
  level: 'info' | 'warn' | 'error' = 'info'
): void {
  if (typeof console === 'undefined') return;
  const payload = {
    ts: new Date().toISOString(),
    origin: typeof window !== 'undefined' ? window.location.origin : 'ssr',
    secureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
    ...details,
  };
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  fn(`[ZeroCrumbs Voice] ${stage}`, payload);
}

export function getVoiceEnvironmentDiagnostics(): VoiceEnvironmentDiagnostics {
  if (typeof window === 'undefined') {
    return {
      isSecureContext: false,
      origin: '',
      protocol: '',
      inIframe: false,
      mediaDevicesAvailable: false,
      permissionsApiAvailable: false,
      speechRecognitionAvailable: false,
      mediaRecorderAvailable: false,
      speechSynthesisAvailable: false,
      userAgent: '',
    };
  }

  let inIframe = false;
  try {
    inIframe = window.self !== window.top;
  } catch {
    inIframe = true;
  }

  return {
    isSecureContext: Boolean(window.isSecureContext),
    origin: window.location.origin,
    protocol: window.location.protocol,
    inIframe,
    mediaDevicesAvailable: Boolean(
      typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function'
    ),
    permissionsApiAvailable: Boolean(
      typeof navigator !== 'undefined' &&
        navigator.permissions &&
        typeof navigator.permissions.query === 'function'
    ),
    speechRecognitionAvailable: Boolean(getSpeechRecognitionConstructor()),
    mediaRecorderAvailable: typeof MediaRecorder !== 'undefined',
    speechSynthesisAvailable: hasSpeechSynthesisSupport(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };
}

export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructorLike | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructorLike;
    webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export function hasSpeechSynthesisSupport(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined'
  );
}

export function getVoiceSupportInfo(): VoiceSupportInfo {
  if (typeof window === 'undefined') {
    return {
      secureContext: false,
      microphoneApi: false,
      speechRecognition: false,
      mediaRecorder: false,
      speechSynthesis: false,
      supported: false,
      preferredMode: null,
      unsupportedReason: 'Voice assistant requires a browser environment.',
    };
  }

  const secureContext = window.isSecureContext;
  const microphoneApi = Boolean(
    typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
  );
  const speechRecognition = Boolean(getSpeechRecognitionConstructor());
  const mediaRecorder = typeof MediaRecorder !== 'undefined';
  const speechSynthesis = hasSpeechSynthesisSupport();

  if (!secureContext) {
    return {
      secureContext,
      microphoneApi,
      speechRecognition,
      mediaRecorder,
      speechSynthesis,
      supported: false,
      preferredMode: null,
      unsupportedReason:
        'Microphone voice input requires HTTPS or localhost. Open Zero Crumbs on HTTPS or localhost to enable voice.',
    };
  }

  if (!microphoneApi) {
    return {
      secureContext,
      microphoneApi,
      speechRecognition,
      mediaRecorder,
      speechSynthesis,
      supported: false,
      preferredMode: null,
      unsupportedReason:
        'Your browser does not support microphone capture (MediaDevices API). Please try the latest Chrome, Edge, Safari, or Firefox.',
    };
  }

  if (!speechRecognition && !mediaRecorder) {
    return {
      secureContext,
      microphoneApi,
      speechRecognition,
      mediaRecorder,
      speechSynthesis,
      supported: false,
      preferredMode: null,
      unsupportedReason:
        'This browser supports neither Web Speech Recognition nor audio recording. Please try Chrome, Edge, Safari, or Firefox.',
    };
  }

  return {
    secureContext,
    microphoneApi,
    speechRecognition,
    mediaRecorder,
    speechSynthesis,
    supported: true,
    preferredMode: speechRecognition ? 'browser-speech' : 'server-transcribe',
  };
}

export async function queryMicrophonePermissionStatus(options?: {
  sessionGranted?: boolean;
  sessionBlocked?: boolean;
}): Promise<{
  status: MicrophonePermissionStatus;
  source: 'permissions-api' | 'session-fallback' | 'unsupported';
}> {
  if (typeof window === 'undefined') {
    return { status: 'unsupported', source: 'unsupported' };
  }

  const hasMediaDevices = Boolean(
    typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
  );

  if (!window.isSecureContext || !hasMediaDevices) {
    return { status: 'unsupported', source: 'unsupported' };
  }

  if (
    typeof navigator !== 'undefined' &&
    navigator.permissions &&
    typeof navigator.permissions.query === 'function'
  ) {
    try {
      const perm = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });
      if (perm.state === 'granted') {
        return { status: 'allowed', source: 'permissions-api' };
      }
      if (perm.state === 'denied') {
        return { status: 'blocked', source: 'permissions-api' };
      }
      return { status: 'not_requested', source: 'permissions-api' };
    } catch {
      // Safari / browsers that do not support permissions.query({ name: 'microphone' })
    }
  }

  if (options?.sessionBlocked) {
    return { status: 'blocked', source: 'session-fallback' };
  }
  if (options?.sessionGranted) {
    return { status: 'allowed', source: 'session-fallback' };
  }
  return { status: 'not_requested', source: 'session-fallback' };
}

export function subscribeMicrophonePermissionChange(
  onChange: (status: MicrophonePermissionStatus) => void
): () => void {
  if (
    typeof window === 'undefined' ||
    !window.isSecureContext ||
    typeof navigator === 'undefined' ||
    !navigator.permissions ||
    typeof navigator.permissions.query !== 'function'
  ) {
    return () => {};
  }

  let active = true;
  let permStatus: PermissionStatus | null = null;

  const mapState = (state: PermissionState): MicrophonePermissionStatus => {
    if (state === 'granted') return 'allowed';
    if (state === 'denied') return 'blocked';
    return 'not_requested';
  };

  const handleChange = () => {
    if (!active || !permStatus) return;
    onChange(mapState(permStatus.state));
  };

  void navigator.permissions
    .query({ name: 'microphone' as PermissionName })
    .then((result) => {
      if (!active) return;
      permStatus = result;
      onChange(mapState(result.state));
      if (typeof result.addEventListener === 'function') {
        result.addEventListener('change', handleChange);
      } else {
        result.onchange = handleChange;
      }
    })
    .catch(() => {
      // Ignore browsers that reject 'microphone' permission query
    });

  return () => {
    active = false;
    if (permStatus) {
      if (typeof permStatus.removeEventListener === 'function') {
        permStatus.removeEventListener('change', handleChange);
      } else if (permStatus.onchange === handleChange) {
        permStatus.onchange = null;
      }
    }
  };
}

export function isMobileOrTouchBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function unlockSpeechSynthesis(): void {
  if (!hasSpeechSynthesisSupport()) return;
  try {
    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending) {
      synth.cancel();
    }
    if (synth.paused) {
      synth.resume();
    }
    const primer = new SpeechSynthesisUtterance('');
    primer.volume = 0;
    synth.speak(primer);
  } catch {
    // Ignore browser speech unlock errors
  }
}

export function stopSpeechSynthesis(): void {
  if (!hasSpeechSynthesisSupport()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Ignore
  }
}

export function cleanTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '. ')
    .replace(/https?:\/\/[^\s)]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSpeechChunks(text: string, maxLen = 175): string[] {
  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) return [];

  const sentences = cleaned.match(/[^.!?]+[.!?]*\s*/g) || [cleaned];
  const chunks: string[] = [];
  let current = '';

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    if ((current + ' ' + sentence).trim().length <= maxLen) {
      current = (current + ' ' + sentence).trim();
    } else {
      if (current) chunks.push(current);
      if (sentence.length <= maxLen) {
        current = sentence;
      } else {
        const words = sentence.split(/\s+/);
        let wordBuf = '';
        for (const w of words) {
          if ((wordBuf + ' ' + w).trim().length > maxLen) {
            if (wordBuf) chunks.push(wordBuf);
            wordBuf = w;
          } else {
            wordBuf = (wordBuf + ' ' + w).trim();
          }
        }
        current = wordBuf;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function speakTextAloud(params: {
  text: string;
  voiceURI?: string;
  rate?: number;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (reason: string) => void;
}): () => void {
  if (!hasSpeechSynthesisSupport()) {
    params.onError?.('Text-to-speech playback is not supported in this browser.');
    params.onEnd?.();
    return () => {};
  }

  const chunks = splitSpeechChunks(params.text);
  if (chunks.length === 0) {
    params.onEnd?.();
    return () => {};
  }

  let cancelled = false;
  let startDelayTimer: number | null = null;
  let chunkWatchdogTimer: number | null = null;
  const synth = window.speechSynthesis;

  const clearTimers = () => {
    if (startDelayTimer !== null) {
      window.clearTimeout(startDelayTimer);
      startDelayTimer = null;
    }
    if (chunkWatchdogTimer !== null) {
      window.clearTimeout(chunkWatchdogTimer);
      chunkWatchdogTimer = null;
    }
  };

  const wasBusy = synth.speaking || synth.pending;
  if (wasBusy) {
    try {
      synth.cancel();
    } catch {
      // Ignore
    }
  }
  try {
    if (synth.paused) {
      synth.resume();
    }
  } catch {
    // Ignore
  }

  const voices = synth.getVoices();
  const chosenVoice =
    (params.voiceURI && voices.find((v) => v.voiceURI === params.voiceURI)) ||
    voices.find((v) => v.localService && v.lang.toLowerCase().startsWith('en')) ||
    voices.find((v) => v.lang.toLowerCase().startsWith('en')) ||
    null;

  let index = 0;
  let started = false;

  const speakNext = () => {
    if (cancelled) return;
    clearTimers();
    if (index >= chunks.length) {
      params.onEnd?.();
      return;
    }

    const chunkText = chunks[index];
    const utterance = new SpeechSynthesisUtterance(chunkText);
    if (chosenVoice) utterance.voice = chosenVoice;
    utterance.lang = chosenVoice?.lang || navigator.language || 'en-US';
    utterance.rate = params.rate ?? 1;
    utterance.pitch = 1;

    let finishedChunk = false;
    const advanceChunk = () => {
      if (finishedChunk || cancelled) return;
      finishedChunk = true;
      if (chunkWatchdogTimer !== null) {
        window.clearTimeout(chunkWatchdogTimer);
        chunkWatchdogTimer = null;
      }
      index += 1;
      speakNext();
    };

    utterance.onstart = () => {
      if (!started && !cancelled) {
        started = true;
        params.onStart?.();
      }
    };

    utterance.onend = () => {
      advanceChunk();
    };

    utterance.onerror = (ev) => {
      if (cancelled) return;
      if (ev.error === 'interrupted' || ev.error === 'canceled') {
        return;
      }
      logVoiceDiagnostic('speech_synthesis_error', { error: ev.error }, 'warn');
      cancelled = true;
      clearTimers();
      params.onError?.(
        ev.error === 'not-allowed'
          ? 'Browser audio autoplay blocked speech playback. Tap Listen on the reply or Retry Voice to hear replies.'
          : 'Could not play speech audio in this browser; the written response is shown above.'
      );
      params.onEnd?.();
    };

    // Guard against Chromium occasionally dropping utterance.onend so voice never hangs in 'speaking'
    const maxChunkMs = Math.max(7000, Math.min(28000, chunkText.length * 145));
    chunkWatchdogTimer = window.setTimeout(() => {
      if (!finishedChunk && !cancelled) {
        logVoiceDiagnostic(
          'speech_synthesis_watchdog_advance',
          { chunkIndex: index, chunkLength: chunkText.length },
          'warn'
        );
        try {
          synth.cancel();
        } catch {
          // Ignore
        }
        advanceChunk();
      }
    }, maxChunkMs);

    if (!started && index === 0) {
      started = true;
      params.onStart?.();
    }

    try {
      if (synth.paused) {
        synth.resume();
      }
      synth.speak(utterance);
    } catch (err) {
      logVoiceDiagnostic(
        'speech_synthesis_exception',
        { message: err instanceof Error ? err.message : String(err) },
        'error'
      );
      cancelled = true;
      clearTimers();
      params.onError?.('Speech playback failed in this browser.');
      params.onEnd?.();
    }
  };

  // Chromium requires a brief delay after cancel() before speak() so the new utterance isn't dropped
  if (wasBusy) {
    startDelayTimer = window.setTimeout(speakNext, 60);
  } else {
    speakNext();
  }

  return () => {
    cancelled = true;
    clearTimers();
    try {
      synth.cancel();
    } catch {
      // Ignore
    }
  };
}

export interface FriendlyMicPermissionError {
  message: string;
  howToEnable: string;
  code: 'permission_denied' | 'no_microphone' | 'busy' | 'insecure_context' | 'unsupported' | 'unknown';
}

export function formatMicrophonePermissionError(err: unknown): FriendlyMicPermissionError {
  const isMobile = isMobileOrTouchBrowser();

  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      return {
        code: 'permission_denied',
        message: 'Microphone access was denied or blocked for this site.',
        howToEnable: isMobile
          ? 'Browser permissions must be changed in site settings if previously blocked: tap the lock/site-settings icon in your browser address bar -> Permissions -> Microphone -> Allow, then tap Retry Voice.'
          : 'Browser permissions must be changed in site settings if previously blocked: click the tune/lock icon to the left of the URL -> Site settings -> set Microphone to Allow, reload or tap Retry Voice. If inside an embedded frame, open Zero Crumbs in a new tab.',
      };
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      return {
        code: 'no_microphone',
        message: 'No microphone was found on this device.',
        howToEnable:
          'Connect or enable a working microphone in your system settings, then tap Retry Voice.',
      };
    }
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      return {
        code: 'busy',
        message: 'Your microphone is currently in use by another app or browser tab.',
        howToEnable:
          'Close other video/voice calls or recording tabs, then tap Retry Voice.',
      };
    }
    if (err.name === 'SecurityError') {
      return {
        code: 'insecure_context',
        message: 'Microphone access requires HTTPS or localhost.',
        howToEnable: 'Open Zero Crumbs over a secure HTTPS URL or localhost and try again.',
      };
    }
  }

  return {
    code: 'unknown',
    message:
      err instanceof Error && err.message
        ? err.message
        : 'Could not start microphone input.',
    howToEnable:
      'Check that your browser allows microphone access for this site and tap Retry Voice.',
  };
}

export async function requestMicrophoneStream(): Promise<MediaStream> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    throw new DOMException('Microphone capture API is unavailable in this browser.', 'NotSupportedError');
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError')
    ) {
      logVoiceDiagnostic('getUserMedia_constraint_fallback', { errorName: err.name }, 'warn');
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw err;
  }
}

export function stopMediaStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Ignore
    }
  }
}

export function pickSupportedRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      if (commaIdx === -1) {
        reject(new Error('Could not encode audio recording.'));
        return;
      }
      resolve(result.slice(commaIdx + 1));
    };
    reader.onerror = () => reject(new Error('Failed to read recorded audio.'));
    reader.readAsDataURL(blob);
  });
}

export function startMicLevelMonitor(
  stream: MediaStream,
  onLevel: (level: number) => void
): () => void {
  let audioCtx: AudioContext | null = null;
  let rafId = 0;
  let stopped = false;

  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return () => {};

    audioCtx = new AudioCtx();
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume().catch(() => {});
    }

    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let lastEmit = 0;

    const tick = (now: number) => {
      if (stopped) return;
      if (now - lastEmit >= 65) {
        lastEmit = now;
        analyser.getByteTimeDomainData(dataArray);
        let sumSq = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i] - 128) / 128;
          sumSq += normalized * normalized;
        }
        const rms = Math.sqrt(sumSq / dataArray.length);
        onLevel(Math.min(1, rms * 4.5));
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      onLevel(0);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // Ignore
      }
      if (audioCtx) {
        void audioCtx.close().catch(() => {});
      }
    };
  } catch {
    return () => {};
  }
}
