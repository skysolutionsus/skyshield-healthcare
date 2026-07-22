import { NextRequest, NextResponse } from "next/server";
import { compare, hash } from "bcryptjs";
import { auditRequestContext } from "@/lib/audit";
import { requireCurrentUser } from "@/lib/current-user-auth";
import { db } from "@/lib/db";
import { clearedLoginThrottleState } from "@/lib/login-throttle";
import { strongPasswordValidationError } from "@/lib/password-policy";

class CredentialStateChangedError extends Error {}

export async function POST(request: NextRequest) {
  const access = await requireCurrentUser({ requireMfa: true });
  if (!access.ok) return access.response;
  const currentUser = access.user;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const currentPassword =
    typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const passwordError = strongPasswordValidationError(newPassword);
  if (!currentPassword || passwordError) {
    return NextResponse.json(
      { error: passwordError ?? "Current password is required." },
      { status: 400 }
    );
  }
  if (currentPassword === newPassword) {
    return NextResponse.json(
      { error: "New password must be different from the current password." },
      { status: 400 }
    );
  }

  const credential = await db.user.findFirst({
    where: {
      id: currentUser.id,
      organizationId: currentUser.organizationId,
      active: true,
      credentialVersion: currentUser.credentialVersion,
    },
    select: { passwordHash: true },
  });
  const currentPasswordValid = Boolean(
    credential && (await compare(currentPassword, credential.passwordHash))
  );
  if (!currentPasswordValid) {
    return NextResponse.json(
      { error: "Current password is incorrect." },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const passwordHash = await hash(newPassword, 12);
  const now = new Date();
  const requestContext = auditRequestContext(request);
  const nextCredentialVersion = currentUser.credentialVersion + 1;

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: {
          id: currentUser.id,
          organizationId: currentUser.organizationId,
          active: true,
          credentialVersion: currentUser.credentialVersion,
        },
        data: {
          passwordHash,
          credentialVersion: { increment: 1 },
          ...clearedLoginThrottleState,
        },
      });
      if (updated.count !== 1) throw new CredentialStateChangedError();

      await tx.passwordResetToken.updateMany({
        where: {
          userId: currentUser.id,
          organizationId: currentUser.organizationId,
          usedAt: null,
        },
        data: { usedAt: now },
      });
      await tx.auditLog.create({
        data: {
          organizationId: currentUser.organizationId,
          userId: currentUser.id,
          action: "USER_PASSWORD_CHANGE",
          resourceType: "user",
          resourceId: currentUser.id,
          metadata: { credentialVersion: nextCredentialVersion },
          ipAddress: requestContext.ipAddress ?? null,
          userAgent: requestContext.userAgent ?? null,
        },
      });
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error instanceof CredentialStateChangedError) {
      return NextResponse.json(
        { error: "Your credentials changed. Sign in and try again." },
        { status: 409, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    console.error("Password change failed:", error);
    return NextResponse.json(
      { error: "Unable to change password" },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  return NextResponse.json(
    { success: true, signOutRequired: true },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
