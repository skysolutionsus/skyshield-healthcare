import { NextRequest, NextResponse } from "next/server";
import { hash } from "bcryptjs";
import { auditRequestContext } from "@/lib/audit";
import { db } from "@/lib/db";
import { clearedLoginThrottleState } from "@/lib/login-throttle";
import { strongPasswordValidationError } from "@/lib/password-policy";
import {
  normalizePasswordResetToken,
  passwordResetTokenDigest,
} from "@/lib/password-reset-security";
import { normalizeAccountEmail } from "@/lib/user-management-security";

class InvalidResetLinkError extends Error {}

const INVALID_LINK_MESSAGE = "Reset link is invalid or expired.";

function invalidLinkResponse() {
  return NextResponse.json(
    { error: INVALID_LINK_MESSAGE },
    { status: 400, headers: { "Cache-Control": "private, no-store" } }
  );
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalidLinkResponse();
  }

  const email = normalizeAccountEmail(body.email);
  const rawToken = normalizePasswordResetToken(body.resetToken);
  const password = typeof body.password === "string" ? body.password : "";
  const passwordError = strongPasswordValidationError(password);
  if (passwordError) {
    return NextResponse.json(
      { error: passwordError },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  if (!email || !rawToken) return invalidLinkResponse();

  const tokenDigest = passwordResetTokenDigest(rawToken);
  const now = new Date();
  const reset = await db.passwordResetToken.findUnique({
    where: { tokenDigest },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      createdByUserId: true,
      expiresAt: true,
      usedAt: true,
      user: {
        select: {
          id: true,
          email: true,
          organizationId: true,
          active: true,
          credentialVersion: true,
        },
      },
    },
  });

  if (
    !reset ||
    reset.usedAt ||
    reset.expiresAt.getTime() <= now.getTime() ||
    !reset.user.active ||
    reset.organizationId !== reset.user.organizationId ||
    normalizeAccountEmail(reset.user.email) !== email
  ) {
    return invalidLinkResponse();
  }

  const passwordHash = await hash(password, 12);
  const nextCredentialVersion = reset.user.credentialVersion + 1;
  const requestContext = auditRequestContext(request);

  try {
    await db.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: {
          id: reset.id,
          tokenDigest,
          userId: reset.userId,
          organizationId: reset.organizationId,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw new InvalidResetLinkError();

      const updated = await tx.user.updateMany({
        where: {
          id: reset.user.id,
          organizationId: reset.organizationId,
          credentialVersion: reset.user.credentialVersion,
          active: true,
        },
        data: {
          passwordHash,
          credentialVersion: { increment: 1 },
          ...clearedLoginThrottleState,
        },
      });
      if (updated.count !== 1) throw new InvalidResetLinkError();

      await tx.passwordResetToken.updateMany({
        where: {
          userId: reset.user.id,
          organizationId: reset.organizationId,
          usedAt: null,
        },
        data: { usedAt: now },
      });
      await tx.auditLog.create({
        data: {
          organizationId: reset.organizationId,
          userId: reset.user.id,
          action: "USER_PASSWORD_RESET_COMPLETE",
          resourceType: "user",
          resourceId: reset.user.id,
          metadata: {
            resetTokenId: reset.id,
            issuedByUserId: reset.createdByUserId,
            credentialVersion: nextCredentialVersion,
          },
          ipAddress: requestContext.ipAddress ?? null,
          userAgent: requestContext.userAgent ?? null,
        },
      });
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error instanceof InvalidResetLinkError) return invalidLinkResponse();
    console.error("Password reset failed:", error);
    return NextResponse.json(
      { error: "Unable to reset password" },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  return NextResponse.json(
    { success: true },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
