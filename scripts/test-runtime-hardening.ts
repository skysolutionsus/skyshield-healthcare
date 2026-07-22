import * as assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildMinimalHealthResponse,
  healthReadinessStatusCode,
} from "../src/lib/health-readiness";
import { runtimeAuthSecretError } from "../src/lib/runtime-config";

const fixedNow = new Date("2026-07-22T00:00:00.000Z");
assert.deepEqual(buildMinimalHealthResponse(true, fixedNow), {
  status: "ok",
  readiness: "ready",
  timestamp: fixedNow.toISOString(),
});
assert.deepEqual(buildMinimalHealthResponse(false, fixedNow), {
  status: "degraded",
  readiness: "not_ready",
  timestamp: fixedNow.toISOString(),
});
assert.equal(healthReadinessStatusCode(true), 200);
assert.equal(healthReadinessStatusCode(false), 503);

const testEnvironment: NodeJS.ProcessEnv = { NODE_ENV: "test" };
assert.match(
  runtimeAuthSecretError(testEnvironment) || "",
  /must be explicitly configured/i
);
assert.match(
  runtimeAuthSecretError({
    ...testEnvironment,
    NEXTAUTH_SECRET: "change-me-in-production-change-me",
  }) || "",
  /placeholder|weak default/i
);
assert.match(
  runtimeAuthSecretError({ ...testEnvironment, NEXTAUTH_SECRET: "a".repeat(64) }) || "",
  /character diversity/i
);
const strongSecret = randomBytes(48).toString("base64url");
assert.equal(
  runtimeAuthSecretError({ ...testEnvironment, NEXTAUTH_SECRET: strongSecret }),
  null
);

const root = process.cwd();
const healthRoute = fs.readFileSync(path.join(root, "src/app/api/health/route.ts"), "utf8");
for (const forbidden of [
  "DATABASE_URL",
  "NEXTAUTH_URL",
  "BIFROST_BASE_URL",
  "BIFROST_MODEL",
  "userCount",
  "documentCount",
  "chunkCount",
]) {
  assert.ok(!healthRoute.includes(forbidden), `Public health route exposes ${forbidden}`);
}

const authSource = fs.readFileSync(path.join(root, "src/lib/auth.ts"), "utf8");
assert.ok(
  !authSource.includes("token.mfaEnabled = session.user.mfaEnabled"),
  "JWT refresh must never trust a browser-controlled MFA flag"
);
assert.match(
  authSource,
  /async jwt\(\{ token, user \}\)[\s\S]*if \(typeof token\.userId === "string"\)[\s\S]*db\.user\.findUnique/,
  "Every JWT evaluation must refresh authorization state from the database"
);
assert.ok(
  !authSource.includes('trigger === "update"'),
  "Database authorization refresh must not be limited to browser-requested session updates"
);
assert.match(
  authSource,
  /currentUser\.mfaEnabled &&[\s\S]*sessionWasMfaVerified &&[\s\S]*sessionVerificationTime >= currentMfaGenerationStartedAt/,
  "A password-only session must never inherit another session's MFA verification"
);
assert.ok(
  !authSource.includes("mfaLastUsedAt >= authenticatedAt"),
  "A user-global MFA timestamp cannot prove verification in a specific session"
);

const mfaSettingsSource = fs.readFileSync(
  path.join(root, "src/components/mfa-settings.tsx"),
  "utf8"
);
assert.ok(
  !mfaSettingsSource.includes("useSession"),
  "MFA enrollment must not upgrade the current password-only JWT"
);
assert.match(
  mfaSettingsSource,
  /finishRecoveryCodes[\s\S]*signOut\(\{ callbackUrl: "\/login" \}\)/,
  "MFA enrollment must force a fresh sign-in after recovery codes are saved"
);

const proxySource = fs.readFileSync(path.join(root, "src/proxy.ts"), "utf8");
assert.match(
  proxySource,
  /pathname === "\/api\/register"/,
  "Invitation redemption must be reachable without an existing session"
);
assert.match(
  proxySource,
  /pathname === "\/register"/,
  "Invitation registration UI must be reachable without an existing session"
);
assert.match(
  proxySource,
  /!mfaEnabled \|\| !mfaVerifiedAt/,
  "Protected routes must require an MFA verification bound to the session"
);

const stewardAuthSource = fs.readFileSync(
  path.join(root, "src/lib/scsem-steward-auth.ts"),
  "utf8"
);
assert.match(
  stewardAuthSource,
  /mfaEnabled: true/,
  "SCSEM stewardship authorization must read current MFA state from the database"
);
assert.match(
  stewardAuthSource,
  /!user\.mfaEnabled \|\|[\s\S]*!Number\.isFinite\(sessionMfaVerifiedAt\)/,
  "SCSEM stewardship authorization must fail closed without verified MFA"
);
assert.match(
  stewardAuthSource,
  /sessionMfaVerifiedAt < currentMfaGenerationStartedAt/,
  "SCSEM stewardship must reject proof from a superseded MFA enrollment"
);

const compose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
assert.match(
  compose,
  /NEXTAUTH_SECRET=\$\{NEXTAUTH_SECRET:\?[^}]+\}/,
  "docker-compose must reject a missing NEXTAUTH_SECRET"
);
assert.match(
  compose,
  /DATABASE_URL=\$\{DATABASE_URL:\?[^}]+\}/,
  "docker-compose must reject a missing database URL"
);
assert.match(
  compose,
  /POSTGRES_PASSWORD=\$\{POSTGRES_PASSWORD:\?[^}]+\}/,
  "docker-compose must reject a missing database password"
);
for (const forbiddenBootstrapVariable of [
  "SKYSHIELD_SYNC_PRODUCTION_USERS",
  "SKYSHIELD_RUN_LEGACY_SCSEM_SEED",
  "SEED_ADMIN_PASSWORD",
  "SEED_COMPUTER_SECURITY_REVIEW_PASSWORD",
  "SEED_INVITED_USER_PASSWORD",
]) {
  assert.ok(
    !compose.includes(forbiddenBootstrapVariable),
    `Normal production startup must not accept ${forbiddenBootstrapVariable}`
  );
}
assert.ok(!compose.includes("change-me-in-production"));
assert.ok(!compose.includes("postgres:postgres"), "docker-compose contains an insecure database credential");
assert.ok(!compose.includes('"5432:5432"'), "PostgreSQL must not be exposed on every host interface");
for (const optionalRuntimeVariable of [
  "BIFROST_TITLE_MODEL",
  "BIFROST_SCSEM_MODEL",
  "CIS_LICENSE_XML_PATH",
  "CIS_LICENSE_XML_BASE64",
]) {
  assert.ok(
    compose.includes(`${optionalRuntimeVariable}=\${${optionalRuntimeVariable}:-}`),
    `docker-compose must pass through ${optionalRuntimeVariable}`
  );
}
assert.ok(!compose.includes("sk-bf-placeholder"), "docker-compose must not inject a fake API key");

const dockerIgnore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
assert.match(
  dockerIgnore,
  /^assets\/license\.xml$/m,
  "The historical CIS license path must never enter the Docker build context"
);
assert.match(
  dockerIgnore,
  /^\*\*\/\*license\*\.xml$/m,
  "Credential-bearing license XML files must never enter the Docker build context"
);
assert.match(
  dockerIgnore,
  /^assets\/Safeguards_FY26_Methodology_Plan_Final DRAFT_v1\.0\.docx$/m,
  "The unused internal methodology draft must never enter the Docker build context"
);

const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
assert.match(
  dockerfile,
  /COPY --from=builder \/app\/src\/lib\/runtime-config\.ts \.\/src\/lib\/runtime-config\.ts/,
  "Production image must include the runtime validator dependency"
);
assert.match(
  dockerfile,
  /COPY --from=builder \/app\/src\/lib\/password-policy\.ts \.\/src\/lib\/password-policy\.ts/,
  "Production image must include the one-shot bootstrap password policy"
);
const runnerStage = dockerfile.split("FROM node:20-alpine AS runner")[1] || "";
assert.ok(
  !/^ENV DATABASE_URL=/m.test(runnerStage),
  "Production image metadata must not contain a fallback database credential"
);
assert.ok(
  !runnerStage.includes("/app/assets ./assets"),
  "The production image must not include unused internal draft assets"
);
assert.ok(
  !runnerStage.includes("/app/scripts ./scripts") &&
    !runnerStage.includes("/app/src/lib/xlsx-parser.ts") &&
    !runnerStage.includes("/app/src/lib/db.ts"),
  "The production image must include only the startup/bootstrap sources it executes"
);
assert.match(
  runnerStage,
  /\/app\/scripts\/validate-runtime-config\.ts \.\/scripts\/validate-runtime-config\.ts/,
  "The production image must include its runtime validator"
);
assert.match(
  runnerStage,
  /\/app\/scripts\/bootstrap-admin\.ts \.\/scripts\/bootstrap-admin\.ts/,
  "The production image must retain the explicit one-shot bootstrap command"
);

const entrypointPath = path.join(root, "entrypoint.sh");
const entrypoint = fs.readFileSync(entrypointPath, "utf8");
assert.ok(
  entrypoint.indexOf("validate-runtime-config.ts") <
    entrypoint.indexOf("prisma migrate deploy"),
  "Runtime auth validation must run before database mutation or app startup"
);
assert.ok(
  !entrypoint.includes("sync-production-users") &&
    !entrypoint.includes("users:bootstrap-admin") &&
    !entrypoint.includes("prisma/seed.ts"),
  "Normal startup must never create users or invoke the destructive seed"
);
const shellSyntax = spawnSync("/bin/sh", ["-n", entrypointPath], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(shellSyntax.status, 0, shellSyntax.stderr || shellSyntax.stdout);

const bootstrapSource = fs.readFileSync(
  path.join(root, "scripts/bootstrap-admin.ts"),
  "utf8"
);
assert.match(
  bootstrapSource,
  /tx\.user\.count\(\)[\s\S]*userCount !== 0/,
  "Bootstrap admin creation must be one-shot and require an empty user database"
);
assert.match(
  bootstrapSource,
  /prisma\.\$transaction[\s\S]*BOOTSTRAP_ADMIN_CREATE/,
  "Bootstrap user and its audit event must commit atomically"
);
assert.match(
  bootstrapSource,
  /isolationLevel: "Serializable"/,
  "Concurrent bootstrap attempts must not both observe an empty user database"
);
assert.ok(
  !fs.existsSync(path.join(root, "scripts/sync-production-users.ts")),
  "Named production-user synchronization must be removed"
);

const legacySeedSource = fs.readFileSync(path.join(root, "prisma/seed.ts"), "utf8");
assert.match(
  legacySeedSource,
  /SEED_USER_PASSWORDS_JSON/,
  "Disposable seed must require per-identity passwords"
);
assert.match(
  legacySeedSource,
  /new Set\(passwords\.values\(\)\)\.size !== SEED_IDENTITIES\.length/,
  "Disposable seed must reject shared passwords"
);

const validatorPath = path.join(root, "scripts/validate-runtime-config.ts");
const validatorArgs = ["--import", "tsx", validatorPath];
const cleanEnvironment: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      key !== "AUTH_SECRET" && key !== "NEXTAUTH_SECRET"
    )
  ),
  NODE_ENV: "test",
};
const rejected = spawnSync(process.execPath, validatorArgs, {
  cwd: root,
  env: cleanEnvironment,
  encoding: "utf8",
});
assert.notEqual(rejected.status, 0, "Runtime validator accepted a missing auth secret");

const accepted = spawnSync(process.execPath, validatorArgs, {
  cwd: root,
  env: { ...cleanEnvironment, NEXTAUTH_SECRET: strongSecret },
  encoding: "utf8",
});
assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
assert.ok(!`${accepted.stdout}${accepted.stderr}`.includes(strongSecret));

process.stdout.write("Runtime health and authentication hardening tests passed.\n");
