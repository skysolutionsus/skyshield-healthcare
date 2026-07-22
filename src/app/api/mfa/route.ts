import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import {
  requireCurrentUser,
  type CurrentAuthenticatedUser,
} from "@/lib/current-user-auth";
import { encryptMfaSecret, decryptMfaSecret } from "@/lib/mfa/secrets";
import {
  generateRecoveryCodes,
  hashRecoveryCodes,
} from "@/lib/mfa/recovery-codes";
import { createTotpQrCodeDataUrl } from "@/lib/mfa/qr";
import {
  buildTotpUri,
  generateTotpSecret,
  matchTotpCounter,
} from "@/lib/mfa/totp";
import { verifyMfaForUser } from "@/lib/mfa/user-mfa";
import { recoveryCodeConsumptionSucceeded } from "@/lib/mfa/evidence";

const MFA_ISSUER = "IRS SkyShield";
const PENDING_SECRET_TTL_MS = 10 * 60 * 1000;

type SessionUser = Pick<
  CurrentAuthenticatedUser,
  "id" | "organizationId" | "credentialVersion"
>;

export async function GET() {
  const access = await requireCurrentUser();
  if (!access.ok) return access.response;
  const sessionUser = access.user;

  const [user, recoveryCodesRemaining] = await Promise.all([
    db.user.findUnique({
      where: { id: sessionUser.id },
      select: {
        mfaEnabled: true,
        mfaEnabledAt: true,
        mfaLastUsedAt: true,
      },
    }),
    db.mfaRecoveryCode.count({
      where: { userId: sessionUser.id, usedAt: null },
    }),
  ]);

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json(
    {
      enabled: user.mfaEnabled,
      enabledAt: user.mfaEnabledAt?.toISOString() ?? null,
      lastUsedAt: user.mfaLastUsedAt?.toISOString() ?? null,
      recoveryCodesRemaining,
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

export async function POST(request: NextRequest) {
  const access = await requireCurrentUser();
  if (!access.ok) return access.response;
  const sessionUser = access.user;

  const body = await request.json().catch(() => null);
  if (!body || typeof body.action !== "string") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (body.action === "start") {
    return startSetup(sessionUser, request);
  }

  if (body.action === "verify") {
    return verifySetup(sessionUser, body.code, request);
  }

  if (body.action === "disable") {
    return disableMfa(sessionUser, body.code, request);
  }

  if (body.action === "regenerate_recovery_codes") {
    return regenerateRecoveryCodes(sessionUser, body.code, request);
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

async function startSetup(sessionUser: SessionUser, request: NextRequest) {
  const user = await db.user.findUnique({
    where: { id: sessionUser.id },
    select: {
      id: true,
      email: true,
      active: true,
      mfaEnabled: true,
      credentialVersion: true,
    },
  });
  if (
    !user?.active ||
    user.credentialVersion !== sessionUser.credentialVersion
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.mfaEnabled) {
    return NextResponse.json(
      { error: "MFA is already enabled. Verify and disable it before enrolling again." },
      { status: 409 }
    );
  }

  const secret = generateTotpSecret();
  const encryptedSecret = encryptMfaSecret(secret);
  const now = new Date();
  const otpauthUrl = buildTotpUri({
    issuer: MFA_ISSUER,
    accountName: user.email,
    secret,
  });
  const qrCodeDataUrl = await createTotpQrCodeDataUrl(otpauthUrl);

  const requestContext = mfaAuditContext(request);
  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: {
          id: user.id,
          active: true,
          credentialVersion: sessionUser.credentialVersion,
          mfaEnabled: false,
        },
        data: {
          mfaPendingSecretEncrypted: encryptedSecret,
          mfaPendingSecretCreatedAt: now,
        },
      });
      if (updated.count !== 1) throw new Error("MFA_STATE_CHANGED");
      await tx.auditLog.create({
        data: {
          organizationId: sessionUser.organizationId,
          userId: sessionUser.id,
          action: "MFA_SETUP_STARTED",
          resourceType: "mfa",
          resourceId: user.id,
          metadata: { expiresAt: new Date(now.getTime() + PENDING_SECRET_TTL_MS).toISOString() },
          ipAddress: requestContext.ipAddress,
          userAgent: requestContext.userAgent,
        },
      });
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error instanceof Error && error.message === "MFA_STATE_CHANGED") {
      return NextResponse.json(
        { error: "Your security settings changed. Sign in and try again." },
        { status: 409 }
      );
    }
    throw error;
  }

  return NextResponse.json(
    {
      secret,
      otpauthUrl,
      qrCodeDataUrl,
      expiresAt: new Date(now.getTime() + PENDING_SECRET_TTL_MS).toISOString(),
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

async function verifySetup(
  sessionUser: SessionUser,
  code: unknown,
  request: NextRequest
) {
  if (typeof code !== "string" || !code.trim()) {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }

  const user = await db.user.findUnique({
    where: { id: sessionUser.id },
    select: {
      id: true,
      mfaPendingSecretEncrypted: true,
      mfaPendingSecretCreatedAt: true,
      mfaEnabled: true,
      active: true,
      credentialVersion: true,
    },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (
    !user.active ||
    user.mfaEnabled ||
    user.credentialVersion !== sessionUser.credentialVersion ||
    !user.mfaPendingSecretEncrypted ||
    !user.mfaPendingSecretCreatedAt ||
    Date.now() - user.mfaPendingSecretCreatedAt.getTime() > PENDING_SECRET_TTL_MS
  ) {
    return NextResponse.json(
      { error: "MFA setup has expired. Start setup again." },
      { status: 400 }
    );
  }

  const secret = decryptMfaSecret(user.mfaPendingSecretEncrypted);
  const totpCounter = matchTotpCounter({ secret, code });
  if (totpCounter === null) {
    await writeMfaAudit({
      sessionUser,
      request,
      action: "MFA_SETUP_FAILED",
      metadata: { reason: "invalid_code" },
    });
    return NextResponse.json(
      { error: "Invalid verification code" },
      { status: 400 }
    );
  }

  const recoveryCodes = generateRecoveryCodes();
  const recoveryCodeHashes = await hashRecoveryCodes(recoveryCodes);
  const now = new Date();

  const requestContext = mfaAuditContext(request);
  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: {
          id: user.id,
          active: true,
          credentialVersion: sessionUser.credentialVersion,
          mfaEnabled: false,
          mfaPendingSecretEncrypted: user.mfaPendingSecretEncrypted,
          mfaPendingSecretCreatedAt: user.mfaPendingSecretCreatedAt,
        },
        data: {
          mfaEnabled: true,
          mfaSecretEncrypted: user.mfaPendingSecretEncrypted,
          mfaPendingSecretEncrypted: null,
          mfaPendingSecretCreatedAt: null,
          mfaEnabledAt: now,
          mfaLastUsedAt: now,
          mfaLastUsedTotpCounter: totpCounter,
          credentialVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new Error("MFA_STATE_CHANGED");
      await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.mfaRecoveryCode.createMany({
        data: recoveryCodeHashes.map((codeHash) => ({
          userId: user.id,
          codeHash,
        })),
      });
      await tx.auditLog.create({
        data: {
          organizationId: sessionUser.organizationId,
          userId: sessionUser.id,
          action: "MFA_ENABLED",
          resourceType: "mfa",
          resourceId: user.id,
          metadata: { credentialVersion: sessionUser.credentialVersion + 1 },
          ipAddress: requestContext.ipAddress,
          userAgent: requestContext.userAgent,
        },
      });
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error instanceof Error && error.message === "MFA_STATE_CHANGED") {
      return NextResponse.json(
        { error: "MFA setup changed or was already completed. Sign in and try again." },
        { status: 409 }
      );
    }
    throw error;
  }

  return NextResponse.json(
    { success: true, recoveryCodes, signOutRequired: true },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

async function disableMfa(
  sessionUser: SessionUser,
  code: unknown,
  request: NextRequest
) {
  if (typeof code !== "string" || !code.trim()) {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }

  const user = await db.user.findUnique({
    where: { id: sessionUser.id },
    select: {
      id: true,
      mfaEnabled: true,
      mfaSecretEncrypted: true,
      credentialVersion: true,
      mfaLastUsedTotpCounter: true,
    },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (!user.mfaEnabled) {
    return NextResponse.json({ error: "MFA is not enabled" }, { status: 400 });
  }

  const result = await verifyMfaForUser({
    userId: user.id,
    secretEncrypted: user.mfaSecretEncrypted,
    token: code,
  });
  if (!result.ok) {
    await writeMfaAudit({
      sessionUser,
      request,
      action: "MFA_DISABLE_FAILED",
      metadata: { reason: "invalid_code" },
    });
    return NextResponse.json(
      { error: "Invalid verification code" },
      { status: 400 }
    );
  }

  const now = new Date();
  const requestContext = {
    ipAddress:
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      null,
    userAgent: request.headers.get("user-agent") || null,
  };
  try {
    await db.$transaction(async (tx) => {
      if (result.method === "recovery_code") {
        const consumed = await tx.mfaRecoveryCode.updateMany({
          where: {
            id: result.recoveryCodeId,
            userId: user.id,
            usedAt: null,
          },
          data: { usedAt: now },
        });
        if (!recoveryCodeConsumptionSucceeded(consumed.count)) {
          throw new Error("MFA_EVIDENCE_REPLAYED");
        }
      }
      const updated = await tx.user.updateMany({
        where: {
          id: user.id,
          credentialVersion: sessionUser.credentialVersion,
          active: true,
          mfaEnabled: true,
          ...(result.method === "totp"
            ? {
                OR: [
                  { mfaLastUsedTotpCounter: null },
                  { mfaLastUsedTotpCounter: { lt: result.totpCounter } },
                ],
              }
            : {}),
        },
        data: {
          mfaEnabled: false,
          mfaSecretEncrypted: null,
          mfaPendingSecretEncrypted: null,
          mfaPendingSecretCreatedAt: null,
          mfaEnabledAt: null,
          mfaLastUsedAt: null,
          mfaLastUsedTotpCounter: null,
          credentialVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error(
          result.method === "totp"
            ? "MFA_EVIDENCE_REPLAYED"
            : "MFA_STATE_CHANGED"
        );
      }
      await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.auditLog.create({
        data: {
          organizationId: sessionUser.organizationId,
          userId: sessionUser.id,
          action: "MFA_DISABLED",
          resourceType: "mfa",
          resourceId: user.id,
          metadata: {
            method: result.method,
            credentialVersion: sessionUser.credentialVersion + 1,
          },
          ipAddress: requestContext.ipAddress,
          userAgent: requestContext.userAgent,
          createdAt: now,
        },
      });
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "MFA_STATE_CHANGED" ||
        error.message === "MFA_EVIDENCE_REPLAYED")
    ) {
      await writeMfaAudit({
        sessionUser,
        request,
        action: "MFA_DISABLE_FAILED",
        metadata: { reason: "stale_or_replayed_verification" },
      });
      return NextResponse.json(
        { error: "Verification was already used or security settings changed." },
        { status: 409 }
      );
    }
    throw error;
  }

  return NextResponse.json(
    { success: true, signOutRequired: true },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

async function regenerateRecoveryCodes(
  sessionUser: SessionUser,
  code: unknown,
  request: NextRequest
) {
  if (typeof code !== "string" || !code.trim()) {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }

  const user = await db.user.findUnique({
    where: { id: sessionUser.id },
    select: {
      id: true,
      mfaEnabled: true,
      mfaSecretEncrypted: true,
      mfaLastUsedTotpCounter: true,
    },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (!user.mfaEnabled) {
    return NextResponse.json({ error: "MFA is not enabled" }, { status: 400 });
  }

  const result = await verifyMfaForUser({
    userId: user.id,
    secretEncrypted: user.mfaSecretEncrypted,
    token: code,
  });
  if (!result.ok) {
    await writeMfaAudit({
      sessionUser,
      request,
      action: "MFA_RECOVERY_REGENERATE_FAILED",
      metadata: { reason: "invalid_code" },
    });
    return NextResponse.json(
      { error: "Invalid verification code" },
      { status: 400 }
    );
  }

  const recoveryCodes = generateRecoveryCodes();
  const recoveryCodeHashes = await hashRecoveryCodes(recoveryCodes);
  const now = new Date();
  const requestContext = mfaAuditContext(request);

  try {
    await db.$transaction(async (tx) => {
      if (result.method === "recovery_code") {
        const consumed = await tx.mfaRecoveryCode.updateMany({
          where: {
            id: result.recoveryCodeId,
            userId: user.id,
            usedAt: null,
          },
          data: { usedAt: now },
        });
        if (!recoveryCodeConsumptionSucceeded(consumed.count)) {
          throw new Error("MFA_EVIDENCE_REPLAYED");
        }
      }
      const current = await tx.user.updateMany({
        where: {
          id: user.id,
          active: true,
          mfaEnabled: true,
          credentialVersion: sessionUser.credentialVersion,
          ...(result.method === "totp"
            ? {
                OR: [
                  { mfaLastUsedTotpCounter: null },
                  { mfaLastUsedTotpCounter: { lt: result.totpCounter } },
                ],
              }
            : {}),
        },
        data: {
          mfaLastUsedAt: now,
          ...(result.method === "totp"
            ? { mfaLastUsedTotpCounter: result.totpCounter }
            : {}),
        },
      });
      if (current.count !== 1) {
        throw new Error(
          result.method === "totp"
            ? "MFA_EVIDENCE_REPLAYED"
            : "MFA_STATE_CHANGED"
        );
      }
      await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.mfaRecoveryCode.createMany({
        data: recoveryCodeHashes.map((codeHash) => ({
          userId: user.id,
          codeHash,
        })),
      });
      await tx.auditLog.create({
        data: {
          organizationId: sessionUser.organizationId,
          userId: sessionUser.id,
          action: "MFA_RECOVERY_REGENERATED",
          resourceType: "mfa",
          resourceId: user.id,
          metadata: { method: result.method },
          ipAddress: requestContext.ipAddress,
          userAgent: requestContext.userAgent,
        },
      });
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "MFA_STATE_CHANGED" ||
        error.message === "MFA_EVIDENCE_REPLAYED")
    ) {
      await writeMfaAudit({
        sessionUser,
        request,
        action: "MFA_RECOVERY_REGENERATE_FAILED",
        metadata: { reason: "stale_or_replayed_verification" },
      });
      return NextResponse.json(
        { error: "Verification was already used or security settings changed." },
        { status: 409 }
      );
    }
    throw error;
  }

  return NextResponse.json(
    { success: true, recoveryCodes },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

function mfaAuditContext(request: NextRequest) {
  return {
    ipAddress:
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      null,
    userAgent: request.headers.get("user-agent") || null,
  };
}

async function writeMfaAudit({
  sessionUser,
  request,
  action,
  metadata,
}: {
  sessionUser: SessionUser;
  request: NextRequest;
  action: string;
  metadata?: Record<string, unknown>;
}) {
  await logAudit({
    organizationId: sessionUser.organizationId,
    userId: sessionUser.id,
    action,
    resourceType: "mfa",
    metadata,
    ipAddress: request.headers.get("x-forwarded-for") || undefined,
    userAgent: request.headers.get("user-agent") || undefined,
  });
}
