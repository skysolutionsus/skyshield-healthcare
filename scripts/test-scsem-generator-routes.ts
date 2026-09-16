import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vm from "node:vm";
import ts from "typescript";
import type { SCSEMUpdaterSession } from "../src/lib/scsem-updater-store";
import { buildCISBootstrapChanges } from "../src/lib/scsem-cis-bootstrap";

// Execute actual handlers with only external auth/catalog/persistence seams replaced.
// No service, vault, production database or licensed content is contacted.
function loadRoute(file: string, mocks: Record<string, unknown>) {
    const exports: Record<string, (...args: unknown[]) => Promise<Response>> = {};
    const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(compiled, { exports, require: (name: string) => {
        if (!(name in mocks)) throw new Error(`Unmocked dependency: ${name}`);
        return mocks[name];
    }, console, Request, Response, URL, Buffer, Map, Set });
    return exports;
}
async function main() {
    let created = 0;
    const user = { id: "synthetic-reviewer", organizationId: "synthetic-org" };
    const benchmark = { workbenchId: 1234, benchmarkTitle: "CIS SYNTHETIC Benchmark", benchmarkVersion: "TEST", benchmarkStatus: { status: "accepted" }, workbenchStatus: { status: "published" } };
    const route = loadRoute("src/app/api/scsem-updater/bootstrap/route.ts", {
        "next/server": { NextResponse: Response },
        "@/lib/audit": { auditRequestContext: () => ({}) },
        "@/lib/cis-api": { getCISToken: async () => "synthetic", fetchAllBenchmarks: async () => [benchmark], fetchAllBenchmarkExcelFiles: async () => [benchmark] },
        "@/lib/scsem-cis-bootstrap": { buildCISBootstrapChanges, buildCISBootstrapBlankWorkbook: async () => ({ buffer: Buffer.alloc(0), baseline: {} }) },
        "@/lib/scsem-update-engine": { downloadAndParseBenchmark: async () => ({ recommendations: Array.from({ length: 5001 }, () => ({ profile: "SYNTHETIC" })) }) },
        "@/lib/scsem-updater-store": { createSCSEMUpdaterSession: async () => { created++; throw new Error("Session creation reached"); } },
        "@/lib/scsem-steward-auth": { requireScsemSteward: async () => ({ ok: true, user }) },
        "@/lib/scsem-updater-client-session": {},
        "@/lib/scsem-benchmark-failure": { scsemBenchmarkLookupFailureDetails: () => ({ code: "FAILED", message: "Failed" }) },
    });
    const response = await route.POST(new Request("http://localhost/api/scsem-updater/bootstrap", { method: "POST", body: JSON.stringify({ workbenchId: 1234, profile: "SYNTHETIC" }) }));
    assert.equal(created, 0, "reject oversized selections BEFORE session creation");
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "CIS_BOOTSTRAP_TOO_MANY_RECOMMENDATIONS");
    console.log("PASS: actual bootstrap handler rejects 5001 before any session creation");
    let writes = 0;
    const proposal = { id: "test-change", status: "PENDING", action: "addControl", field: "newControl", testId: "SYNTHETIC", targetSheet: "General App Test Cases", proposedValue: "Synthetic only", currentValue: "", reason: "Synthetic test",
        newControl: { criticality: "Moderate", sectionTitle: "Synthetic", description: "Synthetic", testProcedures: "Synthetic audit", expectedResults: "Synthetic pass", issueCode: "SYNTHETIC", nistId: "ZZ-999999" } };
    const session = { revision: 1, workspaceMode: "cis_bootstrap", status: "analysis_incomplete", changes: [proposal], history: [] };
    const mocks: Record<string, unknown> = {
        "next/server": { NextResponse: Response },
        "@/lib/audit": { auditRequestContext: () => ({}) },
        "@/lib/scsem-updater-store": { readSCSEMUpdaterSessionForUser: () => structuredClone(session), assertSCSEMUpdaterRevision: () => {}, requireSCSEMUpdaterExpectedRevision: () => 1, isSCSEMUpdaterReviewableStatus: () => true, writeSCSEMUpdaterSession: async () => { writes++; }, scsemUpdaterRevisionETag: () => '"2"' },
        "@/lib/scsem-steward-auth": { requireScsemSteward: async () => ({ ok: true, user }) },
        "@/lib/scsem-proposal-validation": await import("../src/lib/scsem-proposal-validation"),
        "@/lib/scsem-updater-route-failure": { scsemUpdaterRouteFailureDetails: () => ({ response: {}, status: 500 }) },
        "@/lib/scsem-issue-codes": { readSCSEMIssueCodeCatalog: () => new Map(), resolveSCSEMIssueCodeSelection: () => ({ issueCode: "SYNTHETIC" }) },
        "@/lib/scsem-source-integrity": { assertSCSEMUpdaterSourceIntegrity: () => ({ absolutePath: "synthetic", sha256: "a".repeat(64) }) },
        "@/lib/scsem-change-audit": { scsemUpdaterAuditChange: (value: unknown) => value },
        "@/lib/scsem-updater-client-session": { clientSafeSCSEMUpdaterSession: (value: unknown) => value },
        "@/lib/scsem-source-precedence": { strictnessApprovalErrors: () => [] },
        "@/lib/scsem-new-control-schema": { readSCSEMNewControlTargetSchemas: () => new Map([["General App Test Cases", { findingStatement: "absent" }]]) },
    };
    mocks["@/lib/scsem-generator-evidence"] = await import("../src/lib/scsem-generator-evidence");
    const review = loadRoute("src/app/api/scsem-updater/[id]/changes/route.ts", mocks);
    const approved = await review.PATCH(new Request("http://localhost/changes", { method: "PATCH", body: JSON.stringify({ changeId: "test-change", status: "APPROVED" }) }), { params: Promise.resolve({ id: "synthetic" }) });
    assert.equal(approved.status, 400, "syntactically valid nonexistent NIST ID must block generator review");
    assert.equal(writes, 0);
    console.log("PASS: actual review rejects ungrounded mapping before persistence");
    const exportMocks = { ...mocks,
        "@/lib/scsem-updater-store": { requireSCSEMUpdaterExpectedRevision: () => 1, withLockedSCSEMUpdaterSessionForUser: async (_id: unknown, _user: unknown, _revision: unknown, run: (value: unknown) => unknown) => run({ ...session, audit: {}, changes: [{ ...proposal, status: "APPROVED" }] }), scsemUpdaterMutationErrorDetails: () => null },
        "@/lib/xlsx-parser": { parseSCSEMFile: () => ({}) },
        "@/lib/scsem-workbook-export": { updatedSCSEMFileName: () => "synthetic.xlsx", buildSCSEMUpdaterWorkbookBuffer: () => { throw new Error("Unsafe export reached"); } },
        "@/lib/scsem-export-error": { scsemExportFailureDetails: () => null },
        "@/lib/scsem-source-integrity": { assertSCSEMUpdaterSourceIntegrity: () => ({ absolutePath: "synthetic" }), SCSEMSourceIntegrityError: class extends Error {} },
        "@/lib/scsem-benchmark-failure": { boundedStoredSCSEMBenchmarkNarrative: () => ({}) },
    };
    const exporter = loadRoute("src/app/api/scsem-updater/[id]/export/route.ts", exportMocks);
    const exported = await exporter.GET(new Request("http://localhost/export?draft=1"), { params: Promise.resolve({ id: "synthetic" }) });
    assert.equal(exported.status, 400, "legacy approvals must fail closed at export with actionable evidence errors");
    assert.equal((await exported.json()).code, "INVALID_GENERATOR_EVIDENCE");
    console.log("PASS: actual export handler rechecks generator evidence, including legacy approvals");
    const { resolveGeneratorPolicyEvidence } = await import("../src/lib/scsem-generator-evidence");
    const sourceEvidence = { bootstrapDraft: true, sourceSheet: "SYNTHETIC", sourceRow: 42, sourceSha256: "a".repeat(64), sourceBenchmarkVersion: "TEST", sourceRemediation: "Enable synthetic logging." };
    Object.assign(proposal, { sourceEvidence });
    proposal.newControl.nistId = "CM-6";
    const reviewerEvidence = { expectedResultsSourceQuote: "Enable synthetic logging.", expectedResultsRationale: "Synthetic rationale only.", applicabilityRationale: "Synthetic applicability only.", policyEvidenceSha256: resolveGeneratorPolicyEvidence("CM-6").sha256 };
    let saved: SCSEMUpdaterSession | undefined;
    (mocks["@/lib/scsem-updater-store"] as Record<string, unknown>).writeSCSEMUpdaterSession = async (value: NonNullable<typeof saved>) => { saved = value; };
    const requestReview = (body: object) => review.PATCH(new Request("http://localhost/changes", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "synthetic" }) });
    const good = await requestReview({ changeId: "test-change", status: "APPROVED", reviewerEvidence });
    assert.equal(good.status, 200, "reviewer evidence must have a distinct, persistable generator-only path");
    assert.deepEqual(saved?.changes[0].sourceEvidence, sourceEvidence);
    assert.equal(saved?.changes[0].reviewerEvidence?.reviewedBy, user.id);
    assert.equal(saved?.status, "analysis_incomplete");
    const forged = await requestReview({ changeId: "test-change", reviewerEvidence: { ...reviewerEvidence, reviewedBy: "attacker" } });
    assert.equal(forged.status, 400, "reviewer attribution is server-owned");
    session.workspaceMode = "official_update";
    const updater = await requestReview({ changeId: "test-change", reviewerEvidence });
    assert.equal(updater.status, 400, "generator evidence contract is not accepted by updater sessions");
    const ordinary = await requestReview({ changeId: "test-change", status: "APPROVED" });
    assert.equal(ordinary.status, 200, "ordinary updater approvals are unchanged");
    console.log("PASS: reviewer evidence persists separately, server-attributed and generator-scoped; updater behavior unchanged");
    const evidencePath = "src/app/api/scsem-updater/[id]/generator-evidence/route.ts";
    assert.ok(fs.existsSync(evidencePath), "generator reviewers need a scoped endpoint returning exact pinned policy excerpts");
    const endpoint = loadRoute(evidencePath, mocks);
    session.workspaceMode = "cis_bootstrap";
    const getEvidence = () => endpoint.GET(new Request("http://localhost/generator-evidence?changeId=test-change&nistId=CM-6"), { params: Promise.resolve({ id: "synthetic" }) });
    const evidenceResponse = await getEvidence();
    assert.equal(evidenceResponse.status, 200);
    const returned = await evidenceResponse.json();
    assert.equal(returned.policy.sha256, reviewerEvidence.policyEvidenceSha256);
    assert.equal(returned.policy.pub1075Excerpt, resolveGeneratorPolicyEvidence("CM-6").pub1075Excerpt);
    assert.ok(returned.policy.nistExcerpt && returned.policy.nistCitation && returned.policy.pub1075Citation);
    session.workspaceMode = "official_update";
    assert.equal((await getEvidence()).status, 409);
    console.log("PASS: scoped endpoint returns exact verified excerpts/citations and rejects updater scope");
    session.workspaceMode = "cis_bootstrap";
    let scopedReads = 0;
    const store = mocks["@/lib/scsem-updater-store"] as Record<string, unknown>;
    store.readSCSEMUpdaterSessionForUser = (id: string, actualUser: unknown) => { assert.equal(id, "synthetic"); assert.equal(actualUser, user); scopedReads++; return structuredClone(session); };
    assert.equal((await getEvidence()).status, 200);
    assert.equal(scopedReads, 1, "endpoint uses existing creator/organization-scoped reader");
    const auth = mocks["@/lib/scsem-steward-auth"] as Record<string, unknown>;
    auth.requireScsemSteward = async () => ({ ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) });
    assert.equal((await getEvidence()).status, 401);
    assert.equal(scopedReads, 1, "authorization failure must stop before session access");
    console.log("PASS: endpoint honors existing auth and creator/organization-scoped session reader");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
