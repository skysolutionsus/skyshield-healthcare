import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { v4 as uuidv4 } from "uuid";
import { hash } from "bcryptjs";
import { generateTemporaryPassword } from "@/lib/passwords";

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userInfo = session.user as unknown as {
      id: string;
      role: string;
      organizationId: string;
    };

    if (userInfo.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();

    if (body.action === "invite") {
      const { email, role } = body;

      if (!email || !role) {
        return NextResponse.json(
          { error: "Email and role are required" },
          { status: 400 }
        );
      }

      // Check if user already exists
      const existing = await db.user.findUnique({ where: { email } });
      if (existing) {
        return NextResponse.json(
          { error: "User with this email already exists" },
          { status: 400 }
        );
      }

      // Create invitation
      const token = uuidv4();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry

      await db.invitation.create({
        data: {
          email,
          role: role as "ADMIN" | "COMPUTER_SECURITY_REVIEW" | "COMPLIANCE_OFFICER" | "AUDITOR" | "VIEWER",
          organizationId: userInfo.organizationId,
          token,
          expiresAt,
        },
      });

      await logAudit({
        organizationId: userInfo.organizationId,
        userId: userInfo.id,
        action: "USER_INVITE",
        resourceType: "invitation",
        metadata: { email, role },
        ipAddress:
          request.headers.get("x-forwarded-for") || undefined,
        userAgent: request.headers.get("user-agent") || undefined,
      });

      return NextResponse.json({ success: true, token });
    }

    if (body.action === "register") {
      const { email, name, password, inviteToken } = body;

      // Validate invitation
      const invitation = await db.invitation.findUnique({
        where: { token: inviteToken },
      });

      if (
        !invitation ||
        invitation.used ||
        invitation.expiresAt < new Date()
      ) {
        return NextResponse.json(
          { error: "Invalid or expired invitation" },
          { status: 400 }
        );
      }

      const passwordHash = await hash(password, 12);

      const user = await db.user.create({
        data: {
          email,
          name,
          passwordHash,
          role: invitation.role,
          organizationId: invitation.organizationId,
        },
      });

      await db.invitation.update({
        where: { id: invitation.id },
        data: { used: true },
      });

      await logAudit({
        organizationId: invitation.organizationId,
        userId: user.id,
        action: "USER_CREATE",
        resourceType: "user",
        resourceId: user.id,
        metadata: { email, role: invitation.role },
      });

      return NextResponse.json({ success: true });
    }

    if (body.action === "reset_password") {
      const { userId } = body;
      if (!userId || typeof userId !== "string") {
        return NextResponse.json(
          { error: "userId is required" },
          { status: 400 }
        );
      }
      if (userId === userInfo.id) {
        return NextResponse.json(
          { error: "Use your account settings to change your own password" },
          { status: 400 }
        );
      }

      const targetUser = await db.user.findFirst({
        where: {
          id: userId,
          organizationId: userInfo.organizationId,
        },
        select: { id: true, email: true, name: true },
      });

      if (!targetUser) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }

      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hash(temporaryPassword, 12);

      await db.user.update({
        where: { id: targetUser.id },
        data: { passwordHash },
      });

      await logAudit({
        organizationId: userInfo.organizationId,
        userId: userInfo.id,
        action: "USER_PASSWORD_RESET",
        resourceType: "user",
        resourceId: targetUser.id,
        metadata: { email: targetUser.email, name: targetUser.name },
        ipAddress: request.headers.get("x-forwarded-for") || undefined,
        userAgent: request.headers.get("user-agent") || undefined,
      });

      return NextResponse.json({
        success: true,
        temporaryPassword,
      });
    }

    if (body.action === "reset_mfa") {
      const { userId } = body;
      if (!userId || typeof userId !== "string") {
        return NextResponse.json(
          { error: "userId is required" },
          { status: 400 }
        );
      }
      if (userId === userInfo.id) {
        return NextResponse.json(
          { error: "Use your MFA settings to reset your own MFA" },
          { status: 400 }
        );
      }

      const targetUser = await db.user.findFirst({
        where: {
          id: userId,
          organizationId: userInfo.organizationId,
        },
        select: { id: true, email: true, name: true },
      });

      if (!targetUser) {
        return NextResponse.json({ error: "User not found" }, { status: 404 });
      }

      await db.$transaction([
        db.mfaRecoveryCode.deleteMany({ where: { userId: targetUser.id } }),
        db.user.update({
          where: { id: targetUser.id },
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

      await logAudit({
        organizationId: userInfo.organizationId,
        userId: userInfo.id,
        action: "USER_MFA_RESET",
        resourceType: "user",
        resourceId: targetUser.id,
        metadata: { email: targetUser.email, name: targetUser.name },
        ipAddress: request.headers.get("x-forwarded-for") || undefined,
        userAgent: request.headers.get("user-agent") || undefined,
      });

      return NextResponse.json({ success: true });
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
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userInfo = session.user as unknown as {
      organizationId: string;
    };

    const users = await db.user.findMany({
      where: { organizationId: userInfo.organizationId },
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

    return NextResponse.json({ users });
  } catch (error) {
    console.error("Users GET error:", error);
    return NextResponse.json(
      { error: "Failed to fetch users" },
      { status: 500 }
    );
  }
}
