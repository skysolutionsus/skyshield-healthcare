-- Add MFA enrollment state to users.
ALTER TABLE "User" ADD COLUMN "mfaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "mfaSecretEncrypted" TEXT;
ALTER TABLE "User" ADD COLUMN "mfaPendingSecretEncrypted" TEXT;
ALTER TABLE "User" ADD COLUMN "mfaPendingSecretCreatedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "mfaEnabledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "mfaLastUsedAt" TIMESTAMP(3);

-- Recovery codes are stored as one-time bcrypt hashes.
CREATE TABLE "MfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MfaRecoveryCode_userId_idx" ON "MfaRecoveryCode"("userId");

ALTER TABLE "MfaRecoveryCode" ADD CONSTRAINT "MfaRecoveryCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
