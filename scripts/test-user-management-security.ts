import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { strongPasswordValidationError } from "../src/lib/password-policy";
import {
  generateInvitationToken,
  invitationTokenDigest,
  isMfaProofCurrent,
  normalizeAccountEmail,
  normalizeDisplayName,
  normalizeInvitationToken,
  parseUserManagementRole,
} from "../src/lib/user-management-security";

assert.equal(normalizeAccountEmail("  Steward@Agency.GOV "), "steward@agency.gov");
assert.equal(normalizeAccountEmail("not-an-email"), null);
assert.equal(normalizeAccountEmail("a@b"), null);
assert.equal(normalizeDisplayName("  Alex   Steward  "), "Alex Steward");
assert.equal(normalizeDisplayName("\u0000Alex"), null);
assert.equal(parseUserManagementRole("ADMIN"), "ADMIN");
assert.equal(parseUserManagementRole("SUPER_ADMIN"), null);

assert.match(strongPasswordValidationError("TooShort1!") || "", /16/);
assert.match(
  strongPasswordValidationError("alllowercasepassword1!") || "",
  /uppercase/i
);
assert.match(
  strongPasswordValidationError("NoNumberInThisPassword!") || "",
  /number/i
);
assert.match(
  strongPasswordValidationError("NoSymbolInThisPassword1") || "",
  /symbol/i
);
assert.match(
  strongPasswordValidationError(`Valid1!${"é".repeat(40)}`) || "",
  /72 UTF-8 bytes/i
);
assert.equal(strongPasswordValidationError("A-strong-registration9"), null);

const firstToken = generateInvitationToken();
const secondToken = generateInvitationToken();
assert.notEqual(firstToken.rawToken, secondToken.rawToken);
assert.notEqual(firstToken.rawToken, firstToken.tokenDigest);
assert.match(firstToken.tokenDigest, /^[0-9a-f]{64}$/);
assert.equal(firstToken.tokenDigest, invitationTokenDigest(firstToken.rawToken));
assert.equal(normalizeInvitationToken(firstToken.rawToken), firstToken.rawToken);
assert.equal(normalizeInvitationToken("short-token"), null);

const enrollment = new Date("2026-07-22T10:00:00.000Z");
assert.equal(isMfaProofCurrent("2026-07-22T10:00:00.000Z", enrollment), true);
assert.equal(isMfaProofCurrent("2026-07-22T10:00:01.000Z", enrollment), true);
assert.equal(isMfaProofCurrent("2026-07-22T09:59:59.999Z", enrollment), false);
assert.equal(isMfaProofCurrent("not-a-date", enrollment), false);
assert.equal(isMfaProofCurrent("2026-07-22T10:00:01.000Z", null), false);

const root = process.cwd();
const adminAuthSource = fs.readFileSync(
  path.join(root, "src/lib/current-admin-auth.ts"),
  "utf8"
);
const currentUserAuthSource = fs.readFileSync(
  path.join(root, "src/lib/current-user-auth.ts"),
  "utf8"
);
assert.match(adminAuthSource, /requireCurrentUser\(\{ requireMfa: true \}\)/);
assert.match(adminAuthSource, /user\.role !== "ADMIN"/);
assert.match(currentUserAuthSource, /db\.user\.findUnique/);
assert.match(currentUserAuthSource, /!user\?\.active/);
assert.match(currentUserAuthSource, /user\.credentialVersion !== issuedCredentialVersion/);
assert.match(currentUserAuthSource, /isMfaProofCurrent\(session\.user\.mfaVerifiedAt/);

const usersRouteSource = fs.readFileSync(
  path.join(root, "src/app/api/users/route.ts"),
  "utf8"
);
assert.ok(
  !usersRouteSource.includes('body.action === "register"'),
  "Invitation redemption must not share the authenticated admin endpoint"
);
assert.ok(
  (usersRouteSource.match(/requireCurrentAdmin\(\)/g) || []).length >= 2,
  "Both GET and POST user-management handlers must use current DB admin authorization"
);
assert.match(usersRouteSource, /organizationId: admin\.organizationId/);
assert.match(usersRouteSource, /token: tokenDigest/);
assert.match(usersRouteSource, /token: rawToken/);
assert.match(usersRouteSource, /tx\.auditLog\.create/);
assert.match(usersRouteSource, /body\.action === "create_password_reset"/);
assert.ok(!usersRouteSource.includes("temporaryPassword"));

const userManagementSource = fs.readFileSync(
  path.join(root, "src/components/user-management.tsx"),
  "utf8"
);
assert.ok(!userManagementSource.includes("Invitation sent successfully"));
assert.ok(!userManagementSource.includes("Send Invitation"));
assert.match(userManagementSource, /\/register#token=/);
assert.match(userManagementSource, /navigator\.clipboard\.writeText\(inviteUrl\)/);
assert.match(userManagementSource, /displayed only once/i);
assert.match(userManagementSource, /It was not emailed/i);

const registerRouteSource = fs.readFileSync(
  path.join(root, "src/app/api/register/route.ts"),
  "utf8"
);
assert.match(registerRouteSource, /invitationTokenDigest\(rawToken\)/);
assert.match(registerRouteSource, /normalizeAccountEmail\(invitation\.email\) !== email/);
assert.match(registerRouteSource, /tx\.invitation\.updateMany/);
assert.match(registerRouteSource, /used: false/);
assert.match(registerRouteSource, /claimed\.count !== 1/);
assert.match(registerRouteSource, /tx\.auditLog\.create/);

const registrationFormSource = fs.readFileSync(
  path.join(root, "src/components/registration-form.tsx"),
  "utf8"
);
assert.match(registrationFormSource, /window\.location\.hash/);
assert.match(registrationFormSource, /window\.history\.replaceState/);
assert.match(registrationFormSource, /password !== passwordConfirmation/);
assert.match(registrationFormSource, /fetch\("\/api\/register"/);
assert.match(registrationFormSource, /credentials: "omit"/);
assert.match(registrationFormSource, /cache: "no-store"/);
assert.match(registrationFormSource, /router\.replace\("\/login"\)/);
assert.ok(!registrationFormSource.includes("console."));

const registrationPageSource = fs.readFileSync(
  path.join(root, "src/app/register/page.tsx"),
  "utf8"
);
assert.match(registrationPageSource, /index: false/);
assert.match(registrationPageSource, /referrer: "no-referrer"/);

console.log("User-management security regression tests passed.");
