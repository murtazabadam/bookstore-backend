require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');

const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
const prisma = new PrismaClient();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const upload = multer({ storage: multer.memoryStorage() });
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const frontendUrls = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigins = [...new Set([...frontendUrls, 'http://localhost:3000'])];
const primaryFrontendUrl = frontendUrls[0];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
}));
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_secret',
  resave: false,
  saveUninitialized: false,
}));
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await prisma.user.findUnique({ where: { email: profile.emails[0].value } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          email: profile.emails[0].value,
          name: profile.displayName,
          password: null,
          emailVerified: true,
        },
      });
    }
    done(null, user);
  } catch (err) {
    done(err, null);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  const user = await prisma.user.findUnique({ where: { id } });
  done(null, user);
});

const otpAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Email sending via Brevo ─────────────────────────────────
async function sendOtpEmail(email, code) {
  const settings = await prisma.storeSettings.findUnique({ where: { id: 'singleton' } });
  const senderName = settings?.senderName || process.env.BREVO_SENDER_NAME;
  const replyTo = settings?.replyToEmail;

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: senderName, email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email }],
      ...(replyTo && { replyTo: { email: replyTo } }),
      subject: 'Verify your email - Maktabah Islamiyah',
      htmlContent: `<p>Your verification code is <strong>${code}</strong>. It expires in 10 minutes.</p><p>If you didn't request this, you can ignore this email.</p>`,
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Brevo error: ${errText}`);
  }
}
async function resolveItemPricing(item) {
  const product = await prisma.product.findUnique({
    where: { id: item.productId },
    include: { variants: true },
  });
  if (!product) throw new Error(`Product not found: ${item.productId}`);
  if (product.status !== 'ACTIVE') throw new Error(`${product.name} is not available for purchase`);

  if (product.variants && product.variants.length > 0) {
    const vi = item.variantInfo || {};
    const variant = product.variants.find(
      v => (v.size || null) === (vi.size || null) && (v.color || null) === (vi.color || null)
    );
    if (!variant) throw new Error(`Variant not found for ${product.name} (size: ${vi.size || '-'}, color: ${vi.color || '-'})`);
    if (variant.stock < item.quantity) throw new Error(`Insufficient stock for ${product.name} (${vi.size || ''} ${vi.color || ''})`);
    const price = variant.price != null ? Number(variant.price) : Number(product.price);
    return { product, variant, price };
  }

  if (product.stock < item.quantity) throw new Error(`Insufficient stock for ${product.name}`);
  return { product, variant: null, price: Number(product.price) };
}

async function calculateOrderTotal(items) {
  const settings = await prisma.storeSettings.findUnique({ where: { id: 'singleton' } });
  const freeThreshold = settings ? Number(settings.freeShippingThreshold) : 0;
  const shippingCharge = settings ? Number(settings.shippingCharge) : 0;

  let subtotal = 0;
  const lines = [];
  for (const item of items) {
    const { price } = await resolveItemPricing(item);
    subtotal += price * item.quantity;
    const vi = item.variantInfo || {};
    lines.push({
      productId: item.productId,
      quantity: item.quantity,
      variantInfo: { size: vi.size || null, color: vi.color || null },
      price,
    });
  }

  const appliedShipping = (freeThreshold > 0 && subtotal >= freeThreshold) ? 0 : shippingCharge;
  const round2 = n => Math.round(n * 100) / 100;
  return {
    subtotal: round2(subtotal),
    shippingCharge: round2(appliedShipping),
    total: round2(subtotal + appliedShipping),
    lines,
  };
}

async function syncProductStockFromVariants(productId) {
  const agg = await prisma.productVariant.aggregate({ where: { productId }, _sum: { stock: true } });
  await prisma.product.update({ where: { id: productId }, data: { stock: agg._sum.stock || 0 } });
}

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Bookstore API running' });
});

// ── Categories & Products (public) ──────────────────────────
app.get('/api/categories', async (req, res) => {
  const categories = await prisma.category.findMany({ where: { isActive: true } });
  res.json(categories);
});

app.get('/api/settings', async (req, res) => {
  const s = await prisma.storeSettings.findUnique({ where: { id: 'singleton' } });
  if (!s) return res.json({});
  res.json({
    storeName: s.storeName, tagline: s.tagline, storeEmail: s.storeEmail,
    phone: s.phone, address: s.address, logoUrl: s.logoUrl,
    shippingCharge: s.shippingCharge, freeShippingThreshold: s.freeShippingThreshold,
    deliveryEstimate: s.deliveryEstimate,
    courierName: s.courierName, trackingUrlTemplate: s.trackingUrlTemplate,
    onlinePaymentsEnabled: s.onlinePaymentsEnabled,
  });
});

app.get('/api/products', async (req, res) => {
  const { category, subcategory, search, featured } = req.query;
  const products = await prisma.product.findMany({
    where: {
      status: { not: 'DRAFT' },
      category: { isActive: true, ...(category && { slug: category }) },
      ...(subcategory && { subcategory }),
      ...(featured === 'true' && { featured: true }),
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
    },
    include: { category: true, variants: true },
  });
  res.json(products);
});

app.get('/api/products/subcategories', async (req, res) => {
  const { category } = req.query;
  const rows = await prisma.product.findMany({
    where: {
      subcategory: { not: null },
      status: { not: 'DRAFT' },
      category: { isActive: true, ...(category && { slug: category }) },
    },
    select: { subcategory: true },
    distinct: ['subcategory'],
  });
  res.json(rows.map(r => r.subcategory));
});

app.get('/api/products/:slug', async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { slug: req.params.slug },
    include: { category: true, variants: true },
  });
  if (!product || product.status === 'DRAFT' || !product.category.isActive) {
    return res.status(404).json({ error: 'Product not found' });
  }
  res.json(product);
});
// ── Auth: Signup with email OTP ──────────────────────────────
app.post('/api/auth/send-otp', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && existing.emailVerified) {
    return res.status(400).json({ error: 'Email already registered' });
  }

  const code = crypto.randomInt(100000, 1000000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.emailOtp.upsert({
    where: { email },
    update: { code, expiresAt },
    create: { email, code, expiresAt },
  });

  try {
    await sendOtpEmail(email, code);
    res.json({ message: 'OTP sent' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send verification email' });
  }
});

app.post('/api/auth/verify-signup', otpAttemptLimiter, async (req, res) => {
  const { name, email, phone, password, otp } = req.body;

  const record = await prisma.emailOtp.findUnique({ where: { email } });
  if (!record || record.code !== otp || record.expiresAt < new Date()) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const existing = await prisma.user.findUnique({ where: { email } });

  let user;
  if (existing) {
    user = await prisma.user.update({
      where: { email },
      data: { name, phone, password: hashedPassword, emailVerified: true },
    });
  } else {
    user = await prisma.user.create({
      data: { email, name, phone, password: hashedPassword, emailVerified: true },
    });
  }

  await prisma.emailOtp.delete({ where: { email } }).catch(() => {});

  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, phone: user.phone, role: user.role } });
});

// ── Auth: Login ───────────────────────────────────────────────
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.password || user.deletedAt || !user.isActive) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, phone: user.phone, role: user.role } });
});

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user || user.deletedAt || !user.isActive) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
  next();
}

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  res.json({ id: user.id, email: user.email, name: user.name, phone: user.phone, role: user.role });
});

app.put('/api/auth/me', requireAuth, async (req, res) => {
  const { name, phone, currentPassword, newPassword } = req.body;
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });

  const updateData = {};
  if (name) updateData.name = name;
  if (phone) updateData.phone = phone;

  if (newPassword) {
    if (!currentPassword || !user.password) {
      return res.status(400).json({ error: 'Current password required to change password' });
    }
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    updateData.password = await bcrypt.hash(newPassword, 10);
  }

  const updated = await prisma.user.update({ where: { id: req.user.userId }, data: updateData });
  res.json({ id: updated.id, email: updated.email, name: updated.name, phone: updated.phone, role: updated.role });
});

app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/api/auth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/login' }),
  (req, res) => {
    const token = jwt.sign({ userId: req.user.id, role: req.user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
   res.redirect(`${primaryFrontendUrl}/auth/callback?token=${token}`);
  }
);

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(404).json({ error: 'No account found with this email' });

  const code = crypto.randomInt(100000, 1000000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.emailOtp.upsert({
    where: { email },
    update: { code, expiresAt },
    create: { email, code, expiresAt },
  });

  try {
    await sendOtpEmail(email, code);
    res.json({ message: 'Reset code sent' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send reset email' });
  }
});

app.post('/api/auth/reset-password', otpAttemptLimiter, async (req, res) => {
  const { email, otp, newPassword } = req.body;

  const record = await prisma.emailOtp.findUnique({ where: { email } });
  if (!record || record.code !== otp || record.expiresAt < new Date()) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { email }, data: { password: hashedPassword } });
  await prisma.emailOtp.delete({ where: { email } }).catch(() => {});

  res.json({ message: 'Password reset successful' });
});

app.delete('/api/auth/me', requireAuth, async (req, res) => {
  const { currentPassword } = req.body;
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });

  if (user.password) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required to delete account' });
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
  }

  await prisma.user.update({
    where: { id: req.user.userId },
    data: {
      email: `deleted-${req.user.userId}@deleted.local`,
      name: 'Deleted User',
      phone: null,
      password: null,
      deletedAt: new Date(),
    },
  });
  res.json({ message: 'Account deleted' });
});

// ── Addresses ────────────────────────────────────────────────
app.get('/api/addresses', requireAuth, async (req, res) => {
  const addresses = await prisma.address.findMany({
    where: { userId: req.user.userId },
    orderBy: { createdAt: 'asc' },
  });
  res.json(addresses);
});

app.post('/api/addresses', requireAuth, async (req, res) => {
  const { label, fullName, phone, street, area, city, state, pincode } = req.body;
  const count = await prisma.address.count({ where: { userId: req.user.userId } });
  const address = await prisma.address.create({
    data: {
      userId: req.user.userId,
      label, fullName, phone, street, area, city, state, pincode,
      isDefault: count === 0,
    },
  });
  res.json(address);
});

app.put('/api/addresses/:id', requireAuth, async (req, res) => {
  const existing = await prisma.address.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Address not found' });
  if (existing.userId !== req.user.userId) return res.status(403).json({ error: 'Not authorized' });

  const { label, fullName, phone, street, area, city, state, pincode } = req.body;
  const address = await prisma.address.update({
    where: { id: req.params.id },
    data: { label, fullName, phone, street, area, city, state, pincode },
  });
  res.json(address);
});

app.delete('/api/addresses/:id', requireAuth, async (req, res) => {
  const existing = await prisma.address.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Address not found' });
  if (existing.userId !== req.user.userId) return res.status(403).json({ error: 'Not authorized' });

  await prisma.address.delete({ where: { id: req.params.id } });

  if (existing.isDefault) {
    const remaining = await prisma.address.findFirst({
      where: { userId: req.user.userId },
      orderBy: { createdAt: 'asc' },
    });
    if (remaining) {
      await prisma.address.update({ where: { id: remaining.id }, data: { isDefault: true } });
    }
  }

  res.json({ success: true });
});

app.put('/api/addresses/:id/default', requireAuth, async (req, res) => {
  const existing = await prisma.address.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Address not found' });
  if (existing.userId !== req.user.userId) return res.status(403).json({ error: 'Not authorized' });

  await prisma.$transaction([
    prisma.address.updateMany({ where: { userId: req.user.userId }, data: { isDefault: false } }),
    prisma.address.update({ where: { id: req.params.id }, data: { isDefault: true } }),
  ]);

  const updated = await prisma.address.findUnique({ where: { id: req.params.id } });
  res.json(updated);
});

// ── Admin: Users ─────────────────────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, email: true, phone: true, createdAt: true, isActive: true, role: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(users);
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { isActive } = req.body;
  if (typeof isActive !== 'boolean') return res.status(400).json({ error: 'isActive must be true or false' });
  if (req.params.id === req.user.userId && !isActive) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive },
      select: { id: true, name: true, email: true, phone: true, createdAt: true, isActive: true, role: true },
    });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: friendlyError(err) });
  }
});

// ── Admin: Settings ──────────────────────────────────────────
function formatSettings(s) {
  return {
    general: { storeName: s.storeName, tagline: s.tagline, storeEmail: s.storeEmail, phone: s.phone, address: s.address, logoUrl: s.logoUrl },
    payment: {
      onlinePaymentsEnabled: s.onlinePaymentsEnabled,
      codEnabled: s.codEnabled,
      mode: process.env.RAZORPAY_KEY_ID?.startsWith('rzp_live_') ? 'live' : 'test',
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      secretsConfigured: !!process.env.RAZORPAY_KEY_SECRET,
    },
    shipping: { shippingCharge: s.shippingCharge, freeShippingThreshold: s.freeShippingThreshold, deliveryEstimate: s.deliveryEstimate, courierName: s.courierName, trackingUrlTemplate: s.trackingUrlTemplate },
    email: { senderName: s.senderName, replyToEmail: s.replyToEmail, lowStockThreshold: s.lowStockThreshold },
  };
}

app.get('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  let s = await prisma.storeSettings.findUnique({ where: { id: 'singleton' } });
  if (!s) s = await prisma.storeSettings.create({ data: { id: 'singleton' } });
  res.json(formatSettings(s));
});

// Returns { data } to save, or throws SettingsError (→ 400 { error }).
class SettingsError extends Error {}
function validateSettings(body) {
  const { general = {}, shipping = {}, email = {}, payment = {} } = body || {};
  const data = {};
  const isEmpty = v => v === null || v === '';
  const text = (obj, key, { max, required = false } = {}) => {
    if (obj[key] === undefined) return;
    const v = obj[key];
    if (isEmpty(v)) {
      if (required) throw new SettingsError(`${key} cannot be empty`);
      data[key] = null; return;
    }
    if (typeof v !== 'string') throw new SettingsError(`${key} must be text`);
    if (v.trim().length > max) throw new SettingsError(`${key} must be at most ${max} characters`);
    data[key] = v.trim();
  };
  const emailField = (obj, key) => {
    if (obj[key] === undefined) return;
    if (isEmpty(obj[key])) { data[key] = null; return; }
    if (typeof obj[key] !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(obj[key].trim())) {
      throw new SettingsError(`${key} must be a valid email address`);
    }
    data[key] = obj[key].trim();
  };
  const money = (obj, key) => {
    if (obj[key] === undefined) return;
    const n = Number(obj[key]);
    if (obj[key] === null || obj[key] === '' || !Number.isFinite(n) || n < 0 || n > 1000000) {
      throw new SettingsError(`${key} must be a number between 0 and 1,000,000`);
    }
    data[key] = Math.round(n * 100) / 100;
  };
  const url = (obj, key) => {
    if (obj[key] === undefined) return null;
    if (isEmpty(obj[key])) { data[key] = null; return null; }
    if (typeof obj[key] !== 'string' || !/^https?:\/\/\S+$/i.test(obj[key].trim())) {
      throw new SettingsError(`${key} must be a link starting with http:// or https://`);
    }
    data[key] = obj[key].trim();
    return data[key];
  };

  // general
  text(general, 'storeName', { max: 100, required: true });
  text(general, 'tagline', { max: 200 });
  emailField(general, 'storeEmail');
  if (general.phone !== undefined) {
    if (isEmpty(general.phone)) data.phone = null;
    else if (!/^\d{10}$/.test(String(general.phone).trim())) throw new SettingsError('phone must be exactly 10 digits');
    else data.phone = String(general.phone).trim();
  }
  text(general, 'address', { max: 500 });
  url(general, 'logoUrl');

  // shipping
  money(shipping, 'shippingCharge');
  money(shipping, 'freeShippingThreshold');
  text(shipping, 'deliveryEstimate', { max: 100 });
  text(shipping, 'courierName', { max: 100 });
  const tpl = url(shipping, 'trackingUrlTemplate');
  if (tpl && !tpl.includes('{trackingNumber}')) {
    throw new SettingsError('trackingUrlTemplate must contain {trackingNumber}');
  }

  // email
  text(email, 'senderName', { max: 100 });
  emailField(email, 'replyToEmail');
  if (email.lowStockThreshold !== undefined) {
    const n = Number(email.lowStockThreshold);
    if (email.lowStockThreshold === null || email.lowStockThreshold === '' || !Number.isInteger(n) || n < 0 || n > 100000) {
      throw new SettingsError('lowStockThreshold must be a whole number between 0 and 100000');
    }
    data.lowStockThreshold = n;
  }

  // payment
  if (payment.onlinePaymentsEnabled !== undefined) {
    if (typeof payment.onlinePaymentsEnabled !== 'boolean') throw new SettingsError('onlinePaymentsEnabled must be true or false');
    data.onlinePaymentsEnabled = payment.onlinePaymentsEnabled;
  }
  if (payment.codEnabled !== undefined) {
    if (typeof payment.codEnabled !== 'boolean') throw new SettingsError('codEnabled must be true or false');
    if (payment.codEnabled) throw new SettingsError('Cash on delivery is not supported yet');
    data.codEnabled = false;
  }
  return data;
}

app.put('/api/admin/settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = validateSettings(req.body);
    const s = await prisma.storeSettings.upsert({ where: { id: 'singleton' }, update: data, create: { id: 'singleton', ...data } });
    res.json(formatSettings(s));
  } catch (err) {
    if (err instanceof SettingsError) return res.status(400).json({ error: err.message });
    res.status(400).json({ error: friendlyError(err) });
  }
});

// ── Admin: Products ──────────────────────────────────────────
app.post('/api/admin/upload-image', requireAuth, requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const fileName = `${Date.now()}-${req.file.originalname}`;
    const { error } = await supabase.storage
      .from('product-images')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
    if (error) throw error;

    const { data } = supabase.storage.from('product-images').getPublicUrl(fileName);
    res.json({ url: data.publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/products', requireAuth, requireAdmin, async (req, res) => {
  const products = await prisma.product.findMany({
    include: { category: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(products);
});

app.get('/api/admin/products/:id', requireAuth, requireAdmin, async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
    include: { category: true, variants: true },
  });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

app.post('/api/admin/products', requireAuth, requireAdmin, async (req, res) => {
  const { name, description, price, originalPrice, stock, categoryId, subcategory, brand, sku, status, featured, imageUrls, attributes, variants } = req.body;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  try {
    const product = await prisma.product.create({
      data: {
        name, slug, description, price,
        originalPrice: originalPrice || null,
        stock: stock || 0, categoryId,
        subcategory: subcategory || null,
        brand: brand || null,
        sku: sku || null,
        status: status || 'ACTIVE',
        featured: !!featured,
        imageUrls: imageUrls || [],
        attributes: attributes || {},
        ...(variants && variants.length > 0 && {
          variants: { create: variants.map(v => ({ size: v.size || null, color: v.color || null, sku: v.sku || null, price: v.price || null, stock: v.stock || 0 })) },
        }),
      },
    });
    if (variants && variants.length > 0) await syncProductStockFromVariants(product.id);
    res.json(product);
  } catch (err) {
    res.status(400).json({ error: friendlyError(err) });
  }
});

app.put('/api/admin/products/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name, description, price, originalPrice, stock, categoryId, subcategory, brand, sku, status, featured, imageUrls, attributes, variants } = req.body;
  try {
    if (variants) {
      await prisma.productVariant.deleteMany({ where: { productId: req.params.id } });
      if (variants.length > 0) {
        await prisma.productVariant.createMany({
          data: variants.map(v => ({ productId: req.params.id, size: v.size || null, color: v.color || null, sku: v.sku || null, price: v.price || null, stock: v.stock || 0 })),
        });
      }
    }

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        name, description, price,
        originalPrice: originalPrice || null,
        stock, categoryId,
        subcategory: subcategory || null,
        brand: brand || null,
        sku: sku || null,
        status: status || undefined,
        featured: featured !== undefined ? !!featured : undefined,
        imageUrls, attributes,
      },
    });
    if (variants && variants.length > 0) await syncProductStockFromVariants(req.params.id);
    res.json(product);
  } catch (err) {
    res.status(400).json({ error: friendlyError(err) });
  }
});

app.delete('/api/admin/products/:id', requireAuth, requireAdmin, async (req, res) => {
  const orderCount = await prisma.orderItem.count({ where: { productId: req.params.id } });
  if (orderCount > 0) {
    return res.status(409).json({ error: 'This product appears in past orders and cannot be deleted. Set its status to DRAFT to hide it instead.' });
  }
  try {
    await prisma.productVariant.deleteMany({ where: { productId: req.params.id } });
    await prisma.product.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: friendlyError(err) });
  }
});

// ── Admin: Orders ────────────────────────────────────────────
app.get('/api/admin/orders', requireAuth, requireAdmin, async (req, res) => {
  const orders = await prisma.order.findMany({
    include: {
      items: { include: { product: true } },
      user: { select: { id: true, name: true, email: true, phone: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(orders);
});

app.put('/api/admin/orders/:id', requireAuth, requireAdmin, async (req, res) => {
  const { status, trackingNumber } = req.body;
  try {
    const existing = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!existing) return res.status(404).json({ error: 'Order not found' });

    if (existing.status === 'CANCELLED' && status && status !== 'CANCELLED') {
      return res.status(400).json({ error: 'Cannot change the status of a cancelled order' });
    }

    const updateData = {};
    if (status) updateData.status = status;
    if (trackingNumber !== undefined) updateData.trackingNumber = trackingNumber;

    if (status === 'CANCELLED' && existing.status !== 'CANCELLED') {
      for (const item of existing.items) {
        const product = await prisma.product.findUnique({ where: { id: item.productId }, include: { variants: true } });
        const vi = item.variantInfo || {};
        const variant = product.variants.find(v => (v.size || null) === (vi.size || null) && (v.color || null) === (vi.color || null));
        if (variant) {
          await prisma.productVariant.update({ where: { id: variant.id }, data: { stock: { increment: item.quantity } } });
          await syncProductStockFromVariants(item.productId);
        } else {
          await prisma.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
        }
      }
    }

    const order = await prisma.order.update({ where: { id: req.params.id }, data: updateData });
    res.json(order);
  } catch (err) {
    res.status(400).json({ error: friendlyError(err) });
  }
});

app.get('/api/admin/categories', requireAuth, requireAdmin, async (req, res) => {
  const categories = await prisma.category.findMany({
    include: { _count: { select: { products: true } } },
  });
  res.json(categories.map(c => ({ ...c, productCount: c._count.products, _count: undefined })));
});

app.post('/api/admin/categories', requireAuth, requireAdmin, async (req, res) => {
  const { name, slug, imageUrl, isActive } = req.body;
  const finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  try {
    const category = await prisma.category.create({
      data: { name, slug: finalSlug, imageUrl: imageUrl || null, isActive: isActive !== undefined ? isActive : true },
    });
    res.json(category);
  } catch (err) {
    res.status(400).json({ error: friendlyError(err) });
  }
});

app.put('/api/admin/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name, slug, imageUrl, isActive } = req.body;
  const data = {};
  if (name !== undefined) data.name = name;
  if (slug !== undefined) data.slug = slug;
  if (imageUrl !== undefined) data.imageUrl = imageUrl;
  if (isActive !== undefined) data.isActive = isActive;
  try {
    const category = await prisma.category.update({ where: { id: req.params.id }, data });
    res.json(category);
  } catch (err) {
    res.status(400).json({ error: friendlyError(err) });
  }
});

app.delete('/api/admin/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  const count = await prisma.product.count({ where: { categoryId: req.params.id } });
  if (count > 0) {
    return res.status(409).json({ error: `Cannot delete — ${count} product(s) still use this category` });
  }
  await prisma.category.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// ── Customer: Order history ─────────────────────────────────
app.get('/api/orders', requireAuth, async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.user.userId },
    include: { items: { include: { product: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(orders);
});

app.get('/api/orders/:id', requireAuth, async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { items: { include: { product: true } } },
  });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.userId !== req.user.userId && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Not authorized to view this order' });
  }
  res.json(order);
});

// ── Checkout: Razorpay ───────────────────────────────────────
// Flow: create-order prices the cart on the server and saves it against the
// Razorpay order id (CheckoutSession). verify then checks the signature, asks
// Razorpay what was actually paid, compares it with the saved total, and
// builds the order from the SAVED items — never from what the browser sends.

class CheckoutError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
class StockError extends Error {}

function parseCartItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new CheckoutError(400, 'Your cart is empty');
  if (items.length > 50) throw new CheckoutError(400, 'Too many items in one order');
  const merged = new Map();
  for (const i of items) {
    const quantity = Number(i && i.quantity);
    if (!i || typeof i.productId !== 'string' || !i.productId) throw new CheckoutError(400, 'Invalid item in cart');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new CheckoutError(400, 'Invalid item quantity');
    const vi = i.variantInfo || {};
    const key = `${i.productId}|${vi.size || ''}|${vi.color || ''}`;
    // Same product+size+colour on two lines counts as one line for stock checks.
    if (merged.has(key)) merged.get(key).quantity += quantity;
    else merged.set(key, { productId: i.productId, quantity, variantInfo: { size: vi.size || null, color: vi.color || null } });
  }
  return [...merged.values()];
}

function razorpayErrorMessage(err, fallback) {
  return err?.error?.description || err?.message || fallback;
}

app.post('/api/checkout/create-order', requireAuth, async (req, res) => {
  try {
    const storeSettings = await prisma.storeSettings.findUnique({ where: { id: 'singleton' } });
    if (storeSettings && storeSettings.onlinePaymentsEnabled === false) {
      throw new CheckoutError(503, 'Online payments are currently unavailable. Please try again later.');
    }
    const items = parseCartItems(req.body.items);
    const { subtotal, shippingCharge, total, lines } = await calculateOrderTotal(items);
    const amountPaise = Math.round(total * 100);
    if (amountPaise < 100) throw new CheckoutError(400, 'Order total is too low to process');

    let razorpayOrder;
    try {
      razorpayOrder = await razorpay.orders.create({
        amount: amountPaise,
        currency: 'INR',
        receipt: `receipt_${Date.now()}`,
        notes: { userId: req.user.userId },
      });
    } catch (err) {
      console.error('Razorpay order create failed', err);
      throw new CheckoutError(502, razorpayErrorMessage(err, 'Could not start the payment. Please try again.'));
    }

    await prisma.checkoutSession.create({
      data: {
        razorpayOrderId: razorpayOrder.id,
        userId: req.user.userId,
        items: lines,
        subtotal, shippingCharge, total, amountPaise,
      },
    });

    res.json({
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      keyId: process.env.RAZORPAY_KEY_ID,
      subtotal, shippingCharge, total,
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post('/api/checkout/verify', requireAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, shippingAddress } = req.body;
  const userId = req.user.userId;

  try {
    for (const v of [razorpay_order_id, razorpay_payment_id, razorpay_signature]) {
      if (typeof v !== 'string' || !v) throw new CheckoutError(400, 'Missing payment details');
    }
    if (typeof shippingAddress !== 'string' || !shippingAddress.trim()) {
      throw new CheckoutError(400, 'Shipping address is required');
    }

    // 1. Signature proves Razorpay issued this order/payment pair.
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    const given = Buffer.from(razorpay_signature, 'hex');
    const want = Buffer.from(expected, 'hex');
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      throw new CheckoutError(400, 'Payment verification failed');
    }

    // 2. Same payment sent again → hand back the order it already created.
    const existingOrder = await prisma.order.findUnique({
      where: { razorpayPaymentId: razorpay_payment_id },
      include: { items: true },
    });
    if (existingOrder) {
      if (existingOrder.userId !== userId) throw new CheckoutError(409, 'This payment has already been used');
      return res.json(existingOrder);
    }

    // 3. What did the server price for this Razorpay order?
    const session = await prisma.checkoutSession.findUnique({ where: { razorpayOrderId: razorpay_order_id } });
    if (!session || session.userId !== userId) throw new CheckoutError(404, 'Checkout session not found');
    if (session.consumedAt) throw new CheckoutError(409, 'This checkout has already been completed');

    // 4. What did Razorpay actually receive?
    let payment;
    try {
      payment = await razorpay.payments.fetch(razorpay_payment_id);
      if (payment.status === 'authorized') {
        payment = await razorpay.payments.capture(razorpay_payment_id, payment.amount, payment.currency);
      }
    } catch (err) {
      console.error('Razorpay payment lookup failed', err);
      throw new CheckoutError(502, 'Could not confirm the payment with Razorpay. Please contact support if you were charged.');
    }
    if (payment.order_id !== razorpay_order_id) throw new CheckoutError(400, 'Payment does not belong to this order');
    if (payment.status !== 'captured') throw new CheckoutError(400, 'Payment has not been completed');
    if (payment.currency !== 'INR' || payment.amount !== session.amountPaise) {
      console.error('Amount mismatch', { razorpay_order_id, razorpay_payment_id, paid: payment.amount, expected: session.amountPaise });
      throw new CheckoutError(400, 'Paid amount does not match the order total. Please contact support.');
    }

    // 5. Build the order from the SAVED items; claim stock atomically.
    const lines = session.items;
    let order;
    try {
      order = await prisma.$transaction(async (tx) => {
        const claimed = await tx.checkoutSession.updateMany({
          where: { id: session.id, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        if (claimed.count === 0) throw new CheckoutError(409, 'This checkout has already been completed');

        const variantProducts = new Set();
        for (const line of lines) {
          const product = await tx.product.findUnique({ where: { id: line.productId }, include: { variants: true } });
          if (!product) throw new StockError(`A product in your order is no longer available`);

          if (product.variants.length > 0) {
            const vi = line.variantInfo || {};
            const variant = product.variants.find(
              v => (v.size || null) === (vi.size || null) && (v.color || null) === (vi.color || null)
            );
            if (!variant) throw new StockError(`${product.name} is no longer available in that option`);
            const r = await tx.productVariant.updateMany({
              where: { id: variant.id, stock: { gte: line.quantity } },
              data: { stock: { decrement: line.quantity } },
            });
            if (r.count === 0) throw new StockError(`${product.name} just sold out`);
            variantProducts.add(product.id);
          } else {
            const r = await tx.product.updateMany({
              where: { id: product.id, stock: { gte: line.quantity } },
              data: { stock: { decrement: line.quantity } },
            });
            if (r.count === 0) throw new StockError(`${product.name} just sold out`);
          }
        }

        for (const productId of variantProducts) {
          const agg = await tx.productVariant.aggregate({ where: { productId }, _sum: { stock: true } });
          await tx.product.update({ where: { id: productId }, data: { stock: agg._sum.stock || 0 } });
        }

        return tx.order.create({
          data: {
            userId,
            total: session.total,
            shippingCharge: session.shippingCharge,
            shippingAddress: shippingAddress.trim(),
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
            status: 'PAID',
            items: {
              create: lines.map(l => ({
                productId: l.productId,
                quantity: l.quantity,
                variantInfo: l.variantInfo || {},
                priceAtPurchase: l.price,
              })),
            },
          },
          include: { items: true },
        });
      }, { timeout: 15000, maxWait: 10000 });
    } catch (err) {
      if (err instanceof StockError) {
        // Paid, but we can't fulfil it — give the money back.
        let refunded = false;
        try {
          await razorpay.payments.refund(razorpay_payment_id, {
            amount: session.amountPaise,
            notes: { reason: 'Item sold out during checkout' },
          });
          refunded = true;
        } catch (refundErr) {
          console.error('AUTO-REFUND FAILED — refund manually', { razorpay_payment_id, refundErr });
        }
        throw new CheckoutError(409, refunded
          ? `${err.message}. Your payment has been refunded.`
          : `${err.message}. We could not refund you automatically — please contact support with payment ID ${razorpay_payment_id}.`);
      }
      if (err.code === 'P2002') {
        // Two verify calls raced; the other one won. Return its order.
        const winner = await prisma.order.findUnique({
          where: { razorpayPaymentId: razorpay_payment_id },
          include: { items: true },
        });
        if (winner && winner.userId === userId) return res.json(winner);
        throw new CheckoutError(409, 'This payment has already been used');
      }
      throw err;
    }

    res.json(order);
  } catch (err) {
    if (err instanceof CheckoutError) return res.status(err.status).json({ error: err.message });
    console.error('Checkout verify failed', err);
    res.status(500).json({ error: 'Something went wrong confirming your order. If you were charged, please contact support.' });
  }
});

function friendlyError(err) {
  console.error(err);
  if (err.code === 'P2002') return `Another record already uses that ${(err.meta?.target || []).join(', ') || 'value'}`;
  if (err.code === 'P2025') return 'Record not found';
  if (err.code === 'P2003') return 'This record is linked to other data and cannot be changed this way';
  if (err.name && err.name.startsWith('PrismaClient')) return 'Invalid input. Please check the values and try again';
  return err.message;
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));