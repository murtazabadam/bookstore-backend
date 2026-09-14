const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const EMAIL_TO_PROMOTE = 'owner-email-goes-here@example.com';

async function main() {
  const user = await prisma.user.update({
    where: { email: EMAIL_TO_PROMOTE },
    data: { role: 'ADMIN' },
  });
  console.log(`${user.email} is now an ADMIN.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());