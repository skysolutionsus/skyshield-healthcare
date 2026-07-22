import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

const legacyRoute = read("src/app/api/scsems/[id]/route.ts");
assert.ok(legacyRoute.includes("requireScsemSteward()"), "Retired detail API must remain steward-gated");
assert.ok(legacyRoute.includes('code: "LEGACY_SCSEM_DETAIL_RETIRED"'), "Retired detail API needs a stable code");
assert.ok(legacyRoute.includes("status: 410"), "Retired detail API must return HTTP 410");
assert.ok(
  legacyRoute.includes('"Cache-Control": "private, no-store"'),
  "Retired detail response must never be cached"
);
for (const forbidden of [
  "@/lib/db",
  "sCSEMTemplate",
  "filePath",
  "importSCSEMTemplateWorkbook",
  "updateReviews",
  "actualResults",
  "findingStatement",
  "notesEvidence",
]) {
  assert.ok(!legacyRoute.includes(forbidden), `Retired detail API must not contain ${forbidden}`);
}

const legacyPage = read("src/app/(authenticated)/scsems/[id]/page.tsx");
assert.ok(
  legacyPage.includes('permanentRedirect("/scsems")'),
  "Legacy detail page must permanently redirect to the authoritative updater"
);
for (const forbidden of ["@/lib/db", "SCSEMDetailTabs", "sCSEMTemplate", "filePath"]) {
  assert.ok(!legacyPage.includes(forbidden), `Legacy detail page must not contain ${forbidden}`);
}

for (const removedFile of [
  "src/lib/scsem-detail-client.ts",
  "src/lib/scsem-importer.ts",
  "src/components/scsem-detail-tabs.tsx",
]) {
  assert.equal(
    fs.existsSync(path.join(ROOT, removedFile)),
    false,
    `${removedFile} must stay removed with the retired database-detail surface`
  );
}

const dashboardPage = read("src/app/(authenticated)/dashboard/page.tsx");
const dashboardApi = read("src/app/api/dashboard/route.ts");
for (const source of [dashboardPage, dashboardApi]) {
  assert.ok(source.includes("officialSCSEMManifest"), "Dashboard SCSEM facts must come from the pinned manifest");
  assert.ok(!source.includes("sCSEMUpdateReview"), "Dashboard must not treat legacy reviews as update status");
  assert.ok(!source.includes("sCSEMTemplate.count"), "Dashboard must not treat legacy DB rows as the official source count");
}

for (const staleClaim of [
  "SCSEM Health",
  "Up to Date",
  "Updates Available",
  "flagged for CIS updates",
  "SCSEM Coverage",
  "scsemOutdated",
  "scsemUpToDate",
]) {
  assert.ok(!dashboardPage.includes(staleClaim), `Dashboard must not make the stale claim: ${staleClaim}`);
}

assert.ok(dashboardPage.includes("scsemManifest.expectedWorkbookCount"));
assert.ok(dashboardPage.includes("scsemManifest.sourcePolicy"));
assert.ok(dashboardPage.includes("Candidate only — human review required"));
assert.ok(dashboardPage.includes("They are not an automated claim"));

for (const expectedApiField of [
  "workbookCount: scsemManifest.expectedWorkbookCount",
  "sourcePolicy: scsemManifest.sourcePolicy",
  "candidateOnly: true",
  "humanReviewRequired: true",
]) {
  assert.ok(dashboardApi.includes(expectedApiField), `Dashboard API is missing ${expectedApiField}`);
}
for (const retiredApiField of ["totalAssessments", "completedAssessments"]) {
  assert.ok(!dashboardApi.includes(retiredApiField), `Dashboard API must not expose ${retiredApiField}`);
}

process.stdout.write(
  "Verified legacy SCSEM detail retirement and pinned-manifest, candidate-only dashboard semantics.\n"
);
