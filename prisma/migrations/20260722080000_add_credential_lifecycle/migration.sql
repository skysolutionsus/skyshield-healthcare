-- Invalidate JWT sessions after credential rotation and persist bounded login lockout state.
ALTER TABLE "User" ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lastFailedLoginAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "loginLockedUntil" TIMESTAMP(3);
-- The matched TOTP time-step is the replay boundary. A timestamp alone cannot
-- distinguish two uses of the same code inside one accepted clock window.
ALTER TABLE "User" ADD COLUMN "mfaLastUsedTotpCounter" INTEGER;

-- Password reset bearer secrets are stored only as SHA-256 digests. A token is
-- organization-scoped, single-use, expiring, and attributable to its issuer.
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "tokenDigest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordResetToken_tokenDigest_key"
    ON "PasswordResetToken"("tokenDigest");
CREATE INDEX "PasswordResetToken_userId_usedAt_expiresAt_idx"
    ON "PasswordResetToken"("userId", "usedAt", "expiresAt");
CREATE INDEX "PasswordResetToken_organizationId_usedAt_expiresAt_idx"
    ON "PasswordResetToken"("organizationId", "usedAt", "expiresAt");

ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
