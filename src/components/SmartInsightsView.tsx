import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Sparkles, TrendingDown } from 'lucide-react';
import type { DonationListing, FoodItem, QuantityHistoryEntry } from '../types';
import { getDaysUntilExpiry } from '../utils/foodUtils';

interface SmartInsightsViewProps {
  foods: FoodItem[];
  donations: DonationListing[];
  quantityHistory: QuantityHistoryEntry[];
  onAskAiInsights: () => void;
}

export function SmartInsightsView({
  foods,
  donations,
  quantityHistory,
  onAskAiInsights,
}: SmartInsightsViewProps) {
  const activeFoods = foods.filter((f) => f.status === 'active');
  const consumedFoods = foods.filter((f) => f.status === 'consumed');
  const wastedFoods = foods.filter((f) => f.status === 'wasted');
  const donatedItemsCount =
    foods.filter((f) => f.status === 'donated').length +
    donations.filter((d) => d.status === 'Donated' || d.status === 'Collected').length;

  const outcomeData = useMemo(
    () => [
      { name: 'Stored', value: activeFoods.length, color: '#52796F' },
      { name: 'Consumed', value: consumedFoods.length, color: '#1B4332' },
      { name: 'Donated', value: donatedItemsCount, color: '#C86D51' },
      { name: 'Wasted', value: wastedFoods.length, color: '#B83B3B' },
    ],
    [activeFoods.length, consumedFoods.length, donatedItemsCount, wastedFoods.length]
  );

  const expiryTrendData = useMemo(() => {
    const buckets = [
      { label: 'Expired', count: 0 },
      { label: 'Today', count: 0 },
      { label: '1–3 Days', count: 0 },
      { label: '4–7 Days', count: 0 },
      { label: '8–14 Days', count: 0 },
      { label: '15+ Days', count: 0 },
    ];
    for (const item of activeFoods) {
      const d = getDaysUntilExpiry(item.expiryDate);
      if (d < 0) buckets[0].count += 1;
      else if (d === 0) buckets[1].count += 1;
      else if (d <= 3) buckets[2].count += 1;
      else if (d <= 7) buckets[3].count += 1;
      else if (d <= 14) buckets[4].count += 1;
      else buckets[5].count += 1;
    }
    return buckets;
  }, [activeFoods]);

  const mostUsedItems = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of quantityHistory) {
      if (entry.changeType === 'used' || entry.changeType === 'completed') {
        counts.set(entry.foodName, (counts.get(entry.foodName) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [quantityHistory]);

  const frequentlyWasted = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of wastedFoods) {
      counts.set(item.name, (counts.get(item.name) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [wastedFoods]);

  const recommendations = useMemo(() => {
    const tips: string[] = [];
    const expiringSoon = activeFoods.filter((f) => {
      const d = getDaysUntilExpiry(f.expiryDate);
      return d >= 0 && d <= 3;
    });
    if (expiringSoon.length > 0) {
      tips.push(
        `Plan meals around ${expiringSoon
          .slice(0, 3)
          .map((i) => i.name)
          .join(', ')} over the next 3 days to prevent waste.`
      );
    }
    if (frequentlyWasted.length > 0) {
      tips.push(
        `You have marked ${frequentlyWasted[0][0]} as wasted before — try buying smaller pack sizes or freezing extra portions.`
      );
    }
    const lowStock = activeFoods.filter(
      (f) => f.initialQuantity > 0 && f.quantity / f.initialQuantity <= 0.25
    );
    if (lowStock.length > 0) {
      tips.push(
        `Low remaining stock detected on ${lowStock
          .slice(0, 3)
          .map((i) => i.name)
          .join(', ')}. Consider adding them to your next shopping list.`
      );
    }
    if (tips.length === 0) {
      tips.push(
        'Keep logging consumption with the Use Food button so Zero Crumbs can tailor your shopping and waste-reduction insights.'
      );
    }
    return tips;
  }, [activeFoods, frequentlyWasted]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-[#1A2820]">
            Smart Insights & Reports
          </h1>
          <p className="text-sm text-[#5A6A60]">
            Visual analytics across stored food, consumption habits, donations, and expiry trends.
          </p>
        </div>

        <button
          type="button"
          onClick={onAskAiInsights}
          className="px-4 py-2.5 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors inline-flex items-center gap-2 cursor-pointer whitespace-nowrap"
        >
          <Sparkles className="w-4 h-4" />
          Generate AI Shopping & Waste Plan
        </button>
      </div>

      {/* Summary KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5">
          <p className="text-xs font-medium text-[#5A6A60] mb-1">Currently Stored</p>
          <p className="font-mono text-2xl font-semibold tabular-nums text-[#1A2820]">
            {activeFoods.length}
          </p>
        </div>
        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5">
          <p className="text-xs font-medium text-[#5A6A60] mb-1">Food Consumed</p>
          <p className="font-mono text-2xl font-semibold tabular-nums text-[#1B4332]">
            {consumedFoods.length}
          </p>
        </div>
        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5">
          <p className="text-xs font-medium text-[#5A6A60] mb-1">Food Donated</p>
          <p className="font-mono text-2xl font-semibold tabular-nums text-[#C86D51]">
            {donatedItemsCount}
          </p>
        </div>
        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5">
          <p className="text-xs font-medium text-[#5A6A60] mb-1">Food Wasted</p>
          <p className="font-mono text-2xl font-semibold tabular-nums text-[#B83B3B]">
            {wastedFoods.length}
          </p>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-6">
          <h2 className="font-display text-base font-semibold text-[#1A2820] mb-1">
            Upcoming Expiry Trends
          </h2>
          <p className="text-xs text-[#5A6A60] mb-5">
            Distribution of active food items across upcoming expiry windows.
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={expiryTrendData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ECEEE8" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#5A6A60' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#5A6A60' }} />
                <Tooltip
                  contentStyle={{
                    borderRadius: '12px',
                    border: '1px solid #E5E7E2',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="count" name="Items" fill="#52796F" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-6">
          <h2 className="font-display text-base font-semibold text-[#1A2820] mb-1">
            Food Outcome Breakdown
          </h2>
          <p className="text-xs text-[#5A6A60] mb-5">
            Stored vs. Consumed vs. Donated vs. Wasted items across your account.
          </p>
          <div className="w-full flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="w-full sm:w-2/3 h-52 sm:h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={outcomeData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={3}
                  >
                    {outcomeData.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="w-full sm:w-1/3 space-y-2.5 text-xs">
              {outcomeData.map((d) => (
                <div key={d.name} className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-[#34443A]">
                    <span
                      className="w-2.5 h-2.5 rounded-sm inline-block"
                      style={{ backgroundColor: d.color }}
                    />
                    {d.name}
                  </span>
                  <span className="font-mono font-semibold tabular-nums text-[#1A2820]">
                    {d.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Lists + Recommendations */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5">
          <h3 className="font-display text-sm font-semibold text-[#1A2820] mb-3">
            Most-Used Food Items
          </h3>
          {mostUsedItems.length === 0 ? (
            <p className="text-xs text-[#5A6A60]">
              Record consumption via “Use Food” to see your household staples.
            </p>
          ) : (
            <div className="space-y-2.5">
              {mostUsedItems.map(([name, count]) => (
                <div key={name} className="flex items-center justify-between text-xs">
                  <span className="text-[#1A2820] font-medium">{name}</span>
                  <span className="font-mono tabular-nums text-[#5A6A60]">{count} uses</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5">
          <h3 className="font-display text-sm font-semibold text-[#1A2820] mb-3">
            Frequently Wasted Food
          </h3>
          {frequentlyWasted.length === 0 ? (
            <p className="text-xs text-[#1B4332]">
              Zero wasted items recorded so far — keep up the great habit!
            </p>
          ) : (
            <div className="space-y-2.5">
              {frequentlyWasted.map(([name, count]) => (
                <div key={name} className="flex items-center justify-between text-xs">
                  <span className="text-[#B83B3B] font-medium">{name}</span>
                  <span className="font-mono tabular-nums text-[#5A6A60]">{count}x wasted</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-[#E5E7E2] rounded-2xl p-5">
          <h3 className="font-display text-sm font-semibold text-[#1A2820] mb-3 flex items-center gap-2">
            <TrendingDown className="w-4 h-4 text-[#1B4332]" />
            Waste-Reduction Tips
          </h3>
          <ul className="space-y-2.5 text-xs text-[#4F5E55] leading-relaxed">
            {recommendations.map((tip, idx) => (
              <li key={idx}>• {tip}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
