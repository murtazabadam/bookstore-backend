require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Bookstore API running' });
});

// Get all categories
app.get('/api/categories', async (req, res) => {
  const categories = await prisma.category.findMany();
  res.json(categories);
});

// Get products (optionally filtered by category)
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

// Get single product by slug
app.get('/api/products/:slug', async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { slug: req.params.slug },
    include: { category: true },
  });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

// Signup
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name } = req.body;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(400).json({ error: 'Email already registered' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, password: hashedPassword, name },
  });

  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// Middleware to protect routes
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Example protected route — get current user
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
});


// Middleware: only allow admins through
function requireAdmin(req, res, next) {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Upload a product image — returns a public URL to use when creating/editing a product
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

// Create a product
app.post('/api/admin/products', requireAuth, requireAdmin, async (req, res) => {
  const { name, description, price, stock, categoryId, imageUrls, attributes } = req.body;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  try {
    const product = await prisma.product.create({
      data: { name, slug, description, price, stock, categoryId, imageUrls: imageUrls || [], attributes: attributes || {} },
    });
    res.json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update a product (also used for restocking — just send the new stock number)
app.put('/api/admin/products/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name, description, price, stock, imageUrls, attributes } = req.body;
  try {
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: { name, description, price, stock, imageUrls, attributes },
    });
    res.json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete a product
app.delete('/api/admin/products/:id', requireAuth, requireAdmin, async (req, res) => {
  await prisma.product.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// View all orders (for fulfilling/tracking, not just your own)
app.get('/api/admin/orders', requireAuth, requireAdmin, async (req, res) => {
  const orders = await prisma.order.findMany({
    include: { items: { include: { product: true } }, user: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(orders);
});

// Update order status (mark as shipped/delivered)
app.put('/api/admin/orders/:id', requireAuth, requireAdmin, async (req, res) => {
  const { status } = req.body;
  const order = await prisma.order.update({ where: { id: req.params.id }, data: { status } });
  res.json(order);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));