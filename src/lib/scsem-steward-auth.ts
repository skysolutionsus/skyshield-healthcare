import "server-only";

import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isScsemStewardRole } from "@/lib/roles";

export interface ScsemStewardUser {
  id: string;
  email: string;
  name: string;
  role: string;
  organizationId: string;
}

type ScsemStewardGranted = {
  ok: true;
  user: ScsemStewardUser;
};

type ScsemStewardDenied = {
  ok: false;
  response: NextResponse;
};

export type ScsemStewardAccess = ScsemStewardGranted | ScsemStewardDenied;

export type ScsemSyncPrincipal = {
  organizationId: string;
  userId: string | null;
  displayName: string;
  scheduled: boolean;
};

type ScsemSyncAccess =
  | { ok: true; principal: ScsemSyncPrincipal }
  | ScsemStewardDenied;

function denied(error: string, status: 401 | 403 | 503): ScsemStewardDenied {
  return {
    ok: false,
    response: NextResponse.json({ error }, { status }),
  };
}

/**
 * Resolve SCSEM stewardship from current database state, never from JWT role
 * or organization claims alone. This makes role changes, deactivation, and
 * organization transfers effective immediately for canonical SCSEM access.
 */
export async function requireScsemSteward(): Promise<ScsemStewardAccess> {
  const session = await auth();
  const sessionUserId = session?.user?.id;

  if (!sessionUserId) {
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
      organization: {
        select: { canManageCanonicalScsems: true },
      },
    },
  });

  const issuedCredentialVersion = Number(session.user.credentialVersion);
  if (
    !user ||
    !user.active ||
    session.user.sessionInvalid ||
    !Number.isSafeInteger(issuedCredentialVersion) ||
    user.credentialVersion !== issuedCredentialVersion
  ) {
    return denied("Unauthorized", 401);
  }

  // Canonical-template mutations require both current database enrollment and
  // proof that MFA was verified for this authenticated session.
  const sessionMfaVerifiedAt = session.user.mfaVerifiedAt
    ? Date.parse(session.user.mfaVerifiedAt)
    : Number.NaN;
  const currentMfaGenerationStartedAt = user.mfaEnabledAt?.getTime() ?? Number.NaN;
  if (
    !user.mfaEnabled ||
    !Number.isFinite(sessionMfaVerifiedAt) ||
    !Number.isFinite(currentMfaGenerationStartedAt) ||
    sessionMfaVerifiedAt < currentMfaGenerationStartedAt
  ) {
    return denied("MFA enrollment and verification required", 403);
  }

  if (
    !isScsemStewardRole(user.role) ||
    !user.organization.canManageCanonicalScsems
  ) {
    return denied("Forbidden", 403);
  }

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      organizationId: user.organizationId,
    },
  };
}

function secretsMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);

  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

/**
 * Scheduled SCSEM syncs require both a configured bearer secret and an
 * explicitly configured, steward-enabled organization. Missing configuration
 * never falls back to a development credential.
 */
export async function requireScsemStewardOrCron(
  request: Request
): Promise<ScsemSyncAccess> {
  const authorization = request.headers.get("authorization");

  if (!authorization) {
    const access = await requireScsemSteward();
    if (!access.ok) return access;

    return {
      ok: true,
      principal: {
        organizationId: access.user.organizationId,
        userId: access.user.id,
        displayName: access.user.name || access.user.email,
        scheduled: false,
      },
    };
  }

  const expectedSecret = process.env.CRON_SECRET?.trim();
  if (!expectedSecret) {
    return denied("Scheduled SCSEM sync is not configured.", 503);
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || !secretsMatch(match[1], expectedSecret)) {
    return denied("Unauthorized", 401);
  }

  const organizationId = process.env.SCSEM_CRON_ORGANIZATION_ID?.trim();
  if (!organizationId) {
    return denied("Scheduled SCSEM sync organization is not configured.", 503);
  }

  const organization = await db.organization.findFirst({
    where: {
      id: organizationId,
      canManageCanonicalScsems: true,
    },
    select: { id: true, name: true },
  });

  if (!organization) {
    return denied("Scheduled SCSEM sync organization is not authorized.", 403);
  }

  return {
    ok: true,
    principal: {
      organizationId: organization.id,
      userId: null,
      displayName: `Scheduled sync (${organization.name})`,
      scheduled: true,
    },
  };
}
