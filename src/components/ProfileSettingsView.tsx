import React, { useEffect, useState } from 'react';
import { sendPasswordResetEmail } from 'firebase/auth';
import { CheckCircle2, KeyRound, LogOut, Phone, Save } from 'lucide-react';
import { auth } from '../firebase';
import { STORAGE_LOCATIONS, type StorageLocation, type UserProfile } from '../types';

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
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

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
    if (!email) return;
    setErrorMsg('');
    setSuccessMsg('');
    try {
      await sendPasswordResetEmail(auth, email);
      setSuccessMsg(`Password reset email sent to ${email}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to send password reset email.');
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

          <div>
            <label className="block text-xs font-medium text-[#34443A] mb-1.5">
              Account Email
            </label>
            <input
              type="email"
              value={profile?.email || auth.currentUser?.email || 'Not linked'}
              disabled
              className="w-full px-3.5 py-2.5 rounded-xl bg-[#F4F5F2] border border-[#E5E7E2] text-sm text-[#5A6A60]"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[#34443A] mb-1.5">
              Verified Phone Number
            </label>
            <div className="relative">
              <Phone className="w-3.5 h-3.5 text-[#6B7A70] absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={profile?.phoneNumber || auth.currentUser?.phoneNumber || 'Not linked'}
                disabled
                className="w-full pl-9 pr-3.5 py-2.5 rounded-xl bg-[#F4F5F2] border border-[#E5E7E2] text-sm text-[#5A6A60] font-mono tabular-nums"
              />
            </div>
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

      {(profile?.email || auth.currentUser?.email) && (
        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-semibold text-[#1A2820]">Account Security</h2>
            <p className="text-xs text-[#5A6A60]">
              Send a secure password reset link to your registered email address.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleSendPasswordReset()}
            className="min-h-[44px] px-4 py-2.5 rounded-xl border border-[#DCE0D8] text-xs font-medium text-[#1A2820] hover:bg-[#F4F5F2] inline-flex items-center justify-center gap-2 cursor-pointer shrink-0"
          >
            <KeyRound className="w-3.5 h-3.5" />
            Send Password Reset Email
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
    </div>
  );
}
