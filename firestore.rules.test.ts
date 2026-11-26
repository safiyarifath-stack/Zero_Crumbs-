/**
 * Dirty Dozen Security Test Specification for Zero Crumbs Firestore Rules
 * Run against Firebase Rules Emulator if installed, or review invariants alongside security_spec.md.
 */
export interface DirtyDozenCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth: { uid: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const dirtyDozenPayloads: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated Read',
    operation: 'get',
    path: '/users/userA/foods/food1',
    auth: null,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Cross-Tenant Read',
    operation: 'get',
    path: '/users/userA/foods/food1',
    auth: { uid: 'userB', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Cross-Tenant List Scraping',
    operation: 'list',
    path: '/users/userA/foods',
    auth: { uid: 'userB', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Identity Spoofing on Create',
    operation: 'create',
    path: '/users/userB/foods/food1',
    auth: { uid: 'userB', email_verified: true },
    payload: { id: 'food1', userId: 'userA', name: 'Apples', quantity: 2 },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Unverified Email Write',
    operation: 'create',
    path: '/users/userA/foods/food1',
    auth: { uid: 'userA', email_verified: false },
    payload: { id: 'food1', userId: 'userA', name: 'Milk', quantity: 1 },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Shadow / Ghost Field Injection',
    operation: 'create',
    path: '/users/userA/foods/food1',
    auth: { uid: 'userA', email_verified: true },
    payload: { id: 'food1', userId: 'userA', name: 'Milk', isAdmin: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'ID Poisoning (Oversized ID)',
    operation: 'create',
    path: `/users/userA/foods/${'a'.repeat(1500)}`,
    auth: { uid: 'userA', email_verified: true },
    payload: { id: 'a'.repeat(1500), userId: 'userA', name: 'Bread' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'XSS Image URI Injection',
    operation: 'create',
    path: '/users/userA/foods/food2',
    auth: { uid: 'userA', email_verified: true },
    payload: { id: 'food2', userId: 'userA', name: 'Bread', imageUrl: 'javascript:alert(1)' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Negative Quantity Poisoning',
    operation: 'update',
    path: '/users/userA/foods/food1',
    auth: { uid: 'userA', email_verified: true },
    payload: { quantity: -5 },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Terminal Donation Mutation',
    operation: 'update',
    path: '/users/userA/donations/don1',
    auth: { uid: 'userA', email_verified: true },
    payload: { status: 'Available' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Unsafe Donation Bypass',
    operation: 'create',
    path: '/users/userA/donations/don2',
    auth: { uid: 'userA', email_verified: true },
    payload: { id: 'don2', userId: 'userA', safetyConfirmed: false },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Audit Log Tampering',
    operation: 'delete',
    path: '/users/userA/activityLogs/log1',
    auth: { uid: 'userA', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
];
