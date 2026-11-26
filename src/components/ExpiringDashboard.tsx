import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Clock,
  HeartHandshake,
  Mail,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { auth } from '../firebase';
import type { FoodItem, UserProfile } from '../types';
import {
  formatExpiryStatus,
  formatQuantity,
  formatShortDate,
  getExpiryBucket,
  sortByNearestExpiry,
} from '../utils/foodUtils';
import { FoodImage } from './FoodImage';

interface ExpiringDashboardProps {
  foods: FoodItem[];
  profile: UserProfile | null;
  onUseFood: (food: FoodItem) => void;
  onDonateFood: (food: FoodItem) => void;
  onMarkWasted: (food: FoodItem) => Promise<void>;
  onAskAiForRecipes: (items: FoodItem[]) => void;
  onUpdateReminderSettings: (updates: {
    reminderDaysBefore?: number;
    browserNotificationsEnabled?: boolean;
    emailRemindersEnabled?: boolean;
  }) => Promise<void>;
}

export function ExpiringDashboard({
  foods,
  profile,
  onUseFood,
  onDonateFood,
  onMarkWasted,
  onAskAiForRecipes,
  onUpdateReminderSettings,
}: ExpiringDashboardProps) {
  const activeFoods = sortByNearestExpiry(foods.filter((f) => f.status === 'active'));
  const threshold = profile?.reminderDaysBefore ?? 3;

  const expiredItems = activeFoods.filter((f) => getExpiryBucket(f.expiryDate, threshold) === 'expired');
  const todayItems = activeFoods.filter((f) => getExpiryBucket(f.expiryDate, threshold) === 'today');
  const soonItems = activeFoods.filter((f) => getExpiryBucket(f.expiryDate, threshold) === 'soon');

  const [browserPerm, setBrowserPerm] = useState<string>(
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'unsupported'
  );
  const [emailStatus, setEmailStatus] = useState<{
    loaded: boolean;
    emailConfigured: boolean;
    missingEnv: string[];
  }>({ loaded: false, emailConfigured: false, missingEnv: [] });
  const [reminderNotice, setReminderNotice] = useState('');
  const [reminderError, setReminderError] = useState('');
  const [sendingEmail, setSendingEmail] = useState(false);

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
          const data = (await resp.json()) as {
            emailConfigured: boolean;
            missingEnv: string[];
          };
          setEmailStatus({
            loaded: true,
            emailConfigured: data.emailConfigured,
            missingEnv: data.missingEnv || [],
          });
        }
      } catch {
        if (active) {
          setEmailStatus({ loaded: true, emailConfigured: false, missingEnv: ['RESEND_API_KEY'] });
        }
      }
    }
    void loadEmailStatus();
    return () => {
      active = false;
    };
  }, []);

  async function handleEnableBrowserNotifications() {
    setReminderError('');
    setReminderNotice('');
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setBrowserPerm('unsupported');
      setReminderError('This browser does not support desktop push notifications.');
      return;
    }

    const permission = await Notification.requestPermission();
    setBrowserPerm(permission);

    if (permission === 'granted') {
      await onUpdateReminderSettings({ browserNotificationsEnabled: true });
      const alertItems = [...expiredItems, ...todayItems, ...soonItems];
      const body =
        alertItems.length > 0
          ? `${alertItems.length} item(s) need attention (${alertItems
              .slice(0, 3)
              .map((i) => i.name)
              .join(', ')}).`
          : `Zero Crumbs ${threshold}-day expiry alerts are now active.`;
      new Notification('Zero Crumbs Expiry Reminder', { body });
      setReminderNotice('Browser notifications enabled and test alert delivered.');
    } else {
      await onUpdateReminderSettings({ browserNotificationsEnabled: false });
      setReminderError(
        'Notification permission was not granted. Allow notifications in your browser settings to receive live alerts.'
      );
    }
  }

  async function handleSendEmailReminder() {
    setReminderError('');
    setReminderNotice('');
    const user = auth.currentUser;
    if (!user) return;
    setSendingEmail(true);
    try {
      const token = await user.getIdToken();
      const targetItems = [...todayItems, ...soonItems].map((i) => ({
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
          items: targetItems,
          reminderDaysBefore: threshold,
        }),
      });
      const data = (await resp.json()) as { error?: string };
      if (!resp.ok) {
        setReminderError(data.error || 'Could not send email reminder.');
      } else {
        setReminderNotice(`Expiry summary email sent to ${user.email}.`);
      }
    } catch (err) {
      setReminderError(err instanceof Error ? err.message : 'Failed to send email.');
    } finally {
      setSendingEmail(false);
    }
  }

  function renderCategorySection(
    title: string,
    subtitle: string,
    items: FoodItem[],
    variant: 'expired' | 'today' | 'soon'
  ) {
    const toneClass =
      variant === 'expired'
        ? 'text-[#B83B3B]'
        : variant === 'today'
          ? 'text-[#B56A1B]'
          : 'text-[#8C6423]';

    return (
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#E5E7E2]">
          <div>
            <h2 className="font-display text-lg font-semibold text-[#1A2820] flex items-center gap-2">
              <span>{title}</span>
              <span className={`font-mono text-sm tabular-nums ${toneClass}`}>
                ({items.length})
              </span>
            </h2>
            <p className="text-xs text-[#5A6A60]">{subtitle}</p>
          </div>
          {variant !== 'expired' && items.length > 0 && (
            <button
              type="button"
              onClick={() => onAskAiForRecipes(items)}
              className="px-3 py-1.5 rounded-xl bg-[#EEF3EC] text-[#1B4332] text-xs font-medium hover:bg-[#DFE9DC] transition-colors inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Suggest Recipes with Zero Crumbs AI
            </button>
          )}
        </div>

        {items.length === 0 ? (
          <div className="bg-white border border-[#E5E7E2] rounded-2xl p-6 text-sm text-[#5A6A60]">
            No items in this category right now.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {items.map((item) => (
              <div
                key={item.id}
                className="bg-white border border-[#E5E7E2] rounded-2xl overflow-hidden flex flex-col"
              >
                <div className="aspect-[16/9] bg-[#F2F4EF]">
                  <FoodImage src={item.imageUrl} alt={item.name} />
                </div>
                <div className="p-4 flex-1 flex flex-col justify-between gap-4">
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <h3 className="font-display text-base font-semibold text-[#1A2820]">
                        {item.name}
                      </h3>
                      <span className="font-mono text-xs font-medium tabular-nums text-[#1A2820]">
                        {formatQuantity(item.quantity, item.unit)}
                      </span>
                    </div>
                    <p className="text-xs text-[#5A6A60] mb-2">
                      {item.location} · {item.category} · {formatShortDate(item.expiryDate)}
                    </p>
                    <p className={`text-xs font-medium flex items-center gap-1.5 ${toneClass}`}>
                      {variant === 'expired' ? (
                        <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <Clock className="w-3.5 h-3.5 shrink-0" />
                      )}
                      {formatExpiryStatus(item.expiryDate)}
                    </p>
                    <p className="mt-2 text-xs text-[#4F5E55]">
                      {variant === 'expired'
                        ? 'Suggested action: Do not eat or donate expired food. Compost or discard safely.'
                        : variant === 'today'
                          ? 'Suggested action: Cook in today’s meal, freeze if suitable, or share sealed surplus now.'
                          : 'Suggested action: Prioritize in your meal plan or list surplus for charity pickup.'}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 pt-3 border-t border-[#ECEEE8]">
                    {variant === 'expired' ? (
                      <button
                        type="button"
                        onClick={() => void onMarkWasted(item)}
                        className="flex-1 py-2 px-3 rounded-xl bg-[#B83B3B] text-white text-xs font-medium hover:bg-[#9E2F2F] transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Mark Disposed / Wasted
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => onUseFood(item)}
                          className="flex-1 py-2 px-3 rounded-xl bg-[#1B4332] text-white text-xs font-medium hover:bg-[#143325] transition-colors cursor-pointer"
                        >
                          Use Food
                        </button>
                        <button
                          type="button"
                          onClick={() => onDonateFood(item)}
                          className="py-2 px-3 rounded-xl border border-[#DCE0D8] text-xs font-medium text-[#34443A] hover:bg-[#F4F5F2] transition-colors inline-flex items-center gap-1 cursor-pointer"
                        >
                          <HeartHandshake className="w-3.5 h-3.5" />
                          Donate
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header & Summary Strip */}
      <section className="bg-white border border-[#E5E7E2] rounded-2xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-6">
          <div>
            <h1 className="font-display text-2xl font-semibold text-[#1A2820]">
              Expiring Food Dashboard
            </h1>
            <p className="text-sm text-[#5A6A60]">
              Real-time expiry tracking calculated against today’s date with safety-first action guidance.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums">
            <span className="text-[#B83B3B] font-semibold">
              {expiredItems.length} Expired
            </span>
            <span className="text-[#C5CCC5]">·</span>
            <span className="text-[#B56A1B] font-semibold">
              {todayItems.length} Expiring Today
            </span>
            <span className="text-[#C5CCC5]">·</span>
            <span className="text-[#8C6423] font-semibold">
              {soonItems.length} Expiring in 1–{threshold} Days
            </span>
          </div>
        </div>

        {/* Real 3-Day Reminder Settings */}
        <div className="pt-5 border-t border-[#ECEEE8] grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="p-4 rounded-xl bg-[#FAF9F6] border border-[#E5E7E2] flex flex-col justify-between gap-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-[#1A2820] flex items-center gap-2">
                  <Bell className="w-4 h-4 text-[#1B4332]" />
                  Browser Push Notifications ({threshold}-Day Alert)
                </p>
                <p className="text-xs text-[#5A6A60] mt-1">
                  Browser permission:{' '}
                  <strong className="text-[#1A2820] capitalize">{browserPerm}</strong>
                </p>
              </div>
              <select
                aria-label="Reminder days before expiry"
                value={threshold}
                onChange={(e) =>
                  void onUpdateReminderSettings({ reminderDaysBefore: Number(e.target.value) })
                }
                className="px-2.5 py-1.5 rounded-lg bg-white border border-[#DCE0D8] text-xs font-medium text-[#1A2820]"
              >
                <option value={1}>1 day before</option>
                <option value={2}>2 days before</option>
                <option value={3}>3 days before</option>
                <option value={5}>5 days before</option>
                <option value={7}>7 days before</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleEnableBrowserNotifications()}
                className="px-3.5 py-2 rounded-xl bg-[#1B4332] text-white text-xs font-medium hover:bg-[#143325] transition-colors cursor-pointer"
              >
                {browserPerm === 'granted'
                  ? 'Send Real Browser Alert Now'
                  : 'Enable Browser Notifications'}
              </button>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#FAF9F6] border border-[#E5E7E2] flex flex-col justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-[#1A2820] flex items-center gap-2">
                <Mail className="w-4 h-4 text-[#1B4332]" />
                Email Expiry Reminders
              </p>
              <p className="text-xs text-[#5A6A60] mt-1">
                {!emailStatus.loaded
                  ? 'Checking email service configuration...'
                  : !(profile?.email || auth.currentUser?.email)
                    ? 'No email linked to this phone-verified account. Use Browser Push Notifications above.'
                    : emailStatus.emailConfigured
                      ? `Connected and ready for ${profile?.email || auth.currentUser?.email}.`
                      : `Requires server environment secrets (${emailStatus.missingEnv.join(', ')}) to send real emails.`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={
                  sendingEmail ||
                  !emailStatus.emailConfigured ||
                  !(profile?.email || auth.currentUser?.email)
                }
                onClick={() => void handleSendEmailReminder()}
                className="min-h-[42px] px-3.5 py-2 rounded-xl border border-[#DCE0D8] bg-white text-xs font-medium text-[#1A2820] hover:bg-[#F2F4EF] transition-colors cursor-pointer disabled:opacity-50"
              >
                {sendingEmail ? 'Sending...' : 'Send Real Expiry Email'}
              </button>
            </div>
          </div>
        </div>

        {reminderNotice && (
          <div className="mt-4 p-3 rounded-xl bg-[#EEF3EC] border border-[#C7DBC9] text-xs text-[#1B4332]">
            {reminderNotice}
          </div>
        )}
        {reminderError && (
          <div className="mt-4 p-3 rounded-xl bg-[#FDF2EC] border border-[#EBC6BA] text-xs text-[#9E2F2F] flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{reminderError}</span>
          </div>
        )}
      </section>

      {renderCategorySection(
        'Expired Items',
        'Past expiry date — never consume or donate expired items.',
        expiredItems,
        'expired'
      )}

      {renderCategorySection(
        'Expiring Today',
        'Use in meals today or donate sealed non-expired surplus immediately.',
        todayItems,
        'today'
      )}

      {renderCategorySection(
        `Expiring in 1–${threshold} Days`,
        'Plan upcoming recipes or prepare surplus charity listings.',
        soonItems,
        'soon'
      )}
    </div>
  );
}
