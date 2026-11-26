import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';
import { auth } from '../firebase';
import {
  executeConfirmedAiAction,
  recordAiActionOutcome,
} from '../services/firestoreService';
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
  const [errorMsg, setErrorMsg] = useState('');
  const [missingApiKey, setMissingApiKey] = useState(false);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const activeControllerRef = useRef<AbortController | null>(null);

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
        if (!resp.ok) return;
        const data = (await resp.json()) as { configured?: boolean };
        if (!cancelled && data.configured === false) {
          setMissingApiKey(true);
        }
      } catch {
        // Ignore transient status check failure
      }
    }
    void checkAiStatus();
    return () => {
      cancelled = true;
      activeControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, errorMsg]);

  useEffect(() => {
    if (queuedPrompt && open) {
      void sendMessage(queuedPrompt);
      onConsumeQueuedPrompt?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedPrompt, open]);

  if (mode === 'drawer' && !open) return null;

  async function sendMessage(textToSend: string, options?: { skipUserBubble?: boolean }) {
    const trimmed = textToSend.trim();
    if (!trimmed || loading) return;

    setErrorMsg('');
    setLastFailedPrompt(null);

    const historySnapshot = messages.slice(-8).map((m) => ({ role: m.role, text: m.text }));

    if (!options?.skipUserBubble) {
      const userMsg: ChatMessage = {
        id: `msg_${Date.now()}`,
        role: 'user',
        text: trimmed,
        timestamp: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, userMsg]);
      setInput('');
    }
    setLoading(true);

    const controller = new AbortController();
    activeControllerRef.current = controller;
    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, 45000);

    try {
      const currentUser = auth.currentUser;
      if (!currentUser) throw new Error('Please sign in to use Zero Crumbs AI.');
      const token = await currentUser.getIdToken();

      const resp = await fetch('/api/ai/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: trimmed,
          history: historySnapshot,
          inventory: foods.map((f) => ({
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
          donations: donations.map((d) => ({
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
            fullName: profile?.fullName,
            reminderDaysBefore: profile?.reminderDaysBefore ?? 3,
            defaultLocation: profile?.defaultLocation ?? 'Fridge',
          },
          currentDate: getTodayIsoDate(),
        }),
      });

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
        if (data.missingApiKey) {
          setMissingApiKey(true);
        }
        const friendly =
          data.error && !data.error.trim().startsWith('{')
            ? data.error
            : resp.status === 503
              ? 'Zero Crumbs AI is temporarily experiencing high demand. Please tap Retry in a moment.'
              : resp.status === 429
                ? 'Zero Crumbs AI reached a temporary rate limit. Please wait a moment and tap Retry.'
                : 'Zero Crumbs AI could not complete your request right now. Please tap Retry.';
        throw new Error(friendly);
      }

      setMissingApiKey(false);

      const assistantMsg: ChatMessage = {
        id: `msg_${Date.now()}_ai`,
        role: 'assistant',
        text: data.reply || 'Here is what I found in your Zero Crumbs account.',
        timestamp: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        originalInstruction: trimmed,
        pendingActions: (data.pendingActions || []).map((a) => ({
          ...a,
          executionState: 'pending',
        })),
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setLastFailedPrompt(trimmed);
      if (err instanceof DOMException && err.name === 'AbortError') {
        setErrorMsg(
          'Zero Crumbs AI timed out while waiting for a response. Please tap Retry to try again.'
        );
      } else {
        const raw = err instanceof Error ? err.message : '';
        const friendly =
          raw && !raw.trim().startsWith('{')
            ? raw
            : 'Zero Crumbs AI is temporarily unavailable. Please tap Retry to try again.';
        setErrorMsg(friendly);
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
      setLoading(false);
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

  const content = (
    <div
      className={`flex flex-col bg-white border border-[#E5E7E2] ${
        mode === 'drawer'
          ? 'w-full sm:w-[440px] h-[580px] max-h-[82dvh] rounded-2xl shadow-2xl overflow-hidden'
          : 'h-[calc(100dvh-13rem)] min-h-[480px] rounded-2xl overflow-hidden'
      }`}
    >
      {/* Header */}
      <div className="px-5 py-4 bg-[#1B3B2B] text-white flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-[#DCEAD8]" />
          </div>
          <div>
            <h2 className="font-display text-sm font-semibold">Zero Crumbs AI</h2>
            <p className="text-[11px] text-[#CBE0D2]">
              Inventory actions, expiry alerts, recipes & charity helper
            </p>
          </div>
        </div>
        {mode === 'drawer' && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-white/80 hover:bg-white/15 cursor-pointer"
            aria-label="Close AI Assistant"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Chat Body */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 bg-[#FAF9F6]">
        {messages.length === 0 && (
          <div className="space-y-4">
            <div className="bg-white border border-[#E5E7E2] rounded-2xl p-4 text-sm text-[#34443A] leading-relaxed">
              Hello {profile?.fullName?.split(' ')[0] || 'there'}! I am{' '}
              <strong>Zero Crumbs AI</strong>. Ask me to check your pantry, update remaining
              quantities, suggest recipes for expiring food, or prepare safe charity donations.
              Every inventory or donation change asks for your confirmation first.
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-[#5A6A60]">Try asking:</p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void sendMessage(prompt)}
                    className="text-left px-3 py-2 rounded-xl bg-white border border-[#DCE0D8] text-xs text-[#1A2820] hover:bg-[#F2F4EF] transition-colors cursor-pointer"
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
                  ? 'bg-[#1B4332] text-white'
                  : 'bg-white border border-[#E5E7E2] text-[#1A2820]'
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
                      className="bg-white border border-[#D4DDD3] rounded-2xl p-4 shadow-xs"
                    >
                      <p className="text-xs font-medium text-[#52796F] mb-1">
                        Proposed Account Action
                      </p>
                      <p className="text-sm font-semibold text-[#1A2820] mb-1">{act.title}</p>
                      <p className="text-xs text-[#4F5E55] mb-3">{act.description}</p>

                      {state === 'pending' && (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleConfirmAction(msg, act)}
                            className="px-3.5 py-2 rounded-xl bg-[#1B4332] text-white text-xs font-medium hover:bg-[#143325] transition-colors cursor-pointer"
                          >
                            Confirm & Execute
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleCancelAction(msg, act)}
                            className="px-3.5 py-2 rounded-xl border border-[#DCE0D8] text-xs font-medium text-[#4F5E55] hover:bg-[#F4F5F2] transition-colors cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      )}

                      {state === 'executing' && (
                        <p className="text-xs text-[#355E4B] inline-flex items-center gap-1.5">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Saving to your Zero Crumbs database...
                        </p>
                      )}

                      {state === 'confirmed' && (
                        <p className="text-xs font-medium text-[#1B4332] inline-flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                          {act.executionMessage || 'Action completed and recorded.'}
                        </p>
                      )}

                      {state === 'failed' && (
                        <p className="text-xs font-medium text-[#B83B3B] inline-flex items-center gap-1.5">
                          <XCircle className="w-4 h-4 shrink-0" />
                          {act.executionMessage || 'Action failed.'}
                        </p>
                      )}

                      {state === 'cancelled' && (
                        <p className="text-xs text-[#6B7A70]">Cancelled — no changes made.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <span className="mt-1 text-[10px] text-[#6B7A70] px-1">{msg.timestamp}</span>
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2 text-xs text-[#5A6A60] bg-white border border-[#E5E7E2] rounded-xl px-3.5 py-2.5 w-fit">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1B4332]" />
            Zero Crumbs AI is checking your inventory...
          </div>
        )}

        {missingApiKey && !errorMsg && (
          <div className="p-3.5 rounded-xl bg-[#FDF2EC] border border-[#EBC6BA] text-xs text-[#9E2F2F] space-y-1.5">
            <div className="flex items-start gap-2 font-medium">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>Gemini API key setup needed on the server</span>
            </div>
            <p className="leading-relaxed text-[#7E2B2B]">
              Create a free Gemini API key in Google AI Studio, then add it as{' '}
              <code className="px-1 py-0.5 rounded bg-white/80 font-mono text-[11px]">
                GEMINI_API_KEY
              </code>{' '}
              in your project&apos;s <strong>Settings &gt; Secrets</strong> panel.
            </p>
          </div>
        )}

        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-[#FDF2EC] border border-[#EBC6BA] text-xs text-[#9E2F2F] space-y-2.5">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="leading-relaxed">{errorMsg}</span>
            </div>
            {missingApiKey && (
              <p className="leading-relaxed text-[#7E2B2B]">
                To configure it: generate a key in Google AI Studio, open{' '}
                <strong>Settings &gt; Secrets</strong>, save it as{' '}
                <code className="px-1 py-0.5 rounded bg-white/80 font-mono text-[11px]">
                  GEMINI_API_KEY
                </code>
                , and tap Retry below.
              </p>
            )}
            {lastFailedPrompt && (
              <button
                type="button"
                disabled={loading}
                onClick={() => void sendMessage(lastFailedPrompt, { skipUserBubble: true })}
                className="min-h-[38px] px-3 py-1.5 rounded-lg bg-white border border-[#EBC6BA] text-[#9E2F2F] font-medium hover:bg-[#FAF0EB] transition-colors inline-flex items-center gap-1.5 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Retry
              </button>
            )}
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Input Bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void sendMessage(input);
        }}
        className="p-3 bg-white border-t border-[#E5E7E2] flex items-center gap-2 shrink-0"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Zero Crumbs AI or give an instruction..."
          className="flex-1 min-w-0 min-h-[44px] px-3.5 py-2.5 rounded-xl bg-[#FAF9F6] border border-[#DCE0D8] text-sm text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="min-w-[44px] min-h-[44px] p-2.5 rounded-xl bg-[#1B4332] text-white hover:bg-[#143325] transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center shrink-0"
          aria-label="Send message"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );

  if (mode === 'drawer') {
    return (
      <div className="fixed inset-x-3 bottom-3 sm:inset-auto sm:bottom-5 sm:right-5 z-50 sm:w-auto">
        {content}
      </div>
    );
  }

  return content;
}
