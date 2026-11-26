import React, { useEffect, useState } from 'react';
import { Upload, X } from 'lucide-react';
import {
  FOOD_CATEGORIES,
  FOOD_IMAGE_PRESETS,
  FOOD_UNITS,
  STORAGE_LOCATIONS,
  type FoodCategory,
  type FoodItem,
  type FoodUnit,
  type StorageLocation,
} from '../types';
import type { AddFoodInput } from '../services/firestoreService';
import {
  addDaysIsoDate,
  compressImageToDataUrl,
  getRecommendedPresetImage,
} from '../utils/foodUtils';
import { FoodImage } from './FoodImage';

interface FoodFormProps {
  initialItem?: FoodItem | null;
  defaultLocation?: StorageLocation;
  isModal?: boolean;
  onSave: (data: AddFoodInput) => Promise<void>;
  onCancel?: () => void;
}

export function FoodForm({
  initialItem,
  defaultLocation = 'Fridge',
  isModal = false,
  onSave,
  onCancel,
}: FoodFormProps) {
  const [name, setName] = useState(initialItem?.name || '');
  const [quantity, setQuantity] = useState(initialItem ? String(initialItem.quantity) : '1');
  const [unit, setUnit] = useState<FoodUnit>(initialItem?.unit || 'pcs');
  const [location, setLocation] = useState<StorageLocation>(
    initialItem?.location || defaultLocation
  );
  const [category, setCategory] = useState<FoodCategory>(initialItem?.category || 'Produce');
  const [expiryDate, setExpiryDate] = useState(initialItem?.expiryDate || addDaysIsoDate(5));
  const [imageUrl, setImageUrl] = useState(
    initialItem?.imageUrl || getRecommendedPresetImage('Produce', '')
  );
  const [customImageUsed, setCustomImageUsed] = useState(
    Boolean(initialItem?.imageUrl?.startsWith('data:image/'))
  );
  const [notes, setNotes] = useState(initialItem?.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!initialItem && !customImageUsed) {
      setImageUrl(getRecommendedPresetImage(category, name));
    }
  }, [category, name, initialItem, customImageUsed]);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const compressed = await compressImageToDataUrl(file);
      setImageUrl(compressed);
      setCustomImageUsed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload image.');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const cleanName = name.trim();
    const numericQty = Number(quantity);

    if (!cleanName) {
      setError('Please enter a food name.');
      return;
    }
    if (Number.isNaN(numericQty) || numericQty <= 0) {
      setError('Quantity must be a positive number greater than 0.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      setError('Please choose a valid expiry date.');
      return;
    }

    setSaving(true);
    try {
      await onSave({
        name: cleanName,
        category,
        quantity: numericQty,
        unit,
        location,
        expiryDate,
        imageUrl,
        notes: notes.trim(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save food item.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="p-3.5 rounded-xl bg-[#FDF2EC] border border-[#EBC6BA] text-sm text-[#9E2F2F]">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-[#34443A] mb-1.5">
            Food Name *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Organic Whole Milk, Baby Spinach, Sourdough Loaf"
            maxLength={120}
            className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-[#34443A] mb-1.5">
            Quantity *
          </label>
          <input
            type="number"
            step="any"
            min="0.01"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm font-mono tabular-nums text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-[#34443A] mb-1.5">
            Unit of Measurement *
          </label>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as FoodUnit)}
            className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
          >
            {FOOD_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-[#34443A] mb-1.5">
            Storage Location *
          </label>
          <div className="grid grid-cols-3 gap-2">
            {STORAGE_LOCATIONS.map((loc) => (
              <button
                key={loc}
                type="button"
                onClick={() => setLocation(loc)}
                className={`py-2 px-3 rounded-xl text-sm font-medium border transition-colors cursor-pointer ${
                  location === loc
                    ? 'bg-[#1B4332] text-white border-[#1B4332]'
                    : 'bg-white text-[#34443A] border-[#DCE0D8] hover:bg-[#F4F5F2]'
                }`}
              >
                {loc}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-[#34443A] mb-1.5">
            Expiry Date *
          </label>
          <input
            type="date"
            value={expiryDate}
            onChange={(e) => setExpiryDate(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm font-mono tabular-nums text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-[#34443A] mb-1.5">
            Category
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as FoodCategory)}
            className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
          >
            {FOOD_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-[#34443A] mb-1.5">
            Optional Notes
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g., Opened Monday, use in pasta"
            maxLength={500}
            className="w-full px-3.5 py-2.5 rounded-xl bg-white border border-[#DCE0D8] text-sm text-[#1A2820] focus:outline-none focus:border-[#1B4332]"
          />
        </div>
      </div>

      {/* Image Presets & Custom Upload */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium text-[#34443A]">
            Food Image (Preset or Custom Upload)
          </label>
          <label className="inline-flex items-center gap-1.5 text-xs font-medium text-[#1B4332] hover:underline cursor-pointer">
            <Upload className="w-3.5 h-3.5" />
            Upload custom image
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {FOOD_IMAGE_PRESETS.map((preset) => {
            const active = imageUrl === preset.url;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  setImageUrl(preset.url);
                  setCustomImageUsed(false);
                }}
                className={`group rounded-xl overflow-hidden border text-left transition-all cursor-pointer ${
                  active
                    ? 'border-[#1B4332] ring-2 ring-[#1B4332]/20'
                    : 'border-[#E5E7E2] hover:border-[#B8C4BA]'
                }`}
              >
                <div className="aspect-[4/3] bg-[#F2F4EF]">
                  <FoodImage src={preset.url} alt={preset.label} />
                </div>
                <div className="px-2 py-1.5 text-[11px] font-medium text-[#34443A] truncate bg-white">
                  {preset.label}
                </div>
              </button>
            );
          })}

          {customImageUsed && (
            <div className="rounded-xl overflow-hidden border border-[#1B4332] ring-2 ring-[#1B4332]/20 bg-white">
              <div className="aspect-[4/3]">
                <FoodImage src={imageUrl} alt="Custom upload" />
              </div>
              <div className="px-2 py-1.5 text-[11px] font-medium text-[#1B4332] truncate">
                Custom Upload
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-[#E5E7E2]">
        {isModal && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2.5 rounded-xl border border-[#DCE0D8] text-sm font-medium text-[#34443A] hover:bg-[#F4F5F2] transition-colors cursor-pointer"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={saving}
          className="px-5 py-2.5 rounded-xl bg-[#1B4332] text-white text-sm font-medium hover:bg-[#143325] transition-colors cursor-pointer disabled:opacity-60"
        >
          {saving ? 'Saving...' : initialItem ? 'Save Changes' : 'Add to Inventory'}
        </button>
      </div>
    </form>
  );
}

interface FoodModalProps {
  open: boolean;
  initialItem?: FoodItem | null;
  defaultLocation?: StorageLocation;
  onSave: (data: AddFoodInput) => Promise<void>;
  onClose: () => void;
}

export function FoodModal({
  open,
  initialItem,
  defaultLocation,
  onSave,
  onClose,
}: FoodModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1A2820]/40 backdrop-blur-[2px] p-3 sm:p-4 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-2xl bg-white border border-[#E5E7E2] rounded-2xl p-4 sm:p-6 shadow-xl my-auto max-h-[92dvh] overflow-y-auto"
      >
        <div className="flex items-center justify-between pb-4 mb-5 border-b border-[#E5E7E2]">
          <div>
            <h2 className="font-display text-lg font-semibold text-[#1A2820]">
              {initialItem ? `Edit ${initialItem.name}` : 'Add New Food Item'}
            </h2>
            <p className="text-xs text-[#5A6A60]">
              Track exact quantities, storage location, and expiry date.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-[#5A6A60] hover:bg-[#F2F4EF] cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <FoodForm
          initialItem={initialItem}
          defaultLocation={defaultLocation}
          isModal
          onSave={async (data) => {
            await onSave(data);
            onClose();
          }}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
