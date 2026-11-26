# Zero Crumbs Security Specification

## 1. Data Invariants
1. **Strict Tenant Isolation**: Every document in `/users/{userId}` and its subcollections (`foods`, `quantityHistory`, `donations`, `donationRequests`, `activityLogs`, `aiActions`) is strictly private to the authenticated, verified owner (`request.auth.uid == userId` and either `request.auth.token.email_verified == true` or server-verified `emailOtpVerified == true`).
2. **Master Gate Relational Sync**: Every subcollection read/write (`get`, `create`, `update`, `delete`) verifies that the parent `/users/{userId}` profile exists and belongs to `request.auth.uid`.
3. **PII Isolation**: User email, phone number, donor contact phone (`donorPhone`), exact pickup coordinates/addresses (`pickupLatitude`, `pickupLongitude`, `pickupAddress`), and selected charity handoff details reside strictly inside owner-only `/users/{userId}` paths. No cross-user read or `list` queries are permitted, preventing unrelated users from accessing personal contact information.
4. **Food Safety & Donation Terminal Locks**:
   - Donations require `safetyConfirmed == true` and valid non-empty quantity `> 0`.
   - Once a donation reaches a terminal state (`Donated` or `Cancelled`), no further updates are permitted.
   - Once a donation request reaches a terminal state (`Collected` or `Declined`), no further updates are permitted.
5. **Immutable Audit Logs**: `quantityHistory`, `activityLogs`, and `aiActions` are append-only (`create` and `read` only; `update` and `delete` are denied).
6. **Temporal & Identity Integrity**: All `createdAt` and `updatedAt` timestamps must match `request.time`. Owner `uid`/`userId` and `createdAt` fields are immutable on update.

## 2. The "Dirty Dozen" Attack Payloads (All Must Return PERMISSION_DENIED)
1. **Unauthenticated Read**: Read `/users/userA/foods/food1` when `request.auth == null`.
2. **Cross-Tenant Read**: User B (`uid: userB`) attempts `get` on `/users/userA/foods/food1`.
3. **Cross-Tenant List Scraping**: User B attempts `list` on `/users/userA/foods`.
4. **Identity Spoofing on Create**: User B creates `/users/userB/foods/food1` with `userId: "userA"`.
5. **Unverified Email Write**: User A with `email_verified: false` attempts to create a `FoodItem`.
6. **Shadow / Ghost Field Injection**: User A creates a `FoodItem` with an extra `isAdmin: true` field.
7. **ID Poisoning (1.5KB Document ID)**: User A creates `/users/userA/foods/<1500_char_id>`.
8. **XSS Image URI Injection**: User A creates a `FoodItem` with `imageUrl: "javascript:alert(1)"` or `"data:image/svg+xml;base64,..."`.
9. **Negative Quantity Poisoning**: User A updates a `FoodItem` with `quantity: -5`.
10. **Terminal Donation Mutation**: User A attempts to update a `DonationListing` whose existing status is `"Donated"`.
11. **Unsafe Donation Bypass**: User A creates a `DonationListing` with `safetyConfirmed: false`.
12. **Audit Log Tampering**: User A attempts to `update` or `delete` an existing `/users/userA/activityLogs/log1` document.
