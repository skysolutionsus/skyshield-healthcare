import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  isFreshTotpCounter,
  recoveryCodeConsumptionSucceeded,
} from "../src/lib/mfa/evidence";

const testDatabaseUrl = process.env.CREDENTIAL_TEST_DATABASE_URL?.trim();

async function run() {
  if (!testDatabaseUrl) {
    process.stdout.write(
      "MFA evidence database test skipped (CREDENTIAL_TEST_DATABASE_URL is not set).\n"
    );
    return;
  }

  const db = new PrismaClient({ datasourceUrl: testDatabaseUrl });
  const suffix = randomUUID();
  const organization = await db.organization.create({
    data: { name: `Credential Test ${suffix}`, slug: `credential-test-${suffix}` },
  });
  const user = await db.user.create({
    data: {
      email: `credential-test-${suffix}@example.invalid`,
      name: "Credential Evidence Test",
      passwordHash: "not-used-by-this-test",
      organizationId: organization.id,
      mfaEnabled: true,
      mfaLastUsedTotpCounter: null,
    },
  });
  const recovery = await db.mfaRecoveryCode.create({
    data: { userId: user.id, codeHash: "not-used-by-this-test" },
  });

  async function serialize<T>(operation: () => Promise<T>): Promise<T | false> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034"
      ) {
        return false;
      }
      throw error;
    }
  }

  try {
    const recoveryAttempts = await Promise.all(
      [0, 1].map(() =>
        serialize(() =>
          db.$transaction(async (tx) => {
            const consumed = await tx.mfaRecoveryCode.updateMany({
              where: { id: recovery.id, userId: user.id, usedAt: null },
              data: { usedAt: new Date() },
            });
            if (!recoveryCodeConsumptionSucceeded(consumed.count)) return false;
            await tx.auditLog.create({
              data: {
                organizationId: organization.id,
                userId: user.id,
                action: "TEST_RECOVERY_EVIDENCE_CONSUMED",
                resourceType: "mfa",
                resourceId: recovery.id,
              },
            });
            return true;
          }, { isolationLevel: "Serializable" })
        )
      )
    );
    assert.equal(recoveryAttempts.filter((accepted) => accepted === true).length, 1);
    assert.equal(
      await db.auditLog.count({
        where: {
          organizationId: organization.id,
          action: "TEST_RECOVERY_EVIDENCE_CONSUMED",
        },
      }),
      1
    );

    const candidateCounter = 70_000_000;
    const counterAttempts = await Promise.all(
      [0, 1].map(() =>
        serialize(() =>
          db.$transaction(async (tx) => {
            const accepted = await tx.user.updateMany({
              where: {
                id: user.id,
                OR: [
                  { mfaLastUsedTotpCounter: null },
                  { mfaLastUsedTotpCounter: { lt: candidateCounter } },
                ],
              },
              data: { mfaLastUsedTotpCounter: candidateCounter },
            });
            if (accepted.count !== 1) return false;
            await tx.auditLog.create({
              data: {
                organizationId: organization.id,
                userId: user.id,
                action: "TEST_TOTP_EVIDENCE_CONSUMED",
                resourceType: "mfa",
              },
            });
            return true;
          }, { isolationLevel: "Serializable" })
        )
      )
    );
    assert.equal(counterAttempts.filter((accepted) => accepted === true).length, 1);
    assert.equal(isFreshTotpCounter(candidateCounter, candidateCounter), false);
    assert.equal(isFreshTotpCounter(candidateCounter, candidateCounter + 1), true);

    const sameCounter = await db.user.updateMany({
      where: { id: user.id, mfaLastUsedTotpCounter: { lt: candidateCounter } },
      data: { mfaLastUsedTotpCounter: candidateCounter },
    });
    assert.equal(sameCounter.count, 0);
    const nextCounter = await db.user.updateMany({
      where: { id: user.id, mfaLastUsedTotpCounter: { lt: candidateCounter + 1 } },
      data: { mfaLastUsedTotpCounter: candidateCounter + 1 },
    });
    assert.equal(nextCounter.count, 1);
  } finally {
    await db.auditLog.deleteMany({
      where: { organizationId: organization.id },
    });
    await db.user.delete({ where: { id: user.id } });
    await db.organization.delete({ where: { id: organization.id } });
    await db.$disconnect();
  }

  process.stdout.write("MFA evidence database concurrency tests passed.\n");
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
