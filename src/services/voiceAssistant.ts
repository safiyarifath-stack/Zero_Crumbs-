export type VoiceStage =
  | 'idle'
  | 'requesting_permission'
  | 'listening'
  | 'transcribing'
  | 'processing'
  | 'speaking'
  | 'error';

export type VoiceRecognitionMode = 'browser-speech' | 'server-transcribe';

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

export function isMobileOrTouchBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function unlockSpeechSynthesis(): void {
  if (!hasSpeechSynthesisSupport()) return;
  try {
    window.speechSynthesis.cancel();
    const primer = new SpeechSynthesisUtterance('');
    primer.volume = 0;
    window.speechSynthesis.speak(primer);
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
  const synth = window.speechSynthesis;
  try {
    synth.cancel();
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
    if (index >= chunks.length) {
      params.onEnd?.();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(chunks[index]);
    if (chosenVoice) utterance.voice = chosenVoice;
    utterance.lang = chosenVoice?.lang || navigator.language || 'en-US';
    utterance.rate = params.rate ?? 1;
    utterance.pitch = 1;

    utterance.onstart = () => {
      if (!started && !cancelled) {
        started = true;
        params.onStart?.();
      }
    };

    utterance.onend = () => {
      if (cancelled) return;
      index += 1;
      speakNext();
    };

    utterance.onerror = (ev) => {
      if (cancelled) return;
      if (ev.error === 'interrupted' || ev.error === 'canceled') {
        return;
      }
      cancelled = true;
      params.onError?.(
        ev.error === 'not-allowed'
          ? 'Browser audio autoplay blocked speech playback. Tap the speaker icon or Retry Voice to hear replies.'
          : 'Could not play speech audio in this browser; the written response is shown above.'
      );
      params.onEnd?.();
    };

    if (!started && index === 0) {
      started = true;
      params.onStart?.();
    }

    try {
      synth.speak(utterance);
    } catch {
      cancelled = true;
      params.onError?.('Speech playback failed in this browser.');
      params.onEnd?.();
    }
  };

  speakNext();

  return () => {
    cancelled = true;
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
        message: 'Microphone access was denied.',
        howToEnable: isMobile
          ? 'Tap the browser site settings/lock icon (or device Settings > Browser > Microphone), allow Microphone for this site, and tap Retry Voice. If inside an embedded preview, open the app in a new tab.'
          : 'Click the lock or site-info icon in your browser address bar, set Microphone to Allow, and click Retry Voice. If viewing inside an embedded frame, open Zero Crumbs in a new tab.',
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
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
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
