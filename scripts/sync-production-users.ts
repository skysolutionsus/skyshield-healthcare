import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

const prisma = new PrismaClient();

const adminPassword = process.env.SEED_ADMIN_PASSWORD || "SkyShield2026!";
const csrPassword =
  process.env.SEED_COMPUTER_SECURITY_REVIEW_PASSWORD || "ComputerSecurity2026!";

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: "sky-solutions" },
    update: { name: "Sky Solutions" },
    create: { name: "Sky Solutions", slug: "sky-solutions" },
  });

  const adminPasswordHash = await hash(adminPassword, 12);
  const csrPasswordHash = await hash(csrPassword, 12);

  const users = [
    {
      email: "james@skysolutions.com",
      name: "James Galang",
      role: "ADMIN" as const,
      passwordHash: adminPasswordHash,
    },
    {
      email: "jcambra@skysolutions.com",
      name: "Jared Cambra",
      role: "ADMIN" as const,
      passwordHash: adminPasswordHash,
    },
    {
      email: "mconklin@skysolutions.com",
      name: "Michael Conklin",
      role: "ADMIN" as const,
      passwordHash: adminPasswordHash,
    },
    {
      email: "nmatta@skysolutions.com",
      name: "Nitin Matta",
      role: "ADMIN" as const,
      passwordHash: adminPasswordHash,
    },
    {
      email: "folami.r.lofinmakinjr2@irs.gov",
      name: "Folami Lofinmakin",
      role: "COMPUTER_SECURITY_REVIEW" as const,
      passwordHash: csrPasswordHash,
    },
  ];

  for (const user of users) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: {
        name: user.name,
        role: user.role,
        organizationId: org.id,
        active: true,
      },
      create: {
        email: user.email,
        name: user.name,
        role: user.role,
        passwordHash: user.passwordHash,
        organizationId: org.id,
      },
    });
    console.log(`Synced ${user.email} as ${user.role}`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
