import {
  AlertCircle,
  ArrowRight,
  Clock,
  HeartHandshake,
  Package,
  Plus,
  Sparkles,
} from 'lucide-react';
import type { FoodItem, NavPage, UserProfile } from '../types';
import {
  formatExpiryStatus,
  formatQuantity,
  formatShortDate,
  getExpiryBucket,
  sortByNearestExpiry,
} from '../utils/foodUtils';
import { FoodImage } from './FoodImage';

interface HomeDashboardProps {
  profile: UserProfile | null;
  foods: FoodItem[];
  onNavigate: (page: NavPage) => void;
  onUseFood: (food: FoodItem) => void;
  onDonateFood: (food: FoodItem) => void;
  onOpenAi: () => void;
  onLoadSampleData: () => Promise<void>;
}

export function HomeDashboard({
  profile,
  foods,
  onNavigate,
  onUseFood,
  onDonateFood,
  onOpenAi,
  onLoadSampleData,
}: HomeDashboardProps) {
  const activeFoods = sortByNearestExpiry(foods.filter((f) => f.status === 'active'));
  const expiredItems = activeFoods.filter((f) => getExpiryBucket(f.expiryDate) === 'expired');
  const expiringWithin3 = activeFoods.filter((f) => {
    const b = getExpiryBucket(f.expiryDate, 3);
    return b === 'today' || b === 'soon';
  });
  const freshItems = activeFoods.filter((f) => getExpiryBucket(f.expiryDate, 3) === 'fresh');
  const needsAttention = [...expiredItems, ...expiringWithin3];

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = profile?.fullName?.split(' ')[0] || 'there';

  return (
    <div className="space-y-8">
      {/* Personalized Welcome */}
      <section className="bg-white border border-[#E5E7E2] rounded-2xl p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-[#52796F]">
            Save Food. Reduce Waste. Share Goodness.
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-[#1A2820] text-balance">
            {greeting}, {firstName}
          </h1>
          <p className="text-sm text-[#5A6A60] max-w-xl">
            {needsAttention.length > 0
              ? `You have ${needsAttention.length} item${needsAttention.length === 1 ? '' : 's'} needing attention right now. Prioritizing soon-to-expire items keeps your kitchen zero-waste.`
              : activeFoods.length > 0
                ? 'Everything in your household pantry, fridge, and freezer is currently fresh.'
                : 'Your kitchen inventory is ready. Add your first groceries or load sample household items to explore.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => onNavigate('add-food')}
            className="px-4 py-2.5 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors inline-flex items-center gap-2 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            Add Food
          </button>
          <button
            type="button"
            onClick={onOpenAi}
            className="px-4 py-2.5 rounded-xl bg-[#FBE8DC] text-[#7D3A24] text-sm font-medium hover:bg-[#F5DACA] transition-colors inline-flex items-center gap-2 cursor-pointer whitespace-nowrap"
          >
            <Sparkles className="w-4 h-4" />
            Open AI Assistant
          </button>
        </div>
      </section>

      {/* Four Overview Cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <button
          type="button"
          onClick={() => onNavigate('expiring')}
          className="text-left bg-white border border-[#E5E7E2] rounded-2xl p-5 hover:border-[#D9A79B] transition-colors cursor-pointer"
        >
          <p className="text-xs font-medium text-[#5A6A60] mb-2">Expired Items</p>
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-3xl font-semibold tabular-nums text-[#B83B3B]">
              {expiredItems.length}
            </span>
            <span className="text-xs font-medium text-[#B83B3B]">Dispose safely</span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('expiring')}
          className="text-left bg-white border border-[#E5E7E2] rounded-2xl p-5 hover:border-[#DFB889] transition-colors cursor-pointer"
        >
          <p className="text-xs font-medium text-[#5A6A60] mb-2">Expiring Within 3 Days</p>
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-3xl font-semibold tabular-nums text-[#B56A1B]">
              {expiringWithin3.length}
            </span>
            <span className="text-xs font-medium text-[#B56A1B]">Use or share soon</span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('inventory')}
          className="text-left bg-white border border-[#E5E7E2] rounded-2xl p-5 hover:border-[#B8D0BF] transition-colors cursor-pointer"
        >
          <p className="text-xs font-medium text-[#5A6A60] mb-2">Fresh Food Items</p>
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-3xl font-semibold tabular-nums text-[#1B4332]">
              {freshItems.length}
            </span>
            <span className="text-xs font-medium text-[#355E4B]">Healthy shelf life</span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('inventory')}
          className="text-left bg-white border border-[#E5E7E2] rounded-2xl p-5 hover:border-[#C5CCC5] transition-colors cursor-pointer"
        >
          <p className="text-xs font-medium text-[#5A6A60] mb-2">Total Food Items</p>
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-3xl font-semibold tabular-nums text-[#1A2820]">
              {activeFoods.length}
            </span>
            <span className="text-xs text-[#5A6A60]">Active in storage</span>
          </div>
        </button>
      </section>

      {/* Quick Actions Strip */}
      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <button
          type="button"
          onClick={() => onNavigate('add-food')}
          className="p-3.5 rounded-xl bg-white border border-[#E5E7E2] hover:bg-[#F2F4EF] transition-colors text-left cursor-pointer"
        >
          <Plus className="w-4 h-4 text-[#1B4332] mb-2" />
          <p className="text-sm font-medium text-[#1A2820]">Add Food</p>
        </button>
        <button
          type="button"
          onClick={() => onNavigate('expiring')}
          className="p-3.5 rounded-xl bg-white border border-[#E5E7E2] hover:bg-[#F2F4EF] transition-colors text-left cursor-pointer"
        >
          <Clock className="w-4 h-4 text-[#B56A1B] mb-2" />
          <p className="text-sm font-medium text-[#1A2820]">View Expiring Items</p>
        </button>
        <button
          type="button"
          onClick={() => onNavigate('inventory')}
          className="p-3.5 rounded-xl bg-white border border-[#E5E7E2] hover:bg-[#F2F4EF] transition-colors text-left cursor-pointer"
        >
          <Package className="w-4 h-4 text-[#355E4B] mb-2" />
          <p className="text-sm font-medium text-[#1A2820]">Open Food Inventory</p>
        </button>
        <button
          type="button"
          onClick={() => onNavigate('charity')}
          className="p-3.5 rounded-xl bg-white border border-[#E5E7E2] hover:bg-[#F2F4EF] transition-colors text-left cursor-pointer"
        >
          <HeartHandshake className="w-4 h-4 text-[#C86D51] mb-2" />
          <p className="text-sm font-medium text-[#1A2820]">Open Charity Dashboard</p>
        </button>
        <button
          type="button"
          onClick={onOpenAi}
          className="col-span-2 sm:col-span-1 p-3.5 rounded-xl bg-white border border-[#E5E7E2] hover:bg-[#F2F4EF] transition-colors text-left cursor-pointer"
        >
          <Sparkles className="w-4 h-4 text-[#1B4332] mb-2" />
          <p className="text-sm font-medium text-[#1A2820]">Open AI Assistant</p>
        </button>
      </section>

      {/* Needs Attention Section */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold text-[#1A2820]">Needs Attention</h2>
            <p className="text-xs text-[#5A6A60]">
              Expired and soon-to-expire items sorted by nearest expiry date.
            </p>
          </div>
          {needsAttention.length > 0 && (
            <button
              type="button"
              onClick={() => onNavigate('expiring')}
              className="text-xs font-medium text-[#1B4332] hover:underline inline-flex items-center gap-1 cursor-pointer"
            >
              Open Expiring Dashboard
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {activeFoods.length === 0 ? (
          <div className="bg-white border border-[#E5E7E2] rounded-2xl p-10 text-center">
            <p className="text-base font-medium text-[#1A2820] mb-1">
              Your Zero Crumbs inventory is currently empty
            </p>
            <p className="text-sm text-[#5A6A60] mb-6 max-w-md mx-auto">
              Start by adding groceries from your fridge, freezer, or pantry, or load clearly
              labelled sample household items to test expiry alerts and Zero Crumbs AI.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => onNavigate('add-food')}
                className="px-4 py-2.5 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors cursor-pointer"
              >
                Add First Food Item
              </button>
              <button
                type="button"
                onClick={() => void onLoadSampleData()}
                className="px-4 py-2.5 rounded-xl border border-[#DCE0D8] text-sm font-medium text-[#34443A] hover:bg-[#F4F5F2] transition-colors cursor-pointer"
              >
                Load Sample Household Data
              </button>
            </div>
          </div>
        ) : needsAttention.length === 0 ? (
          <div className="bg-white border border-[#E5E7E2] rounded-2xl p-8 text-center">
            <p className="text-sm font-medium text-[#1B4332] mb-1">
              Nothing expiring within the next 3 days
            </p>
            <p className="text-xs text-[#5A6A60]">
              All {activeFoods.length} tracked food items are fresh.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {needsAttention.map((item) => {
              const bucket = getExpiryBucket(item.expiryDate);
              const isExpired = bucket === 'expired';

              return (
                <div
                  key={item.id}
                  className="bg-white border border-[#E5E7E2] rounded-2xl overflow-hidden flex flex-col"
                >
                  <div className="aspect-[16/9] bg-[#F2F4EF] relative">
                    <FoodImage src={item.imageUrl} alt={item.name} />
                  </div>
                  <div className="p-4 flex-1 flex flex-col justify-between gap-4">
                    <div>
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <h3 className="font-display text-base font-semibold text-[#1A2820]">
                          {item.name}
                        </h3>
                        <span className="font-mono text-xs font-medium tabular-nums text-[#1A2820] shrink-0">
                          {formatQuantity(item.quantity, item.unit)}
                        </span>
                      </div>
                      <p className="text-xs text-[#5A6A60] mb-2">
                        {item.location} · Expires {formatShortDate(item.expiryDate)}
                      </p>
                      <p
                        className={`text-xs font-medium inline-flex items-center gap-1.5 ${
                          isExpired ? 'text-[#B83B3B]' : 'text-[#B56A1B]'
                        }`}
                      >
                        <AlertCircle className="w-3.5 h-3.5" />
                        {formatExpiryStatus(item.expiryDate)}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 pt-3 border-t border-[#ECEEE8]">
                      <button
                        type="button"
                        onClick={() => onUseFood(item)}
                        className="flex-1 py-2 px-3 rounded-xl bg-[#1B4332] text-white text-xs font-medium hover:bg-[#143325] transition-colors cursor-pointer"
                      >
                        {isExpired ? 'Dispose / Mark Wasted' : 'Use Food'}
                      </button>
                      {!isExpired && (
                        <button
                          type="button"
                          onClick={() => onDonateFood(item)}
                          className="py-2 px-3 rounded-xl border border-[#DCE0D8] text-xs font-medium text-[#34443A] hover:bg-[#F4F5F2] transition-colors cursor-pointer"
                        >
                          Donate
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
