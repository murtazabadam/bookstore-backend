const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const categories = await prisma.category.findMany();
  const catId = (slug) => categories.find(c => c.slug === slug).id;

  const products = [
    { name: 'The Riyadhus-Saliheen', slug: 'riyadhus-saliheen', description: 'A renowned compilation of authentic hadiths by Imam Nawawi.', price: 499, stock: 40, category: 'books', attributes: { author: 'Imam Nawawi', language: 'English/Arabic' } },
    { name: 'Sahih Al-Bukhari (Arabic)', slug: 'sahih-al-bukhari-arabic', description: 'The most authentic collection of hadith, complete set.', price: 799, stock: 25, category: 'books', attributes: { author: 'Imam Bukhari', language: 'Arabic' } },
    { name: 'Fortress of the Muslim', slug: 'fortress-of-the-muslim', description: 'A pocket-sized collection of daily duas and adhkar.', price: 399, stock: 60, category: 'books', attributes: { author: 'Said bin Ali bin Wahf Al-Qahtani', language: 'English/Arabic' } },

    { name: 'Rasasi Hawas Attar', slug: 'rasasi-hawas-attar', description: 'Long-lasting alcohol-free fragrance oil, 12ml.', price: 699, stock: 35, category: 'attars', attributes: { volume_ml: '12', scent_notes: 'Amber, Woody' } },
    { name: 'Oud Attar', slug: 'oud-attar', description: 'Premium alcohol-free oud fragrance oil.', price: 799, stock: 30, category: 'attars', attributes: { volume_ml: '12', scent_notes: 'Oud, Musk' } },

    { name: 'White Muslim Cap', slug: 'white-muslim-cap', description: 'Classic cotton prayer cap, breathable and lightweight.', price: 299, stock: 80, category: 'caps', attributes: { fabric: 'Cotton', sizes_available: ['S', 'M', 'L'] } },
    { name: 'Premium Cap', slug: 'premium-cap', description: 'Embroidered premium-quality prayer cap.', price: 349, stock: 50, category: 'caps', attributes: { fabric: 'Cotton Blend', sizes_available: ['M', 'L'] } },

    { name: "Men's Shalwar Kameez", slug: 'mens-shalwar-kameez', description: 'Comfortable everyday shalwar kameez, tailored fit.', price: 1299, stock: 20, category: 'shalwar-kameez', attributes: { fabric: 'Cotton', sizes_available: ['S', 'M', 'L', 'XL'] } },
    { name: 'Kameez Shalwar', slug: 'kameez-shalwar', description: 'Simple, breathable daily-wear shalwar kameez.', price: 1499, stock: 18, category: 'shalwar-kameez', attributes: { fabric: 'Linen Blend', sizes_available: ['M', 'L', 'XL'] } },

    { name: 'Black Abaya', slug: 'black-abaya', description: 'Simple, elegant black abaya.', price: 2499, stock: 20, category: 'abayas', attributes: { sizes_available: ['S', 'M', 'L', 'XL'], fabric: 'Crepe' } },

    { name: 'Rose Jilbab', slug: 'rose-jilbab', description: 'Modest, flowing jilbab in a soft rose tone.', price: 1899, stock: 15, category: 'jilbabs', attributes: { fabric: 'Nida', sizes_available: ['S', 'M', 'L'] } },

    { name: 'Prayer Mat', slug: 'prayer-mat', description: 'Soft, cushioned prayer mat with compass.', price: 599, stock: 40, category: 'prayer-quran-accessories', attributes: { material: 'Velvet' } },
    { name: 'Wooden Tasbeeh (99 Beads)', slug: 'wooden-tasbeeh', description: 'Handcrafted wooden tasbeeh for dhikr.', price: 199, stock: 70, category: 'prayer-quran-accessories', attributes: { material: 'Wood', bead_count: '99' } },
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        name: p.name,
        slug: p.slug,
        description: p.description,
        price: p.price,
        stock: p.stock,
        imageUrls: [],
        attributes: p.attributes,
        categoryId: catId(p.category),
      },
    });
    console.log(`Upserted: ${p.name}`);
  }

  console.log('\nSeed complete.');
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());