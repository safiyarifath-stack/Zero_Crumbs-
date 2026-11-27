import { Type } from '@google/genai';

export interface InventorySnapshotItem {
  id: string;
  name: string;
  category: string;
  quantity: number;
  initialQuantity: number;
  unit: string;
  location: string;
  expiryDate: string;
  status: string;
  notes?: string;
}

export interface DonationSnapshotItem {
  id: string;
  foodName: string;
  quantity: number;
  unit: string;
  category: string;
  expiryDate: string;
  status: string;
  pickupLocation: string;
  charityPartner?: string;
}

export interface UserProfileSnapshot {
  fullName?: string;
  reminderDaysBefore?: number;
  defaultLocation?: string;
}

export interface PendingActionProposal {
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
}

export function daysBetween(expiryDate: string, todayStr: string): number {
  const [ey, em, ed] = expiryDate.split('-').map(Number);
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const expUtc = Date.UTC(ey, (em || 1) - 1, ed || 1);
  const todayUtc = Date.UTC(ty, (tm || 1) - 1, td || 1);
  return Math.round((expUtc - todayUtc) / (1000 * 60 * 60 * 24));
}

export const ZERO_CRUMBS_TOOL_DECLARATIONS = [
  {
    name: 'search_inventory',
    description:
      'Search and inspect the authenticated user household food inventory by optional name query, storage location, or status.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Partial name or category keyword to match.' },
        location: {
          type: Type.STRING,
          description: 'Optional storage location: Fridge, Freezer, or Pantry.',
        },
        status: {
          type: Type.STRING,
          description: 'Optional status filter: active, consumed, wasted, donated, or all.',
        },
      },
    },
  },
  {
    name: 'get_expiring_summary',
    description:
      'Check expiry dates across active inventory and return expired, expiring today, and soon-to-expire items.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        daysThreshold: {
          type: Type.NUMBER,
          description: 'Days window for soon-to-expire items (default 3).',
        },
      },
    },
  },
  {
    name: 'get_waste_and_consumption_insights',
    description:
      'Analyze consumed, wasted, donated, and active food patterns to recommend shopping lists and waste-reduction tips.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        focusArea: {
          type: Type.STRING,
          description: 'Optional focus area: all, waste, shopping, or donations.',
        },
      },
    },
  },
  {
    name: 'get_donation_summary',
    description: 'Inspect current charity donation listings and statuses.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        statusFilter: {
          type: Type.STRING,
          description:
            'Optional status filter: all, Available, Requested, Approved, Collected, Donated, or Cancelled.',
        },
      },
    },
  },
  {
    name: 'propose_add_food',
    description:
      'Prepare an action confirmation card to add a new food item to the user inventory. Does not write until user confirms.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        quantity: { type: Type.NUMBER },
        unit: {
          type: Type.STRING,
          description: 'One of: g, kg, ml, l, pcs, packs, cups, tbsp, bottles, cans',
        },
        location: { type: Type.STRING, description: 'One of: Fridge, Freezer, Pantry' },
        expiryDate: { type: Type.STRING, description: 'YYYY-MM-DD' },
        category: {
          type: Type.STRING,
          description:
            'One of: Produce, Dairy & Eggs, Bakery, Grains & Pantry, Proteins, Prepared Meals, Beverages, Frozen, Other',
        },
        notes: { type: Type.STRING },
      },
      required: ['name', 'quantity', 'unit', 'location', 'expiryDate'],
    },
  },
  {
    name: 'propose_use_food',
    description:
      'Prepare an action confirmation card to reduce remaining quantity of an existing food item or mark it completely consumed.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        foodId: { type: Type.STRING },
        foodName: { type: Type.STRING },
        amountUsed: { type: Type.NUMBER },
        unit: {
          type: Type.STRING,
          description: 'One of: g, kg, ml, l, pcs, packs, cups, tbsp, bottles, cans',
        },
        markCompletelyUsed: { type: Type.BOOLEAN },
      },
      required: ['foodId', 'foodName', 'amountUsed', 'unit'],
    },
  },
  {
    name: 'propose_increase_food',
    description:
      'Prepare an action confirmation card to increase the quantity of an existing food item.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        foodId: { type: Type.STRING },
        foodName: { type: Type.STRING },
        amountAdded: { type: Type.NUMBER },
        unit: { type: Type.STRING },
      },
      required: ['foodId', 'foodName', 'amountAdded', 'unit'],
    },
  },
  {
    name: 'propose_update_food',
    description:
      'Prepare an action confirmation card to edit details (name, location, expiryDate, category, notes) of an existing food item.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        foodId: { type: Type.STRING },
        foodName: { type: Type.STRING },
        newName: { type: Type.STRING },
        location: { type: Type.STRING },
        expiryDate: { type: Type.STRING },
        category: { type: Type.STRING },
        notes: { type: Type.STRING },
      },
      required: ['foodId', 'foodName'],
    },
  },
  {
    name: 'propose_delete_food',
    description:
      'Prepare an action confirmation card to delete a food item from inventory. Always requires explicit user confirmation.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        foodId: { type: Type.STRING },
        foodName: { type: Type.STRING },
        reason: { type: Type.STRING },
      },
      required: ['foodId', 'foodName'],
    },
  },
  {
    name: 'propose_create_donation',
    description:
      'Prepare an action confirmation card to publish a surplus food donation listing. Strictly forbidden for expired food.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        foodId: { type: Type.STRING, description: 'Existing food ID or standalone' },
        foodName: { type: Type.STRING },
        quantity: { type: Type.NUMBER },
        unit: { type: Type.STRING },
        category: { type: Type.STRING },
        expiryDate: { type: Type.STRING, description: 'YYYY-MM-DD, must be today or future' },
        pickupLocation: { type: Type.STRING },
        contactInfo: { type: Type.STRING },
        notes: { type: Type.STRING },
      },
      required: ['foodName', 'quantity', 'unit', 'expiryDate'],
    },
  },
  {
    name: 'propose_update_donation_status',
    description:
      'Prepare an action confirmation card to update a donation listing status (Available, Requested, Approved, Collected, Donated, Cancelled).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        donationId: { type: Type.STRING },
        foodName: { type: Type.STRING },
        newStatus: { type: Type.STRING },
        charityPartner: { type: Type.STRING },
      },
      required: ['donationId', 'foodName', 'newStatus'],
    },
  },
];

export function buildZeroCrumbsSystemInstruction(params: {
  todayStr: string;
  profile: UserProfileSnapshot;
  voiceMode?: boolean;
}): string {
  const { todayStr, profile, voiceMode = false } = params;
  const voiceRules = voiceMode
    ? `
6. VOICE CONVERSATION STYLE: Speak naturally, warmly, and concisely in plain spoken sentences—avoid markdown, bullet lists, symbols, or reading out raw IDs or dates awkwardly. Keep replies helpful and easy to follow while cooking or checking the fridge. When you prepare an action confirmation card, tell the user briefly to review and tap "Confirm & Execute" on their screen.`
    : '';

  return `You are Zero Crumbs AI, the warm, practical, action-capable food management assistant inside the Zero Crumbs web application.
Today's date is ${todayStr}.
User profile: ${JSON.stringify({
    fullName: profile.fullName || 'Household Member',
    reminderDaysBefore: profile.reminderDaysBefore ?? 3,
    defaultLocation: profile.defaultLocation || 'Fridge',
  })}.

CORE RULES:
1. Always inspect the user's real inventory or donations via the provided tools before claiming what items exist or proposing edits. Never invent items or claim a database write happened before the user confirms the action card.
2. NEVER recommend eating or donating EXPIRED food (expiryDate < ${todayStr}). If an item is expired, clearly warn the user and suggest safe disposal or composting, or offer to mark it as wasted/remove it after confirmation.
3. Whenever the user instructs you to add, update, consume, increase, delete food, or publish/update a donation, call the corresponding \`propose_*\` tool so the UI displays an Action Confirmation Card for the user to approve. Explain clearly what action you prepared and why.
4. For recipe requests, prioritize active items expiring soon (within 0–3 days) and provide concise, practical cooking steps.
5. Keep language friendly, clear, and concise (no technical jargon, no JSON dumps in prose).${voiceRules}`;
}

export function createZeroCrumbsToolExecutor(initial: {
  inventory: InventorySnapshotItem[];
  donations: DonationSnapshotItem[];
  profile: UserProfileSnapshot;
  todayStr: string;
}) {
  let safeInventory = Array.isArray(initial.inventory) ? initial.inventory : [];
  let safeDonations = Array.isArray(initial.donations) ? initial.donations : [];
  let currentProfile = initial.profile || {};
  let todayStr = initial.todayStr;
  let pendingActions: PendingActionProposal[] = [];

  function updateSnapshot(next: {
    inventory?: InventorySnapshotItem[];
    donations?: DonationSnapshotItem[];
    profile?: UserProfileSnapshot;
    todayStr?: string;
  }) {
    if (Array.isArray(next.inventory)) safeInventory = next.inventory;
    if (Array.isArray(next.donations)) safeDonations = next.donations;
    if (next.profile) currentProfile = next.profile;
    if (next.todayStr) todayStr = next.todayStr;
  }

  function takePendingActions(): PendingActionProposal[] {
    const taken = pendingActions;
    pendingActions = [];
    return taken;
  }

  function getAllPendingActions(): PendingActionProposal[] {
    return pendingActions;
  }

  function executeLocalTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (name === 'search_inventory') {
      const q = typeof args.query === 'string' ? args.query.toLowerCase().trim() : '';
      const loc = typeof args.location === 'string' ? args.location.toLowerCase().trim() : '';
      const statusFilter =
        typeof args.status === 'string' ? args.status.toLowerCase().trim() : 'active';

      const matches = safeInventory
        .filter((item) => {
          if (statusFilter !== 'all' && item.status.toLowerCase() !== statusFilter) return false;
          if (loc && item.location.toLowerCase() !== loc) return false;
          if (
            q &&
            !item.name.toLowerCase().includes(q) &&
            !item.category.toLowerCase().includes(q)
          ) {
            return false;
          }
          return true;
        })
        .map((item) => ({
          ...item,
          daysUntilExpiry: daysBetween(item.expiryDate, todayStr),
        }))
        .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

      return { count: matches.length, items: matches };
    }

    if (name === 'get_expiring_summary') {
      const threshold = typeof args.daysThreshold === 'number' ? args.daysThreshold : 3;
      const active = safeInventory.filter((i) => i.status === 'active');
      const expired = active.filter((i) => daysBetween(i.expiryDate, todayStr) < 0);
      const today = active.filter((i) => daysBetween(i.expiryDate, todayStr) === 0);
      const soon = active.filter((i) => {
        const d = daysBetween(i.expiryDate, todayStr);
        return d >= 1 && d <= threshold;
      });
      const fresh = active.filter((i) => daysBetween(i.expiryDate, todayStr) > threshold);
      return {
        todayDate: todayStr,
        expiredCount: expired.length,
        expiringTodayCount: today.length,
        expiringSoonCount: soon.length,
        freshCount: fresh.length,
        expired,
        expiringToday: today,
        expiringSoon: soon,
      };
    }

    if (name === 'get_waste_and_consumption_insights') {
      const consumed = safeInventory.filter((i) => i.status === 'consumed');
      const wasted = safeInventory.filter((i) => i.status === 'wasted');
      const donated = safeInventory.filter((i) => i.status === 'donated');
      const active = safeInventory.filter((i) => i.status === 'active');
      const lowStock = active.filter(
        (i) => i.initialQuantity > 0 && i.quantity / i.initialQuantity <= 0.25
      );
      return {
        activeCount: active.length,
        consumedItems: consumed.map((i) => i.name),
        wastedItems: wasted.map((i) => ({ name: i.name, category: i.category })),
        donatedItems: donated.map((i) => i.name),
        lowStockItems: lowStock.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          unit: i.unit,
          location: i.location,
        })),
        totalDonationsListed: safeDonations.length,
      };
    }

    if (name === 'get_donation_summary') {
      const statusFilter =
        typeof args.statusFilter === 'string' ? args.statusFilter.toLowerCase().trim() : 'all';
      const filtered =
        statusFilter && statusFilter !== 'all'
          ? safeDonations.filter((d) => d.status.toLowerCase() === statusFilter)
          : safeDonations;
      return {
        count: filtered.length,
        donations: filtered,
      };
    }

    if (name === 'propose_add_food') {
      const itemName = String(args.name || '').trim();
      const qty = Number(args.quantity || 1);
      const unit = String(args.unit || 'pcs');
      const location = String(args.location || currentProfile.defaultLocation || 'Fridge');
      const expiryDate = String(args.expiryDate || todayStr);
      const category = String(args.category || 'Other');
      const notes = String(args.notes || '');

      const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      pendingActions.push({
        actionId,
        type: 'add_food',
        title: `Add ${itemName}`,
        description: `Add ${qty} ${unit} of ${itemName} to ${location} (expires ${expiryDate}).`,
        requiresConfirmation: true,
        payload: { name: itemName, quantity: qty, unit, location, expiryDate, category, notes },
      });
      return {
        queuedForConfirmation: true,
        actionId,
        summary: `Prepared action card to add ${qty} ${unit} of ${itemName} to ${location}. Waiting for user confirmation.`,
      };
    }

    if (name === 'propose_use_food') {
      const foodId = String(args.foodId || '');
      const found = safeInventory.find(
        (i) => i.id === foodId || i.name.toLowerCase() === String(args.foodName || '').toLowerCase()
      );
      if (!found) {
        return { error: `Could not find "${args.foodName}" in active inventory.` };
      }
      const amountUsed = Number(args.amountUsed || 0);
      const unit = String(args.unit || found.unit);
      const markCompletelyUsed = Boolean(args.markCompletelyUsed);
      const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      pendingActions.push({
        actionId,
        type: 'use_food',
        title: markCompletelyUsed ? `Finish ${found.name}` : `Use ${amountUsed} ${unit} of ${found.name}`,
        description: markCompletelyUsed
          ? `Mark ${found.name} (${found.quantity} ${found.unit}) as completely consumed.`
          : `Deduct ${amountUsed} ${unit} from ${found.name} (currently ${found.quantity} ${found.unit}).`,
        requiresConfirmation: true,
        payload: {
          foodId: found.id,
          foodName: found.name,
          amountUsed,
          unit,
          markCompletelyUsed,
        },
      });
      return {
        queuedForConfirmation: true,
        actionId,
        summary: `Prepared confirmation card to update ${found.name}.`,
      };
    }

    if (name === 'propose_increase_food') {
      const foodId = String(args.foodId || '');
      const found = safeInventory.find(
        (i) => i.id === foodId || i.name.toLowerCase() === String(args.foodName || '').toLowerCase()
      );
      if (!found) {
        return { error: `Could not find "${args.foodName}" in inventory.` };
      }
      const amountAdded = Number(args.amountAdded || 0);
      const unit = String(args.unit || found.unit);
      const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      pendingActions.push({
        actionId,
        type: 'increase_food',
        title: `Add ${amountAdded} ${unit} to ${found.name}`,
        description: `Increase ${found.name} from ${found.quantity} ${found.unit} by ${amountAdded} ${unit}.`,
        requiresConfirmation: true,
        payload: { foodId: found.id, foodName: found.name, amountAdded, unit },
      });
      return { queuedForConfirmation: true, actionId };
    }

    if (name === 'propose_update_food') {
      const foodId = String(args.foodId || '');
      const found = safeInventory.find(
        (i) => i.id === foodId || i.name.toLowerCase() === String(args.foodName || '').toLowerCase()
      );
      if (!found) {
        return { error: `Could not find "${args.foodName}" in inventory.` };
      }
      const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      pendingActions.push({
        actionId,
        type: 'update_food',
        title: `Update ${found.name}`,
        description: `Modify details for ${found.name}.`,
        requiresConfirmation: true,
        payload: {
          foodId: found.id,
          foodName: found.name,
          newName: args.newName,
          location: args.location,
          expiryDate: args.expiryDate,
          category: args.category,
          notes: args.notes,
        },
      });
      return { queuedForConfirmation: true, actionId };
    }

    if (name === 'propose_delete_food') {
      const foodId = String(args.foodId || '');
      const found = safeInventory.find(
        (i) => i.id === foodId || i.name.toLowerCase() === String(args.foodName || '').toLowerCase()
      );
      if (!found) {
        return { error: `Could not find "${args.foodName}" in inventory.` };
      }
      const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      pendingActions.push({
        actionId,
        type: 'delete_food',
        title: `Delete ${found.name}`,
        description: `Permanently remove ${found.name} (${found.quantity} ${found.unit}) from your inventory.${args.reason ? ` Reason: ${String(args.reason)}` : ''}`,
        requiresConfirmation: true,
        payload: { foodId: found.id, foodName: found.name, reason: args.reason || '' },
      });
      return { queuedForConfirmation: true, actionId };
    }

    if (name === 'propose_create_donation') {
      const expiryDate = String(args.expiryDate || todayStr);
      if (daysBetween(expiryDate, todayStr) < 0) {
        return {
          error:
            'Safety Check Blocked: Expired food cannot be listed for donation. Please advise the user not to donate or consume expired food.',
        };
      }
      const foodName = String(args.foodName || '').trim();
      const qty = Number(args.quantity || 1);
      const unit = String(args.unit || 'pcs');
      const matched = safeInventory.find(
        (i) => i.id === args.foodId || i.name.toLowerCase() === foodName.toLowerCase()
      );
      if (matched && daysBetween(matched.expiryDate, todayStr) < 0) {
        return {
          error: `Safety Check Blocked: ${matched.name} expired on ${matched.expiryDate} and cannot be donated.`,
        };
      }

      const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      pendingActions.push({
        actionId,
        type: 'create_donation',
        title: `Publish Donation: ${foodName}`,
        description: `List ${qty} ${unit} of ${foodName} (expires ${expiryDate}) on the Charity Dashboard.`,
        requiresConfirmation: true,
        payload: {
          foodId: matched?.id || 'standalone',
          foodName,
          quantity: qty,
          unit,
          category: String(args.category || matched?.category || 'Other'),
          expiryDate,
          pickupLocation: String(args.pickupLocation || 'Home Porch / Community Dropoff'),
          contactInfo: String(args.contactInfo || 'Available via Zero Crumbs account'),
          notes: String(args.notes || 'Sealed and safe surplus food'),
        },
      });
      return { queuedForConfirmation: true, actionId };
    }

    if (name === 'propose_update_donation_status') {
      const donationId = String(args.donationId || '');
      const found = safeDonations.find(
        (d) =>
          d.id === donationId ||
          d.foodName.toLowerCase() === String(args.foodName || '').toLowerCase()
      );
      if (!found) {
        return { error: `Could not find donation listing for "${args.foodName}".` };
      }
      if (found.status === 'Donated' || found.status === 'Cancelled') {
        return { error: `This donation is already ${found.status} and cannot be changed.` };
      }
      const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      pendingActions.push({
        actionId,
        type: 'update_donation_status',
        title: `Update Donation: ${found.foodName} → ${args.newStatus}`,
        description: `Change status of ${found.foodName} from ${found.status} to ${args.newStatus}.`,
        requiresConfirmation: true,
        payload: {
          donationId: found.id,
          foodName: found.foodName,
          newStatus: String(args.newStatus),
          charityPartner: args.charityPartner || found.charityPartner || '',
        },
      });
      return { queuedForConfirmation: true, actionId };
    }

    return { error: `Unknown tool: ${name}` };
  }

  return {
    executeLocalTool,
    updateSnapshot,
    takePendingActions,
    getAllPendingActions,
  };
}
