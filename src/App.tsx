import { useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import {
  BarChart3,
  Clock,
  HeartHandshake,
  History,
  Home,
  Leaf,
  LogOut,
  Package,
  PlusCircle,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import { auth, authPersistenceReady } from './firebase';
import {
  addFoodItem,
  adjustFoodQuantity,
  createDonationListing,
  createDonationRequest,
  deleteFoodItem,
  editFoodItem,
  ensureUserProfile,
  getEmailOtpVerifiedStatus,
  loadSampleDemoData,
  subscribeUserCollections,
  transitionDonationStatus,
  updateDonationDetails,
  updateDonationRequestStatus,
  updateUserProfile,
} from './services/firestoreService';
import type {
  ActivityLog,
  AiActionRecord,
  ChatMessage,
  DonationListing,
  DonationRequest,
  FoodItem,
  NavPage,
  QuantityHistoryEntry,
  UserProfile,
} from './types';
import { getExpiryBucket } from './utils/foodUtils';
import { ActivityHistoryView } from './components/ActivityHistoryView';
import { AiAssistantPanel } from './components/AiAssistantPanel';
import {
  AuthScreen,
  consumePendingSignupMetaByEmail,
  peekPendingSignupMetaByEmail,
  type PendingSignupMeta,
} from './components/AuthScreen';
import { CharityDashboard } from './components/CharityDashboard';
import { ConfirmModal } from './components/ConfirmModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ExpiringDashboard } from './components/ExpiringDashboard';
import { FoodForm, FoodModal } from './components/FoodModal';
import { HomeDashboard } from './components/HomeDashboard';
import { InventoryView } from './components/InventoryView';
import { ProfileSettingsView } from './components/ProfileSettingsView';
import { SmartInsightsView } from './components/SmartInsightsView';
import { UseFoodModal } from './components/UseFoodModal';

const NAV_ITEMS: Array<{ id: NavPage; label: string; shortLabel: string; icon: typeof Home }> = [
  { id: 'home', label: 'Home', shortLabel: 'Home', icon: Home },
  { id: 'expiring', label: 'Expiring Dashboard', shortLabel: 'Expiring', icon: Clock },
  { id: 'inventory', label: 'Food Inventory', shortLabel: 'Inventory', icon: Package },
  { id: 'add-food', label: 'Add Food', shortLabel: 'Add Food', icon: PlusCircle },
  { id: 'charity', label: 'Charity Dashboard', shortLabel: 'Charity', icon: HeartHandshake },
  { id: 'ai', label: 'AI Assistant', shortLabel: 'AI Assistant', icon: Sparkles },
  { id: 'activity', label: 'Activity History', shortLabel: 'Activity', icon: History },
  { id: 'insights', label: 'Smart Insights', shortLabel: 'Insights', icon: BarChart3 },
  { id: 'settings', label: 'Profile and Settings', shortLabel: 'Settings', icon: Settings },
];

function ZeroCrumbsWorkspace() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [verifiedUid, setVerifiedUid] = useState<string | null>(null);
  const [verifyingAuth, setVerifyingAuth] = useState(false);
  const [authRefreshTick, setAuthRefreshTick] = useState(0);
  const [profileReadyUid, setProfileReadyUid] = useState<string | null>(null);
  const [profileSyncError, setProfileSyncError] = useState('');
  const [profileRetrying, setProfileRetrying] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [foods, setFoods] = useState<FoodItem[]>([]);
  const [quantityHistory, setQuantityHistory] = useState<QuantityHistoryEntry[]>([]);
  const [donations, setDonations] = useState<DonationListing[]>([]);
  const [donationRequests, setDonationRequests] = useState<DonationRequest[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [aiActions, setAiActions] = useState<AiActionRecord[]>([]);

  const [page, setPage] = useState<NavPage>('home');
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [aiMessages, setAiMessages] = useState<ChatMessage[]>([]);
  const [queuedAiPrompt, setQueuedAiPrompt] = useState<string | null>(null);

  const [editingFood, setEditingFood] = useState<FoodItem | null>(null);
  const [foodModalOpen, setFoodModalOpen] = useState(false);
  const [useFoodTarget, setUseFoodTarget] = useState<FoodItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FoodItem | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [charityPrefillFood, setCharityPrefillFood] = useState<FoodItem | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const notifiedBrowserRef = useRef(false);
  const mobileNavRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  function showToast(text: string, type: 'success' | 'error' = 'success') {
    setToast({ type, text });
    window.setTimeout(() => {
      setToast((curr) => (curr?.text === text ? null : curr));
    }, 4500);
  }

  function clearSessionWorkspaceState() {
    setVerifiedUid(null);
    setProfileReadyUid(null);
    setProfileSyncError('');
    setProfile(null);
    setFoods([]);
    setQuantityHistory([]);
    setDonations([]);
    setDonationRequests([]);
    setActivityLogs([]);
    setAiActions([]);
    setAiMessages([]);
    setQueuedAiPrompt(null);
    setAiDrawerOpen(false);
    setEditingFood(null);
    setFoodModalOpen(false);
    setUseFoodTarget(null);
    setDeleteTarget(null);
    setCharityPrefillFood(null);
    setToast(null);
    notifiedBrowserRef.current = false;
    setPage('home');
    try {
      for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
        const k = window.sessionStorage.key(i);
        if (k && k.startsWith('zc_pending_signup_meta_')) {
          window.sessionStorage.removeItem(k);
        }
      }
    } catch {
      // Ignore storage cleanup error
    }
  }

  async function syncVerifiedUserProfile(
    targetUser: User,
    pendingMetaOverride?: PendingSignupMeta
  ) {
    setProfileSyncError('');
    try {
      const pendingMeta = pendingMetaOverride ?? consumePendingSignupMetaByEmail(targetUser.email);
      if (pendingMetaOverride) {
        consumePendingSignupMetaByEmail(targetUser.email);
      }

      if (pendingMeta?.otpProofToken) {
        try {
          const idToken = await targetUser.getIdToken();
          await fetch('/api/auth/confirm-verified', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({ otpProofToken: pendingMeta.otpProofToken }),
          });
        } catch {
          // Non-fatal; ensureUserProfile persists emailOtpVerified to Firestore
        }
      }

      await ensureUserProfile(targetUser, pendingMeta);
      setProfileReadyUid(targetUser.uid);
    } catch (err) {
      console.error('Failed to sync user profile:', err);
      setProfileReadyUid(null);
      setProfileSyncError(
        'Could not load your Zero Crumbs profile from the cloud database. Please check your connection and retry.'
      );
    }
  }

  async function evaluateAndSyncUser(targetUser: User | null): Promise<void> {
    if (!targetUser) {
      clearSessionWorkspaceState();
      return;
    }

    if (targetUser.emailVerified) {
      setVerifiedUid(targetUser.uid);
      await syncVerifiedUserProfile(targetUser);
      return;
    }

    setVerifyingAuth(true);
    try {
      const pendingMeta = peekPendingSignupMetaByEmail(targetUser.email);
      const otpVerified =
        Boolean(pendingMeta?.emailOtpVerified) || (await getEmailOtpVerifiedStatus(targetUser.uid));

      if (otpVerified) {
        setVerifiedUid(targetUser.uid);
        await syncVerifiedUserProfile(targetUser, pendingMeta);
      } else {
        clearSessionWorkspaceState();
      }
    } finally {
      setVerifyingAuth(false);
    }
  }

  useEffect(() => {
    let active = true;
    let unsub: (() => void) | undefined;

    void authPersistenceReady.finally(() => {
      if (!active) return;
      unsub = onAuthStateChanged(auth, async (nextUser) => {
        if (!active) return;
        setUser(nextUser);
        await evaluateAndSyncUser(nextUser);
        if (active) {
          setAuthReady(true);
        }
      });
    });

    return () => {
      active = false;
      unsub?.();
    };
  }, []);

  useEffect(() => {
    if (!user || verifiedUid !== user.uid || profileReadyUid !== user.uid) return;
    const unsub = subscribeUserCollections(user.uid, {
      onProfile: setProfile,
      onFoods: setFoods,
      onQuantityHistory: setQuantityHistory,
      onDonations: setDonations,
      onDonationRequests: setDonationRequests,
      onActivityLogs: setActivityLogs,
      onAiActions: setAiActions,
    });
    return () => unsub();
  }, [user, verifiedUid, profileReadyUid, authRefreshTick]);

  // Real browser notification trigger when enabled and permitted
  useEffect(() => {
    if (
      !profile?.browserNotificationsEnabled ||
      notifiedBrowserRef.current ||
      typeof window === 'undefined' ||
      !('Notification' in window) ||
      Notification.permission !== 'granted'
    ) {
      return;
    }

    const threshold = profile.reminderDaysBefore ?? 3;
    const due = foods.filter((f) => {
      if (f.status !== 'active') return false;
      const b = getExpiryBucket(f.expiryDate, threshold);
      return b === 'today' || b === 'soon';
    });

    if (due.length > 0) {
      notifiedBrowserRef.current = true;
      new Notification('Zero Crumbs Expiry Alert', {
        body: `${due.length} item${due.length === 1 ? '' : 's'} expiring within ${threshold} days: ${due
          .slice(0, 3)
          .map((d) => d.name)
          .join(', ')}`,
      });
    }
  }, [foods, profile]);

  useEffect(() => {
    const activeBtn = mobileNavRefs.current[page];
    activeBtn?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [page]);

  if (!authReady || verifyingAuth) {
    return (
      <div className="min-h-screen bg-[#FAF9F6] flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="w-10 h-10 rounded-xl bg-[#1B4332] text-white flex items-center justify-center mx-auto">
            <Leaf className="w-5 h-5" />
          </div>
          <p className="text-sm font-medium text-[#1A2820]">Loading Zero Crumbs...</p>
        </div>
      </div>
    );
  }

  const isVerifiedUser = Boolean(user && verifiedUid === user.uid);

  if (!user || !isVerifiedUser) {
    return (
      <AuthScreen
        unverifiedUser={user && !isVerifiedUser ? user : null}
        onVerifiedRefresh={async () => {
          if (auth.currentUser) {
            await auth.currentUser.reload();
            await auth.currentUser.getIdToken(true);
            const refreshed = auth.currentUser;
            setUser(refreshed);
            setAuthRefreshTick((t) => t + 1);
            await evaluateAndSyncUser(refreshed);
          }
        }}
      />
    );
  }

  if (profileSyncError) {
    return (
      <div className="min-h-screen bg-[#FAF9F6] flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white border border-[#E5E7E2] rounded-2xl p-6 sm:p-8 text-center space-y-4">
          <div className="w-11 h-11 rounded-xl bg-[#FDF2EC] text-[#9E2F2F] flex items-center justify-center mx-auto">
            <Leaf className="w-5 h-5" />
          </div>
          <h1 className="font-display text-xl font-semibold text-[#1A2820]">
            Account Sync Interrupted
          </h1>
          <p className="text-sm text-[#5A6A60] leading-relaxed">{profileSyncError}</p>
          <div className="flex flex-col sm:flex-row gap-2.5 justify-center pt-1">
            <button
              type="button"
              disabled={profileRetrying}
              onClick={async () => {
                setProfileRetrying(true);
                await syncVerifiedUserProfile(user);
                setProfileRetrying(false);
              }}
              className="min-h-[42px] px-5 py-2 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors cursor-pointer disabled:opacity-60"
            >
              {profileRetrying ? 'Retrying...' : 'Retry Sync'}
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmLogout()}
              className="min-h-[42px] px-5 py-2 rounded-xl border border-[#DCE0D8] text-sm font-medium text-[#34443A] hover:bg-[#F4F5F2] transition-colors cursor-pointer"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (profileReadyUid !== user.uid) {
    return (
      <div className="min-h-screen bg-[#FAF9F6] flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="w-10 h-10 rounded-xl bg-[#1B4332] text-white flex items-center justify-center mx-auto">
            <Leaf className="w-5 h-5" />
          </div>
          <p className="text-sm font-medium text-[#1A2820]">Preparing your private pantry...</p>
        </div>
      </div>
    );
  }

  const activeFoods = foods.filter((f) => f.status === 'active');
  const attentionCount = activeFoods.filter((f) => {
    const b = getExpiryBucket(f.expiryDate, profile?.reminderDaysBefore ?? 3);
    return b === 'expired' || b === 'today' || b === 'soon';
  }).length;

  function openAiWithPrompt(prompt: string) {
    setQueuedAiPrompt(prompt);
    if (page !== 'ai') {
      setAiDrawerOpen(true);
    }
  }

  function handleNavigate(next: NavPage) {
    setPage(next);
    if (next === 'ai') {
      setAiDrawerOpen(false);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleConfirmLogout() {
    setLogoutLoading(true);
    try {
      await signOut(auth);
      clearSessionWorkspaceState();
      setLogoutConfirmOpen(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not sign out cleanly.', 'error');
    } finally {
      setLogoutLoading(false);
    }
  }

  const userDisplayLabel = profile?.fullName || user.email || 'Zero Crumbs Member';

  return (
    <div className="min-h-screen bg-[#FAF9F6] flex flex-col max-w-full overflow-x-clip">
      {/* Directly Visible Top Navigation Header (Desktop & Mobile) */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-[#E5E7E2]">
        <div className="max-w-[1360px] mx-auto px-3 sm:px-6 lg:px-8">
          {/* Top Brand & Utility Row */}
          <div className="h-14 sm:h-16 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => handleNavigate('home')}
              className="flex items-center gap-2.5 text-left cursor-pointer min-w-0"
            >
              <div className="w-9 h-9 rounded-xl bg-[#1B4332] text-white flex items-center justify-center shrink-0">
                <Leaf className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <span className="font-display text-base font-semibold text-[#1A2820] block leading-none truncate">
                  Zero Crumbs
                </span>
                <span className="hidden sm:block text-[11px] text-[#5A6A60] truncate mt-0.5">
                  Save Food. Reduce Waste. Share Goodness.
                </span>
              </div>
            </button>

            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              <span className="hidden md:inline text-xs font-medium text-[#5A6A60] truncate max-w-[180px]">
                {userDisplayLabel}
              </span>
              <button
                type="button"
                onClick={() => {
                  setEditingFood(null);
                  setFoodModalOpen(true);
                }}
                className="min-h-[38px] sm:min-h-[40px] px-3 sm:px-3.5 py-2 rounded-xl bg-[#1B4332] text-white text-xs font-medium hover:bg-[#143325] transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                + Add Food
              </button>
              <button
                type="button"
                onClick={() => setLogoutConfirmOpen(true)}
                className="hidden sm:inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 rounded-xl border border-[#EBC6BA] bg-[#FDF2EC] text-xs font-medium text-[#9E2F2F] hover:bg-[#FAE4DA] transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Logout</span>
              </button>
            </div>
          </div>

          {/* Desktop Directly-Visible Navigation Strip */}
          <nav
            aria-label="Main navigation"
            className="hidden lg:flex items-center gap-1 pb-2.5 overflow-x-auto no-scrollbar"
          >
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = page === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleNavigate(item.id)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-[#EEF3EC] text-[#1B4332]'
                      : 'text-[#4F5E55] hover:bg-[#F4F5F2] hover:text-[#1A2820]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span>{item.label}</span>
                  {item.id === 'expiring' && attentionCount > 0 && (
                    <span className="ml-0.5 font-mono text-[11px] tabular-nums font-semibold text-[#B56A1B]">
                      ({attentionCount})
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Mobile Directly-Visible Horizontally Scrollable Navigation Bar */}
          <nav
            aria-label="Mobile navigation"
            className="flex lg:hidden items-center gap-1.5 pb-2.5 overflow-x-auto no-scrollbar -mx-3 px-3"
          >
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = page === item.id;
              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    mobileNavRefs.current[item.id] = el;
                  }}
                  type="button"
                  onClick={() => handleNavigate(item.id)}
                  className={`min-h-[40px] flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 border ${
                    active
                      ? 'bg-[#1B4332] border-[#1B4332] text-white'
                      : 'bg-[#FAF9F6] border-[#E5E7E2] text-[#34443A] hover:bg-[#F0F2EC]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span>{item.shortLabel}</span>
                  {item.id === 'expiring' && attentionCount > 0 && (
                    <span
                      className={`font-mono text-[11px] tabular-nums font-semibold ${
                        active ? 'text-[#DCEAD8]' : 'text-[#B56A1B]'
                      }`}
                    >
                      {attentionCount}
                    </span>
                  )}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setLogoutConfirmOpen(true)}
              className="min-h-[40px] flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-[#FDF2EC] border border-[#EBC6BA] text-[#9E2F2F] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5 shrink-0" />
              <span>Logout</span>
            </button>
          </nav>
        </div>
      </header>

      {/* Toast Notification */}
      {toast && (
        <div className="max-w-[1360px] w-full mx-auto px-3 sm:px-6 lg:px-8 pt-4">
          <div
            className={`px-4 py-3 rounded-xl border text-sm flex items-center justify-between gap-3 ${
              toast.type === 'error'
                ? 'bg-[#FDF2EC] border-[#EBC6BA] text-[#9E2F2F]'
                : 'bg-[#EEF3EC] border-[#C7DBC9] text-[#1B4332]'
            }`}
          >
            <span>{toast.text}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="p-1 opacity-70 hover:opacity-100 cursor-pointer shrink-0"
              aria-label="Dismiss notification"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Active Page */}
      <main className="flex-1 px-3 sm:px-6 lg:px-8 py-5 sm:py-8 max-w-[1360px] w-full mx-auto">
        {page === 'home' && (
          <HomeDashboard
            profile={profile}
            foods={foods}
            onNavigate={handleNavigate}
            onUseFood={(f) => setUseFoodTarget(f)}
            onDonateFood={(f) => {
              setCharityPrefillFood(f);
              handleNavigate('charity');
            }}
            onOpenAi={() => setAiDrawerOpen(true)}
            onLoadSampleData={async () => {
              await loadSampleDemoData(user.uid, user.email || 'Zero Crumbs Member');
              showToast('Loaded clearly labelled sample household items.');
            }}
          />
        )}

        {page === 'expiring' && (
          <ExpiringDashboard
            foods={foods}
            profile={profile}
            onUseFood={(f) => setUseFoodTarget(f)}
            onDonateFood={(f) => {
              setCharityPrefillFood(f);
              handleNavigate('charity');
            }}
            onMarkWasted={async (f) => {
              await adjustFoodQuantity(user.uid, f, { mode: 'waste' });
              showToast(`Marked ${f.name} as safely disposed/wasted.`);
            }}
            onAskAiForRecipes={(items) => {
              const names = items.slice(0, 5).map((i) => i.name).join(', ');
              openAiWithPrompt(
                `Suggest practical recipes using my expiring ingredients: ${names}. Include simple steps.`
              );
            }}
            onUpdateReminderSettings={async (updates) => {
              await updateUserProfile(user.uid, updates);
              showToast('Expiry reminder settings updated.');
            }}
          />
        )}

        {page === 'inventory' && (
          <InventoryView
            foods={foods}
            onAddFood={() => {
              setEditingFood(null);
              setFoodModalOpen(true);
            }}
            onEditFood={(f) => {
              setEditingFood(f);
              setFoodModalOpen(true);
            }}
            onUseFood={(f) => setUseFoodTarget(f)}
            onDeleteFood={(f) => setDeleteTarget(f)}
            onDonateFood={(f) => {
              setCharityPrefillFood(f);
              handleNavigate('charity');
            }}
            onLoadSampleData={async () => {
              await loadSampleDemoData(user.uid, user.email || 'Zero Crumbs Member');
              showToast('Loaded clearly labelled sample household items.');
            }}
          />
        )}

        {page === 'add-food' && (
          <div className="max-w-2xl space-y-5">
            <div>
              <h1 className="font-display text-2xl font-semibold text-[#1A2820]">Add Food</h1>
              <p className="text-sm text-[#5A6A60]">
                Log a new item into your Fridge, Freezer, or Pantry with an expiry date.
              </p>
            </div>
            <div className="bg-white border border-[#E5E7E2] rounded-2xl p-4 sm:p-6">
              <FoodForm
                defaultLocation={profile?.defaultLocation || 'Fridge'}
                onSave={async (data) => {
                  await addFoodItem(user.uid, data, 'manual');
                  showToast(`Added ${data.name} to ${data.location}.`);
                  handleNavigate('inventory');
                }}
              />
            </div>
          </div>
        )}

        {page === 'charity' && (
          <CharityDashboard
            donations={donations}
            requests={donationRequests}
            activeFoods={activeFoods}
            userEmail={user.email || ''}
            prefillFood={charityPrefillFood}
            onClearPrefill={() => setCharityPrefillFood(null)}
            onCreateDonation={async (input) => {
              await createDonationListing(user.uid, input, 'manual');
              showToast(`Published donation listing for ${input.foodName}.`);
            }}
            onUpdateDonation={async (don, updates) => {
              await updateDonationDetails(user.uid, don, updates);
              showToast(`Updated donation listing for ${don.foodName}.`);
            }}
            onTransitionStatus={async (don, status, partner) => {
              await transitionDonationStatus(user.uid, don, status, partner, 'manual');
              showToast(`${don.foodName} status updated to ${status}.`);
            }}
            onCreateRequest={async (don, input) => {
              await createDonationRequest(user.uid, don, input);
              showToast(`Recorded request from ${input.requesterName}.`);
            }}
            onUpdateRequestStatus={async (reqItem, don, status) => {
              await updateDonationRequestStatus(user.uid, reqItem, don, status);
              showToast(`Pickup request marked ${status}.`);
            }}
          />
        )}

        {page === 'ai' && (
          <div className="space-y-4">
            <div>
              <h1 className="font-display text-2xl font-semibold text-[#1A2820]">
                Zero Crumbs AI Assistant
              </h1>
              <p className="text-sm text-[#5A6A60]">
                Ask questions, request recipes, or instruct Zero Crumbs AI to manage your inventory
                and donations.
              </p>
            </div>
            <AiAssistantPanel
              mode="page"
              userId={user.uid}
              profile={profile}
              foods={foods}
              donations={donations}
              messages={aiMessages}
              setMessages={setAiMessages}
              queuedPrompt={queuedAiPrompt}
              onConsumeQueuedPrompt={() => setQueuedAiPrompt(null)}
            />
          </div>
        )}

        {page === 'activity' && (
          <ActivityHistoryView logs={activityLogs} aiActions={aiActions} />
        )}

        {page === 'insights' && (
          <SmartInsightsView
            foods={foods}
            donations={donations}
            quantityHistory={quantityHistory}
            onAskAiInsights={() =>
              openAiWithPrompt(
                'Analyze my consumption and waste history, suggest items to replenish on my shopping list, and give 3 specific tips to cut waste.'
              )
            }
          />
        )}

        {page === 'settings' && (
          <ProfileSettingsView
            profile={profile}
            onSaveProfile={async (updates) => {
              await updateUserProfile(user.uid, updates);
              showToast('Profile and reminder settings saved.');
            }}
            onRequestLogout={() => setLogoutConfirmOpen(true)}
          />
        )}
      </main>

      {/* Clean Footer */}
      <footer className="px-3 sm:px-6 lg:px-8 py-5 border-t border-[#E5E7E2] text-xs text-[#6B7A70] flex flex-col sm:flex-row items-center justify-between gap-2 max-w-[1360px] w-full mx-auto">
        <span>Zero Crumbs — Save Food. Reduce Waste. Share Goodness.</span>
        <span>Private cloud-synced kitchen & donation platform</span>
      </footer>

      {/* Floating Zero Crumbs AI Button */}
      {page !== 'ai' && !aiDrawerOpen && (
        <button
          type="button"
          onClick={() => setAiDrawerOpen(true)}
          className="fixed bottom-4 right-4 sm:bottom-5 sm:right-5 z-40 min-h-[44px] px-4 py-2.5 rounded-2xl bg-[#1B4332] text-white shadow-lg hover:bg-[#143325] transition-all inline-flex items-center gap-2 text-sm font-medium cursor-pointer"
        >
          <Sparkles className="w-4 h-4 text-[#DCEAD8]" />
          <span>Zero Crumbs AI</span>
        </button>
      )}

      {/* Floating AI Drawer */}
      {page !== 'ai' && (
        <AiAssistantPanel
          mode="drawer"
          open={aiDrawerOpen}
          onClose={() => setAiDrawerOpen(false)}
          userId={user.uid}
          profile={profile}
          foods={foods}
          donations={donations}
          messages={aiMessages}
          setMessages={setAiMessages}
          queuedPrompt={queuedAiPrompt}
          onConsumeQueuedPrompt={() => setQueuedAiPrompt(null)}
        />
      )}

      {/* Add / Edit Food Modal */}
      <FoodModal
        open={foodModalOpen}
        initialItem={editingFood}
        defaultLocation={profile?.defaultLocation || 'Fridge'}
        onSave={async (data) => {
          if (editingFood) {
            await editFoodItem(user.uid, editingFood, data, 'manual');
            showToast(`Updated ${data.name}.`);
          } else {
            await addFoodItem(user.uid, data, 'manual');
            showToast(`Added ${data.name} to ${data.location}.`);
          }
          setEditingFood(null);
        }}
        onClose={() => {
          setFoodModalOpen(false);
          setEditingFood(null);
        }}
      />

      {/* Use Food / Quantity Management Modal */}
      <UseFoodModal
        food={useFoodTarget}
        history={quantityHistory}
        onAdjust={async (options) => {
          if (!useFoodTarget) return;
          const res = await adjustFoodQuantity(user.uid, useFoodTarget, options);
          showToast(
            res.newStatus === 'consumed'
              ? `${useFoodTarget.name} marked as completely consumed.`
              : res.newStatus === 'wasted'
                ? `${useFoodTarget.name} marked as wasted.`
                : `Updated ${useFoodTarget.name} to ${res.newQuantity} ${useFoodTarget.unit} remaining.`
          );
        }}
        onClose={() => setUseFoodTarget(null)}
      />

      {/* Delete Food Confirmation Modal */}
      <ConfirmModal
        open={Boolean(deleteTarget)}
        title={`Delete ${deleteTarget?.name || 'food item'}?`}
        message={`Are you sure you want to permanently delete ${deleteTarget?.name || 'this item'} (${deleteTarget?.quantity} ${deleteTarget?.unit}) from your inventory?`}
        confirmLabel="Delete Item"
        destructive
        loading={deleteLoading}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setDeleteLoading(true);
          try {
            await deleteFoodItem(user.uid, deleteTarget, 'manual');
            showToast(`Deleted ${deleteTarget.name}.`);
            setDeleteTarget(null);
          } finally {
            setDeleteLoading(false);
          }
        }}
      />

      {/* Logout Confirmation Modal */}
      <ConfirmModal
        open={logoutConfirmOpen}
        title="Logout from Zero Crumbs?"
        message="Are you sure you want to sign out of your account? You will be redirected to the login screen, and all your food inventory and donation records will remain safely saved."
        confirmLabel="Logout"
        destructive
        loading={logoutLoading}
        onCancel={() => setLogoutConfirmOpen(false)}
        onConfirm={() => void handleConfirmLogout()}
      />
    </div>
  );
}

export default function App() {
  const [quotaExceeded, setQuotaExceeded] = useState(false);

  useEffect(() => {
    const handler = () => setQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', handler);
    return () => window.removeEventListener('gmp-quota-exceeded', handler);
  }, []);

  return (
    <ErrorBoundary>
      {quotaExceeded && (
        <div
          role="alert"
          className="sticky top-0 z-50 w-full bg-[#FDF2EC] border-b border-[#EBC6BA] text-[#7F2323] px-4 py-2.5 text-xs sm:text-sm"
        >
          <div className="max-w-[1360px] mx-auto flex items-center justify-between gap-3">
            <span>
              Google Maps quota exceeded: the daily free-tier limit (100 req/day) has been reached.
              Upgrade your Google Cloud billing plan or add your own Google Maps API key to continue
              using map features.{' '}
              <a
                href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-semibold hover:text-[#5B1616]"
              >
                Learn more
              </a>
            </span>
            <button
              type="button"
              onClick={() => setQuotaExceeded(false)}
              className="p-1 rounded-lg hover:bg-[#FAE4DA] cursor-pointer shrink-0"
              aria-label="Dismiss Google Maps quota notice"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
      <ZeroCrumbsWorkspace />
    </ErrorBoundary>
  );
}

