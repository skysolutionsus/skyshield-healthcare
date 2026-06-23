import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

const prisma = new PrismaClient();

const adminPassword = process.env.SEED_ADMIN_PASSWORD || "SkyShield2026!";
const csrPassword =
  process.env.SEED_COMPUTER_SECURITY_REVIEW_PASSWORD || "ComputerSecurity2026!";
const invitedUserPassword =
  process.env.SEED_INVITED_USER_PASSWORD || csrPassword;
const jackCochranPasswordHash =
  "$2b$12$q98m4ao9.3t42NJDxsVw8.pq4PW.QjzXbl1fMsPRihQQEzYXyIspu";
const paulJohnsonPasswordHash =
  "$2b$12$psblO4H1rjfWhbnlS.5SW..aXtmraECyWsHS.AGhj7MLVPDko.8d6";

function nameFromEmail(email: string) {
  const localPart = email.split("@")[0] || email;

  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: "sky-solutions" },
    update: { name: "Sky Solutions" },
    create: { name: "Sky Solutions", slug: "sky-solutions" },
  });

  const adminPasswordHash = await hash(adminPassword, 12);
  const csrPasswordHash = await hash(csrPassword, 12);
  const invitedUserPasswordHash = await hash(invitedUserPassword, 12);

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
    {
      email: "jcochran@skysolutions.com",
      name: "Jack Cochran",
      role: "ADMIN" as const,
      passwordHash: jackCochranPasswordHash,
    },
    {
      email: "pjohnson@skysolutions.com",
      name: "Paul Johnson",
      role: "ADMIN" as const,
      passwordHash: paulJohnsonPasswordHash,
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

  const pendingInvitations = await prisma.invitation.findMany({
    where: {
      used: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const invitation of pendingInvitations) {
    const existingUser = await prisma.user.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    });

    await prisma.user.upsert({
      where: { email: invitation.email },
      update: {
        role: invitation.role,
        organizationId: invitation.organizationId,
        active: true,
      },
      create: {
        email: invitation.email,
        name: nameFromEmail(invitation.email),
        role: invitation.role,
        passwordHash: invitedUserPasswordHash,
        organizationId: invitation.organizationId,
      },
    });

    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { used: true },
    });

    console.log(
      `${existingUser ? "Activated existing" : "Provisioned invited"} user ${invitation.email} as ${invitation.role}`
    );
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
