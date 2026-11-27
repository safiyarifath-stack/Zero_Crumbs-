import crypto from 'node:crypto';

export type OtpPurpose = 'signup' | 'verify-existing' | 'otp-verification';

export interface OtpChallengeRecord {
  email: string;
  purpose: OtpPurpose;
  salt: string;
  otpHash: string;
  createdAt: number;
  lastSentAt: number;
  expiresAt: number;
  attempts: number;
}

export interface EmailSendPayload {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type EmailSenderFn = (payload: EmailSendPayload) => Promise<{ provider: string }>;

export class EmailServiceNotConfiguredError extends Error {
  readonly code = 'EMAIL_NOT_CONFIGURED';
  constructor() {
    super(
      'Email verification is temporarily unavailable right now. Please try again in a few minutes or continue with Google.'
    );
  }
}

export class PublicEmailDeliveryError extends Error {
  readonly code = 'EMAIL_DELIVERY_FAILED';
  constructor(message: string) {
    super(message);
  }
}

export const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
export const OTP_RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds
export const OTP_MAX_VERIFY_ATTEMPTS = 5;
export const OTP_REQUEST_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const OTP_MAX_REQUESTS_PER_EMAIL = 5;
export const OTP_MAX_REQUESTS_PER_IP = 15;
export const OTP_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes brute-force lock

const FALLBACK_RUNTIME_SECRET = crypto.randomBytes(32).toString('hex');

function getHmacSecret(): string {
  const configured = process.env.OTP_HMAC_SECRET?.trim();
  return configured && configured.length >= 16 ? configured : FALLBACK_RUNTIME_SECRET;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmailAddress(email: string): boolean {
  if (!email || email.length > 160) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashOtp(salt: string, email: string, purpose: OtpPurpose, otp: string): string {
  return crypto
    .createHmac('sha256', getHmacSecret())
    .update(`${salt}:${email}:${purpose}:${otp}`)
    .digest('hex');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isAllowedAppsScriptUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname === 'script.google.com') {
      return parsed.pathname.startsWith('/macros/') || parsed.pathname.startsWith('/a/macros/');
    }
    return parsed.hostname === 'script.googleusercontent.com';
  } catch {
    return false;
  }
}

export function getEmailDeliveryStatus(): {
  configured: boolean;
  provider: 'apps-script' | 'resend' | null;
} {
  const appsScriptUrl = process.env.APPS_SCRIPT_EMAIL_URL?.trim();
  if (appsScriptUrl && isAllowedAppsScriptUrl(appsScriptUrl)) {
    return { configured: true, provider: 'apps-script' };
  }
  const resendKey = process.env.RESEND_API_KEY?.trim();
  const fromEmail = process.env.REMINDER_FROM_EMAIL?.trim();
  if (resendKey && fromEmail) {
    return { configured: true, provider: 'resend' };
  }
  return {
    configured: false,
    provider: null,
  };
}

export async function defaultSendEmail(payload: EmailSendPayload): Promise<{ provider: string }> {
  const appsScriptUrl = process.env.APPS_SCRIPT_EMAIL_URL?.trim();
  if (appsScriptUrl) {
    if (!isAllowedAppsScriptUrl(appsScriptUrl)) {
      console.error(
        '[EmailOtp] Invalid APPS_SCRIPT_EMAIL_URL format. Expected an https://script.google.com/macros/... Web App URL.'
      );
      throw new PublicEmailDeliveryError(
        'Email verification service is temporarily unavailable. Please try again later.'
      );
    }

    const appsScriptSecret = process.env.APPS_SCRIPT_EMAIL_SECRET?.trim();
    const requestBody: Record<string, string> = {
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      ...(appsScriptSecret ? { secret: appsScriptSecret } : {}),
    };

    const resp = await fetch(appsScriptUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain',
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify(requestBody),
    });

    const rawBody = await resp.text();
    const trimmedBody = rawBody.trim();
    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    const finalUrl = (resp.url || '').toLowerCase();

    if (!resp.ok) {
      console.error(`[EmailOtp] Google Apps Script webhook returned HTTP ${resp.status}.`);
      throw new PublicEmailDeliveryError(
        'Unable to send the verification email right now. Please try again shortly.'
      );
    }

    if (
      finalUrl.includes('accounts.google.com') ||
      contentType.includes('text/html') ||
      /^<!doctype\s+html/i.test(trimmedBody) ||
      /^<html[\s>]/i.test(trimmedBody)
    ) {
      console.error(
        '[EmailOtp] Google Apps Script returned an HTML page instead of JSON. Ensure Web App access is set to "Anyone" and MailApp permissions are authorized.'
      );
      throw new PublicEmailDeliveryError(
        'Unable to deliver the verification email right now. Please try again later.'
      );
    }

    let parsedJson: { ok?: boolean; success?: boolean; error?: string } | null = null;
    try {
      parsedJson = JSON.parse(trimmedBody) as { ok?: boolean; success?: boolean; error?: string };
    } catch {
      parsedJson = null;
    }

    if (parsedJson !== null && typeof parsedJson === 'object') {
      if (parsedJson.ok === false || parsedJson.success === false) {
        console.error(
          '[EmailOtp] Google Apps Script rejected the email request:',
          parsedJson.error || 'Unknown script error'
        );
        throw new PublicEmailDeliveryError(
          'Unable to deliver the verification email right now. Please try again shortly.'
        );
      }
      if (parsedJson.ok === true || parsedJson.success === true) {
        return { provider: 'apps-script' };
      }
    }

    if (/^(ok|sent)$/i.test(trimmedBody)) {
      return { provider: 'apps-script' };
    }

    console.error('[EmailOtp] Google Apps Script returned an unexpected non-JSON response.');
    throw new PublicEmailDeliveryError(
      'Unable to confirm verification email delivery. Please try again shortly.'
    );
  }

  const resendKey = process.env.RESEND_API_KEY?.trim();
  const fromEmail = process.env.REMINDER_FROM_EMAIL?.trim();
  if (resendKey && fromEmail) {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        from: fromEmail,
        to: [payload.to],
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
      }),
    });
    if (!resp.ok) {
      console.error(`[EmailOtp] Resend email delivery failed (HTTP ${resp.status}).`);
      throw new PublicEmailDeliveryError(
        'Unable to send the verification email right now. Please try again shortly.'
      );
    }
    return { provider: 'resend' };
  }

  throw new EmailServiceNotConfiguredError();
}

export class GmailAuthRequiredError extends Error {
  readonly code = 'GMAIL_AUTH_REQUIRED';
  constructor(message: string) {
    super(message);
  }
}

function sanitizeMimeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export async function sendOtpViaGmailApi(
  gmailAccessToken: string,
  payload: EmailSendPayload
): Promise<{ provider: string }> {
  const token = gmailAccessToken.trim();
  if (!token || /[\r\n\s]/.test(token)) {
    throw new GmailAuthRequiredError(
      'Your Gmail connection is missing or invalid. Sign in with Google again to send the verification OTP.'
    );
  }

  const safeTo = sanitizeMimeHeader(payload.to);
  const safeSubject = sanitizeMimeHeader(payload.subject);
  const mimeMessage = [
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    payload.text,
  ].join('\r\n');

  const raw = Buffer.from(mimeMessage, 'utf-8').toString('base64url');
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(12000),
    body: JSON.stringify({ raw }),
  });

  if (resp.status === 401) {
    throw new GmailAuthRequiredError(
      'Your Gmail session expired. Please reconnect with Google to send the verification OTP.'
    );
  }

  if (resp.status === 403) {
    throw new GmailAuthRequiredError(
      'Gmail send permission was not granted. Please reconnect with Google and allow sending verification emails.'
    );
  }

  if (!resp.ok) {
    const errBody = (await resp.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(
      errBody?.error?.message || `Gmail OTP delivery failed (HTTP ${resp.status}).`
    );
  }

  return { provider: 'gmail-oauth' };
}

export class EmailOtpService {
  private challenges = new Map<string, OtpChallengeRecord>();
  private emailSendHistory = new Map<string, number[]>();
  private ipSendHistory = new Map<string, number[]>();
  private lockouts = new Map<string, number>();
  private sender: EmailSenderFn;
  private nowFn: () => number;

  constructor(options?: { sender?: EmailSenderFn; now?: () => number }) {
    this.sender = options?.sender || defaultSendEmail;
    this.nowFn = options?.now || (() => Date.now());
  }

  private challengeKey(email: string, purpose: OtpPurpose): string {
    return `${purpose}:${email}`;
  }

  private pruneWindow(timestamps: number[], now: number): number[] {
    const cutoff = now - OTP_REQUEST_WINDOW_MS;
    return timestamps.filter((t) => t > cutoff);
  }

  private pruneExpired(now: number): void {
    for (const [k, rec] of this.challenges.entries()) {
      if (now > rec.expiresAt) {
        this.challenges.delete(k);
      }
    }
    for (const [k, until] of this.lockouts.entries()) {
      if (now >= until) {
        this.lockouts.delete(k);
      }
    }
    for (const [k, times] of this.emailSendHistory.entries()) {
      const pruned = this.pruneWindow(times, now);
      if (pruned.length === 0) {
        this.emailSendHistory.delete(k);
      } else {
        this.emailSendHistory.set(k, pruned);
      }
    }
    for (const [k, times] of this.ipSendHistory.entries()) {
      const pruned = this.pruneWindow(times, now);
      if (pruned.length === 0) {
        this.ipSendHistory.delete(k);
      } else {
        this.ipSendHistory.set(k, pruned);
      }
    }
  }

  async sendOtp(params: {
    email: string;
    purpose: OtpPurpose;
    fullName?: string;
    ip?: string;
    gmailAccessToken?: string;
  }): Promise<
    | {
        ok: true;
        expiresInSeconds: number;
        resendCooldownSeconds: number;
        provider: string;
      }
    | {
        ok: false;
        status: number;
        code: string;
        error: string;
        retryAfterSeconds?: number;
        missingEmailService?: boolean;
      }
  > {
    const email = normalizeEmail(params.email);
    if (!isValidEmailAddress(email)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_EMAIL',
        error: 'Please enter a valid email address.',
      };
    }

    const now = this.nowFn();
    this.pruneExpired(now);
    const key = this.challengeKey(email, params.purpose);

    // Check brute-force lockout first
    const lockedUntil = this.lockouts.get(key) || 0;
    if (lockedUntil > now) {
      const waitSec = Math.ceil((lockedUntil - now) / 1000);
      return {
        ok: false,
        status: 429,
        code: 'TOO_MANY_ATTEMPTS',
        retryAfterSeconds: waitSec,
        error: `Too many failed verification attempts. Please wait ${Math.ceil(waitSec / 60)} minute(s) before requesting a new code.`,
      };
    }

    // Check 30-second resend cooldown
    const existing = this.challenges.get(key);
    if (existing && now - existing.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((OTP_RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
      return {
        ok: false,
        status: 429,
        code: 'RESEND_COOLDOWN',
        retryAfterSeconds: waitSec,
        error: `Please wait ${waitSec} second${waitSec === 1 ? '' : 's'} before requesting a new verification code.`,
      };
    }

    // Rate limit per email
    const emailTimes = this.pruneWindow(this.emailSendHistory.get(email) || [], now);
    if (emailTimes.length >= OTP_MAX_REQUESTS_PER_EMAIL) {
      const oldest = emailTimes[0];
      const waitSec = Math.max(1, Math.ceil((oldest + OTP_REQUEST_WINDOW_MS - now) / 1000));
      return {
        ok: false,
        status: 429,
        code: 'RATE_LIMITED',
        retryAfterSeconds: waitSec,
        error: 'Too many verification code requests for this email. Please wait a few minutes and try again.',
      };
    }

    // Rate limit per IP
    const ip = (params.ip || 'unknown').trim();
    const ipTimes = this.pruneWindow(this.ipSendHistory.get(ip) || [], now);
    if (ipTimes.length >= OTP_MAX_REQUESTS_PER_IP) {
      const oldest = ipTimes[0];
      const waitSec = Math.max(1, Math.ceil((oldest + OTP_REQUEST_WINDOW_MS - now) / 1000));
      return {
        ok: false,
        status: 429,
        code: 'RATE_LIMITED',
        retryAfterSeconds: waitSec,
        error: 'Too many verification requests from this network. Please wait a few minutes and try again.',
      };
    }

    // Generate cryptographically random 6-digit OTP and hash it
    const otp = crypto.randomInt(100000, 1000000).toString();
    const salt = crypto.randomBytes(16).toString('hex');
    const otpHash = hashOtp(salt, email, params.purpose, otp);

    const safeNameText = (params.fullName || 'there').trim().replace(/[\r\n<>]+/g, ' ').slice(0, 60) || 'there';
    const safeNameHtml = escapeHtml(safeNameText);
    const subject = 'Zero Crumbs — Your 6-digit email verification code';
    const text = `Hello ${safeNameText},\n\nYour Zero Crumbs email verification code is: ${otp}\n\nThis code expires in 5 minutes. If you did not request this verification code, you can safely ignore this email.\n\nSave Food. Reduce Waste. Share Goodness.\n— Zero Crumbs`;
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #FAF9F6; color: #1A2820; border-radius: 16px; border: 1px solid #E5E7E2;">
        <h2 style="margin: 0 0 12px; color: #1B4332; font-size: 20px;">Zero Crumbs Verification</h2>
        <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5;">Hello ${safeNameHtml}, enter the 6-digit code below to verify your email address:</p>
        <div style="background: #FFFFFF; border: 1px solid #DCE0D8; border-radius: 12px; padding: 16px; text-align: center; margin-bottom: 16px;">
          <span style="font-family: monospace; font-size: 28px; font-weight: 700; letter-spacing: 8px; color: #1B4332;">${otp}</span>
        </div>
        <p style="margin: 0 0 8px; font-size: 12px; color: #5A6A60;">This verification code expires in <strong>5 minutes</strong>.</p>
        <p style="margin: 0; font-size: 12px; color: #6B7A70;">Save Food. Reduce Waste. Share Goodness.</p>
      </div>
    `;

    try {
      const sent =
        params.gmailAccessToken && params.gmailAccessToken.trim()
          ? await sendOtpViaGmailApi(params.gmailAccessToken, { to: email, subject, text, html })
          : await this.sender({ to: email, subject, text, html });
      this.challenges.set(key, {
        email,
        purpose: params.purpose,
        salt,
        otpHash,
        createdAt: now,
        lastSentAt: now,
        expiresAt: now + OTP_EXPIRY_MS,
        attempts: 0,
      });
      emailTimes.push(now);
      ipTimes.push(now);
      this.emailSendHistory.set(email, emailTimes);
      this.ipSendHistory.set(ip, ipTimes);

      return {
        ok: true,
        expiresInSeconds: Math.round(OTP_EXPIRY_MS / 1000),
        resendCooldownSeconds: Math.round(OTP_RESEND_COOLDOWN_MS / 1000),
        provider: sent.provider,
      };
    } catch (err) {
      if (err instanceof GmailAuthRequiredError) {
        return {
          ok: false,
          status: 401,
          code: 'GMAIL_AUTH_REQUIRED',
          error: err.message,
        };
      }
      if (err instanceof EmailServiceNotConfiguredError) {
        console.error(
          '[EmailOtp] Email delivery is not configured on the server (set APPS_SCRIPT_EMAIL_URL).'
        );
        return {
          ok: false,
          status: 503,
          code: 'EMAIL_NOT_CONFIGURED',
          missingEmailService: true,
          error: err.message,
        };
      }
      if (err instanceof PublicEmailDeliveryError) {
        return {
          ok: false,
          status: 502,
          code: 'EMAIL_DELIVERY_FAILED',
          error: err.message,
        };
      }
      console.error(
        '[EmailOtp] Unexpected email delivery error:',
        err instanceof Error ? err.message : 'Unknown error'
      );
      return {
        ok: false,
        status: 502,
        code: 'EMAIL_DELIVERY_FAILED',
        error: 'Could not send verification email right now. Please try again shortly.',
      };
    }
  }

  verifyOtp(params: {
    email: string;
    otp: string;
    purpose: OtpPurpose;
  }):
    | {
        ok: true;
        otpProofToken: string;
      }
    | {
        ok: false;
        status: number;
        code: string;
        error: string;
        attemptsRemaining?: number;
      } {
    const email = normalizeEmail(params.email);
    const cleanOtp = String(params.otp || '').trim();
    if (!isValidEmailAddress(email)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_EMAIL',
        error: 'Please enter a valid email address.',
      };
    }
    if (!/^\d{6}$/.test(cleanOtp)) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_OTP_FORMAT',
        error: 'Please enter a valid 6-digit numeric verification code.',
      };
    }

    const now = this.nowFn();
    const key = this.challengeKey(email, params.purpose);

    const lockedUntil = this.lockouts.get(key) || 0;
    if (lockedUntil > now) {
      const waitMins = Math.ceil((lockedUntil - now) / 60000);
      return {
        ok: false,
        status: 429,
        code: 'TOO_MANY_ATTEMPTS',
        error: `Verification temporarily locked due to too many incorrect attempts. Try again in ${waitMins} minute(s).`,
      };
    }

    const record = this.challenges.get(key);
    if (!record) {
      return {
        ok: false,
        status: 400,
        code: 'OTP_NOT_FOUND',
        error: 'No active verification code found for this email. Please request a new code.',
      };
    }

    if (now > record.expiresAt) {
      this.challenges.delete(key);
      return {
        ok: false,
        status: 410,
        code: 'OTP_EXPIRED',
        error: 'This verification code has expired (5-minute limit). Please tap Resend OTP for a fresh code.',
      };
    }

    const computed = hashOtp(record.salt, email, params.purpose, cleanOtp);
    const isMatch = crypto.timingSafeEqual(
      Buffer.from(computed, 'hex'),
      Buffer.from(record.otpHash, 'hex')
    );

    if (!isMatch) {
      record.attempts += 1;
      const remaining = Math.max(0, OTP_MAX_VERIFY_ATTEMPTS - record.attempts);
      if (record.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
        this.challenges.delete(key);
        this.lockouts.set(key, now + OTP_LOCKOUT_MS);
        return {
          ok: false,
          status: 429,
          code: 'TOO_MANY_ATTEMPTS',
          attemptsRemaining: 0,
          error:
            'Too many incorrect attempts. Verification has been locked for 15 minutes to protect your account.',
        };
      }
      return {
        ok: false,
        status: 400,
        code: 'OTP_INCORRECT',
        attemptsRemaining: remaining,
        error: `Incorrect verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      };
    }

    // Success: consume challenge so OTP cannot be reused
    this.challenges.delete(key);
    this.lockouts.delete(key);

    const proofPayload = {
      email,
      purpose: params.purpose,
      exp: now + 5 * 60 * 1000,
      nonce: crypto.randomBytes(12).toString('hex'),
    };
    const encodedPayload = Buffer.from(JSON.stringify(proofPayload), 'utf-8').toString('base64url');
    const sig = crypto
      .createHmac('sha256', getHmacSecret())
      .update(encodedPayload)
      .digest('base64url');

    return {
      ok: true,
      otpProofToken: `${encodedPayload}.${sig}`,
    };
  }

  verifyOtpProofToken(token: string, expectedEmail: string): boolean {
    if (!token || typeof token !== 'string' || !token.includes('.')) return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [encodedPayload, sig] = parts;
    if (!encodedPayload || !sig) return false;

    const expectedSig = crypto
      .createHmac('sha256', getHmacSecret())
      .update(encodedPayload)
      .digest('base64url');

    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return false;
    }

    try {
      const payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf-8')
      ) as { email?: string; exp?: number };
      if (!payload.email || !payload.exp) return false;
      if (this.nowFn() > payload.exp) return false;
      return normalizeEmail(payload.email) === normalizeEmail(expectedEmail);
    } catch {
      return false;
    }
  }
}
