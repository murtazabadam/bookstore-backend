const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Map each product's slug to its uploaded image URL(s).
// Update these URLs after uploading real photos to Supabase Storage.
const imageMap = {
  'riyadhus-saliheen': ['https://your-project.supabase.co/storage/v1/object/public/product-images/riyadhus-saliheen.jpg'],
  'sahih-al-bukhari-arabic': [],
  'fortress-of-the-muslim': [],
  'rasasi-hawas-attar': [],
  'oud-attar': ['...'],
  'white-muslim-cap': [],
  'premium-cap': ['...'],
  'mens-shalwar-kameez': [],
  'kameez-shalwar': [],
  'black-abaya': [],
  'rose-jilbab': [],
  'prayer-mat': [],
  'wooden-tasbeeh': [],
};

async function main() {
  for (const [slug, imageUrls] of Object.entries(imageMap)) {
    await prisma.product.update({ where: { slug }, data: { imageUrls } });
    console.log(`Updated images for: ${slug}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());