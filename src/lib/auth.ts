import NextAuth, { CredentialsSignin, type NextAuthConfig } from "next-auth";
import type { DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { verifyMfaForUser } from "@/lib/mfa/user-mfa";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
      organizationId: string;
    } & DefaultSession["user"];
  }

  interface User {
    role?: string;
    organizationId?: string;
  }
}

class MfaRequiredError extends CredentialsSignin {
  code = "mfa_required";
}

class MfaInvalidError extends CredentialsSignin {
  code = "mfa_invalid";
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
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = credentials.email as string;
        const password = credentials.password as string;
        const mfaCode =
          typeof credentials.mfaCode === "string" ? credentials.mfaCode : "";

        const user = await db.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            name: true,
            passwordHash: true,
            role: true,
            organizationId: true,
            active: true,
            mfaEnabled: true,
            mfaSecretEncrypted: true,
          },
        });

        if (!user || !user.active) {
          return null;
        }

        const passwordValid = await bcrypt.compare(password, user.passwordHash);

        if (!passwordValid) {
          return null;
        }

        let mfaMethod: string | null = null;
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
            await logAudit({
              organizationId: user.organizationId,
              userId: user.id,
              action: "MFA_FAILURE",
              resourceType: "session",
              metadata: { reason: "invalid_code" },
              ipAddress: request.headers.get("x-forwarded-for") || undefined,
              userAgent: request.headers.get("user-agent") || undefined,
            });
            throw new MfaInvalidError();
          }

          mfaMethod = mfaResult.method ?? "unknown";
        }

        const now = new Date();
        await db.user.update({
          where: { id: user.id },
          data: {
            lastLogin: now,
            ...(user.mfaEnabled ? { mfaLastUsedAt: now } : {}),
          },
        });

        await logAudit({
          organizationId: user.organizationId,
          userId: user.id,
          action: "LOGIN",
          resourceType: "session",
          metadata: {
            mfa: user.mfaEnabled ? mfaMethod : "not_enabled",
          },
          ipAddress: request.headers.get("x-forwarded-for") || undefined,
          userAgent: request.headers.get("user-agent") || undefined,
        });

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          organizationId: user.organizationId,
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
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.userId as string;
        session.user.role = token.role as string;
        session.user.organizationId = token.organizationId as string;
      }
      return session;
    },
  },
};

export const { auth, signIn, signOut, handlers } = NextAuth(config);
