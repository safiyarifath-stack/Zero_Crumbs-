import React, { useEffect, useState } from 'react';
import { sendPasswordResetEmail } from 'firebase/auth';
import {
  CheckCircle2,
  Clock,
  KeyRound,
  Loader2,
  LogOut,
  MailCheck,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { auth } from '../firebase';
import { ensureUserProfile } from '../services/firestoreService';
import {
  clearGmailAccessToken,
  connectGmailForOtpWithGoogle,
  getGmailAccessToken,
  subscribeGmailConnection,
} from '../services/gmailService';
import { STORAGE_LOCATIONS, type StorageLocation, type UserProfile } from '../types';
import { ConfirmModal } from './ConfirmModal';

interface ProfileSettingsViewProps {
  profile: UserProfile | null;
  onSaveProfile: (updates: {
    fullName: string;
    username: string;
    householdSize: number;
    defaultLocation: StorageLocation;
    reminderDaysBefore: number;
    browserNotificationsEnabled: boolean;
    emailRemindersEnabled: boolean;
  }) => Promise<void>;
  onRequestLogout: () => void;
}

export function ProfileSettingsView({
  profile,
  onSaveProfile,
  onRequestLogout,
}: ProfileSettingsViewProps) {
  const [fullName, setFullName] = useState(profile?.fullName || '');
  const [username, setUsername] = useState(profile?.username || '');
  const [householdSize, setHouseholdSize] = useState(String(profile?.householdSize ?? 2));
  const [defaultLocation, setDefaultLocation] = useState<StorageLocation>(
    profile?.defaultLocation || 'Fridge'
  );
  const [reminderDaysBefore, setReminderDaysBefore] = useState(
    String(profile?.reminderDaysBefore ?? 3)
  );
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] = useState(
    Boolean(profile?.browserNotificationsEnabled)
  );
  const [emailRemindersEnabled, setEmailRemindersEnabled] = useState(
    Boolean(profile?.emailRemindersEnabled)
  );

  const [saving, setSaving] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Gmail OTP Verification state (send-only scope strictly for 6-digit OTP verification)
  const [gmailConnected, setGmailConnected] = useState(false);
  const [connectingGmail, setConnectingGmail] = useState(false);
  const [otpSendConfirmOpen, setOtpSendConfirmOpen] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [resendSeconds, setResendSeconds] = useState(0);
  const [otpVerifiedNow, setOtpVerifiedNow] = useState(false);
  const [otpNotice, setOtpNotice] = useState('');
  const [otpError, setOtpError] = useState('');

  useEffect(() => {
    return subscribeGmailConnection(setGmailConnected);
  }, []);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const id = window.setTimeout(() => setResendSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [resendSeconds]);

  useEffect(() => {
    if (profile) {
      setFullName(profile.fullName);
      setUsername(profile.username);
      setHouseholdSize(String(profile.householdSize));
      setDefaultLocation(profile.defaultLocation);
      setReminderDaysBefore(String(profile.reminderDaysBefore));
      setBrowserNotificationsEnabled(profile.browserNotificationsEnabled);
      setEmailRemindersEnabled(profile.emailRemindersEnabled);
    }
  }, [profile]);

  const accountEmail = profile?.email || auth.currentUser?.email || '';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSuccessMsg('');
    setErrorMsg('');

    if (!fullName.trim()) {
      setErrorMsg('Full name cannot be empty.');
      return;
    }
    if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(username.trim())) {
      setErrorMsg('Username must be 2–40 characters (letters, numbers, dot, underscore, hyphen).');
      return;
    }

    setSaving(true);
    try {
      await onSaveProfile({
        fullName: fullName.trim(),
        username: username.trim(),
        householdSize: Math.min(20, Math.max(1, Number(householdSize) || 2)),
        defaultLocation,
        reminderDaysBefore: Math.min(14, Math.max(1, Number(reminderDaysBefore) || 3)),
        browserNotificationsEnabled,
        emailRemindersEnabled,
      });
      setSuccessMsg('Account and reminder preferences saved.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not update profile settings.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSendPasswordReset() {
    const email = profile?.email || auth.currentUser?.email;
    if (!email || sendingReset) return;
    setErrorMsg('');
    setSuccessMsg('');
    setSendingReset(true);
    try {
      await sendPasswordResetEmail(auth, email);
      setSuccessMsg(`Password reset email sent to ${email}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to send password reset email.');
    } finally {
      setSendingReset(false);
    }
  }

  async function handleConnectGmailForOtp() {
    setOtpError('');
    setOtpNotice('');
    setConnectingGmail(true);
    try {
      const res = await connectGmailForOtpWithGoogle();
      setOtpNotice(
        `Gmail (${res.email || accountEmail}) connected with send-only access for OTP verification.`
      );
    } catch (err) {
      setOtpError(err instanceof Error ? err.message : 'Could not connect Gmail for OTP sending.');
    } finally {
      setConnectingGmail(false);
    }
  }

  async function handleConfirmSendOtpViaGmail() {
    const currentUser = auth.currentUser;
    const gmailToken = getGmailAccessToken();
    if (!currentUser || !accountEmail) {
      setOtpError('No signed-in email address is available for OTP verification.');
      setOtpSendConfirmOpen(false);
      return;
    }
    if (!gmailToken) {
      setOtpError('Please connect your Gmail account with Google first.');
      setOtpSendConfirmOpen(false);
      return;
    }

    setOtpError('');
    setOtpNotice('');
    setSendingOtp(true);
    try {
      const idToken = await currentUser.getIdToken();
      const resp = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
          'X-Gmail-Access-Token': gmailToken,
        },
        body: JSON.stringify({
          email: accountEmail,
          fullName: profile?.fullName || currentUser.displayName || '',
          purpose: 'otp-verification',
        }),
      });

      const data = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        code?: string;
        retryAfterSeconds?: number;
        resendCooldownSeconds?: number;
      };

      if (!resp.ok) {
        if (data.code === 'GMAIL_AUTH_REQUIRED') {
          clearGmailAccessToken();
        }
        if (typeof data.retryAfterSeconds === 'number' && data.retryAfterSeconds > 0) {
          setResendSeconds((prev) => Math.max(prev, data.retryAfterSeconds || 0));
        }
        throw new Error(data.error || 'Could not send 6-digit verification OTP via Gmail.');
      }

      setOtpSent(true);
      setOtpCode('');
      setOtpVerifiedNow(false);
      setResendSeconds(data.resendCooldownSeconds || 30);
      setOtpNotice(`A 6-digit verification OTP was sent via Gmail to ${accountEmail}.`);
      setOtpSendConfirmOpen(false);
    } catch (err) {
      setOtpError(err instanceof Error ? err.message : 'Failed to send verification OTP.');
      setOtpSendConfirmOpen(false);
    } finally {
      setSendingOtp(false);
    }
  }

  async function handleVerifyOtpCode(e: React.FormEvent) {
    e.preventDefault();
    const currentUser = auth.currentUser;
    if (!currentUser || !accountEmail) return;
    setOtpError('');
    setOtpNotice('');

    const cleanOtp = otpCode.replace(/\D/g, '');
    if (cleanOtp.length !== 6) {
      setOtpError('Enter the 6-digit verification code from your email.');
      return;
    }

    setVerifyingOtp(true);
    try {
      const idToken = await currentUser.getIdToken();
      const resp = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          email: accountEmail,
          otp: cleanOtp,
          purpose: 'otp-verification',
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        otpProofToken?: string;
        error?: string;
      };
      if (!resp.ok || !data.otpProofToken) {
        throw new Error(data.error || 'Incorrect or expired verification code.');
      }

      await ensureUserProfile(currentUser, { emailOtpVerified: true });
      await fetch('/api/auth/confirm-verified', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ otpProofToken: data.otpProofToken }),
      }).catch(() => undefined);

      setOtpVerifiedNow(true);
      setOtpSent(false);
      setOtpCode('');
      setOtpNotice(`Your email (${accountEmail}) has been verified with the 6-digit OTP.`);
    } catch (err) {
      setOtpError(err instanceof Error ? err.message : 'Could not verify OTP code.');
    } finally {
      setVerifyingOtp(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-[#1A2820]">
          Profile & Account Settings
        </h1>
        <p className="text-sm text-[#5A6A60]">
          Manage your private Zero Crumbs household details, expiry reminder schedule, and security.
        </p>
      </div>

      {successMsg && (
        <div className="p-3.5 rounded-xl bg-[#EEF3EC] border border-[#C7DBC9] text-sm text-[#1B4332] flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {errorMsg && (
        <div className="p-3.5 rounded-xl bg-[#FDF2EC] border border-[#EBC6BA] text-sm text-[#9E2F2F]">
          {errorMsg}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="bg-white border border-[#E5E7E2] rounded-2xl p-6 space-y-5"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#34443A] mb-1.5">Full Name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#DCE0D8] text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#34443A] mb-1.5">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#DCE0D8] text-sm"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-[#34443A] mb-1.5">
              Account Email
            </label>
            <input
              type="email"
              value={accountEmail || 'Not linked'}
              disabled
              className="w-full px-3.5 py-2.5 rounded-xl bg-[#F4F5F2] border border-[#E5E7E2] text-sm text-[#5A6A60]"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[#34443A] mb-1.5">
              Household Size
            </label>
            <input
              type="number"
              min={1}
              max={20}
              value={householdSize}
              onChange={(e) => setHouseholdSize(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#DCE0D8] text-sm font-mono tabular-nums"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[#34443A] mb-1.5">
              Default Storage Location
            </label>
            <select
              value={defaultLocation}
              onChange={(e) => setDefaultLocation(e.target.value as StorageLocation)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#DCE0D8] text-sm"
            >
              {STORAGE_LOCATIONS.map((loc) => (
                <option key={loc} value={loc}>
                  {loc}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-[#34443A] mb-1.5">
              Expiry Reminder Window (Days Before Expiry)
            </label>
            <select
              value={reminderDaysBefore}
              onChange={(e) => setReminderDaysBefore(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#DCE0D8] text-sm"
            >
              <option value="1">1 day before expiry</option>
              <option value="2">2 days before expiry</option>
              <option value="3">3 days before expiry (Recommended)</option>
              <option value="5">5 days before expiry</option>
              <option value="7">7 days before expiry</option>
            </select>
          </div>
        </div>

        <div className="pt-4 border-t border-[#ECEEE8] space-y-3">
          <label className="flex items-center justify-between gap-4 cursor-pointer">
            <div>
              <p className="text-sm font-medium text-[#1A2820]">Browser Push Alerts</p>
              <p className="text-xs text-[#5A6A60]">
                Deliver real desktop notifications when items enter your reminder window.
              </p>
            </div>
            <input
              type="checkbox"
              checked={browserNotificationsEnabled}
              onChange={(e) => setBrowserNotificationsEnabled(e.target.checked)}
              className="w-4 h-4 rounded text-[#1B4332]"
            />
          </label>

          <label className="flex items-center justify-between gap-4 cursor-pointer">
            <div>
              <p className="text-sm font-medium text-[#1A2820]">Email Expiry Summaries</p>
              <p className="text-xs text-[#5A6A60]">
                Enable email alerts when server email secrets (RESEND_API_KEY) are configured.
              </p>
            </div>
            <input
              type="checkbox"
              checked={emailRemindersEnabled}
              onChange={(e) => setEmailRemindersEnabled(e.target.checked)}
              className="w-4 h-4 rounded text-[#1B4332]"
            />
          </label>
        </div>

        <div className="pt-4 border-t border-[#ECEEE8] flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2.5 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors inline-flex items-center gap-2 cursor-pointer disabled:opacity-60"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>

      {/* Gmail OTP Verification Section (Send-only for 6-digit OTP verification) */}
      {accountEmail && (
        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5 sm:p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="space-y-1">
              <h2 className="font-display text-base font-semibold text-[#1A2820] flex items-center gap-2">
                <MailCheck className="w-4 h-4 text-[#1B4332]" />
                Gmail OTP Verification
              </h2>
              <p className="text-xs text-[#5A6A60] leading-relaxed">
                Connect Gmail solely to send a 6-digit verification OTP to{' '}
                <strong className="text-[#1A2820]">{accountEmail}</strong>. Zero Crumbs requests
                send-only access and never reads, searches, or modifies your inbox.
              </p>
            </div>

            {(otpVerifiedNow || profile?.emailOtpVerified) && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#EEF3EC] text-[#1B4332] text-xs font-medium shrink-0">
                <ShieldCheck className="w-3.5 h-3.5" />
                OTP Verified
              </span>
            )}
          </div>

          {otpNotice && (
            <div className="p-3 rounded-xl bg-[#EEF3EC] border border-[#C7DBC9] text-xs text-[#1B4332] flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{otpNotice}</span>
            </div>
          )}

          {otpError && (
            <div className="p-3 rounded-xl bg-[#FDF2EC] border border-[#EBC6BA] text-xs text-[#9E2F2F]">
              {otpError}
            </div>
          )}

          {!gmailConnected ? (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <button
                type="button"
                disabled={connectingGmail}
                onClick={() => void handleConnectGmailForOtp()}
                className="inline-flex items-center justify-center gap-2.5 min-h-[42px] px-4 py-2 rounded-md bg-white border border-[#DADCE0] text-xs font-medium text-[#3C4043] hover:bg-[#F8F9FA] transition-colors cursor-pointer disabled:opacity-60 shrink-0"
              >
                {connectingGmail ? (
                  <Loader2 className="w-4 h-4 animate-spin text-[#4285F4]" />
                ) : (
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
                )}
                <span>{connectingGmail ? 'Connecting...' : 'Sign in with Google'}</span>
              </button>
              <span className="text-[11px] text-[#6B7A70]">
                Authorizes Gmail send-only access in memory for this session to deliver OTP codes.
              </span>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={sendingOtp || resendSeconds > 0}
                  onClick={() => setOtpSendConfirmOpen(true)}
                  className="min-h-[42px] px-4 py-2 rounded-xl bg-[#1B4332] text-white text-xs font-medium hover:bg-[#143325] transition-colors inline-flex items-center gap-2 cursor-pointer disabled:opacity-60"
                >
                  {sendingOtp && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {resendSeconds > 0
                    ? `Resend OTP in ${resendSeconds}s`
                    : otpSent
                      ? 'Resend 6-Digit OTP via Gmail'
                      : 'Send 6-Digit OTP via Gmail'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearGmailAccessToken();
                    setOtpSent(false);
                    setOtpNotice('Disconnected Gmail OTP sender from this session.');
                  }}
                  className="min-h-[42px] px-3.5 py-2 rounded-xl border border-[#DCE0D8] text-xs font-medium text-[#5A6A60] hover:bg-[#F4F5F2] cursor-pointer"
                >
                  Disconnect Gmail
                </button>
              </div>

              {otpSent && (
                <form
                  onSubmit={handleVerifyOtpCode}
                  className="p-4 rounded-xl bg-[#FAF9F6] border border-[#E5E7E2] space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-[#34443A]">
                      Enter 6-Digit Verification OTP
                    </label>
                    <span className="inline-flex items-center gap-1 text-[11px] text-[#5A6A60]">
                      <Clock className="w-3 h-3" />
                      Expires in 5 mins
                    </span>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2.5">
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={otpCode}
                      onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="••••••"
                      className="sm:w-48 min-h-[44px] px-4 py-2 rounded-xl bg-white border border-[#DCE0D8] text-center font-mono text-lg tracking-[0.35em] text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
                    />
                    <button
                      type="submit"
                      disabled={verifyingOtp || otpCode.length !== 6}
                      className="min-h-[44px] px-4 py-2 rounded-xl bg-[#1B4332] text-white text-xs font-medium hover:bg-[#143325] inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
                    >
                      {verifyingOtp && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      {verifyingOtp ? 'Verifying...' : 'Verify OTP'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      )}

      {accountEmail && (
        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-semibold text-[#1A2820]">Account Security</h2>
            <p className="text-xs text-[#5A6A60]">
              Send a secure password reset link to your registered email address.
            </p>
          </div>
          <button
            type="button"
            disabled={sendingReset}
            onClick={() => void handleSendPasswordReset()}
            className="min-h-[44px] px-4 py-2.5 rounded-xl border border-[#DCE0D8] text-xs font-medium text-[#1A2820] hover:bg-[#F4F5F2] inline-flex items-center justify-center gap-2 cursor-pointer shrink-0 disabled:opacity-60"
          >
            <KeyRound className="w-3.5 h-3.5" />
            {sendingReset ? 'Sending Reset Email...' : 'Send Password Reset Email'}
          </button>
        </div>
      )}

      <div className="bg-white border border-[#EBC6BA] rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="font-display text-base font-semibold text-[#1A2820]">Account Session</h2>
          <p className="text-xs text-[#5A6A60]">
            End your active Zero Crumbs session on this device. Your food inventory, reminders, and
            donations remain securely saved.
          </p>
        </div>
        <button
          type="button"
          onClick={onRequestLogout}
          className="min-h-[44px] px-5 py-2.5 rounded-xl bg-[#FDF2EC] border border-[#EBC6BA] text-sm font-medium text-[#9E2F2F] hover:bg-[#FAE4DA] transition-colors inline-flex items-center justify-center gap-2 cursor-pointer shrink-0"
        >
          <LogOut className="w-4 h-4" />
          Logout
        </button>
      </div>

      <ConfirmModal
        open={otpSendConfirmOpen}
        title="Send verification OTP via Gmail?"
        message={`Send a 6-digit verification OTP email to ${accountEmail} using your connected Gmail account?`}
        confirmLabel="Send OTP via Gmail"
        loading={sendingOtp}
        onCancel={() => {
          if (!sendingOtp) setOtpSendConfirmOpen(false);
        }}
        onConfirm={() => void handleConfirmSendOtpViaGmail()}
      />
    </div>
  );
}
