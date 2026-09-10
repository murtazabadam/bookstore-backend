require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));