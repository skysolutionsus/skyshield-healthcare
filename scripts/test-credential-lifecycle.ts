import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  clearedLoginThrottleState,
  isLoginLocked,
  LOGIN_FAILURE_THRESHOLD,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_LOCKOUT_DURATION_MS,
  nextLoginFailureState,
  type LoginThrottleState,
} from "../src/lib/login-throttle";
import {
  generatePasswordResetToken,
  normalizePasswordResetToken,
  PASSWORD_RESET_TTL_MS,
  passwordResetTokenDigest,
} from "../src/lib/password-reset-security";
import {
  isFreshTotpCounter,
  recoveryCodeConsumptionSucceeded,
} from "../src/lib/mfa/evidence";
import { matchTotpCounter } from "../src/lib/mfa/totp";
import {
  canAccessPath,
  COMPUTER_SECURITY_REVIEW_ROLE,
} from "../src/lib/roles";

const start = new Date("2026-07-22T12:00:00.000Z");
let state: LoginThrottleState = { ...clearedLoginThrottleState };
for (let attempt = 1; attempt <= LOGIN_FAILURE_THRESHOLD; attempt += 1) {
  const now = new Date(start.getTime() + attempt * 1_000);
  const next = nextLoginFailureState(state, now);
  assert.equal(next.failedLoginAttempts, attempt);
  assert.equal(next.newlyLocked, attempt === LOGIN_FAILURE_THRESHOLD);
  assert.equal(
    next.loginLockedUntil?.getTime() ?? null,
    attempt === LOGIN_FAILURE_THRESHOLD
      ? now.getTime() + LOGIN_LOCKOUT_DURATION_MS
      : null
  );
  state = next;
}
assert.equal(isLoginLocked(state, new Date(start.getTime() + 10_000)), true);
assert.equal(
  isLoginLocked(state, state.loginLockedUntil as Date),
  false,
  "Lockout ends exactly at the persisted expiry"
);

const afterQuietWindow = nextLoginFailureState(
  {
    failedLoginAttempts: LOGIN_FAILURE_THRESHOLD - 1,
    lastFailedLoginAt: start,
    loginLockedUntil: null,
  },
  new Date(start.getTime() + LOGIN_FAILURE_WINDOW_MS + 1)
);
assert.equal(afterQuietWindow.failedLoginAttempts, 1);
assert.equal(afterQuietWindow.newlyLocked, false);

const afterExpiredLock = nextLoginFailureState(
  {
    failedLoginAttempts: LOGIN_FAILURE_THRESHOLD,
    lastFailedLoginAt: start,
    loginLockedUntil: new Date(start.getTime() + LOGIN_LOCKOUT_DURATION_MS),
  },
  new Date(start.getTime() + LOGIN_LOCKOUT_DURATION_MS)
);
assert.equal(afterExpiredLock.failedLoginAttempts, 1);
assert.equal(afterExpiredLock.loginLockedUntil, null);
assert.deepEqual(clearedLoginThrottleState, {
  failedLoginAttempts: 0,
  lastFailedLoginAt: null,
  loginLockedUntil: null,
});

assert.equal(PASSWORD_RESET_TTL_MS, 30 * 60 * 1_000);
const firstReset = generatePasswordResetToken();
const secondReset = generatePasswordResetToken();
assert.notEqual(firstReset.rawToken, secondReset.rawToken);
assert.notEqual(firstReset.rawToken, firstReset.tokenDigest);
assert.match(firstReset.rawToken, /^[A-Za-z0-9_-]{40,128}$/);
assert.match(firstReset.tokenDigest, /^[0-9a-f]{64}$/);
assert.equal(
  firstReset.tokenDigest,
  passwordResetTokenDigest(firstReset.rawToken)
);
assert.equal(normalizePasswordResetToken(firstReset.rawToken), firstReset.rawToken);
assert.equal(normalizePasswordResetToken("short"), null);

// RFC 6238's SHA-1 secret and 59-second vector produce 94287082; SkyShield's
// six-digit profile therefore matches 287082 at moving-factor counter 1.
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const matchedCounter = matchTotpCounter({
  secret: rfcSecret,
  code: "287082",
  now: 59_000,
  window: 0,
});
assert.equal(matchedCounter, 1);
assert.equal(isFreshTotpCounter(null, matchedCounter as number), true);
assert.equal(isFreshTotpCounter(1, matchedCounter as number), false);
assert.equal(isFreshTotpCounter(1, 2), true);
assert.equal(isFreshTotpCounter(2, 1), false);
assert.equal(isFreshTotpCounter(null, Number.NaN), false);

const competingRecoveryUpdates = [1, 0].map(
  recoveryCodeConsumptionSucceeded
);
assert.deepEqual(competingRecoveryUpdates, [true, false]);
assert.equal(competingRecoveryUpdates.filter(Boolean).length, 1);

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

const schema = read("prisma/schema.prisma");
for (const required of [
  "credentialVersion",
  "failedLoginAttempts",
  "lastFailedLoginAt",
  "loginLockedUntil",
  "mfaLastUsedTotpCounter",
  "model PasswordResetToken",
  "tokenDigest",
  "expiresAt",
  "usedAt",
  "createdByUserId",
]) {
  assert.ok(schema.includes(required), `Credential schema is missing ${required}`);
}
const migration = read(
  "prisma/migrations/20260722080000_add_credential_lifecycle/migration.sql"
);
assert.match(migration, /ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 0/);
assert.match(migration, /CREATE TABLE "PasswordResetToken"/);
assert.match(migration, /ADD COLUMN "mfaLastUsedTotpCounter" INTEGER/);
assert.match(migration, /CREATE UNIQUE INDEX "PasswordResetToken_tokenDigest_key"/);
assert.match(migration, /ON DELETE CASCADE/);

const authSource = read("src/lib/auth.ts");
assert.match(authSource, /DUMMY_PASSWORD_HASH/);
assert.match(authSource, /mode: "insensitive"/);
assert.match(authSource, /SELECT[\s\S]*FROM "User"[\s\S]*FOR UPDATE/);
assert.match(authSource, /nextLoginFailureState\(current, now\)/);
assert.match(authSource, /action: "LOGIN_FAILURE"/);
assert.match(authSource, /action: "LOGIN"/);
assert.match(authSource, /\.\.\.clearedLoginThrottleState/);
assert.match(authSource, /currentUser\?\.credentialVersion === issuedCredentialVersion/);
assert.match(authSource, /token\.sessionInvalid = true/);
assert.match(authSource, /isFreshTotpCounter/);
assert.match(authSource, /recoveryCodeConsumptionSucceeded/);
assert.ok(!authSource.includes('trigger === "update"'));

const currentUserAuth = read("src/lib/current-user-auth.ts");
assert.match(currentUserAuth, /session\?\.user\?\.sessionInvalid/);
assert.match(currentUserAuth, /user\.credentialVersion !== issuedCredentialVersion/);
assert.match(currentUserAuth, /isMfaProofCurrent/);

const stewardAuth = read("src/lib/scsem-steward-auth.ts");
assert.match(stewardAuth, /user\.credentialVersion !== issuedCredentialVersion/);

const proxy = read("src/proxy.ts");
assert.match(proxy, /pathname === "\/api\/reset-password"/);
assert.match(proxy, /pathname === "\/reset-password"/);
assert.match(proxy, /authUser\?\.sessionInvalid/);
assert.ok(
  proxy.indexOf("authUser?.sessionInvalid") < proxy.indexOf("!mfaEnabled || !mfaVerifiedAt"),
  "Invalid sessions must be rejected before MFA setup exceptions"
);

for (const role of ["VIEWER", COMPUTER_SECURITY_REVIEW_ROLE]) {
  assert.equal(
    canAccessPath(role, "/api/account/password"),
    true,
    `${role} must be able to change its own password`
  );
  assert.equal(canAccessPath(role, "/api/account"), false);
  assert.equal(canAccessPath(role, "/api/account/password/admin"), false);
  assert.equal(canAccessPath(role, "/api/users"), false);
}

const accountPasswordRoute = read("src/app/api/account/password/route.ts");
assert.match(accountPasswordRoute, /requireCurrentUser\(\{ requireMfa: true \}\)/);
assert.match(accountPasswordRoute, /compare\(currentPassword, credential\.passwordHash\)/);
assert.match(accountPasswordRoute, /strongPasswordValidationError\(newPassword\)/);
assert.match(accountPasswordRoute, /credentialVersion: \{ increment: 1 \}/);
assert.match(accountPasswordRoute, /tx\.passwordResetToken\.updateMany/);
assert.match(accountPasswordRoute, /action: "USER_PASSWORD_CHANGE"/);
assert.match(accountPasswordRoute, /signOutRequired: true/);

const usersRoute = read("src/app/api/users/route.ts");
assert.match(usersRoute, /body\.action === "create_password_reset"/);
assert.match(usersRoute, /generatePasswordResetToken\(\)/);
assert.match(usersRoute, /tokenDigest,/);
assert.match(usersRoute, /tx\.passwordResetToken\.updateMany/);
assert.match(usersRoute, /createdByUserId: admin\.id/);
assert.match(usersRoute, /organizationId: admin\.organizationId/);
assert.match(usersRoute, /action: "USER_PASSWORD_RESET_LINK_CREATE"/);
assert.ok(!usersRoute.includes("temporaryPassword"));
assert.match(usersRoute, /body\.action === "reset_mfa"[\s\S]*credentialVersion: \{ increment: 1 \}/);

const resetRoute = read("src/app/api/reset-password/route.ts");
assert.match(resetRoute, /passwordResetTokenDigest\(rawToken\)/);
assert.match(resetRoute, /normalizeAccountEmail\(reset\.user\.email\) !== email/);
assert.match(resetRoute, /reset\.expiresAt\.getTime\(\) <= now\.getTime\(\)/);
assert.match(resetRoute, /tx\.passwordResetToken\.updateMany/);
assert.match(resetRoute, /usedAt: null/);
assert.match(resetRoute, /expiresAt: \{ gt: now \}/);
assert.match(resetRoute, /credentialVersion: \{ increment: 1 \}/);
assert.match(resetRoute, /\.\.\.clearedLoginThrottleState/);
assert.match(resetRoute, /action: "USER_PASSWORD_RESET_COMPLETE"/);
assert.ok(!resetRoute.includes("console.log"));

const resetForm = read("src/components/password-reset-form.tsx");
assert.match(resetForm, /window\.location\.hash/);
assert.match(resetForm, /window\.history\.replaceState/);
assert.match(resetForm, /password !== confirmation/);
assert.match(resetForm, /credentials: "omit"/);
assert.match(resetForm, /cache: "no-store"/);
assert.match(resetForm, /router\.replace\("\/login"\)/);

const passwordSettings = read("src/components/password-settings.tsx");
assert.match(passwordSettings, /fetch\("\/api\/account\/password"/);
assert.match(passwordSettings, /password !== confirmation|newPassword !== confirmation/);
assert.match(passwordSettings, /signOut\(\{ callbackUrl: "\/login" \}\)/);

const mfaRoute = read("src/app/api/mfa/route.ts");
assert.ok(
  (mfaRoute.match(/requireCurrentUser\(\)/g) || []).length >= 2,
  "Every MFA handler entry point must bind the JWT to current credential state"
);
assert.match(mfaRoute, /MFA is already enabled/);
assert.match(
  mfaRoute,
  /mfaPendingSecretEncrypted: user\.mfaPendingSecretEncrypted,[\s\S]*mfaPendingSecretCreatedAt: user\.mfaPendingSecretCreatedAt/
);
assert.match(mfaRoute, /mfaEnabled: false,[\s\S]*credentialVersion: \{ increment: 1 \}/);
assert.match(mfaRoute, /action: "MFA_ENABLED"/);
assert.match(mfaRoute, /action: "MFA_RECOVERY_REGENERATED"/);
assert.match(mfaRoute, /mfaLastUsedTotpCounter: totpCounter/);
assert.match(mfaRoute, /mfaLastUsedTotpCounter: \{ lt: result\.totpCounter \}/);
assert.match(mfaRoute, /id: result\.recoveryCodeId,[\s\S]*usedAt: null/);

const userMfa = read("src/lib/mfa/user-mfa.ts");
assert.match(userMfa, /recoveryCodeId: matchingCodeId/);
assert.ok(
  !userMfa.includes("mfaRecoveryCode.update"),
  "MFA verification must not burn a recovery code before the protected transaction"
);

const adminActions = read("src/components/admin-user-actions.tsx");
assert.match(adminActions, /\/reset-password#token=/);
assert.match(adminActions, /does not email it|was not emailed/i);
assert.match(adminActions, /I saved the link — clear it/);
assert.match(adminActions, /Clipboard access failed/);
assert.match(adminActions, /setResetLink\(""\)/);
assert.ok(!adminActions.includes("temporaryPassword"));

process.stdout.write("Credential lifecycle security regression tests passed.\n");
