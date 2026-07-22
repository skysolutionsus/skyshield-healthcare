import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auditRequestContext } from "@/lib/audit";
import { requireCurrentAdmin } from "@/lib/current-admin-auth";
import {
  generatePasswordResetToken,
  PASSWORD_RESET_TTL_MS,
} from "@/lib/password-reset-security";
import {
  generateInvitationToken,
  normalizeAccountEmail,
  parseUserManagementRole,
} from "@/lib/user-management-security";

export async function POST(request: NextRequest) {
  try {
    const access = await requireCurrentAdmin();
    if (!access.ok) return access.response;
    const admin = access.user;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const requestContext = auditRequestContext(request);

    if (body.action === "invite") {
      const email = normalizeAccountEmail(body.email);
      const role = parseUserManagementRole(body.role);
      if (!email || !role) {
        return NextResponse.json(
          { error: "A valid email and role are required" },
          { status: 400 }
        );
      }

      const existing = await db.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true },
      });
      if (existing) {
        return NextResponse.json(
          { error: "User with this email already exists" },
          { status: 400 }
        );
      }

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const { rawToken, tokenDigest } = generateInvitationToken();
      const invitation = await db.$transaction(async (tx) => {
        // A raw token is intentionally unrecoverable. Reissuing for the same
        // email invalidates any older active link before publishing a new one.
        const revoked = await tx.invitation.updateMany({
          where: {
            email: { equals: email, mode: "insensitive" },
            organizationId: admin.organizationId,
            used: false,
            expiresAt: { gt: new Date() },
          },
          data: { used: true },
        });
        const created = await tx.invitation.create({
          data: {
            email,
            role,
            organizationId: admin.organizationId,
            token: tokenDigest,
            expiresAt,
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: admin.organizationId,
            userId: admin.id,
            action: "USER_INVITE",
            resourceType: "invitation",
            resourceId: created.id,
            metadata: {
              email,
              role,
              expiresAt: expiresAt.toISOString(),
              supersededActiveInvitations: revoked.count,
            },
            ipAddress: requestContext.ipAddress ?? null,
            userAgent: requestContext.userAgent ?? null,
          },
        });
        return created;
      }, { isolationLevel: "Serializable" });

      return NextResponse.json(
        {
          success: true,
          token: rawToken,
          invitationId: invitation.id,
          expiresAt: expiresAt.toISOString(),
        },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }

    if (body.action === "create_password_reset") {
      const { userId } = body;
      if (!userId || typeof userId !== "string") {
        return NextResponse.json(
          { error: "userId is required" },
          { status: 400 }
        );
      }
      if (userId === admin.id) {
        return NextResponse.json(
          { error: "Use your account settings to change your own password" },
          { status: 400 }
        );
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS);
      const { rawToken, tokenDigest } = generatePasswordResetToken();
      const resetToken = await db.$transaction(async (tx) => {
        const targetUser = await tx.user.findFirst({
          where: {
            id: userId,
            organizationId: admin.organizationId,
            active: true,
          },
          select: { id: true, email: true, name: true },
        });
        if (!targetUser) return null;

        const revoked = await tx.passwordResetToken.updateMany({
          where: {
            userId: targetUser.id,
            organizationId: admin.organizationId,
            usedAt: null,
          },
          data: { usedAt: now },
        });
        const created = await tx.passwordResetToken.create({
          data: {
            userId: targetUser.id,
            organizationId: admin.organizationId,
            createdByUserId: admin.id,
            tokenDigest,
            expiresAt,
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: admin.organizationId,
            userId: admin.id,
            action: "USER_PASSWORD_RESET_LINK_CREATE",
            resourceType: "password_reset_token",
            resourceId: created.id,
            metadata: {
              targetUserId: targetUser.id,
              email: targetUser.email,
              name: targetUser.name,
              expiresAt: expiresAt.toISOString(),
              supersededResetLinks: revoked.count,
            },
            ipAddress: requestContext.ipAddress ?? null,
            userAgent: requestContext.userAgent ?? null,
          },
        });
        return created;
      }, { isolationLevel: "Serializable" });
      if (!resetToken) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }

      return NextResponse.json(
        {
          success: true,
          token: rawToken,
          resetTokenId: resetToken.id,
          expiresAt: expiresAt.toISOString(),
        },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }

    if (body.action === "reset_mfa") {
      const { userId } = body;
      if (!userId || typeof userId !== "string") {
        return NextResponse.json(
          { error: "userId is required" },
          { status: 400 }
        );
      }
      if (userId === admin.id) {
        return NextResponse.json(
          { error: "Use your MFA settings to reset your own MFA" },
          { status: 400 }
        );
      }

      const targetUser = await db.user.findFirst({
        where: {
          id: userId,
          organizationId: admin.organizationId,
        },
        select: {
          id: true,
          email: true,
          name: true,
          credentialVersion: true,
        },
      });

      if (!targetUser) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }

      await db.$transaction(async (tx) => {
        await tx.mfaRecoveryCode.deleteMany({ where: { userId: targetUser.id } });
        const updated = await tx.user.updateMany({
          where: {
            id: targetUser.id,
            organizationId: admin.organizationId,
            credentialVersion: targetUser.credentialVersion,
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
          throw new Error("TARGET_SECURITY_STATE_CHANGED");
        }
        await tx.auditLog.create({
          data: {
            organizationId: admin.organizationId,
            userId: admin.id,
            action: "USER_MFA_RESET",
            resourceType: "user",
            resourceId: targetUser.id,
            metadata: {
              email: targetUser.email,
              name: targetUser.name,
              credentialVersion: targetUser.credentialVersion + 1,
            },
            ipAddress: requestContext.ipAddress ?? null,
            userAgent: requestContext.userAgent ?? null,
          },
        });
      }, { isolationLevel: "Serializable" });

      return NextResponse.json(
        { success: true },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }

    return NextResponse.json(
      { error: "Invalid action" },
      { status: 400 }
    );
  } catch (error) {
    console.error("Users API error:", error);
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const access = await requireCurrentAdmin();
    if (!access.ok) return access.response;

    const users = await db.user.findMany({
      where: { organizationId: access.user.organizationId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        lastLogin: true,
        mfaEnabled: true,
        mfaLastUsedAt: true,
      },
      orderBy: { name: "asc" },
    });

    return NextResponse.json(
      { users },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    console.error("Users GET error:", error);
    return NextResponse.json(
      { error: "Failed to fetch users" },
      { status: 500 }
    );
  }
}
