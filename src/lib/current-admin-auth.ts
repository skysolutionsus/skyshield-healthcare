import "server-only";

import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/lib/current-user-auth";

export type CurrentAdminUser = {
  id: string;
  email: string;
  name: string;
  organizationId: string;
};

export type CurrentAdminAccess =
  | { ok: true; user: CurrentAdminUser }
  | { ok: false; response: NextResponse };

function denied(
  error: string,
  status: 401 | 403
): Extract<CurrentAdminAccess, { ok: false }> {
  return {
    ok: false,
    response: NextResponse.json({ error }, { status }),
  };
}

/**
 * Resolve administrative authority from current database state. JWT role and
 * organization claims are deliberately not used for authorization or scoping.
 */
export async function requireCurrentAdmin(): Promise<CurrentAdminAccess> {
  const access = await requireCurrentUser({ requireMfa: true });
  if (!access.ok) return access;
  const user = access.user;
  if (user.role !== "ADMIN") return denied("Forbidden", 403);

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      organizationId: user.organizationId,
    },
  };
}
