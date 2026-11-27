import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  type LiveServerMessage,
  type Session,
} from '@google/genai';
import {
  defaultSendEmail,
  EmailOtpService,
  getEmailDeliveryStatus,
  type OtpPurpose,
} from './server/emailOtpService.ts';
import {
  buildZeroCrumbsSystemInstruction,
  createZeroCrumbsToolExecutor,
  ZERO_CRUMBS_TOOL_DECLARATIONS,
  type DonationSnapshotItem,
  type InventorySnapshotItem,
  type UserProfileSnapshot,
} from './server/zeroCrumbsAi.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'microphone=*');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const isAllowedOrigin =
    Boolean(origin) &&
    (/^https:\/\/[a-z0-9.-]+\.(run\.app|aistudio\.google\.com|web\.app|firebaseapp\.com)(:\d+)?$/i.test(
      origin
    ) ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin));

  if (isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Gmail-Access-Token'
    );
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});

app.use(express.json({ limit: '6mb' }));

const emailOtpService = new EmailOtpService();
const verifiedOtpUids = new Set<string>();

// Load Firebase client config for verifying Firebase ID tokens via Identity Toolkit REST API (no IAM required)
let firebaseApiKey = '';
let firebaseProjectId = '';
let firestoreDatabaseId = '(default)';
try {
  const cfgPath = path.resolve(__dirname, 'firebase-applet-config.json');
  if (fs.existsSync(cfgPath)) {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    firebaseApiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '';
    firebaseProjectId = typeof raw.projectId === 'string' ? raw.projectId : '';
    firestoreDatabaseId =
      typeof raw.firestoreDatabaseId === 'string' && raw.firestoreDatabaseId
        ? raw.firestoreDatabaseId
        : '(default)';
  }
} catch (err) {
  console.error('Could not load firebase-applet-config.json:', err);
}

interface VerifiedUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  idToken: string;
}

async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedUser | null> {
  const trimmed = idToken.trim();
  if (!trimmed || !firebaseApiKey) {
    return null;
  }

  try {
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: trimmed }),
      }
    );
    if (!resp.ok) {
      return null;
    }
    const data = (await resp.json()) as {
      users?: Array<{
        localId?: string;
        email?: string;
        emailVerified?: boolean;
      }>;
    };
    const u = data.users?.[0];
    if (!u?.localId || !u.email) {
      return null;
    }
    return {
      uid: u.localId,
      email: u.email,
      emailVerified: Boolean(u.emailVerified),
      idToken: trimmed,
    };
  } catch {
    return null;
  }
}

async function verifyFirebaseBearerToken(req: express.Request): Promise<VerifiedUser | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return verifyFirebaseIdToken(authHeader.slice('Bearer '.length));
}

async function isEmailOtpVerifiedInFirestore(uid: string, idToken: string): Promise<boolean> {
  if (!firebaseProjectId || !idToken) return false;
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseProjectId)}/databases/${encodeURIComponent(firestoreDatabaseId)}/documents/users/${encodeURIComponent(uid)}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return false;
    const doc = (await resp.json()) as {
      fields?: {
        emailOtpVerified?: { booleanValue?: boolean };
      };
    };
    const verified = doc?.fields?.emailOtpVerified?.booleanValue === true;
    if (verified) {
      verifiedOtpUids.add(uid);
    }
    return verified;
  } catch {
    return false;
  }
}

async function isUserOtpVerified(user: VerifiedUser): Promise<boolean> {
  return (
    user.emailVerified ||
    verifiedOtpUids.has(user.uid) ||
    (await isEmailOtpVerifiedInFirestore(user.uid, user.idToken))
  );
}

async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const user = await verifyFirebaseBearerToken(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required. Please sign in to continue.' });
    return;
  }
  const otpVerified = await isUserOtpVerified(user);

  if (!otpVerified) {
    res.status(403).json({
      error: 'Please verify your email address via Email OTP before performing this action.',
    });
    return;
  }
  (req as express.Request & { authUser?: VerifiedUser }).authUser = user;
  next();
}

function isGeminiKeyConfigured(): boolean {
  const apiKey = process.env.GEMINI_API_KEY;
  return Boolean(apiKey && apiKey.trim().length > 0 && apiKey !== 'MY_GEMINI_API_KEY');
}

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!isGeminiKeyConfigured() || !apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getGeminiLiveClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!isGeminiKeyConfigured() || !apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: 'v1beta',
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const GMP_SOLUTION_ID = 'gmp_mcp_codeassist_v1_aistudio';

function getGoogleMapsApiKey(): string {
  const candidates = [
    process.env.GOOGLE_MAPS_API_KEY,
    process.env.VITE_GOOGLE_MAPS_API_KEY,
  ];
  for (const val of candidates) {
    if (
      typeof val === 'string' &&
      val.trim().length > 0 &&
      val !== 'MY_GOOGLE_MAPS_API_KEY'
    ) {
      return val.trim();
    }
  }
  return '';
}

function isMapsQuotaError(status: number, rawBody: string): boolean {
  if (status === 429) return true;
  const upper = rawBody.toUpperCase();
  return (
    upper.includes('RESOURCE_EXHAUSTED') ||
    upper.includes('OVER_QUERY_LIMIT') ||
    upper.includes('OVERQUOTA') ||
    upper.includes('QUOTA')
  );
}

function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

interface CachedCharityResult {
  expiresAt: number;
  organisations: Array<{
    placeId: string;
    name: string;
    address: string;
    phone?: string;
    category: string;
    latitude: number;
    longitude: number;
    distanceMeters: number;
    googleMapsUri?: string;
    directionsUri: string;
    websiteUri?: string;
  }>;
}

const nearbyCharitiesCache = new Map<string, CachedCharityResult>();

// Health check
app.get('/api/health', (_req, res) => {
  const emailDelivery = getEmailDeliveryStatus();
  res.json({
    ok: true,
    service: 'zero-crumbs-api',
    geminiConfigured: isGeminiKeyConfigured(),
    mapsConfigured: Boolean(getGoogleMapsApiKey()),
    emailOtpConfigured: emailDelivery.configured,
    emailDeliveryProvider: emailDelivery.provider,
  });
});

// Public Email OTP delivery configuration status (no secrets exposed)
app.get('/api/auth/otp-status', (_req, res) => {
  const status = getEmailDeliveryStatus();
  res.json(status);
});

// Send 6-digit Email OTP (signup, existing unverified email, or authenticated OTP verification)
app.post('/api/auth/send-otp', async (req, res) => {
  const { email, fullName, purpose } = req.body as {
    email?: string;
    fullName?: string;
    purpose?: OtpPurpose;
  };
  const safePurpose: OtpPurpose =
    purpose === 'verify-existing'
      ? 'verify-existing'
      : purpose === 'otp-verification'
        ? 'otp-verification'
        : 'signup';

  let targetEmail = typeof email === 'string' ? email : '';

  if (safePurpose === 'otp-verification') {
    const authUser = await verifyFirebaseBearerToken(req);
    if (!authUser) {
      res.status(401).json({ error: 'Authentication required to send verification OTP.' });
      return;
    }
    if (!authUser.email) {
      res.status(400).json({ error: 'No email address is associated with this account.' });
      return;
    }
    targetEmail = authUser.email;
  }

  const rawGmailHeader = req.headers['x-gmail-access-token'];
  const gmailAccessToken =
    typeof rawGmailHeader === 'string' && rawGmailHeader.trim() ? rawGmailHeader.trim() : undefined;

  const clientIp =
    (typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : req.ip) || 'unknown';

  const result = await emailOtpService.sendOtp({
    email: targetEmail,
    fullName: typeof fullName === 'string' ? fullName : '',
    purpose: safePurpose,
    ip: clientIp,
    gmailAccessToken,
  });

  if (!result.ok) {
    res.status(result.status).json({
      error: result.error,
      code: result.code,
      retryAfterSeconds: result.retryAfterSeconds,
      missingEmailService: result.missingEmailService,
    });
    return;
  }

  res.json({
    ok: true,
    expiresInSeconds: result.expiresInSeconds,
    resendCooldownSeconds: result.resendCooldownSeconds,
    provider: result.provider,
  });
});

// Verify 6-digit Email OTP securely on the server
app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp, purpose } = req.body as {
    email?: string;
    otp?: string;
    purpose?: OtpPurpose;
  };
  const safePurpose: OtpPurpose =
    purpose === 'verify-existing'
      ? 'verify-existing'
      : purpose === 'otp-verification'
        ? 'otp-verification'
        : 'signup';

  let targetEmail = typeof email === 'string' ? email : '';
  if (safePurpose === 'otp-verification') {
    const authUser = await verifyFirebaseBearerToken(req);
    if (!authUser || !authUser.email) {
      res.status(401).json({ error: 'Authentication required to verify OTP.' });
      return;
    }
    targetEmail = authUser.email;
  }

  const result = emailOtpService.verifyOtp({
    email: targetEmail,
    otp: typeof otp === 'string' ? otp : '',
    purpose: safePurpose,
  });

  if (!result.ok) {
    res.status(result.status).json({
      error: result.error,
      code: result.code,
      attemptsRemaining: result.attemptsRemaining,
    });
    return;
  }

  res.json({
    ok: true,
    otpProofToken: result.otpProofToken,
  });
});

// Bind verified Email OTP proof to a newly created or existing Firebase UID
app.post('/api/auth/confirm-verified', async (req, res) => {
  const user = await verifyFirebaseBearerToken(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const { otpProofToken } = req.body as { otpProofToken?: string };
  if (!otpProofToken || !emailOtpService.verifyOtpProofToken(otpProofToken, user.email)) {
    res.status(403).json({ error: 'Invalid or expired email OTP verification proof.' });
    return;
  }
  verifiedOtpUids.add(user.uid);
  res.json({ ok: true, uid: user.uid });
});

// Check Gemini AI integration status for authenticated users
app.get('/api/ai/status', requireAuth, (req, res) => {
  const configured = isGeminiKeyConfigured();
  const forwardedProto =
    typeof req.headers['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'].split(',')[0].trim()
      : req.protocol;
  res.json({
    configured,
    model: 'gemini-4-hydrogen',
    transcribeModel: 'gemini-3.5-transcribe',
    liveModel: 'gemini-3.8-live',
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    protocol: forwardedProto,
  });
});

// Check real email reminder integration status
app.get('/api/reminders/status', requireAuth, (_req, res) => {
  const delivery = getEmailDeliveryStatus();
  res.json({
    emailConfigured: delivery.configured,
    provider: delivery.provider,
  });
});

// Send real email reminder via configured free Apps Script MailApp or Resend
app.post('/api/reminders/send-email', requireAuth, async (req, res) => {
  const authUser = (req as express.Request & { authUser?: VerifiedUser }).authUser;
  if (!authUser?.email) {
    res.status(400).json({
      error: 'Your account does not have an email address linked.',
    });
    return;
  }

  const delivery = getEmailDeliveryStatus();
  if (!delivery.configured) {
    res.status(503).json({
      error: 'Email reminder delivery is temporarily unavailable right now.',
    });
    return;
  }

  const { items, reminderDaysBefore } = req.body as {
    items?: Array<{ name: string; quantity: number; unit: string; location: string; expiryDate: string }>;
    reminderDaysBefore?: number;
  };

  if (!Array.isArray(items)) {
    res.status(400).json({ error: 'Invalid expiring items payload.' });
    return;
  }

  const days = typeof reminderDaysBefore === 'number' ? reminderDaysBefore : 3;
  const itemRows =
    items.length > 0
      ? items
          .slice(0, 25)
          .map(
            (i) =>
              `- ${i.name} (${i.quantity} ${i.unit}, ${i.location}) — Expires ${i.expiryDate}`
          )
          .join('\n')
      : 'No items are currently within your expiry reminder window.';

  try {
    const subject = `Zero Crumbs Reminder: ${items.length} food item${items.length === 1 ? '' : 's'} expiring within ${days} days`;
    const text = `Hello,\n\nHere is your Zero Crumbs expiry alert (window: ${days} days):\n\n${itemRows}\n\nOpen Zero Crumbs to plan meals or share safe surplus food before it goes to waste.\n\nSave Food. Reduce Waste. Share Goodness.`;
    const result = await defaultSendEmail({
      to: authUser.email,
      subject,
      text,
      html: `<pre style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; white-space: pre-wrap;">${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] || c))}</pre>`,
    });
    res.json({ ok: true, provider: result.provider });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to send email reminder.',
    });
  }
});

// Zero Crumbs AI Agent endpoint with Gemini function calling
app.post('/api/ai/chat', requireAuth, async (req, res) => {
  try {
    const {
      message,
      history = [],
      inventory = [],
      donations = [],
      profile = {},
      currentDate,
    } = req.body as {
      message?: string;
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      inventory?: InventorySnapshotItem[];
      donations?: DonationSnapshotItem[];
      profile?: UserProfileSnapshot;
      currentDate?: string;
    };

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'Please enter a message for Zero Crumbs AI.' });
      return;
    }

    const todayStr =
      typeof currentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(currentDate)
        ? currentDate
        : new Date().toISOString().slice(0, 10);

    const safeInventory = Array.isArray(inventory) ? inventory : [];
    const safeDonations = Array.isArray(donations) ? donations : [];

    const ai = getGeminiClient();

    const systemInstruction = buildZeroCrumbsSystemInstruction({
      todayStr,
      profile,
      voiceMode: false,
    });

    const toolExecutor = createZeroCrumbsToolExecutor({
      inventory: safeInventory,
      donations: safeDonations,
      profile,
      todayStr,
    });
    const executeLocalTool = toolExecutor.executeLocalTool;
    const toolDeclarations = ZERO_CRUMBS_TOOL_DECLARATIONS;

    const formattedHistory = (Array.isArray(history) ? history.slice(-10) : [])
      .filter((h) => typeof h?.text === 'string' && h.text.trim().length > 0)
      .map((h) => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(h.text).trim() }],
      }));

    while (formattedHistory.length > 0 && formattedHistory[0].role === 'model') {
      formattedHistory.shift();
    }

    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [
      ...formattedHistory,
      { role: 'user', parts: [{ text: message.trim() }] },
    ];

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    function parseErrorDetails(err: unknown): {
      code: number;
      statusText: string;
      rawMessage: string;
      isRetryable: boolean;
    } {
      const anyErr = err as { status?: number; code?: number; message?: string };
      let code = typeof anyErr?.status === 'number' ? anyErr.status : typeof anyErr?.code === 'number' ? anyErr.code : 0;
      let statusText = '';
      let rawMessage = err instanceof Error ? err.message : String(err || '');

      // Extract embedded JSON payload often thrown by @google/genai SDK
      const jsonMatch = rawMessage.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as {
            error?: { code?: number; message?: string; status?: string };
          };
          if (parsed?.error) {
            if (typeof parsed.error.code === 'number') code = parsed.error.code;
            if (parsed.error.status) statusText = parsed.error.status;
            if (parsed.error.message) rawMessage = parsed.error.message;
          }
        } catch {
          // Keep original rawMessage
        }
      }

      const lower = `${statusText} ${rawMessage}`.toLowerCase();
      if (!code) {
        if (lower.includes('503') || lower.includes('unavailable') || lower.includes('high demand') || lower.includes('overloaded')) {
          code = 503;
        } else if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('rate limit')) {
          code = 429;
        } else if (lower.includes('403') || lower.includes('permission_denied') || lower.includes('api_key_invalid')) {
          code = 403;
        }
      }

      const isRetryable =
        code === 503 ||
        code === 429 ||
        code === 500 ||
        code === 502 ||
        code === 504 ||
        lower.includes('unavailable') ||
        lower.includes('high demand') ||
        lower.includes('overloaded') ||
        lower.includes('resource_exhausted') ||
        lower.includes('econnreset') ||
        lower.includes('etimedout') ||
        lower.includes('fetch failed');

      return { code: code || 500, statusText, rawMessage, isRetryable };
    }

    async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<T>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`ETIMEDOUT: ${label} exceeded ${ms}ms`));
            }, ms);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function callGeminiStepWithRetry(
      stepContents: Array<{ role: string; parts: Array<Record<string, unknown>> }>
    ) {
      const modelsToTry: Array<{
        model: string;
        maxAttempts: number;
        thinkingLevel: ThinkingLevel;
      }> = [
        { model: 'gemini-4-hydrogen', maxAttempts: 2, thinkingLevel: ThinkingLevel.LOW },
        { model: 'gemini-3.1-flash-lite', maxAttempts: 2, thinkingLevel: ThinkingLevel.MINIMAL },
      ];

      let lastError: unknown = null;

      for (const candidate of modelsToTry) {
        for (let attempt = 1; attempt <= candidate.maxAttempts; attempt++) {
          try {
            return await withTimeout(
              ai.models.generateContent({
                model: candidate.model,
                contents: stepContents as never,
                config: {
                  systemInstruction,
                  thinkingConfig: { thinkingLevel: candidate.thinkingLevel },
                  tools: [{ functionDeclarations: toolDeclarations as never }],
                },
              }),
              18000,
              `Gemini request (${candidate.model})`
            );
          } catch (err) {
            lastError = err;
            const info = parseErrorDetails(err);
            const isLastAttemptForModel = attempt >= candidate.maxAttempts;

            if (!info.isRetryable) {
              throw err;
            }

            if (!isLastAttemptForModel) {
              const baseDelay = 650 * Math.pow(2, attempt - 1);
              const jitter = Math.floor(Math.random() * 250);
              await sleep(baseDelay + jitter);
            } else {
              // Brief pause before falling back to secondary model
              await sleep(250);
            }
          }
        }
      }

      throw lastError;
    }

    let finalReplyText = '';
    for (let step = 0; step < 5; step++) {
      const response = await callGeminiStepWithRetry(contents);

      const functionCalls = response.functionCalls;
      if (!functionCalls || functionCalls.length === 0) {
        finalReplyText = (response.text || '').trim();
        break;
      }

      const modelContent = response.candidates?.[0]?.content;
      if (modelContent) {
        contents.push(modelContent as never);
      }

      const responseParts: Array<Record<string, unknown>> = [];
      for (const call of functionCalls) {
        const result = executeLocalTool(
          call.name || '',
          (call.args as Record<string, unknown>) || {}
        );
        responseParts.push({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name || 'tool',
            response: result,
          },
        });
      }

      contents.push({
        role: 'user',
        parts: responseParts,
      });
    }

    const pendingActions = toolExecutor.getAllPendingActions();

    if (!finalReplyText) {
      finalReplyText =
        pendingActions.length > 0
          ? 'I prepared the requested action below. Please review the details and confirm to apply it to your account.'
          : 'I checked your Zero Crumbs food inventory and donations. Let me know what you would like to update or cook next!';
    }

    res.json({
      reply: finalReplyText,
      pendingActions,
    });
  } catch (err) {
    console.error('AI chat error:', err);
    const raw = err instanceof Error ? err.message : String(err || '');
    const lower = raw.toLowerCase();

    if (raw.includes('GEMINI_API_KEY is not configured')) {
      res.status(503).json({
        error:
          'GEMINI_API_KEY is missing on the server. Add your Gemini API key in Google AI Studio Settings > Secrets (as GEMINI_API_KEY), then tap Retry.',
        missingApiKey: true,
        retryable: true,
      });
      return;
    }

    if (lower.includes('etimedout') || lower.includes('timed out')) {
      res.status(504).json({
        error:
          'Zero Crumbs AI took longer than expected to respond. Please tap Retry to send your message again.',
        retryable: true,
      });
      return;
    }

    if (
      lower.includes('503') ||
      lower.includes('unavailable') ||
      lower.includes('high demand') ||
      lower.includes('overloaded')
    ) {
      res.status(503).json({
        error:
          'Zero Crumbs AI is temporarily experiencing high demand. We automatically retried, so please tap Retry in a moment.',
        retryable: true,
      });
      return;
    }

    if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota')) {
      res.status(429).json({
        error:
          'Zero Crumbs AI has reached a temporary rate limit. Please wait a few seconds and tap Retry.',
        retryable: true,
      });
      return;
    }

    if (
      lower.includes('permission_denied') ||
      lower.includes('api_key_invalid') ||
      lower.includes('api key not valid') ||
      lower.includes('403')
    ) {
      res.status(403).json({
        error:
          'The Gemini API key appears invalid or lacks permission. Please verify GEMINI_API_KEY in Google AI Studio Settings > Secrets.',
        missingApiKey: true,
        retryable: false,
      });
      return;
    }

    if (lower.includes('400') || lower.includes('invalid_argument')) {
      res.status(400).json({
        error: 'Zero Crumbs AI could not process that message format. Please try rephrasing and tap Retry.',
        retryable: true,
      });
      return;
    }

    res.status(500).json({
      error: 'Zero Crumbs AI could not complete that request right now. Please tap Retry.',
      retryable: true,
    });
  }
});

// Speech-to-text transcription fallback for browsers without Web Speech Recognition (e.g., Firefox)
app.post('/api/ai/transcribe', requireAuth, async (req, res) => {
  try {
    const { audioBase64, mimeType } = req.body as {
      audioBase64?: string;
      mimeType?: string;
    };

    if (!audioBase64 || typeof audioBase64 !== 'string' || audioBase64.trim().length < 16) {
      res.status(400).json({ error: 'No recorded audio was received. Please speak and try again.' });
      return;
    }

    if (audioBase64.length > 5 * 1024 * 1024) {
      res.status(413).json({ error: 'Voice recording is too long. Please keep each message under 45 seconds.' });
      return;
    }

    const rawMime = typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : 'audio/webm';
    const allowedMimes = new Set([
      'audio/webm',
      'audio/mp4',
      'audio/ogg',
      'audio/wav',
      'audio/mpeg',
      'audio/aac',
    ]);
    const safeMime = allowedMimes.has(rawMime) ? rawMime : 'audio/webm';

    const ai = getGeminiClient();
    const models = ['gemini-3.5-transcribe', 'gemini-4-hydrogen'];
    let lastError: unknown = null;

    for (const model of models) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: safeMime,
                  data: audioBase64.trim(),
                },
              },
              {
                text: 'Transcribe the spoken user speech accurately into plain text. Return only the spoken words with no commentary or quotes. If there is only silence or background noise, return an empty string.',
              },
            ],
          },
        });
        const transcript = (response.text || '').trim();
        res.json({ transcript, model });
        return;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError;
  } catch (err) {
    console.error('AI transcribe error:', err);
    const raw = err instanceof Error ? err.message : String(err || '');
    const lower = raw.toLowerCase();

    if (raw.includes('GEMINI_API_KEY is not configured')) {
      res.status(503).json({
        error:
          'GEMINI_API_KEY is missing on the server. Add your Gemini API key in Google AI Studio Settings > Secrets (as GEMINI_API_KEY).',
        missingApiKey: true,
      });
      return;
    }

    if (
      lower.includes('permission_denied') ||
      lower.includes('api_key_invalid') ||
      lower.includes('api key not valid') ||
      lower.includes('403')
    ) {
      res.status(403).json({
        error:
          'The Gemini API key appears invalid or lacks permission. Please verify GEMINI_API_KEY in Google AI Studio Settings > Secrets.',
        missingApiKey: true,
      });
      return;
    }

    if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota')) {
      res.status(429).json({
        error: 'Speech transcription reached a temporary rate limit. Please wait a moment and try again.',
      });
      return;
    }

    res.status(502).json({
      error: 'Could not transcribe your voice recording right now. Please try speaking again.',
    });
  }
});

// --- Google Maps Platform Integration Endpoints ---

// Expose runtime Google Maps JS API key to authenticated users without hardcoding
app.get('/api/maps/config', requireAuth, (_req, res) => {
  const apiKey = getGoogleMapsApiKey();
  res.json({
    configured: Boolean(apiKey),
    apiKey,
  });
});

// Forward Geocoding API v4 proxy (address string -> lat/lng + formattedAddress)
app.post('/api/maps/geocode', requireAuth, async (req, res) => {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    res.status(503).json({
      error:
        'Google Maps API key is not configured on the server. Add GOOGLE_MAPS_API_KEY in Settings > Secrets.',
      missingMapsKey: true,
    });
    return;
  }

  const { address } = req.body as { address?: string };
  if (typeof address !== 'string' || address.trim().length < 2 || address.trim().length > 300) {
    res.status(400).json({ error: 'Please enter a valid street address, area, or postal code.' });
    return;
  }

  const trimmed = address.trim();
  try {
    const endpoint = `https://geocode.googleapis.com/v4/geocode/address/${encodeURIComponent(trimmed)}?languageCode=en`;
    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'results.placeId,results.location,results.formattedAddress',
        'X-Goog-Maps-Solution-ID': GMP_SOLUTION_ID,
      },
      signal: AbortSignal.timeout(10000),
    });

    const rawText = await resp.text();
    if (!resp.ok) {
      if (isMapsQuotaError(resp.status, rawText)) {
        res.status(429).json({
          error: 'Google Maps daily free-tier quota exceeded.',
          quotaExceeded: true,
        });
        return;
      }
      res.status(resp.status >= 400 && resp.status < 500 ? resp.status : 502).json({
        error: 'Could not resolve that address using Google Geocoding API.',
      });
      return;
    }

    const data = JSON.parse(rawText) as {
      results?: Array<{
        placeId?: string;
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
      }>;
    };

    const first = data.results?.[0];
    if (
      !first ||
      typeof first.location?.latitude !== 'number' ||
      typeof first.location?.longitude !== 'number'
    ) {
      res.status(404).json({
        error:
          'No matching address was found. Try including a city or neighborhood, or move the pin directly on the map.',
      });
      return;
    }

    res.json({
      lat: first.location.latitude,
      lng: first.location.longitude,
      formattedAddress: first.formattedAddress || trimmed,
      placeId: first.placeId || '',
    });
  } catch (err) {
    console.error('Geocode proxy error:', err);
    res.status(502).json({
      error: 'Could not reach Google Geocoding service. Please check your connection and retry.',
    });
  }
});

// Reverse Geocoding API v4 proxy (lat/lng -> formattedAddress + placeId)
app.post('/api/maps/reverse-geocode', requireAuth, async (req, res) => {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    res.status(503).json({
      error:
        'Google Maps API key is not configured on the server. Add GOOGLE_MAPS_API_KEY in Settings > Secrets.',
      missingMapsKey: true,
    });
    return;
  }

  const { lat, lng } = req.body as { lat?: number; lng?: number };
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    Number.isNaN(lat) ||
    Number.isNaN(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    res.status(400).json({ error: 'Valid latitude and longitude coordinates are required.' });
    return;
  }

  try {
    const url = new URL('https://geocode.googleapis.com/v4/geocode/location');
    url.searchParams.set('location.latitude', String(lat));
    url.searchParams.set('location.longitude', String(lng));
    url.searchParams.set('languageCode', 'en');

    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'results.placeId,results.formattedAddress',
        'X-Goog-Maps-Solution-ID': GMP_SOLUTION_ID,
      },
      signal: AbortSignal.timeout(10000),
    });

    const rawText = await resp.text();
    if (!resp.ok) {
      if (isMapsQuotaError(resp.status, rawText)) {
        res.status(429).json({
          error: 'Google Maps daily free-tier quota exceeded.',
          quotaExceeded: true,
        });
        return;
      }
      res.status(resp.status >= 400 && resp.status < 500 ? resp.status : 502).json({
        error: 'Could not look up the street address for this pin location.',
      });
      return;
    }

    const data = JSON.parse(rawText) as {
      results?: Array<{
        placeId?: string;
        formattedAddress?: string;
      }>;
    };

    const first = data.results?.[0];
    if (!first?.formattedAddress) {
      res.json({
        lat,
        lng,
        formattedAddress: '',
        placeId: '',
        noAddressFound: true,
      });
      return;
    }

    res.json({
      lat,
      lng,
      formattedAddress: first.formattedAddress,
      placeId: first.placeId || '',
      noAddressFound: false,
    });
  } catch (err) {
    console.error('Reverse geocode proxy error:', err);
    res.status(502).json({
      error: 'Could not reach Google Geocoding service. Please try again.',
    });
  }
});

// Places API (New) Text Search proxy for genuine nearby NGOs, food banks, orphanages & community kitchens
app.post('/api/maps/nearby-charities', requireAuth, async (req, res) => {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    res.status(503).json({
      error:
        'Google Maps API key is not configured on the server. Add GOOGLE_MAPS_API_KEY in Settings > Secrets.',
      missingMapsKey: true,
    });
    return;
  }

  const { lat, lng, radiusMeters } = req.body as {
    lat?: number;
    lng?: number;
    radiusMeters?: number;
  };

  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    Number.isNaN(lat) ||
    Number.isNaN(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    res.status(400).json({ error: 'Valid pickup latitude and longitude coordinates are required.' });
    return;
  }

  const safeRadius =
    typeof radiusMeters === 'number' && !Number.isNaN(radiusMeters)
      ? Math.min(50000, Math.max(1000, Math.round(radiusMeters)))
      : 15000;

  const cacheKey = `${lat.toFixed(3)}:${lng.toFixed(3)}:${safeRadius}`;
  const now = Date.now();
  const cached = nearbyCharitiesCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    res.json({ organisations: cached.organisations, cached: true });
    return;
  }

  interface RawPlaceItem {
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
    primaryTypeDisplayName?: { text?: string };
    googleMapsUri?: string;
    googleMapsLinks?: {
      placeUri?: string;
      directionsUri?: string;
    };
    nationalPhoneNumber?: string;
    internationalPhoneNumber?: string;
    websiteUri?: string;
  }

  async function runTextSearch(textQuery: string): Promise<{
    places: RawPlaceItem[];
    quotaExceeded?: boolean;
    errorStatus?: number;
  }> {
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.location,places.primaryTypeDisplayName,places.googleMapsUri,places.googleMapsLinks,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri',
        'X-Goog-Maps-Solution-ID': GMP_SOLUTION_ID,
      },
      body: JSON.stringify({
        textQuery,
        pageSize: 15,
        languageCode: 'en',
        locationBias: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: safeRadius,
          },
        },
      }),
      signal: AbortSignal.timeout(12000),
    });

    const rawText = await resp.text();
    if (!resp.ok) {
      if (isMapsQuotaError(resp.status, rawText)) {
        return { places: [], quotaExceeded: true, errorStatus: 429 };
      }
      return { places: [], errorStatus: resp.status };
    }

    const parsed = JSON.parse(rawText) as { places?: RawPlaceItem[] };
    return { places: Array.isArray(parsed.places) ? parsed.places : [] };
  }

  try {
    const primary = await runTextSearch('charity food bank NGO orphanage community kitchen');
    if (primary.quotaExceeded) {
      res.status(429).json({
        error: 'Google Maps daily free-tier quota exceeded.',
        quotaExceeded: true,
      });
      return;
    }
    if (primary.errorStatus) {
      res.status(502).json({
        error: 'Could not search nearby charity organisations via Google Places API.',
      });
      return;
    }

    const combinedMap = new Map<string, RawPlaceItem>();
    for (const p of primary.places) {
      if (p.id) combinedMap.set(p.id, p);
    }

    // Only issue a secondary query if fewer than 3 matches came back
    if (combinedMap.size < 3) {
      const secondary = await runTextSearch('nonprofit charitable trust food pantry shelter');
      if (secondary.quotaExceeded) {
        res.status(429).json({
          error: 'Google Maps daily free-tier quota exceeded.',
          quotaExceeded: true,
        });
        return;
      }
      for (const p of secondary.places) {
        if (p.id && !combinedMap.has(p.id)) {
          combinedMap.set(p.id, p);
        }
      }
    }

    const organisations = Array.from(combinedMap.values())
      .filter(
        (p) =>
          typeof p.id === 'string' &&
          p.id.length > 0 &&
          typeof p.displayName?.text === 'string' &&
          p.displayName.text.trim().length > 0 &&
          typeof p.location?.latitude === 'number' &&
          typeof p.location?.longitude === 'number'
      )
      .map((p) => {
        const pLat = p.location!.latitude!;
        const pLng = p.location!.longitude!;
        const placeId = p.id!;
        const distanceMeters = haversineDistanceMeters(lat, lng, pLat, pLng);
        const rawPhone = (p.nationalPhoneNumber || p.internationalPhoneNumber || '').trim();
        const rawMapsUri = (p.googleMapsUri || p.googleMapsLinks?.placeUri || '').trim();
        const rawDirectionsUri = (p.googleMapsLinks?.directionsUri || '').trim();
        const rawWebsite = (p.websiteUri || '').trim();

        const safeGoogleMapsUri =
          rawMapsUri.startsWith('https://')
            ? rawMapsUri.slice(0, 500)
            : `https://www.google.com/maps/search/?api=1&query=${pLat},${pLng}&query_place_id=${encodeURIComponent(placeId)}`;

        const safeDirectionsUri =
          rawDirectionsUri.startsWith('https://')
            ? rawDirectionsUri.slice(0, 500)
            : `https://www.google.com/maps/dir/?api=1&origin=${lat},${lng}&destination=${pLat},${pLng}&destination_place_id=${encodeURIComponent(placeId)}`;

        const safeWebsiteUri = /^https?:\/\/[^\s]+$/i.test(rawWebsite)
          ? rawWebsite.slice(0, 500)
          : undefined;

        return {
          placeId: placeId.slice(0, 200),
          name: p.displayName!.text!.trim().slice(0, 160),
          address: (p.formattedAddress || `${pLat.toFixed(5)}, ${pLng.toFixed(5)}`)
            .trim()
            .slice(0, 300),
          ...(rawPhone ? { phone: rawPhone.slice(0, 40) } : {}),
          category: (p.primaryTypeDisplayName?.text || 'Charity & Food Relief')
            .trim()
            .slice(0, 80),
          latitude: pLat,
          longitude: pLng,
          distanceMeters,
          googleMapsUri: safeGoogleMapsUri,
          directionsUri: safeDirectionsUri,
          ...(safeWebsiteUri ? { websiteUri: safeWebsiteUri } : {}),
        };
      })
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, 12);

    // Maintain a bounded 5-minute cache to stay friendly to GHP daily quota
    if (nearbyCharitiesCache.size >= 50) {
      const oldestKey = nearbyCharitiesCache.keys().next().value;
      if (oldestKey) nearbyCharitiesCache.delete(oldestKey);
    }
    nearbyCharitiesCache.set(cacheKey, {
      expiresAt: now + 5 * 60 * 1000,
      organisations,
    });

    res.json({ organisations, cached: false });
  } catch (err) {
    console.error('Nearby charities search error:', err);
    res.status(502).json({
      error: 'Could not search nearby charity organisations right now. Please try again.',
    });
  }
});

const ALLOWED_LIVE_VOICES = new Set(['Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir']);

function formatLiveError(err: unknown): { message: string; missingApiKey: boolean } {
  const raw = err instanceof Error ? err.message : String(err || '');
  const lower = raw.toLowerCase();

  if (raw.includes('GEMINI_API_KEY is not configured')) {
    return {
      message:
        'GEMINI_API_KEY is missing on the server. Add your Gemini API key in Google AI Studio Settings > Secrets (as GEMINI_API_KEY), then try voice again.',
      missingApiKey: true,
    };
  }
  if (
    lower.includes('permission_denied') ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('403')
  ) {
    return {
      message:
        'The Gemini API key appears invalid or lacks permission. Please verify GEMINI_API_KEY in Google AI Studio Settings > Secrets.',
      missingApiKey: true,
    };
  }
  if (lower.includes('404') || lower.includes('not_found')) {
    return {
      message:
        'Gemini Live streaming endpoint returned 404 (not found or unsupported for this API version/model).',
      missingApiKey: false,
    };
  }
  if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota')) {
    return {
      message:
        'Zero Crumbs AI Voice reached a temporary rate limit. Please wait a few seconds and try again.',
      missingApiKey: false,
    };
  }
  return {
    message: raw
      ? `Zero Crumbs AI Voice connection failed: ${raw.slice(0, 180)}`
      : 'Zero Crumbs AI Voice encountered a connection issue. Please try starting voice again.',
    missingApiKey: false,
  };
}

function attachLiveVoiceWebSocket(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  server.on('upgrade', (request, socket, head) => {
    try {
      const reqUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (reqUrl.pathname === '/api/ai/live') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
        return;
      }
    } catch {
      // Ignore malformed upgrade URLs
    }
    socket.destroy();
  });

  wss.on('connection', (clientWs: WebSocket) => {
    let initialized = false;
    let closed = false;
    let session: Session | null = null;
    let toolExecutor: ReturnType<typeof createZeroCrumbsToolExecutor> | null = null;

    const sendToClient = (payload: Record<string, unknown>) => {
      if (!closed && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(authTimer);
      if (session) {
        try {
          session.close();
        } catch {
          // Ignore close failure
        }
        session = null;
      }
    };

    const authTimer = setTimeout(() => {
      if (!initialized && !closed) {
        sendToClient({ type: 'error', error: 'Authentication handshake timed out.' });
        clientWs.close(4001, 'Authentication timeout');
        cleanup();
      }
    }, 10000);

    clientWs.on('close', cleanup);
    clientWs.on('error', cleanup);

    clientWs.on('message', async (rawData) => {
      if (closed) return;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(rawData.toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      const msgType = typeof msg.type === 'string' ? msg.type : '';

      if (!initialized) {
        if (msgType !== 'init') {
          sendToClient({ type: 'error', error: 'Authentication required before streaming audio.' });
          clientWs.close(4001, 'Authentication required');
          cleanup();
          return;
        }

        const idToken = typeof msg.idToken === 'string' ? msg.idToken : '';
        const authUser = await verifyFirebaseIdToken(idToken);
        if (!authUser) {
          sendToClient({ type: 'error', error: 'Authentication required. Please sign in to use voice.' });
          clientWs.close(4001, 'Invalid token');
          cleanup();
          return;
        }

        const otpVerified = await isUserOtpVerified(authUser);
        if (!otpVerified) {
          sendToClient({
            type: 'error',
            error: 'Please verify your email address via Email OTP before using Zero Crumbs AI Voice.',
          });
          clientWs.close(4003, 'Email verification required');
          cleanup();
          return;
        }

        if (!isGeminiKeyConfigured()) {
          sendToClient({
            type: 'error',
            missingApiKey: true,
            error:
              'GEMINI_API_KEY is missing on the server. Add your Gemini API key in Google AI Studio Settings > Secrets (as GEMINI_API_KEY), then tap Try Again.',
          });
          clientWs.close(4503, 'Missing API key');
          cleanup();
          return;
        }

        clearTimeout(authTimer);
        initialized = true;

        const todayStr =
          typeof msg.currentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(msg.currentDate)
            ? msg.currentDate
            : new Date().toISOString().slice(0, 10);

        const inventory = Array.isArray(msg.inventory)
          ? (msg.inventory as InventorySnapshotItem[])
          : [];
        const donations = Array.isArray(msg.donations)
          ? (msg.donations as DonationSnapshotItem[])
          : [];
        const profile =
          msg.profile && typeof msg.profile === 'object'
            ? (msg.profile as UserProfileSnapshot)
            : {};

        const requestedVoice = typeof msg.voiceName === 'string' ? msg.voiceName : 'Zephyr';
        const voiceName = ALLOWED_LIVE_VOICES.has(requestedVoice) ? requestedVoice : 'Zephyr';

        toolExecutor = createZeroCrumbsToolExecutor({
          inventory,
          donations,
          profile,
          todayStr,
        });

        const systemInstruction = buildZeroCrumbsSystemInstruction({
          todayStr,
          profile,
          voiceMode: true,
        });

        try {
          const ai = getGeminiLiveClient();
          const activeExecutor = toolExecutor;
          let readySent = false;
          const emitReady = () => {
            if (!readySent && !closed) {
              readySent = true;
              sendToClient({ type: 'ready', model: 'gemini-3.8-live', voiceName });
            }
          };

          const liveSession = await ai.live.connect({
            model: 'gemini-3.8-live',
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName } },
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              systemInstruction,
              tools: [{ functionDeclarations: ZERO_CRUMBS_TOOL_DECLARATIONS as never }],
            },
            callbacks: {
              onopen: () => {
                // Wait for setupComplete or confirm ready once connect resolves
              },
              onmessage: (liveMessage: LiveServerMessage) => {
                if (closed) return;

                if (liveMessage.setupComplete) {
                  emitReady();
                }

                const serverContent = liveMessage.serverContent;
                if (serverContent) {
                  if (serverContent.interrupted) {
                    sendToClient({ type: 'interrupted' });
                  }

                  if (serverContent.inputTranscription?.text) {
                    sendToClient({
                      type: 'inputTranscript',
                      text: serverContent.inputTranscription.text,
                    });
                  }

                  if (serverContent.outputTranscription?.text) {
                    sendToClient({
                      type: 'outputTranscript',
                      text: serverContent.outputTranscription.text,
                    });
                  }

                  for (const part of serverContent.modelTurn?.parts ?? []) {
                    if (part.inlineData?.data) {
                      sendToClient({ type: 'audio', data: part.inlineData.data });
                    }
                  }

                  if (serverContent.turnComplete) {
                    sendToClient({ type: 'turnComplete' });
                  }
                }

                const functionCalls = liveMessage.toolCall?.functionCalls;
                if (functionCalls && functionCalls.length > 0 && session) {
                  const functionResponses = functionCalls.map((call) => {
                    const result = activeExecutor.executeLocalTool(
                      call.name || '',
                      (call.args as Record<string, unknown>) || {}
                    );
                    return {
                      ...(call.id ? { id: call.id } : {}),
                      name: call.name || 'tool',
                      response: result,
                    };
                  });

                  const proposed = activeExecutor.takePendingActions();
                  if (proposed.length > 0) {
                    sendToClient({ type: 'pendingActions', actions: proposed });
                  }

                  try {
                    session.sendToolResponse({ functionResponses });
                  } catch (toolErr) {
                    console.error('Failed to send tool response to Live session:', toolErr);
                  }
                }
              },
              onerror: (errEvent) => {
                if (closed) return;
                const formatted = formatLiveError(
                  (errEvent as { error?: unknown; message?: string })?.error ||
                    (errEvent as { message?: string })?.message ||
                    'Live API error'
                );
                sendToClient({
                  type: 'error',
                  error: formatted.message,
                  missingApiKey: formatted.missingApiKey,
                });
              },
              onclose: () => {
                if (!closed) {
                  sendToClient({ type: 'sessionClosed' });
                  clientWs.close(1000, 'Live session ended');
                  cleanup();
                }
              },
            },
          });

          if (closed) {
            liveSession.close();
            return;
          }

          session = liveSession;
          emitReady();
        } catch (err) {
          console.error('Failed to connect Gemini Live session:', err);
          const formatted = formatLiveError(err);
          sendToClient({
            type: 'error',
            error: formatted.message,
            missingApiKey: formatted.missingApiKey,
          });
          clientWs.close(1011, 'Gemini Live setup failed');
          cleanup();
        }
        return;
      }

      if (!session) return;

      if (msgType === 'audio' && typeof msg.data === 'string' && msg.data.length > 0) {
        try {
          session.sendRealtimeInput({
            audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
          });
        } catch {
          // Ignore send after close
        }
      } else if (msgType === 'audioStreamEnd') {
        try {
          session.sendRealtimeInput({ audioStreamEnd: true });
        } catch {
          // Ignore send after close
        }
      } else if (msgType === 'text' && typeof msg.text === 'string' && msg.text.trim().length > 0) {
        try {
          session.sendRealtimeInput({ text: msg.text.trim() });
        } catch {
          // Ignore send after close
        }
      } else if (msgType === 'contextUpdate' && toolExecutor) {
        toolExecutor.updateSnapshot({
          inventory: Array.isArray(msg.inventory)
            ? (msg.inventory as InventorySnapshotItem[])
            : undefined,
          donations: Array.isArray(msg.donations)
            ? (msg.donations as DonationSnapshotItem[])
            : undefined,
          profile:
            msg.profile && typeof msg.profile === 'object'
              ? (msg.profile as UserProfileSnapshot)
              : undefined,
          todayStr:
            typeof msg.currentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(msg.currentDate)
              ? msg.currentDate
              : undefined,
        });
      } else if (msgType === 'close') {
        clientWs.close(1000, 'Client closed voice conversation');
        cleanup();
      }
    });
  });
}

async function startServer() {
  const port = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    const assetsDir = path.join(distDir, 'assets');
    if (fs.existsSync(assetsDir)) {
      app.use('/assets', express.static(assetsDir, { maxAge: '1y', immutable: true }));
    }
    app.use(
      express.static(distDir, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          }
        },
      })
    );
    app.all('/api/*', (_req, res) => {
      res.status(404).json({ error: 'API endpoint not found.' });
    });
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = http.createServer(app);
  attachLiveVoiceWebSocket(server);

  server.listen(port, '0.0.0.0', () => {
    console.log(
      `Zero Crumbs server running on http://0.0.0.0:${port} (env=${isProd ? 'production' : 'development'}, geminiConfigured=${isGeminiKeyConfigured()})`
    );
  });
}

startServer();
