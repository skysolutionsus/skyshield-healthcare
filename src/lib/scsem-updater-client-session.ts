import type {
    SCSEMDisaStigAuditSource,
    SCSEMUpdaterAuditSource,
    SCSEMUpdaterChange,
    SCSEMUpdaterSession,
} from "@/lib/scsem-updater-store";
import {
    boundedStoredSCSEMBenchmarkAttemptReason,
    boundedStoredSCSEMBenchmarkNarrative,
} from "@/lib/scsem-benchmark-failure";
import type {
    SCSEMIssueCodeAudit,
    SCSEMIssueCodeAuditFinding,
} from "@/lib/scsem-issue-codes";

type ClientEvidenceValue = string | number | boolean | null | string[];

export type SCSEMUpdaterClientChange = Pick<
    SCSEMUpdaterChange,
    | "id"
    | "status"
    | "action"
    | "testId"
    | "field"
    | "currentValue"
    | "proposedValue"
    | "reason"
    | "confidence"
    | "targetSheet"
> & {
    sourceEvidence?: Record<string, ClientEvidenceValue> | null;
    newControl?: {
        nistId?: string | null;
        nistControlName?: string | null;
        testMethod?: string | null;
        sectionTitle?: string | null;
        description?: string | null;
        testProcedures?: string | null;
        expectedResults?: string | null;
        findingStatement?: string | null;
        criticality?: string | null;
        issueCode?: string | null;
        cisBenchmarkRef?: string | null;
        recommendationNum?: string | null;
        rationale?: string | null;
        impact?: string | null;
        remediationProcedure?: string | null;
    };
};

export type SCSEMUpdaterClientAuditSource = Pick<
    SCSEMUpdaterAuditSource,
    | "sourceKind"
    | "sourceRelationship"
    | "workbenchId"
    | "benchmarkTitle"
    | "benchmarkVersion"
    | "sha256"
    | "selectedProfile"
    | "matchedSheets"
    | "matchQuery"
    | "adjacentCategory"
    | "adjacentRationale"
>;

export type SCSEMUpdaterClientDisaStigSource = Pick<
    SCSEMDisaStigAuditSource,
    | "sourceKind"
    | "sourceRelationship"
    | "sourceTitle"
    | "sourceVersion"
    | "sourceReleaseInfo"
    | "sourceUploadDate"
    | "sourceUrl"
    | "catalogSourceUrl"
    | "catalogReviewedAt"
    | "benchmarkIds"
    | "expectedPackageSha256"
    | "packageSha256"
    | "ruleCount"
    | "matchedSheets"
    | "matchQuery"
    | "error"
>;

export type SCSEMUpdaterClientIssueCodeAudit = Pick<
    SCSEMIssueCodeAudit,
    | "complete"
    | "issueCodeTableEntries"
    | "testCaseRows"
    | "rowsWithIssueCodes"
    | "issueCodeReferences"
    | "validIssueCodeReferences"
    | "errorCount"
    | "truncatedFindingCount"
> & {
    findings: Array<Pick<
        SCSEMIssueCodeAuditFinding,
        | "severity"
        | "kind"
        | "sheetName"
        | "row"
        | "testId"
        | "issueCode"
        | "message"
    >>;
};

export interface SCSEMUpdaterClientSession {
    id: string;
    revision: number;
    analysisLeasePresent: boolean;
    analysisStartedAt?: string;
    analysisLeaseExpiresAt?: string;
    originalFileName: string;
    inferredTechnology: string;
    technologyInference?: {
        source: "official_manifest" | "content" | "subject" | "filename" | "fallback";
        confidence: "high" | "medium" | "low";
        signals: string[];
    };
    status: SCSEMUpdaterSession["status"];
    workspaceMode: "official_update" | "unverified_update" | "cis_bootstrap";
    analysisScope: "full" | "compliance_only";
    summary?: string;
    scsem: {
        subject: string | null;
        version: string | null;
        effectiveDate: string | null;
        totalControls: number;
        testCaseSheets: string[];
    };
    changes: SCSEMUpdaterClientChange[];
    history: Array<{
        action: string;
        changeId?: string;
        previousStatus?: SCSEMUpdaterChange["status"];
        nextStatus?: SCSEMUpdaterChange["status"];
    }>;
    audit: {
        pub1075Version?: string;
        nistVersion?: string;
        nistSourceUrl?: string;
        complianceCoverage?: {
            requested: number;
            pub1075: number;
            nistFallback: number;
            uncovered: number;
        };
        benchmarkLookupError?: string;
        benchmarkLookupErrorCode?: string;
        issueCodeAudit?: SCSEMUpdaterClientIssueCodeAudit;
        supplementalComparison?: {
            mode: "ai" | "deterministic_fallback" | "no_delta" | "not_requested" | "failed";
            complete: boolean;
            candidateOnly: true;
            applicabilityStatus: "review_required" | "not_requested" | "not_applicable";
            directSourceCount: number;
            comparedDirectSourceCount: number;
            candidateCount: number;
            comparedCandidateCount: number;
            rawProposalCount: number;
            evidenceBoundProposalCount: number;
            reason: string;
        };
        benchmarkResolution?: Array<{
            kind: "CIS" | "CIS_STIG" | "STIG";
            query: string;
            sheetName: string;
            catalogCandidateCount: number;
            attempts: Array<{
                benchmarkTitle: string;
                benchmarkVersion: string;
                outcome: string;
                reason: string;
            }>;
        }>;
        officialReference?: {
            sourceUrl: string;
            workbookVersion: string | null;
            workbookEffectiveDate: string | null;
            irsEffectiveDate: string;
            addedSheets: string[];
            selectedAsBase: boolean;
            upgradeReason: string | null;
        } | null;
        cis?: SCSEMUpdaterClientAuditSource | null;
        stig?: SCSEMUpdaterClientAuditSource | null;
        cisSources?: SCSEMUpdaterClientAuditSource[];
        stigSources?: SCSEMUpdaterClientAuditSource[];
        adjacentSources?: SCSEMUpdaterClientAuditSource[];
        disaStigSources?: SCSEMUpdaterClientDisaStigSource[];
        cisBootstrap?: {
            workbenchId: number;
            benchmarkTitle: string;
            benchmarkVersion: string;
            selectedProfile: string;
            recommendationCount: number;
            structuralBaseline: {
                sourceFileName: string;
                sourceUrl: string;
                sourceSha256: string;
                sourceVersion: string | null;
                targetSheet: string;
            };
        };
        structuralAdmission?: {
            trust: "unverified_structural_draft";
            totalControls: number;
            testCaseSheets: string[];
            issueCodeCount: number;
            blocker: string;
        };
    };
}

const SOURCE_EVIDENCE_KEYS = [
    "evidenceTier",
    "sourceRelationship",
    "complianceSource",
    "pub1075Only",
    "sourceBenchmarkTitle",
    "sourceWorkbenchId",
    "cisRecommendation",
    "cisProfile",
    "stigRecommendation",
    "stigProfile",
    "adjacentSourceCategory",
    "applicabilityRationale",
    "sourceSheet",
    "pub1075Version",
    "nistVersion",
    "sourceKind",
    "sourceUrl",
    "sourceTitle",
    "sourceUploadDate",
    "sourcePackageSha256",
    "stigBenchmarkId",
    "stigRuleId",
    "stigVersion",
    "stigVulnerabilityId",
    "cciIds",
    "nistControlIds",
    "gapType",
    "applicabilityReviewRequired",
    "strictnessGroupId",
    "strictnessSelectionRequired",
    "competingAuthorityCount",
    "competingAuthorities",
] as const;

function clientSourceEvidence(
    evidence: Record<string, unknown> | null | undefined
): Record<string, ClientEvidenceValue> | null | undefined {
    if (evidence === null) return null;
    if (!evidence) return undefined;
    const selected: Record<string, ClientEvidenceValue> = {};
    for (const key of SOURCE_EVIDENCE_KEYS) {
        const value = evidence[key];
        if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
            selected[key] = value.slice(0, 100);
        } else if (
            typeof value === "string" || typeof value === "number" ||
            typeof value === "boolean" || value === null
        ) {
            selected[key] = value;
        }
    }
    return Object.keys(selected).length > 0 ? selected : null;
}

function clientChange(change: SCSEMUpdaterChange): SCSEMUpdaterClientChange {
    const newControl = change.newControl;
    return {
        id: change.id,
        status: change.status,
        action: change.action,
        testId: change.testId,
        field: change.field,
        currentValue: change.currentValue,
        proposedValue: change.proposedValue,
        reason: change.reason,
        ...(change.confidence !== undefined ? { confidence: change.confidence } : {}),
        ...(change.targetSheet !== undefined ? { targetSheet: change.targetSheet } : {}),
        ...(change.sourceEvidence !== undefined
            ? { sourceEvidence: clientSourceEvidence(change.sourceEvidence) }
            : {}),
        ...(newControl !== undefined
            ? {
                newControl: {
                    ...(newControl.nistId !== undefined ? { nistId: newControl.nistId } : {}),
                    ...(newControl.nistControlName !== undefined
                        ? { nistControlName: newControl.nistControlName }
                        : {}),
                    ...(newControl.testMethod !== undefined ? { testMethod: newControl.testMethod } : {}),
                    ...(newControl.sectionTitle !== undefined ? { sectionTitle: newControl.sectionTitle } : {}),
                    ...(newControl.description !== undefined ? { description: newControl.description } : {}),
                    ...(newControl.testProcedures !== undefined
                        ? { testProcedures: newControl.testProcedures }
                        : {}),
                    ...(newControl.expectedResults !== undefined
                        ? { expectedResults: newControl.expectedResults }
                        : {}),
                    ...(newControl.findingStatement !== undefined
                        ? { findingStatement: newControl.findingStatement }
                        : {}),
                    ...(newControl.criticality !== undefined ? { criticality: newControl.criticality } : {}),
                    ...(newControl.issueCode !== undefined ? { issueCode: newControl.issueCode } : {}),
                    ...(newControl.cisBenchmarkRef !== undefined
                        ? { cisBenchmarkRef: newControl.cisBenchmarkRef }
                        : {}),
                    ...(newControl.recommendationNum !== undefined
                        ? { recommendationNum: newControl.recommendationNum }
                        : {}),
                    ...(newControl.rationale !== undefined ? { rationale: newControl.rationale } : {}),
                    ...(newControl.impact !== undefined ? { impact: newControl.impact } : {}),
                    ...(newControl.remediationProcedure !== undefined
                        ? { remediationProcedure: newControl.remediationProcedure }
                        : {}),
                },
            }
            : {}),
    };
}

function clientAuditSource(
    source: SCSEMUpdaterAuditSource
): SCSEMUpdaterClientAuditSource {
    return {
        ...(source.sourceKind !== undefined ? { sourceKind: source.sourceKind } : {}),
        ...(source.sourceRelationship !== undefined
            ? { sourceRelationship: source.sourceRelationship }
            : {}),
        workbenchId: source.workbenchId,
        benchmarkTitle: source.benchmarkTitle,
        benchmarkVersion: source.benchmarkVersion,
        sha256: source.sha256,
        ...(source.selectedProfile !== undefined ? { selectedProfile: source.selectedProfile } : {}),
        ...(source.matchedSheets !== undefined ? { matchedSheets: [...source.matchedSheets] } : {}),
        ...(source.matchQuery !== undefined ? { matchQuery: source.matchQuery } : {}),
        ...(source.adjacentCategory !== undefined ? { adjacentCategory: source.adjacentCategory } : {}),
        ...(source.adjacentRationale !== undefined ? { adjacentRationale: source.adjacentRationale } : {}),
    };
}

function clientAuditSourceList(
    sources: SCSEMUpdaterAuditSource[] | undefined
): SCSEMUpdaterClientAuditSource[] | undefined {
    return sources?.map(clientAuditSource);
}

/** Explicit allowlist matching only fields consumed by the SCSEM updater UI. */
export function clientSafeSCSEMUpdaterSession(
    session: SCSEMUpdaterSession
): SCSEMUpdaterClientSession {
    const officialReference = session.audit.officialReference;
    const benchmarkNarrative = boundedStoredSCSEMBenchmarkNarrative({
        benchmarkLookupError: session.audit.benchmarkLookupError,
        summary: session.summary,
        blockers: session.audit.analysisCoverage?.blockers,
        supplementalReason: session.audit.supplementalComparison?.reason,
    });
    return {
        id: session.id,
        revision: session.revision,
        analysisLeasePresent: Boolean(session.analysisOperationId),
        ...(session.analysisStartedAt !== undefined
            ? { analysisStartedAt: session.analysisStartedAt }
            : {}),
        ...(session.analysisLeaseExpiresAt !== undefined
            ? { analysisLeaseExpiresAt: session.analysisLeaseExpiresAt }
            : {}),
        originalFileName: session.originalFileName,
        inferredTechnology: session.inferredTechnology,
        ...(session.technologyInference !== undefined
            ? {
                technologyInference: {
                    source: session.technologyInference.source,
                    confidence: session.technologyInference.confidence,
                    signals: [...session.technologyInference.signals],
                },
            }
            : {}),
        status: session.status,
        workspaceMode: session.workspaceMode || "official_update",
        analysisScope: session.analysisScope || "full",
        ...(benchmarkNarrative.summary !== undefined
            ? { summary: benchmarkNarrative.summary }
            : {}),
        scsem: {
            subject: session.scsem.subject,
            version: session.scsem.version,
            effectiveDate: session.scsem.effectiveDate,
            totalControls: session.scsem.totalControls,
            testCaseSheets: [...session.scsem.testCaseSheets],
        },
        changes: session.changes.map(clientChange),
        history: session.history.map((entry) => ({
            action: entry.action,
            ...(entry.changeId !== undefined ? { changeId: entry.changeId } : {}),
            ...(entry.previousStatus !== undefined ? { previousStatus: entry.previousStatus } : {}),
            ...(entry.nextStatus !== undefined ? { nextStatus: entry.nextStatus } : {}),
        })),
        audit: {
            ...(session.audit.pub1075Version !== undefined
                ? { pub1075Version: session.audit.pub1075Version }
                : {}),
            ...(session.audit.nistVersion !== undefined ? { nistVersion: session.audit.nistVersion } : {}),
            ...(session.audit.nistSourceUrl !== undefined
                ? { nistSourceUrl: session.audit.nistSourceUrl }
                : {}),
            ...(session.audit.complianceCoverage !== undefined
                ? {
                    complianceCoverage: {
                        requested: session.audit.complianceCoverage.requested,
                        pub1075: session.audit.complianceCoverage.pub1075,
                        nistFallback: session.audit.complianceCoverage.nistFallback,
                        uncovered: session.audit.complianceCoverage.uncovered,
                    },
                }
                : {}),
            ...(benchmarkNarrative.benchmarkLookupError !== undefined
                ? {
                    benchmarkLookupError: benchmarkNarrative.benchmarkLookupError,
                }
                : {}),
            ...(session.audit.benchmarkLookupErrorCode !== undefined
                ? { benchmarkLookupErrorCode: session.audit.benchmarkLookupErrorCode }
                : {}),
            ...(session.audit.issueCodeAudit !== undefined
                ? {
                    issueCodeAudit: {
                        complete: session.audit.issueCodeAudit.complete,
                        issueCodeTableEntries: session.audit.issueCodeAudit.issueCodeTableEntries,
                        testCaseRows: session.audit.issueCodeAudit.testCaseRows,
                        rowsWithIssueCodes: session.audit.issueCodeAudit.rowsWithIssueCodes,
                        issueCodeReferences: session.audit.issueCodeAudit.issueCodeReferences,
                        validIssueCodeReferences: session.audit.issueCodeAudit.validIssueCodeReferences,
                        errorCount: session.audit.issueCodeAudit.errorCount,
                        findings: session.audit.issueCodeAudit.findings.map((finding) => ({
                            severity: finding.severity,
                            kind: finding.kind,
                            sheetName: finding.sheetName,
                            row: finding.row,
                            testId: finding.testId,
                            issueCode: finding.issueCode,
                            message: finding.message,
                        })),
                        truncatedFindingCount: session.audit.issueCodeAudit.truncatedFindingCount,
                    },
                }
                : {}),
            ...(session.audit.supplementalComparison !== undefined
                ? {
                    supplementalComparison: {
                        mode: session.audit.supplementalComparison.mode,
                        complete: session.audit.supplementalComparison.complete,
                        candidateOnly: session.audit.supplementalComparison.candidateOnly,
                        applicabilityStatus: session.audit.supplementalComparison.applicabilityStatus,
                        directSourceCount: session.audit.supplementalComparison.directSourceCount,
                        comparedDirectSourceCount:
                            session.audit.supplementalComparison.comparedDirectSourceCount,
                        candidateCount: session.audit.supplementalComparison.candidateCount,
                        comparedCandidateCount:
                            session.audit.supplementalComparison.comparedCandidateCount,
                        rawProposalCount: session.audit.supplementalComparison.rawProposalCount,
                        evidenceBoundProposalCount:
                            session.audit.supplementalComparison.evidenceBoundProposalCount,
                        reason: benchmarkNarrative.supplementalReason ??
                            session.audit.supplementalComparison.reason,
                    },
                }
                : {}),
            ...(session.audit.benchmarkResolution !== undefined
                ? {
                    benchmarkResolution: session.audit.benchmarkResolution.map((diagnostic) => ({
                        kind: diagnostic.kind,
                        query: diagnostic.query,
                        sheetName: diagnostic.sheetName,
                        catalogCandidateCount: diagnostic.catalogCandidateCount,
                        attempts: diagnostic.attempts.map((attempt) => ({
                            benchmarkTitle: attempt.benchmarkTitle,
                            benchmarkVersion: attempt.benchmarkVersion,
                            outcome: attempt.outcome,
                            reason: boundedStoredSCSEMBenchmarkAttemptReason(attempt.reason),
                        })),
                    })),
                }
                : {}),
            ...(officialReference !== undefined
                ? {
                    officialReference: officialReference
                        ? {
                            sourceUrl: officialReference.sourceUrl,
                            workbookVersion: officialReference.workbookVersion,
                            workbookEffectiveDate: officialReference.workbookEffectiveDate,
                            irsEffectiveDate: officialReference.irsEffectiveDate,
                            addedSheets: [...officialReference.addedSheets],
                            selectedAsBase: officialReference.selectedAsBase,
                            upgradeReason: officialReference.upgradeReason,
                        }
                        : null,
                }
                : {}),
            ...(session.audit.cis !== undefined
                ? { cis: session.audit.cis ? clientAuditSource(session.audit.cis) : null }
                : {}),
            ...(session.audit.stig !== undefined
                ? { stig: session.audit.stig ? clientAuditSource(session.audit.stig) : null }
                : {}),
            ...(session.audit.cisSources !== undefined
                ? { cisSources: clientAuditSourceList(session.audit.cisSources) }
                : {}),
            ...(session.audit.stigSources !== undefined
                ? { stigSources: clientAuditSourceList(session.audit.stigSources) }
                : {}),
            ...(session.audit.adjacentSources !== undefined
                ? { adjacentSources: clientAuditSourceList(session.audit.adjacentSources) }
                : {}),
            ...(session.audit.disaStigSources !== undefined
                ? {
                    disaStigSources: session.audit.disaStigSources.map((source) => ({
                        sourceKind: source.sourceKind,
                        sourceRelationship: source.sourceRelationship,
                        sourceTitle: source.sourceTitle,
                        sourceVersion: source.sourceVersion,
                        sourceReleaseInfo: source.sourceReleaseInfo,
                        sourceUploadDate: source.sourceUploadDate,
                        sourceUrl: source.sourceUrl,
                        catalogSourceUrl: source.catalogSourceUrl,
                        catalogReviewedAt: source.catalogReviewedAt,
                        benchmarkIds: [...source.benchmarkIds],
                        ...(source.expectedPackageSha256 !== undefined
                            ? { expectedPackageSha256: source.expectedPackageSha256 }
                            : {}),
                        ...(source.packageSha256 !== undefined
                            ? { packageSha256: source.packageSha256 }
                            : {}),
                        ...(source.ruleCount !== undefined ? { ruleCount: source.ruleCount } : {}),
                        matchedSheets: [...source.matchedSheets],
                        matchQuery: source.matchQuery,
                        ...(source.error !== undefined ? { error: source.error } : {}),
                    })),
                }
                : {}),
            ...(session.audit.cisBootstrap !== undefined
                ? {
                    cisBootstrap: {
                        workbenchId: session.audit.cisBootstrap.workbenchId,
                        benchmarkTitle: session.audit.cisBootstrap.benchmarkTitle,
                        benchmarkVersion: session.audit.cisBootstrap.benchmarkVersion,
                        selectedProfile: session.audit.cisBootstrap.selectedProfile,
                        recommendationCount: session.audit.cisBootstrap.recommendationCount,
                        structuralBaseline: { ...session.audit.cisBootstrap.structuralBaseline },
                    },
                }
                : {}),
            ...(session.audit.structuralAdmission !== undefined
                ? {
                    structuralAdmission: {
                        trust: session.audit.structuralAdmission.trust,
                        totalControls: session.audit.structuralAdmission.totalControls,
                        testCaseSheets: [...session.audit.structuralAdmission.testCaseSheets],
                        issueCodeCount: session.audit.structuralAdmission.issueCodeCount,
                        blocker: session.audit.structuralAdmission.blocker,
                    },
                }
                : {}),
        },
    };
}
