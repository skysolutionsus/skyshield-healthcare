import "server-only";

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isMfaProofCurrent } from "@/lib/user-management-security";

export type CurrentAuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  organizationId: string;
  credentialVersion: number;
  mfaEnabled: boolean;
  mfaEnabledAt: Date | null;
};

export type CurrentUserAccess =
  | { ok: true; user: CurrentAuthenticatedUser }
  | { ok: false; response: NextResponse };

function denied(
  error: string,
  status: 401 | 403
): Extract<CurrentUserAccess, { ok: false }> {
  return {
    ok: false,
    response: NextResponse.json(
      { error },
      { status, headers: { "Cache-Control": "private, no-store" } }
    ),
  };
}

/**
 * Resolve the authenticated principal from current database state and bind the
 * JWT to the credential generation that issued it. Password changes, reset
 * completion, account deactivation, and other security resets therefore revoke
 * an existing session before a sensitive route can act on it.
 */
export async function requireCurrentUser(options?: {
  requireMfa?: boolean;
}): Promise<CurrentUserAccess> {
  const session = await auth();
  const sessionUserId = session?.user?.id;
  const issuedCredentialVersion = Number(session?.user?.credentialVersion);
  if (
    !sessionUserId ||
    session?.user?.sessionInvalid ||
    !Number.isSafeInteger(issuedCredentialVersion)
  ) {
    return denied("Unauthorized", 401);
  }

  const user = await db.user.findUnique({
    where: { id: sessionUserId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      organizationId: true,
      active: true,
      credentialVersion: true,
      mfaEnabled: true,
      mfaEnabledAt: true,
    },
  });

  if (
    !user?.active ||
    user.credentialVersion !== issuedCredentialVersion
  ) {
    return denied("Unauthorized", 401);
  }

  if (
    options?.requireMfa &&
    (!user.mfaEnabled ||
      !isMfaProofCurrent(session.user.mfaVerifiedAt, user.mfaEnabledAt))
  ) {
    return denied("Current MFA verification required", 403);
  }

  return { ok: true, user };
}
