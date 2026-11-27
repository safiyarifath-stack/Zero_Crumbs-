import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sendPasswordResetEmail } from 'firebase/auth';
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  Clock,
  Info,
  KeyRound,
  Laptop,
  Loader2,
  LogOut,
  Mail,
  MailCheck,
  Mic,
  MicOff,
  Moon,
  Palette,
  RefreshCw,
  Save,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sun,
  User as UserIcon,
  Volume2,
  XCircle,
} from 'lucide-react';
import { auth } from '../firebase';
import { ensureUserProfile } from '../services/firestoreService';
import {
  clearGmailAccessToken,
  connectGmailForOtpWithGoogle,
  getGmailAccessToken,
  subscribeGmailConnection,
} from '../services/gmailService';
import {
  formatMicrophonePermissionError,
  getVoiceEnvironmentDiagnostics,
  getVoiceSupportInfo,
  isMobileOrTouchBrowser,
  logVoiceDiagnostic,
  queryMicrophonePermissionStatus,
  requestMicrophoneStream,
  startMicLevelMonitor,
  stopMediaStream,
  subscribeMicrophonePermissionChange,
  type MicrophonePermissionStatus,
} from '../services/voiceAssistant';
import {
  STORAGE_LOCATIONS,
  type FoodItem,
  type StorageLocation,
  type UserProfile,
} from '../types';
import { getExpiryBucket } from '../utils/foodUtils';
import {
  applyThemePreference,
  getSavedThemePreference,
  resolveEffectiveTheme,
  subscribeSystemThemeChanges,
  type ThemePreference,
} from '../utils/theme';
import { ConfirmModal } from './ConfirmModal';

type SettingsSectionId =
  | 'all'
  | 'microphone'
  | 'account'
  | 'notifications'
  | 'appearance'
  | 'security'
  | 'about';

interface ProfileSettingsViewProps {
  profile: UserProfile | null;
  foods?: FoodItem[];
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

const SECTION_TABS: Array<{ id: SettingsSectionId; label: string; icon: typeof Mic }> = [
  { id: 'all', label: 'All Settings', icon: Shield },
  { id: 'microphone', label: 'Microphone', icon: Mic },
  { id: 'account', label: 'Account', icon: UserIcon },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'security', label: 'Privacy & Security', icon: ShieldCheck },
  { id: 'about', label: 'About', icon: Info },
];

export function ProfileSettingsView({
  profile,
  foods = [],
  onSaveProfile,
  onRequestLogout,
}: ProfileSettingsViewProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('all');

  // Account & Reminder Profile State
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

  const [savingAccount, setSavingAccount] = useState(false);
  const [savingNotifications, setSavingNotifications] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Appearance (Theme) State
  const [themePref, setThemePref] = useState<ThemePreference>(() => getSavedThemePreference());
  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(() =>
    resolveEffectiveTheme(getSavedThemePreference())
  );

  // Real Browser Notification State
  const [browserNotificationPerm, setBrowserNotificationPerm] = useState<string>(() =>
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'unsupported'
  );
  const [notifNotice, setNotifNotice] = useState('');
  const [notifError, setNotifError] = useState('');
  const [emailServiceStatus, setEmailServiceStatus] = useState<{
    loaded: boolean;
    configured: boolean;
  }>({ loaded: false, configured: false });
  const [sendingSummaryEmail, setSendingSummaryEmail] = useState(false);

  // Real Microphone Permission & Live Test State
  const [micStatus, setMicStatus] = useState<MicrophonePermissionStatus>('not_requested');
  const [micStatusSource, setMicStatusSource] = useState<
    'permissions-api' | 'session-fallback' | 'unsupported'
  >('permissions-api');
  const [micChecking, setMicChecking] = useState(true);
  const [micRequesting, setMicRequesting] = useState(false);
  const [micTesting, setMicTesting] = useState(false);
  const [micTestLevel, setMicTestLevel] = useState(0);
  const [micTestPeak, setMicTestPeak] = useState(0);
  const [micTestResult, setMicTestResult] = useState<{
    type: 'success' | 'info' | 'error';
    message: string;
    howToEnable?: string;
  } | null>(null);
  const [micActionError, setMicActionError] = useState<{
    message: string;
    howToEnable: string;
  } | null>(null);

  const sessionMicGrantedRef = useRef(false);
  const sessionMicBlockedRef = useRef(false);
  const testStreamRef = useRef<MediaStream | null>(null);
  const stopMonitorRef = useRef<(() => void) | null>(null);
  const testTimerRef = useRef<number | null>(null);
  const peakLevelRef = useRef(0);

  // Gmail OTP Verification State (send-only for 6-digit OTP verification)
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

  const voiceSupport = getVoiceSupportInfo();
  const voiceEnv = getVoiceEnvironmentDiagnostics();

  const cleanupMicTestResources = useCallback(() => {
    if (testTimerRef.current !== null) {
      window.clearTimeout(testTimerRef.current);
      testTimerRef.current = null;
    }
    if (stopMonitorRef.current) {
      stopMonitorRef.current();
      stopMonitorRef.current = null;
    }
    if (testStreamRef.current) {
      stopMediaStream(testStreamRef.current);
      testStreamRef.current = null;
    }
    setMicTesting(false);
    setMicTestLevel(0);
  }, []);

  const refreshMicrophoneStatus = useCallback(async () => {
    setMicChecking(true);
    const res = await queryMicrophonePermissionStatus({
      sessionGranted: sessionMicGrantedRef.current,
      sessionBlocked: sessionMicBlockedRef.current,
    });
    setMicStatus(res.status);
    setMicStatusSource(res.source);
    setMicChecking(false);
    logVoiceDiagnostic('settings_mic_status_checked', {
      status: res.status,
      source: res.source,
    });
  }, []);

  useEffect(() => {
    void refreshMicrophoneStatus();
    const unsubMic = subscribeMicrophonePermissionChange((nextStatus) => {
      setMicStatus(nextStatus);
      setMicStatusSource('permissions-api');
      if (nextStatus === 'allowed') {
        sessionMicGrantedRef.current = true;
        sessionMicBlockedRef.current = false;
        setMicActionError(null);
      } else if (nextStatus === 'blocked') {
        sessionMicGrantedRef.current = false;
        sessionMicBlockedRef.current = true;
      }
    });
    return () => {
      unsubMic();
      cleanupMicTestResources();
    };
  }, [refreshMicrophoneStatus, cleanupMicTestResources]);

  useEffect(() => {
    const unsubTheme = subscribeSystemThemeChanges(() => {
      if (getSavedThemePreference() === 'system') {
        setEffectiveTheme(applyThemePreference('system', false));
      }
    });
    return unsubTheme;
  }, []);

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

  useEffect(() => {
    let active = true;
    async function loadEmailStatus() {
      const user = auth.currentUser;
      if (!user) return;
      try {
        const token = await user.getIdToken();
        const resp = await fetch('/api/reminders/status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok && active) {
          const data = (await resp.json()) as { emailConfigured?: boolean };
          setEmailServiceStatus({
            loaded: true,
            configured: Boolean(data.emailConfigured),
          });
          return;
        }
      } catch {
        // Ignore non-fatal status check error
      }
      if (active) {
        setEmailServiceStatus({ loaded: true, configured: false });
      }
    }
    void loadEmailStatus();
    return () => {
      active = false;
    };
  }, []);

  const accountEmail = profile?.email || auth.currentUser?.email || '';

  async function handleEnableMicrophone() {
    if (micRequesting || micTesting) return;
    setMicActionError(null);
    setMicTestResult(null);

    if (!voiceEnv.isSecureContext || !voiceEnv.mediaDevicesAvailable) {
      setMicStatus('unsupported');
      setMicActionError({
        message: 'Microphone access is unsupported in this browser or non-HTTPS context.',
        howToEnable:
          'Open Zero Crumbs over HTTPS or localhost in Chrome, Edge, Safari, or Firefox.',
      });
      return;
    }

    setMicRequesting(true);
    try {
      const stream = await requestMicrophoneStream();
      // Immediately release hardware mic stream after confirming genuine browser permission
      stopMediaStream(stream);
      sessionMicGrantedRef.current = true;
      sessionMicBlockedRef.current = false;
      setMicStatus('allowed');
      setMicTestResult({
        type: 'success',
        message:
          'Microphone permission is Allowed. You can now test your audio level below or use Start Voice in Zero Crumbs AI.',
      });
      await refreshMicrophoneStatus();
    } catch (err) {
      const friendly = formatMicrophonePermissionError(err);
      if (friendly.code === 'permission_denied') {
        sessionMicGrantedRef.current = false;
        sessionMicBlockedRef.current = true;
        setMicStatus('blocked');
      } else if (friendly.code === 'insecure_context' || friendly.code === 'unsupported') {
        setMicStatus('unsupported');
      }
      setMicActionError({
        message: friendly.message,
        howToEnable: friendly.howToEnable,
      });
      logVoiceDiagnostic('settings_mic_enable_error', {
        code: friendly.code,
        message: friendly.message,
      });
      await refreshMicrophoneStatus();
    } finally {
      setMicRequesting(false);
    }
  }

  function finishMicTest() {
    const peak = peakLevelRef.current;
    cleanupMicTestResources();
    if (peak >= 0.04) {
      setMicTestResult({
        type: 'success',
        message: `Audio input detected (peak signal ${Math.round(peak * 100)}%). Your microphone stream was released cleanly.`,
      });
    } else {
      setMicTestResult({
        type: 'info',
        message:
          'Microphone access succeeded, but little or no sound was detected during the test. Check your hardware mute switch or input device volume, then test again while speaking.',
      });
    }
  }

  async function handleStartMicTest() {
    if (micTesting) {
      finishMicTest();
      return;
    }
    setMicActionError(null);
    setMicTestResult(null);
    setMicTestPeak(0);
    setMicTestLevel(0);
    peakLevelRef.current = 0;

    if (!voiceEnv.isSecureContext || !voiceEnv.mediaDevicesAvailable) {
      setMicStatus('unsupported');
      setMicActionError({
        message: 'Microphone testing is unavailable in this browser or non-HTTPS context.',
        howToEnable: 'Open Zero Crumbs over HTTPS or localhost in a supported browser.',
      });
      return;
    }

    setMicTesting(true);
    try {
      const stream = await requestMicrophoneStream();
      testStreamRef.current = stream;
      sessionMicGrantedRef.current = true;
      sessionMicBlockedRef.current = false;
      setMicStatus('allowed');

      stopMonitorRef.current = startMicLevelMonitor(stream, (lvl) => {
        setMicTestLevel(lvl);
        if (lvl > peakLevelRef.current) {
          peakLevelRef.current = lvl;
          setMicTestPeak(lvl);
        }
      });

      testTimerRef.current = window.setTimeout(() => {
        finishMicTest();
      }, 4500);
    } catch (err) {
      cleanupMicTestResources();
      const friendly = formatMicrophonePermissionError(err);
      if (friendly.code === 'permission_denied') {
        sessionMicGrantedRef.current = false;
        sessionMicBlockedRef.current = true;
        setMicStatus('blocked');
      } else if (friendly.code === 'insecure_context' || friendly.code === 'unsupported') {
        setMicStatus('unsupported');
      }
      setMicActionError({
        message: friendly.message,
        howToEnable: friendly.howToEnable,
      });
      await refreshMicrophoneStatus();
    }
  }

  async function saveProfileUpdates(nextOverrides?: {
    reminderDaysBefore?: number;
    browserNotificationsEnabled?: boolean;
    emailRemindersEnabled?: boolean;
  }) {
    if (!fullName.trim()) {
      throw new Error('Full name cannot be empty.');
    }
    if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(username.trim())) {
      throw new Error(
        'Username must be 2–40 characters (letters, numbers, dot, underscore, hyphen).'
      );
    }

    await onSaveProfile({
      fullName: fullName.trim(),
      username: username.trim(),
      householdSize: Math.min(20, Math.max(1, Number(householdSize) || 2)),
      defaultLocation,
      reminderDaysBefore: Math.min(
        14,
        Math.max(1, nextOverrides?.reminderDaysBefore ?? (Number(reminderDaysBefore) || 3))
      ),
      browserNotificationsEnabled:
        nextOverrides?.browserNotificationsEnabled ?? browserNotificationsEnabled,
      emailRemindersEnabled: nextOverrides?.emailRemindersEnabled ?? emailRemindersEnabled,
    });
  }

  async function handleSaveAccountSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSuccessMsg('');
    setErrorMsg('');
    setSavingAccount(true);
    try {
      await saveProfileUpdates();
      setSuccessMsg('Account details saved.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not update account settings.');
    } finally {
      setSavingAccount(false);
    }
  }

  async function handleSaveNotificationsSubmit(e: React.FormEvent) {
    e.preventDefault();
    setNotifNotice('');
    setNotifError('');
    setSavingNotifications(true);
    try {
      await saveProfileUpdates();
      setNotifNotice('Food expiry reminder preferences saved.');
    } catch (err) {
      setNotifError(err instanceof Error ? err.message : 'Could not save notification settings.');
    } finally {
      setSavingNotifications(false);
    }
  }

  async function handleRequestBrowserNotifications() {
    setNotifError('');
    setNotifNotice('');
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setBrowserNotificationPerm('unsupported');
      setNotifError('Desktop push notifications are not supported in this browser.');
      return;
    }

    try {
      const perm = await Notification.requestPermission();
      setBrowserNotificationPerm(perm);
      if (perm === 'granted') {
        setBrowserNotificationsEnabled(true);
        await saveProfileUpdates({ browserNotificationsEnabled: true });
        new Notification('Zero Crumbs Notifications Enabled', {
          body: `Expiry alerts are active (${reminderDaysBefore}-day reminder window).`,
        });
        setNotifNotice('Browser notifications granted and a test alert was shown.');
      } else {
        setBrowserNotificationsEnabled(false);
        await saveProfileUpdates({ browserNotificationsEnabled: false });
        setNotifError(
          'Notification permission was not granted. Update Notification permissions in your browser site settings if previously blocked.'
        );
      }
    } catch (err) {
      setNotifError(
        err instanceof Error ? err.message : 'Could not request browser notification permission.'
      );
    }
  }

  async function handleSendExpirySummaryEmail() {
    const user = auth.currentUser;
    if (!user) return;
    setNotifError('');
    setNotifNotice('');
    setSendingSummaryEmail(true);
    try {
      const token = await user.getIdToken();
      const threshold = Math.min(14, Math.max(1, Number(reminderDaysBefore) || 3));
      const expiringItems = foods
        .filter((f) => {
          if (f.status !== 'active') return false;
          const bucket = getExpiryBucket(f.expiryDate, threshold);
          return bucket === 'today' || bucket === 'soon';
        })
        .map((i) => ({
          name: i.name,
          quantity: i.quantity,
          unit: i.unit,
          location: i.location,
          expiryDate: i.expiryDate,
        }));

      const resp = await fetch('/api/reminders/send-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          items: expiringItems,
          reminderDaysBefore: threshold,
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as { error?: string };
      if (!resp.ok) {
        throw new Error(data.error || 'Could not send expiry summary email.');
      }
      setNotifNotice(`Expiry summary email sent to ${accountEmail}.`);
    } catch (err) {
      setNotifError(err instanceof Error ? err.message : 'Failed to send summary email.');
    } finally {
      setSendingSummaryEmail(false);
    }
  }

  function handleSelectTheme(nextPref: ThemePreference) {
    setThemePref(nextPref);
    const nextEffective = applyThemePreference(nextPref, true);
    setEffectiveTheme(nextEffective);
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

  const showSection = (id: Exclude<SettingsSectionId, 'all'>) =>
    activeSection === 'all' || activeSection === id;

  const micStatusBadge = (() => {
    switch (micStatus) {
      case 'allowed':
        return {
          label: 'Allowed',
          icon: CheckCircle2,
          classes:
            'bg-[#EEF3EC] dark:bg-[#1E3328] border-[#C7DBC9] dark:border-[#345C45] text-[#1B4332] dark:text-[#9CE0B8]',
        };
      case 'blocked':
        return {
          label: 'Blocked',
          icon: XCircle,
          classes:
            'bg-[#FDF2EC] dark:bg-[#2B1B18] border-[#EBC6BA] dark:border-[#68372E] text-[#9E2F2F] dark:text-[#F5B0A6]',
        };
      case 'unsupported':
        return {
          label: 'Unsupported',
          icon: ShieldAlert,
          classes:
            'bg-[#FBF4E9] dark:bg-[#2C2418] border-[#E7D4B5] dark:border-[#5D492B] text-[#7A561E] dark:text-[#E8C58E]',
        };
      default:
        return {
          label: 'Not Requested',
          icon: Mic,
          classes:
            'bg-[#F2F4EF] dark:bg-[#1F2C25] border-[#DCE0D8] dark:border-[#31443A] text-[#34443A] dark:text-[#C5D5CC]',
        };
    }
  })();
  const MicBadgeIcon = micStatusBadge.icon;

  const isMobile = isMobileOrTouchBrowser();

  return (
    <div className="max-w-5xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="font-display text-2xl font-semibold text-[#1A2820] dark:text-[#EBF2ED]">
          Settings
        </h1>
        <p className="text-sm text-[#5A6A60] dark:text-[#9CB0A4]">
          Manage microphone permissions for Zero Crumbs AI Voice, account profile, expiry alerts,
          appearance, and security.
        </p>
      </div>

      {/* Global Account Notices */}
      {successMsg && (
        <div className="p-3.5 rounded-xl bg-[#EEF3EC] dark:bg-[#1D3127] border border-[#C7DBC9] dark:border-[#335844] text-sm text-[#1B4332] dark:text-[#9CE0B8] flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {errorMsg && (
        <div className="p-3.5 rounded-xl bg-[#FDF2EC] dark:bg-[#2B1B18] border border-[#EBC6BA] dark:border-[#5C3128] text-sm text-[#9E2F2F] dark:text-[#F5B0A6]">
          {errorMsg}
        </div>
      )}

      {/* Mobile / Tablet Section Filter Bar */}
      <div className="flex lg:hidden items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
        {SECTION_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeSection === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveSection(tab.id)}
              className={`min-h-[40px] px-3 py-2 rounded-xl border text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                active
                  ? 'bg-[#1B4332] dark:bg-[#2D6A4F] border-[#1B4332] dark:border-[#2D6A4F] text-white'
                  : 'bg-white dark:bg-[#17211C] border-[#E5E7E2] dark:border-[#27362E] text-[#34443A] dark:text-[#C5D5CC] hover:bg-[#F2F4EF] dark:hover:bg-[#1F2C25]'
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Desktop Settings Sidebar */}
        <aside className="hidden lg:block lg:col-span-3 sticky top-28 bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-2.5 space-y-1">
          {SECTION_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeSection === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveSection(tab.id)}
                className={`w-full px-3 py-2.5 rounded-xl text-left text-xs font-medium inline-flex items-center gap-2.5 transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#EEF3EC] dark:bg-[#21352B] text-[#1B4332] dark:text-[#A3DFBC]'
                    : 'text-[#4F5E55] dark:text-[#A5B7AC] hover:bg-[#F4F5F2] dark:hover:bg-[#1F2D25] hover:text-[#1A2820] dark:hover:text-[#EBF2ED]'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </aside>

        {/* Main Settings Cards Column */}
        <div className="lg:col-span-9 space-y-6">
          {/* 1. MICROPHONE PERMISSION */}
          {showSection('microphone') && (
            <section className="bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-5 sm:p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div className="space-y-1">
                  <h2 className="font-display text-lg font-semibold text-[#1A2820] dark:text-[#EBF2ED] flex items-center gap-2">
                    <Mic className="w-4 h-4 text-[#1B4332] dark:text-[#86B69C]" />
                    Microphone Permission
                  </h2>
                  <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4] leading-relaxed max-w-2xl">
                    Microphone access is required so Zero Crumbs AI Voice can hear your spoken
                    questions and inventory commands. Permission is controlled by your browser and
                    only shows Allowed once genuinely granted.
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold ${micStatusBadge.classes}`}
                  >
                    <MicBadgeIcon className="w-3.5 h-3.5 shrink-0" />
                    <span>{micChecking ? 'Checking...' : micStatusBadge.label}</span>
                  </span>
                </div>
              </div>

              {/* Action Controls */}
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={micRequesting || micTesting || micStatus === 'unsupported'}
                  onClick={() => void handleEnableMicrophone()}
                  className="min-h-[42px] px-4 py-2 rounded-xl bg-[#1B4332] dark:bg-[#2D6A4F] text-white text-xs font-medium hover:bg-[#143325] dark:hover:bg-[#245740] transition-colors inline-flex items-center gap-2 cursor-pointer disabled:opacity-55"
                >
                  {micRequesting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Mic className="w-4 h-4" />
                  )}
                  <span>{micRequesting ? 'Requesting Access...' : 'Enable Microphone'}</span>
                </button>

                <button
                  type="button"
                  disabled={micRequesting || micStatus === 'unsupported'}
                  onClick={() => void handleStartMicTest()}
                  className={`min-h-[42px] px-4 py-2 rounded-xl border text-xs font-medium transition-colors inline-flex items-center gap-2 cursor-pointer disabled:opacity-55 ${
                    micTesting
                      ? 'bg-[#FDF2EC] dark:bg-[#2B1B18] border-[#EBC6BA] dark:border-[#68372E] text-[#9E2F2F] dark:text-[#F5B0A6]'
                      : 'bg-white dark:bg-[#1E2A23] border-[#DCE0D8] dark:border-[#31483B] text-[#1A2820] dark:text-[#EBF2ED] hover:bg-[#F4F5F2] dark:hover:bg-[#26362E]'
                  }`}
                >
                  {micTesting ? <MicOff className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                  <span>{micTesting ? 'Stop Test' : 'Test Microphone'}</span>
                </button>

                <button
                  type="button"
                  disabled={micChecking || micTesting}
                  onClick={() => void refreshMicrophoneStatus()}
                  className="min-h-[42px] px-3.5 py-2 rounded-xl border border-[#DCE0D8] dark:border-[#31483B] text-xs font-medium text-[#4F5E55] dark:text-[#B5C6BC] hover:bg-[#F4F5F2] dark:hover:bg-[#223129] transition-colors inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-55"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${micChecking ? 'animate-spin' : ''}`} />
                  <span>Refresh Status</span>
                </button>
              </div>

              {/* Live Microphone Audio Meter During Test */}
              {micTesting && (
                <div className="p-4 rounded-xl bg-[#EEF3EC] dark:bg-[#1A2921] border border-[#C7DBC9] dark:border-[#2E4739] space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-[#1B4332] dark:text-[#9CE0B8] flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-[#1B4332] dark:bg-[#8CD4A9] animate-ping" />
                      Testing microphone input — speak a word or two now...
                    </span>
                    <span className="font-mono tabular-nums text-[#34443A] dark:text-[#B5C6BC]">
                      Peak {Math.round(micTestPeak * 100)}%
                    </span>
                  </div>
                  <div className="h-2.5 w-full rounded-full bg-white dark:bg-[#0F1713] border border-[#D4DDD3] dark:border-[#2B4034] overflow-hidden">
                    <div
                      className="h-full bg-[#1B4332] dark:bg-[#52B788] transition-all duration-75 rounded-full"
                      style={{ width: `${Math.min(100, Math.round(micTestLevel * 100))}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-[#4F5E55] dark:text-[#9CB0A4]">
                    The microphone stream automatically stops and releases as soon as the 4.5-second
                    test completes.
                  </p>
                </div>
              )}

              {/* Test Result Feedback */}
              {micTestResult && (
                <div
                  className={`p-3.5 rounded-xl border text-xs leading-relaxed flex items-start gap-2.5 ${
                    micTestResult.type === 'success'
                      ? 'bg-[#EEF3EC] dark:bg-[#1D3127] border-[#C7DBC9] dark:border-[#335844] text-[#1B4332] dark:text-[#9CE0B8]'
                      : 'bg-[#FAF9F6] dark:bg-[#141E19] border-[#DCE0D8] dark:border-[#2B3B32] text-[#34443A] dark:text-[#D5E2DA]'
                  }`}
                >
                  {micTestResult.type === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  ) : (
                    <Info className="w-4 h-4 shrink-0 mt-0.5" />
                  )}
                  <span>{micTestResult.message}</span>
                </div>
              )}

              {/* Blocked / Denied Guidance */}
              {(micStatus === 'blocked' || micActionError) && (
                <div className="p-4 rounded-xl bg-[#FDF2EC] dark:bg-[#2B1B18] border border-[#EBC6BA] dark:border-[#5C3128] text-xs space-y-2">
                  <div className="flex items-start gap-2 font-semibold text-[#9E2F2F] dark:text-[#F5B0A6]">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      {micActionError?.message ||
                        'Microphone access is currently Blocked for this site.'}
                    </span>
                  </div>
                  <p className="text-[#7E2B2B] dark:text-[#E89B90] leading-relaxed">
                    {micActionError?.howToEnable ||
                      (isMobile
                        ? 'Browser permissions cannot be reset by websites once blocked. Tap the lock or site-settings icon in your browser address bar, go to Permissions → Microphone → Allow, then tap Refresh Status.'
                        : 'Browser permissions cannot be overridden by websites once blocked. Click the tune or lock icon beside the website URL → Site settings → change Microphone to Allow, then click Refresh Status.')}
                  </p>
                </div>
              )}

              {/* Unsupported Notice */}
              {micStatus === 'unsupported' && (
                <div className="p-4 rounded-xl bg-[#FBF4E9] dark:bg-[#2C2418] border border-[#E7D4B5] dark:border-[#5D492B] text-xs text-[#614721] dark:text-[#E8C58E] leading-relaxed">
                  {voiceSupport.unsupportedReason ||
                    'Your current browser or connection does not support navigator.mediaDevices.getUserMedia(). Please open Zero Crumbs over HTTPS or localhost in Chrome, Edge, Safari, or Firefox.'}
                </div>
              )}

              {/* Honest Technical Capabilities Note */}
              <div className="p-3.5 rounded-xl bg-[#FAF9F6] dark:bg-[#131C17] border border-[#ECEEE8] dark:border-[#24322B] text-[11px] text-[#5A6A60] dark:text-[#9CB0A4] space-y-1 leading-relaxed">
                <p>
                  <strong className="text-[#34443A] dark:text-[#DCE6DF]">Important:</strong>{' '}
                  Allowing microphone permission enables audio capture from your device, but it does
                  not by itself guarantee speech recognition will succeed. Voice transcription also
                  depends on browser speech recognition support or server audio transcription and an
                  active network connection.
                </p>
                <p>
                  Detected browser capabilities:{' '}
                  <span className="font-medium text-[#1A2820] dark:text-[#E2ECE6]">
                    {voiceSupport.speechRecognition
                      ? 'Web Speech Recognition + Audio Fallback'
                      : voiceSupport.mediaRecorder
                        ? 'Audio Recording + Server Transcription'
                        : 'Text Chat Only'}
                  </span>
                  {micStatusSource === 'session-fallback' &&
                    ' · Permission status tracked from active session checks'}
                </p>
              </div>
            </section>
          )}

          {/* 2. ACCOUNT SETTINGS */}
          {showSection('account') && (
            <section className="bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-5 sm:p-6 space-y-5">
              <div>
                <h2 className="font-display text-lg font-semibold text-[#1A2820] dark:text-[#EBF2ED] flex items-center gap-2">
                  <UserIcon className="w-4 h-4 text-[#1B4332] dark:text-[#86B69C]" />
                  Account Settings
                </h2>
                <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
                  View and update your private Zero Crumbs household profile details.
                </p>
              </div>

              <form onSubmit={handleSaveAccountSubmit} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-[#34443A] dark:text-[#C5D5CC] mb-1.5">
                      Full Name
                    </label>
                    <input
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#0F1713] border border-[#DCE0D8] dark:border-[#2B3B32] text-sm text-[#1A2820] dark:text-[#EBF2ED] focus:outline-none focus:border-[#1B4332] dark:focus:border-[#52B788]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#34443A] dark:text-[#C5D5CC] mb-1.5">
                      Username
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#0F1713] border border-[#DCE0D8] dark:border-[#2B3B32] text-sm text-[#1A2820] dark:text-[#EBF2ED] focus:outline-none focus:border-[#1B4332] dark:focus:border-[#52B788]"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-[#34443A] dark:text-[#C5D5CC] mb-1.5">
                      Account Email
                    </label>
                    <input
                      type="email"
                      value={accountEmail || 'Not linked'}
                      disabled
                      className="w-full px-3.5 py-2.5 rounded-xl bg-[#F4F5F2] dark:bg-[#131C17] border border-[#E5E7E2] dark:border-[#24322B] text-sm text-[#5A6A60] dark:text-[#90A498]"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-[#34443A] dark:text-[#C5D5CC] mb-1.5">
                      Household Size
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={householdSize}
                      onChange={(e) => setHouseholdSize(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#0F1713] border border-[#DCE0D8] dark:border-[#2B3B32] text-sm font-mono tabular-nums text-[#1A2820] dark:text-[#EBF2ED] focus:outline-none focus:border-[#1B4332] dark:focus:border-[#52B788]"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-[#34443A] dark:text-[#C5D5CC] mb-1.5">
                      Default Storage Location
                    </label>
                    <select
                      value={defaultLocation}
                      onChange={(e) => setDefaultLocation(e.target.value as StorageLocation)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#0F1713] border border-[#DCE0D8] dark:border-[#2B3B32] text-sm text-[#1A2820] dark:text-[#EBF2ED] focus:outline-none focus:border-[#1B4332] dark:focus:border-[#52B788]"
                    >
                      {STORAGE_LOCATIONS.map((loc) => (
                        <option key={loc} value={loc}>
                          {loc}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="pt-3 border-t border-[#ECEEE8] dark:border-[#24322B] flex justify-end">
                  <button
                    type="submit"
                    disabled={savingAccount}
                    className="min-h-[42px] px-5 py-2.5 rounded-xl bg-[#1B4332] dark:bg-[#2D6A4F] text-white text-xs sm:text-sm font-medium hover:bg-[#143325] dark:hover:bg-[#245740] transition-colors inline-flex items-center gap-2 cursor-pointer disabled:opacity-60"
                  >
                    <Save className="w-4 h-4" />
                    {savingAccount ? 'Saving...' : 'Save Account Details'}
                  </button>
                </div>
              </form>
            </section>
          )}

          {/* 3. NOTIFICATIONS */}
          {showSection('notifications') && (
            <section className="bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-5 sm:p-6 space-y-5">
              <div>
                <h2 className="font-display text-lg font-semibold text-[#1A2820] dark:text-[#EBF2ED] flex items-center gap-2">
                  <Bell className="w-4 h-4 text-[#1B4332] dark:text-[#86B69C]" />
                  Notifications & Expiry Reminders
                </h2>
                <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
                  Choose how early Zero Crumbs warns you before food spoils and manage delivery
                  channels.
                </p>
              </div>

              {notifNotice && (
                <div className="p-3 rounded-xl bg-[#EEF3EC] dark:bg-[#1D3127] border border-[#C7DBC9] dark:border-[#335844] text-xs text-[#1B4332] dark:text-[#9CE0B8] flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{notifNotice}</span>
                </div>
              )}

              {notifError && (
                <div className="p-3 rounded-xl bg-[#FDF2EC] dark:bg-[#2B1B18] border border-[#EBC6BA] dark:border-[#5C3128] text-xs text-[#9E2F2F] dark:text-[#F5B0A6]">
                  {notifError}
                </div>
              )}

              <form onSubmit={handleSaveNotificationsSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-[#34443A] dark:text-[#C5D5CC] mb-1.5">
                    Expiry Reminder Window (Days Before Expiry)
                  </label>
                  <select
                    value={reminderDaysBefore}
                    onChange={(e) => setReminderDaysBefore(e.target.value)}
                    className="w-full sm:max-w-xs px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#0F1713] border border-[#DCE0D8] dark:border-[#2B3B32] text-sm text-[#1A2820] dark:text-[#EBF2ED]"
                  >
                    <option value="1">1 day before expiry</option>
                    <option value="2">2 days before expiry</option>
                    <option value="3">3 days before expiry (Recommended)</option>
                    <option value="5">5 days before expiry</option>
                    <option value="7">7 days before expiry</option>
                  </select>
                </div>

                <div className="p-4 rounded-xl bg-[#FAF9F6] dark:bg-[#131C17] border border-[#ECEEE8] dark:border-[#24322B] space-y-3">
                  <label className="flex items-start justify-between gap-4 cursor-pointer">
                    <div>
                      <p className="text-sm font-medium text-[#1A2820] dark:text-[#EBF2ED]">
                        Browser Push Alerts
                      </p>
                      <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
                        Show desktop notifications when food items enter your reminder window.
                        Browser permission:{' '}
                        <strong className="capitalize text-[#1A2820] dark:text-[#EBF2ED]">
                          {browserNotificationPerm === 'granted'
                            ? 'Allowed'
                            : browserNotificationPerm === 'denied'
                              ? 'Blocked'
                              : browserNotificationPerm === 'default'
                                ? 'Not Requested'
                                : 'Unsupported'}
                        </strong>
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={browserNotificationsEnabled}
                      onChange={(e) => setBrowserNotificationsEnabled(e.target.checked)}
                      className="mt-1 w-4 h-4 rounded text-[#1B4332]"
                    />
                  </label>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={browserNotificationPerm === 'unsupported'}
                      onClick={() => void handleRequestBrowserNotifications()}
                      className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-white dark:bg-[#1E2A23] border border-[#DCE0D8] dark:border-[#31483B] text-xs font-medium text-[#1A2820] dark:text-[#EBF2ED] hover:bg-[#F2F4EF] dark:hover:bg-[#26362E] transition-colors cursor-pointer disabled:opacity-55"
                    >
                      {browserNotificationPerm === 'granted'
                        ? 'Send Test Browser Alert'
                        : 'Enable Browser Notifications'}
                    </button>
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-[#FAF9F6] dark:bg-[#131C17] border border-[#ECEEE8] dark:border-[#24322B] space-y-3">
                  <label className="flex items-start justify-between gap-4 cursor-pointer">
                    <div>
                      <p className="text-sm font-medium text-[#1A2820] dark:text-[#EBF2ED]">
                        Email Expiry Summaries
                      </p>
                      <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
                        {!emailServiceStatus.loaded
                          ? 'Checking server email configuration...'
                          : emailServiceStatus.configured
                            ? `Ready to email summaries to ${accountEmail}.`
                            : 'Email expiry summaries are temporarily unavailable right now.'}
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={emailRemindersEnabled}
                      onChange={(e) => setEmailRemindersEnabled(e.target.checked)}
                      className="mt-1 w-4 h-4 rounded text-[#1B4332]"
                    />
                  </label>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={
                        sendingSummaryEmail || !emailServiceStatus.configured || !accountEmail
                      }
                      onClick={() => void handleSendExpirySummaryEmail()}
                      className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-white dark:bg-[#1E2A23] border border-[#DCE0D8] dark:border-[#31483B] text-xs font-medium text-[#1A2820] dark:text-[#EBF2ED] hover:bg-[#F2F4EF] dark:hover:bg-[#26362E] transition-colors inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-55"
                    >
                      {sendingSummaryEmail ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Mail className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {sendingSummaryEmail ? 'Sending Email...' : 'Send Expiry Summary Now'}
                      </span>
                    </button>
                  </div>
                </div>

                <div className="pt-2 flex justify-end">
                  <button
                    type="submit"
                    disabled={savingNotifications}
                    className="min-h-[42px] px-5 py-2.5 rounded-xl bg-[#1B4332] dark:bg-[#2D6A4F] text-white text-xs sm:text-sm font-medium hover:bg-[#143325] dark:hover:bg-[#245740] transition-colors inline-flex items-center gap-2 cursor-pointer disabled:opacity-60"
                  >
                    <Save className="w-4 h-4" />
                    {savingNotifications ? 'Saving...' : 'Save Notification Settings'}
                  </button>
                </div>
              </form>
            </section>
          )}

          {/* 4. APPEARANCE */}
          {showSection('appearance') && (
            <section className="bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-5 sm:p-6 space-y-4">
              <div>
                <h2 className="font-display text-lg font-semibold text-[#1A2820] dark:text-[#EBF2ED] flex items-center gap-2">
                  <Palette className="w-4 h-4 text-[#1B4332] dark:text-[#86B69C]" />
                  Appearance
                </h2>
                <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
                  Switch between the warm Cream & Sage light theme and Forest Slate dark theme.
                  Saved automatically on this device.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {(
                  [
                    {
                      id: 'light',
                      title: 'Light',
                      desc: 'Cream & Sage workspace',
                      icon: Sun,
                    },
                    {
                      id: 'dark',
                      title: 'Dark',
                      desc: 'Low-glare forest slate',
                      icon: Moon,
                    },
                    {
                      id: 'system',
                      title: 'System',
                      desc: `Matches OS (${effectiveTheme})`,
                      icon: Laptop,
                    },
                  ] as const
                ).map((opt) => {
                  const Icon = opt.icon;
                  const selected = themePref === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => handleSelectTheme(opt.id)}
                      className={`p-4 rounded-xl border text-left transition-all cursor-pointer flex items-start gap-3 ${
                        selected
                          ? 'bg-[#EEF3EC] dark:bg-[#20342A] border-[#1B4332] dark:border-[#52B788] ring-1 ring-[#1B4332]/20 dark:ring-[#52B788]/30'
                          : 'bg-[#FAF9F6] dark:bg-[#131C17] border-[#DCE0D8] dark:border-[#2B3B32] hover:border-[#B8C4BA] dark:hover:border-[#3D5748]'
                      }`}
                    >
                      <div
                        className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                          selected
                            ? 'bg-[#1B4332] dark:bg-[#2D6A4F] text-white'
                            : 'bg-white dark:bg-[#1B2620] text-[#4F5E55] dark:text-[#9CB0A4] border border-[#E5E7E2] dark:border-[#27362E]'
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-[#1A2820] dark:text-[#EBF2ED]">
                          {opt.title}
                        </p>
                        <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4]">{opt.desc}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* 5. PRIVACY & SECURITY */}
          {showSection('security') && (
            <section className="space-y-4">
              {/* Gmail OTP Verification Section (Send-only for 6-digit OTP verification) */}
              {accountEmail && (
                <div className="bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-5 sm:p-6 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                    <div className="space-y-1">
                      <h2 className="font-display text-lg font-semibold text-[#1A2820] dark:text-[#EBF2ED] flex items-center gap-2">
                        <MailCheck className="w-4 h-4 text-[#1B4332] dark:text-[#86B69C]" />
                        Gmail OTP Verification
                      </h2>
                      <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4] leading-relaxed">
                        Connect Gmail solely to send a 6-digit verification OTP to{' '}
                        <strong className="text-[#1A2820] dark:text-[#EBF2ED]">
                          {accountEmail}
                        </strong>
                        . Zero Crumbs requests send-only access and never reads, searches, or
                        modifies your inbox.
                      </p>
                    </div>

                    {(otpVerifiedNow || profile?.emailOtpVerified) && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#EEF3EC] dark:bg-[#1E3328] text-[#1B4332] dark:text-[#9CE0B8] text-xs font-medium shrink-0">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        OTP Verified
                      </span>
                    )}
                  </div>

                  {otpNotice && (
                    <div className="p-3 rounded-xl bg-[#EEF3EC] dark:bg-[#1D3127] border border-[#C7DBC9] dark:border-[#335844] text-xs text-[#1B4332] dark:text-[#9CE0B8] flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>{otpNotice}</span>
                    </div>
                  )}

                  {otpError && (
                    <div className="p-3 rounded-xl bg-[#FDF2EC] dark:bg-[#2B1B18] border border-[#EBC6BA] dark:border-[#5C3128] text-xs text-[#9E2F2F] dark:text-[#F5B0A6]">
                      {otpError}
                    </div>
                  )}

                  {!gmailConnected ? (
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                      <button
                        type="button"
                        disabled={connectingGmail}
                        onClick={() => void handleConnectGmailForOtp()}
                        className="inline-flex items-center justify-center gap-2.5 min-h-[42px] px-4 py-2 rounded-md bg-white dark:bg-[#1E2A23] border border-[#DADCE0] dark:border-[#31483B] text-xs font-medium text-[#3C4043] dark:text-[#EBF2ED] hover:bg-[#F8F9FA] dark:hover:bg-[#26362E] transition-colors cursor-pointer disabled:opacity-60 shrink-0"
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
                      <span className="text-[11px] text-[#6B7A70] dark:text-[#90A498]">
                        Authorizes Gmail send-only access in memory for this session to deliver OTP
                        codes.
                      </span>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <button
                          type="button"
                          disabled={sendingOtp || resendSeconds > 0}
                          onClick={() => setOtpSendConfirmOpen(true)}
                          className="min-h-[42px] px-4 py-2 rounded-xl bg-[#1B4332] dark:bg-[#2D6A4F] text-white text-xs font-medium hover:bg-[#143325] dark:hover:bg-[#245740] transition-colors inline-flex items-center gap-2 cursor-pointer disabled:opacity-60"
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
                          className="min-h-[42px] px-3.5 py-2 rounded-xl border border-[#DCE0D8] dark:border-[#31483B] text-xs font-medium text-[#5A6A60] dark:text-[#B5C6BC] hover:bg-[#F4F5F2] dark:hover:bg-[#213028] cursor-pointer"
                        >
                          Disconnect Gmail
                        </button>
                      </div>

                      {otpSent && (
                        <form
                          onSubmit={handleVerifyOtpCode}
                          className="p-4 rounded-xl bg-[#FAF9F6] dark:bg-[#131C17] border border-[#E5E7E2] dark:border-[#27362E] space-y-3"
                        >
                          <div className="flex items-center justify-between">
                            <label className="text-xs font-medium text-[#34443A] dark:text-[#C5D5CC]">
                              Enter 6-Digit Verification OTP
                            </label>
                            <span className="inline-flex items-center gap-1 text-[11px] text-[#5A6A60] dark:text-[#9CB0A4]">
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
                              onChange={(e) =>
                                setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                              }
                              placeholder="••••••"
                              className="sm:w-48 min-h-[44px] px-4 py-2 rounded-xl bg-white dark:bg-[#0F1713] border border-[#DCE0D8] dark:border-[#2B3B32] text-center font-mono text-lg tracking-[0.35em] text-[#1A2820] dark:text-[#EBF2ED] focus:outline-none focus:border-[#1B4332] dark:focus:border-[#52B788]"
                            />
                            <button
                              type="submit"
                              disabled={verifyingOtp || otpCode.length !== 6}
                              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#1B4332] dark:bg-[#2D6A4F] text-white text-xs font-medium hover:bg-[#143325] dark:hover:bg-[#245740] inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
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

              {/* Password Security */}
              {accountEmail && (
                <div className="bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <h2 className="font-display text-base font-semibold text-[#1A2820] dark:text-[#EBF2ED]">
                      Password & Account Security
                    </h2>
                    <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
                      Send a secure Firebase password reset link to {accountEmail}.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={sendingReset}
                    onClick={() => void handleSendPasswordReset()}
                    className="min-h-[44px] px-4 py-2.5 rounded-xl border border-[#DCE0D8] dark:border-[#31483B] text-xs font-medium text-[#1A2820] dark:text-[#EBF2ED] hover:bg-[#F4F5F2] dark:hover:bg-[#223129] inline-flex items-center justify-center gap-2 cursor-pointer shrink-0 disabled:opacity-60"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    {sendingReset ? 'Sending Reset Email...' : 'Send Password Reset Email'}
                  </button>
                </div>
              )}

              {/* Account Session */}
              <div className="bg-white dark:bg-[#17211C] border border-[#EBC6BA] dark:border-[#5C3128] rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h2 className="font-display text-base font-semibold text-[#1A2820] dark:text-[#EBF2ED]">
                    Account Session
                  </h2>
                  <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
                    Sign out of Zero Crumbs on this device. Your food inventory, expiry alerts, and
                    donation records stay safely synced in your private account.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onRequestLogout}
                  className="min-h-[44px] px-5 py-2.5 rounded-xl bg-[#FDF2EC] dark:bg-[#2B1B18] border border-[#EBC6BA] dark:border-[#68372E] text-sm font-medium text-[#9E2F2F] dark:text-[#F5B0A6] hover:bg-[#FAE4DA] dark:hover:bg-[#3A221E] transition-colors inline-flex items-center justify-center gap-2 cursor-pointer shrink-0"
                >
                  <LogOut className="w-4 h-4" />
                  Logout
                </button>
              </div>
            </section>
          )}

          {/* 6. ABOUT ZERO CRUMBS */}
          {showSection('about') && (
            <section className="bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-5 sm:p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <h2 className="font-display text-lg font-semibold text-[#1A2820] dark:text-[#EBF2ED] flex items-center gap-2">
                    <Info className="w-4 h-4 text-[#1B4332] dark:text-[#86B69C]" />
                    About Zero Crumbs
                  </h2>
                  <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
                    Save Food. Reduce Waste. Share Goodness.
                  </p>
                </div>
                <span className="font-mono text-xs px-2.5 py-1 rounded-lg bg-[#EEF3EC] dark:bg-[#1E3328] text-[#1B4332] dark:text-[#9CE0B8] w-fit">
                  Version 1.4.0
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3.5 rounded-xl bg-[#FAF9F6] dark:bg-[#131C17] border border-[#ECEEE8] dark:border-[#24322B] space-y-1">
                  <p className="font-semibold text-[#1A2820] dark:text-[#EBF2ED]">
                    Core Capabilities
                  </p>
                  <p className="text-[#5A6A60] dark:text-[#9CB0A4] leading-relaxed">
                    Private cloud-synced pantry tracking, expiry reminders, Google Maps charity
                    donations, consumption analytics, and Zero Crumbs AI text & voice assistant.
                  </p>
                </div>
                <div className="p-3.5 rounded-xl bg-[#FAF9F6] dark:bg-[#131C17] border border-[#ECEEE8] dark:border-[#24322B] space-y-1">
                  <p className="font-semibold text-[#1A2820] dark:text-[#EBF2ED]">
                    Browser Voice Environment
                  </p>
                  <p className="text-[#5A6A60] dark:text-[#9CB0A4] leading-relaxed">
                    Secure context: {voiceEnv.isSecureContext ? 'Yes (HTTPS / localhost)' : 'No'} ·
                    Audio capture API: {voiceEnv.mediaDevicesAvailable ? 'Available' : 'Unavailable'}{' '}
                    · Speech recognition:{' '}
                    {voiceEnv.speechRecognitionAvailable ? 'Built-in' : 'Server fallback'}
                  </p>
                </div>
              </div>
            </section>
          )}
        </div>
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
