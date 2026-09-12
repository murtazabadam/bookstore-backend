const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find the old "Clothing" category and the product attached to it
  const clothing = await prisma.category.findUnique({ where: { slug: 'clothing' } });

  // Create the new, correct category list
  const caps = await prisma.category.upsert({
    where: { slug: 'caps' },
    update: {},
    create: { name: 'Caps', slug: 'caps' },
  });
  const shalwarKameez = await prisma.category.upsert({
    where: { slug: 'shalwar-kameez' },
    update: {},
    create: { name: 'Shalwar Kameez', slug: 'shalwar-kameez' },
  });
  const abayas = await prisma.category.upsert({
    where: { slug: 'abayas' },
    update: {},
    create: { name: 'Abayas', slug: 'abayas' },
  });
  const jilbabs = await prisma.category.upsert({
    where: { slug: 'jilbabs' },
    update: {},
    create: { name: 'Jilbabs', slug: 'jilbabs' },
  });
  const prayerAccessories = await prisma.category.upsert({
    where: { slug: 'prayer-quran-accessories' },
    update: {},
    create: { name: 'Prayer & Quran Accessories', slug: 'prayer-quran-accessories' },
  });

  console.log('New categories created/confirmed.');

  // Move any products out of "Clothing" into the correct new category before deleting it
  if (clothing) {
    const productsInClothing = await prisma.product.findMany({ where: { categoryId: clothing.id } });
    for (const product of productsInClothing) {
      // Your seeded "Black Abaya" belongs in Abayas — adjust this mapping if you add more later
      await prisma.product.update({
        where: { id: product.id },
        data: { categoryId: abayas.id },
      });
      console.log(`Moved "${product.name}" to Abayas`);
    }

    await prisma.category.delete({ where: { id: clothing.id } });
    console.log('Deleted old "Clothing" category.');
  }

  const finalCategories = await prisma.category.findMany();
  console.log('\nFinal category list:');
  finalCategories.forEach(c => console.log(`- ${c.name} (${c.slug})`));
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());