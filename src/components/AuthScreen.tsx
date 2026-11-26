import React, { useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Leaf,
  Loader2,
  Mail,
  MailCheck,
  ShieldCheck,
} from 'lucide-react';
import { auth } from '../firebase';
import { ensureUserProfile, getEmailOtpVerifiedStatus } from '../services/firestoreService';
import {
  buildGmailGoogleProvider,
  clearGmailAccessToken,
  connectGmailForOtpWithGoogle,
  getGmailAccessToken,
  setCachedGmailAccessToken,
  subscribeGmailConnection,
} from '../services/gmailService';
import { HERO_PANTRY_IMAGE } from '../types';
import { ConfirmModal } from './ConfirmModal';
import { FoodImage } from './FoodImage';

interface AuthScreenProps {
  unverifiedUser: User | null;
  onVerifiedRefresh: () => Promise<void>;
}

type AuthMode = 'login' | 'signup' | 'reset';

export interface PendingSignupMeta {
  fullName?: string;
  username?: string;
  emailOtpVerified?: boolean;
  otpProofToken?: string;
}

interface PendingOtpSignupState {
  fullName: string;
  username: string;
  email: string;
  password: string;
  expiresInSeconds: number;
}

const USERNAME_HINT_KEY = 'zc_username_email_hints';
const PENDING_EMAIL_META_PREFIX = 'zc_pending_signup_meta_email_';

function normalizeEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

function saveUsernameHint(username: string, email: string) {
  try {
    const cleanUser = username.trim().toLowerCase();
    const cleanEmail = email.trim();
    if (!cleanUser || !cleanEmail.includes('@')) return;
    const raw = window.localStorage.getItem(USERNAME_HINT_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    map[cleanUser] = cleanEmail;
    window.localStorage.setItem(USERNAME_HINT_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

function lookupUsernameHint(username: string): string | null {
  try {
    const raw = window.localStorage.getItem(USERNAME_HINT_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, string>;
    return map[username.trim().toLowerCase()] || null;
  } catch {
    return null;
  }
}

export function savePendingSignupMetaByEmail(email: string, meta: PendingSignupMeta) {
  try {
    const clean = normalizeEmailKey(email);
    if (!clean) return;
    window.sessionStorage.setItem(`${PENDING_EMAIL_META_PREFIX}${clean}`, JSON.stringify(meta));
  } catch {
    // Ignore storage errors
  }
}

export function peekPendingSignupMetaByEmail(email: string | null | undefined): PendingSignupMeta | undefined {
  try {
    if (!email) return undefined;
    const key = `${PENDING_EMAIL_META_PREFIX}${normalizeEmailKey(email)}`;
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as PendingSignupMeta;
  } catch {
    return undefined;
  }
}

export function consumePendingSignupMetaByEmail(email: string | null | undefined): PendingSignupMeta | undefined {
  try {
    if (!email) return undefined;
    const key = `${PENDING_EMAIL_META_PREFIX}${normalizeEmailKey(email)}`;
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return undefined;
    window.sessionStorage.removeItem(key);
    return JSON.parse(raw) as PendingSignupMeta;
  } catch {
    return undefined;
  }
}

export function AuthScreen({ unverifiedUser, onVerifiedRefresh }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login');

  const [identifier, setIdentifier] = useState('');
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Email OTP verification state (Signup + Unverified existing account)
  const [pendingOtpSignup, setPendingOtpSignup] = useState<PendingOtpSignupState | null>(null);
  const [existingOtpSent, setExistingOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [resendSeconds, setResendSeconds] = useState(0);

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');
  const [needsConsoleEmailSetup, setNeedsConsoleEmailSetup] = useState(false);
  const [needsEmailDeliverySetup, setNeedsEmailDeliverySetup] = useState(false);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailOtpConfirmOpen, setGmailOtpConfirmOpen] = useState(false);

  useEffect(() => {
    return subscribeGmailConnection(setGmailConnected);
  }, []);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const id = window.setTimeout(() => setResendSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [resendSeconds]);

  useEffect(() => {
    setExistingOtpSent(false);
    setOtpCode('');
    setResendSeconds(0);
    setErrorMsg('');
    setInfoMsg('');
    setNeedsEmailDeliverySetup(false);
  }, [unverifiedUser?.uid]);

  function resetNotices() {
    setErrorMsg('');
    setInfoMsg('');
    setNeedsConsoleEmailSetup(false);
    setNeedsEmailDeliverySetup(false);
  }

  function clearOtpFlow() {
    setPendingOtpSignup(null);
    setOtpCode('');
    setResendSeconds(0);
    setNeedsEmailDeliverySetup(false);
  }

  function mapAuthError(err: unknown): string {
    const code = (err as { code?: string })?.code || '';
    const message = err instanceof Error ? err.message : 'Authentication failed.';

    if (code === 'auth/operation-not-allowed') {
      setNeedsConsoleEmailSetup(true);
      return 'Email/Password sign-in is not enabled in the Firebase project yet. Enable it in Firebase Console or use Continue with Google below.';
    }
    if (code === 'auth/too-many-requests') {
      return 'Too many authentication attempts. Please wait a few minutes and try again.';
    }
    if (code === 'auth/invalid-credential' || code === 'auth/wrong-password') {
      return 'Incorrect email or password. Please check your credentials and try again.';
    }
    if (code === 'auth/user-not-found') {
      return 'No account found with those credentials.';
    }
    if (code === 'auth/email-already-in-use') {
      return 'An account with this email already exists. Please sign in with your password instead.';
    }
    if (code === 'auth/weak-password') {
      return 'Please choose a stronger password (at least 6 characters).';
    }
    if (code === 'auth/popup-blocked') {
      return 'Sign-in popup was blocked by your browser. Please allow popups for this site and try again.';
    }
    if (code === 'auth/cancelled-popup-request' || code === 'auth/popup-closed-by-user') {
      return 'Google sign-in popup was closed before finishing.';
    }
    if (code === 'auth/account-exists-with-different-credential') {
      return 'An account already exists with this email using a different sign-in method. Please sign in with that method first.';
    }
    if (code === 'auth/unauthorized-domain') {
      return 'This domain is not authorized for Firebase sign-in yet. Add this app domain under Firebase Console → Authentication → Settings → Authorized domains.';
    }
    if (code === 'auth/network-request-failed') {
      return 'Network error while contacting Firebase Authentication. Please check your internet connection and try again.';
    }
    if (code === 'auth/invalid-email') {
      return 'Please enter a valid email address.';
    }
    if (code === 'auth/user-disabled') {
      return 'This account has been disabled. Please contact support for assistance.';
    }
    return message;
  }

  async function requestEmailOtp(
    targetEmail: string,
    targetName: string,
    purpose: 'signup' | 'verify-existing'
  ): Promise<{ ok: boolean; expiresInSeconds: number }> {
    const gmailToken = getGmailAccessToken();
    const resp = await fetch('/api/auth/send-otp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(gmailToken ? { 'X-Gmail-Access-Token': gmailToken } : {}),
      },
      body: JSON.stringify({
        email: targetEmail,
        fullName: targetName,
        purpose,
      }),
    });

    const data = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
      resendCooldownSeconds?: number;
      expiresInSeconds?: number;
      missingEmailService?: boolean;
    };

    if (!resp.ok) {
      if (data.code === 'GMAIL_AUTH_REQUIRED') {
        clearGmailAccessToken();
      }
      if (data.missingEmailService) {
        setNeedsEmailDeliverySetup(true);
      }
      if (typeof data.retryAfterSeconds === 'number' && data.retryAfterSeconds > 0) {
        setResendSeconds((prev) => Math.max(prev, data.retryAfterSeconds || 0));
      }
      throw new Error(data.error || 'Could not send verification OTP email.');
    }

    setResendSeconds(data.resendCooldownSeconds || 30);
    return {
      ok: true,
      expiresInSeconds: data.expiresInSeconds || 300,
    };
  }

  async function handleGoogleSignIn() {
    resetNotices();
    setLoading(true);
    try {
      const provider = buildGmailGoogleProvider();
      const cred = await signInWithPopup(auth, provider);
      const oauthCred = GoogleAuthProvider.credentialFromResult(cred);
      setCachedGmailAccessToken(cred.user, oauthCred?.accessToken);
      await ensureUserProfile(cred.user);
    } catch (err) {
      setErrorMsg(mapAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault();
    resetNotices();

    const trimmed = identifier.trim();
    if (!trimmed) {
      setErrorMsg('Please enter your email address or username.');
      return;
    }

    let resolvedEmail = trimmed;
    if (!trimmed.includes('@')) {
      const hinted = lookupUsernameHint(trimmed);
      if (!hinted) {
        setErrorMsg(
          'Username lookup is not cached on this browser yet. Please enter your account email address to sign in securely.'
        );
        return;
      }
      resolvedEmail = hinted;
    }

    if (!password) {
      setErrorMsg('Please enter your password.');
      return;
    }

    setLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, resolvedEmail, password);
      const isVerified =
        cred.user.emailVerified || (await getEmailOtpVerifiedStatus(cred.user.uid));
      if (isVerified) {
        const profile = await ensureUserProfile(cred.user);
        saveUsernameHint(profile.username, resolvedEmail);
      }
    } catch (err) {
      setErrorMsg(mapAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleSignupStart(e: React.FormEvent) {
    e.preventDefault();
    resetNotices();

    const cleanFull = fullName.trim();
    const cleanUser = username.trim();
    const cleanEmail = email.trim();

    if (cleanFull.length < 2) {
      setErrorMsg('Please enter your full name.');
      return;
    }
    if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(cleanUser)) {
      setErrorMsg(
        'Username must be 2–40 characters using letters, numbers, dots, underscores, or hyphens.'
      );
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setErrorMsg('Please enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      setErrorMsg('Password must be at least 6 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setErrorMsg('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const { expiresInSeconds } = await requestEmailOtp(cleanEmail, cleanFull, 'signup');
      setPendingOtpSignup({
        fullName: cleanFull,
        username: cleanUser,
        email: cleanEmail,
        password,
        expiresInSeconds,
      });
      setOtpCode('');
      setInfoMsg(
        `We sent a 6-digit verification code to ${cleanEmail}. Enter it within 5 minutes to create your account.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to send verification OTP.');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifySignupOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingOtpSignup) return;
    resetNotices();

    const cleanOtp = otpCode.replace(/\D/g, '');
    if (cleanOtp.length !== 6) {
      setErrorMsg('Please enter the 6-digit verification code from your email.');
      return;
    }

    setLoading(true);
    try {
      const verifyResp = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: pendingOtpSignup.email,
          otp: cleanOtp,
          purpose: 'signup',
        }),
      });
      const verifyData = (await verifyResp.json().catch(() => ({}))) as {
        ok?: boolean;
        otpProofToken?: string;
        error?: string;
      };

      if (!verifyResp.ok || !verifyData.otpProofToken) {
        throw new Error(verifyData.error || 'OTP verification failed. Please check the code and try again.');
      }

      const otpProofToken = verifyData.otpProofToken;

      // Save pending profile metadata BEFORE creating Firebase Auth user so App.tsx onAuthStateChanged
      // immediately knows this signup completed Email OTP verification.
      saveUsernameHint(pendingOtpSignup.username, pendingOtpSignup.email);
      savePendingSignupMetaByEmail(pendingOtpSignup.email, {
        fullName: pendingOtpSignup.fullName,
        username: pendingOtpSignup.username,
        emailOtpVerified: true,
        otpProofToken,
      });

      try {
        const cred = await createUserWithEmailAndPassword(
          auth,
          pendingOtpSignup.email,
          pendingOtpSignup.password
        );
        await updateProfile(cred.user, { displayName: pendingOtpSignup.fullName });
        await ensureUserProfile(cred.user, {
          fullName: pendingOtpSignup.fullName,
          username: pendingOtpSignup.username,
          email: pendingOtpSignup.email,
          emailOtpVerified: true,
        });

        try {
          const idToken = await cred.user.getIdToken();
          await fetch('/api/auth/confirm-verified', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({ otpProofToken }),
          });
        } catch {
          // Non-fatal; Firestore profile emailOtpVerified is already persisted
        }

        clearOtpFlow();
        await onVerifiedRefresh();
      } catch (firebaseErr) {
        consumePendingSignupMetaByEmail(pendingOtpSignup.email);
        const mapped = mapAuthError(firebaseErr);
        const code = (firebaseErr as { code?: string })?.code;
        if (code === 'auth/email-already-in-use') {
          clearOtpFlow();
          setMode('login');
          setIdentifier(pendingOtpSignup.email);
        }
        setErrorMsg(mapped);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not verify OTP.');
    } finally {
      setLoading(false);
    }
  }

  async function handleResendSignupOtp() {
    if (!pendingOtpSignup || resendSeconds > 0 || loading) return;
    resetNotices();
    setLoading(true);
    try {
      await requestEmailOtp(pendingOtpSignup.email, pendingOtpSignup.fullName, 'signup');
      setOtpCode('');
      setInfoMsg(`A new 6-digit verification code was sent to ${pendingOtpSignup.email}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not resend OTP.');
    } finally {
      setLoading(false);
    }
  }

  async function executeSendExistingVerificationOtp() {
    if (!unverifiedUser?.email || resendSeconds > 0 || loading) return;
    resetNotices();
    setLoading(true);
    try {
      await requestEmailOtp(
        unverifiedUser.email,
        unverifiedUser.displayName || '',
        'verify-existing'
      );
      setExistingOtpSent(true);
      setOtpCode('');
      setInfoMsg(
        `A 6-digit verification code has been sent to ${unverifiedUser.email}. It expires in 5 minutes.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not send verification OTP.');
    } finally {
      setLoading(false);
    }
  }

  function handleRequestExistingVerificationOtp() {
    if (getGmailAccessToken()) {
      setGmailOtpConfirmOpen(true);
    } else {
      void executeSendExistingVerificationOtp();
    }
  }

  async function handleConnectGmailOnUnverifiedScreen() {
    resetNotices();
    setLoading(true);
    try {
      const res = await connectGmailForOtpWithGoogle();
      setInfoMsg(
        `Gmail (${res.email || 'Google account'}) connected with send-only access. Click "Send 6-Digit Email OTP" to send your verification code.`
      );
    } catch (err) {
      setErrorMsg(mapAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyExistingOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!unverifiedUser?.email) return;
    resetNotices();

    const cleanOtp = otpCode.replace(/\D/g, '');
    if (cleanOtp.length !== 6) {
      setErrorMsg('Please enter the 6-digit verification code sent to your email.');
      return;
    }

    setLoading(true);
    try {
      const verifyResp = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: unverifiedUser.email,
          otp: cleanOtp,
          purpose: 'verify-existing',
        }),
      });
      const verifyData = (await verifyResp.json().catch(() => ({}))) as {
        ok?: boolean;
        otpProofToken?: string;
        error?: string;
      };

      if (!verifyResp.ok || !verifyData.otpProofToken) {
        throw new Error(verifyData.error || 'Incorrect or expired verification code.');
      }

      await ensureUserProfile(unverifiedUser, {
        emailOtpVerified: true,
      });

      try {
        const idToken = await unverifiedUser.getIdToken();
        await fetch('/api/auth/confirm-verified', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ otpProofToken: verifyData.otpProofToken }),
        });
      } catch {
        // Non-fatal; Firestore profile emailOtpVerified is saved
      }

      await onVerifiedRefresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not verify email OTP.');
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordReset(e: React.FormEvent) {
    e.preventDefault();
    resetNotices();
    const target = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
      setErrorMsg('Please enter a valid email address associated with your account.');
      return;
    }
    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, target);
      setInfoMsg(`Password reset instructions sent to ${target}. Check your inbox.`);
    } catch (err) {
      setErrorMsg(mapAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  if (unverifiedUser) {
    return (
      <div className="min-h-screen bg-[#FAF9F6] flex items-center justify-center p-4 sm:p-6">
        <div className="max-w-md w-full bg-white border border-[#E5E7E2] rounded-2xl p-6 sm:p-8 space-y-5 shadow-xs">
          <div className="w-12 h-12 rounded-xl bg-[#EEF3EC] text-[#1B4332] flex items-center justify-center">
            <MailCheck className="w-6 h-6" />
          </div>

          <div>
            <h1 className="font-display text-2xl font-semibold text-[#1A2820] mb-2">
              Verify your email via OTP
            </h1>
            <p className="text-sm text-[#4F5E55] leading-relaxed">
              Only verified accounts can access your private Zero Crumbs workspace. Send a 6-digit
              OTP verification code to{' '}
              <span className="font-medium text-[#1A2820]">{unverifiedUser.email}</span> to unlock
              your account.
            </p>
          </div>

          {errorMsg && (
            <div className="p-3.5 rounded-xl bg-[#FDF2EC] border border-[#F0CFC4] text-sm text-[#9E2F2F]">
              {errorMsg}
            </div>
          )}

          {infoMsg && (
            <div className="p-3.5 rounded-xl bg-[#EEF3EC] border border-[#CFE0D2] text-sm text-[#1B4332] flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{infoMsg}</span>
            </div>
          )}

          {needsEmailDeliverySetup && (
            <div className="p-4 rounded-xl bg-[#FBF4E9] border border-[#E7D4B5] text-xs text-[#614721] space-y-1.5">
              <p className="font-semibold">Email OTP delivery needs server configuration:</p>
              <p>
                Add <code className="font-mono">APPS_SCRIPT_EMAIL_URL</code> (free Google Apps
                Script MailApp) or <code className="font-mono">RESEND_API_KEY</code> +{' '}
                <code className="font-mono">REMINDER_FROM_EMAIL</code> in Google AI Studio{' '}
                <strong>Settings → Secrets</strong>, then restart the server.
              </p>
            </div>
          )}

          {!existingOtpSent ? (
            <div className="space-y-3">
              <button
                type="button"
                disabled={loading || !unverifiedUser.email}
                onClick={handleRequestExistingVerificationOtp}
                className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                {loading ? 'Sending OTP...' : 'Send 6-Digit Email OTP'}
              </button>

              {!gmailConnected && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void handleConnectGmailOnUnverifiedScreen()}
                  className="w-full min-h-[44px] py-2.5 px-4 rounded-md bg-white border border-[#DADCE0] text-sm font-medium text-[#3C4043] hover:bg-[#F8F9FA] transition-colors flex items-center justify-center gap-2.5 cursor-pointer disabled:opacity-60"
                >
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    />
                  </svg>
                  <span>Sign in with Google (Send OTP via Gmail)</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => signOut(auth)}
                className="w-full min-h-[44px] py-2 text-sm text-[#5A6A60] hover:text-[#1A2820] transition-colors cursor-pointer"
              >
                Sign out and use another account
              </button>
            </div>
          ) : (
            <form onSubmit={handleVerifyExistingOtp} className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-medium text-[#34443A]">
                    6-Digit Email OTP
                  </label>
                  <span className="inline-flex items-center gap-1 text-[11px] text-[#5A6A60]">
                    <Clock className="w-3 h-3" />
                    Expires in 5 mins
                  </span>
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  className="w-full min-h-[48px] px-4 py-2.5 rounded-xl bg-[#FAF9F6] border border-[#DCE0D8] text-center font-mono text-xl tracking-[0.4em] text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                />
              </div>

              <button
                type="submit"
                disabled={loading || otpCode.length !== 6}
                className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {loading ? 'Verifying OTP...' : 'Verify Email & Open Workspace'}
                {!loading && <ArrowRight className="w-4 h-4" />}
              </button>

              <div className="pt-3 border-t border-[#ECEEE8] flex items-center justify-between gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => signOut(auth)}
                  className="text-[#5A6A60] hover:text-[#1A2820] cursor-pointer min-h-[36px]"
                >
                  Sign out
                </button>
                <button
                  type="button"
                  disabled={resendSeconds > 0 || loading}
                  onClick={handleRequestExistingVerificationOtp}
                  className="font-medium text-[#1B4332] hover:underline disabled:text-[#6B7A70] disabled:no-underline cursor-pointer disabled:cursor-not-allowed min-h-[36px]"
                >
                  {resendSeconds > 0 ? `Resend OTP in ${resendSeconds}s` : 'Resend OTP'}
                </button>
              </div>
            </form>
          )}
        </div>

        <ConfirmModal
          open={gmailOtpConfirmOpen}
          title="Send verification OTP via Gmail?"
          message={`Send a 6-digit verification code to ${unverifiedUser.email} using your connected Gmail account?`}
          confirmLabel="Send OTP via Gmail"
          loading={loading}
          onCancel={() => {
            if (!loading) setGmailOtpConfirmOpen(false);
          }}
          onConfirm={() => {
            setGmailOtpConfirmOpen(false);
            void executeSendExistingVerificationOtp();
          }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FAF9F6] grid grid-cols-1 lg:grid-cols-12">
      {/* Left Brand & Editorial Showcase */}
      <div className="lg:col-span-6 bg-[#1B3B2B] text-white p-6 sm:p-8 lg:p-14 flex flex-col justify-between relative overflow-hidden">
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-6 lg:mb-10">
            <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center">
              <Leaf className="w-5 h-5 text-[#DCEAD8]" />
            </div>
            <span className="font-display text-xl font-semibold tracking-tight">Zero Crumbs</span>
          </div>

          <h1 className="font-display text-2xl sm:text-3xl lg:text-4xl font-semibold leading-tight text-balance max-w-lg mb-3 lg:mb-4">
            Save Food. Reduce Waste. Share Goodness.
          </h1>
          <p className="text-sm lg:text-base text-[#D3E0D7] max-w-md leading-relaxed mb-6 lg:mb-8">
            Track what sits in your fridge, freezer, and pantry, act before expiry dates pass,
            manage exact remaining quantities, and share safe surplus food with local charities.
          </p>
        </div>

        <div className="hidden sm:block relative z-10 rounded-2xl overflow-hidden border border-white/15 aspect-video mb-8 bg-[#142D20]">
          <FoodImage
            src={HERO_PANTRY_IMAGE}
            alt="Zero Crumbs organized kitchen pantry with fresh produce and glass jars"
            className="w-full h-full object-cover"
          />
        </div>

        <div className="hidden sm:grid relative z-10 grid-cols-3 gap-6 pt-6 border-t border-white/15 text-xs text-[#CBE0D2]">
          <div>
            <p className="font-medium text-white mb-1">Smart Expiry</p>
            <p>Automatic alerts before food spoils</p>
          </div>
          <div>
            <p className="font-medium text-white mb-1">Zero Crumbs AI</p>
            <p>Actionable assistant & recipe helper</p>
          </div>
          <div>
            <p className="font-medium text-white mb-1">Charity Sharing</p>
            <p>Safe surplus donations to neighbors</p>
          </div>
        </div>
      </div>

      {/* Right Authentication Panel */}
      <div className="lg:col-span-6 flex items-center justify-center p-5 sm:p-10 lg:p-14">
        <div className="w-full max-w-md">
          {pendingOtpSignup ? (
            /* Dedicated 6-Digit Email OTP Verification Screen for Signup */
            <div className="bg-white border border-[#E5E7E2] rounded-2xl p-6 sm:p-7 space-y-5 shadow-xs">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => {
                    clearOtpFlow();
                    resetNotices();
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[#5A6A60] hover:text-[#1A2820] cursor-pointer min-h-[36px]"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Edit details
                </button>
                <span className="inline-flex items-center gap-1 text-xs font-medium text-[#1B4332]">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Email OTP
                </span>
              </div>

              <div>
                <h2 className="font-display text-xl font-semibold text-[#1A2820] mb-1">
                  Verify your email address
                </h2>
                <p className="text-sm text-[#5A6A60]">
                  Enter the 6-digit verification code sent to{' '}
                  <strong className="text-[#1A2820] break-all">{pendingOtpSignup.email}</strong>.
                </p>
              </div>

              {errorMsg && (
                <div className="p-3.5 rounded-xl bg-[#FDF2EC] border border-[#EBC6BA] text-sm text-[#9E2F2F]">
                  {errorMsg}
                </div>
              )}

              {infoMsg && (
                <div className="p-3.5 rounded-xl bg-[#EEF3EC] border border-[#C7DBC9] text-sm text-[#1B4332] flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{infoMsg}</span>
                </div>
              )}

              <form onSubmit={handleVerifySignupOtp} className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-medium text-[#34443A]">
                      6-Digit Email OTP Code
                    </label>
                    <span className="inline-flex items-center gap-1 text-[11px] text-[#5A6A60]">
                      <Clock className="w-3 h-3" />
                      Valid for 5 minutes
                    </span>
                  </div>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="••••••"
                    className="w-full min-h-[48px] px-4 py-2.5 rounded-xl bg-[#FAF9F6] border border-[#DCE0D8] text-center font-mono text-xl tracking-[0.4em] text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading || otpCode.length !== 6}
                  className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                >
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {loading ? 'Verifying & creating account...' : 'Verify & Create Account'}
                  {!loading && <ArrowRight className="w-4 h-4" />}
                </button>
              </form>

              <div className="pt-3 border-t border-[#ECEEE8] flex items-center justify-between gap-2 text-xs">
                <span className="text-[#5A6A60]">Didn’t receive the email?</span>
                <button
                  type="button"
                  disabled={resendSeconds > 0 || loading}
                  onClick={() => void handleResendSignupOtp()}
                  className="font-medium text-[#1B4332] hover:underline disabled:text-[#6B7A70] disabled:no-underline cursor-pointer disabled:cursor-not-allowed min-h-[36px]"
                >
                  {resendSeconds > 0 ? `Resend OTP in ${resendSeconds}s` : 'Resend OTP'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-6">
                <h2 className="font-display text-2xl font-semibold text-[#1A2820] mb-1">
                  {mode === 'login' && 'Welcome back to Zero Crumbs'}
                  {mode === 'signup' && 'Create your Zero Crumbs account'}
                  {mode === 'reset' && 'Reset your password'}
                </h2>
                <p className="text-sm text-[#5A6A60]">
                  {mode === 'login' &&
                    'Access your private food inventory, expiry alerts, and charity listings.'}
                  {mode === 'signup' &&
                    'Register with your email and verify with a 6-digit OTP to get started.'}
                  {mode === 'reset' && 'Enter your account email and we will send a reset link.'}
                </p>
              </div>

              {mode !== 'reset' && (
                <div className="grid grid-cols-2 gap-1 p-1 bg-[#EFEFE9] rounded-xl mb-5">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('login');
                      resetNotices();
                    }}
                    className={`min-h-[42px] py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                      mode === 'login'
                        ? 'bg-white text-[#1A2820] shadow-xs'
                        : 'text-[#5A6A60] hover:text-[#1A2820]'
                    }`}
                  >
                    Sign In
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('signup');
                      resetNotices();
                    }}
                    className={`min-h-[42px] py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                      mode === 'signup'
                        ? 'bg-white text-[#1A2820] shadow-xs'
                        : 'text-[#5A6A60] hover:text-[#1A2820]'
                    }`}
                  >
                    Create Account
                  </button>
                </div>
              )}

              {errorMsg && (
                <div className="mb-5 p-3.5 rounded-xl bg-[#FDF2EC] border border-[#EBC6BA] text-sm text-[#9E2F2F]">
                  {errorMsg}
                </div>
              )}

              {infoMsg && (
                <div className="mb-5 p-3.5 rounded-xl bg-[#EEF3EC] border border-[#C7DBC9] text-sm text-[#1B4332] flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{infoMsg}</span>
                </div>
              )}

              {needsConsoleEmailSetup && (
                <div className="mb-5 p-4 rounded-xl bg-[#FBF4E9] border border-[#E7D4B5] text-xs text-[#614721] space-y-1.5">
                  <p className="font-semibold">How to enable Email/Password Sign-In:</p>
                  <p>
                    1. Open your Firebase Console → <strong>Authentication</strong> →{' '}
                    <strong>Sign-in method</strong>.
                  </p>
                  <p>
                    2. Click <strong>Email/Password</strong>, toggle <strong>Enable</strong>, and save.
                  </p>
                  <p>Or use Continue with Google below right now.</p>
                </div>
              )}

              {needsEmailDeliverySetup && (
                <div className="mb-5 p-4 rounded-xl bg-[#FBF4E9] border border-[#E7D4B5] text-xs text-[#614721] space-y-1.5">
                  <p className="font-semibold">Free Email OTP Delivery Setup Required:</p>
                  <p>
                    Configure <code className="font-mono">APPS_SCRIPT_EMAIL_URL</code> (free Google
                    Apps Script <code className="font-mono">MailApp</code>) or{' '}
                    <code className="font-mono">RESEND_API_KEY</code> +{' '}
                    <code className="font-mono">REMINDER_FROM_EMAIL</code> in Google AI Studio{' '}
                    <strong>Settings → Secrets</strong> so real OTP emails can be sent.
                  </p>
                </div>
              )}

              {/* LOGIN: EMAIL / USERNAME + PASSWORD */}
              {mode === 'login' && (
                <form onSubmit={handleEmailLogin} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-[#34443A] mb-1.5">
                      Email or Username
                    </label>
                    <input
                      type="text"
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      placeholder="you@example.com or username"
                      autoComplete="username"
                      className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-xs font-medium text-[#34443A]">Password</label>
                      <button
                        type="button"
                        onClick={() => {
                          setMode('reset');
                          resetNotices();
                        }}
                        className="text-xs font-medium text-[#355E4B] hover:underline cursor-pointer"
                      >
                        Forgot password?
                      </button>
                    </div>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Enter your password"
                        autoComplete="current-password"
                        className="w-full min-h-[44px] px-3.5 py-2.5 pr-11 rounded-xl bg-white border border-[#DCE0D8] text-sm text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-[#6B7A70] hover:text-[#1A2820] cursor-pointer"
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                  >
                    {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                    {loading ? 'Signing in...' : 'Sign In'}
                    {!loading && <ArrowRight className="w-4 h-4" />}
                  </button>
                </form>
              )}

              {/* SIGNUP: EMAIL + 6-DIGIT EMAIL OTP */}
              {mode === 'signup' && (
                <form onSubmit={handleSignupStart} className="space-y-3.5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-medium text-[#34443A] mb-1">
                        Full Name *
                      </label>
                      <input
                        type="text"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        placeholder="Maya Lin"
                        className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#34443A] mb-1">
                        Username *
                      </label>
                      <input
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="mayalin"
                        className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-[#34443A] mb-1">
                      Email Address *
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="maya@example.com"
                      autoComplete="email"
                      className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-medium text-[#34443A] mb-1">
                        Password *
                      </label>
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Min. 6 characters"
                        autoComplete="new-password"
                        className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#34443A] mb-1">
                        Confirm Password *
                      </label>
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Repeat password"
                        autoComplete="new-password"
                        className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                      />
                    </div>
                  </div>

                  <label className="inline-flex items-center gap-2 text-xs text-[#5A6A60] cursor-pointer min-h-[32px]">
                    <input
                      type="checkbox"
                      checked={showPassword}
                      onChange={(e) => setShowPassword(e.target.checked)}
                      className="rounded border-[#DCE0D8] text-[#1B4332]"
                    />
                    Show passwords
                  </label>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                  >
                    {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                    {loading ? 'Sending Verification OTP...' : 'Send 6-Digit Email OTP'}
                    {!loading && <ArrowRight className="w-4 h-4" />}
                  </button>
                </form>
              )}

              {mode === 'reset' && (
                <form onSubmit={handlePasswordReset} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-[#34443A] mb-1.5">
                      Account Email Address
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                  >
                    {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                    {loading ? 'Sending reset link...' : 'Send Password Reset Email'}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setMode('login');
                      resetNotices();
                    }}
                    className="w-full min-h-[40px] py-2 text-sm text-[#5A6A60] hover:text-[#1A2820] transition-colors cursor-pointer"
                  >
                    Back to Sign In
                  </button>
                </form>
              )}

              {mode !== 'reset' && (
                <>
                  <div className="flex items-center gap-3 my-6">
                    <div className="h-px flex-1 bg-[#E5E7E2]" />
                    <span className="text-xs text-[#6B7A70]">or continue instantly</span>
                    <div className="h-px flex-1 bg-[#E5E7E2]" />
                  </div>

                  <button
                    type="button"
                    disabled={loading}
                    onClick={handleGoogleSignIn}
                    className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-white border border-[#DCE0D8] text-sm font-medium text-[#1A2820] hover:bg-[#F4F5F2] transition-colors flex items-center justify-center gap-2.5 cursor-pointer disabled:opacity-60"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="#4285F4"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      />
                    </svg>
                    Continue with Google
                  </button>
                </>
              )}
            </>
          )}

          <p className="mt-7 text-center text-xs text-[#6B7A70]">
            Zero Crumbs — Private, cloud-synced household food management.
          </p>
        </div>
      </div>
    </div>
  );
}
