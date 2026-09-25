# Maktabah Islamiyah — Backend API Reference

Base URL (production): `https://bookstore-backend-bnpf.onrender.com`
Base URL (local dev): `http://localhost:5000`

All request/response bodies are JSON. Authenticated routes require:
```
Authorization: Bearer <token>
```

**All error responses use the shape `{ "error": "message here" }`** — the field is always `error`, never `message`.

---

## Auth — Signup

### `POST /api/auth/send-otp`
Sends a 6-digit verification code to the given email (via Brevo).
**Request:** `{ "email": "user@example.com" }`
**Response (200):** `{ "message": "OTP sent" }`
**Errors:** `400` if email already registered and verified.

### `POST /api/auth/verify-signup`
Verifies the OTP and creates (or completes) the account.
**Request:**
```json
{ "name": "Full Name", "email": "user@example.com", "phone": "9876543210", "password": "plaintext_password", "otp": "123456" }
```
**Response (200):**
```json
{ "token": "jwt_token", "user": { "id": "uuid", "email": "...", "name": "...", "phone": "...", "role": "CUSTOMER" } }
```
**Errors:** `400` if OTP invalid or expired.

---

## Auth — Login & Session

### `POST /api/auth/login`
**Request:** `{ "email": "user@example.com", "password": "plaintext_password" }`
**Response (200):** same shape as `verify-signup`.
**Errors:** `401` invalid credentials (also returned for deleted accounts).

### `GET /api/auth/me` *(auth required)*
**Response (200):** `{ "id": "uuid", "email": "...", "name": "...", "phone": "...", "role": "CUSTOMER" }`

### `PUT /api/auth/me` *(auth required)*
Updates name, phone, and/or password. All fields optional — send only what's changing.
**Request (name/phone):** `{ "name": "New Name", "phone": "9999999999" }`
**Request (password change):** `{ "currentPassword": "old", "newPassword": "new" }`
**Response (200):** updated user object.
**Errors:** `400` if changing password without `currentPassword`; `401` if `currentPassword` wrong.

### `DELETE /api/auth/me` *(auth required)*
Deletes the account. This **anonymizes** the account (clears email/name/phone/password, sets an internal `deletedAt` flag) rather than removing the row — existing order history is preserved for business records, but the account can never log in again.
**Response (200):** `{ "message": "Account deleted" }`

### `GET /api/auth/google`
Redirects to Google's OAuth consent screen. Link a button directly to this URL.

### `GET /api/auth/google/callback`
Backend-handled. Redirects to `{FRONTEND_URL}/auth/callback?token=<jwt>`. Frontend needs a `/auth/callback` page that reads `token`, stores it like normal login, redirects home.

---

## Auth — Forgot Password

### `POST /api/auth/forgot-password`
**Request:** `{ "email": "user@example.com" }`
**Response (200):** `{ "message": "Reset code sent" }`
**Errors:** `404` if no account exists with that email.

### `POST /api/auth/reset-password`
**Request:** `{ "email": "user@example.com", "otp": "123456", "newPassword": "new_password" }`
**Response (200):** `{ "message": "Password reset successful" }`
**Errors:** `400` if code invalid or expired.

---

## Products & Categories *(public, no auth)*

### `GET /api/categories`
**Response:** array of `{ id, name, slug }`
**Use `id` (not `slug`) whenever a `categoryId` field is required elsewhere** (e.g. creating a product).

### `GET /api/products`
Query params (all optional): `?category=<slug>` `&subcategory=<text>` `&search=<text>`
**Response:** array of product objects:
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
  "attributes": { "author": "...", "language": "..." },
  "subcategory": "Islamic Studies",
  "categoryId": "uuid",
  "category": { "id": "uuid", "name": "Books", "slug": "books" }
}
```
**Important:** there are no dedicated top-level `sizes` or `colors` fields. For clothing/apparel categories, sizes live at `attributes.sizes_available` (an array of strings, e.g. `["S","M","L","XL"]`). There is currently no color-variant data anywhere — don't build against a `colors` field yet.

`attributes` shape varies by category: books → `author`/`language`; attars → `volume_ml`/`scent_notes`; clothing → `fabric`/`sizes_available`. Render dynamically based on category.

### `GET /api/products/subcategories?category=<slug>`
Returns the distinct subcategory strings that actually exist for a given category, e.g. `["Hadith","Islamic Studies"]`. Use this to build filter tabs dynamically rather than hardcoding them.

### `GET /api/products/:slug`
Single product by **slug** (not the database `id`). Same shape as above. `404` if not found.

---

## Checkout *(auth required)*

### `POST /api/checkout/create-order`
**Request:** `{ "items": [{ "productId": "uuid", "quantity": 1 }] }`
**Response:** `{ "razorpayOrderId": "order_xxx", "amount": 1599, "keyId": "rzp_test_xxx" }` (`amount` in paise)

### `POST /api/checkout/verify`
Call from Razorpay's `handler` callback after payment.
**Request:**
```json
{
  "razorpay_order_id": "order_xxx",
  "razorpay_payment_id": "pay_xxx",
  "razorpay_signature": "signature_from_razorpay",
  "items": [{ "productId": "uuid", "quantity": 1, "variantInfo": {} }],
  "shippingAddress": "full address as a single string"
}
```
Pass the three `razorpay_*` fields exactly as Razorpay's widget returns them.
**Response (200):** the created order object, including `items`.
**Errors:** `400` — `"Payment verification failed"` (signature mismatch) or a stock-related message.

---

## Orders *(auth required)*

### `GET /api/orders`
Logged-in user's own order history, each with `items` (including nested `product`) and `trackingNumber` (null until shipped).

### `GET /api/orders/:id`
Single order by ID. `403` if it belongs to a different user (unless `ADMIN`), `404` if not found.

---

## Admin *(auth + ADMIN role required)*

### `GET /api/admin/products` — all products
### `POST /api/admin/products` — create
```json
{
  "name": "...", "description": "...", "price": 15.99, "originalPrice": null,
  "stock": 50, "categoryId": "uuid-from-GET-categories", "subcategory": "Hadith",
  "imageUrls": [], "attributes": {}
}
```
**`categoryId` must be the real UUID from `GET /api/categories`, not the slug.**

### `PUT /api/admin/products/:id` — update (same shape, `slug` unchanged)
### `DELETE /api/admin/products/:id` — delete

### `POST /api/admin/upload-image`
`multipart/form-data`, field name `image`. Returns `{ "url": "https://..." }`.

### `GET /api/admin/orders` — all orders, any customer
### `PUT /api/admin/orders/:id`
```json
{ "status": "SHIPPED", "trackingNumber": "RXXXXXXXXXIN" }
```
Both fields optional — send only what's changing. Valid `status` values: `PENDING`, `PAID`, `SHIPPED`, `DELIVERED`, `CANCELLED`.

---

## Payment methods & other frontend-only concerns
There is **no backend API for saved payment methods**. Storing only non-sensitive display data (last-4 digits, card type, UPI handle) client-side, never full card numbers or CVV/PIN, is the correct approach — do not build a backend endpoint for this.

---

## Notes
- This document is the source of truth. If something here doesn't match actual backend behavior, that's a bug to report — not a signal to guess a workaround.
- Updated same-day with every backend change going forward.