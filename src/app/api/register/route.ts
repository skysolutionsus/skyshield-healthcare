import { hash } from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { auditRequestContext } from "@/lib/audit";
import { db } from "@/lib/db";
import { strongPasswordValidationError } from "@/lib/password-policy";
import {
  invitationTokenDigest,
  normalizeAccountEmail,
  normalizeDisplayName,
  normalizeInvitationToken,
} from "@/lib/user-management-security";

export const runtime = "nodejs";

class InvitationRedemptionError extends Error {
  constructor() {
    super("Invalid or expired invitation");
    this.name = "InvitationRedemptionError";
  }
}

function invalidInvitation() {
  return NextResponse.json(
    { error: "Invalid or expired invitation" },
    { status: 400, headers: { "Cache-Control": "no-store" } }
  );
}

/** Redeem a bearer invitation without requiring an existing authenticated session. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "Invalid request" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const email = normalizeAccountEmail(body.email);
    const name = normalizeDisplayName(body.name);
    const rawToken = normalizeInvitationToken(body.inviteToken);
    const passwordError = strongPasswordValidationError(body.password);
    if (!email || !name || !rawToken) return invalidInvitation();
    if (passwordError) {
      return NextResponse.json(
        { error: passwordError },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const tokenDigest = invitationTokenDigest(rawToken);
    const now = new Date();
    const invitation = await db.invitation.findUnique({
      where: { token: tokenDigest },
      select: {
        id: true,
        email: true,
        role: true,
        organizationId: true,
        used: true,
        expiresAt: true,
      },
    });

    if (
      !invitation ||
      invitation.used ||
      invitation.expiresAt <= now ||
      normalizeAccountEmail(invitation.email) !== email
    ) {
      return invalidInvitation();
    }

    const existingUser = await db.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    if (existingUser) return invalidInvitation();

    const passwordHash = await hash(body.password as string, 12);
    const requestContext = auditRequestContext(request);

    const user = await db.$transaction(async (tx) => {
      // Conditional claim closes the replay race: only one concurrent request
      // can transition this invitation from unused to used.
      const claimed = await tx.invitation.updateMany({
        where: {
          id: invitation.id,
          token: tokenDigest,
          email: invitation.email,
          used: false,
          expiresAt: { gt: now },
        },
        data: { used: true },
      });
      if (claimed.count !== 1) throw new InvitationRedemptionError();

      const duplicate = await tx.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true },
      });
      if (duplicate) throw new InvitationRedemptionError();

      const created = await tx.user.create({
        data: {
          email,
          name,
          passwordHash,
          role: invitation.role,
          organizationId: invitation.organizationId,
        },
      });

      // Keep account creation and its audit record in the same database
      // transaction so neither can survive without the other.
      await tx.auditLog.create({
        data: {
          organizationId: invitation.organizationId,
          userId: created.id,
          action: "USER_CREATE",
          resourceType: "user",
          resourceId: created.id,
          metadata: {
            email,
            role: invitation.role,
            invitationId: invitation.id,
          },
          ipAddress: requestContext.ipAddress ?? null,
          userAgent: requestContext.userAgent ?? null,
        },
      });

      return created;
    });

    return NextResponse.json(
      { success: true, userId: user.id },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof InvitationRedemptionError) return invalidInvitation();
    console.error("Invitation registration error:", error);
    return NextResponse.json(
      { error: "Failed to register account" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
