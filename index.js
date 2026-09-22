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

const app = express();
const prisma = new PrismaClient();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const upload = multer({ storage: multer.memoryStorage() });
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.use(cors());
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

// ── Email sending via Brevo ─────────────────────────────────
async function sendOtpEmail(email, code) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: process.env.BREVO_SENDER_NAME, email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email }],
      subject: 'Verify your email - Maktabah Islamiyah',
      htmlContent: `<p>Your verification code is <strong>${code}</strong>. It expires in 10 minutes.</p><p>If you didn't request this, you can ignore this email.</p>`,
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Brevo error: ${errText}`);
  }
}

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Bookstore API running' });
});

// ── Categories & Products (public) ──────────────────────────
app.get('/api/categories', async (req, res) => {
  const categories = await prisma.category.findMany();
  res.json(categories);
});

app.get('/api/products', async (req, res) => {
  const { category, search } = req.query;
  const products = await prisma.product.findMany({
    where: {
      ...(category && { category: { slug: category } }),
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
    },
    include: { category: true },
  });
  res.json(products);
});

app.get('/api/products/:slug', async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { slug: req.params.slug },
    include: { category: true },
  });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

// ── Auth: Signup with email OTP ──────────────────────────────
app.post('/api/auth/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && existing.emailVerified) {
    return res.status(400).json({ error: 'Email already registered' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
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

app.post('/api/auth/verify-signup', async (req, res) => {
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
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.password) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, phone: user.phone, role: user.role } });
});

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
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
    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${token}`);
  }
);
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(404).json({ error: 'No account found with this email' });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
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

app.post('/api/auth/reset-password', async (req, res) => {
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

app.post('/api/admin/products', requireAuth, requireAdmin, async (req, res) => {
  const { name, description, price, originalPrice, stock, categoryId, imageUrls, attributes } = req.body;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  try {
    const product = await prisma.product.create({
      data: {
        name, slug, description, price,
        originalPrice: originalPrice || null,
        stock, categoryId,
        imageUrls: imageUrls || [],
        attributes: attributes || {},
      },
    });
    res.json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/products/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name, description, price, originalPrice, stock, imageUrls, attributes } = req.body;
  try {
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: { name, description, price, originalPrice: originalPrice || null, stock, imageUrls, attributes },
    });
    res.json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/products/:id', requireAuth, requireAdmin, async (req, res) => {
  await prisma.product.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// ── Admin: Orders ────────────────────────────────────────────
app.get('/api/admin/orders', requireAuth, requireAdmin, async (req, res) => {
  const orders = await prisma.order.findMany({
    include: { items: { include: { product: true } }, user: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(orders);
});

app.put('/api/admin/orders/:id', requireAuth, requireAdmin, async (req, res) => {
  const { status } = req.body;
  const order = await prisma.order.update({ where: { id: req.params.id }, data: { status } });
  res.json(order);
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
app.post('/api/checkout/create-order', requireAuth, async (req, res) => {
  const { items } = req.body;
  try {
    let total = 0;
    for (const item of items) {
      const product = await prisma.product.findUnique({ where: { id: item.productId } });
      if (!product) throw new Error(`Product not found: ${item.productId}`);
      if (product.stock < item.quantity) throw new Error(`Insufficient stock for ${product.name}`);
      total += Number(product.price) * item.quantity;
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(total * 100),
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
    });

    res.json({ razorpayOrderId: razorpayOrder.id, amount: razorpayOrder.amount, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/checkout/verify', requireAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, items, shippingAddress } = req.body;

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment verification failed' });
  }

  try {
    const order = await prisma.$transaction(async (tx) => {
      let total = 0;
      const orderItemsData = [];

      for (const item of items) {
        const product = await tx.product.findUnique({ where: { id: item.productId } });
        if (!product || product.stock < item.quantity) {
          throw new Error(`Stock issue with product ${item.productId}`);
        }
        total += Number(product.price) * item.quantity;
        orderItemsData.push({
          productId: product.id,
          quantity: item.quantity,
          variantInfo: item.variantInfo || {},
          priceAtPurchase: product.price,
        });
        await tx.product.update({ where: { id: product.id }, data: { stock: { decrement: item.quantity } } });
      }

      return tx.order.create({
        data: { userId: req.user.userId, total, shippingAddress, status: 'PAID', items: { create: orderItemsData } },
        include: { items: true },
      });
    });

    res.json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));