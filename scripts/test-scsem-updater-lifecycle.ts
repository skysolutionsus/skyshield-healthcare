import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteTextFileSync } from "../src/lib/atomic-file";
import type { AuditLogParams } from "../src/lib/audit";
import { scsemAnalysisLeaseViewState } from "../src/components/scsem-updater";
import {
    SCSEM_EXPORT_SCHEMA_UNSUPPORTED,
    scsemExportFailureDetails,
} from "../src/lib/scsem-export-error";
import {
    SCSEM_ANALYSIS_FAILURE_MESSAGE,
    isSCSEMAnalysisFailureOwnedByRevision,
    scsemAnalysisFailureDetails,
} from "../src/lib/scsem-analysis-failure";
import { SCSEMSourceIntegrityError } from "../src/lib/scsem-source-integrity";
import { scsemUpdaterRouteFailureDetails } from "../src/lib/scsem-updater-route-failure";
import { clientSafeSCSEMUpdaterSession } from "../src/lib/scsem-updater-client-session";
import {
    boundedStoredSCSEMBenchmarkAttemptReason,
    boundedStoredSCSEMBenchmarkNarrative,
    scsemBenchmarkCandidateFailureReason,
    scsemBenchmarkLookupFailureDetails,
} from "../src/lib/scsem-benchmark-failure";
import {
    SCSEM_UPDATER_LOCK_STALE_MS,
    SCSEM_ANALYSIS_LEASE_MAX_TIMEOUT_MS,
    SCSEM_ANALYSIS_LEASE_MIN_TIMEOUT_MS,
    SCSEMUpdaterConflictError,
    SCSEMUpdaterPreconditionError,
    claimSCSEMAnalysisLease,
    clearSCSEMAnalysisLease,
    createSCSEMUpdaterDurabilityTestHarness,
    isSCSEMUpdaterReviewableStatus,
    isSCSEMAnalysisLeaseOwnedBy,
    readSCSEMUpdaterSession,
    resolveUpdaterPath,
    requireSCSEMUpdaterExpectedRevision,
    resolveSCSEMAnalysisLeaseTimeoutMs,
    scsemUpdaterMutationErrorDetails,
    withLockedSCSEMUpdaterSessionForUser,
    type SCSEMUpdaterSession,
    type SCSEMUpdaterStatus,
} from "../src/lib/scsem-updater-store";

const expectedReviewability: Record<SCSEMUpdaterStatus, boolean> = {
    uploaded: false,
    analyzing: false,
    analysis_incomplete: true,
    review_ready: true,
    error: false,
};

for (const [status, reviewable] of Object.entries(expectedReviewability)) {
    assert.equal(
        isSCSEMUpdaterReviewableStatus(status as SCSEMUpdaterStatus),
        reviewable,
        `${status} reviewability must remain fail-closed`
    );
}

function testSession(id: string): SCSEMUpdaterSession {
    return {
        id,
        revision: 0,
        originalFileName: "Safeguards-SCSEM-Test.xlsx",
        originalFilePath: "/tmp/Safeguards-SCSEM-Test.xlsx",
        organizationId: "test-organization",
        createdByUserId: "test-reviewer",
        uploadedAt: "2026-07-22T00:00:00.000Z",
        inferredTechnology: "Test Technology",
        status: "uploaded",
        scsem: {
            subject: "Test Technology",
            version: "1.0",
            effectiveDate: "2026-07-22",
            totalControls: 0,
            testCaseSheets: [],
        },
        changes: [],
        history: [],
        audit: {
            uploadedSha256: "0".repeat(64),
            uploadedSizeBytes: 0,
        },
    };
}

function assertNoClientPathLeaks(value: unknown, location = "session"): void {
    if (typeof value === "string") return;
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertNoClientPathLeaks(entry, `${location}[${index}]`));
        return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
        const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
        assert.ok(
            normalized.endsWith("sourcepath") ||
            (!normalized.endsWith("filepath") &&
                !normalized.endsWith("storagepath") &&
                !normalized.endsWith("runtimepath") &&
                !normalized.endsWith("localpath") &&
                !normalized.endsWith("absolutepath")),
            `${location}.${key} must not expose an internal path key`
        );
        assertNoClientPathLeaks(entry, `${location}.${key}`);
    }
}

async function main() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skyshield-session-lifecycle-"));
    const previousRuntimeRoot = process.env.SKYSHIELD_RUNTIME_DATA_DIR;
    process.env.SKYSHIELD_RUNTIME_DATA_DIR = tempRoot;

    const auditEvents: Array<{
        kind: "intent" | "outcome";
        params: AuditLogParams;
        persistedRevision: number | null;
        persistedEntries: string[];
    }> = [];
    let failCompletionAudit = false;
    const durability = createSCSEMUpdaterDurabilityTestHarness({
        async persistIntent(params) {
            const sessionPath = path.join(
                tempRoot,
                "scsem-updater",
                String(params.resourceId),
                "session.json"
            );
            const sessionDirectory = path.dirname(sessionPath);
            auditEvents.push({
                kind: "intent",
                params,
                persistedRevision: fs.existsSync(sessionPath)
                    ? JSON.parse(fs.readFileSync(sessionPath, "utf8")).revision
                    : null,
                persistedEntries: fs.existsSync(sessionDirectory)
                    ? fs.readdirSync(sessionDirectory).sort()
                    : [],
            });
        },
        async persistOutcome(params) {
            auditEvents.push({
                kind: "outcome",
                params,
                persistedRevision: null,
                persistedEntries: [],
            });
            if (failCompletionAudit && params.metadata?.phase === "COMPLETED") {
                throw new Error("simulated completion audit outage");
            }
        },
    });
    const mutation = (label: string) => ({
        action: "SCSEM_UPDATER_EDIT" as const,
        affectedPayload: { label },
    });

    const unsafeClientSession = testSession("client-projection");
    unsafeClientSession.audit.pub1075SourcePath = "data/pub1075/p1075-full-text.md";
    unsafeClientSession.audit.nistSourcePath = "/private/runtime/nist.json";
    unsafeClientSession.audit.benchmarkLookupError =
        `EACCES while reading ${tempRoot}/cis/benchmark.xlsx`;
    unsafeClientSession.summary =
        `CIS lookup failed (${unsafeClientSession.audit.benchmarkLookupError}); review blockers.`;
    unsafeClientSession.technologyInference = {
        source: "official_manifest",
        confidence: "high",
        signals: ["Pinned manifest fixture"],
    };
    unsafeClientSession.audit.complianceCoverage = {
        requested: 1,
        pub1075: 1,
        nistFallback: 0,
        uncovered: 0,
    };
    unsafeClientSession.audit.analysisCoverage = {
        totalRows: 1,
        nistMappedRows: 1,
        reviewedRows: 0,
        unmappedRows: 0,
        totalBatches: 1,
        aiCompletedBatches: 0,
        supplementalComparisonComplete: false,
        complete: false,
        blockers: [
            `CIS Benchmark/CIS-STIG lookup unavailable: ${unsafeClientSession.audit.benchmarkLookupError}`,
        ],
    };
    unsafeClientSession.audit.supplementalComparison = {
        mode: "failed",
        complete: false,
        candidateOnly: true,
        applicabilityStatus: "review_required",
        directSourceCount: 0,
        comparedDirectSourceCount: 0,
        candidateCount: 0,
        comparedCandidateCount: 0,
        rawProposalCount: 0,
        evidenceBoundProposalCount: 0,
        reason: unsafeClientSession.audit.benchmarkLookupError,
    };
    unsafeClientSession.audit.benchmarkResolution = [{
        kind: "CIS",
        query: "Fixture benchmark",
        sheetName: "Test Cases",
        catalogCandidateCount: 1,
        attempts: [{
            workbenchId: 123,
            benchmarkTitle: "CIS fixture",
            benchmarkVersion: "1.0",
            outcome: "failed",
            reason: `EACCES while reading ${tempRoot}/cis/candidate.xlsx`,
        }],
    }];
    unsafeClientSession.changes.push({
        id: "path-text-regression",
        status: "PENDING",
        action: "updateField",
        testId: "TEST-1",
        field: "testProcedures",
        currentValue: "/etc/ssh/sshd_config is reviewed as control evidence.",
        proposedValue:
            "/etc/ssh/sshd_config and /app/skyshield/config must remain reviewer-visible.",
        reason:
            "/etc and /app/skyshield/config paths in a rationale are control text, not server locators.",
        sourceEvidence: {
            evidenceTier: "CIS Benchmark/CIS-STIG supplemental",
            futureSecret: "nested-source-evidence-secret",
        },
        newControl: {
            description: "/app/skyshield/config is legitimate proposed control text.",
            rationale: "/etc/ssh/sshd_config remains legitimate rationale text.",
        },
    });
    unsafeClientSession.audit.cis = {
        workbenchId: 123,
        benchmarkTitle: "CIS fixture",
        benchmarkVersion: "1.0",
        releaseDate: "2026-07-22",
        excelTitle: "CIS fixture",
        excelFileName: "cis-fixture.xlsx",
        filePath: "C:\\runtime\\cis-fixture.xlsx",
        sha256: "1".repeat(64),
        downloadedAt: "2026-07-22T00:00:00.000Z",
        sourceUrl: "https://workbench.cisecurity.org/fixture",
    };
    const futureSecret = "future-secret-sentinel-must-not-cross-dto";
    (unsafeClientSession as unknown as Record<string, unknown>).futureSecret = futureSecret;
    (unsafeClientSession.technologyInference as unknown as Record<string, unknown>).futureSecret =
        futureSecret;
    (unsafeClientSession.scsem as unknown as Record<string, unknown>).futureSecret = futureSecret;
    (unsafeClientSession.audit.complianceCoverage as unknown as Record<string, unknown>)
        .futureSecret = futureSecret;
    (unsafeClientSession.audit.supplementalComparison as unknown as Record<string, unknown>)
        .futureSecret = futureSecret;
    (unsafeClientSession.changes[0].newControl as unknown as Record<string, unknown>)
        .futureSecret = futureSecret;
    (unsafeClientSession.audit.cis as unknown as Record<string, unknown>).futureSecret =
        futureSecret;
    (unsafeClientSession.audit as Record<string, unknown>).futureSnapshot = {
        runtimePath: "/srv/skyshield/future-snapshot.xlsx",
        windowsPath: "C:\\runtime\\future-snapshot.xlsx",
        fileUri: "file:///srv/skyshield/future-snapshot.xlsx",
        sha256: "2".repeat(64),
    };
    const projectedClientSession = clientSafeSCSEMUpdaterSession(unsafeClientSession);
    assert.equal("originalFilePath" in projectedClientSession, false);
    assert.equal("organizationId" in projectedClientSession, false);
    assert.equal("createdByUserId" in projectedClientSession, false);
    assert.equal("analysisOperationId" in projectedClientSession, false);
    assert.equal("pub1075SourcePath" in projectedClientSession.audit, false);
    assert.equal("nistSourcePath" in projectedClientSession.audit, false);
    assert.equal(
        projectedClientSession.audit.benchmarkLookupError,
        "CIS Benchmark/CIS-STIG lookup could not be completed."
    );
    assert.equal(
        projectedClientSession.summary,
        "CIS lookup failed (CIS Benchmark/CIS-STIG lookup could not be completed.); review blockers."
    );
    assert.equal(
        projectedClientSession.audit.supplementalComparison?.reason,
        "CIS Benchmark/CIS-STIG lookup could not be completed."
    );
    assert.equal(
        projectedClientSession.audit.benchmarkResolution?.[0].attempts[0].reason,
        "Benchmark candidate resolution detail was unavailable."
    );
    assert.equal("filePath" in (projectedClientSession.audit.cis || {}), false);
    assert.equal("futureSnapshot" in projectedClientSession.audit, false);
    assert.equal(
        projectedClientSession.changes[0].proposedValue,
        "/etc/ssh/sshd_config and /app/skyshield/config must remain reviewer-visible."
    );
    assert.equal(
        projectedClientSession.changes[0].reason,
        "/etc and /app/skyshield/config paths in a rationale are control text, not server locators."
    );
    assert.equal(
        projectedClientSession.changes[0].newControl?.description,
        "/app/skyshield/config is legitimate proposed control text."
    );
    assert.deepEqual(
        Object.keys(projectedClientSession).sort(),
        [
            "analysisLeasePresent", "analysisScope", "audit", "changes", "history", "id",
            "inferredTechnology", "originalFileName", "revision", "scsem",
            "status", "summary", "technologyInference", "workspaceMode",
        ].sort()
    );
    assert.deepEqual(
        Object.keys(projectedClientSession.technologyInference || {}).sort(),
        ["confidence", "signals", "source"]
    );
    assert.deepEqual(
        Object.keys(projectedClientSession.scsem).sort(),
        ["effectiveDate", "subject", "testCaseSheets", "totalControls", "version"]
    );
    assert.deepEqual(
        Object.keys(projectedClientSession.changes[0]).sort(),
        [
            "action", "currentValue", "field", "id", "newControl", "proposedValue",
            "reason", "sourceEvidence", "status", "testId",
        ].sort()
    );
    assert.deepEqual(
        Object.keys(projectedClientSession.changes[0].newControl || {}).sort(),
        ["description", "rationale"]
    );
    assert.deepEqual(
        Object.keys(projectedClientSession.changes[0].sourceEvidence || {}).sort(),
        ["evidenceTier"]
    );
    assert.deepEqual(
        Object.keys(projectedClientSession.audit.complianceCoverage || {}).sort(),
        ["nistFallback", "pub1075", "requested", "uncovered"]
    );
    assert.deepEqual(
        Object.keys(projectedClientSession.audit.cis || {}).sort(),
        ["benchmarkTitle", "benchmarkVersion", "sha256", "workbenchId"]
    );
    assert.ok(!JSON.stringify(projectedClientSession).includes(futureSecret));
    assert.ok(!JSON.stringify(projectedClientSession).includes(tempRoot));
    assertNoClientPathLeaks(projectedClientSession);

    const boundedBenchmarkFailure = scsemBenchmarkLookupFailureDetails(
        new Error(`EACCES: permission denied, open '${tempRoot}/cis/benchmark.xlsx'`),
        "direct"
    );
    assert.deepEqual(boundedBenchmarkFailure, {
        code: "CIS_BENCHMARK_LOOKUP_UNAVAILABLE",
        message: "CIS Benchmark/CIS-STIG lookup could not be completed.",
    });
    assert.equal(
        scsemBenchmarkCandidateFailureReason(
            new Error(`EACCES: ${tempRoot}/cis/candidate.xlsx`)
        ),
        "Benchmark candidate workbook could not be downloaded or validated."
    );
    assert.ok(!JSON.stringify(boundedBenchmarkFailure).includes(tempRoot));
    assert.deepEqual(
        boundedStoredSCSEMBenchmarkNarrative({
            benchmarkLookupError: unsafeClientSession.audit.benchmarkLookupError,
            blockers: unsafeClientSession.audit.analysisCoverage.blockers,
        }),
        {
            benchmarkLookupError: "CIS Benchmark/CIS-STIG lookup could not be completed.",
            blockers: [
                "CIS Benchmark/CIS-STIG lookup unavailable: " +
                    "CIS Benchmark/CIS-STIG lookup could not be completed.",
            ],
        }
    );
    assert.equal(
        boundedStoredSCSEMBenchmarkAttemptReason(
            `EACCES while reading ${tempRoot}/cis/candidate.xlsx`
        ),
        "Benchmark candidate resolution detail was unavailable."
    );

    try {
    const stablePath = path.join(tempRoot, "atomic-write.json");
    fs.writeFileSync(stablePath, "stable-before-failure", "utf8");
    assert.throws(
        () => atomicWriteTextFileSync(stablePath, "truncated-or-partial", {
            beforeRename: () => {
                throw new Error("simulated failure before atomic rename");
            },
        }),
        /simulated failure/
    );
    assert.equal(
        fs.readFileSync(stablePath, "utf8"),
        "stable-before-failure",
        "A failed atomic write must not truncate the prior session file"
    );
    assert.deepEqual(
        fs.readdirSync(tempRoot).filter((name) => name.endsWith(".tmp")),
        [],
        "A failed atomic write must clean up its same-directory temporary file"
    );

    const uploadFixturePath = path.join(
        process.cwd(),
        "data/scsems/current/Safeguards-SCSEM-Fortigate-v10-120124.xlsx"
    );
    const uploadBuffer = fs.readFileSync(uploadFixturePath);
    const uploadAuditStart = auditEvents.length;
    const uploadedSession = await durability.createSession(
        path.basename(uploadFixturePath),
        uploadBuffer,
        { organizationId: "test-organization", userId: "test-reviewer" },
        undefined,
        {
            action: "SCSEM_UPDATER_UPLOAD",
            affectedPayload: {
                fixtureSha256: createHash("sha256").update(uploadBuffer).digest("hex"),
            },
        }
    );
    const uploadIntent = auditEvents.slice(uploadAuditStart).find((event) => event.kind === "intent");
    assert.ok(uploadIntent, "Upload creation must emit a strict intent");
    assert.deepEqual(
        uploadIntent.persistedEntries,
        ["session.json.lock"],
        "Only the coordination lock may exist when the upload intent is persisted"
    );
    assert.equal(uploadedSession.revision, 1);
    assert.equal(uploadedSession.lastOperationId, uploadIntent.params.metadata?.operationId);
    assert.ok(
        fs.existsSync(resolveUpdaterPath(uploadedSession.originalFilePath)),
        "The canonical uploaded workbook must persist after its intent"
    );
    assert.equal(
        readSCSEMUpdaterSession(uploadedSession.id).lastOperationId,
        uploadedSession.lastOperationId,
        "Upload intent linkage must persist in canonical session JSON"
    );

    const id = randomUUID();
    const created = testSession(id);
    await durability.writeSession(created, 0, mutation("create test session"));
    assert.equal(created.revision, 1, "First durable session write must establish revision 1");
    const createIntent = auditEvents.find(
        (event) => event.kind === "intent" && event.params.resourceId === id
    );
    assert.ok(createIntent, "A durable intent must be emitted before the first session write");
    const createIntentMetadata = createIntent.params.metadata;
    assert.ok(createIntentMetadata, "The durable intent must include reconciliation metadata");
    assert.equal(createIntent.persistedRevision, null, "Creation intent must precede session persistence");
    assert.equal(createIntentMetadata.phase, "INTENT");
    assert.equal(createIntentMetadata.expectedRevision, 0);
    assert.equal(createIntentMetadata.targetRevision, 1);
    assert.match(String(createIntentMetadata.operationId), /^[a-f0-9-]{36}$/i);
    assert.equal(created.lastOperationId, createIntentMetadata.operationId);
    assert.equal(created.history.at(-1)?.operationId, created.lastOperationId);
    assert.equal(created.history.at(-1)?.action, "durable_mutation");
    assert.match(
        String((createIntentMetadata.after as Record<string, unknown>).sessionJsonSha256),
        /^[a-f0-9]{64}$/
    );
    assert.match(String(createIntentMetadata.affectedPayloadSha256), /^[a-f0-9]{64}$/);
    assert.equal(
        ((createIntentMetadata.sourceHashes as Record<string, unknown>).uploaded as Record<string, unknown>).sha256,
        "0".repeat(64),
        "Intent reconciliation metadata must pin the uploaded workbook hash"
    );

    const beforeRejectedIntent = fs.readFileSync(
        path.join(tempRoot, "scsem-updater", id, "session.json"),
        "utf8"
    );
    const rejectedMutation = readSCSEMUpdaterSession(id);
    rejectedMutation.summary = "must never be persisted";
    const rejectingDurability = createSCSEMUpdaterDurabilityTestHarness({
        async persistIntent() {
            throw new Error("simulated durable audit outage");
        },
        async persistOutcome() {
            assert.fail("No outcome may be logged when the strict intent did not persist");
        },
    });
    await assert.rejects(
        () => rejectingDurability.writeSession(
            rejectedMutation,
            rejectedMutation.revision,
            mutation("audit outage")
        ),
        /simulated durable audit outage/,
        "A strict audit-intent outage must fail closed"
    );
    assert.equal(
        fs.readFileSync(path.join(tempRoot, "scsem-updater", id, "session.json"), "utf8"),
        beforeRejectedIntent,
        "No canonical session byte may change when the durable intent fails"
    );
    assert.equal(rejectedMutation.revision, 1, "A rejected intent must not advance in-memory revision state");

    assert.equal(resolveSCSEMAnalysisLeaseTimeoutMs(1), SCSEM_ANALYSIS_LEASE_MIN_TIMEOUT_MS);
    assert.equal(
        resolveSCSEMAnalysisLeaseTimeoutMs(Number.MAX_SAFE_INTEGER),
        SCSEM_ANALYSIS_LEASE_MAX_TIMEOUT_MS,
        "Configured analysis leases must remain bounded"
    );
    const leaseNowMs = Date.parse("2026-07-22T12:00:00.000Z");
    const leaseTimeoutMs = SCSEM_ANALYSIS_LEASE_MIN_TIMEOUT_MS;
    const firstAnalysisOperationId = "11111111-1111-4111-8111-111111111111";
    const secondAnalysisOperationId = "22222222-2222-4222-8222-222222222222";
    const uiLeaseSession = {
        status: "analyzing" as const,
        analysisLeasePresent: true,
        analysisStartedAt: new Date(leaseNowMs).toISOString(),
        analysisLeaseExpiresAt: new Date(leaseNowMs + leaseTimeoutMs).toISOString(),
    };
    assert.equal(
        scsemAnalysisLeaseViewState(uiLeaseSession, null).state,
        "checking",
        "The first hydrated render must fail closed without consulting the wall clock"
    );
    const freshUiLease = scsemAnalysisLeaseViewState(
        uiLeaseSession,
        leaseNowMs + Math.floor(leaseTimeoutMs / 2)
    );
    assert.equal(freshUiLease.state, "fresh");
    assert.equal(freshUiLease.retryAfterMs, Math.ceil(leaseTimeoutMs / 2));
    assert.equal(
        scsemAnalysisLeaseViewState(
            uiLeaseSession,
            leaseNowMs + leaseTimeoutMs
        ).state,
        "stale",
        "The explicit recovery action must unlock at the persisted expiry boundary"
    );
    assert.deepEqual(
        scsemAnalysisLeaseViewState(
            { status: "analyzing", analysisLeasePresent: false },
            leaseNowMs
        ),
        { state: "stale", expiresAtMs: null, retryAfterMs: 0, invalid: true },
        "Missing or invalid persisted lease metadata must expose stale recovery"
    );
    assert.equal(
        scsemAnalysisLeaseViewState({
            ...uiLeaseSession,
            analysisStartedAt: new Date(leaseNowMs + 1).toISOString(),
        }, leaseNowMs).state,
        "stale",
        "A future-dated lease start must not block explicit recovery"
    );
    const skewProtectedUiLease = scsemAnalysisLeaseViewState(
        { status: "analyzing", analysisLeasePresent: false },
        leaseNowMs,
        leaseNowMs + 30_000
    );
    assert.equal(skewProtectedUiLease.state, "fresh");
    assert.equal(skewProtectedUiLease.retryAfterMs, 30_000);
    const newLeaseSession = testSession(randomUUID());
    const startedClaim = claimSCSEMAnalysisLease(
        newLeaseSession,
        firstAnalysisOperationId,
        leaseNowMs,
        leaseTimeoutMs
    );
    assert.equal(startedClaim.outcome, "started");
    assert.equal(
        newLeaseSession.analysisLeaseExpiresAt,
        new Date(leaseNowMs + leaseTimeoutMs).toISOString(),
        "A new claim must persist its configured expiry for clients"
    );
    const corruptExpirySession = testSession(randomUUID());
    corruptExpirySession.status = "analyzing";
    corruptExpirySession.analysisOperationId = firstAnalysisOperationId;
    corruptExpirySession.analysisStartedAt = new Date(leaseNowMs).toISOString();
    corruptExpirySession.analysisLeaseExpiresAt = new Date(
        leaseNowMs + SCSEM_ANALYSIS_LEASE_MAX_TIMEOUT_MS + 1
    ).toISOString();
    assert.equal(
        claimSCSEMAnalysisLease(
            corruptExpirySession,
            secondAnalysisOperationId,
            leaseNowMs + leaseTimeoutMs,
            leaseTimeoutMs
        ).outcome,
        "reclaimed",
        "An invalid overlong persisted expiry must not create an unbounded lease"
    );
    const leaseSession = testSession(randomUUID());
    leaseSession.status = "analyzing";
    leaseSession.analysisOperationId = firstAnalysisOperationId;
    leaseSession.analysisStartedAt = new Date(leaseNowMs - leaseTimeoutMs - 1).toISOString();
    leaseSession.analysisLeaseExpiresAt = new Date(leaseNowMs - 1).toISOString();
    await durability.writeSession(leaseSession, 0, {
        action: "SCSEM_UPDATER_ANALYZE_START",
        analysisOperationId: firstAnalysisOperationId,
        affectedPayload: { analysisLease: firstAnalysisOperationId },
    });

    const staleLeaseCandidate = readSCSEMUpdaterSession(leaseSession.id);
    const staleClaim = claimSCSEMAnalysisLease(
        staleLeaseCandidate,
        secondAnalysisOperationId,
        leaseNowMs,
        leaseTimeoutMs
    );
    assert.equal(staleClaim.outcome, "reclaimed");
    if (staleClaim.outcome !== "reclaimed") assert.fail("Expected a stale lease reclaim");
    assert.equal(staleClaim.previousLease?.operationId, firstAnalysisOperationId);
    assert.equal(staleLeaseCandidate.analysisOperationId, secondAnalysisOperationId);
    assert.equal(
        staleLeaseCandidate.analysisLeaseExpiresAt,
        new Date(leaseNowMs + leaseTimeoutMs).toISOString()
    );

    await assert.rejects(
        () => rejectingDurability.writeSession(
            staleLeaseCandidate,
            staleLeaseCandidate.revision,
            {
                action: "SCSEM_UPDATER_ANALYZE_RESTART",
                analysisOperationId: secondAnalysisOperationId,
                affectedPayload: {
                    staleAbort: staleClaim.previousLease,
                    after: staleClaim.lease,
                },
            }
        ),
        /simulated durable audit outage/,
        "A stale lease restart must not persist when its strict intent fails"
    );
    assert.equal(
        readSCSEMUpdaterSession(leaseSession.id).analysisOperationId,
        firstAnalysisOperationId,
        "An audit outage must preserve the old stale lease for a later recovery attempt"
    );
    assert.equal(
        readSCSEMUpdaterSession(leaseSession.id).analysisLeaseExpiresAt,
        new Date(leaseNowMs - 1).toISOString(),
        "An audit outage must not partially persist a replacement expiry"
    );

    const retryCandidate = readSCSEMUpdaterSession(leaseSession.id);
    const retryClaim = claimSCSEMAnalysisLease(
        retryCandidate,
        secondAnalysisOperationId,
        leaseNowMs,
        leaseTimeoutMs
    );
    assert.equal(retryClaim.outcome, "reclaimed");
    const restartAuditStart = auditEvents.length;
    await durability.writeSession(retryCandidate, retryCandidate.revision, {
        action: "SCSEM_UPDATER_ANALYZE_RESTART",
        analysisOperationId: secondAnalysisOperationId,
        affectedPayload: {
            staleAbort: retryClaim.outcome === "reclaimed" ? retryClaim.previousLease : null,
            after: retryClaim.lease,
        },
    });
    const restartIntent = auditEvents.slice(restartAuditStart).find((event) => event.kind === "intent");
    assert.ok(restartIntent, "A recovered stale lease must have a durable restart intent");
    assert.equal(
        restartIntent.params.metadata?.mutationAction,
        "SCSEM_UPDATER_ANALYZE_RESTART"
    );
    assert.equal(
        restartIntent.params.metadata?.analysisOperationId,
        secondAnalysisOperationId
    );
    assert.equal(
        (((restartIntent.params.metadata?.affectedPayload as Record<string, unknown>)
            .staleAbort as Record<string, unknown>).operationId),
        firstAnalysisOperationId,
        "The restart intent must link the stale operation it aborts"
    );
    assert.equal(
        readSCSEMUpdaterSession(leaseSession.id).analysisOperationId,
        secondAnalysisOperationId,
        "The owner must be able to retry a stale reclaim after audit persistence recovers"
    );
    assert.equal(
        readSCSEMUpdaterSession(leaseSession.id).history.at(-1)?.analysisOperationId,
        secondAnalysisOperationId,
        "Durable session history must preserve the analysis-operation linkage"
    );

    const freshCandidate = readSCSEMUpdaterSession(leaseSession.id);
    const freshClaim = claimSCSEMAnalysisLease(
        freshCandidate,
        "33333333-3333-4333-8333-333333333333",
        leaseNowMs + Math.floor(leaseTimeoutMs / 2),
        leaseTimeoutMs
    );
    assert.equal(freshClaim.outcome, "already_running");
    if (freshClaim.outcome !== "already_running") assert.fail("Expected a fresh lease rejection");
    assert.equal(freshClaim.retryAfterMs, Math.ceil(leaseTimeoutMs / 2));
    assert.equal(
        freshCandidate.analysisOperationId,
        secondAnalysisOperationId,
        "A fresh concurrent attempt must not replace the active lease"
    );
    assert.throws(
        () => clearSCSEMAnalysisLease(freshCandidate, firstAnalysisOperationId),
        SCSEMUpdaterConflictError,
        "A non-owning analysis operation must not finalize or clear the lease"
    );
    assert.equal(
        freshCandidate.analysisLeaseExpiresAt,
        new Date(leaseNowMs + leaseTimeoutMs).toISOString(),
        "A wrong-operation finalization must leave the expiry intact"
    );
    assert.ok(isSCSEMAnalysisLeaseOwnedBy(freshCandidate, secondAnalysisOperationId));
    const clearedLease = clearSCSEMAnalysisLease(freshCandidate, secondAnalysisOperationId);
    assert.equal(clearedLease.operationId, secondAnalysisOperationId);
    assert.equal(freshCandidate.analysisOperationId, undefined);
    assert.equal(freshCandidate.analysisStartedAt, undefined);
    assert.equal(freshCandidate.analysisLeaseExpiresAt, undefined);

    const firstTab = readSCSEMUpdaterSession(id);
    const staleSecondTab = readSCSEMUpdaterSession(id);
    firstTab.summary = "first tab won";
    await durability.writeSession(firstTab, firstTab.revision, mutation("first tab update"));
    assert.equal(firstTab.revision, 2);

    staleSecondTab.summary = "stale tab must not overwrite";
    const intentsBeforeConflict = auditEvents.filter((event) => event.kind === "intent").length;
    await assert.rejects(
        () => durability.writeSession(staleSecondTab, staleSecondTab.revision, mutation("stale tab")),
        (error: unknown) => {
            assert.ok(error instanceof SCSEMUpdaterConflictError);
            assert.equal(error.expectedRevision, 1);
            assert.equal(error.actualRevision, 2);
            assert.equal(scsemUpdaterMutationErrorDetails(error)?.status, 409);
            return true;
        },
        "A stale multi-tab session write must fail with an HTTP-409-mappable conflict"
    );
    assert.equal(
        auditEvents.filter((event) => event.kind === "intent").length,
        intentsBeforeConflict,
        "A conflict detected before intent persistence must not create an orphan intent"
    );
    assert.equal(readSCSEMUpdaterSession(id).summary, "first tab won");

    const sessionDirectory = path.join(tempRoot, "scsem-updater", id);
    const lockPath = path.join(sessionDirectory, "session.json.lock");
    fs.writeFileSync(lockPath, "active-other-writer", { mode: 0o600 });
    const lockedSession = readSCSEMUpdaterSession(id);
    await assert.rejects(
        () => durability.writeSession(lockedSession, lockedSession.revision, mutation("locked update")),
        SCSEMUpdaterConflictError,
        "An active per-session lock must fail closed instead of racing another writer"
    );

    const staleTime = new Date(Date.now() - SCSEM_UPDATER_LOCK_STALE_MS - 60_000);
    fs.utimesSync(lockPath, staleTime, staleTime);
    lockedSession.summary = "recovered after stale lock";
    await durability.writeSession(lockedSession, lockedSession.revision, mutation("stale lock recovery"));
    assert.equal(readSCSEMUpdaterSession(id).summary, "recovered after stale lock");
    assert.ok(!fs.existsSync(lockPath), "Recovered stale session lock must be removed");

    const completionFailureSession = readSCSEMUpdaterSession(id);
    completionFailureSession.summary = "committed despite completion audit outage";
    failCompletionAudit = true;
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
        await durability.writeSession(
            completionFailureSession,
            completionFailureSession.revision,
            mutation("completion audit outage")
        );
    } finally {
        console.error = originalConsoleError;
        failCompletionAudit = false;
    }
    assert.equal(
        readSCSEMUpdaterSession(id).summary,
        "committed despite completion audit outage",
        "Completion logging is best effort only after operationId-linked state is durable"
    );

    const successfulIntentIds = auditEvents
        .filter((event) => event.kind === "intent")
        .map((event) => String(event.params.metadata?.operationId));
    assert.equal(
        new Set(successfulIntentIds).size,
        successfulIntentIds.length,
        "Every mutation intent must use a unique operationId"
    );

    const user = { id: "test-reviewer", organizationId: "test-organization" };
    const exportRevision = readSCSEMUpdaterSession(id).revision;
    const lockedRevision = await withLockedSCSEMUpdaterSessionForUser(
        id,
        user,
        exportRevision,
        async (snapshot) => {
            assert.equal(snapshot.revision, exportRevision);
            const competingMutation = readSCSEMUpdaterSession(id);
            competingMutation.summary = "must not race a locked export";
            await assert.rejects(
                () => durability.writeSession(
                    competingMutation,
                    competingMutation.revision,
                    mutation("export race")
                ),
                SCSEMUpdaterConflictError,
                "A mutation concurrent with an exact-revision export must fail closed"
            );
            await Promise.resolve();
            return snapshot.revision;
        }
    );
    assert.equal(lockedRevision, exportRevision);
    assert.ok(!fs.existsSync(lockPath), "The exact-revision export lock must be released");
    await assert.rejects(
        () => withLockedSCSEMUpdaterSessionForUser(
            id,
            user,
            exportRevision - 1,
            async () => undefined
        ),
        SCSEMUpdaterConflictError,
        "A stale export revision must fail before candidate generation"
    );

    assert.equal(
        requireSCSEMUpdaterExpectedRevision(new Request("http://localhost", {
            headers: { "If-Match": 'W/"3"' },
        })),
        3
    );
    assert.throws(
        () => requireSCSEMUpdaterExpectedRevision(new Request("http://localhost")),
        (error: unknown) => {
            assert.ok(error instanceof SCSEMUpdaterPreconditionError);
            assert.equal(scsemUpdaterMutationErrorDetails(error)?.status, 428);
            return true;
        },
        "Mutating requests without an optimistic revision must fail closed"
    );

    const internalExportFailure = new Error(
        "Cannot export approved SCSEM change hidden-id: target sheet Secret!B42 contains a formula at /private/runtime/source.xlsx"
    );
    const safeExportFailure = scsemExportFailureDetails(internalExportFailure);
    assert.deepEqual(safeExportFailure, {
        status: 422,
        code: SCSEM_EXPORT_SCHEMA_UNSUPPORTED,
        error:
            "One or more approved changes cannot be applied safely to this workbook schema. " +
            "Remove or reject the unsupported change, or prepare an approved template row/layout for it, then retry the candidate export.",
    });
    assert.ok(!safeExportFailure?.error.includes("Secret!B42"));
    assert.ok(!safeExportFailure?.error.includes("/private/runtime"));
    assert.equal(
        scsemExportFailureDetails(new Error("Database connection failed")),
        null,
        "Unexpected operational failures must remain server errors instead of being mislabeled as schema rejection"
    );

    const analyzingSnapshot = {
        revision: exportRevision,
        status: "analyzing" as const,
    };
    assert.equal(
        isSCSEMAnalysisFailureOwnedByRevision(analyzingSnapshot, null),
        false,
        "An early failure without a captured analysis revision must never claim a session"
    );
    assert.equal(
        isSCSEMAnalysisFailureOwnedByRevision(analyzingSnapshot, exportRevision),
        true,
        "Only the exact analyzing revision may be transitioned to error"
    );
    assert.equal(
        isSCSEMAnalysisFailureOwnedByRevision(
            { ...analyzingSnapshot, revision: exportRevision + 1 },
            exportRevision
        ),
        false,
        "A newer session revision must not be overwritten by an older analysis failure"
    );
    assert.equal(
        isSCSEMAnalysisFailureOwnedByRevision(
            { ...analyzingSnapshot, status: "review_ready" },
            exportRevision
        ),
        false,
        "A completed session must not be overwritten by a late analysis failure"
    );

    const internalAnalysisFailure = scsemAnalysisFailureDetails(
        new Error("Bifrost key sk-secret-value failed at /private/runtime/scsem.xlsx")
    );
    assert.deepEqual(internalAnalysisFailure, {
        status: 500,
        response: { error: SCSEM_ANALYSIS_FAILURE_MESSAGE },
        persistedError: SCSEM_ANALYSIS_FAILURE_MESSAGE,
    });
    assert.ok(!JSON.stringify(internalAnalysisFailure).includes("sk-secret-value"));
    assert.ok(!JSON.stringify(internalAnalysisFailure).includes("/private/runtime"));

    const sourceIntegrityFailure = scsemAnalysisFailureDetails(
        new SCSEMSourceIntegrityError("Pinned source failed at /private/runtime/source.xlsx")
    );
    assert.equal(sourceIntegrityFailure.status, 409);
    assert.equal(sourceIntegrityFailure.response.code, "SCSEM_SOURCE_INTEGRITY_FAILURE");
    assert.ok(!JSON.stringify(sourceIntegrityFailure).includes("/private/runtime"));

    const genericRouteMessage = "The updater request failed.";
    const misleadingNotFoundFailure = scsemUpdaterRouteFailureDetails(
        new Error("Database table not found while using sk-secret at /private/runtime/database.sock"),
        genericRouteMessage
    );
    assert.deepEqual(misleadingNotFoundFailure, {
        status: 500,
        response: { error: genericRouteMessage },
    });
    assert.ok(!JSON.stringify(misleadingNotFoundFailure).includes("sk-secret"));
    assert.ok(!JSON.stringify(misleadingNotFoundFailure).includes("/private/runtime"));

    assert.deepEqual(
        scsemUpdaterRouteFailureDetails(
            new Error("SCSEM updater session not found."),
            genericRouteMessage
        ),
        {
            status: 404,
            response: { error: "SCSEM updater session not found." },
        },
        "Only the exact creator-scoped session miss may map to HTTP 404"
    );
    const structuredConflict = scsemUpdaterRouteFailureDetails(
        new SCSEMUpdaterConflictError("Revision conflict.", 2, 3),
        genericRouteMessage
    );
    assert.equal(structuredConflict.status, 409);
    assert.equal(structuredConflict.response.code, "SCSEM_SESSION_CONFLICT");
    assert.equal(structuredConflict.response.expectedRevision, 2);
    assert.equal(structuredConflict.response.actualRevision, 3);
    const structuredSourceIntegrity = scsemUpdaterRouteFailureDetails(
        new SCSEMSourceIntegrityError("Do not expose /private/source.xlsx"),
        genericRouteMessage
    );
    assert.equal(structuredSourceIntegrity.status, 409);
    assert.equal(structuredSourceIntegrity.response.code, "SCSEM_SOURCE_INTEGRITY_FAILURE");
    assert.ok(!JSON.stringify(structuredSourceIntegrity).includes("/private/source.xlsx"));
    const structuredExportFailure = scsemUpdaterRouteFailureDetails(
        internalExportFailure,
        genericRouteMessage
    );
    assert.equal(structuredExportFailure.status, 422);
    assert.equal(structuredExportFailure.response.code, SCSEM_EXPORT_SCHEMA_UNSUPPORTED);
    assert.ok(!JSON.stringify(structuredExportFailure).includes("Secret!B42"));

    const mutatingRoutes = [
        "src/app/api/scsem-updater/[id]/analyze/route.ts",
        "src/app/api/scsem-updater/[id]/changes/route.ts",
        "src/app/api/scsem-updater/[id]/undo/route.ts",
    ];
    for (const route of mutatingRoutes) {
        const source = fs.readFileSync(path.join(process.cwd(), route), "utf8");
        assert.ok(source.includes("requireSCSEMUpdaterExpectedRevision"), `${route} lacks If-Match enforcement`);
        assert.ok(
            source.includes("scsemUpdaterMutationErrorDetails") ||
            source.includes("scsemUpdaterRouteFailureDetails"),
            `${route} lacks conflict-to-409 mapping`
        );
        assert.ok(
            source.includes("await writeSCSEMUpdaterSession(") &&
            source.includes("affectedPayload:") &&
            source.includes("...auditRequestContext(request)"),
            `${route} must await the intent-first durable session writer with request-linked payload metadata`
        );
    }

    const storeSource = fs.readFileSync(
        path.join(process.cwd(), "src/lib/scsem-updater-store.ts"),
        "utf8"
    );
    const strictIntentIndex = storeSource.indexOf("await persistence.persistIntent({");
    const sessionWriteIndex = storeSource.indexOf("atomicWriteTextFileSync(sessionPath");
    assert.ok(
        strictIntentIndex >= 0 && sessionWriteIndex > strictIntentIndex,
        "The strict DB intent must be awaited before any canonical session replacement"
    );
    assert.ok(
        storeSource.includes("lastOperationId: operationId") &&
        storeSource.includes('action: "durable_mutation"') &&
        storeSource.includes("operationId,"),
        "The resulting session and history must carry the same reconciliation operationId"
    );
    assert.ok(
        storeSource.includes('action: "SCSEM_UPDATER_DURABLE_ABORTED"') &&
        storeSource.includes('action: "SCSEM_UPDATER_DURABLE_COMPLETED"'),
        "Intent outcomes must be reconcilable as completed or aborted"
    );

    const auditSource = fs.readFileSync(path.join(process.cwd(), "src/lib/audit.ts"), "utf8");
    assert.ok(
        auditSource.includes("export async function logAuditStrict") &&
        !auditSource.slice(
            auditSource.indexOf("export async function logAuditStrict"),
            auditSource.indexOf("export async function logAudit(")
        ).includes("try {"),
        "The strict audit helper must propagate database failures"
    );

    const uploadRoute = fs.readFileSync(
        path.join(process.cwd(), "src/app/api/scsem-updater/upload/route.ts"),
        "utf8"
    );
    assert.ok(
        uploadRoute.includes("await createSCSEMUpdaterSession(") &&
        uploadRoute.includes('action: "SCSEM_UPDATER_UPLOAD"') &&
        !uploadRoute.includes("logAudit("),
        "Upload creation must be performed through the intent-first store boundary"
    );

    const analyzeRoute = fs.readFileSync(
        path.join(process.cwd(), "src/app/api/scsem-updater/[id]/analyze/route.ts"),
        "utf8"
    );
    assert.ok(
        analyzeRoute.includes("claimSCSEMAnalysisLease") &&
        analyzeRoute.includes('outcome === "already_running"') &&
        analyzeRoute.includes("analysisLeaseExpiresAt: leaseClaim.lease.expiresAt") &&
        analyzeRoute.includes('"SCSEM_UPDATER_ANALYZE_RESTART"') &&
        analyzeRoute.includes('reason: "analysis_lease_expired"'),
        "Analysis must reject a fresh lease and durably identify stale-abort/restart recovery"
    );
    assert.ok(
        analyzeRoute.includes("scsemBenchmarkLookupFailureDetails") &&
        !analyzeRoute.includes("benchmarkLookupError = error?.message") &&
        !analyzeRoute.includes("Adjacent CIS Benchmark/CIS-STIG lookup failed"),
        "Benchmark lookup exceptions must be mapped before entering session, API, audit, or export state"
    );
    const benchmarkResolver = fs.readFileSync(
        path.join(process.cwd(), "src/lib/scsem-benchmark-resolver.ts"),
        "utf8"
    );
    assert.ok(
        benchmarkResolver.includes("scsemBenchmarkCandidateFailureReason(error)") &&
        !benchmarkResolver.includes("reason: error instanceof Error ? error.message"),
        "Benchmark resolution diagnostics must not persist raw download/parser errors"
    );

    for (const route of [
        uploadRoute,
        fs.readFileSync(path.join(process.cwd(), "src/app/api/scsem-updater/[id]/route.ts"), "utf8"),
        analyzeRoute,
        fs.readFileSync(path.join(process.cwd(), "src/app/api/scsem-updater/[id]/changes/route.ts"), "utf8"),
        fs.readFileSync(path.join(process.cwd(), "src/app/api/scsem-updater/[id]/undo/route.ts"), "utf8"),
    ]) {
        assert.ok(
            route.includes("clientSafeSCSEMUpdaterSession(updaterSession)"),
            "Every updater JSON session response must use the client-safe projection"
        );
    }
    assert.ok(
        (analyzeRoute.match(/clearSCSEMAnalysisLease\(/g) || []).length >= 4 &&
        analyzeRoute.includes("isSCSEMAnalysisLeaseOwnedBy(updaterSession, analysisOperationId)") &&
        !analyzeRoute.includes("isSCSEMAnalysisFailureOwnedByRevision"),
        "Final and error transitions must clear only their operation-owned analysis lease"
    );
    assert.ok(
        analyzeRoute.includes("scsemAnalysisFailureDetails") &&
        !analyzeRoute.includes('error.message || "Failed to analyze'),
        "Analysis failures must use sanitized client and persisted messages"
    );

    const sanitizedUpdaterRoutes = [
        "src/app/api/scsem-updater/[id]/route.ts",
        "src/app/api/scsem-updater/upload/route.ts",
        "src/app/api/scsem-updater/[id]/changes/route.ts",
        "src/app/api/scsem-updater/[id]/undo/route.ts",
    ];
    for (const route of sanitizedUpdaterRoutes) {
        const source = fs.readFileSync(path.join(process.cwd(), route), "utf8");
        assert.ok(
            source.includes("scsemUpdaterRouteFailureDetails"),
            `${route} must use the shared sanitized updater error mapper`
        );
        assert.ok(
            !source.includes("error.message?.includes") &&
            !source.includes("error.message ||"),
            `${route} must not expose or heuristically classify raw exception messages`
        );
    }

    const legacyDetailRoute = fs.readFileSync(
        path.join(process.cwd(), "src/app/api/scsems/[id]/route.ts"),
        "utf8"
    );
    assert.ok(
        legacyDetailRoute.includes("requireScsemSteward") &&
        legacyDetailRoute.includes("status: 410") &&
        legacyDetailRoute.includes('"Cache-Control": "private, no-store"') &&
        legacyDetailRoute.includes('code: "LEGACY_SCSEM_DETAIL_RETIRED"') &&
        !legacyDetailRoute.includes("prisma") &&
        !legacyDetailRoute.includes("scsem-importer") &&
        !legacyDetailRoute.includes("filePath") &&
        !legacyDetailRoute.includes("error.message"),
        "The legacy detail API must be auth-gated, bounded, non-cacheable, and free of database/importer access"
    );
    const legacyDetailPage = fs.readFileSync(
        path.join(process.cwd(), "src/app/(authenticated)/scsems/[id]/page.tsx"),
        "utf8"
    );
    assert.ok(
        legacyDetailPage.includes('permanentRedirect("/scsems")') &&
        !legacyDetailPage.includes("prisma") &&
        !legacyDetailPage.includes("ScsemDetailTabs"),
        "The retired legacy detail page must permanently redirect to the pinned-source updater"
    );
    for (const retiredFile of [
        "src/lib/scsem-detail-client.ts",
        "src/components/scsem-detail-tabs.tsx",
        "src/lib/scsem-importer.ts",
    ]) {
        assert.equal(
            fs.existsSync(path.join(process.cwd(), retiredFile)),
            false,
            `${retiredFile} must remain retired`
        );
    }

    const exportRoute = fs.readFileSync(
        path.join(process.cwd(), "src/app/api/scsem-updater/[id]/export/route.ts"),
        "utf8"
    );
    assert.ok(
        exportRoute.includes("scsemExportFailureDetails"),
        "Updater export route must map known schema failures to sanitized HTTP 422 responses"
    );
    assert.ok(
        exportRoute.includes("requireSCSEMUpdaterExpectedRevision"),
        "Updater export route must require the reviewed revision in If-Match"
    );
    assert.ok(
        exportRoute.includes("withLockedSCSEMUpdaterSessionForUser"),
        "Updater export route must hold the session lock through candidate generation"
    );
    assert.ok(
        exportRoute.includes("scsemUpdaterMutationErrorDetails"),
        "Updater export route must map stale or missing revisions to conflict/precondition responses"
    );
    assert.ok(
        exportRoute.includes("scsemUpdaterRevisionETag") &&
        exportRoute.includes('"X-SCSEM-Revision"'),
        "Updater export responses must identify the exact exported session revision"
    );
    assert.ok(
        exportRoute.includes("Failed to export candidate SCSEM workbook.") &&
        !exportRoute.includes('error.message || "Failed to export'),
        "Unexpected export failures must not expose internal error details"
    );
    const exportBufferIndex = exportRoute.indexOf("const buffer = await buildSCSEMUpdaterWorkbookBuffer(");
    const strictExportAuditIndex = exportRoute.indexOf("await logAuditStrict({");
    const exportResponseIndex = exportRoute.indexOf("return new Response(new Uint8Array(buffer)");
    assert.ok(
        exportBufferIndex >= 0 &&
        strictExportAuditIndex > exportBufferIndex &&
        exportResponseIndex > strictExportAuditIndex &&
        exportRoute.includes("outputSha256: candidateSha256") &&
        exportRoute.includes("exportBaseSha256: verifiedBase.sha256") &&
        exportRoute.includes("sessionRevision: updaterSession.revision"),
        "Export must generate first, strictly log output/source hashes and revision, then release bytes"
    );

    const updaterUi = fs.readFileSync(
        path.join(process.cwd(), "src/components/scsem-updater.tsx"),
        "utf8"
    );
    assert.ok(
        (updaterUi.match(/"If-Match"/g) || []).length >= 5,
        "Every updater UI mutation and export must send the loaded session revision"
    );
    assert.ok(
        !updaterUi.includes("originalFilePath") && !updaterUi.includes("filePath"),
        "The updater UI must not depend on server-side storage locators"
    );
    assert.ok(
        updaterUi.includes("analysisLeasePresent") &&
        !updaterUi.includes("analysisOperationId"),
        "The updater UI must receive only a lease-presence bit, never the internal operation identifier"
    );
    assert.ok(
        updaterUi.includes("URL.createObjectURL") && updaterUi.includes("await res.blob()"),
        "Updater export must download the revision-checked response as a Blob"
    );
    assert.ok(
        !updaterUi.includes("<a\n                            href={`/api/scsem-updater/"),
        "Updater export must not bypass If-Match through a plain navigation link"
    );
    assert.ok(
        updaterUi.includes("analysisLeaseExpiresAt") &&
        updaterUi.includes("scsemAnalysisLeaseViewState") &&
        updaterUi.includes("useState<number | null>(null)") &&
        updaterUi.includes("refreshAtLeaseBoundary"),
        "The UI must derive lease state from persisted expiry after hydration and refresh at its boundary"
    );
    assert.ok(
        updaterUi.includes('"Recover stale analysis"') &&
        updaterUi.includes("staleAnalysisRecoverable") &&
        updaterUi.includes("disabled={analysisBusy || activeAnalysisProtected || session.workspaceMode === \"cis_bootstrap\"}") &&
        updaterUi.includes('setBusy(recoveringStaleLease ? "recover-analysis" : "analyze")'),
        "Only an explicitly stale lease may expose the audited recovery action"
    );
    assert.ok(
        updaterUi.includes('method: "POST"') &&
        updaterUi.includes('headers: { "If-Match": `"${session.revision}"` }') &&
        updaterUi.includes("It does not clear or overwrite analysis state in the browser") &&
        !updaterUi.includes('setSession({ ...session, status: "analyzing" })'),
        "Recovery must use the normal revision-checked route without silently clearing client state"
    );

    const proxy = fs.readFileSync(
        path.join(process.cwd(), "src/proxy.ts"),
        "utf8"
    );
    assert.ok(
        proxy.includes('if (pathname.startsWith("/api/"))') &&
        proxy.includes('NextResponse.json({ error: "Unauthorized" }, { status: 401 })'),
        "Unauthenticated API requests must receive bounded JSON 401 responses instead of login redirects"
    );
    } finally {
        if (previousRuntimeRoot === undefined) delete process.env.SKYSHIELD_RUNTIME_DATA_DIR;
        else process.env.SKYSHIELD_RUNTIME_DATA_DIR = previousRuntimeRoot;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    process.stdout.write("SCSEM updater lifecycle, atomic-write, lock, and revision tests passed.\n");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
