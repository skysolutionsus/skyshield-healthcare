import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import { strongPasswordValidationError } from "../src/lib/password-policy";

const prisma = new PrismaClient();

function requiredValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be explicitly configured.`);
  return value;
}

function requiredBootstrapPassword(): string {
  const value = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!value) throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be explicitly configured.");
  const validationError = strongPasswordValidationError(value);
  if (validationError || /(?:password|change|rotate|skyshield)/i.test(value)) {
    throw new Error(validationError || "BOOTSTRAP_ADMIN_PASSWORD must not be a placeholder.");
  }
  return value;
}

function requiredBoolean(name: string): boolean {
  const value = requiredValue(name).toLowerCase();
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be exactly true or false.`);
  }
  return value === "true";
}

function normalizedEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("BOOTSTRAP_ADMIN_EMAIL must be a valid email address.");
  }
  return email;
}

function normalizedSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("BOOTSTRAP_ORGANIZATION_SLUG must be a lowercase URL-safe slug.");
  }
  return slug;
}

async function main() {
  const email = normalizedEmail(requiredValue("BOOTSTRAP_ADMIN_EMAIL"));
  const name = requiredValue("BOOTSTRAP_ADMIN_NAME");
  const password = requiredBootstrapPassword();
  const organizationName = requiredValue("BOOTSTRAP_ORGANIZATION_NAME");
  const organizationSlug = normalizedSlug(
    requiredValue("BOOTSTRAP_ORGANIZATION_SLUG")
  );
  const canManageCanonicalScsems = requiredBoolean(
    "BOOTSTRAP_CAN_MANAGE_CANONICAL_SCSEMS"
  );
  const passwordHash = await hash(password, 12);

  const created = await prisma.$transaction(async (tx) => {
    const [userCount, existingOrganization] = await Promise.all([
      tx.user.count(),
      tx.organization.findUnique({ where: { slug: organizationSlug } }),
    ]);
    if (userCount !== 0 || existingOrganization) {
      throw new Error(
        "Bootstrap is one-shot and requires an empty user database and a new organization slug. Use the authenticated invitation workflow for all later users."
      );
    }

    const organization = await tx.organization.create({
      data: {
        name: organizationName,
        slug: organizationSlug,
        canManageCanonicalScsems,
      },
    });
    const user = await tx.user.create({
      data: {
        email,
        name,
        passwordHash,
        role: "ADMIN",
        organizationId: organization.id,
      },
    });
    await tx.auditLog.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        action: "BOOTSTRAP_ADMIN_CREATE",
        resourceType: "user",
        resourceId: user.id,
        metadata: {
          email,
          role: "ADMIN",
          canManageCanonicalScsems,
          oneShot: true,
        },
      },
    });
    return { organization, user };
  }, { isolationLevel: "Serializable" });

  console.log(
    `Created one bootstrap administrator ${created.user.email} for ${created.organization.name}. MFA enrollment is required at first sign-in.`
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await prisma.$disconnect();
    process.exit(1);
  });
