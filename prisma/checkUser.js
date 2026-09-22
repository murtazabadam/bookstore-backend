const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const email = 'murtazabadam+test1@gmail.com';
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    console.log(`No user found with email: ${email}`);
    console.log('He needs to sign up first before he can log in.');
  } else {
    console.log('User found:');
    console.log({ id: user.id, email: user.email, name: user.name, role: user.role });
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());