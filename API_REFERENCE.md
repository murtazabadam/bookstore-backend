# Maktabah Islamiyah — Backend API Reference

Base URL (production): `https://bookstore-backend-bnpf.onrender.com`
Base URL (local dev): `http://localhost:5000`

All request/response bodies are JSON. Authenticated routes require:
```
Authorization: Bearer <token>
```

---

## Auth

### `POST /api/auth/send-otp`
Sends a 6-digit verification code to the given email (via Brevo). Used for both new signups and resending a code.

**Request:**
```json
{ "email": "user@example.com" }
```
**Response (200):**
```json
{ "message": "OTP sent" }
```
**Errors:** `400` if email already registered and verified.

---

### `POST /api/auth/verify-signup`
Verifies the OTP and creates (or completes) the account. This is the actual account-creation step.

**Request:**
```json
{
  "name": "Full Name",
  "email": "user@example.com",
  "phone": "9876543210",
  "password": "plaintext_password",
  "otp": "123456"
}
```
**Response (200):**
```json
{
  "token": "jwt_token_here",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "Full Name",
    "phone": "9876543210",
    "role": "CUSTOMER"
  }
}
```
**Errors:** `400` if OTP invalid or expired.

---

### `POST /api/auth/login`
**Request:**
```json
{ "email": "user@example.com", "password": "plaintext_password" }
```
**Response (200):** same shape as `verify-signup`.
**Errors:** `401` invalid credentials.

---

### `GET /api/auth/me` *(auth required)*
Returns the current logged-in user.
**Response (200):**
```json
{ "id": "uuid", "email": "...", "name": "...", "phone": "...", "role": "CUSTOMER" }
```

---

### `GET /api/auth/google`
Redirects to Google's OAuth consent screen. Link a "Continue with Google" button directly to this URL — no fetch/AJAX needed, just navigate the browser here.

### `GET /api/auth/google/callback`
Handled entirely by the backend. After Google login, redirects the browser to:
```
{FRONTEND_URL}/auth/callback?token=<jwt_token>
```
**Frontend must have a `/auth/callback` page** that reads the `token` query param, stores it the same way normal login does, then redirects to the homepage.

---

## Products & Categories *(public, no auth)*

### `GET /api/categories`
**Response:** array of `{ id, name, slug }`

### `GET /api/products`
Query params (optional): `?category=<slug>` `&search=<text>`
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
  "categoryId": "uuid",
  "category": { "id": "uuid", "name": "Books", "slug": "books" }
}
```
`attributes` shape varies by category (books: author/language; attars: volume_ml/scent_notes; clothing: fabric/sizes_available) — render dynamically.

### `GET /api/products/:slug`
Single product, same shape as above. `404` if not found.

---

## Checkout *(auth required)*

### `POST /api/checkout/create-order`
Creates a Razorpay order. Does **not** touch the database yet.
**Request:**
```json
{ "items": [{ "productId": "uuid", "quantity": 1 }] }
```
**Response:**
```json
{ "razorpayOrderId": "order_xxx", "amount": 1599, "keyId": "rzp_test_xxx" }
```
Use `razorpayOrderId`, `amount`, `keyId` to open Razorpay's checkout widget (`amount` is in paise).

### `POST /api/checkout/verify`
Call this from Razorpay's `handler` callback after payment. Verifies the payment signature server-side, then creates the real order and decrements stock.
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
Pass these three `razorpay_*` fields exactly as Razorpay's widget returns them in its response object — do not rename or restructure them.

**Response (200):** the created order object, including `items`.
**Errors:** `400` — either `"Payment verification failed"` (signature mismatch) or a stock-related message.

---

## Orders *(auth required)*

### `GET /api/orders`
Returns the logged-in user's own order history.
**Response:** array of orders, each with `items` (including nested `product`).

### `GET /api/orders/:id`
Single order by ID — for an order confirmation/detail page. Returns `403` if the order belongs to a different user (unless requester is `ADMIN`), `404` if not found.

---

## Admin *(auth + ADMIN role required)*

All routes below return `403` if the logged-in user's role isn't `ADMIN`.

### `GET /api/admin/products` — all products
### `POST /api/admin/products` — create
```json
{ "name": "...", "description": "...", "price": 15.99, "originalPrice": null, "stock": 50, "categoryId": "uuid", "imageUrls": [], "attributes": {} }
```
### `PUT /api/admin/products/:id` — update (same body shape as create, `slug` unchanged)
### `DELETE /api/admin/products/:id` — delete

### `POST /api/admin/upload-image`
`multipart/form-data`, field name `image`. Returns `{ "url": "https://..." }` — use this URL in `imageUrls` when creating/editing a product.

### `GET /api/admin/orders` — all orders, any customer
### `PUT /api/admin/orders/:id`
```json
{ "status": "SHIPPED" }
```
Valid values: `PENDING`, `PAID`, `SHIPPED`, `DELIVERED`, `CANCELLED`.

---

## Notes
- This document is the source of truth. If something here doesn't match actual backend behavior, that's a bug to report — not a signal to guess a workaround.
- Last updated: reflects backend as of the email-OTP-verification and `/api/orders/:id` additions.
