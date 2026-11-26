import type { Timestamp } from 'firebase/firestore';

export const FOOD_UNITS = [
  'g',
  'kg',
  'ml',
  'l',
  'pcs',
  'packs',
  'cups',
  'tbsp',
  'bottles',
  'cans',
] as const;

export type FoodUnit = (typeof FOOD_UNITS)[number];

export const FOOD_CATEGORIES = [
  'Produce',
  'Dairy & Eggs',
  'Bakery',
  'Grains & Pantry',
  'Proteins',
  'Prepared Meals',
  'Beverages',
  'Frozen',
  'Other',
] as const;

export type FoodCategory = (typeof FOOD_CATEGORIES)[number];

export const STORAGE_LOCATIONS = ['Fridge', 'Freezer', 'Pantry'] as const;
export type StorageLocation = (typeof STORAGE_LOCATIONS)[number];

export const DONATION_STATUSES = [
  'Available',
  'Requested',
  'Approved',
  'Collected',
  'Donated',
  'Cancelled',
] as const;

export type DonationStatus = (typeof DONATION_STATUSES)[number];

export const ORGANIZATION_TYPES = [
  'Community Pantry',
  'Food Bank',
  'Shelter',
  'Verified NGO',
  'Local Volunteer',
] as const;

export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

export type FoodStatus = 'active' | 'consumed' | 'wasted' | 'donated';

export type NavPage =
  | 'home'
  | 'expiring'
  | 'inventory'
  | 'add-food'
  | 'charity'
  | 'ai'
  | 'activity'
  | 'insights'
  | 'settings';

export interface UserProfile {
  uid: string;
  fullName: string;
  username: string;
  email: string;
  phoneNumber?: string;
  householdSize: number;
  defaultLocation: StorageLocation;
  reminderDaysBefore: number;
  browserNotificationsEnabled: boolean;
  emailRemindersEnabled: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface FoodItem {
  id: string;
  userId: string;
  name: string;
  category: FoodCategory;
  quantity: number;
  initialQuantity: number;
  unit: FoodUnit;
  location: StorageLocation;
  expiryDate: string; // YYYY-MM-DD
  imageUrl: string;
  notes: string;
  status: FoodStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface QuantityHistoryEntry {
  id: string;
  userId: string;
  foodId: string;
  foodName: string;
  changeType: 'added' | 'used' | 'increased' | 'adjusted' | 'completed' | 'wasted' | 'donated';
  delta: number;
  previousQuantity: number;
  newQuantity: number;
  unit: FoodUnit;
  note: string;
  source: 'manual' | 'ai';
  createdAt?: Timestamp;
}

export interface DonationListing {
  id: string;
  userId: string;
  foodId: string;
  foodName: string;
  quantity: number;
  unit: FoodUnit;
  category: FoodCategory;
  expiryDate: string;
  imageUrl: string;
  pickupLocation: string;
  contactInfo: string;
  notes: string;
  status: DonationStatus;
  charityPartner: string;
  safetyConfirmed: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface DonationRequest {
  id: string;
  userId: string;
  donationId: string;
  foodName: string;
  requesterName: string;
  organizationType: OrganizationType;
  requestedQuantity: number;
  unit: FoodUnit;
  pickupWindow: string;
  message: string;
  status: 'Pending' | 'Approved' | 'Collected' | 'Declined';
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type ActivityActionType =
  | 'food_added'
  | 'food_edited'
  | 'quantity_increased'
  | 'quantity_decreased'
  | 'food_consumed'
  | 'food_wasted'
  | 'food_deleted'
  | 'donation_created'
  | 'donation_updated'
  | 'donation_completed'
  | 'donation_cancelled'
  | 'ai_action'
  | 'settings_updated';

export interface ActivityLog {
  id: string;
  userId: string;
  action: ActivityActionType;
  itemName: string;
  details: string;
  source: 'user' | 'ai';
  createdAt?: Timestamp;
}

export interface AiActionRecord {
  id: string;
  userId: string;
  instruction: string;
  actionType: string;
  summary: string;
  status: 'confirmed' | 'failed' | 'cancelled';
  errorMessage: string;
  createdAt?: Timestamp;
}

export interface PendingAiAction {
  actionId: string;
  type:
    | 'add_food'
    | 'use_food'
    | 'increase_food'
    | 'update_food'
    | 'delete_food'
    | 'create_donation'
    | 'update_donation_status';
  title: string;
  description: string;
  requiresConfirmation: boolean;
  payload: Record<string, unknown>;
  executionState?: 'pending' | 'executing' | 'confirmed' | 'failed' | 'cancelled';
  executionMessage?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  pendingActions?: PendingAiAction[];
  originalInstruction?: string;
}

export const FOOD_IMAGE_PRESETS: Array<{ id: string; label: string; url: string }> = [
  {
    id: 'produce',
    label: 'Fresh Produce',
    url: '/src/assets/images/preset_fresh_produce_1795687183404.jpg',
  },
  {
    id: 'dairy',
    label: 'Dairy & Bakery',
    url: '/src/assets/images/preset_dairy_bakery_1795687183100.jpg',
  },
  {
    id: 'pantry',
    label: 'Pantry Staples',
    url: '/src/assets/images/preset_pantry_staples_1795687183099.jpg',
  },
  {
    id: 'meals',
    label: 'Prepared & Berries',
    url: '/src/assets/images/preset_prepared_meals_1795687183099.jpg',
  },
];

export const HERO_PANTRY_IMAGE = '/src/assets/images/hero_fresh_pantry_1795687181575.jpg';
