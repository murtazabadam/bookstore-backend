const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const books = await prisma.category.create({
    data: { name: 'Books', slug: 'books' },
  });
  const attars = await prisma.category.create({
    data: { name: 'Attars', slug: 'attars' },
  });
  const clothing = await prisma.category.create({
    data: { name: 'Clothing', slug: 'clothing' },
  });

  await prisma.product.create({
    data: {
      name: 'Kitab al-Tawheed',
      slug: 'kitab-al-tawheed',
      description: 'A foundational text on Islamic monotheism.',
      price: 15.99,
      stock: 50,
      imageUrls: [],
      attributes: { author: 'Muhammad ibn Abd al-Wahhab', language: 'English' },
      categoryId: books.id,
    },
  });

  await prisma.product.create({
    data: {
      name: 'Oud Attar',
      slug: 'oud-attar',
      description: 'Premium alcohol-free oud fragrance oil.',
      price: 24.99,
      stock: 30,
      imageUrls: [],
      attributes: { volume_ml: '12', scent_notes: 'Oud, Musk' },
      categoryId: attars.id,
    },
  });

  await prisma.product.create({
    data: {
      name: 'Black Abaya',
      slug: 'black-abaya',
      description: 'Simple, elegant black abaya.',
      price: 45.00,
      stock: 20,
      imageUrls: [],
      attributes: { sizes_available: ['S', 'M', 'L', 'XL'], fabric: 'Crepe' },
      categoryId: clothing.id,
    },
  });

  console.log('Seed data created.');
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());