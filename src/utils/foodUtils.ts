import type { Timestamp } from 'firebase/firestore';
import {
  FOOD_IMAGE_PRESETS,
  type FoodCategory,
  type FoodItem,
  type FoodUnit,
} from '../types';

export function getTodayIsoDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysIsoDate(days: number): string {
  const now = new Date();
  now.setDate(now.getDate() + days);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getDaysUntilExpiry(expiryDate: string): number {
  const todayStr = getTodayIsoDate();
  const [ey, em, ed] = expiryDate.split('-').map(Number);
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const expUtc = Date.UTC(ey || 2026, (em || 1) - 1, ed || 1);
  const todayUtc = Date.UTC(ty || 2026, (tm || 1) - 1, td || 1);
  return Math.round((expUtc - todayUtc) / (1000 * 60 * 60 * 24));
}

export type ExpiryBucket = 'expired' | 'today' | 'soon' | 'fresh';

export function getExpiryBucket(expiryDate: string, soonDays = 3): ExpiryBucket {
  const diff = getDaysUntilExpiry(expiryDate);
  if (diff < 0) return 'expired';
  if (diff === 0) return 'today';
  if (diff <= soonDays) return 'soon';
  return 'fresh';
}

export function formatExpiryStatus(expiryDate: string): string {
  const diff = getDaysUntilExpiry(expiryDate);
  if (diff < -1) return `Expired ${Math.abs(diff)} days ago`;
  if (diff === -1) return 'Expired yesterday';
  if (diff === 0) return 'Expires today';
  if (diff === 1) return 'Expires tomorrow';
  if (diff <= 3) return `Expires in ${diff} days`;
  return `Fresh · ${diff} days left`;
}

export function isItemExpired(expiryDate: string): boolean {
  return getDaysUntilExpiry(expiryDate) < 0;
}

export function formatShortDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatTimestamp(ts?: Timestamp | null): string {
  if (!ts) return 'Just now';
  try {
    const date = ts.toDate();
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return 'Just now';
  }
}

export function getCompatibleUnits(unit: FoodUnit): FoodUnit[] {
  if (unit === 'l' || unit === 'ml') return ['l', 'ml'];
  if (unit === 'kg' || unit === 'g') return ['kg', 'g'];
  return [unit];
}

export function convertUnitAmount(
  amount: number,
  fromUnit: FoodUnit,
  toUnit: FoodUnit
): number | null {
  if (fromUnit === toUnit) return amount;
  if (fromUnit === 'ml' && toUnit === 'l') return amount / 1000;
  if (fromUnit === 'l' && toUnit === 'ml') return amount * 1000;
  if (fromUnit === 'g' && toUnit === 'kg') return amount / 1000;
  if (fromUnit === 'kg' && toUnit === 'g') return amount * 1000;
  return null;
}

export function formatQuantity(value: number, unit: string): string {
  const rounded = Math.round(value * 1000) / 1000;
  return `${rounded} ${unit}`;
}

export function getRecommendedPresetImage(category: FoodCategory, name = ''): string {
  const lower = name.toLowerCase();
  if (
    category === 'Dairy & Eggs' ||
    category === 'Bakery' ||
    lower.includes('milk') ||
    lower.includes('bread') ||
    lower.includes('egg') ||
    lower.includes('yogurt') ||
    lower.includes('cheese')
  ) {
    return FOOD_IMAGE_PRESETS[1].url;
  }
  if (
    category === 'Grains & Pantry' ||
    lower.includes('oat') ||
    lower.includes('rice') ||
    lower.includes('lentil') ||
    lower.includes('pasta') ||
    lower.includes('flour')
  ) {
    return FOOD_IMAGE_PRESETS[2].url;
  }
  if (
    category === 'Prepared Meals' ||
    category === 'Proteins' ||
    category === 'Frozen' ||
    lower.includes('berry') ||
    lower.includes('berries') ||
    lower.includes('soup') ||
    lower.includes('salad')
  ) {
    return FOOD_IMAGE_PRESETS[3].url;
  }
  return FOOD_IMAGE_PRESETS[0].url;
}

export function sortByNearestExpiry(items: FoodItem[]): FoodItem[] {
  return [...items].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
}

export function sanitizeIdSegment(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${rand}`.replace(/[^a-zA-Z0-9_-]/g, '');
}

export async function compressImageToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose a valid image file (JPEG, PNG, or WebP).');
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read the selected image file.'));
      el.src = objectUrl;
    });

    const maxWidth = 480;
    const maxHeight = 360;
    const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Browser canvas is unavailable for image processing.');
    }
    ctx.drawImage(img, 0, 0, width, height);

    let dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    if (dataUrl.length > 90000) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.5);
    }
    if (dataUrl.length > 95000) {
      throw new Error('Selected image is too large even after compression. Please pick a smaller image.');
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
