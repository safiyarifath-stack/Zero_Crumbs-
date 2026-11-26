import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  defaultSendEmail,
  EmailOtpService,
  getEmailDeliveryStatus,
  type OtpPurpose,
} from './server/emailOtpService';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));

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

async function verifyFirebaseBearerToken(req: express.Request): Promise<VerifiedUser | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken || !firebaseApiKey) {
    return null;
  }

  try {
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
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
      idToken,
    };
  } catch {
    return null;
  }
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
  const otpVerified =
    user.emailVerified ||
    verifiedOtpUids.has(user.uid) ||
    (await isEmailOtpVerifiedInFirestore(user.uid, user.idToken));

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

// Send 6-digit Email OTP (signup or existing unverified email verification)
app.post('/api/auth/send-otp', async (req, res) => {
  const { email, fullName, purpose } = req.body as {
    email?: string;
    fullName?: string;
    purpose?: OtpPurpose;
  };
  const safePurpose: OtpPurpose =
    purpose === 'verify-existing' ? 'verify-existing' : 'signup';
  const clientIp =
    (typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : req.ip) || 'unknown';

  const result = await emailOtpService.sendOtp({
    email: typeof email === 'string' ? email : '',
    fullName: typeof fullName === 'string' ? fullName : '',
    purpose: safePurpose,
    ip: clientIp,
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
app.post('/api/auth/verify-otp', (req, res) => {
  const { email, otp, purpose } = req.body as {
    email?: string;
    otp?: string;
    purpose?: OtpPurpose;
  };
  const safePurpose: OtpPurpose =
    purpose === 'verify-existing' ? 'verify-existing' : 'signup';

  const result = emailOtpService.verifyOtp({
    email: typeof email === 'string' ? email : '',
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
app.get('/api/ai/status', requireAuth, (_req, res) => {
  res.json({
    configured: isGeminiKeyConfigured(),
    model: 'gemini-4-hydrogen',
  });
});

// Check real email reminder integration status
app.get('/api/reminders/status', requireAuth, (_req, res) => {
  const delivery = getEmailDeliveryStatus();
  res.json({
    emailConfigured: delivery.configured,
    provider: delivery.provider,
    missingEnv: delivery.missingEnv,
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
      error:
        'Email reminder service is not connected yet. Configure APPS_SCRIPT_EMAIL_URL (free Google Apps Script MailApp) or RESEND_API_KEY and REMINDER_FROM_EMAIL in Settings > Secrets.',
      missingEnv: delivery.missingEnv,
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

interface InventorySnapshotItem {
  id: string;
  name: string;
  category: string;
  quantity: number;
  initialQuantity: number;
  unit: string;
  location: string;
  expiryDate: string;
  status: string;
  notes?: string;
}

interface DonationSnapshotItem {
  id: string;
  foodName: string;
  quantity: number;
  unit: string;
  category: string;
  expiryDate: string;
  status: string;
  pickupLocation: string;
  charityPartner?: string;
}

interface PendingActionProposal {
  actionId: string;
  type:
    | 'add_food'
    | 'use_food'
    | 'increase_food'
    | 'update_food'
    | 'delete_food'
    | 'create_donation'
    | 'update_donation_status';
  title: string;
  description: string;
  requiresConfirmation: boolean;
  payload: Record<string, unknown>;
}

function daysBetween(expiryDate: string, todayStr: string): number {
  const [ey, em, ed] = expiryDate.split('-').map(Number);
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const expUtc = Date.UTC(ey, (em || 1) - 1, ed || 1);
  const todayUtc = Date.UTC(ty, (tm || 1) - 1, td || 1);
  return Math.round((expUtc - todayUtc) / (1000 * 60 * 60 * 24));
}

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
      profile?: { fullName?: string; reminderDaysBefore?: number; defaultLocation?: string };
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

    const toolDeclarations = [
      {
        name: 'search_inventory',
        description:
          'Search and inspect the authenticated user household food inventory by optional name query, storage location, or status.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: { type: Type.STRING, description: 'Partial name or category keyword to match.' },
            location: {
              type: Type.STRING,
              description: 'Optional storage location: Fridge, Freezer, or Pantry.',
            },
            status: {
              type: Type.STRING,
              description: 'Optional status filter: active, consumed, wasted, donated, or all.',
            },
          },
        },
      },
      {
        name: 'get_expiring_summary',
        description:
          'Check expiry dates across active inventory and return expired, expiring today, and soon-to-expire items.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            daysThreshold: {
              type: Type.NUMBER,
              description: 'Days window for soon-to-expire items (default 3).',
            },
          },
        },
      },
      {
        name: 'get_waste_and_consumption_insights',
        description:
          'Analyze consumed, wasted, donated, and active food patterns to recommend shopping lists and waste-reduction tips.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            focusArea: {
              type: Type.STRING,
              description: 'Optional focus area: all, waste, shopping, or donations.',
            },
          },
        },
      },
      {
        name: 'get_donation_summary',
        description: 'Inspect current charity donation listings and statuses.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            statusFilter: {
              type: Type.STRING,
              description:
                'Optional status filter: all, Available, Requested, Approved, Collected, Donated, or Cancelled.',
            },
          },
        },
      },
      {
        name: 'propose_add_food',
        description:
          'Prepare an action confirmation card to add a new food item to the user inventory. Does not write until user confirms.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            quantity: { type: Type.NUMBER },
            unit: {
              type: Type.STRING,
              description: 'One of: g, kg, ml, l, pcs, packs, cups, tbsp, bottles, cans',
            },
            location: { type: Type.STRING, description: 'One of: Fridge, Freezer, Pantry' },
            expiryDate: { type: Type.STRING, description: 'YYYY-MM-DD' },
            category: {
              type: Type.STRING,
              description:
                'One of: Produce, Dairy & Eggs, Bakery, Grains & Pantry, Proteins, Prepared Meals, Beverages, Frozen, Other',
            },
            notes: { type: Type.STRING },
          },
          required: ['name', 'quantity', 'unit', 'location', 'expiryDate'],
        },
      },
      {
        name: 'propose_use_food',
        description:
          'Prepare an action confirmation card to reduce remaining quantity of an existing food item or mark it completely consumed.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            foodId: { type: Type.STRING },
            foodName: { type: Type.STRING },
            amountUsed: { type: Type.NUMBER },
            unit: {
              type: Type.STRING,
              description: 'One of: g, kg, ml, l, pcs, packs, cups, tbsp, bottles, cans',
            },
            markCompletelyUsed: { type: Type.BOOLEAN },
          },
          required: ['foodId', 'foodName', 'amountUsed', 'unit'],
        },
      },
      {
        name: 'propose_increase_food',
        description:
          'Prepare an action confirmation card to increase the quantity of an existing food item.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            foodId: { type: Type.STRING },
            foodName: { type: Type.STRING },
            amountAdded: { type: Type.NUMBER },
            unit: { type: Type.STRING },
          },
          required: ['foodId', 'foodName', 'amountAdded', 'unit'],
        },
      },
      {
        name: 'propose_update_food',
        description:
          'Prepare an action confirmation card to edit details (name, location, expiryDate, category, notes) of an existing food item.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            foodId: { type: Type.STRING },
            foodName: { type: Type.STRING },
            newName: { type: Type.STRING },
            location: { type: Type.STRING },
            expiryDate: { type: Type.STRING },
            category: { type: Type.STRING },
            notes: { type: Type.STRING },
          },
          required: ['foodId', 'foodName'],
        },
      },
      {
        name: 'propose_delete_food',
        description:
          'Prepare an action confirmation card to delete a food item from inventory. Always requires explicit user confirmation.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            foodId: { type: Type.STRING },
            foodName: { type: Type.STRING },
            reason: { type: Type.STRING },
          },
          required: ['foodId', 'foodName'],
        },
      },
      {
        name: 'propose_create_donation',
        description:
          'Prepare an action confirmation card to publish a surplus food donation listing. Strictly forbidden for expired food.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            foodId: { type: Type.STRING, description: 'Existing food ID or standalone' },
            foodName: { type: Type.STRING },
            quantity: { type: Type.NUMBER },
            unit: { type: Type.STRING },
            category: { type: Type.STRING },
            expiryDate: { type: Type.STRING, description: 'YYYY-MM-DD, must be today or future' },
            pickupLocation: { type: Type.STRING },
            contactInfo: { type: Type.STRING },
            notes: { type: Type.STRING },
          },
          required: ['foodName', 'quantity', 'unit', 'expiryDate'],
        },
      },
      {
        name: 'propose_update_donation_status',
        description:
          'Prepare an action confirmation card to update a donation listing status (Available, Requested, Approved, Collected, Donated, Cancelled).',
        parameters: {
          type: Type.OBJECT,
          properties: {
            donationId: { type: Type.STRING },
            foodName: { type: Type.STRING },
            newStatus: { type: Type.STRING },
            charityPartner: { type: Type.STRING },
          },
          required: ['donationId', 'foodName', 'newStatus'],
        },
      },
    ];

    const systemInstruction = `You are Zero Crumbs AI, the warm, practical, action-capable food management assistant inside the Zero Crumbs web application.
Today's date is ${todayStr}.
User profile: ${JSON.stringify({
      fullName: profile.fullName || 'Household Member',
      reminderDaysBefore: profile.reminderDaysBefore ?? 3,
      defaultLocation: profile.defaultLocation || 'Fridge',
    })}.

CORE RULES:
1. Always inspect the user's real inventory or donations via the provided tools before claiming what items exist or proposing edits. Never invent items or claim a database write happened before the user confirms the action card.
2. NEVER recommend eating or donating EXPIRED food (expiryDate < ${todayStr}). If an item is expired, clearly warn the user and suggest safe disposal or composting, or offer to mark it as wasted/remove it after confirmation.
3. Whenever the user instructs you to add, update, consume, increase, delete food, or publish/update a donation, call the corresponding \`propose_*\` tool so the UI displays an Action Confirmation Card for the user to approve. Explain clearly what action you prepared and why.
4. For recipe requests, prioritize active items expiring soon (within 0–3 days) and provide concise, practical cooking steps.
5. Keep language friendly, clear, and concise (no technical jargon, no JSON dumps in prose).`;

    const pendingActions: PendingActionProposal[] = [];

    function executeLocalTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
      if (name === 'search_inventory') {
        const q = typeof args.query === 'string' ? args.query.toLowerCase().trim() : '';
        const loc = typeof args.location === 'string' ? args.location.toLowerCase().trim() : '';
        const statusFilter =
          typeof args.status === 'string' ? args.status.toLowerCase().trim() : 'active';

        const matches = safeInventory
          .filter((item) => {
            if (statusFilter !== 'all' && item.status.toLowerCase() !== statusFilter) return false;
            if (loc && item.location.toLowerCase() !== loc) return false;
            if (
              q &&
              !item.name.toLowerCase().includes(q) &&
              !item.category.toLowerCase().includes(q)
            ) {
              return false;
            }
            return true;
          })
          .map((item) => ({
            ...item,
            daysUntilExpiry: daysBetween(item.expiryDate, todayStr),
          }))
          .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

        return { count: matches.length, items: matches };
      }

      if (name === 'get_expiring_summary') {
        const threshold = typeof args.daysThreshold === 'number' ? args.daysThreshold : 3;
        const active = safeInventory.filter((i) => i.status === 'active');
        const expired = active.filter((i) => daysBetween(i.expiryDate, todayStr) < 0);
        const today = active.filter((i) => daysBetween(i.expiryDate, todayStr) === 0);
        const soon = active.filter((i) => {
          const d = daysBetween(i.expiryDate, todayStr);
          return d >= 1 && d <= threshold;
        });
        const fresh = active.filter((i) => daysBetween(i.expiryDate, todayStr) > threshold);
        return {
          todayDate: todayStr,
          expiredCount: expired.length,
          expiringTodayCount: today.length,
          expiringSoonCount: soon.length,
          freshCount: fresh.length,
          expired,
          expiringToday: today,
          expiringSoon: soon,
        };
      }

      if (name === 'get_waste_and_consumption_insights') {
        const consumed = safeInventory.filter((i) => i.status === 'consumed');
        const wasted = safeInventory.filter((i) => i.status === 'wasted');
        const donated = safeInventory.filter((i) => i.status === 'donated');
        const active = safeInventory.filter((i) => i.status === 'active');
        const lowStock = active.filter(
          (i) => i.initialQuantity > 0 && i.quantity / i.initialQuantity <= 0.25
        );
        return {
          activeCount: active.length,
          consumedItems: consumed.map((i) => i.name),
          wastedItems: wasted.map((i) => ({ name: i.name, category: i.category })),
          donatedItems: donated.map((i) => i.name),
          lowStockItems: lowStock.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            unit: i.unit,
            location: i.location,
          })),
          totalDonationsListed: safeDonations.length,
        };
      }

      if (name === 'get_donation_summary') {
        const statusFilter =
          typeof args.statusFilter === 'string' ? args.statusFilter.toLowerCase().trim() : 'all';
        const filtered =
          statusFilter && statusFilter !== 'all'
            ? safeDonations.filter((d) => d.status.toLowerCase() === statusFilter)
            : safeDonations;
        return {
          count: filtered.length,
          donations: filtered,
        };
      }

      if (name === 'propose_add_food') {
        const itemName = String(args.name || '').trim();
        const qty = Number(args.quantity || 1);
        const unit = String(args.unit || 'pcs');
        const location = String(args.location || profile.defaultLocation || 'Fridge');
        const expiryDate = String(args.expiryDate || todayStr);
        const category = String(args.category || 'Other');
        const notes = String(args.notes || '');

        const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        pendingActions.push({
          actionId,
          type: 'add_food',
          title: `Add ${itemName}`,
          description: `Add ${qty} ${unit} of ${itemName} to ${location} (expires ${expiryDate}).`,
          requiresConfirmation: true,
          payload: { name: itemName, quantity: qty, unit, location, expiryDate, category, notes },
        });
        return {
          queuedForConfirmation: true,
          actionId,
          summary: `Prepared action card to add ${qty} ${unit} of ${itemName} to ${location}. Waiting for user confirmation.`,
        };
      }

      if (name === 'propose_use_food') {
        const foodId = String(args.foodId || '');
        const found = safeInventory.find(
          (i) => i.id === foodId || i.name.toLowerCase() === String(args.foodName || '').toLowerCase()
        );
        if (!found) {
          return { error: `Could not find "${args.foodName}" in active inventory.` };
        }
        const amountUsed = Number(args.amountUsed || 0);
        const unit = String(args.unit || found.unit);
        const markCompletelyUsed = Boolean(args.markCompletelyUsed);
        const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        pendingActions.push({
          actionId,
          type: 'use_food',
          title: markCompletelyUsed ? `Finish ${found.name}` : `Use ${amountUsed} ${unit} of ${found.name}`,
          description: markCompletelyUsed
            ? `Mark ${found.name} (${found.quantity} ${found.unit}) as completely consumed.`
            : `Deduct ${amountUsed} ${unit} from ${found.name} (currently ${found.quantity} ${found.unit}).`,
          requiresConfirmation: true,
          payload: {
            foodId: found.id,
            foodName: found.name,
            amountUsed,
            unit,
            markCompletelyUsed,
          },
        });
        return {
          queuedForConfirmation: true,
          actionId,
          summary: `Prepared confirmation card to update ${found.name}.`,
        };
      }

      if (name === 'propose_increase_food') {
        const foodId = String(args.foodId || '');
        const found = safeInventory.find(
          (i) => i.id === foodId || i.name.toLowerCase() === String(args.foodName || '').toLowerCase()
        );
        if (!found) {
          return { error: `Could not find "${args.foodName}" in inventory.` };
        }
        const amountAdded = Number(args.amountAdded || 0);
        const unit = String(args.unit || found.unit);
        const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        pendingActions.push({
          actionId,
          type: 'increase_food',
          title: `Add ${amountAdded} ${unit} to ${found.name}`,
          description: `Increase ${found.name} from ${found.quantity} ${found.unit} by ${amountAdded} ${unit}.`,
          requiresConfirmation: true,
          payload: { foodId: found.id, foodName: found.name, amountAdded, unit },
        });
        return { queuedForConfirmation: true, actionId };
      }

      if (name === 'propose_update_food') {
        const foodId = String(args.foodId || '');
        const found = safeInventory.find(
          (i) => i.id === foodId || i.name.toLowerCase() === String(args.foodName || '').toLowerCase()
        );
        if (!found) {
          return { error: `Could not find "${args.foodName}" in inventory.` };
        }
        const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        pendingActions.push({
          actionId,
          type: 'update_food',
          title: `Update ${found.name}`,
          description: `Modify details for ${found.name}.`,
          requiresConfirmation: true,
          payload: {
            foodId: found.id,
            foodName: found.name,
            newName: args.newName,
            location: args.location,
            expiryDate: args.expiryDate,
            category: args.category,
            notes: args.notes,
          },
        });
        return { queuedForConfirmation: true, actionId };
      }

      if (name === 'propose_delete_food') {
        const foodId = String(args.foodId || '');
        const found = safeInventory.find(
          (i) => i.id === foodId || i.name.toLowerCase() === String(args.foodName || '').toLowerCase()
        );
        if (!found) {
          return { error: `Could not find "${args.foodName}" in inventory.` };
        }
        const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        pendingActions.push({
          actionId,
          type: 'delete_food',
          title: `Delete ${found.name}`,
          description: `Permanently remove ${found.name} (${found.quantity} ${found.unit}) from your inventory.${args.reason ? ` Reason: ${String(args.reason)}` : ''}`,
          requiresConfirmation: true,
          payload: { foodId: found.id, foodName: found.name, reason: args.reason || '' },
        });
        return { queuedForConfirmation: true, actionId };
      }

      if (name === 'propose_create_donation') {
        const expiryDate = String(args.expiryDate || todayStr);
        if (daysBetween(expiryDate, todayStr) < 0) {
          return {
            error:
              'Safety Check Blocked: Expired food cannot be listed for donation. Please advise the user not to donate or consume expired food.',
          };
        }
        const foodName = String(args.foodName || '').trim();
        const qty = Number(args.quantity || 1);
        const unit = String(args.unit || 'pcs');
        const matched = safeInventory.find(
          (i) => i.id === args.foodId || i.name.toLowerCase() === foodName.toLowerCase()
        );
        if (matched && daysBetween(matched.expiryDate, todayStr) < 0) {
          return {
            error: `Safety Check Blocked: ${matched.name} expired on ${matched.expiryDate} and cannot be donated.`,
          };
        }

        const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        pendingActions.push({
          actionId,
          type: 'create_donation',
          title: `Publish Donation: ${foodName}`,
          description: `List ${qty} ${unit} of ${foodName} (expires ${expiryDate}) on the Charity Dashboard.`,
          requiresConfirmation: true,
          payload: {
            foodId: matched?.id || 'standalone',
            foodName,
            quantity: qty,
            unit,
            category: String(args.category || matched?.category || 'Other'),
            expiryDate,
            pickupLocation: String(args.pickupLocation || 'Home Porch / Community Dropoff'),
            contactInfo: String(args.contactInfo || 'Available via Zero Crumbs account'),
            notes: String(args.notes || 'Sealed and safe surplus food'),
          },
        });
        return { queuedForConfirmation: true, actionId };
      }

      if (name === 'propose_update_donation_status') {
        const donationId = String(args.donationId || '');
        const found = safeDonations.find(
          (d) =>
            d.id === donationId ||
            d.foodName.toLowerCase() === String(args.foodName || '').toLowerCase()
        );
        if (!found) {
          return { error: `Could not find donation listing for "${args.foodName}".` };
        }
        if (found.status === 'Donated' || found.status === 'Cancelled') {
          return { error: `This donation is already ${found.status} and cannot be changed.` };
        }
        const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        pendingActions.push({
          actionId,
          type: 'update_donation_status',
          title: `Update Donation: ${found.foodName} → ${args.newStatus}`,
          description: `Change status of ${found.foodName} from ${found.status} to ${args.newStatus}.`,
          requiresConfirmation: true,
          payload: {
            donationId: found.id,
            foodName: found.foodName,
            newStatus: String(args.newStatus),
            charityPartner: args.charityPartner || found.charityPartner || '',
          },
        });
        return { queuedForConfirmation: true, actionId };
      }

      return { error: `Unknown tool: ${name}` };
    }

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

async function startServer() {
  const port = 3000;
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
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Zero Crumbs server running on http://0.0.0.0:${port}`);
  });
}

startServer();
