import React, { useState } from 'react';
import { Check, History, Minus, Plus, Trash2, X } from 'lucide-react';
import type { FoodItem, FoodUnit, QuantityHistoryEntry } from '../types';
import {
  convertUnitAmount,
  formatQuantity,
  formatTimestamp,
  getCompatibleUnits,
} from '../utils/foodUtils';
import { FoodImage } from './FoodImage';

interface UseFoodModalProps {
  food: FoodItem | null;
  history: QuantityHistoryEntry[];
  onAdjust: (options: {
    mode: 'use' | 'increase' | 'complete' | 'waste';
    amount?: number;
    amountUnit?: FoodUnit;
    note?: string;
  }) => Promise<void>;
  onClose: () => void;
}

export function UseFoodModal({ food, history, onAdjust, onClose }: UseFoodModalProps) {
  const [tab, setTab] = useState<'use' | 'increase' | 'history'>('use');
  const [amount, setAmount] = useState('');
  const [selectedUnit, setSelectedUnit] = useState<FoodUnit>(food?.unit || 'pcs');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!food) return null;

  const compatibleUnits = getCompatibleUnits(food.unit);
  const activeUnit = compatibleUnits.includes(selectedUnit) ? selectedUnit : food.unit;
  const itemHistory = history.filter((h) => h.foodId === food.id);

  const numericAmount = Number(amount);
  const convertedPreview =
    !Number.isNaN(numericAmount) && numericAmount > 0
      ? convertUnitAmount(numericAmount, activeUnit, food.unit)
      : null;

  const projectedRemaining =
    convertedPreview !== null
      ? tab === 'use'
        ? Math.max(0, Math.round((food.quantity - convertedPreview) * 1000) / 1000)
        : Math.round((food.quantity + convertedPreview) * 1000) / 1000
      : food.quantity;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (Number.isNaN(numericAmount) || numericAmount <= 0) {
      setError('Please enter a positive quantity greater than 0.');
      return;
    }
    setLoading(true);
    try {
      await onAdjust({
        mode: tab === 'increase' ? 'increase' : 'use',
        amount: numericAmount,
        amountUnit: activeUnit,
        note: note.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update quantity.');
    } finally {
      setLoading(false);
    }
  }

  async function handleQuickAction(mode: 'complete' | 'waste') {
    setError('');
    setLoading(true);
    try {
      await onAdjust({ mode });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1A2820]/40 dark:bg-black/65 backdrop-blur-[2px] p-3 sm:p-4 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-4 sm:p-6 shadow-xl my-auto max-h-[92dvh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-4 pb-4 mb-5 border-b border-[#E5E7E2] dark:border-[#27362E]">
          <div className="flex items-center gap-3.5">
            <div className="w-14 h-14 rounded-xl overflow-hidden border border-[#E5E7E2] dark:border-[#27362E] shrink-0">
              <FoodImage src={food.imageUrl} alt={food.name} />
            </div>
            <div>
              <h2 className="font-display text-lg font-semibold text-[#1A2820] dark:text-[#EBF2ED]">
                {food.name}
              </h2>
              <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4] font-mono tabular-nums">
                Currently remaining:{' '}
                <strong className="text-[#1A2820] dark:text-[#EBF2ED]">
                  {formatQuantity(food.quantity, food.unit)}
                </strong>{' '}
                · {food.location}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-[#5A6A60] dark:text-[#9CB0A4] hover:bg-[#F2F4EF] dark:hover:bg-[#1F2D25] cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-1 p-1 bg-[#EFEFE9] dark:bg-[#121B16] rounded-xl mb-5">
          <button
            type="button"
            onClick={() => {
              setTab('use');
              setError('');
            }}
            className={`py-2 px-2 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
              tab === 'use'
                ? 'bg-white dark:bg-[#21352B] text-[#1A2820] dark:text-[#EBF2ED] shadow-xs'
                : 'text-[#5A6A60] dark:text-[#9CB0A4]'
            }`}
          >
            <Minus className="w-3.5 h-3.5" />
            Use Food
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('increase');
              setError('');
            }}
            className={`py-2 px-2 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
              tab === 'increase'
                ? 'bg-white dark:bg-[#21352B] text-[#1A2820] dark:text-[#EBF2ED] shadow-xs'
                : 'text-[#5A6A60] dark:text-[#9CB0A4]'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            Add Stock
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('history');
              setError('');
            }}
            className={`py-2 px-2 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
              tab === 'history'
                ? 'bg-white dark:bg-[#21352B] text-[#1A2820] dark:text-[#EBF2ED] shadow-xs'
                : 'text-[#5A6A60] dark:text-[#9CB0A4]'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            History ({itemHistory.length})
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-xl bg-[#FDF2EC] dark:bg-[#331B1B] border border-[#EBC6BA] dark:border-[#6B3232] text-sm text-[#9E2F2F] dark:text-[#FCA5A5]">
            {error}
          </div>
        )}

        {tab !== 'history' ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-[#34443A] dark:text-[#B8C7BE] mb-1.5">
                  {tab === 'use' ? 'Amount Consumed' : 'Amount Added'}
                </label>
                <input
                  type="number"
                  step="any"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={food.unit === 'l' ? 'e.g. 500 (if ml) or 0.5' : 'Enter amount'}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#0F1713] border border-[#DCE0D8] dark:border-[#2B3B32] text-sm font-mono tabular-nums text-[#1A2820] dark:text-[#EBF2ED] focus:outline-none focus:border-[#1B4332] dark:focus:border-[#52B788]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#34443A] dark:text-[#B8C7BE] mb-1.5">
                  Unit
                </label>
                <select
                  value={activeUnit}
                  onChange={(e) => setSelectedUnit(e.target.value as FoodUnit)}
                  className="w-full px-3 py-2.5 rounded-xl bg-white dark:bg-[#0F1713] border border-[#DCE0D8] dark:border-[#2B3B32] text-sm text-[#1A2820] dark:text-[#EBF2ED] focus:outline-none focus:border-[#1B4332] dark:focus:border-[#52B788]"
                >
                  {compatibleUnits.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {convertedPreview !== null && (
              <div className="p-3 rounded-xl bg-[#F2F4EF] dark:bg-[#1B3328] text-xs text-[#2D4739] dark:text-[#CBE0D2] flex items-center justify-between">
                <span>Projected remaining quantity:</span>
                <span className="font-mono font-semibold tabular-nums">
                  {formatQuantity(projectedRemaining, food.unit)}
                </span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-[#34443A] dark:text-[#B8C7BE] mb-1.5">
                Note (optional)
              </label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={tab === 'use' ? 'e.g., Used for breakfast' : 'e.g., Bought extra pack'}
                className="w-full px-3.5 py-2 rounded-xl bg-white dark:bg-[#0F1713] border border-[#DCE0D8] dark:border-[#2B3B32] text-sm text-[#1A2820] dark:text-[#EBF2ED] focus:outline-none focus:border-[#1B4332] dark:focus:border-[#52B788]"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-xl bg-[#1B4332] dark:bg-[#2D6A4F] text-white text-sm font-medium hover:bg-[#143325] dark:hover:bg-[#245740] transition-colors cursor-pointer disabled:opacity-60"
            >
              {loading
                ? 'Updating...'
                : tab === 'use'
                  ? 'Confirm Consumption'
                  : 'Confirm Quantity Increase'}
            </button>

            {tab === 'use' && (
              <div className="pt-4 border-t border-[#E5E7E2] dark:border-[#27362E] grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => handleQuickAction('complete')}
                  className="py-2 px-3 rounded-xl border border-[#CFE0D2] dark:border-[#2E4D3E] bg-[#EEF3EC] dark:bg-[#1B3328] text-[#1B4332] dark:text-[#82C9A5] text-xs font-medium hover:bg-[#E1ECE0] dark:hover:bg-[#244234] transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                  Mark Completely Used
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => handleQuickAction('waste')}
                  className="py-2 px-3 rounded-xl border border-[#F0CFC4] dark:border-[#6B3232] bg-[#FDF2EC] dark:bg-[#331B1B] text-[#9E2F2F] dark:text-[#FCA5A5] text-xs font-medium hover:bg-[#FAE4DA] dark:hover:bg-[#472323] transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Mark as Spoiled / Wasted
                </button>
              </div>
            )}
          </form>
        ) : (
          <div className="max-h-72 overflow-y-auto divide-y divide-[#E5E7E2] dark:divide-[#27362E]">
            {itemHistory.length === 0 ? (
              <p className="py-8 text-center text-sm text-[#5A6A60] dark:text-[#9CB0A4]">
                No quantity changes recorded for this item yet.
              </p>
            ) : (
              itemHistory.map((entry) => (
                <div key={entry.id} className="py-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-[#1A2820] dark:text-[#EBF2ED] capitalize">
                      {entry.changeType} ·{' '}
                      <span className="font-mono tabular-nums">
                        {entry.delta > 0 ? `+${entry.delta}` : entry.delta} {entry.unit}
                      </span>
                    </p>
                    <p className="text-xs text-[#5A6A60] dark:text-[#9CB0A4]">{entry.note}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-mono tabular-nums text-[#1A2820] dark:text-[#EBF2ED]">
                      → {formatQuantity(entry.newQuantity, entry.unit)}
                    </p>
                    <p className="text-[11px] text-[#6B7A70] dark:text-[#869B8F]">
                      {formatTimestamp(entry.createdAt)}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
