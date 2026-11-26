import React, { useEffect, useRef, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  RecaptchaVerifier,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signInWithPopup,
  signOut,
  updateProfile,
  type ConfirmationResult,
  type User,
} from 'firebase/auth';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Leaf,
  Mail,
  MailCheck,
  Phone,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { auth } from '../firebase';
import { ensureUserProfile } from '../services/firestoreService';
import { HERO_PANTRY_IMAGE } from '../types';
import { FoodImage } from './FoodImage';

interface AuthScreenProps {
  unverifiedUser: User | null;
  onVerifiedRefresh: () => Promise<void>;
}

type AuthMode = 'login' | 'signup' | 'reset';
type AuthMethod = 'email' | 'phone';

const COUNTRY_CODES: Array<{ code: string; label: string; minDigits: number; maxDigits: number }> = [
  { code: '+91', label: 'India (+91)', minDigits: 10, maxDigits: 10 },
  { code: '+1', label: 'USA / Canada (+1)', minDigits: 10, maxDigits: 10 },
  { code: '+44', label: 'United Kingdom (+44)', minDigits: 10, maxDigits: 10 },
  { code: '+971', label: 'UAE (+971)', minDigits: 9, maxDigits: 9 },
  { code: '+65', label: 'Singapore (+65)', minDigits: 8, maxDigits: 8 },
  { code: '+61', label: 'Australia (+61)', minDigits: 9, maxDigits: 9 },
  { code: '+49', label: 'Germany (+49)', minDigits: 10, maxDigits: 12 },
  { code: '+33', label: 'France (+33)', minDigits: 9, maxDigits: 9 },
  { code: '+81', label: 'Japan (+81)', minDigits: 10, maxDigits: 10 },
  { code: '+55', label: 'Brazil (+55)', minDigits: 10, maxDigits: 11 },
];

const USERNAME_HINT_KEY = 'zc_username_email_hints';
const PENDING_PROFILE_KEY = 'zc_pending_signup_meta';

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

export function savePendingSignupMeta(
  uid: string,
  meta: { fullName?: string; username?: string; phoneNumber?: string }
) {
  try {
    window.sessionStorage.setItem(`${PENDING_PROFILE_KEY}_${uid}`, JSON.stringify(meta));
  } catch {
    // Ignore
  }
}

export function consumePendingSignupMeta(
  uid: string
): { fullName?: string; username?: string; phoneNumber?: string } | undefined {
  try {
    const key = `${PENDING_PROFILE_KEY}_${uid}`;
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return undefined;
    window.sessionStorage.removeItem(key);
    return JSON.parse(raw) as { fullName?: string; username?: string; phoneNumber?: string };
  } catch {
    return undefined;
  }
}

export function AuthScreen({ unverifiedUser, onVerifiedRefresh }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [method, setMethod] = useState<AuthMethod>('email');

  const [identifier, setIdentifier] = useState('');
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [countryCode, setCountryCode] = useState('+91');
  const [phoneDigits, setPhoneDigits] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Real Firebase Phone OTP verification state
  const [otpConfirmation, setOtpConfirmation] = useState<ConfirmationResult | null>(null);
  const [otpTargetPhone, setOtpTargetPhone] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [resendSeconds, setResendSeconds] = useState(0);
  const [pendingPhoneSignup, setPendingPhoneSignup] = useState<{
    fullName: string;
    username: string;
    email: string;
  } | null>(null);

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');
  const [needsConsoleEmailSetup, setNeedsConsoleEmailSetup] = useState(false);
  const [needsConsolePhoneSetup, setNeedsConsolePhoneSetup] = useState(false);

  const recaptchaRef = useRef<RecaptchaVerifier | null>(null);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const id = window.setTimeout(() => setResendSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [resendSeconds]);

  useEffect(() => {
    return () => {
      if (recaptchaRef.current) {
        try {
          recaptchaRef.current.clear();
        } catch {
          // Ignore cleanup errors
        }
        recaptchaRef.current = null;
      }
    };
  }, []);

  function resetConsoleNotices() {
    setNeedsConsoleEmailSetup(false);
    setNeedsConsolePhoneSetup(false);
  }

  function clearOtpFlow() {
    setOtpConfirmation(null);
    setOtpTargetPhone('');
    setOtpCode('');
    setResendSeconds(0);
    setPendingPhoneSignup(null);
  }

  function formatPhoneE164(): { e164: string; error?: string } {
    const digits = phoneDigits.replace(/\D/g, '');
    const selectedCountry = COUNTRY_CODES.find((c) => c.code === countryCode);
    if (!digits) {
      return { e164: '', error: 'Please enter your phone number.' };
    }
    if (selectedCountry) {
      if (digits.length < selectedCountry.minDigits || digits.length > selectedCountry.maxDigits) {
        const expected =
          selectedCountry.minDigits === selectedCountry.maxDigits
            ? `${selectedCountry.minDigits} digits`
            : `${selectedCountry.minDigits}–${selectedCountry.maxDigits} digits`;
        return {
          e164: '',
          error: `Please enter a valid ${expected} phone number for ${selectedCountry.label}.`,
        };
      }
    } else if (digits.length < 7 || digits.length > 15) {
      return { e164: '', error: 'Please enter a valid phone number (7–15 digits).' };
    }
    return { e164: `${countryCode}${digits}` };
  }

  function mapAuthError(err: unknown, context: 'email' | 'phone' = 'email'): string {
    const code = (err as { code?: string })?.code || '';
    const message = err instanceof Error ? err.message : 'Authentication failed.';

    if (code === 'auth/operation-not-allowed') {
      if (context === 'phone') {
        setNeedsConsolePhoneSetup(true);
        return 'Phone Number (SMS OTP) sign-in is not enabled in the Firebase project yet. Enable Phone authentication in Firebase Console to send real OTP SMS messages.';
      }
      setNeedsConsoleEmailSetup(true);
      return 'Email/Password sign-in is not enabled in the Firebase project yet. Enable it in Firebase Console or use Continue with Google below.';
    }
    if (code === 'auth/billing-not-enabled' || code === 'auth/quota-exceeded') {
      setNeedsConsolePhoneSetup(true);
      return 'Firebase SMS delivery could not proceed because Phone Auth SMS quota/billing is not enabled in this Firebase project. Enable Phone Auth in Firebase Console (or configure Firebase test phone numbers for testing).';
    }
    if (code === 'auth/invalid-phone-number') {
      return 'The phone number format is invalid. Please select your country code and enter a valid mobile number.';
    }
    if (code === 'auth/missing-phone-number') {
      return 'Please enter a valid phone number with country code.';
    }
    if (code === 'auth/invalid-verification-code') {
      return 'Incorrect OTP code. Please check the 6-digit SMS code and try again.';
    }
    if (code === 'auth/code-expired') {
      return 'This OTP code has expired. Tap Resend OTP to request a new SMS code.';
    }
    if (code === 'auth/too-many-requests') {
      return 'Too many verification attempts. Please wait a few minutes before requesting another OTP.';
    }
    if (code === 'auth/captcha-check-failed') {
      return 'Security reCAPTCHA check could not be completed. Please try sending the OTP again.';
    }
    if (code === 'auth/invalid-credential' || code === 'auth/wrong-password') {
      return 'Incorrect email or password. Please check your credentials and try again.';
    }
    if (code === 'auth/user-not-found') {
      return 'No account found with those credentials.';
    }
    if (code === 'auth/email-already-in-use') {
      return 'An account with this email already exists. Try signing in instead.';
    }
    if (code === 'auth/weak-password') {
      return 'Please choose a stronger password (at least 6 characters).';
    }
    if (code === 'auth/popup-closed-by-user') {
      return 'Google sign-in popup was closed before finishing.';
    }
    return message;
  }

  async function initFreshRecaptcha(): Promise<RecaptchaVerifier> {
    if (recaptchaRef.current) {
      try {
        recaptchaRef.current.clear();
      } catch {
        // Ignore clear errors
      }
      recaptchaRef.current = null;
    }

    const verifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
      size: 'invisible',
    });
    await verifier.render();
    recaptchaRef.current = verifier;
    return verifier;
  }

  async function sendPhoneOtp(e164Phone: string) {
    const verifier = await initFreshRecaptcha();
    const confirmation = await signInWithPhoneNumber(auth, e164Phone, verifier);
    setOtpConfirmation(confirmation);
    setOtpTargetPhone(e164Phone);
    setOtpCode('');
    setResendSeconds(60);
    setInfoMsg(`A 6-digit verification code was sent via SMS to ${e164Phone}.`);
  }

  async function handleGoogleSignIn() {
    setErrorMsg('');
    setInfoMsg('');
    resetConsoleNotices();
    setLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(auth, provider);
      await ensureUserProfile(cred.user);
    } catch (err) {
      setErrorMsg(mapAuthError(err, 'email'));
    } finally {
      setLoading(false);
    }
  }

  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');
    resetConsoleNotices();

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
      if (cred.user.emailVerified) {
        const profile = await ensureUserProfile(cred.user);
        saveUsernameHint(profile.username, resolvedEmail);
      }
    } catch (err) {
      setErrorMsg(mapAuthError(err, 'email'));
    } finally {
      setLoading(false);
    }
  }

  async function handlePhoneLoginStart(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');
    resetConsoleNotices();

    const { e164, error } = formatPhoneE164();
    if (error) {
      setErrorMsg(error);
      return;
    }

    setLoading(true);
    try {
      setPendingPhoneSignup(null);
      await sendPhoneOtp(e164);
    } catch (err) {
      setErrorMsg(mapAuthError(err, 'phone'));
    } finally {
      setLoading(false);
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');
    resetConsoleNotices();

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

    if (method === 'phone') {
      const { e164, error } = formatPhoneE164();
      if (error) {
        setErrorMsg(error);
        return;
      }
      if (cleanEmail && !cleanEmail.includes('@')) {
        setErrorMsg('Please enter a valid email address or leave email blank for phone signup.');
        return;
      }
      if (password && password.length < 6) {
        setErrorMsg('Optional backup password must be at least 6 characters.');
        return;
      }
      if (password && password !== confirmPassword) {
        setErrorMsg('Passwords do not match.');
        return;
      }

      setLoading(true);
      try {
        setPendingPhoneSignup({
          fullName: cleanFull,
          username: cleanUser,
          email: cleanEmail,
        });
        await sendPhoneOtp(e164);
      } catch (err) {
        setPendingPhoneSignup(null);
        setErrorMsg(mapAuthError(err, 'phone'));
      } finally {
        setLoading(false);
      }
      return;
    }

    // Email registration path
    if (!cleanEmail.includes('@')) {
      setErrorMsg('Please enter a valid email address.');
      return;
    }

    let optionalPhone = '';
    if (phoneDigits.trim()) {
      const phoneCheck = formatPhoneE164();
      if (phoneCheck.error) {
        setErrorMsg(phoneCheck.error);
        return;
      }
      optionalPhone = phoneCheck.e164;
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
      const cred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
      await updateProfile(cred.user, { displayName: cleanFull });
      saveUsernameHint(cleanUser, cleanEmail);
      savePendingSignupMeta(cred.user.uid, {
        fullName: cleanFull,
        username: cleanUser,
        phoneNumber: optionalPhone,
      });

      try {
        await sendEmailVerification(cred.user);
        setInfoMsg(
          `Verification link sent to ${cleanEmail}. Please verify your email to unlock your private Zero Crumbs workspace.`
        );
      } catch {
        setInfoMsg('Account created. Please verify your email address to continue.');
      }

      if (cred.user.emailVerified) {
        await ensureUserProfile(cred.user, {
          fullName: cleanFull,
          username: cleanUser,
          phoneNumber: optionalPhone,
        });
      }
    } catch (err) {
      setErrorMsg(mapAuthError(err, 'email'));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!otpConfirmation) return;
    setErrorMsg('');
    setInfoMsg('');

    const cleanOtp = otpCode.replace(/\D/g, '');
    if (cleanOtp.length !== 6) {
      setErrorMsg('Please enter the 6-digit OTP verification code.');
      return;
    }

    setLoading(true);
    try {
      const cred = await otpConfirmation.confirm(cleanOtp);
      if (pendingPhoneSignup) {
        await updateProfile(cred.user, { displayName: pendingPhoneSignup.fullName });
        if (pendingPhoneSignup.email) {
          saveUsernameHint(pendingPhoneSignup.username, pendingPhoneSignup.email);
        }
        await ensureUserProfile(cred.user, {
          fullName: pendingPhoneSignup.fullName,
          username: pendingPhoneSignup.username,
          email: pendingPhoneSignup.email,
          phoneNumber: cred.user.phoneNumber || otpTargetPhone,
        });
      } else {
        await ensureUserProfile(cred.user, {
          phoneNumber: cred.user.phoneNumber || otpTargetPhone,
        });
      }
      clearOtpFlow();
    } catch (err) {
      setErrorMsg(mapAuthError(err, 'phone'));
    } finally {
      setLoading(false);
    }
  }

  async function handleResendOtp() {
    if (!otpTargetPhone || resendSeconds > 0 || loading) return;
    setErrorMsg('');
    setInfoMsg('');
    setLoading(true);
    try {
      await sendPhoneOtp(otpTargetPhone);
    } catch (err) {
      setErrorMsg(mapAuthError(err, 'phone'));
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordReset(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');
    const target = email.trim();
    if (!target.includes('@')) {
      setErrorMsg('Please enter the email address associated with your account.');
      return;
    }
    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, target);
      setInfoMsg(`Password reset instructions sent to ${target}. Check your inbox.`);
    } catch (err) {
      setErrorMsg(mapAuthError(err, 'email'));
    } finally {
      setLoading(false);
    }
  }

  async function handleResendVerification() {
    if (!unverifiedUser) return;
    setErrorMsg('');
    setInfoMsg('');
    setLoading(true);
    try {
      await sendEmailVerification(unverifiedUser);
      setInfoMsg(`Verification email re-sent to ${unverifiedUser.email}.`);
    } catch (err) {
      setErrorMsg(mapAuthError(err, 'email'));
    } finally {
      setLoading(false);
    }
  }

  if (unverifiedUser) {
    return (
      <div className="min-h-screen bg-[#FAF9F6] flex items-center justify-center p-4 sm:p-6">
        <div className="max-w-md w-full bg-white border border-[#E5E7E2] rounded-2xl p-6 sm:p-8">
          <div className="w-12 h-12 rounded-xl bg-[#EEF3EC] text-[#1B4332] flex items-center justify-center mb-5">
            <MailCheck className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-semibold text-[#1A2820] mb-2">Verify your email</h1>
          <p className="text-sm text-[#4F5E55] leading-relaxed mb-6">
            To keep your Zero Crumbs account secure, we sent a verification link to{' '}
            <span className="font-medium text-[#1A2820]">{unverifiedUser.email}</span>. Click the
            link in your inbox, then check your status below.
          </p>

          {errorMsg && (
            <div className="mb-4 p-3 rounded-xl bg-[#FDF2EC] border border-[#F0CFC4] text-sm text-[#9E2F2F]">
              {errorMsg}
            </div>
          )}
          {infoMsg && (
            <div className="mb-4 p-3 rounded-xl bg-[#EEF3EC] border border-[#CFE0D2] text-sm text-[#1B4332]">
              {infoMsg}
            </div>
          )}

          <div className="space-y-3">
            <button
              type="button"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                setErrorMsg('');
                await onVerifiedRefresh();
                setLoading(false);
              }}
              className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
            >
              <RefreshCw className="w-4 h-4" />
              I verified my email — Continue
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={handleResendVerification}
              className="w-full min-h-[44px] py-2.5 px-4 rounded-xl border border-[#DCE0D8] text-[#2D3E33] text-sm font-medium hover:bg-[#F4F5F2] transition-colors cursor-pointer"
            >
              Resend verification email
            </button>
            <button
              type="button"
              onClick={() => signOut(auth)}
              className="w-full min-h-[44px] py-2 text-sm text-[#5A6A60] hover:text-[#1A2820] transition-colors cursor-pointer"
            >
              Sign out and use another account
            </button>
          </div>
        </div>
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
          {/* Persistent invisible reCAPTCHA mount node for Firebase Phone Auth */}
          <div id="recaptcha-container" />

          {otpConfirmation ? (
            /* Dedicated OTP Verification Screen */
            <div className="bg-white border border-[#E5E7E2] rounded-2xl p-6 sm:p-7 space-y-5 shadow-xs">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => {
                    clearOtpFlow();
                    setErrorMsg('');
                    setInfoMsg('');
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[#5A6A60] hover:text-[#1A2820] cursor-pointer min-h-[36px]"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Change phone number
                </button>
                <span className="inline-flex items-center gap-1 text-xs font-medium text-[#1B4332]">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  SMS OTP
                </span>
              </div>

              <div>
                <h2 className="font-display text-xl font-semibold text-[#1A2820] mb-1">
                  Enter verification code
                </h2>
                <p className="text-sm text-[#5A6A60]">
                  Enter the 6-digit SMS code sent to{' '}
                  <strong className="font-mono text-[#1A2820]">{otpTargetPhone}</strong>.
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

              <form onSubmit={handleVerifyOtp} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-[#34443A] mb-1.5">
                    6-Digit OTP Code
                  </label>
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
                  {loading ? 'Verifying OTP...' : pendingPhoneSignup ? 'Verify & Create Account' : 'Verify & Sign In'}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>

              <div className="pt-3 border-t border-[#ECEEE8] flex items-center justify-between gap-2 text-xs">
                <span className="text-[#5A6A60]">Didn’t receive the SMS?</span>
                <button
                  type="button"
                  disabled={resendSeconds > 0 || loading}
                  onClick={() => void handleResendOtp()}
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
                    'Register with your email or phone number to start cutting household food waste.'}
                  {mode === 'reset' && 'Enter your account email and we will send a reset link.'}
                </p>
              </div>

              {mode !== 'reset' && (
                <div className="grid grid-cols-2 gap-1 p-1 bg-[#EFEFE9] rounded-xl mb-4">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('login');
                      setErrorMsg('');
                      setInfoMsg('');
                      resetConsoleNotices();
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
                      setErrorMsg('');
                      setInfoMsg('');
                      resetConsoleNotices();
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

              {mode !== 'reset' && (
                <div className="grid grid-cols-2 gap-2 mb-5">
                  <button
                    type="button"
                    onClick={() => {
                      setMethod('email');
                      setErrorMsg('');
                      setInfoMsg('');
                      resetConsoleNotices();
                    }}
                    className={`min-h-[42px] px-3 py-2 rounded-xl border text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                      method === 'email'
                        ? 'bg-[#EEF3EC] border-[#1B4332] text-[#1B4332]'
                        : 'bg-white border-[#DCE0D8] text-[#4F5E55] hover:bg-[#F4F5F2]'
                    }`}
                  >
                    <Mail className="w-3.5 h-3.5" />
                    {mode === 'login' ? 'Email / Username' : 'Email Signup'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMethod('phone');
                      setErrorMsg('');
                      setInfoMsg('');
                      resetConsoleNotices();
                    }}
                    className={`min-h-[42px] px-3 py-2 rounded-xl border text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                      method === 'phone'
                        ? 'bg-[#EEF3EC] border-[#1B4332] text-[#1B4332]'
                        : 'bg-white border-[#DCE0D8] text-[#4F5E55] hover:bg-[#F4F5F2]'
                    }`}
                  >
                    <Phone className="w-3.5 h-3.5" />
                    Phone (OTP)
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

              {needsConsolePhoneSetup && (
                <div className="mb-5 p-4 rounded-xl bg-[#FBF4E9] border border-[#E7D4B5] text-xs text-[#614721] space-y-1.5">
                  <p className="font-semibold">How to enable Phone Number (SMS OTP) Sign-In:</p>
                  <p>
                    1. Open Firebase Console → <strong>Authentication</strong> →{' '}
                    <strong>Sign-in method</strong> → <strong>Add new provider</strong> →{' '}
                    <strong>Phone</strong>.
                  </p>
                  <p>
                    2. Toggle <strong>Enable</strong>, add your authorized domain, and configure SMS
                    billing or Firebase test phone numbers for instant OTP testing.
                  </p>
                </div>
              )}

              {/* LOGIN: EMAIL / USERNAME + PASSWORD */}
              {mode === 'login' && method === 'email' && (
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
                          setErrorMsg('');
                          setInfoMsg('');
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
                    {loading ? 'Signing in...' : 'Sign In'}
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </form>
              )}

              {/* LOGIN: PHONE NUMBER + OTP */}
              {mode === 'login' && method === 'phone' && (
                <form onSubmit={handlePhoneLoginStart} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-[#34443A] mb-1.5">
                      Phone Number with Country Code
                    </label>
                    <div className="flex gap-2">
                      <select
                        aria-label="Country code"
                        value={countryCode}
                        onChange={(e) => setCountryCode(e.target.value)}
                        className="w-[140px] shrink-0 min-h-[44px] px-2.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-xs font-medium text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                      >
                        {COUNTRY_CODES.map((c) => (
                          <option key={c.code} value={c.code}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="tel"
                        inputMode="tel"
                        value={phoneDigits}
                        onChange={(e) => setPhoneDigits(e.target.value)}
                        placeholder={countryCode === '+91' ? '9876543210' : 'Mobile number'}
                        autoComplete="tel-national"
                        className="flex-1 min-w-0 min-h-[44px] px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm font-mono tabular-nums text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                  >
                    {loading ? 'Sending SMS OTP...' : 'Send Verification OTP'}
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </form>
              )}

              {/* SIGNUP: EMAIL OR PHONE NUMBER */}
              {mode === 'signup' && (
                <form onSubmit={handleSignup} className="space-y-3.5">
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
                      Email Address {method === 'email' ? '*' : '(optional)'}
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

                  <div>
                    <label className="block text-xs font-medium text-[#34443A] mb-1">
                      Phone Number with Country Code {method === 'phone' ? '*' : '(optional)'}
                    </label>
                    <div className="flex gap-2">
                      <select
                        aria-label="Country code"
                        value={countryCode}
                        onChange={(e) => setCountryCode(e.target.value)}
                        className="w-[140px] shrink-0 min-h-[44px] px-2.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-xs font-medium text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                      >
                        {COUNTRY_CODES.map((c) => (
                          <option key={c.code} value={c.code}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="tel"
                        inputMode="tel"
                        value={phoneDigits}
                        onChange={(e) => setPhoneDigits(e.target.value)}
                        placeholder={countryCode === '+91' ? '9876543210' : 'Mobile number'}
                        autoComplete="tel-national"
                        className="flex-1 min-w-0 min-h-[44px] px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm font-mono tabular-nums text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-medium text-[#34443A] mb-1">
                        Password {method === 'email' ? '*' : '(optional)'}
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
                        Confirm Password {method === 'email' ? '*' : '(optional)'}
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
                    {loading
                      ? method === 'phone'
                        ? 'Sending SMS OTP...'
                        : 'Creating account...'
                      : method === 'phone'
                        ? 'Send OTP & Verify Phone'
                        : 'Create Account with Email'}
                    <ArrowRight className="w-4 h-4" />
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
                    className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors cursor-pointer disabled:opacity-60"
                  >
                    {loading ? 'Sending reset link...' : 'Send Password Reset Email'}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setMode('login');
                      setErrorMsg('');
                      setInfoMsg('');
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
