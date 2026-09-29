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
**Errors:** `400` if code invalid or expired.

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
**Response:** array of `{ id, name, slug }`. Use `id` (not `slug`) for `categoryId` fields elsewhere.

### `GET /api/products`
Query params (optional): `?category=<slug>` `&subcategory=<text>` `&search=<text>`
**Response:** array of:
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
No dedicated `sizes`/`colors` fields — clothing sizes live at `attributes.sizes_available`. No color-variant data exists yet.

### `GET /api/products/subcategories?category=<slug>`
Returns distinct subcategory strings for that category, e.g. `["Hadith","Islamic Studies"]`.

### `GET /api/products/:slug`
Single product by **slug**. `404` if not found.

---

## Checkout *(auth required)*

### `POST /api/checkout/create-order`
**Request:** `{ "items": [{ "productId": "uuid", "quantity": 1 }] }`
**Response:** `{ "razorpayOrderId": "order_xxx", "amount": 1599, "keyId": "rzp_test_xxx" }`

### `POST /api/checkout/verify`
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
**Response (200):** the created order object, including `items`.
**Errors:** `400` payment verification failed or stock issue.

---

## Orders *(auth required)*

### `GET /api/orders`
Own order history, with `items`, `trackingNumber` (null until shipped), `shippingAddress`.

### `GET /api/orders/:id`
Single order. `403`/`404` as appropriate.

---

## Admin *(auth + ADMIN role required)*

### `GET /api/admin/products` — all products
### `POST /api/admin/products`
```json
{ "name": "...", "description": "...", "price": 15.99, "originalPrice": null, "stock": 50, "categoryId": "uuid-from-GET-categories", "subcategory": "Hadith", "imageUrls": [], "attributes": {} }
```
### `PUT /api/admin/products/:id` — same shape, `slug` unchanged
### `DELETE /api/admin/products/:id`

### `POST /api/admin/upload-image`
`multipart/form-data`, field `image`. Returns `{ "url": "https://..." }`.

### `GET /api/admin/orders` — all orders, any customer
### `PUT /api/admin/orders/:id`
```json
{ "status": "SHIPPED", "trackingNumber": "RXXXXXXXXXIN" }
```
Valid `status`: `PENDING`, `PAID`, `SHIPPED`, `DELIVERED`, `CANCELLED`.

---

## Payment methods
No backend API — frontend stores only non-sensitive display data (last-4, card type, UPI handle) locally. Correct approach; no endpoint needed.

---

## Notes
- Source of truth. Mismatches are bugs to report, not workarounds to guess.
- Updated same-day with every backend change, automatically.