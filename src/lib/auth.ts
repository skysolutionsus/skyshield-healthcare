import NextAuth, { CredentialsSignin, type NextAuthConfig } from "next-auth";
import type { DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import {
  verifyMfaForUser,
  type SuccessfulMfaVerification,
} from "@/lib/mfa/user-mfa";
import {
  isFreshTotpCounter,
  recoveryCodeConsumptionSucceeded,
} from "@/lib/mfa/evidence";
import {
  clearedLoginThrottleState,
  isLoginLocked,
  LOGIN_FAILURE_THRESHOLD,
  nextLoginFailureState,
} from "@/lib/login-throttle";
import { normalizeAccountEmail } from "@/lib/user-management-security";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
      organizationId: string;
      mfaEnabled: boolean;
      mfaVerifiedAt: string | null;
      credentialVersion: number;
      sessionInvalid: boolean;
    } & DefaultSession["user"];
  }

  interface User {
    role?: string;
    organizationId?: string;
    mfaEnabled?: boolean;
    mfaVerifiedAt?: string | null;
    credentialVersion?: number;
    sessionInvalid?: boolean;
  }
}

class MfaRequiredError extends CredentialsSignin {
  code = "mfa_required";
}

class MfaInvalidError extends CredentialsSignin {
  code = "mfa_invalid";
}

const DUMMY_PASSWORD_HASH =
  "$2b$12$vTsdorrUXJOufJwK6hOInegij9RQFr6MfIKitsJTOe4TUk.nJjpCe";

type LoginAuditUser = {
  id: string;
  organizationId: string;
};

type LockedUserRow = {
  active: boolean;
  credentialVersion: number;
  failedLoginAttempts: number;
  lastFailedLoginAt: Date | null;
  loginLockedUntil: Date | null;
  mfaLastUsedTotpCounter: number | null;
};

function requestAuditContext(request: Request) {
  return {
    ipAddress:
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      null,
    userAgent: request.headers.get("user-agent") || null,
  };
}

async function persistLoginFailure(
  user: LoginAuditUser,
  reason: "invalid_password" | "invalid_mfa" | "account_locked",
  request: Request,
  now: Date
): Promise<void> {
  const requestContext = requestAuditContext(request);
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedUserRow[]>`
      SELECT
        "active",
        "credentialVersion",
        "failedLoginAttempts",
        "lastFailedLoginAt",
        "loginLockedUntil",
        "mfaLastUsedTotpCounter"
      FROM "User"
      WHERE "id" = ${user.id}
      FOR UPDATE
    `;
    const current = rows[0];
    if (!current) return;

    const alreadyLocked = isLoginLocked(current, now);
    const next = alreadyLocked
      ? {
          failedLoginAttempts: current.failedLoginAttempts,
          lastFailedLoginAt: current.lastFailedLoginAt,
          loginLockedUntil: current.loginLockedUntil,
          newlyLocked: false,
        }
      : nextLoginFailureState(current, now);

    if (!alreadyLocked) {
      await tx.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: next.failedLoginAttempts,
          lastFailedLoginAt: next.lastFailedLoginAt,
          loginLockedUntil: next.loginLockedUntil,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        organizationId: user.organizationId,
        userId: user.id,
        action: "LOGIN_FAILURE",
        resourceType: "session",
        metadata: {
          reason: alreadyLocked ? "account_locked" : reason,
          failedLoginAttempts: next.failedLoginAttempts,
          lockoutThreshold: LOGIN_FAILURE_THRESHOLD,
          locked: alreadyLocked || next.newlyLocked,
          lockedUntil: next.loginLockedUntil?.toISOString() ?? null,
        },
        ipAddress: requestContext.ipAddress,
        userAgent: requestContext.userAgent,
      },
    });
  });
}

async function persistSuccessfulLogin(
  user: LoginAuditUser & {
    credentialVersion: number;
    mfaEnabled: boolean;
  },
  mfaVerification: SuccessfulMfaVerification | null,
  request: Request,
  now: Date
): Promise<"success" | "mfa_replayed" | "rejected"> {
  const requestContext = requestAuditContext(request);
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedUserRow[]>`
      SELECT
        "active",
        "credentialVersion",
        "failedLoginAttempts",
        "lastFailedLoginAt",
        "loginLockedUntil",
        "mfaLastUsedTotpCounter"
      FROM "User"
      WHERE "id" = ${user.id}
      FOR UPDATE
    `;
    const current = rows[0];
    if (
      !current?.active ||
      current.credentialVersion !== user.credentialVersion ||
      isLoginLocked(current, now)
    ) {
      if (current) {
        await tx.auditLog.create({
          data: {
            organizationId: user.organizationId,
            userId: user.id,
            action: "LOGIN_FAILURE",
            resourceType: "session",
            metadata: {
              reason: isLoginLocked(current, now)
                ? "account_locked"
                : "credential_changed_during_login",
              failedLoginAttempts: current.failedLoginAttempts,
              lockedUntil: current.loginLockedUntil?.toISOString() ?? null,
            },
            ipAddress: requestContext.ipAddress,
            userAgent: requestContext.userAgent,
          },
        });
      }
      return "rejected";
    }

    if (user.mfaEnabled && !mfaVerification) return "rejected";

    if (user.mfaEnabled && mfaVerification) {
      let evidenceReplayed = false;
      if (mfaVerification.method === "totp") {
        evidenceReplayed = !isFreshTotpCounter(
          current.mfaLastUsedTotpCounter,
          mfaVerification.totpCounter
        );
      } else {
        const consumed = await tx.mfaRecoveryCode.updateMany({
          where: {
            id: mfaVerification.recoveryCodeId,
            userId: user.id,
            usedAt: null,
          },
          data: { usedAt: now },
        });
        evidenceReplayed = !recoveryCodeConsumptionSucceeded(consumed.count);
      }

      if (evidenceReplayed) {
        const next = nextLoginFailureState(current, now);
        await tx.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: next.failedLoginAttempts,
            lastFailedLoginAt: next.lastFailedLoginAt,
            loginLockedUntil: next.loginLockedUntil,
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: user.organizationId,
            userId: user.id,
            action: "LOGIN_FAILURE",
            resourceType: "session",
            metadata: {
              reason: "mfa_replayed",
              mfa: mfaVerification.method,
              failedLoginAttempts: next.failedLoginAttempts,
              locked: next.newlyLocked,
              lockedUntil: next.loginLockedUntil?.toISOString() ?? null,
            },
            ipAddress: requestContext.ipAddress,
            userAgent: requestContext.userAgent,
          },
        });
        return "mfa_replayed";
      }
    }

    await tx.user.update({
      where: { id: user.id },
      data: {
        lastLogin: now,
        ...clearedLoginThrottleState,
        ...(user.mfaEnabled ? { mfaLastUsedAt: now } : {}),
        ...(user.mfaEnabled && mfaVerification?.method === "totp"
          ? { mfaLastUsedTotpCounter: mfaVerification.totpCounter }
          : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        organizationId: user.organizationId,
        userId: user.id,
        action: "LOGIN",
        resourceType: "session",
        metadata: {
          mfa: user.mfaEnabled
            ? mfaVerification?.method ?? "unknown"
            : "not_enabled",
          credentialVersion: user.credentialVersion,
        },
        ipAddress: requestContext.ipAddress,
        userAgent: requestContext.userAgent,
      },
    });
    return "success";
  }, { isolationLevel: "Serializable" });
}

const config: NextAuthConfig = {
  session: {
    strategy: "jwt",
    maxAge: 30 * 60,
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        mfaCode: { label: "MFA code", type: "text" },
      },
      async authorize(credentials, request) {
        if (typeof credentials?.password !== "string") {
          return null;
        }

        const email = normalizeAccountEmail(credentials.email);
        const password = credentials.password;
        const mfaCode =
          typeof credentials.mfaCode === "string" ? credentials.mfaCode : "";

        if (!email) {
          await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
          return null;
        }

        const user = await db.user.findFirst({
          where: { email: { equals: email, mode: "insensitive" } },
          select: {
            id: true,
            email: true,
            name: true,
            passwordHash: true,
            role: true,
            organizationId: true,
            active: true,
            credentialVersion: true,
            failedLoginAttempts: true,
            lastFailedLoginAt: true,
            loginLockedUntil: true,
            mfaEnabled: true,
            mfaSecretEncrypted: true,
          },
        });

        if (!user) {
          await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
          return null;
        }

        const passwordValid = await bcrypt.compare(password, user.passwordHash);

        if (!user.active) return null;

        const now = new Date();
        if (isLoginLocked(user, now)) {
          await persistLoginFailure(user, "account_locked", request, now);
          return null;
        }

        if (!passwordValid) {
          await persistLoginFailure(user, "invalid_password", request, now);
          return null;
        }

        let mfaVerification: SuccessfulMfaVerification | null = null;
        if (user.mfaEnabled) {
          if (!mfaCode.trim()) {
            throw new MfaRequiredError();
          }

          const mfaResult = await verifyMfaForUser({
            userId: user.id,
            secretEncrypted: user.mfaSecretEncrypted,
            token: mfaCode,
          });

          if (!mfaResult.ok) {
            await persistLoginFailure(user, "invalid_mfa", request, now);
            throw new MfaInvalidError();
          }

          mfaVerification = mfaResult;
        }

        const loginResult = await persistSuccessfulLogin(
          user,
          mfaVerification,
          request,
          now
        );
        if (loginResult === "mfa_replayed") throw new MfaInvalidError();
        if (loginResult !== "success") return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          organizationId: user.organizationId,
          mfaEnabled: user.mfaEnabled,
          mfaVerifiedAt: user.mfaEnabled ? now.toISOString() : null,
          credentialVersion: user.credentialVersion,
          sessionInvalid: false,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
        token.organizationId = user.organizationId;
        token.userId = user.id;
        token.mfaEnabled = Boolean(user.mfaEnabled);
        token.mfaVerifiedAt = user.mfaVerifiedAt ?? null;
        token.credentialVersion = user.credentialVersion;
        token.sessionInvalid = false;
      }

      // Refresh authorization and credential-generation state on every JWT
      // evaluation. A session update payload is browser-controlled and is never
      // trusted. Credential-version mismatch is terminal for the issued JWT.
      if (typeof token.userId === "string") {
        const currentUser = await db.user.findUnique({
          where: { id: token.userId },
          select: {
            active: true,
            role: true,
            organizationId: true,
            credentialVersion: true,
            mfaEnabled: true,
            mfaEnabledAt: true,
          },
        });

        const issuedCredentialVersion = Number(token.credentialVersion);
        const credentialVersionValid =
          Number.isSafeInteger(issuedCredentialVersion) &&
          currentUser?.credentialVersion === issuedCredentialVersion;
        if (!currentUser?.active || !credentialVersionValid) {
          token.sessionInvalid = true;
          token.mfaEnabled = false;
          token.mfaVerifiedAt = null;
          token.role = undefined;
          token.organizationId = undefined;
        } else {
          const sessionWasMfaVerified =
            typeof token.mfaVerifiedAt === "string";
          const sessionVerificationTime = sessionWasMfaVerified
            ? Date.parse(token.mfaVerifiedAt as string)
            : Number.NaN;
          const currentMfaGenerationStartedAt =
            currentUser.mfaEnabledAt?.getTime() ?? Number.NaN;
          token.role = currentUser.role;
          token.organizationId = currentUser.organizationId;
          token.sessionInvalid = false;
          token.mfaEnabled = currentUser.mfaEnabled;
          token.mfaVerifiedAt =
            currentUser.mfaEnabled &&
            sessionWasMfaVerified &&
            Number.isFinite(currentMfaGenerationStartedAt) &&
            sessionVerificationTime >= currentMfaGenerationStartedAt
              ? token.mfaVerifiedAt
              : null;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.userId as string;
        session.user.role = token.role as string;
        session.user.organizationId = token.organizationId as string;
        session.user.mfaEnabled = Boolean(token.mfaEnabled);
        session.user.mfaVerifiedAt =
          typeof token.mfaVerifiedAt === "string" ? token.mfaVerifiedAt : null;
        session.user.credentialVersion = Number(token.credentialVersion);
        session.user.sessionInvalid = Boolean(token.sessionInvalid);
      }
      return session;
    },
  },
};

export const { auth, signIn, signOut, handlers } = NextAuth(config);
