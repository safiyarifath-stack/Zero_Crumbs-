import { useMemo, useState } from 'react';
import {
  Edit3,
  HeartHandshake,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import {
  STORAGE_LOCATIONS,
  type FoodItem,
  type FoodStatus,
  type StorageLocation,
} from '../types';
import {
  formatExpiryStatus,
  formatQuantity,
  formatShortDate,
  getExpiryBucket,
  isItemExpired,
  sortByNearestExpiry,
} from '../utils/foodUtils';
import { FoodImage } from './FoodImage';

interface InventoryViewProps {
  foods: FoodItem[];
  onAddFood: () => void;
  onEditFood: (food: FoodItem) => void;
  onUseFood: (food: FoodItem) => void;
  onDeleteFood: (food: FoodItem) => void;
  onDonateFood: (food: FoodItem) => void;
  onLoadSampleData: () => Promise<void>;
}

export function InventoryView({
  foods,
  onAddFood,
  onEditFood,
  onUseFood,
  onDeleteFood,
  onDonateFood,
  onLoadSampleData,
}: InventoryViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [locationFilter, setLocationFilter] = useState<'All' | StorageLocation>('All');
  const [statusFilter, setStatusFilter] = useState<'all' | FoodStatus>('active');
  const [sortBy, setSortBy] = useState<'expiry' | 'name' | 'quantity'>('expiry');

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const list = foods.filter((item) => {
      if (statusFilter !== 'all' && item.status !== statusFilter) return false;
      if (locationFilter !== 'All' && item.location !== locationFilter) return false;
      if (q && !item.name.toLowerCase().includes(q) && !item.category.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });

    if (sortBy === 'expiry') return sortByNearestExpiry(list);
    if (sortBy === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name));
    return [...list].sort((a, b) => b.quantity - a.quantity);
  }, [foods, searchQuery, locationFilter, statusFilter, sortBy]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-[#1A2820] dark:text-[#EBF2ED]">
            Food Inventory
          </h1>
          <p className="text-sm text-[#5A6A60] dark:text-[#9CB0A4]">
            Search, filter by storage location, manage remaining quantities, and keep items fresh.
          </p>
        </div>
        <button
          type="button"
          onClick={onAddFood}
          className="px-4 py-2.5 rounded-xl bg-[#1B4332] dark:bg-[#2D6A4F] text-white text-sm font-medium hover:bg-[#143325] dark:hover:bg-[#245740] transition-colors inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
        >
          <Plus className="w-4 h-4" />
          Add Food Item
        </button>
      </div>

      {/* Filters Toolbar */}
      <div className="bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-4 space-y-3">
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-[#6B7A70] dark:text-[#90A498] absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search food by name or category..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#FAF9F6] dark:bg-[#0F1713] border border-[#DCE0D8] dark:border-[#2B3B32] text-sm text-[#1A2820] dark:text-[#EBF2ED] focus:outline-none focus:border-[#1B4332] dark:focus:border-[#52B788]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-[#EFEFE9] dark:bg-[#121B16] rounded-xl max-w-full overflow-x-auto no-scrollbar">
              {(['All', ...STORAGE_LOCATIONS] as const).map((loc) => (
                <button
                  key={loc}
                  type="button"
                  onClick={() => setLocationFilter(loc)}
                  className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    locationFilter === loc
                      ? 'bg-white dark:bg-[#21352B] text-[#1A2820] dark:text-[#EBF2ED] shadow-xs'
                      : 'text-[#5A6A60] dark:text-[#9CB0A4] hover:text-[#1A2820] dark:hover:text-[#EBF2ED]'
                  }`}
                >
                  {loc}
                </button>
              ))}
            </div>

            <div className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#FAF9F6] dark:bg-[#0F1713] border border-[#DCE0D8] dark:border-[#2B3B32]">
              <SlidersHorizontal className="w-3.5 h-3.5 text-[#5A6A60] dark:text-[#9CB0A4]" />
              <select
                aria-label="Sort food inventory"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'expiry' | 'name' | 'quantity')}
                className="bg-transparent text-xs font-medium text-[#1A2820] dark:text-[#EBF2ED] focus:outline-none"
              >
                <option value="expiry">Nearest Expiry</option>
                <option value="name">Name (A–Z)</option>
                <option value="quantity">Highest Quantity</option>
              </select>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#ECEEE8] dark:border-[#24322B]">
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                { key: 'active', label: 'In Stock' },
                { key: 'consumed', label: 'Consumed' },
                { key: 'donated', label: 'Donated' },
                { key: 'wasted', label: 'Wasted' },
                { key: 'all', label: 'All History' },
              ] as const
            ).map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setStatusFilter(s.key)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  statusFilter === s.key
                    ? 'bg-[#1B4332] dark:bg-[#2D6A4F] text-white'
                    : 'text-[#5A6A60] dark:text-[#9CB0A4] hover:bg-[#F2F4EF] dark:hover:bg-[#1F2D25]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <span className="text-xs font-mono tabular-nums text-[#5A6A60] dark:text-[#9CB0A4]">
            Showing {filtered.length} item{filtered.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {/* Inventory Grid */}
      {foods.length === 0 ? (
        <div className="bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-12 text-center">
          <p className="text-base font-medium text-[#1A2820] dark:text-[#EBF2ED] mb-1">
            No food items added yet
          </p>
          <p className="text-sm text-[#5A6A60] dark:text-[#9CB0A4] mb-6 max-w-md mx-auto">
            Add groceries manually, ask Zero Crumbs AI, or load sample household data to explore.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={onAddFood}
              className="px-4 py-2.5 rounded-xl bg-[#1B4332] dark:bg-[#2D6A4F] text-white text-sm font-medium hover:bg-[#143325] dark:hover:bg-[#245740] cursor-pointer"
            >
              Add First Food Item
            </button>
            <button
              type="button"
              onClick={() => void onLoadSampleData()}
              className="px-4 py-2.5 rounded-xl border border-[#DCE0D8] dark:border-[#31483B] text-sm font-medium text-[#34443A] dark:text-[#C5D5CC] hover:bg-[#F4F5F2] dark:hover:bg-[#223129] cursor-pointer"
            >
              Load Sample Household Data
            </button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-10 text-center">
          <p className="text-sm font-medium text-[#1A2820] dark:text-[#EBF2ED] mb-1">
            No items match your current filters
          </p>
          <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4]">
            Try clearing your search query or switching storage location.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((item) => {
            const bucket = getExpiryBucket(item.expiryDate);
            const expired = isItemExpired(item.expiryDate);
            const pct =
              item.initialQuantity > 0
                ? Math.min(100, Math.max(0, Math.round((item.quantity / item.initialQuantity) * 100)))
                : 0;

            const statusColor =
              item.status !== 'active'
                ? 'text-[#5A6A60] dark:text-[#9CB0A4]'
                : bucket === 'expired'
                  ? 'text-[#B83B3B] dark:text-[#F29A9A]'
                  : bucket === 'today' || bucket === 'soon'
                    ? 'text-[#B56A1B] dark:text-[#E8B173]'
                    : 'text-[#1B4332] dark:text-[#9CE0B8]';

            return (
              <div
                key={item.id}
                className="bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl overflow-hidden flex flex-col"
              >
                <div className="aspect-[16/9] bg-[#F2F4EF] dark:bg-[#131C17]">
                  <FoodImage src={item.imageUrl} alt={item.name} />
                </div>

                <div className="p-4 flex-1 flex flex-col justify-between gap-4">
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <h3 className="font-display text-base font-semibold text-[#1A2820] dark:text-[#EBF2ED]">
                        {item.name}
                      </h3>
                      <span className="font-mono text-xs font-semibold tabular-nums text-[#1A2820] dark:text-[#EBF2ED] shrink-0">
                        {formatQuantity(item.quantity, item.unit)}
                      </span>
                    </div>

                    <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4] mb-2">
                      {item.location} · {item.category} · {formatShortDate(item.expiryDate)}
                    </p>

                    {/* Remaining quantity meter */}
                    {item.status === 'active' && (
                      <div className="mb-2.5">
                        <div className="h-1.5 w-full rounded-full bg-[#EFEFE9] dark:bg-[#233129] overflow-hidden">
                          <div
                            className="h-full bg-[#52796F] dark:bg-[#52B788] rounded-full transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    )}

                    <p className={`text-xs font-medium ${statusColor}`}>
                      {item.status === 'active'
                        ? formatExpiryStatus(item.expiryDate)
                        : `Status: ${item.status.charAt(0).toUpperCase() + item.status.slice(1)}`}
                    </p>

                    {item.notes && (
                      <p className="mt-2 text-xs text-[#5A6A60] dark:text-[#9CB0A4] line-clamp-2">
                        {item.notes}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 pt-3 border-t border-[#ECEEE8] dark:border-[#24322B]">
                    {item.status === 'active' && (
                      <button
                        type="button"
                        onClick={() => onUseFood(item)}
                        className="flex-1 py-2 px-3 rounded-xl bg-[#1B4332] dark:bg-[#2D6A4F] text-white text-xs font-medium hover:bg-[#143325] dark:hover:bg-[#245740] transition-colors cursor-pointer"
                      >
                        Use Food
                      </button>
                    )}
                    {item.status === 'active' && !expired && (
                      <button
                        type="button"
                        onClick={() => onDonateFood(item)}
                        className="p-2 rounded-xl border border-[#DCE0D8] dark:border-[#31483B] text-[#34443A] dark:text-[#C5D5CC] hover:bg-[#F4F5F2] dark:hover:bg-[#223129] transition-colors cursor-pointer"
                        title="Share surplus on Charity Dashboard"
                        aria-label={`Donate ${item.name}`}
                      >
                        <HeartHandshake className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onEditFood(item)}
                      className="p-2 rounded-xl border border-[#DCE0D8] dark:border-[#31483B] text-[#34443A] dark:text-[#C5D5CC] hover:bg-[#F4F5F2] dark:hover:bg-[#223129] transition-colors cursor-pointer"
                      title="Edit food item"
                      aria-label={`Edit ${item.name}`}
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteFood(item)}
                      className="p-2 rounded-xl border border-[#DCE0D8] dark:border-[#31483B] text-[#B83B3B] dark:text-[#F29A9A] hover:bg-[#FDF2EC] dark:hover:bg-[#2B1B18] transition-colors cursor-pointer"
                      title="Delete food item"
                      aria-label={`Delete ${item.name}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
