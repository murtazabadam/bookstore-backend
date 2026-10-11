# Maktabah Islamiyah — Backend API Reference

Base URL (production): `https://bookstore-backend-bnpf.onrender.com`
Base URL (local dev): `http://localhost:5000`

**CORS:** `FRONTEND_URL` on Render accepts several addresses, comma-separated (e.g. `https://shop.vercel.app,https://mydomain.com`); `http://localhost:3000` is always allowed too. Google login redirects to the **first** address in the list.

All request/response bodies are JSON. Authenticated routes require:
```
Authorization: Bearer <token>
```

**All error responses use the shape `{ "error": "message here" }`** — the field is always `error`, never `message`. This includes `429` rate-limit responses. Raw database errors are translated to plain messages (e.g. `"Another record already uses that sku"`); no stack traces are returned.

**Auth failures:** no/invalid/expired token → `401`; valid token but not an admin on any `/api/admin/*` route → `403 { "error": "Admin access required" }`.

---

## Auth — Signup

### `POST /api/auth/send-otp`
**Request:** `{ "email": "user@example.com" }`
**Response (200):** `{ "message": "OTP sent" }`
**Errors:** `400` if email already registered and verified.

### `POST /api/auth/verify-signup`
**Request:**
```json
{ "name": "Full Name", "email": "user@example.com", "phone": "9876543210", "password": "plaintext_password", "otp": "123456" }
```
**Response (200):**
```json
{ "token": "jwt_token", "user": { "id": "uuid", "email": "...", "name": "...", "phone": "...", "role": "CUSTOMER" } }
```
**Errors:** `400` if OTP invalid or expired; `429` after 10 attempts in 15 minutes (per IP).
Accounts created here are **always `CUSTOMER`** — any `role` in the body is ignored. Admins are promoted by script only (`prisma/makeAdmin.js`).

---

## Auth — Login & Session

### `POST /api/auth/login`
**Request:** `{ "email": "user@example.com", "password": "plaintext_password" }`
**Response (200):** same shape as `verify-signup`.
**Errors:** `401` invalid credentials — also returned for deleted accounts **and deactivated accounts** (`isActive: false`); `429` after 10 attempts in 15 minutes (per IP).
A deactivated user's existing token stops working immediately too (every authenticated route re-checks the user).

### `GET /api/auth/me` *(auth required)*
**Response (200):** `{ "id": "uuid", "email": "...", "name": "...", "phone": "...", "role": "CUSTOMER" }`

### `PUT /api/auth/me` *(auth required)*
**Request (name/phone):** `{ "name": "New Name", "phone": "9999999999" }`
**Request (password change):** `{ "currentPassword": "old", "newPassword": "new" }`
**Response (200):** updated user object.
**Errors:** `400` if changing password without `currentPassword`; `401` if `currentPassword` wrong.

### `DELETE /api/auth/me` *(auth required)*
Anonymizes the account (clears email/name/phone/password, sets `deletedAt`) rather than deleting the row — order history is preserved. **Token is invalidated immediately.**
**Request body:** `{ "currentPassword": "..." }` — required if the account has a password; omit for Google-only accounts.
**Response (200):** `{ "message": "Account deleted" }`
**Errors:** `400` missing password on a password account; `401` wrong password.
**Frontend should still clear localStorage and redirect after success.**

### `GET /api/auth/google`
Redirects to Google's OAuth consent screen.

### `GET /api/auth/google/callback`
Redirects to `{FRONTEND_URL}/auth/callback?token=<jwt>`.

---

## Auth — Forgot Password

### `POST /api/auth/forgot-password`
**Request:** `{ "email": "user@example.com" }`
**Response (200):** `{ "message": "Reset code sent" }`
**Errors:** `404` if no account exists with that email.

### `POST /api/auth/reset-password`
**Request:** `{ "email": "user@example.com", "otp": "123456", "newPassword": "new_password" }`
**Response (200):** `{ "message": "Password reset successful" }`
**Errors:** `400` if code invalid or expired; `429` after 10 attempts in 15 minutes (per IP).

---

## Addresses *(auth required, all routes)*

Saved delivery addresses, scoped to the logged-in user. A user's own addresses only — never another user's, enforced with `403` on any cross-user access attempt.

### `GET /api/addresses`
**Response:** array of:
```json
{
  "id": "uuid",
  "label": "Home",
  "fullName": "...",
  "phone": "...",
  "street": "...",
  "area": "...",
  "city": "...",
  "state": "...",
  "pincode": "...",
  "isDefault": true
}
```

### `POST /api/addresses`
**Request:** same shape as above, minus `id`/`isDefault`. The **first** address a user creates is automatically set as `isDefault: true`; subsequent ones default to `false` unless explicitly promoted.
**Response:** the created address object.

### `PUT /api/addresses/:id`
Same body shape as `POST` (partial updates supported — send only changed fields, though `undefined` fields will overwrite with `undefined` in the current implementation, so send the full object to be safe).
**Response:** the updated address object.
**Errors:** `404` not found; `403` if it belongs to a different user.

### `DELETE /api/addresses/:id`
Deletes the address. If it was the default and other addresses remain, the oldest remaining one is automatically promoted to default.
**Response:** `{ "success": true }`
**Errors:** `404` not found; `403` if it belongs to a different user.

### `PUT /api/addresses/:id/default`
Sets this address as the user's default, unsetting any previous default.
**Response:** the now-default address object.
**Errors:** `404` not found; `403` if it belongs to a different user.

**Note on checkout:** `shippingAddress` on an `Order` is a plain string, captured at the moment `/api/checkout/verify` is called — completely independent of the address book. Editing or deleting a saved address afterward never changes what's shown on past orders. The frontend is responsible for formatting the selected saved address into a single string before sending it to checkout.

---

## Products & Categories *(public, no auth)*

### `GET /api/categories`
Active categories only. **Response:** array of `{ id, name, slug, imageUrl, isActive }`. Use `id` (not `slug`) for `categoryId` fields elsewhere.
Switching a category off hides the category **and all its products** from every public route below.

### `GET /api/products`
Query params (optional): `?category=<slug>` `&subcategory=<text>` `&search=<text>` `&featured=true`
Products with `status: DRAFT` are never returned. `OUT_OF_STOCK` products are returned. **Response:** array of:
```json
{
  "id": "uuid",
  "name": "...",
  "slug": "...",
  "description": "...",
  "price": "15.99",
  "originalPrice": null,
  "stock": 50,
  "imageUrls": [],
  "attributes": { "author": "...", "language": "...", "sizes_available": ["M", "L"] },
  "subcategory": "Islamic Studies",
  "brand": null,
  "sku": null,
  "status": "ACTIVE",
  "featured": false,
  "categoryId": "uuid",
  "category": { "id": "uuid", "name": "Books", "slug": "books", "imageUrl": null, "isActive": true },
  "variants": [{ "id": "uuid", "productId": "uuid", "size": "M", "color": "Black", "sku": "KS-M-BLK", "price": "1499.00", "stock": 5 }]
}
```
`variants` is `[]` when the product has none. A variant `price` of `null` means "use the product price". `attributes` is free-form JSON (strings, arrays, longer text all fine).
When a product has variants, **`stock` is the sum of its variants' stock**.

### `GET /api/products/subcategories?category=<slug>`
Distinct subcategory strings, e.g. `["Hadith","Islamic Studies"]` (DRAFT products and inactive categories excluded).

### `GET /api/products/:slug`
Single product by **slug**, same shape as above. `404` if not found, DRAFT, or its category is inactive.

### `GET /api/settings`
Safe, public subset (no auth). Returns `{}` if settings were never saved.
```json
{
  "storeName": "Maktabah Islamiyah", "tagline": null, "storeEmail": "...", "phone": "9876543210",
  "address": "...", "logoUrl": null,
  "shippingCharge": "50", "freeShippingThreshold": "1000", "deliveryEstimate": "5-8 days",
  "courierName": "India Post", "trackingUrlTemplate": "https://.../?n={trackingNumber}",
  "onlinePaymentsEnabled": true
}
```
`shippingCharge` / `freeShippingThreshold` are what `create-order` really uses, so the cart can show the exact total Razorpay will charge. Shipping rule: free when `freeShippingThreshold > 0` and subtotal ≥ it; otherwise `shippingCharge`. `0` threshold = never free.
To build a tracking link: replace `{trackingNumber}` in `trackingUrlTemplate` with the order's `trackingNumber`.

---

## Checkout *(auth required)*

The server prices the cart itself and remembers it against the Razorpay order id. `verify` builds the order from that saved cart — **items sent to `verify` are ignored** — and only succeeds if Razorpay really received the saved total.

### `POST /api/checkout/create-order`
**Request:** `{ "items": [{ "productId": "uuid", "quantity": 1, "variantInfo": { "size": "M", "color": null } }] }`
`variantInfo` is required when the product has variants (size/color must match a variant exactly). Quantity must be a whole number 1–100. Duplicate lines for the same product + size + color are merged before the stock check.
**Response:**
```json
{
  "razorpayOrderId": "order_xxx",
  "amount": 15000,
  "keyId": "rzp_test_xxx",
  "subtotal": 100,
  "shippingCharge": 50,
  "total": 150
}
```
`amount` is in paise (`total × 100`). `subtotal` / `shippingCharge` / `total` are in rupees and use the shipping rules from store settings, so the frontend can show exactly what will be charged.
**Errors:** `400` empty cart, bad quantity, product unavailable/not ACTIVE, variant not found, insufficient stock, total under ₹1; `502` Razorpay could not create the order.

### `POST /api/checkout/verify`
**Request:**
```json
{
  "razorpay_order_id": "order_xxx",
  "razorpay_payment_id": "pay_xxx",
  "razorpay_signature": "signature_from_razorpay",
  "shippingAddress": "full address as a single string"
}
```
`items` may still be sent but is ignored.
**What it checks, in order:** signature → payment id not already used → a saved checkout exists for this user and Razorpay order → Razorpay reports the payment as captured, for that order, in INR, for exactly the saved total → stock is still available.
**Response (200):** the created order object, including `items`. **Safe to retry:** sending the same `razorpay_payment_id` again returns the same order and never creates a second one.
**Errors (`{ "error": ... }`):**
- `400` bad signature, payment not captured, payment belongs to a different order, **paid amount does not match the order total**, missing address
- `404` no checkout found for this order id / user
- `409` checkout already completed, payment id used by another account, or an item sold out between `create-order` and `verify` — in that case the payment is **automatically refunded** and the message says so (if the refund itself fails, the message tells the customer to contact support with the payment id)
- `502` could not reach Razorpay to confirm the payment
- `500` unexpected error (customer is told to contact support if charged)

**Known limitation:** if the customer pays but the browser never calls `verify` (tab closed, network drop), no order is created. A Razorpay webhook would close this gap — not built yet.

---

## Orders *(auth required)*

Order object (customer and admin):
```json
{
  "id": "uuid",
  "userId": "uuid",
  "status": "PAID",
  "total": "150.00",
  "shippingCharge": "50.00",
  "shippingAddress": "single string captured at checkout",
  "trackingNumber": null,
  "razorpayOrderId": "order_xxx",
  "razorpayPaymentId": "pay_xxx",
  "createdAt": "2026-10-10T10:00:00.000Z",
  "items": [{
    "id": "uuid", "productId": "uuid", "quantity": 1,
    "priceAtPurchase": "100.00",
    "variantInfo": { "size": "M", "color": null },
    "product": { "id": "uuid", "name": "...", "slug": "...", "imageUrls": [] }
  }]
}
```
The total field is **`total`** (not `totalAmount`) and it **includes** shipping. `shippingCharge` is stored separately, so **subtotal = `total` − `shippingCharge`** (also = sum of `priceAtPurchase × quantity`). `product` is the full product row (current values — use `priceAtPurchase` for what was charged).

### `GET /api/orders`
Own order history, newest first. `403`/`404` rules below.
### `GET /api/orders/:id`
Single order. `404` not found; `403` if it belongs to another user (admins may view any).

---

## Admin *(auth + ADMIN role required, every route)*

### Products
`GET /api/admin/products` — all products (any status), each with `category`, **without** `variants`.
`GET /api/admin/products/:id` — one product with `category` and `variants`.
`POST /api/admin/products` / `PUT /api/admin/products/:id`:
```json
{
  "name": "Men's Shalwar Kameez", "description": "...", "price": 1299, "originalPrice": null,
  "stock": 20, "categoryId": "uuid-from-GET-categories", "subcategory": "Daily wear",
  "brand": "Maktabah", "sku": "KS-001", "status": "ACTIVE", "featured": false,
  "imageUrls": ["https://..."],
  "attributes": { "fabric": "Cotton", "sizes_available": ["M", "L"] },
  "variants": [{ "size": "M", "color": "Black", "sku": "KS-M-BLK", "price": 1499, "stock": 5 }]
}
```
- `status`: `ACTIVE` | `DRAFT` | `OUT_OF_STOCK`. Only `ACTIVE` products can be bought; `DRAFT` is hidden from the store.
- `slug` is generated from `name` on create and **never changes** on update.
- **Variants:** on `PUT`, sending a `variants` array **replaces all variants** for that product; omit the key to leave them untouched. If the product has ≥1 variant, `stock` is set to the **sum of variant stock** (the `stock` you send is ignored). Variant `sku` must be unique.
- Duplicate `sku`/`slug` → `400 { "error": "Another record already uses that sku" }`.
`DELETE /api/admin/products/:id` — `409 { "error": "This product appears in past orders and cannot be deleted. Set its status to DRAFT to hide it instead." }` if it was ever ordered; otherwise deletes the product and its variants → `{ "success": true }`.

### `POST /api/admin/upload-image`
`multipart/form-data`, field `image`. Returns `{ "url": "https://..." }`.

### Orders
`GET /api/admin/orders` — all orders, newest first, same shape as above **plus** the customer as a nested object:
```json
"user": { "id": "uuid", "name": "...", "email": "...", "phone": "..." }
```
(no flat `customerName` / `customerEmail`). `razorpayPaymentId`, `shippingAddress` and `trackingNumber` are always present on the order (`null` when empty).

`PUT /api/admin/orders/:id` — `{ "status": "SHIPPED", "trackingNumber": "RXXXXXXXXXIN" }` (either field optional). Valid `status`: `PENDING`, `PAID`, `SHIPPED`, `DELIVERED`, `CANCELLED`. Returns the updated order (without `items`).
- Moving an order **to `CANCELLED` puts every item back in stock** (the matching variant if there is one, then the product total). **No refund is made** — refund in the Razorpay dashboard.
- A cancelled order is **locked**: any other status → `400 { "error": "Cannot change the status of a cancelled order" }`.
- Orders are only created after a captured payment, so new orders start as `PAID`; `PENDING` is not used by checkout.

### Categories
`GET /api/admin/categories` — all categories including inactive: `[{ "id", "name", "slug", "imageUrl", "isActive", "productCount" }]`.
`POST /api/admin/categories` — `{ "name": "Hijabs", "slug"?: "hijabs", "imageUrl"?: "https://...", "isActive"?: true }`. `slug` is generated from `name` if missing. Returns the created category.
`PUT /api/admin/categories/:id` — same fields, **partial**; only sent fields change (slug stays unless sent). `imageUrl: null` removes the image.
`DELETE /api/admin/categories/:id` — `409 { "error": "Cannot delete — 3 product(s) still use this category" }` if any product uses it; otherwise `{ "success": true }`.

### Users
`GET /api/admin/users` — non-deleted users, newest first: `[{ "id", "name", "email", "phone", "createdAt", "isActive", "role" }]`. Passwords, tokens and OTPs are never returned (explicit field list).
`PUT /api/admin/users/:id` — `{ "isActive": false }`. Returns the same user fields. `isActive` must be a boolean (`400` otherwise). An admin cannot deactivate **their own** account (`400 { "error": "You cannot deactivate your own account" }`). A deactivated user cannot log in and their existing token is rejected immediately.

### Settings
`GET /api/admin/settings` and `PUT /api/admin/settings` both return the **full saved object**:
```json
{
  "general":  { "storeName": "Maktabah Islamiyah", "tagline": null, "storeEmail": "...", "phone": "9876543210", "address": "...", "logoUrl": null },
  "payment":  { "onlinePaymentsEnabled": true, "codEnabled": false, "mode": "test", "razorpayKeyId": "rzp_test_xxx", "secretsConfigured": true },
  "shipping": { "shippingCharge": "50", "freeShippingThreshold": "1000", "deliveryEstimate": "5-8 days", "courierName": "India Post", "trackingUrlTemplate": "https://.../?n={trackingNumber}" },
  "email":    { "senderName": "...", "replyToEmail": null, "lowStockThreshold": 10 }
}
```
`PUT` takes the same grouped shape and **only changes the fields it receives**. Read-only (ignored on PUT): `mode`, `razorpayKeyId`, `secretsConfigured`. Secrets (Razorpay secret, Brevo key, JWT secret, DB URLs) are never returned.

**Validation** (any failure → `400 { "error": "..." }`, nothing is saved):
| Field | Rule |
|---|---|
| `storeName` | required, ≤ 100 chars |
| `tagline` | ≤ 200 chars; `""`/`null` clears it |
| `storeEmail`, `replyToEmail` | valid email; `""`/`null` clears it |
| `phone` | exactly 10 digits; `""`/`null` clears it |
| `address` | ≤ 500 chars |
| `logoUrl` | `http(s)://` link |
| `shippingCharge`, `freeShippingThreshold` | number 0 – 1,000,000 (`0` threshold = never free) |
| `deliveryEstimate`, `courierName` | ≤ 100 chars |
| `trackingUrlTemplate` | `http(s)://` link that contains `{trackingNumber}` |
| `senderName` | ≤ 100 chars |
| `lowStockThreshold` | whole number 0 – 100000 — read it from **`GET /api/admin/settings` → `email.lowStockThreshold`** |
| `onlinePaymentsEnabled` | boolean. When `false`, `create-order` returns `503` and nobody can check out |
| `codEnabled` | cannot be set to `true` — cash on delivery is not built (`400 "Cash on delivery is not supported yet"`) |

What is actually used: `shippingCharge` + `freeShippingThreshold` (every checkout total), `onlinePaymentsEnabled` (checkout on/off), `senderName` + `replyToEmail` (OTP / reset emails). The other fields are stored for display. `lowStockThreshold` is stored; the dashboard reads it.

---

## Emails the backend sends today
Only two, both from the OTP code path: sign-up verification code and password-reset code (sender name and reply-to come from settings). **No** order-confirmation, shipped, or new-order admin alert emails exist yet, and there is no `adminAlertEmail` setting.

## Payment methods
No backend API — frontend stores only non-sensitive display data (last-4, card type, UPI handle) locally. Correct approach; no endpoint needed.

## Not built yet
Cash on delivery · Razorpay webhook (customer pays but never reaches `verify`) · refunds from the admin panel · order emails · reviews/coupons · pagination on `GET /api/products`.

## Notes
- Source of truth. Mismatches are bugs to report, not workarounds to guess.
- Updated with every backend change.