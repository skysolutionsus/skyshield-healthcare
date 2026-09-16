import { generatorApprovalErrors, resolveGeneratorPolicyEvidence } from "../src/lib/scsem-generator-evidence";
import { addIdsToChanges } from "../src/lib/scsem-updater-store";
import * as assert from "node:assert/strict";
import { buildCISBootstrapChanges } from "../src/lib/scsem-cis-bootstrap";
import type { CISBenchmarkRecommendation } from "../src/lib/cis-benchmark-xlsx";

const recommendation: CISBenchmarkRecommendation = {
    profile: "SYNTHETIC", sourceSheet: "Synthetic source sheet", sourceRow: 42,
    section: "1", recommendation: "1.1", title: "Synthetic logging must be enabled",
    assessmentStatus: "Manual", description: "Synthetic fixture, not licensed benchmark content.",
    rationale: null, impact: null, remediation: "Enable synthetic logging.",
    audit: "Verify synthetic logging is enabled.", additionalInfo: null, cisControls: null,
    references: null, defaultValue: "Disabled",
};
const input = { recommendations: [recommendation], workbenchId: 1234,
    benchmarkTitle: "SYNTHETIC TEST ONLY", benchmarkVersion: "TEST-1", profile: "SYNTHETIC" };
for (const defaultValue of ["Disabled", "Not configured", null]) {
    const change = buildCISBootstrapChanges({ ...input, recommendations: [{ ...recommendation, defaultValue }] })[0];
    assert.equal(change.newControl.expectedResults, null, "never promote a default or audit instruction to a secure pass criterion");
    assert.equal(change.newControl.criticality, null, "generator must not auto-select a risk mapping");
}
console.log("PASS: unchecked defaults and audit text never become expected results");
assert.throws(() => buildCISBootstrapChanges({ ...input, recommendations: Array.from({ length: 5001 }, () => recommendation) }), /5000/, "oversized selections must fail, never slice");
assert.equal(buildCISBootstrapChanges({ ...input, recommendations: Array.from({ length: 5000 }, () => recommendation) }).length, 5000);
console.log("PASS: 5000 represented; 5001 rejected without silent omissions");
const provenance = buildCISBootstrapChanges({ ...input, sourceSha256: "a".repeat(64) })[0].sourceEvidence;
assert.equal(provenance.sourceSheet, recommendation.sourceSheet, "source sheet is not the destination");
assert.equal(provenance.sourceRow, 42);
assert.equal(provenance.sourceSha256, "a".repeat(64));
assert.equal(provenance.sourceBenchmarkVersion, "TEST-1");
assert.equal(provenance.sourceAudit, recommendation.audit);
assert.equal(provenance.sourceRemediation, recommendation.remediation);
assert.equal(provenance.sourceTitle, recommendation.title);
assert.equal(provenance.sourceDescription, recommendation.description);
assert.equal(provenance.cisProfile, "SYNTHETIC");
assert.equal(provenance.cisRecommendation, "1.1");
console.log("PASS: immutable source coordinates, artifact, version and recommendation text preserved separately from destination");
const candidate = addIdsToChanges(buildCISBootstrapChanges({ ...input, sourceSha256: "a".repeat(64) }))[0];
candidate.newControl = { ...candidate.newControl, nistId: "CM-6", expectedResults: "Synthetic logging is enabled." };
assert.ok(generatorApprovalErrors(candidate).some((error) => error.includes("reviewerEvidence")), "an exact NIST ID alone is not reviewer evidence");
const policy = resolveGeneratorPolicyEvidence("CM-6");
candidate.reviewerEvidence = {
    expectedResultsSourceQuote: "Enable synthetic logging.",
    expectedResultsRationale: "Synthetic fixture: enabled logging is the pass criterion supported by the quoted remediation.",
    applicabilityRationale: "Synthetic fixture: this configuration setting maps to configuration management; not a real compliance claim.",
    policyEvidenceSha256: policy.sha256,
};
assert.ok(generatorApprovalErrors(candidate).some((error) => error.includes("criticality")), "generator cannot reach exporter default Moderate without a reviewer choice");
candidate.newControl.criticality = "Moderate"; // explicitly synthetic reviewer choice
assert.deepEqual(generatorApprovalErrors(candidate), []);
candidate.reviewerEvidence.expectedResultsSourceQuote = "Invented recommendation quote";
assert.ok(generatorApprovalErrors(candidate).some((error) => error.includes("quote")));
candidate.reviewerEvidence.expectedResultsSourceQuote = "Enable synthetic logging.";
candidate.reviewerEvidence.policyEvidenceSha256 = "b".repeat(64);
assert.ok(generatorApprovalErrors(candidate).some((error) => error.includes("policy")));
assert.throws(() => resolveGeneratorPolicyEvidence("ZZ-999999"), /does not exist/);
assert.throws(() => resolveGeneratorPolicyEvidence("AC-2(99)"), /does not exist/);
assert.throws(() => resolveGeneratorPolicyEvidence("AC-2(5)"), /No pinned Publication 1075/);
// Real pinned-source regression: coverage metadata lists AC-2(13), but the
// reviewer excerpt ends before CE-13. Never mint an approvable fingerprint.
for (const nistId of ["AC-2(13)", "AC-2(12)"]) {
    assert.throws(() => resolveGeneratorPolicyEvidence(nistId), /Publication 1075.*truncated.*blocked/i,
        `${nistId}: truncated policy must remain an unresolved reviewer blocker`);
    const truncatedCandidate = structuredClone(candidate);
    truncatedCandidate.newControl!.nistId = nistId;
    assert.ok(generatorApprovalErrors(truncatedCandidate).some((error) =>
        /Publication 1075.*truncated.*blocked/i.test(error)),
    `${nistId}: approval must report incomplete evidence, not merely a fingerprint mismatch`);
}
console.log("PASS: truncated AC-2 enhancement requirements block policy resolution and approval");
console.log("PASS: exact policy mapping, reviewer rationale, source quote and current evidence fingerprint required");
import { clientSafeSCSEMUpdaterSession } from "../src/lib/scsem-updater-client-session";
import type { SCSEMUpdaterSession } from "../src/lib/scsem-updater-store";
const client = clientSafeSCSEMUpdaterSession({ id: "synthetic", originalFilePath: "synthetic.xlsx", organizationId: "synthetic", createdByUserId: "synthetic", uploadedAt: "2026-01-01", revision: 1, status: "analysis_incomplete", workspaceMode: "cis_bootstrap", originalFileName: "synthetic.xlsx", inferredTechnology: "synthetic", scsem: { subject: null, version: null, effectiveDate: null, totalControls: 0, testCaseSheets: [] }, changes: [candidate], history: [], audit: { uploadedSha256: "a".repeat(64), uploadedSizeBytes: 0 } } as SCSEMUpdaterSession);
assert.deepEqual(client.changes[0].reviewerEvidence, candidate.reviewerEvidence, "reviewer decisions survive client reload");
assert.equal(client.changes[0].sourceEvidence?.sourceRow, 42);
assert.equal(client.changes[0].sourceEvidence?.sourceRemediation, recommendation.remediation);
assert.equal(client.changes[0].sourceEvidence?.sourceSha256, "a".repeat(64));
console.log("PASS: client allowlist retains generator review and immutable source quote context");
const malformed = structuredClone(candidate);
Object.assign(malformed.reviewerEvidence!, { expectedResultsSourceQuote: 42 });
assert.doesNotThrow(() => generatorApprovalErrors(malformed), "malformed legacy evidence must fail closed with errors, not throw");
assert.ok(generatorApprovalErrors(malformed).length > 0);
