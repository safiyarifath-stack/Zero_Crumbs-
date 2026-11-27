import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  RotateCcw,
  Send,
  Sparkles,
  Volume2,
  VolumeX,
  X,
  XCircle,
} from 'lucide-react';
import { auth } from '../firebase';
import {
  executeConfirmedAiAction,
  recordAiActionOutcome,
} from '../services/firestoreService';
import {
  blobToBase64,
  formatMicrophonePermissionError,
  getSpeechRecognitionConstructor,
  getVoiceEnvironmentDiagnostics,
  getVoiceSupportInfo,
  hasSpeechSynthesisSupport,
  isMobileOrTouchBrowser,
  logVoiceDiagnostic,
  pickSupportedRecorderMimeType,
  queryMicrophonePermissionStatus,
  requestMicrophoneStream,
  speakTextAloud,
  startMicLevelMonitor,
  stopMediaStream,
  stopSpeechSynthesis,
  unlockSpeechSynthesis,
  type SpeechRecognitionInstanceLike,
  type VoiceRecognitionMode,
  type VoiceStage,
} from '../services/voiceAssistant';
import type {
  ChatMessage,
  DonationListing,
  FoodItem,
  PendingAiAction,
  UserProfile,
} from '../types';
import { getTodayIsoDate } from '../utils/foodUtils';

interface AiAssistantPanelProps {
  mode: 'page' | 'drawer';
  open?: boolean;
  onClose?: () => void;
  onOpenVoiceSettings?: () => void;
  userId: string;
  profile: UserProfile | null;
  foods: FoodItem[];
  donations: DonationListing[];
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  queuedPrompt?: string | null;
  onConsumeQueuedPrompt?: () => void;
}

const SUGGESTED_PROMPTS = [
  'Show me everything expiring within 3 days and what to use first',
  'I used half of my milk. Update the remaining quantity.',
  'What can I cook using ingredients expiring soon?',
  'Add 2 kg of apples to my fridge expiring in 7 days',
  'Which surplus food items can I donate safely right now?',
];

export function AiAssistantPanel({
  mode,
  open = true,
  onClose,
  onOpenVoiceSettings,
  userId,
  profile,
  foods,
  donations,
  messages,
  setMessages,
  queuedPrompt,
  onConsumeQueuedPrompt,
}: AiAssistantPanelProps) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [errorHint, setErrorHint] = useState('');
  const [missingApiKey, setMissingApiKey] = useState(false);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);

  // Voice assistant state
  const [voiceStage, setVoiceStage] = useState<VoiceStage>('idle');
  const [recognitionMode, setRecognitionMode] = useState<VoiceRecognitionMode>('browser-speech');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [voiceHint, setVoiceHint] = useState('');
  const [voiceMutedOutput, setVoiceMutedOutput] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [speechDetected, setSpeechDetected] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [voiceRetryAvailable, setVoiceRetryAvailable] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);

  const endRef = useRef<HTMLDivElement | null>(null);
  const activeControllerRef = useRef<AbortController | null>(null);

  // Latest React state refs to prevent stale closures in speech/audio callbacks
  const foodsRef = useRef(foods);
  const donationsRef = useRef(donations);
  const profileRef = useRef(profile);
  const messagesRef = useRef(messages);
  foodsRef.current = foods;
  donationsRef.current = donations;
  profileRef.current = profile;
  messagesRef.current = messages;

  const voiceActiveRef = useRef(false);
  const voiceSessionIdRef = useRef(0);
  const voiceStageRef = useRef<VoiceStage>('idle');
  const voiceMutedOutputRef = useRef(false);
  const recognitionModeRef = useRef<VoiceRecognitionMode>('browser-speech');
  const micStreamRef = useRef<MediaStream | null>(null);
  const stopMonitorRef = useRef<(() => void) | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstanceLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const recorderCancelDiscardRef = useRef(false);
  const recorderTimerRef = useRef<number | null>(null);
  const stopSpeechRef = useRef<(() => void) | null>(null);
  const resumeTimerRef = useRef<number | null>(null);
  const noSpeechCountRef = useRef(0);
  const finalSpeechTranscriptRef = useRef('');
  const latestTranscriptRef = useRef('');
  const retriedWithoutStreamRef = useRef(false);

  const updateVoiceStage = useCallback((stage: VoiceStage) => {
    voiceStageRef.current = stage;
    setVoiceStage(stage);
  }, []);

  const releaseMicrophoneHardware = useCallback(() => {
    if (stopMonitorRef.current) {
      stopMonitorRef.current();
      stopMonitorRef.current = null;
    }
    if (micStreamRef.current) {
      stopMediaStream(micStreamRef.current);
      micStreamRef.current = null;
    }
    setMicLevel(0);
  }, []);

  const stopRecorder = useCallback((discardAudio: boolean) => {
    if (recorderTimerRef.current !== null) {
      window.clearInterval(recorderTimerRef.current);
      recorderTimerRef.current = null;
    }
    setRecordingSeconds(0);
    const rec = recorderRef.current;
    if (rec) {
      recorderCancelDiscardRef.current = discardAudio;
      if (rec.state === 'recording' || rec.state === 'paused') {
        try {
          rec.stop();
        } catch {
          // Ignore
        }
      }
      if (discardAudio) {
        recorderRef.current = null;
        recorderChunksRef.current = [];
      }
    }
  }, []);

  const stopBrowserRecognition = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      recognitionRef.current = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      rec.onaudiostart = null;
      rec.onspeechstart = null;
      rec.onspeechend = null;
      try {
        rec.abort();
      } catch {
        // Ignore
      }
    }
  }, []);

  const stopCurrentPlayback = useCallback(() => {
    if (stopSpeechRef.current) {
      stopSpeechRef.current();
      stopSpeechRef.current = null;
    }
    stopSpeechSynthesis();
    setSpeakingMessageId(null);
  }, []);

  const stopVoiceConversation = useCallback(
    (options?: { preserveError?: boolean }) => {
      voiceActiveRef.current = false;
      voiceSessionIdRef.current += 1;
      if (resumeTimerRef.current !== null) {
        window.clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = null;
      }
      stopBrowserRecognition();
      stopRecorder(true);
      stopCurrentPlayback();
      releaseMicrophoneHardware();
      setInterimTranscript('');
      latestTranscriptRef.current = '';
      finalSpeechTranscriptRef.current = '';
      setSpeechDetected(false);
      if (!options?.preserveError) {
        setVoiceHint('');
        updateVoiceStage('idle');
      }
    },
    [
      releaseMicrophoneHardware,
      stopBrowserRecognition,
      stopCurrentPlayback,
      stopRecorder,
      updateVoiceStage,
    ]
  );

  useEffect(() => {
    let cancelled = false;
    async function checkAiStatus() {
      try {
        const currentUser = auth.currentUser;
        if (!currentUser) return;
        const token = await currentUser.getIdToken();
        const resp = await fetch('/api/ai/status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) {
          logVoiceDiagnostic('ai_status_http_error', { status: resp.status }, 'warn');
          return;
        }
        const data = (await resp.json()) as {
          configured?: boolean;
          environment?: string;
          protocol?: string;
        };
        logVoiceDiagnostic('ai_status_ok', {
          configured: data.configured,
          environment: data.environment,
          protocol: data.protocol,
        });
        if (!cancelled && data.configured === false) {
          setMissingApiKey(true);
        }
      } catch (err) {
        logVoiceDiagnostic(
          'ai_status_fetch_failed',
          { message: err instanceof Error ? err.message : String(err) },
          'warn'
        );
      }
    }
    void checkAiStatus();
    return () => {
      cancelled = true;
      activeControllerRef.current?.abort();
      stopVoiceConversation();
    };
  }, [stopVoiceConversation]);

  useEffect(() => {
    if (mode === 'drawer' && !open && voiceActiveRef.current) {
      stopVoiceConversation();
    }
  }, [mode, open, stopVoiceConversation]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, errorMsg, interimTranscript, voiceStage]);

  useEffect(() => {
    if (queuedPrompt && open) {
      void sendMessage(queuedPrompt);
      onConsumeQueuedPrompt?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedPrompt, open]);

  const buildChatRequestBody = useCallback((promptText: string) => {
    const historySnapshot = messagesRef.current
      .slice(-8)
      .map((m) => ({ role: m.role, text: m.text }));
    const currentFoods = foodsRef.current;
    const currentDonations = donationsRef.current;
    const currentProfile = profileRef.current;

    return {
      message: promptText,
      history: historySnapshot,
      inventory: currentFoods.map((f) => ({
        id: f.id,
        name: f.name,
        category: f.category,
        quantity: f.quantity,
        initialQuantity: f.initialQuantity,
        unit: f.unit,
        location: f.location,
        expiryDate: f.expiryDate,
        status: f.status,
        notes: f.notes,
      })),
      donations: currentDonations.map((d) => ({
        id: d.id,
        foodName: d.foodName,
        quantity: d.quantity,
        unit: d.unit,
        category: d.category,
        expiryDate: d.expiryDate,
        status: d.status,
        pickupLocation: d.pickupLocation,
        charityPartner: d.charityPartner,
      })),
      profile: {
        fullName: currentProfile?.fullName,
        reminderDaysBefore: currentProfile?.reminderDaysBefore ?? 3,
        defaultLocation: currentProfile?.defaultLocation ?? 'Fridge',
      },
      currentDate: getTodayIsoDate(),
    };
  }, []);

  const speakAssistantReply = useCallback(
    (msgId: string, replyText: string, resumeListeningAfter: boolean, sessionId?: number) => {
      const isSameActiveSession = () =>
        voiceActiveRef.current && (sessionId === undefined || voiceSessionIdRef.current === sessionId);

      if (voiceMutedOutputRef.current) {
        if (resumeListeningAfter && isSameActiveSession()) {
          resumeTimerRef.current = window.setTimeout(() => {
            if (isSameActiveSession()) {
              void beginListeningTurnRef.current?.();
            }
          }, 300);
        } else if (!voiceActiveRef.current) {
          updateVoiceStage('idle');
        }
        return;
      }

      if (!hasSpeechSynthesisSupport()) {
        if (resumeListeningAfter) {
          setVoiceHint(
            'Audio playback is unavailable in this browser; the response is shown in chat.'
          );
          if (isSameActiveSession()) {
            resumeTimerRef.current = window.setTimeout(() => {
              if (isSameActiveSession()) {
                void beginListeningTurnRef.current?.();
              }
            }, 350);
          }
        }
        return;
      }

      stopCurrentPlayback();
      setSpeakingMessageId(msgId);
      if (isSameActiveSession()) {
        updateVoiceStage('speaking');
        setVoiceHint('Speaking response aloud — tap Stop Speaking to interrupt');
      }

      stopSpeechRef.current = speakTextAloud({
        text: replyText,
        onStart: () => {
          setSpeakingMessageId(msgId);
          if (isSameActiveSession()) {
            updateVoiceStage('speaking');
          }
        },
        onError: (reason) => {
          setVoiceHint(reason);
        },
        onEnd: () => {
          stopSpeechRef.current = null;
          setSpeakingMessageId(null);
          if (resumeListeningAfter && isSameActiveSession()) {
            resumeTimerRef.current = window.setTimeout(() => {
              if (isSameActiveSession()) {
                void beginListeningTurnRef.current?.();
              }
            }, 350);
          } else if (isSameActiveSession()) {
            updateVoiceStage('idle');
          }
        },
      });
    },
    [stopCurrentPlayback, updateVoiceStage]
  );

  const sendMessage = useCallback(
    async (
      textToSend: string,
      options?: { skipUserBubble?: boolean; speakReply?: boolean }
    ) => {
      const trimmed = textToSend.trim();
      if (!trimmed || loadingRef.current) return;

      setErrorMsg('');
      setErrorHint('');
      setLastFailedPrompt(null);
      setVoiceRetryAvailable(false);

      if (!options?.skipUserBubble) {
        const userMsg: ChatMessage = {
          id: `msg_${Date.now()}`,
          role: 'user',
          text: trimmed,
          timestamp: new Date().toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
          }),
        };
        setMessages((prev) => [...prev, userMsg]);
        if (!options?.speakReply) {
          setInput('');
        }
      }

      const voiceSessionId = options?.speakReply ? voiceSessionIdRef.current : undefined;
      loadingRef.current = true;
      setLoading(true);
      if (options?.speakReply && voiceActiveRef.current) {
        updateVoiceStage('processing');
        setVoiceHint('Sending your spoken message to Zero Crumbs AI...');
      }

      const controller = new AbortController();
      activeControllerRef.current = controller;
      const timeoutId = window.setTimeout(() => {
        controller.abort();
      }, 45000);

      try {
        const currentUser = auth.currentUser;
        if (!currentUser) throw new Error('Please sign in to use Zero Crumbs AI.');

        const requestBody = JSON.stringify(buildChatRequestBody(trimmed));
        let token = await currentUser.getIdToken();
        let resp = await fetch('/api/ai/chat', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: requestBody,
        });

        if (resp.status === 401) {
          logVoiceDiagnostic('chat_token_refresh_retry', { status: 401 }, 'warn');
          token = await currentUser.getIdToken(true);
          resp = await fetch('/api/ai/chat', {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: requestBody,
          });
        }

        let data: {
          reply?: string;
          pendingActions?: PendingAiAction[];
          error?: string;
          missingApiKey?: boolean;
        } = {};
        try {
          data = (await resp.json()) as typeof data;
        } catch {
          data = {};
        }

        if (!resp.ok) {
          logVoiceDiagnostic(
            'chat_http_error',
            { status: resp.status, missingApiKey: data.missingApiKey, error: data.error },
            'error'
          );
          if (data.missingApiKey) {
            setMissingApiKey(true);
          }
          const friendly =
            data.error && !data.error.trim().startsWith('{')
              ? data.error
              : resp.status === 401
                ? 'Your sign-in session expired. Please refresh or sign in again.'
                : resp.status === 403
                  ? 'Please verify your email address via Email OTP before using Zero Crumbs AI.'
                  : resp.status === 503
                    ? 'Zero Crumbs AI is temporarily experiencing high demand. Please tap Retry in a moment.'
                    : resp.status === 429
                      ? 'Zero Crumbs AI reached a temporary rate limit. Please wait a moment and tap Retry.'
                      : 'Zero Crumbs AI could not complete your request right now. Please tap Retry.';
          throw new Error(friendly);
        }

        setMissingApiKey(false);

        const assistantMsgId = `msg_${Date.now()}_ai`;
        const replyText = data.reply || 'Here is what I found in your Zero Crumbs account.';
        const assistantMsg: ChatMessage = {
          id: assistantMsgId,
          role: 'assistant',
          text: replyText,
          timestamp: new Date().toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
          }),
          originalInstruction: trimmed,
          pendingActions: (data.pendingActions || []).map((a) => ({
            ...a,
            executionState: 'pending',
          })),
        };

        setMessages((prev) => [...prev, assistantMsg]);

        if (
          options?.speakReply &&
          voiceActiveRef.current &&
          voiceSessionId === voiceSessionIdRef.current
        ) {
          logVoiceDiagnostic('chat_reply_speaking', {
            replyLength: replyText.length,
            pendingActions: assistantMsg.pendingActions?.length || 0,
          });
          speakAssistantReply(assistantMsgId, replyText, true, voiceSessionId);
        }
      } catch (err) {
        logVoiceDiagnostic(
          'chat_exception',
          {
            speakReply: Boolean(options?.speakReply),
            message: err instanceof Error ? err.message : String(err),
          },
          'error'
        );
        setLastFailedPrompt(trimmed);
        let friendly = 'Zero Crumbs AI is temporarily unavailable. Please tap Retry to try again.';
        if (err instanceof DOMException && err.name === 'AbortError') {
          friendly =
            'Zero Crumbs AI timed out while waiting for a response. Please tap Retry to try again.';
        } else if (err instanceof TypeError && err.message.toLowerCase().includes('fetch')) {
          friendly =
            'Network connection was lost while reaching Zero Crumbs AI. Check your internet connection and tap Retry.';
        } else {
          const raw = err instanceof Error ? err.message : '';
          if (raw && !raw.trim().startsWith('{')) {
            friendly = raw;
          }
        }
        setErrorMsg(friendly);
        if (
          options?.speakReply &&
          voiceActiveRef.current &&
          voiceSessionId === voiceSessionIdRef.current
        ) {
          setVoiceRetryAvailable(true);
          stopVoiceConversation({ preserveError: true });
          updateVoiceStage('error');
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (activeControllerRef.current === controller) {
          activeControllerRef.current = null;
        }
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [
      buildChatRequestBody,
      setMessages,
      speakAssistantReply,
      stopVoiceConversation,
      updateVoiceStage,
    ]
  );

  const transcribeRecordedClip = useCallback(
    async (audioBlob: Blob) => {
      const sessionId = voiceSessionIdRef.current;
      if (!voiceActiveRef.current) return;
      if (audioBlob.size < 400) {
        setVoiceHint('Recording was too short. Please speak clearly and tap Send Speech.');
        if (voiceActiveRef.current && voiceSessionIdRef.current === sessionId) {
          void beginListeningTurnRef.current?.();
        }
        return;
      }

      updateVoiceStage('transcribing');
      setVoiceHint('Converting your recorded speech to text...');

      try {
        const currentUser = auth.currentUser;
        if (!currentUser) throw new Error('Please sign in to use Zero Crumbs AI Voice.');
        let token = await currentUser.getIdToken();
        const audioBase64 = await blobToBase64(audioBlob);

        if (!voiceActiveRef.current || voiceSessionIdRef.current !== sessionId) return;

        const payload = JSON.stringify({
          audioBase64,
          mimeType: audioBlob.type || 'audio/webm',
        });

        let resp = await fetch('/api/ai/transcribe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: payload,
        });

        if (resp.status === 401) {
          token = await currentUser.getIdToken(true);
          resp = await fetch('/api/ai/transcribe', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: payload,
          });
        }

        if (!voiceActiveRef.current || voiceSessionIdRef.current !== sessionId) return;

        let data: { transcript?: string; error?: string; missingApiKey?: boolean } = {};
        try {
          data = (await resp.json()) as typeof data;
        } catch {
          data = {};
        }

        if (!resp.ok) {
          logVoiceDiagnostic(
            'transcribe_http_error',
            { status: resp.status, missingApiKey: data.missingApiKey, error: data.error },
            'error'
          );
          if (data.missingApiKey) {
            setMissingApiKey(true);
          }
          throw new Error(data.error || 'Could not transcribe your voice clip. Please try again.');
        }

        const transcript = (data.transcript || '').trim();
        logVoiceDiagnostic('transcribe_success', { transcriptLength: transcript.length });
        if (!transcript) {
          setVoiceHint('No speech was detected in that clip. Listening again...');
          if (voiceActiveRef.current && voiceSessionIdRef.current === sessionId) {
            void beginListeningTurnRef.current?.();
          }
          return;
        }

        await sendMessage(transcript, { speakReply: true });
      } catch (err) {
        if (!voiceActiveRef.current || voiceSessionIdRef.current !== sessionId) return;
        logVoiceDiagnostic(
          'transcribe_exception',
          { message: err instanceof Error ? err.message : String(err) },
          'error'
        );
        const msg =
          err instanceof Error && err.message
            ? err.message
            : 'Speech transcription failed. Check your connection and tap Retry Voice.';
        setErrorMsg(msg);
        setErrorHint('');
        setVoiceRetryAvailable(true);
        stopVoiceConversation({ preserveError: true });
        updateVoiceStage('error');
      }
    },
    [sendMessage, stopVoiceConversation, updateVoiceStage]
  );

  const startRecordingFallbackTurn = useCallback(async () => {
    if (!voiceActiveRef.current) return;

    recognitionModeRef.current = 'server-transcribe';
    setRecognitionMode('server-transcribe');
    stopBrowserRecognition();
    stopRecorder(true);

    try {
      if (!micStreamRef.current || micStreamRef.current.getTracks().every((t) => t.readyState !== 'live')) {
        micStreamRef.current = await requestMicrophoneStream();
      }
      const stream = micStreamRef.current;

      if (!stopMonitorRef.current) {
        stopMonitorRef.current = startMicLevelMonitor(stream, (lvl) => {
          setMicLevel(lvl);
          setSpeechDetected(lvl > 0.08);
        });
      }

      const mimeType = pickSupportedRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorderChunksRef.current = [];
      recorderCancelDiscardRef.current = false;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recorderChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = () => {
        if (recorderTimerRef.current !== null) {
          window.clearInterval(recorderTimerRef.current);
          recorderTimerRef.current = null;
        }
        setRecordingSeconds(0);
        const shouldDiscard = recorderCancelDiscardRef.current;
        const chunks = recorderChunksRef.current;
        const recMime = recorder.mimeType || mimeType || 'audio/webm';
        recorderRef.current = null;
        recorderChunksRef.current = [];

        releaseMicrophoneHardware();
        if (shouldDiscard || !voiceActiveRef.current) {
          return;
        }
        const blob = new Blob(chunks, { type: recMime });
        void transcribeRecordedClip(blob);
      };

      recorder.start(250);
      updateVoiceStage('listening');
      setVoiceHint('Recording mode active — speak your question, then tap Send Speech.');
      setRecordingSeconds(0);

      let elapsed = 0;
      recorderTimerRef.current = window.setInterval(() => {
        elapsed += 1;
        setRecordingSeconds(elapsed);
        if (elapsed >= 45 && recorderRef.current?.state === 'recording') {
          recorderRef.current.stop();
        }
      }, 1000);
    } catch (err) {
      const info = formatMicrophonePermissionError(err);
      setErrorMsg(info.message);
      setErrorHint(info.howToEnable);
      setVoiceRetryAvailable(true);
      stopVoiceConversation({ preserveError: true });
      updateVoiceStage('error');
    }
  }, [
    releaseMicrophoneHardware,
    stopBrowserRecognition,
    stopRecorder,
    stopVoiceConversation,
    transcribeRecordedClip,
    updateVoiceStage,
  ]);

  const startBrowserSpeechTurn = useCallback(async () => {
    if (!voiceActiveRef.current) return;

    const RecognitionCtor = getSpeechRecognitionConstructor();
    if (!RecognitionCtor) {
      await startRecordingFallbackTurn();
      return;
    }

    recognitionModeRef.current = 'browser-speech';
    setRecognitionMode('browser-speech');
    stopBrowserRecognition();
    finalSpeechTranscriptRef.current = '';
    latestTranscriptRef.current = '';
    setInterimTranscript('');
    setSpeechDetected(false);

    const sessionId = voiceSessionIdRef.current;

    // On mobile browsers (or after an audio-capture/no-speech hardware conflict), keeping getUserMedia
    // open alongside SpeechRecognition can conflict; release stream after permission check in those cases.
    const isMobile = isMobileOrTouchBrowser();
    if (isMobile || retriedWithoutStreamRef.current) {
      releaseMicrophoneHardware();
    } else if (micStreamRef.current && !stopMonitorRef.current) {
      stopMonitorRef.current = startMicLevelMonitor(micStreamRef.current, (lvl) => {
        setMicLevel(lvl);
      });
    }

    const recognition = new RecognitionCtor();
    recognitionRef.current = recognition;
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let handledResult = false;
    let switchingToFallback = false;

    recognition.onaudiostart = () => {
      if (!voiceActiveRef.current || voiceSessionIdRef.current !== sessionId) return;
      logVoiceDiagnostic('speech_recognition_audio_start', {
        releasedStream: isMobile || retriedWithoutStreamRef.current,
      });
      updateVoiceStage('listening');
      if (noSpeechCountRef.current === 0) {
        setVoiceHint('Listening — speak naturally');
      }
    };

    recognition.onspeechstart = () => {
      if (!voiceActiveRef.current || voiceSessionIdRef.current !== sessionId) return;
      setSpeechDetected(true);
    };

    recognition.onspeechend = () => {
      setSpeechDetected(false);
    };

    recognition.onresult = (event) => {
      if (!voiceActiveRef.current || voiceSessionIdRef.current !== sessionId) return;
      noSpeechCountRef.current = 0;

      let finalChunk = '';
      let interimChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const phrase = res[0]?.transcript || '';
        if (res.isFinal) {
          finalChunk += phrase;
        } else {
          interimChunk += phrase;
        }
      }

      if (finalChunk) {
        finalSpeechTranscriptRef.current = `${finalSpeechTranscriptRef.current} ${finalChunk}`.trim();
      }
      const combinedPreview = `${finalSpeechTranscriptRef.current} ${interimChunk}`.trim();
      latestTranscriptRef.current = combinedPreview;
      setInterimTranscript(combinedPreview);

      if (finalChunk && finalSpeechTranscriptRef.current) {
        handledResult = true;
        const spokenText = finalSpeechTranscriptRef.current;
        finalSpeechTranscriptRef.current = '';
        latestTranscriptRef.current = '';
        setInterimTranscript('');
        logVoiceDiagnostic('speech_recognition_final', { textLength: spokenText.length });
        try {
          recognition.stop();
        } catch {
          // Ignore
        }
        void sendMessage(spokenText, { speakReply: true });
      }
    };

    recognition.onerror = (event) => {
      if (!voiceActiveRef.current || voiceSessionIdRef.current !== sessionId) return;
      const errCode = event.error;

      if (errCode === 'aborted') {
        return;
      }

      logVoiceDiagnostic('speech_recognition_error', {
        error: errCode,
        message: event.message,
        hasOpenStream: Boolean(micStreamRef.current),
      }, errCode === 'no-speech' ? 'info' : 'warn');

      if (errCode === 'not-allowed' || errCode === 'permission-denied') {
        const info = formatMicrophonePermissionError(
          new DOMException('Microphone permission denied', 'NotAllowedError')
        );
        setErrorMsg(info.message);
        setErrorHint(info.howToEnable);
        setVoiceRetryAvailable(true);
        stopVoiceConversation({ preserveError: true });
        updateVoiceStage('error');
        return;
      }

      if (
        (errCode === 'audio-capture' || errCode === 'no-speech') &&
        micStreamRef.current &&
        !retriedWithoutStreamRef.current
      ) {
        // Release dual getUserMedia stream so SpeechRecognition gets exclusive mic access
        switchingToFallback = true;
        retriedWithoutStreamRef.current = true;
        stopBrowserRecognition();
        releaseMicrophoneHardware();
        resumeTimerRef.current = window.setTimeout(() => {
          if (voiceActiveRef.current && voiceSessionIdRef.current === sessionId) {
            void beginListeningTurnRef.current?.();
          }
        }, 150);
        return;
      }

      if (
        errCode === 'network' ||
        errCode === 'service-not-allowed' ||
        errCode === 'language-not-supported' ||
        errCode === 'audio-capture'
      ) {
        // Seamlessly fall back to MediaRecorder + Gemini /api/ai/transcribe
        logVoiceDiagnostic('switching_to_server_transcribe_fallback', { reason: errCode }, 'warn');
        switchingToFallback = true;
        stopBrowserRecognition();
        if (typeof MediaRecorder !== 'undefined') {
          void startRecordingFallbackTurn();
        } else {
          setErrorMsg(
            errCode === 'network'
              ? 'Browser speech recognition could not reach the speech service. Check your connection and tap Retry Voice.'
              : 'Microphone speech capture is unavailable in this browser view. Try opening in Chrome, Edge, or Safari in a new tab.'
          );
          setVoiceRetryAvailable(true);
          stopVoiceConversation({ preserveError: true });
          updateVoiceStage('error');
        }
        return;
      }

      if (errCode === 'no-speech') {
        noSpeechCountRef.current += 1;
        if (noSpeechCountRef.current >= 4) {
          setErrorMsg('No speech was detected for a while.');
          setErrorHint('Tap Retry Voice whenever you are ready to speak to Zero Crumbs AI.');
          setVoiceRetryAvailable(true);
          stopVoiceConversation({ preserveError: true });
          updateVoiceStage('error');
        } else {
          setVoiceHint("Didn't catch anything yet — still listening, speak whenever ready.");
        }
        return;
      }

      setErrorMsg(`Voice recognition encountered an issue (${errCode || 'unknown'}). Please tap Retry Voice.`);
      setErrorHint('');
      setVoiceRetryAvailable(true);
      stopVoiceConversation({ preserveError: true });
      updateVoiceStage('error');
    };

    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }
      setSpeechDetected(false);

      if (!voiceActiveRef.current || voiceSessionIdRef.current !== sessionId || switchingToFallback || handledResult) {
        return;
      }

      // On Android Chrome, SpeechRecognition can emit interimResults and fire onend before isFinal=true
      const buffered = (finalSpeechTranscriptRef.current || latestTranscriptRef.current).trim();
      if (buffered) {
        finalSpeechTranscriptRef.current = '';
        latestTranscriptRef.current = '';
        setInterimTranscript('');
        logVoiceDiagnostic('speech_recognition_onend_flush', { textLength: buffered.length });
        void sendMessage(buffered, { speakReply: true });
        return;
      }

      // Automatically continue listening on no-speech timeouts while session is active
      if (voiceStageRef.current === 'listening') {
        resumeTimerRef.current = window.setTimeout(() => {
          if (
            voiceActiveRef.current &&
            voiceSessionIdRef.current === sessionId &&
            voiceStageRef.current === 'listening'
          ) {
            void beginListeningTurnRef.current?.();
          }
        }, 250);
      }
    };

    try {
      updateVoiceStage('listening');
      if (noSpeechCountRef.current === 0) {
        setVoiceHint('Listening — speak naturally');
      }
      recognition.start();
    } catch (err) {
      logVoiceDiagnostic(
        'speech_recognition_start_exception',
        { message: err instanceof Error ? err.message : String(err) },
        'warn'
      );
      switchingToFallback = true;
      stopBrowserRecognition();
      if (typeof MediaRecorder !== 'undefined') {
        await startRecordingFallbackTurn();
      } else {
        setErrorMsg('Could not start speech recognition. Please tap Retry Voice.');
        setVoiceRetryAvailable(true);
        stopVoiceConversation({ preserveError: true });
        updateVoiceStage('error');
      }
    }
  }, [
    releaseMicrophoneHardware,
    sendMessage,
    startRecordingFallbackTurn,
    stopBrowserRecognition,
    stopVoiceConversation,
    updateVoiceStage,
  ]);

  const beginListeningTurnRef = useRef<(() => Promise<void>) | null>(null);
  beginListeningTurnRef.current = async () => {
    if (!voiceActiveRef.current) return;
    if (recognitionModeRef.current === 'server-transcribe' || !getSpeechRecognitionConstructor()) {
      await startRecordingFallbackTurn();
    } else {
      await startBrowserSpeechTurn();
    }
  };

  async function startVoiceConversation() {
    if (voiceActiveRef.current) return;

    setErrorMsg('');
    setErrorHint('');
    setLastFailedPrompt(null);
    setVoiceRetryAvailable(false);
    setInterimTranscript('');
    latestTranscriptRef.current = '';
    noSpeechCountRef.current = 0;

    // Unlock browser TTS inside synchronous user gesture (critical for iOS Safari / Android Chrome)
    unlockSpeechSynthesis();

    const envDiag = getVoiceEnvironmentDiagnostics();
    const support = getVoiceSupportInfo();
    const permCheck = await queryMicrophonePermissionStatus();
    logVoiceDiagnostic('start_voice_requested', {
      ...envDiag,
      permissionStatus: permCheck.status,
      permissionSource: permCheck.source,
      preferredMode: support.preferredMode,
    });

    if (!support.supported) {
      setErrorMsg(support.unsupportedReason || 'Voice assistant is not supported in this browser.');
      setErrorHint(
        support.secureContext
          ? 'You can continue using text chat below, or switch to Chrome, Edge, or Safari.'
          : 'Open Zero Crumbs over HTTPS or localhost to allow microphone access.'
      );
      setVoiceRetryAvailable(false);
      updateVoiceStage('error');
      return;
    }

    if (!auth.currentUser) {
      setErrorMsg('Please sign in to start a voice conversation with Zero Crumbs AI.');
      setErrorHint('');
      updateVoiceStage('error');
      return;
    }

    voiceActiveRef.current = true;
    const sessionId = voiceSessionIdRef.current + 1;
    voiceSessionIdRef.current = sessionId;
    retriedWithoutStreamRef.current = false;
    updateVoiceStage('requesting_permission');
    setVoiceHint('Requesting microphone permission...');

    try {
      const stream = await requestMicrophoneStream();
      if (!voiceActiveRef.current || voiceSessionIdRef.current !== sessionId) {
        stopMediaStream(stream);
        return;
      }
      micStreamRef.current = stream;

      if (support.preferredMode === 'browser-speech') {
        await startBrowserSpeechTurn();
      } else {
        await startRecordingFallbackTurn();
      }
    } catch (err) {
      if (!voiceActiveRef.current || voiceSessionIdRef.current !== sessionId) {
        return;
      }
      logVoiceDiagnostic(
        'microphone_request_failed',
        {
          name: err instanceof DOMException ? err.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
        },
        'error'
      );
      const info = formatMicrophonePermissionError(err);
      setErrorMsg(info.message);
      setErrorHint(info.howToEnable);
      setVoiceRetryAvailable(true);
      stopVoiceConversation({ preserveError: true });
      updateVoiceStage('error');
    }
  }

  function handleSendRecordingNow() {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderCancelDiscardRef.current = false;
      recorderRef.current.stop();
    }
  }

  function toggleVoiceOutputMute() {
    const nextMuted = !voiceMutedOutput;
    voiceMutedOutputRef.current = nextMuted;
    setVoiceMutedOutput(nextMuted);
    if (nextMuted && voiceStageRef.current === 'speaking') {
      stopCurrentPlayback();
      if (voiceActiveRef.current) {
        void beginListeningTurnRef.current?.();
      }
    }
  }

  function handleStopSpeakingOnly() {
    stopCurrentPlayback();
    if (voiceActiveRef.current) {
      void beginListeningTurnRef.current?.();
    }
  }

  function updateActionInMessage(
    msgId: string,
    actionId: string,
    patch: Partial<PendingAiAction>
  ) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id !== msgId
          ? m
          : {
              ...m,
              pendingActions: m.pendingActions?.map((a) =>
                a.actionId === actionId ? { ...a, ...patch } : a
              ),
            }
      )
    );
  }

  async function handleConfirmAction(
    msg: ChatMessage,
    action: PendingAiAction
  ) {
    updateActionInMessage(msg.id, action.actionId, { executionState: 'executing' });
    try {
      const resultText = await executeConfirmedAiAction(
        userId,
        action,
        foods,
        donations,
        msg.originalInstruction || action.title
      );
      updateActionInMessage(msg.id, action.actionId, {
        executionState: 'confirmed',
        executionMessage: resultText,
      });
    } catch (err) {
      updateActionInMessage(msg.id, action.actionId, {
        executionState: 'failed',
        executionMessage:
          err instanceof Error ? err.message : 'Database action failed. No changes saved.',
      });
    }
  }

  async function handleCancelAction(msg: ChatMessage, action: PendingAiAction) {
    updateActionInMessage(msg.id, action.actionId, {
      executionState: 'cancelled',
      executionMessage: 'Action cancelled by user.',
    });
    try {
      await recordAiActionOutcome(
        userId,
        msg.originalInstruction || action.title,
        action,
        'cancelled',
        ''
      );
    } catch {
      // Ignore secondary logging error
    }
  }

  const isVoiceRunning =
    voiceStage === 'requesting_permission' ||
    voiceStage === 'listening' ||
    voiceStage === 'transcribing' ||
    voiceStage === 'processing' ||
    voiceStage === 'speaking';

  const barHeights = [0.4, 0.85, 1, 0.7, 0.45];

  const content = (
    <div
      className={`flex flex-col bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] ${
        mode === 'drawer'
          ? 'w-full sm:w-[440px] h-[580px] max-h-[82dvh] rounded-2xl shadow-2xl overflow-hidden'
          : 'h-[calc(100dvh-13rem)] min-h-[480px] rounded-2xl overflow-hidden'
      }`}
    >
      {/* Header */}
      <div className="px-4 sm:px-5 py-3.5 bg-[#1B3B2B] dark:bg-[#12291E] text-white flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4 text-[#DCEAD8]" />
          </div>
          <div className="min-w-0">
            <h2 className="font-display text-sm font-semibold truncate">Zero Crumbs AI</h2>
            <p className="text-[11px] text-[#CBE0D2] truncate">
              {isVoiceRunning
                ? 'Voice assistant active — speak or confirm actions'
                : 'Voice & text pantry, expiry, recipe & charity helper'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isVoiceRunning ? (
            <button
              type="button"
              onClick={() => stopVoiceConversation()}
              className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#C2410C] hover:bg-[#9A3412] text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              <span>Stop Voice</span>
            </button>
          ) : voiceStage === 'error' && voiceRetryAvailable ? (
            <button
              type="button"
              onClick={() => void startVoiceConversation()}
              className="min-h-[36px] px-3 py-1.5 rounded-xl bg-white/15 hover:bg-white/25 text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5 text-[#DCEAD8]" />
              <span>Retry Voice</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void startVoiceConversation()}
              className="min-h-[36px] px-3 py-1.5 rounded-xl bg-white/15 hover:bg-white/25 text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Mic className="w-3.5 h-3.5 text-[#DCEAD8]" />
              <span>Start Voice</span>
            </button>
          )}

          {mode === 'drawer' && onClose && (
            <button
              type="button"
              onClick={() => {
                if (isVoiceRunning) stopVoiceConversation();
                onClose();
              }}
              className="p-1.5 rounded-lg text-white/80 hover:bg-white/15 cursor-pointer"
              aria-label="Close AI Assistant"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Chat Body */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 bg-[#FAF9F6] dark:bg-[#0F1713]">
        {messages.length === 0 && !interimTranscript && (
          <div className="space-y-4">
            <div className="bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-4 text-sm text-[#34443A] dark:text-[#D5E2DA] leading-relaxed">
              Hello {profile?.fullName?.split(' ')[0] || 'there'}! I am{' '}
              <strong className="dark:text-white">Zero Crumbs AI</strong>. Type a question or tap{' '}
              <strong className="dark:text-white">Start Voice</strong> to speak with me about your
              pantry, expiring items, recipes, or surplus donations. Every inventory or donation
              change asks for your confirmation first.
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-[#5A6A60] dark:text-[#9CB0A4]">Try asking:</p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void sendMessage(prompt)}
                    className="text-left px-3 py-2 rounded-xl bg-white dark:bg-[#17211C] border border-[#DCE0D8] dark:border-[#2B3B32] text-xs text-[#1A2820] dark:text-[#E2ECE6] hover:bg-[#F2F4EF] dark:hover:bg-[#1F2D25] transition-colors cursor-pointer"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-[#1B4332] dark:bg-[#2D6A4F] text-white'
                  : 'bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] text-[#1A2820] dark:text-[#EBF2ED]'
              }`}
            >
              {msg.text}
            </div>

            {/* Action Confirmation Cards */}
            {msg.pendingActions && msg.pendingActions.length > 0 && (
              <div className="mt-2.5 w-full max-w-[92%] space-y-2.5">
                {msg.pendingActions.map((act) => {
                  const state = act.executionState || 'pending';
                  return (
                    <div
                      key={act.actionId}
                      className="bg-white dark:bg-[#17211C] border border-[#D4DDD3] dark:border-[#2C3F34] rounded-2xl p-4 shadow-xs"
                    >
                      <p className="text-xs font-medium text-[#52796F] dark:text-[#86B69C] mb-1">
                        Proposed Account Action
                      </p>
                      <p className="text-sm font-semibold text-[#1A2820] dark:text-[#EBF2ED] mb-1">
                        {act.title}
                      </p>
                      <p className="text-xs text-[#4F5E55] dark:text-[#A3B5AA] mb-3">
                        {act.description}
                      </p>

                      {state === 'pending' && (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleConfirmAction(msg, act)}
                            className="px-3.5 py-2 rounded-xl bg-[#1B4332] dark:bg-[#2D6A4F] text-white text-xs font-medium hover:bg-[#143325] dark:hover:bg-[#245740] transition-colors cursor-pointer"
                          >
                            Confirm & Execute
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleCancelAction(msg, act)}
                            className="px-3.5 py-2 rounded-xl border border-[#DCE0D8] dark:border-[#31483B] text-xs font-medium text-[#4F5E55] dark:text-[#C4D3CA] hover:bg-[#F4F5F2] dark:hover:bg-[#213028] transition-colors cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      )}

                      {state === 'executing' && (
                        <p className="text-xs text-[#355E4B] dark:text-[#86B69C] inline-flex items-center gap-1.5">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Saving to your Zero Crumbs database...
                        </p>
                      )}

                      {state === 'confirmed' && (
                        <p className="text-xs font-medium text-[#1B4332] dark:text-[#8CD4A9] inline-flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                          {act.executionMessage || 'Action completed and recorded.'}
                        </p>
                      )}

                      {state === 'failed' && (
                        <p className="text-xs font-medium text-[#B83B3B] dark:text-[#F29A9A] inline-flex items-center gap-1.5">
                          <XCircle className="w-4 h-4 shrink-0" />
                          {act.executionMessage || 'Action failed.'}
                        </p>
                      )}

                      {state === 'cancelled' && (
                        <p className="text-xs text-[#6B7A70] dark:text-[#9CB0A4]">
                          Cancelled — no changes made.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-1 flex items-center gap-2 px-1">
              <span className="text-[10px] text-[#6B7A70] dark:text-[#90A498]">{msg.timestamp}</span>
              {msg.role === 'assistant' && hasSpeechSynthesisSupport() && (
                <button
                  type="button"
                  onClick={() => {
                    if (speakingMessageId === msg.id) {
                      stopCurrentPlayback();
                    } else {
                      speakAssistantReply(msg.id, msg.text, false);
                    }
                  }}
                  className="text-[10px] text-[#52796F] dark:text-[#86B69C] hover:text-[#1B4332] dark:hover:text-[#CBE5D5] inline-flex items-center gap-1 cursor-pointer"
                  aria-label={speakingMessageId === msg.id ? 'Stop reading aloud' : 'Read reply aloud'}
                >
                  {speakingMessageId === msg.id ? (
                    <>
                      <VolumeX className="w-3 h-3" />
                      <span>Stop audio</span>
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-3 h-3" />
                      <span>Listen</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        ))}

        {/* Live speech recognition preview while user is speaking */}
        {interimTranscript && (
          <div className="flex flex-col items-end">
            <div className="max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap bg-[#1B4332]/85 dark:bg-[#2D6A4F]/90 text-white border border-[#1B4332] dark:border-[#3D8B67]">
              {interimTranscript}
            </div>
            <span className="mt-1 text-[10px] text-[#52796F] dark:text-[#86B69C] px-1">
              Listening...
            </span>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-xs text-[#5A6A60] dark:text-[#B5C6BC] bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-xl px-3.5 py-2.5 w-fit">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1B4332] dark:text-[#86B69C]" />
            Zero Crumbs AI is checking your inventory...
          </div>
        )}

        {missingApiKey && !errorMsg && (
          <div className="p-3.5 rounded-xl bg-[#FDF2EC] dark:bg-[#2B1B18] border border-[#EBC6BA] dark:border-[#5C3128] text-xs text-[#9E2F2F] dark:text-[#F5B0A6] space-y-1.5">
            <div className="flex items-start gap-2 font-medium">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>Gemini API key setup needed on the server</span>
            </div>
            <p className="leading-relaxed text-[#7E2B2B] dark:text-[#E89B90]">
              Create a free Gemini API key in Google AI Studio, then add it as{' '}
              <code className="px-1 py-0.5 rounded bg-white/80 dark:bg-black/30 font-mono text-[11px]">
                GEMINI_API_KEY
              </code>{' '}
              in your project&apos;s <strong>Settings &gt; Secrets</strong> panel.
            </p>
          </div>
        )}

        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-[#FDF2EC] dark:bg-[#2B1B18] border border-[#EBC6BA] dark:border-[#5C3128] text-xs text-[#9E2F2F] dark:text-[#F5B0A6] space-y-2.5">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium leading-relaxed">{errorMsg}</p>
                {errorHint && (
                  <p className="leading-relaxed text-[#7E2B2B] dark:text-[#E89B90]">{errorHint}</p>
                )}
              </div>
            </div>
            {missingApiKey && (
              <p className="leading-relaxed text-[#7E2B2B] dark:text-[#E89B90]">
                To configure it: generate a key in Google AI Studio, open{' '}
                <strong>Settings &gt; Secrets</strong>, save it as{' '}
                <code className="px-1 py-0.5 rounded bg-white/80 dark:bg-black/30 font-mono text-[11px]">
                  GEMINI_API_KEY
                </code>
                , and tap Retry below.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {lastFailedPrompt && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void sendMessage(lastFailedPrompt, { skipUserBubble: true })}
                  className="min-h-[38px] px-3 py-1.5 rounded-lg bg-white dark:bg-[#1E2A23] border border-[#EBC6BA] dark:border-[#6A392F] text-[#9E2F2F] dark:text-[#F5B0A6] font-medium hover:bg-[#FAF0EB] dark:hover:bg-[#34211D] transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Retry Message
                </button>
              )}
              {voiceRetryAvailable && (
                <button
                  type="button"
                  onClick={() => void startVoiceConversation()}
                  className="min-h-[38px] px-3 py-1.5 rounded-lg bg-white dark:bg-[#1E2A23] border border-[#EBC6BA] dark:border-[#6A392F] text-[#9E2F2F] dark:text-[#F5B0A6] font-medium hover:bg-[#FAF0EB] dark:hover:bg-[#34211D] transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Mic className="w-3.5 h-3.5" />
                  Retry Voice
                </button>
              )}
              {voiceRetryAvailable && onOpenVoiceSettings && (
                <button
                  type="button"
                  onClick={onOpenVoiceSettings}
                  className="min-h-[38px] px-3 py-1.5 rounded-lg bg-white dark:bg-[#1E2A23] border border-[#DCE0D8] dark:border-[#31483B] text-[#1A2820] dark:text-[#EBF2ED] font-medium hover:bg-[#F4F5F2] dark:hover:bg-[#26362E] transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                >
                  Open Microphone Settings
                </button>
              )}
            </div>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Voice Assistant Status Strip */}
      {isVoiceRunning && (
        <div className="px-4 py-2.5 bg-[#EEF3EC] dark:bg-[#1A2921] border-t border-[#D4DDD3] dark:border-[#2B4034] flex flex-wrap items-center justify-between gap-2.5 shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {voiceStage === 'requesting_permission' ||
            voiceStage === 'transcribing' ||
            voiceStage === 'processing' ? (
              <Loader2 className="w-4 h-4 animate-spin text-[#1B4332] dark:text-[#8CD4A9] shrink-0" />
            ) : voiceStage === 'speaking' ? (
              <Volume2 className="w-4 h-4 text-[#1B4332] dark:text-[#8CD4A9] shrink-0 animate-pulse" />
            ) : (
              <div className="flex items-end gap-0.5 h-4 shrink-0" aria-hidden="true">
                {barHeights.map((weight, idx) => {
                  const activeLevel =
                    micLevel > 0.02
                      ? Math.max(0.2, micLevel * weight)
                      : speechDetected
                        ? 0.65 * weight
                        : 0.25;
                  return (
                    <span
                      key={idx}
                      className="w-1 rounded-full bg-[#1B4332] dark:bg-[#8CD4A9] transition-all duration-75"
                      style={{ height: `${Math.round(activeLevel * 16)}px` }}
                    />
                  );
                })}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[#1B4332] dark:text-[#B7DFC5] truncate">
                {voiceStage === 'requesting_permission'
                  ? 'Requesting microphone access...'
                  : voiceStage === 'transcribing'
                    ? 'Converting speech to text...'
                    : voiceStage === 'processing'
                      ? 'Zero Crumbs AI is thinking...'
                      : voiceStage === 'speaking'
                        ? 'Zero Crumbs AI is speaking'
                        : recognitionMode === 'server-transcribe'
                          ? `Recording voice (${recordingSeconds}s)`
                          : speechDetected
                            ? 'Hearing your voice...'
                            : 'Listening — speak now'}
              </p>
              <p className="text-[11px] text-[#4F5E55] dark:text-[#9CB0A4] truncate">
                {voiceHint || 'Speak naturally to ask questions or manage inventory'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {voiceStage === 'listening' && recognitionMode === 'server-transcribe' && (
              <button
                type="button"
                onClick={handleSendRecordingNow}
                className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[#1B4332] dark:bg-[#2D6A4F] text-white text-xs font-medium hover:bg-[#143325] dark:hover:bg-[#245740] inline-flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Send Speech</span>
              </button>
            )}

            {voiceStage === 'speaking' && (
              <button
                type="button"
                onClick={handleStopSpeakingOnly}
                className="min-h-[36px] px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#1E2A23] border border-[#DCE0D8] dark:border-[#31483B] text-[#1A2820] dark:text-[#EBF2ED] text-xs font-medium hover:bg-[#F4F5F2] dark:hover:bg-[#26362E] inline-flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <VolumeX className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Stop Speaking</span>
              </button>
            )}

            <button
              type="button"
              onClick={toggleVoiceOutputMute}
              className={`min-h-[36px] px-2.5 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 border transition-colors cursor-pointer ${
                voiceMutedOutput
                  ? 'bg-[#FDF2EC] dark:bg-[#2B1B18] border-[#EBC6BA] dark:border-[#5C3128] text-[#9E2F2F] dark:text-[#F5B0A6]'
                  : 'bg-white dark:bg-[#1E2A23] border-[#DCE0D8] dark:border-[#31483B] text-[#1A2820] dark:text-[#EBF2ED] hover:bg-[#F4F5F2] dark:hover:bg-[#26362E]'
              }`}
              aria-label={voiceMutedOutput ? 'Unmute AI voice output' : 'Mute AI voice output'}
              title={voiceMutedOutput ? 'Unmute AI voice output' : 'Mute AI voice output'}
            >
              {voiceMutedOutput ? (
                <VolumeX className="w-3.5 h-3.5" />
              ) : (
                <Volume2 className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">{voiceMutedOutput ? 'Muted' : 'Audio On'}</span>
            </button>

            <button
              type="button"
              onClick={() => stopVoiceConversation()}
              className="min-h-[36px] px-2.5 py-1.5 rounded-lg bg-[#C2410C] text-white text-xs font-medium hover:bg-[#9A3412] inline-flex items-center gap-1.5 transition-colors cursor-pointer"
              aria-label="Stop voice assistant"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Stop Voice</span>
            </button>
          </div>
        </div>
      )}

      {/* Input Bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void sendMessage(input);
        }}
        className="p-3 bg-white dark:bg-[#17211C] border-t border-[#E5E7E2] dark:border-[#27362E] flex items-center gap-2 shrink-0"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Zero Crumbs AI or tap Start Voice..."
          className="flex-1 min-w-0 min-h-[44px] px-3.5 py-2.5 rounded-xl bg-[#FAF9F6] dark:bg-[#0F1713] border border-[#DCE0D8] dark:border-[#2B3B32] text-sm text-[#1A2820] dark:text-[#EBF2ED] focus:outline-none focus:border-[#1B4332] dark:focus:border-[#52B788]"
        />
        <button
          type="button"
          onClick={() => {
            if (isVoiceRunning) {
              stopVoiceConversation();
            } else {
              void startVoiceConversation();
            }
          }}
          className={`min-w-[44px] min-h-[44px] p-2.5 rounded-xl border transition-colors cursor-pointer flex items-center justify-center shrink-0 ${
            isVoiceRunning
              ? 'bg-[#FDF2EC] border-[#EBC6BA] text-[#C2410C] hover:bg-[#FAF0EB]'
              : 'bg-[#EEF3EC] dark:bg-[#22332A] border-[#D4DDD3] dark:border-[#31483B] text-[#1B4332] dark:text-[#B7DFC5] hover:bg-[#E1EBDF] dark:hover:bg-[#294034]'
          }`}
          aria-label={isVoiceRunning ? 'Stop voice assistant' : 'Start voice assistant'}
          title={isVoiceRunning ? 'Stop voice assistant' : 'Talk with Zero Crumbs AI'}
        >
          {isVoiceRunning ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </button>
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="min-w-[44px] min-h-[44px] p-2.5 rounded-xl bg-[#1B4332] dark:bg-[#2D6A4F] text-white hover:bg-[#143325] dark:hover:bg-[#245740] transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center shrink-0"
          aria-label="Send message"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );

  if (mode === 'drawer') {
    if (!open) return null;
    return (
      <div className="fixed inset-x-3 bottom-3 sm:inset-auto sm:bottom-5 sm:right-5 z-50 sm:w-auto">
        {content}
      </div>
    );
  }

  return content;
}
