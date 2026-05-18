import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { encryptMfaSecret, decryptMfaSecret } from "@/lib/mfa/secrets";
import {
  generateRecoveryCodes,
  hashRecoveryCodes,
} from "@/lib/mfa/recovery-codes";
import { createTotpQrCodeDataUrl } from "@/lib/mfa/qr";
import {
  buildTotpUri,
  generateTotpSecret,
  verifyTotpCode,
} from "@/lib/mfa/totp";
import { verifyMfaForUser } from "@/lib/mfa/user-mfa";

const MFA_ISSUER = "IRS SkyShield";
const PENDING_SECRET_TTL_MS = 10 * 60 * 1000;

type SessionUser = {
  id: string;
  organizationId: string;
};

export async function GET() {
  const sessionUser = await requireSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  return NextResponse.json({
    enabled: user.mfaEnabled,
    enabledAt: user.mfaEnabledAt?.toISOString() ?? null,
    lastUsedAt: user.mfaLastUsedAt?.toISOString() ?? null,
    recoveryCodesRemaining,
  });
}

export async function POST(request: NextRequest) {
  const sessionUser = await requireSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

async function requireSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user) return null;

  return session.user as unknown as SessionUser;
}

async function startSetup(sessionUser: SessionUser, request: NextRequest) {
  const user = await db.user.findUnique({
    where: { id: sessionUser.id },
    select: { id: true, email: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
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

  await db.user.update({
    where: { id: user.id },
    data: {
      mfaPendingSecretEncrypted: encryptedSecret,
      mfaPendingSecretCreatedAt: now,
    },
  });

  await writeMfaAudit({
    sessionUser,
    request,
    action: "MFA_SETUP_STARTED",
  });

  return NextResponse.json({
    secret,
    otpauthUrl,
    qrCodeDataUrl,
    expiresAt: new Date(now.getTime() + PENDING_SECRET_TTL_MS).toISOString(),
  });
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
    },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (
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
  if (!verifyTotpCode({ secret, code })) {
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

  await db.$transaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: true,
        mfaSecretEncrypted: user.mfaPendingSecretEncrypted,
        mfaPendingSecretEncrypted: null,
        mfaPendingSecretCreatedAt: null,
        mfaEnabledAt: now,
        mfaLastUsedAt: now,
      },
    });
    await tx.mfaRecoveryCode.createMany({
      data: recoveryCodeHashes.map((codeHash) => ({
        userId: user.id,
        codeHash,
      })),
    });
  });

  await writeMfaAudit({
    sessionUser,
    request,
    action: "MFA_ENABLED",
  });

  return NextResponse.json({ success: true, recoveryCodes });
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

  await db.$transaction([
    db.mfaRecoveryCode.deleteMany({ where: { userId: user.id } }),
    db.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: false,
        mfaSecretEncrypted: null,
        mfaPendingSecretEncrypted: null,
        mfaPendingSecretCreatedAt: null,
        mfaEnabledAt: null,
        mfaLastUsedAt: null,
      },
    }),
  ]);

  await writeMfaAudit({
    sessionUser,
    request,
    action: "MFA_DISABLED",
    metadata: { method: result.method },
  });

  return NextResponse.json({ success: true });
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

  await db.$transaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.mfaRecoveryCode.createMany({
      data: recoveryCodeHashes.map((codeHash) => ({
        userId: user.id,
        codeHash,
      })),
    });
  });

  await writeMfaAudit({
    sessionUser,
    request,
    action: "MFA_RECOVERY_REGENERATED",
    metadata: { method: result.method },
  });

  return NextResponse.json({ success: true, recoveryCodes });
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
