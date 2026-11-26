import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  ActivityActionType,
  ActivityLog,
  AiActionRecord,
  DonationListing,
  DonationRequest,
  DonationStatus,
  FoodCategory,
  FoodItem,
  FoodUnit,
  OrganizationType,
  PendingAiAction,
  QuantityHistoryEntry,
  StorageLocation,
  UserProfile,
} from '../types';
import {
  addDaysIsoDate,
  convertUnitAmount,
  getRecommendedPresetImage,
  isItemExpired,
  sanitizeIdSegment,
} from '../utils/foodUtils';

function cleanUsername(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40);
  return cleaned.length >= 2 ? cleaned : `member_${Date.now().toString().slice(-4)}`;
}

export async function ensureUserProfile(
  user: User,
  overrides?: { fullName?: string; username?: string; email?: string; phoneNumber?: string }
): Promise<UserProfile> {
  const path = `users/${user.uid}`;
  try {
    const ref = doc(db, 'users', user.uid);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      return snap.data() as UserProfile;
    }

    const rawEmail = (overrides?.email ?? user.email ?? '').trim().slice(0, 160);
    const rawPhone = (overrides?.phoneNumber ?? user.phoneNumber ?? '').trim().slice(0, 20);
    const email = rawEmail || (rawPhone ? '' : 'user@zerocrumbs.app');
    const fallbackName =
      email ? email.split('@')[0] : rawPhone ? `Member ${rawPhone.slice(-4)}` : 'Zero Crumbs Member';
    const fullName = (overrides?.fullName || user.displayName || fallbackName).trim().slice(0, 100);
    const username = cleanUsername(
      overrides?.username || (email ? email.split('@')[0] : '') || (rawPhone ? `user_${rawPhone.slice(-6)}` : 'member')
    );

    const profileData: Record<string, unknown> = {
      uid: user.uid,
      fullName: fullName || 'Zero Crumbs Member',
      username,
      email,
      householdSize: 2,
      defaultLocation: 'Fridge' as StorageLocation,
      reminderDaysBefore: 3,
      browserNotificationsEnabled: false,
      emailRemindersEnabled: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (rawPhone) {
      profileData.phoneNumber = rawPhone;
    }

    await setDoc(ref, profileData);
    const createdSnap = await getDoc(ref);
    return createdSnap.data() as UserProfile;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function updateUserProfile(
  userId: string,
  updates: Partial<
    Pick<
      UserProfile,
      | 'fullName'
      | 'username'
      | 'email'
      | 'phoneNumber'
      | 'householdSize'
      | 'defaultLocation'
      | 'reminderDaysBefore'
      | 'browserNotificationsEnabled'
      | 'emailRemindersEnabled'
    >
  >
): Promise<void> {
  const path = `users/${userId}`;
  try {
    const batch = writeBatch(db);
    const userRef = doc(db, 'users', userId);
    const payload: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
    };
    if (updates.fullName !== undefined) payload.fullName = updates.fullName.trim().slice(0, 100);
    if (updates.username !== undefined) payload.username = cleanUsername(updates.username);
    if (updates.email !== undefined) payload.email = updates.email.trim().slice(0, 160);
    if (updates.phoneNumber !== undefined) payload.phoneNumber = updates.phoneNumber.trim().slice(0, 20);
    if (updates.householdSize !== undefined)
      payload.householdSize = Math.min(20, Math.max(1, Math.round(updates.householdSize)));
    if (updates.defaultLocation !== undefined) payload.defaultLocation = updates.defaultLocation;
    if (updates.reminderDaysBefore !== undefined)
      payload.reminderDaysBefore = Math.min(14, Math.max(1, Math.round(updates.reminderDaysBefore)));
    if (updates.browserNotificationsEnabled !== undefined)
      payload.browserNotificationsEnabled = Boolean(updates.browserNotificationsEnabled);
    if (updates.emailRemindersEnabled !== undefined)
      payload.emailRemindersEnabled = Boolean(updates.emailRemindersEnabled);

    batch.update(userRef, payload);

    const logId = sanitizeIdSegment('log');
    const logRef = doc(db, 'users', userId, 'activityLogs', logId);
    batch.set(logRef, {
      id: logId,
      userId,
      action: 'settings_updated' satisfies ActivityActionType,
      itemName: 'Account & Reminder Settings',
      details: 'Updated profile preferences or expiry notification settings.',
      source: 'user',
      createdAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export function subscribeUserCollections(
  userId: string,
  callbacks: {
    onProfile: (profile: UserProfile | null) => void;
    onFoods: (foods: FoodItem[]) => void;
    onQuantityHistory: (entries: QuantityHistoryEntry[]) => void;
    onDonations: (donations: DonationListing[]) => void;
    onDonationRequests: (requests: DonationRequest[]) => void;
    onActivityLogs: (logs: ActivityLog[]) => void;
    onAiActions: (actions: AiActionRecord[]) => void;
  }
): () => void {
  const unsubs: Unsubscribe[] = [];

  unsubs.push(
    onSnapshot(
      doc(db, 'users', userId),
      (snap) => {
        callbacks.onProfile(snap.exists() ? (snap.data() as UserProfile) : null);
      },
      (err) => handleFirestoreError(err, OperationType.GET, `users/${userId}`)
    )
  );

  unsubs.push(
    onSnapshot(
      query(
        collection(db, 'users', userId, 'foods'),
        where('userId', '==', userId),
        orderBy('expiryDate', 'asc')
      ),
      (snap) => {
        callbacks.onFoods(snap.docs.map((d) => d.data() as FoodItem));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `users/${userId}/foods`)
    )
  );

  unsubs.push(
    onSnapshot(
      query(
        collection(db, 'users', userId, 'quantityHistory'),
        where('userId', '==', userId),
        orderBy('createdAt', 'desc')
      ),
      (snap) => {
        callbacks.onQuantityHistory(snap.docs.map((d) => d.data() as QuantityHistoryEntry));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `users/${userId}/quantityHistory`)
    )
  );

  unsubs.push(
    onSnapshot(
      query(
        collection(db, 'users', userId, 'donations'),
        where('userId', '==', userId),
        orderBy('createdAt', 'desc')
      ),
      (snap) => {
        callbacks.onDonations(snap.docs.map((d) => d.data() as DonationListing));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `users/${userId}/donations`)
    )
  );

  unsubs.push(
    onSnapshot(
      query(
        collection(db, 'users', userId, 'donationRequests'),
        where('userId', '==', userId),
        orderBy('createdAt', 'desc')
      ),
      (snap) => {
        callbacks.onDonationRequests(snap.docs.map((d) => d.data() as DonationRequest));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `users/${userId}/donationRequests`)
    )
  );

  unsubs.push(
    onSnapshot(
      query(
        collection(db, 'users', userId, 'activityLogs'),
        where('userId', '==', userId),
        orderBy('createdAt', 'desc')
      ),
      (snap) => {
        callbacks.onActivityLogs(snap.docs.map((d) => d.data() as ActivityLog));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `users/${userId}/activityLogs`)
    )
  );

  unsubs.push(
    onSnapshot(
      query(
        collection(db, 'users', userId, 'aiActions'),
        where('userId', '==', userId),
        orderBy('createdAt', 'desc')
      ),
      (snap) => {
        callbacks.onAiActions(snap.docs.map((d) => d.data() as AiActionRecord));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `users/${userId}/aiActions`)
    )
  );

  return () => {
    unsubs.forEach((u) => u());
  };
}

export interface AddFoodInput {
  name: string;
  category: FoodCategory;
  quantity: number;
  unit: FoodUnit;
  location: StorageLocation;
  expiryDate: string;
  imageUrl?: string;
  notes?: string;
}

export async function addFoodItem(
  userId: string,
  input: AddFoodInput,
  source: 'manual' | 'ai' = 'manual'
): Promise<string> {
  const foodId = sanitizeIdSegment('food');
  const path = `users/${userId}/foods/${foodId}`;
  try {
    const batch = writeBatch(db);
    const qty = Math.max(0.01, Number(input.quantity));
    const safeName = input.name.trim().slice(0, 120);
    const imageUrl =
      input.imageUrl && input.imageUrl.trim().length > 0
        ? input.imageUrl.trim()
        : getRecommendedPresetImage(input.category, safeName);

    batch.set(doc(db, 'users', userId, 'foods', foodId), {
      id: foodId,
      userId,
      name: safeName,
      category: input.category,
      quantity: qty,
      initialQuantity: qty,
      unit: input.unit,
      location: input.location,
      expiryDate: input.expiryDate,
      imageUrl,
      notes: (input.notes || '').trim().slice(0, 500),
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const qhId = sanitizeIdSegment('qh');
    batch.set(doc(db, 'users', userId, 'quantityHistory', qhId), {
      id: qhId,
      userId,
      foodId,
      foodName: safeName,
      changeType: 'added',
      delta: qty,
      previousQuantity: 0,
      newQuantity: qty,
      unit: input.unit,
      note: `Added to ${input.location}`,
      source,
      createdAt: serverTimestamp(),
    });

    const logId = sanitizeIdSegment('log');
    batch.set(doc(db, 'users', userId, 'activityLogs', logId), {
      id: logId,
      userId,
      action: 'food_added' satisfies ActivityActionType,
      itemName: safeName,
      details: `Added ${qty} ${input.unit} in ${input.location} (expires ${input.expiryDate}).`,
      source: source === 'ai' ? 'ai' : 'user',
      createdAt: serverTimestamp(),
    });

    await batch.commit();
    return foodId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function editFoodItem(
  userId: string,
  food: FoodItem,
  updates: Partial<AddFoodInput> & { status?: FoodItem['status'] },
  source: 'manual' | 'ai' = 'manual'
): Promise<void> {
  const path = `users/${userId}/foods/${food.id}`;
  try {
    const batch = writeBatch(db);
    const newName = (updates.name ?? food.name).trim().slice(0, 120);
    const newQty = updates.quantity !== undefined ? Math.max(0, Number(updates.quantity)) : food.quantity;
    const newInitial = Math.max(food.initialQuantity, newQty, 0.01);

    batch.update(doc(db, 'users', userId, 'foods', food.id), {
      name: newName,
      category: updates.category ?? food.category,
      quantity: newQty,
      initialQuantity: newInitial,
      unit: updates.unit ?? food.unit,
      location: updates.location ?? food.location,
      expiryDate: updates.expiryDate ?? food.expiryDate,
      imageUrl: updates.imageUrl ?? food.imageUrl,
      notes: (updates.notes ?? food.notes).trim().slice(0, 500),
      status: updates.status ?? food.status,
      updatedAt: serverTimestamp(),
    });

    const logId = sanitizeIdSegment('log');
    batch.set(doc(db, 'users', userId, 'activityLogs', logId), {
      id: logId,
      userId,
      action: 'food_edited' satisfies ActivityActionType,
      itemName: newName,
      details: `Updated details (${newQty} ${updates.unit ?? food.unit}, ${updates.location ?? food.location}).`,
      source: source === 'ai' ? 'ai' : 'user',
      createdAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function adjustFoodQuantity(
  userId: string,
  food: FoodItem,
  options: {
    mode: 'use' | 'increase' | 'complete' | 'waste';
    amount?: number;
    amountUnit?: FoodUnit;
    note?: string;
    source?: 'manual' | 'ai';
  }
): Promise<{ newQuantity: number; newStatus: FoodItem['status'] }> {
  const path = `users/${userId}/foods/${food.id}`;
  const source = options.source || 'manual';
  const unitUsed = options.amountUnit || food.unit;

  let convertedDelta = 0;
  if (options.mode === 'use' || options.mode === 'increase') {
    const rawAmount = Number(options.amount || 0);
    if (rawAmount <= 0) {
      throw new Error('Please enter a positive quantity greater than zero.');
    }
    const converted = convertUnitAmount(rawAmount, unitUsed, food.unit);
    if (converted === null) {
      throw new Error(`Cannot convert ${unitUsed} to ${food.unit}.`);
    }
    convertedDelta = converted;
  }

  let newQuantity = food.quantity;
  let newStatus: FoodItem['status'] = food.status;
  let changeType: QuantityHistoryEntry['changeType'] = 'used';
  let logAction: ActivityActionType = 'quantity_decreased';
  let details = '';

  if (options.mode === 'use') {
    newQuantity = Math.max(0, Math.round((food.quantity - convertedDelta) * 1000) / 1000);
    if (newQuantity <= 0) {
      newQuantity = 0;
      newStatus = 'consumed';
      changeType = 'completed';
      logAction = 'food_consumed';
      details = `Used ${options.amount} ${unitUsed}; ${food.name} is now completely consumed.`;
    } else {
      changeType = 'used';
      logAction = 'quantity_decreased';
      details = `Used ${options.amount} ${unitUsed}; ${newQuantity} ${food.unit} remaining.`;
    }
  } else if (options.mode === 'increase') {
    newQuantity = Math.round((food.quantity + convertedDelta) * 1000) / 1000;
    newStatus = 'active';
    changeType = 'increased';
    logAction = 'quantity_increased';
    details = `Added ${options.amount} ${unitUsed}; ${newQuantity} ${food.unit} now in stock.`;
  } else if (options.mode === 'complete') {
    convertedDelta = food.quantity;
    newQuantity = 0;
    newStatus = 'consumed';
    changeType = 'completed';
    logAction = 'food_consumed';
    details = `Marked ${food.name} (${food.quantity} ${food.unit}) as completely consumed.`;
  } else if (options.mode === 'waste') {
    convertedDelta = food.quantity;
    newQuantity = 0;
    newStatus = 'wasted';
    changeType = 'wasted';
    logAction = 'food_wasted';
    details = `Marked ${food.name} (${food.quantity} ${food.unit}) as wasted/disposed.`;
  }

  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', userId, 'foods', food.id), {
      quantity: newQuantity,
      status: newStatus,
      updatedAt: serverTimestamp(),
    });

    const qhId = sanitizeIdSegment('qh');
    batch.set(doc(db, 'users', userId, 'quantityHistory', qhId), {
      id: qhId,
      userId,
      foodId: food.id,
      foodName: food.name,
      changeType,
      delta: options.mode === 'increase' ? convertedDelta : -convertedDelta,
      previousQuantity: food.quantity,
      newQuantity,
      unit: food.unit,
      note: (options.note || details).slice(0, 300),
      source,
      createdAt: serverTimestamp(),
    });

    const logId = sanitizeIdSegment('log');
    batch.set(doc(db, 'users', userId, 'activityLogs', logId), {
      id: logId,
      userId,
      action: logAction,
      itemName: food.name,
      details: details.slice(0, 400),
      source: source === 'ai' ? 'ai' : 'user',
      createdAt: serverTimestamp(),
    });

    await batch.commit();
    return { newQuantity, newStatus };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteFoodItem(
  userId: string,
  food: FoodItem,
  source: 'manual' | 'ai' = 'manual'
): Promise<void> {
  const path = `users/${userId}/foods/${food.id}`;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'users', userId, 'foods', food.id));

    const logId = sanitizeIdSegment('log');
    batch.set(doc(db, 'users', userId, 'activityLogs', logId), {
      id: logId,
      userId,
      action: 'food_deleted' satisfies ActivityActionType,
      itemName: food.name,
      details: `Removed ${food.quantity} ${food.unit} from ${food.location}.`,
      source: source === 'ai' ? 'ai' : 'user',
      createdAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export interface CreateDonationInput {
  foodId?: string;
  foodName: string;
  quantity: number;
  unit: FoodUnit;
  category: FoodCategory;
  expiryDate: string;
  imageUrl?: string;
  pickupLocation: string;
  contactInfo: string;
  notes?: string;
  charityPartner?: string;
  safetyConfirmed: boolean;
  sourceFoodItem?: FoodItem | null;
}

export async function createDonationListing(
  userId: string,
  input: CreateDonationInput,
  source: 'manual' | 'ai' = 'manual'
): Promise<string> {
  if (isItemExpired(input.expiryDate)) {
    throw new Error('Food safety check failed: Expired food cannot be listed for donation.');
  }
  if (!input.safetyConfirmed) {
    throw new Error('Please confirm the food safety check before publishing a donation listing.');
  }

  const donationId = sanitizeIdSegment('don');
  const path = `users/${userId}/donations/${donationId}`;
  try {
    const batch = writeBatch(db);
    const safeName = input.foodName.trim().slice(0, 120);
    const qty = Math.max(0.01, Number(input.quantity));
    const imageUrl =
      input.imageUrl && input.imageUrl.trim().length > 0
        ? input.imageUrl.trim()
        : getRecommendedPresetImage(input.category, safeName);

    batch.set(doc(db, 'users', userId, 'donations', donationId), {
      id: donationId,
      userId,
      foodId: input.foodId || input.sourceFoodItem?.id || 'standalone',
      foodName: safeName,
      quantity: qty,
      unit: input.unit,
      category: input.category,
      expiryDate: input.expiryDate,
      imageUrl,
      pickupLocation: input.pickupLocation.trim().slice(0, 200),
      contactInfo: input.contactInfo.trim().slice(0, 150),
      notes: (input.notes || '').trim().slice(0, 500),
      status: 'Available' satisfies DonationStatus,
      charityPartner: (input.charityPartner || '').trim().slice(0, 120),
      safetyConfirmed: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    if (input.sourceFoodItem) {
      const srcFood = input.sourceFoodItem;
      const converted = convertUnitAmount(qty, input.unit, srcFood.unit) ?? qty;
      const remaining = Math.max(0, Math.round((srcFood.quantity - converted) * 1000) / 1000);
      batch.update(doc(db, 'users', userId, 'foods', srcFood.id), {
        quantity: remaining,
        status: remaining <= 0 ? 'donated' : 'active',
        updatedAt: serverTimestamp(),
      });

      const qhId = sanitizeIdSegment('qh');
      batch.set(doc(db, 'users', userId, 'quantityHistory', qhId), {
        id: qhId,
        userId,
        foodId: srcFood.id,
        foodName: srcFood.name,
        changeType: 'donated',
        delta: -converted,
        previousQuantity: srcFood.quantity,
        newQuantity: remaining,
        unit: srcFood.unit,
        note: `Listed ${qty} ${input.unit} for charity donation`,
        source,
        createdAt: serverTimestamp(),
      });
    }

    const logId = sanitizeIdSegment('log');
    batch.set(doc(db, 'users', userId, 'activityLogs', logId), {
      id: logId,
      userId,
      action: 'donation_created' satisfies ActivityActionType,
      itemName: safeName,
      details: `Listed ${qty} ${input.unit} for donation at ${input.pickupLocation.trim()}.`,
      source: source === 'ai' ? 'ai' : 'user',
      createdAt: serverTimestamp(),
    });

    await batch.commit();
    return donationId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateDonationDetails(
  userId: string,
  donation: DonationListing,
  updates: Partial<
    Pick<
      DonationListing,
      | 'foodName'
      | 'quantity'
      | 'unit'
      | 'category'
      | 'expiryDate'
      | 'imageUrl'
      | 'pickupLocation'
      | 'contactInfo'
      | 'notes'
      | 'charityPartner'
    >
  >
): Promise<void> {
  const path = `users/${userId}/donations/${donation.id}`;
  const exp = updates.expiryDate ?? donation.expiryDate;
  if (isItemExpired(exp)) {
    throw new Error('Food safety check failed: Expiry date cannot be in the past.');
  }
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', userId, 'donations', donation.id), {
      foodName: (updates.foodName ?? donation.foodName).trim().slice(0, 120),
      quantity: Math.max(0.01, Number(updates.quantity ?? donation.quantity)),
      unit: updates.unit ?? donation.unit,
      category: updates.category ?? donation.category,
      expiryDate: exp,
      imageUrl: updates.imageUrl ?? donation.imageUrl,
      pickupLocation: (updates.pickupLocation ?? donation.pickupLocation).trim().slice(0, 200),
      contactInfo: (updates.contactInfo ?? donation.contactInfo).trim().slice(0, 150),
      notes: (updates.notes ?? donation.notes).trim().slice(0, 500),
      charityPartner: (updates.charityPartner ?? donation.charityPartner).trim().slice(0, 120),
      updatedAt: serverTimestamp(),
    });

    const logId = sanitizeIdSegment('log');
    batch.set(doc(db, 'users', userId, 'activityLogs', logId), {
      id: logId,
      userId,
      action: 'donation_updated' satisfies ActivityActionType,
      itemName: (updates.foodName ?? donation.foodName).trim().slice(0, 120),
      details: 'Updated donation listing details.',
      source: 'user',
      createdAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function transitionDonationStatus(
  userId: string,
  donation: DonationListing,
  newStatus: DonationStatus,
  charityPartner?: string,
  source: 'manual' | 'ai' = 'manual'
): Promise<void> {
  const path = `users/${userId}/donations/${donation.id}`;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', userId, 'donations', donation.id), {
      status: newStatus,
      charityPartner: (charityPartner ?? donation.charityPartner).trim().slice(0, 120),
      updatedAt: serverTimestamp(),
    });

    const action: ActivityActionType =
      newStatus === 'Donated' || newStatus === 'Collected'
        ? 'donation_completed'
        : newStatus === 'Cancelled'
          ? 'donation_cancelled'
          : 'donation_updated';

    const logId = sanitizeIdSegment('log');
    batch.set(doc(db, 'users', userId, 'activityLogs', logId), {
      id: logId,
      userId,
      action,
      itemName: donation.foodName,
      details: `Donation status updated to ${newStatus}${charityPartner ? ` (${charityPartner})` : ''}.`,
      source: source === 'ai' ? 'ai' : 'user',
      createdAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteDonationListing(userId: string, donationId: string): Promise<void> {
  const path = `users/${userId}/donations/${donationId}`;
  try {
    await deleteDoc(doc(db, 'users', userId, 'donations', donationId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function createDonationRequest(
  userId: string,
  donation: DonationListing,
  input: {
    requesterName: string;
    organizationType: OrganizationType;
    requestedQuantity: number;
    pickupWindow: string;
    message?: string;
  }
): Promise<string> {
  const reqId = sanitizeIdSegment('req');
  const path = `users/${userId}/donationRequests/${reqId}`;
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', userId, 'donationRequests', reqId), {
      id: reqId,
      userId,
      donationId: donation.id,
      foodName: donation.foodName,
      requesterName: input.requesterName.trim().slice(0, 120),
      organizationType: input.organizationType,
      requestedQuantity: Math.max(0.01, Math.min(donation.quantity, Number(input.requestedQuantity))),
      unit: donation.unit,
      pickupWindow: input.pickupWindow.trim().slice(0, 120),
      message: (input.message || '').trim().slice(0, 400),
      status: 'Pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    if (donation.status === 'Available') {
      batch.update(doc(db, 'users', userId, 'donations', donation.id), {
        status: 'Requested',
        charityPartner: input.requesterName.trim().slice(0, 120),
        updatedAt: serverTimestamp(),
      });
    }

    const logId = sanitizeIdSegment('log');
    batch.set(doc(db, 'users', userId, 'activityLogs', logId), {
      id: logId,
      userId,
      action: 'donation_updated' satisfies ActivityActionType,
      itemName: donation.foodName,
      details: `Received pickup request from ${input.requesterName.trim()} (${input.organizationType}).`,
      source: 'user',
      createdAt: serverTimestamp(),
    });

    await batch.commit();
    return reqId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateDonationRequestStatus(
  userId: string,
  requestItem: DonationRequest,
  donation: DonationListing | undefined,
  newRequestStatus: 'Approved' | 'Collected' | 'Declined'
): Promise<void> {
  const path = `users/${userId}/donationRequests/${requestItem.id}`;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', userId, 'donationRequests', requestItem.id), {
      status: newRequestStatus,
      updatedAt: serverTimestamp(),
    });

    if (donation && donation.status !== 'Donated' && donation.status !== 'Cancelled') {
      const nextDonStatus: DonationStatus =
        newRequestStatus === 'Approved'
          ? 'Approved'
          : newRequestStatus === 'Collected'
            ? 'Donated'
            : 'Available';
      batch.update(doc(db, 'users', userId, 'donations', donation.id), {
        status: nextDonStatus,
        charityPartner:
          newRequestStatus === 'Declined' ? '' : requestItem.requesterName.slice(0, 120),
        updatedAt: serverTimestamp(),
      });
    }

    const logId = sanitizeIdSegment('log');
    batch.set(doc(db, 'users', userId, 'activityLogs', logId), {
      id: logId,
      userId,
      action:
        newRequestStatus === 'Collected'
          ? ('donation_completed' satisfies ActivityActionType)
          : ('donation_updated' satisfies ActivityActionType),
      itemName: requestItem.foodName,
      details: `Pickup request from ${requestItem.requesterName} marked ${newRequestStatus}.`,
      source: 'user',
      createdAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function recordAiActionOutcome(
  userId: string,
  instruction: string,
  action: PendingAiAction,
  status: 'confirmed' | 'failed' | 'cancelled',
  errorMessage = ''
): Promise<void> {
  const actionRecordId = sanitizeIdSegment('aia');
  const path = `users/${userId}/aiActions/${actionRecordId}`;
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', userId, 'aiActions', actionRecordId), {
      id: actionRecordId,
      userId,
      instruction: instruction.slice(0, 500) || action.title,
      actionType: action.type,
      summary: action.description.slice(0, 400),
      status,
      errorMessage: errorMessage.slice(0, 300),
      createdAt: serverTimestamp(),
    });

    const logId = sanitizeIdSegment('log');
    batch.set(doc(db, 'users', userId, 'activityLogs', logId), {
      id: logId,
      userId,
      action: 'ai_action' satisfies ActivityActionType,
      itemName: action.title.slice(0, 140),
      details:
        status === 'confirmed'
          ? `Zero Crumbs AI executed: ${action.description}`.slice(0, 400)
          : status === 'cancelled'
            ? `Cancelled AI proposal: ${action.title}`.slice(0, 400)
            : `AI action failed: ${errorMessage}`.slice(0, 400),
      source: 'ai',
      createdAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function executeConfirmedAiAction(
  userId: string,
  action: PendingAiAction,
  foods: FoodItem[],
  donations: DonationListing[],
  instruction: string
): Promise<string> {
  const p = action.payload;

  try {
    let resultMessage = '';

    if (action.type === 'add_food') {
      await addFoodItem(
        userId,
        {
          name: String(p.name || 'Food Item'),
          quantity: Number(p.quantity || 1),
          unit: (p.unit as FoodUnit) || 'pcs',
          location: (p.location as StorageLocation) || 'Fridge',
          expiryDate: String(p.expiryDate || addDaysIsoDate(5)),
          category: (p.category as FoodCategory) || 'Other',
          notes: String(p.notes || ''),
        },
        'ai'
      );
      resultMessage = `Added ${p.quantity} ${p.unit} of ${p.name} to ${p.location}.`;
    } else if (action.type === 'use_food') {
      const target = foods.find((f) => f.id === p.foodId);
      if (!target) throw new Error('Food item no longer exists in your inventory.');
      const res = await adjustFoodQuantity(userId, target, {
        mode: p.markCompletelyUsed ? 'complete' : 'use',
        amount: Number(p.amountUsed || 0),
        amountUnit: (p.unit as FoodUnit) || target.unit,
        note: `Updated via Zero Crumbs AI`,
        source: 'ai',
      });
      resultMessage =
        res.newStatus === 'consumed'
          ? `${target.name} marked as completely consumed.`
          : `Updated ${target.name} to ${res.newQuantity} ${target.unit} remaining.`;
    } else if (action.type === 'increase_food') {
      const target = foods.find((f) => f.id === p.foodId);
      if (!target) throw new Error('Food item no longer exists in your inventory.');
      const res = await adjustFoodQuantity(userId, target, {
        mode: 'increase',
        amount: Number(p.amountAdded || 0),
        amountUnit: (p.unit as FoodUnit) || target.unit,
        note: `Replenished via Zero Crumbs AI`,
        source: 'ai',
      });
      resultMessage = `Updated ${target.name} to ${res.newQuantity} ${target.unit}.`;
    } else if (action.type === 'update_food') {
      const target = foods.find((f) => f.id === p.foodId);
      if (!target) throw new Error('Food item no longer exists in your inventory.');
      await editFoodItem(
        userId,
        target,
        {
          name: p.newName ? String(p.newName) : target.name,
          location: (p.location as StorageLocation) || target.location,
          expiryDate: p.expiryDate ? String(p.expiryDate) : target.expiryDate,
          category: (p.category as FoodCategory) || target.category,
          notes: p.notes !== undefined ? String(p.notes) : target.notes,
        },
        'ai'
      );
      resultMessage = `Updated details for ${target.name}.`;
    } else if (action.type === 'delete_food') {
      const target = foods.find((f) => f.id === p.foodId);
      if (!target) throw new Error('Food item was already removed.');
      await deleteFoodItem(userId, target, 'ai');
      resultMessage = `Deleted ${target.name} from your inventory.`;
    } else if (action.type === 'create_donation') {
      const sourceFood = foods.find((f) => f.id === p.foodId) || null;
      await createDonationListing(
        userId,
        {
          foodId: String(p.foodId || 'standalone'),
          foodName: String(p.foodName || 'Surplus Food'),
          quantity: Number(p.quantity || 1),
          unit: (p.unit as FoodUnit) || 'pcs',
          category: (p.category as FoodCategory) || 'Other',
          expiryDate: String(p.expiryDate || addDaysIsoDate(2)),
          pickupLocation: String(p.pickupLocation || 'Home Porch'),
          contactInfo: String(p.contactInfo || 'Zero Crumbs Member'),
          notes: String(p.notes || ''),
          safetyConfirmed: true,
          sourceFoodItem: sourceFood,
        },
        'ai'
      );
      resultMessage = `Published donation listing for ${p.quantity} ${p.unit} of ${p.foodName}.`;
    } else if (action.type === 'update_donation_status') {
      const targetDon = donations.find((d) => d.id === p.donationId);
      if (!targetDon) throw new Error('Donation listing no longer exists.');
      await transitionDonationStatus(
        userId,
        targetDon,
        p.newStatus as DonationStatus,
        p.charityPartner ? String(p.charityPartner) : undefined,
        'ai'
      );
      resultMessage = `Updated donation "${targetDon.foodName}" to ${p.newStatus}.`;
    } else {
      throw new Error('Unsupported AI action type.');
    }

    await recordAiActionOutcome(userId, instruction, action, 'confirmed', '');
    return resultMessage;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Database operation failed.';
    try {
      await recordAiActionOutcome(userId, instruction, action, 'failed', errMsg);
    } catch {
      // Ignore secondary logging error
    }
    throw err;
  }
}

export async function loadSampleDemoData(userId: string, userEmail: string): Promise<void> {
  const sampleItems: Array<{
    name: string;
    category: FoodCategory;
    quantity: number;
    unit: FoodUnit;
    location: StorageLocation;
    daysOffset: number;
    notes: string;
  }> = [
    {
      name: 'Organic Whole Milk',
      category: 'Dairy & Eggs',
      quantity: 1,
      unit: 'l',
      location: 'Fridge',
      daysOffset: 2,
      notes: 'Sample demo item — opened yesterday morning',
    },
    {
      name: 'Baby Spinach Leaves',
      category: 'Produce',
      quantity: 250,
      unit: 'g',
      location: 'Fridge',
      daysOffset: 0,
      notes: 'Sample demo item — great for smoothies or sauteing today',
    },
    {
      name: 'Artisan Sourdough Loaf',
      category: 'Bakery',
      quantity: 1,
      unit: 'pcs',
      location: 'Pantry',
      daysOffset: 1,
      notes: 'Sample demo item — half loaf left',
    },
    {
      name: 'Rolled Oats',
      category: 'Grains & Pantry',
      quantity: 1.5,
      unit: 'kg',
      location: 'Pantry',
      daysOffset: 45,
      notes: 'Sample demo item — airtight glass jar',
    },
    {
      name: 'Frozen Mixed Berries',
      category: 'Frozen',
      quantity: 600,
      unit: 'g',
      location: 'Freezer',
      daysOffset: 90,
      notes: 'Sample demo item — organic frozen berries',
    },
    {
      name: 'Greek Yogurt Tub',
      category: 'Dairy & Eggs',
      quantity: 400,
      unit: 'g',
      location: 'Fridge',
      daysOffset: -1,
      notes: 'Sample demo item — expired yesterday for demonstration',
    },
  ];

  const batch = writeBatch(db);
  for (const item of sampleItems) {
    const foodId = sanitizeIdSegment('sample');
    batch.set(doc(db, 'users', userId, 'foods', foodId), {
      id: foodId,
      userId,
      name: item.name,
      category: item.category,
      quantity: item.quantity,
      initialQuantity: item.quantity,
      unit: item.unit,
      location: item.location,
      expiryDate: addDaysIsoDate(item.daysOffset),
      imageUrl: getRecommendedPresetImage(item.category, item.name),
      notes: item.notes,
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  const donId = sanitizeIdSegment('sampledon');
  batch.set(doc(db, 'users', userId, 'donations', donId), {
    id: donId,
    userId,
    foodId: 'standalone',
    foodName: 'Canned Chickpeas (Sample)',
    quantity: 4,
    unit: 'cans',
    category: 'Grains & Pantry',
    expiryDate: addDaysIsoDate(120),
    imageUrl: getRecommendedPresetImage('Grains & Pantry', 'chickpeas'),
    pickupLocation: 'Neighborhood Community Hub (Sample)',
    contactInfo: (userEmail || 'Zero Crumbs Member').slice(0, 150),
    notes: 'Sample demo donation listing — sealed pantry cans.',
    status: 'Available',
    charityPartner: '',
    safetyConfirmed: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const logId = sanitizeIdSegment('log');
  batch.set(doc(db, 'users', userId, 'activityLogs', logId), {
    id: logId,
    userId,
    action: 'food_added' satisfies ActivityActionType,
    itemName: 'Sample Household Data',
    details: 'Loaded clearly labelled sample inventory & donation items for exploration.',
    source: 'user',
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}/foods`);
  }
}

export async function updateDocDirect(
  pathParts: [string, string, string, string],
  data: Record<string, unknown>
): Promise<void> {
  try {
    await updateDoc(doc(db, ...pathParts), data);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, pathParts.join('/'));
  }
}
