import { NextResponse } from "next/server";
import { auditRequestContext } from "@/lib/audit";
import {
    fetchAllBenchmarkExcelFiles,
    fetchAllBenchmarks,
    getCISToken,
    hasConfiguredCISLicense,
} from "@/lib/cis-api";
import {
    recommendationEvidenceSummary,
    type CISBenchmarkRecommendation,
    type SelectedCISProfile,
} from "@/lib/cis-benchmark-xlsx";
import {
    hasUnavailableApplicableBenchmarkQuery,
    resolveAdjacentSCSEMBenchmarkSources,
    resolveSCSEMBenchmarkSourcesDetailed,
    type BenchmarkQueryResolutionDiagnostic,
    type ResolvedBenchmarkKind,
    type ResolvedBenchmarkSource,
} from "@/lib/scsem-benchmark-resolver";
import {
    addIdsToChanges,
    assertSCSEMUpdaterRevision,
    SCSEM_ANALYSIS_LEASE_TIMEOUT_MS,
    claimSCSEMAnalysisLease,
    clearSCSEMAnalysisLease,
    createSCSEMAnalysisOperationId,
    isSCSEMAnalysisLeaseOwnedBy,
    readSCSEMUpdaterSessionForUser,
    requireSCSEMUpdaterExpectedRevision,
    scsemUpdaterMutationErrorDetails,
    scsemUpdaterRevisionETag,
    writeSCSEMUpdaterSession,
    type SCSEMUpdaterAuditSource,
    type SCSEMAnalysisScope,
} from "@/lib/scsem-updater-store";
import { parseSCSEMFile, type ParsedSCSEM } from "@/lib/xlsx-parser";
import { evaluateOfficialSCSEMReference } from "@/lib/scsem-official-reference";
import {
    assertOfficialSCSEMReferenceIntegrity,
    assertSCSEMUpdaterSourceIntegrity,
} from "@/lib/scsem-source-integrity";
import {
    scsemAnalysisFailureDetails,
} from "@/lib/scsem-analysis-failure";
import { clientSafeSCSEMUpdaterSession } from "@/lib/scsem-updater-client-session";
import { scsemBenchmarkLookupFailureDetails } from "@/lib/scsem-benchmark-failure";
import {
    buildSheetScopedComparisonCandidates,
    buildControlSummary,
    buildNewControlEvidence,
    isMaterialTextDelta,
    isUsableBenchmarkDefaultValue,
    parseJsonResponse,
    validateChanges,
    type DownloadedBenchmark,
    type SCSEMControlEvidence,
} from "@/lib/scsem-update-engine";
import {
    extractComplianceEvidence,
    normalizeNistControlId,
    type ComplianceEvidence,
} from "@/lib/compliance-evidence";
import {
    annotateSCSEMStrictnessConflicts,
    dedupeSCSEMProposalsPreservingAuthorities,
    fairlyLimitSCSEMProposals,
} from "@/lib/scsem-source-precedence";
import {
    buildDisaStigChanges,
    downloadAndParseDisaStigSource,
    resolveDisaStigCatalogSources,
    type ResolvedDisaStigSource,
} from "@/lib/disa-stig";
import {
    generateBifrostText,
    getConfiguredBifrostModel,
    hasConfiguredBifrostApiKey,
} from "@/lib/ai/bifrost";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";
import {
    buildSCSEMAnalysisCoverage,
    missingCompliancePromptEvidenceControlIds,
    type SCSEMSupplementalComparison,
    type SCSEMSupplementalComparisonMode,
} from "@/lib/scsem-analysis-coverage";

export const runtime = "nodejs";

const UPDATER_CANDIDATE_LIMITS = {
    maxUpdateCandidates: 5000,
    maxNewControlCandidates: 5000,
};
const MAX_UPDATER_CHANGES = 5000;
const AI_CONTROL_LIMIT = Number(process.env.SCSEM_UPDATER_AI_CONTROL_LIMIT || 500);
const AI_PROMPT_CHAR_LIMIT = Number(process.env.SCSEM_UPDATER_AI_PROMPT_CHAR_LIMIT || 90000);
// Production evidence prompts routinely need longer than 25 seconds on the
// governed SCSEM model. A 25-second abort made most bounded batches fail even
// though the model and credential were healthy. Keep the timeout bounded, but
// allow enough time for a complete evidence-grounded JSON response.
const AI_TIMEOUT_MS = Math.max(
    30_000,
    Math.min(Number(process.env.SCSEM_UPDATER_AI_TIMEOUT_MS || 90_000), 180_000)
);
const COMPLIANCE_BATCH_CONTROL_LIMIT = Math.max(
    12,
    Math.min(Number(process.env.SCSEM_UPDATER_COMPLIANCE_BATCH_SIZE || 72), 120)
);
const COMPLIANCE_BATCH_CHAR_LIMIT = Math.max(
    12000,
    Math.min(Number(process.env.SCSEM_UPDATER_COMPLIANCE_BATCH_CHAR_LIMIT || 36000), 42000)
);
const COMPLIANCE_BATCH_CONCURRENCY = Math.max(
    1,
    Math.min(Number(process.env.SCSEM_UPDATER_COMPLIANCE_BATCH_CONCURRENCY || 4), 4)
);
const COMPLIANCE_BATCH_UNIQUE_CONTROL_LIMIT = Math.max(
    4,
    Math.min(Number(process.env.SCSEM_UPDATER_COMPLIANCE_BATCH_UNIQUE_CONTROLS || 11), 12)
);
const MAX_COMPLIANCE_CHANGES_PER_BATCH = 6;
const COMPLIANCE_CONTROL_EVIDENCE_LIMIT = Math.min(
    COMPLIANCE_BATCH_CHAR_LIMIT,
    Math.max(
        9000,
        Math.floor(Math.max(24000, AI_PROMPT_CHAR_LIMIT - 12000) * 0.46)
    )
);

function controlsFromParsedSCSEM(parsed: ParsedSCSEM): SCSEMControlEvidence[] {
    return parsed.sheets
        .filter((sheet) => sheet.sheetType === "test_cases")
        .flatMap((sheet) => sheet.controls.map((control) => ({
            id: `${sheet.sheetName}:${control.rowIndex}`,
            sourceSheet: sheet.sheetName,
            testId: control.testId,
            nistId: control.nistId,
            nistControlName: control.nistControlName,
            testMethod: control.testMethod,
            sectionTitle: control.sectionTitle,
            description: control.description,
            testProcedures: control.testProcedures,
            expectedResults: control.expectedResults,
            findingStatement: control.findingStatement,
            criticality: control.criticality,
            cisBenchmarkRef: control.cisBenchmarkRef,
            recommendationNum: control.recommendationNum,
            rationale: control.rationale,
            impact: control.impact,
            remediationProcedure: control.remediationProcedure,
        })));
}

function auditSource(
    downloaded: DownloadedBenchmark,
    selectedProfile: SelectedCISProfile | null | undefined,
    context?: {
        sourceKind?: ResolvedBenchmarkKind;
        sourceRelationship?: "direct" | "adjacent";
        matchedSheets?: string[];
        matchQuery?: string;
        adjacentCategory?: string;
        adjacentRationale?: string;
    }
): SCSEMUpdaterAuditSource {
    return {
        sourceKind: context?.sourceKind,
        sourceRelationship: context?.sourceRelationship,
        workbenchId: downloaded.snapshot.workbenchId,
        benchmarkTitle: downloaded.snapshot.benchmarkTitle,
        benchmarkVersion: downloaded.snapshot.benchmarkVersion,
        releaseDate: downloaded.snapshot.releaseDate.toISOString(),
        excelTitle: downloaded.snapshot.excelTitle,
        excelFileName: downloaded.snapshot.excelFileName,
        filePath: downloaded.snapshot.filePath,
        sha256: downloaded.snapshot.sha256,
        downloadedAt: downloaded.snapshot.downloadedAt.toISOString(),
        selectedProfile: selectedProfile?.profile || null,
        selectedProfileRecommendationCount: selectedProfile?.totalRecommendationCount || 0,
        sharedRecommendationCount: selectedProfile?.sharedRecommendationCount || 0,
        matchedSheets: context?.matchedSheets,
        matchQuery: context?.matchQuery,
        adjacentCategory: context?.adjacentCategory,
        adjacentRationale: context?.adjacentRationale,
        sourceUrl: `https://workbench.cisecurity.org/api/vendor/v1/excel/${downloaded.snapshot.workbenchId}`,
    };
}

type AnalysisUpdateCandidate = {
    sourceKind: ResolvedBenchmarkKind;
    sourceRelationship?: "direct" | "adjacent";
    sourceLabel: string;
    sourceProfile: string;
    sourceWorkbenchId: number;
    sourceBenchmarkTitle: string;
    control: SCSEMControlEvidence;
    recommendation: CISBenchmarkRecommendation;
    score: number;
};

type AnalysisNewCandidate = {
    sourceKind: ResolvedBenchmarkKind;
    sourceRelationship?: "direct" | "adjacent";
    sourceLabel: string;
    sourceProfile: string;
    sourceWorkbenchId: number;
    sourceBenchmarkTitle: string;
    targetSheet?: string;
    recommendation: CISBenchmarkRecommendation;
};

type AnalysisAdjacentCandidate = {
    sourceKind: ResolvedBenchmarkKind;
    sourceRelationship: "adjacent";
    sourceLabel: string;
    sourceProfile: string;
    sourceWorkbenchId: number;
    sourceBenchmarkTitle: string;
    adjacentCategory: string;
    adjacentRationale: string;
    recommendation: CISBenchmarkRecommendation;
    score: number;
};

function sourceLabel(source: ResolvedBenchmarkSource): string {
    return `${benchmarkKindLabel(source.kind)} WB ${source.downloaded.snapshot.workbenchId} ${source.downloaded.snapshot.benchmarkTitle} (${source.selectedProfile.profile})`;
}

function benchmarkKindLabel(kind: ResolvedBenchmarkKind): "CIS" | "CIS-STIG" {
    return kind === "CIS" ? "CIS" : "CIS-STIG";
}

function sourceEvidence(
    candidate: Pick<AnalysisUpdateCandidate | AnalysisNewCandidate,
        "sourceKind" | "sourceRelationship" | "sourceProfile" | "sourceWorkbenchId" | "sourceBenchmarkTitle" | "recommendation">,
    pub1075Version: string,
    nistVersion?: string
) {
    return {
        evidenceTier: candidate.sourceRelationship === "adjacent" ? "adjacent" : "direct",
        sourceRelationship: candidate.sourceRelationship || "direct",
        sourceKind: candidate.sourceKind,
        cisRecommendation: candidate.sourceKind === "CIS" ? candidate.recommendation.recommendation : null,
        cisProfile: candidate.sourceKind === "CIS" ? candidate.sourceProfile : null,
        stigRecommendation: candidate.sourceKind === "CIS_STIG" ? candidate.recommendation.recommendation : null,
        stigProfile: candidate.sourceKind === "CIS_STIG" ? candidate.sourceProfile : null,
        sourceWorkbenchId: candidate.sourceWorkbenchId,
        sourceBenchmarkTitle: candidate.sourceBenchmarkTitle,
        pub1075Version,
        nistVersion: nistVersion || null,
    };
}

type BenchmarkEvidenceCandidate =
    | AnalysisUpdateCandidate
    | AnalysisNewCandidate
    | AnalysisAdjacentCandidate;

function bindBenchmarkChangesToResolvedEvidence(
    changes: any[],
    controls: SCSEMControlEvidence[],
    candidates: BenchmarkEvidenceCandidate[],
    pub1075Version: string,
    nistVersion: string
): any[] {
    const knownSheets = new Set(
        controls.map((control) => control.sourceSheet).filter((value): value is string => Boolean(value))
    );

    return changes.flatMap((change) => {
        if (!change || typeof change !== "object") return [];
        const evidence = change.sourceEvidence && typeof change.sourceEvidence === "object"
            ? change.sourceEvidence as Record<string, unknown>
            : {};
        const requestedWorkbenchId = Number(evidence.sourceWorkbenchId);
        const requestedRecommendation = String(
            evidence.cisRecommendation ||
            evidence.stigRecommendation ||
            change.newControl?.recommendationNum ||
            ""
        ).trim();
        if (!Number.isSafeInteger(requestedWorkbenchId) || requestedWorkbenchId <= 0 || !requestedRecommendation) {
            return [];
        }

        const requestedSheet = typeof change.targetSheet === "string" && change.targetSheet.trim()
            ? change.targetSheet.trim()
            : null;
        const action = change.action === "addControl" ? "addControl" : "updateField";
        let resolvedControl: SCSEMControlEvidence | null = null;
        if (action === "updateField") {
            const matchingControls = controls.filter((control) =>
                control.testId === change.testId &&
                (!requestedSheet || control.sourceSheet === requestedSheet)
            );
            if (matchingControls.length !== 1) return [];
            resolvedControl = matchingControls[0];
        } else if (!requestedSheet || !knownSheets.has(requestedSheet)) {
            return [];
        }

        const matches = candidates.filter((candidate) => {
            if (candidate.sourceWorkbenchId !== requestedWorkbenchId) return false;
            if (candidate.recommendation.recommendation !== requestedRecommendation) return false;
            if (action === "updateField" && "control" in candidate) {
                return candidate.control.testId === resolvedControl?.testId &&
                    candidate.control.sourceSheet === resolvedControl?.sourceSheet;
            }
            if (action === "addControl" && "targetSheet" in candidate && candidate.targetSheet) {
                return candidate.targetSheet === requestedSheet;
            }
            return true;
        });
        if (matches.length !== 1) return [];
        const candidate = matches[0];
        const relationship = candidate.sourceRelationship || "direct";
        const kind = benchmarkKindLabel(candidate.sourceKind);
        const canonicalEvidence = {
            ...sourceEvidence(candidate, pub1075Version, nistVersion),
            evidenceTier: relationship === "adjacent" ? "adjacent" : "direct",
            sourceRelationship: relationship,
            sourceSheet: resolvedControl?.sourceSheet || requestedSheet,
            ...(relationship === "adjacent" && "adjacentRationale" in candidate
                ? { applicabilityRationale: candidate.adjacentRationale }
                : {}),
        };
        const canonicalReason =
            `Reviewer-gated ${relationship} ${kind} proposal using ${candidate.sourceBenchmarkTitle}, ` +
            `recommendation ${candidate.recommendation.recommendation}, profile ${candidate.sourceProfile}, ` +
            `CIS WorkBench ID ${candidate.sourceWorkbenchId}. Verify applicability and permitted use before approval; ` +
            "model-generated wording is not itself evidence.";

        if (action === "updateField" && resolvedControl) {
            const field = String(change.field || "");
            return [{
                ...change,
                action,
                testId: resolvedControl.testId,
                targetSheet: resolvedControl.sourceSheet,
                currentValue: String(
                    (resolvedControl as unknown as Record<string, unknown>)[field] || ""
                ),
                reason: canonicalReason,
                confidence: "needs_review",
                sourceEvidence: canonicalEvidence,
            }];
        }

        return [{
            ...change,
            action: "addControl",
            testId:
                `NEW-${kind}-${candidate.sourceWorkbenchId}-` +
                safeRecommendationId(candidate.recommendation.recommendation),
            targetSheet: requestedSheet,
            field: "newControl",
            currentValue: "Not present in current SCSEM",
            reason: canonicalReason,
            confidence: "needs_review",
            newControl: {
                ...(change.newControl || {}),
                // Issue-code mapping is IRS template metadata. It must be an
                // explicit reviewer selection from the uploaded workbook's
                // catalog, never model output.
                issueCode: null,
                cisBenchmarkRef: candidate.recommendation.section,
                recommendationNum: candidate.recommendation.recommendation,
            },
            sourceEvidence: canonicalEvidence,
        }];
    });
}

function safeRecommendationId(value: string): string {
    return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function compactField(value: string | null | undefined, maxLength: number): string {
    return (value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}

function pub1075ReviewPriority(control: SCSEMControlEvidence): number {
    let score = 0;
    if (control.nistId) score += 4;
    if (!control.testProcedures || control.testProcedures.length < 80) score += 3;
    if (!control.expectedResults || control.expectedResults.length < 40) score += 2;
    if (!control.description || control.description.length < 80) score += 2;
    if (!control.remediationProcedure || control.remediationProcedure.length < 40) score += 1;
    return score;
}

function buildPub1075ControlEvidence(controls: SCSEMControlEvidence[], maxChars: number): string {
    const sortedControls = [...controls]
        .filter((control) => control.nistId || control.description || control.testProcedures)
        .sort((a, b) => {
            const priorityDiff = pub1075ReviewPriority(b) - pub1075ReviewPriority(a);
            if (priorityDiff !== 0) return priorityDiff;
            return a.testId.localeCompare(b.testId, undefined, { numeric: true });
        });
    const blocks: string[] = [];
    let usedChars = 0;

    for (const control of sortedControls) {
        const block = [
            `SCSEM Test ID: ${control.testId}`,
            `Sheet: ${control.sourceSheet || "unknown"}`,
            `NIST: ${control.nistId || "N/A"} | Control: ${control.nistControlName || "N/A"} | Criticality: ${control.criticality || "N/A"}`,
            `Section title: ${compactField(control.sectionTitle, 220) || "N/A"}`,
            `Description: ${compactField(control.description, 320) || "N/A"}`,
            `Test procedure: ${compactField(control.testProcedures, 420) || "N/A"}`,
            `Expected result: ${compactField(control.expectedResults, 260) || "N/A"}`,
            control.remediationProcedure ? `Remediation: ${compactField(control.remediationProcedure, 260)}` : null,
        ].filter(Boolean).join("\n");

        if (usedChars + block.length > maxChars) break;
        blocks.push(block);
        usedChars += block.length + 8;
    }

    return blocks.join("\n\n---\n\n");
}

function buildComplianceControlEvidence(controls: SCSEMControlEvidence[], maxChars: number): string {
    const blocks: string[] = [];
    let usedChars = 0;

    for (const control of controls) {
        const block = [
            `SCSEM Test ID: ${control.testId} | Sheet: ${control.sourceSheet || "unknown"}`,
            `NIST: ${control.nistId || "N/A"} | Control: ${compactField(control.nistControlName, 100) || "N/A"} | Criticality: ${control.criticality || "N/A"}`,
            `Title: ${compactField(control.sectionTitle, 100) || "N/A"}`,
            `Description: ${compactField(control.description, 140) || "N/A"}`,
            `Test procedure: ${compactField(control.testProcedures, 190) || "N/A"}`,
            `Expected result: ${compactField(control.expectedResults, 120) || "N/A"}`,
            control.remediationProcedure
                ? `Remediation: ${compactField(control.remediationProcedure, 90)}`
                : null,
        ].filter(Boolean).join("\n");

        if (usedChars + block.length > maxChars) break;
        blocks.push(block);
        usedChars += block.length + 8;
    }

    return blocks.join("\n\n---\n\n");
}

const ADJACENT_BASE_TERMS = [
    "access",
    "account",
    "admin",
    "administrator",
    "audit",
    "authentication",
    "authorization",
    "backup",
    "certificate",
    "configuration",
    "credential",
    "cryptographic",
    "default",
    "encrypt",
    "encryption",
    "logging",
    "management",
    "monitor",
    "password",
    "patch",
    "privilege",
    "remote",
    "secure",
    "session",
    "tls",
    "update",
];

function adjacentCategoryTerms(category: string): string[] {
    const normalized = category.toLowerCase();
    if (normalized.includes("network")) {
        return [
            "aaa",
            "radius",
            "tacacs",
            "ssh",
            "snmp",
            "syslog",
            "ntp",
            "management",
            "banner",
            "firmware",
            "configuration",
            "access list",
            "logging",
        ];
    }
    if (normalized.includes("web")) {
        return [
            "tls",
            "ssl",
            "certificate",
            "directory",
            "headers",
            "logging",
            "error",
            "authentication",
            "modules",
            "request",
            "timeout",
            "session",
            "server tokens",
        ];
    }
    if (normalized.includes("application")) {
        return [
            "authentication",
            "session",
            "database",
            "audit",
            "logging",
            "encryption",
            "service account",
            "privilege",
            "connection",
            "password",
            "tls",
        ];
    }
    return [];
}

function adjacentRecommendationScore(recommendation: CISBenchmarkRecommendation, category: string): number {
    const title = `${recommendation.title || ""} ${recommendation.section || ""}`.toLowerCase();
    const body = [
        recommendation.description,
        recommendation.rationale,
        recommendation.audit,
        recommendation.remediation,
        recommendation.defaultValue,
    ].filter(Boolean).join(" ").toLowerCase();
    const terms = [...ADJACENT_BASE_TERMS, ...adjacentCategoryTerms(category)];
    let score = 0;

    for (const term of terms) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`\\b${escaped.replace(/\\ /g, "\\s+")}\\b`, "i");
        if (pattern.test(title)) score += 4;
        if (pattern.test(body)) score += 1;
    }

    if (/deprecated|obsolete|sample|example|demo/i.test(title)) score -= 4;
    if (/level\s*1/i.test(recommendation.profile)) score += 1;
    if ((recommendation.audit || recommendation.remediation || recommendation.description) && recommendation.title) score += 1;
    return score;
}

function buildAdjacentRecommendationCandidates(
    adjacentSources: ResolvedBenchmarkSource[],
    maxTotal = 28
): AnalysisAdjacentCandidate[] {
    const candidates: AnalysisAdjacentCandidate[] = [];
    const seen = new Set<string>();

    for (const source of adjacentSources) {
        const sourceCandidates = source.selectedProfile.recommendations
            .map((recommendation) => ({
                recommendation,
                score: adjacentRecommendationScore(recommendation, source.adjacentCategory || ""),
            }))
            .filter(({ recommendation, score }) => score > 0 && Boolean(recommendation.title))
            .sort((a, b) => b.score - a.score)
            .slice(0, 8);

        for (const { recommendation, score } of sourceCandidates) {
            const dedupeKey = [
                source.kind,
                source.downloaded.snapshot.workbenchId,
                recommendation.recommendation,
                recommendation.title,
            ].join(":").toLowerCase();
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            candidates.push({
                sourceKind: source.kind,
                sourceRelationship: "adjacent",
                sourceLabel: sourceLabel(source),
                sourceProfile: source.selectedProfile.profile,
                sourceWorkbenchId: source.downloaded.snapshot.workbenchId,
                sourceBenchmarkTitle: source.downloaded.snapshot.benchmarkTitle,
                adjacentCategory: source.adjacentCategory || "Adjacent hardening patterns",
                adjacentRationale: source.adjacentRationale || "Adjacent benchmark evidence selected for human review.",
                recommendation,
                score,
            });
        }
    }

    return candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, maxTotal);
}

function buildAdjacentBenchmarkEvidence(candidates: AnalysisAdjacentCandidate[], maxChars: number): string {
    const blocks: string[] = [];
    let usedChars = 0;

    for (const candidate of candidates) {
        const block = [
            `Evidence tier: adjacent benchmark pattern, not a direct SCSEM equivalent`,
            `Adjacent category: ${candidate.adjacentCategory}`,
            `Applicability guardrail: ${candidate.adjacentRationale}`,
            recommendationEvidenceSummary(candidate.recommendation, candidate.sourceLabel),
        ].join("\n");

        if (usedChars + block.length > maxChars) break;
        blocks.push(block);
        usedChars += block.length + 8;
    }

    return blocks.join("\n\n---\n\n");
}

function adjacentSourceSummary(sources: ResolvedBenchmarkSource[]): string {
    if (sources.length === 0) return "- No adjacent benchmark sources were selected.";

    return sources.map((source) => [
        `- Relationship: adjacent, not direct equivalent`,
        `  Category: ${source.adjacentCategory || "Adjacent hardening patterns"}`,
        `  Rationale: ${source.adjacentRationale || "Adjacent benchmark evidence selected for human review."}`,
        `  Kind: ${source.kind}`,
        `  Title: ${source.downloaded.snapshot.benchmarkTitle}`,
        `  WorkBench ID: ${source.downloaded.snapshot.workbenchId}`,
        `  Version: ${source.downloaded.snapshot.benchmarkVersion}`,
        `  Release date: ${source.downloaded.snapshot.releaseDate.toISOString().slice(0, 10)}`,
        `  Selected profile: ${source.selectedProfile.profile}`,
        `  Query: ${source.matchQuery}`,
    ].join("\n")).join("\n");
}

function markAdjacentChangesForReview(changes: any[], pub1075Version: string): any[] {
    return changes.map((change) => ({
        ...change,
        confidence: "needs_review",
        sourceEvidence: {
            ...(change.sourceEvidence || {}),
            evidenceTier: "adjacent",
            sourceRelationship: "adjacent",
            pub1075Version,
        },
    }));
}

function chooseFallbackField(
    control: SCSEMControlEvidence,
    recommendation: CISBenchmarkRecommendation
): { field: string; currentValue: string; proposedValue: string } | null {
    const choices = [
        { field: "testProcedures", currentValue: control.testProcedures || "", proposedValue: recommendation.audit || "" },
        { field: "expectedResults", currentValue: control.expectedResults || "", proposedValue: isUsableBenchmarkDefaultValue(recommendation.defaultValue) ? recommendation.defaultValue || "" : "" },
        { field: "remediationProcedure", currentValue: control.remediationProcedure || "", proposedValue: recommendation.remediation || "" },
        { field: "description", currentValue: control.description || "", proposedValue: recommendation.description || "" },
        { field: "rationale", currentValue: control.rationale || "", proposedValue: recommendation.rationale || "" },
        { field: "impact", currentValue: control.impact || "", proposedValue: recommendation.impact || "" },
    ];

    return choices.find((choice) => choice.proposedValue.trim().length > 0 &&
        isMaterialTextDelta(choice.currentValue, choice.proposedValue)) || null;
}

function interleaveBenchmarkAuthorities<T extends { sourceKind: ResolvedBenchmarkKind }>(candidates: T[]): T[] {
    const buckets = new Map<ResolvedBenchmarkKind, T[]>([
        ["CIS", candidates.filter((candidate) => candidate.sourceKind === "CIS")],
        ["CIS_STIG", candidates.filter((candidate) => candidate.sourceKind === "CIS_STIG")],
    ]);
    const indexes = new Map<ResolvedBenchmarkKind, number>([["CIS", 0], ["CIS_STIG", 0]]);
    const output: T[] = [];
    while (output.length < candidates.length) {
        let added = false;
        for (const kind of ["CIS", "CIS_STIG"] as const) {
            const index = indexes.get(kind) || 0;
            const candidate = buckets.get(kind)?.[index];
            if (!candidate) continue;
            output.push(candidate);
            indexes.set(kind, index + 1);
            added = true;
        }
        if (!added) break;
    }
    return output;
}

function buildFallbackPayload({
    technology,
    pub1075,
    fallbackReason,
    updateCandidates,
    newControlCandidates,
}: {
    technology: string;
    pub1075: { version: string; nist?: { version: string } };
    fallbackReason?: string;
    updateCandidates: AnalysisUpdateCandidate[];
    newControlCandidates: AnalysisNewCandidate[];
}) {
    const fallbackUpdates = interleaveBenchmarkAuthorities(
        [...updateCandidates].sort((a, b) => b.score - a.score)
    );
    const fallbackNewControls = interleaveBenchmarkAuthorities([...newControlCandidates]);

    const changes: any[] = [];
    let examinedCandidateCount = 0;
    const maxUpdateChanges = fallbackNewControls.length > 0
        ? Math.max(1, Math.floor(MAX_UPDATER_CHANGES * 0.7))
        : MAX_UPDATER_CHANGES;

    for (const candidate of fallbackUpdates) {
        if (changes.length >= maxUpdateChanges) break;
        examinedCandidateCount++;
        const selectedField = chooseFallbackField(candidate.control, candidate.recommendation);
        if (!selectedField) continue;

        changes.push({
            action: "updateField",
            testId: candidate.control.testId,
            targetSheet: candidate.control.sourceSheet,
            field: selectedField.field,
            currentValue: selectedField.currentValue.slice(0, 1200),
            proposedValue: selectedField.proposedValue,
            reason: `${benchmarkKindLabel(candidate.sourceKind)} ${candidate.recommendation.recommendation} (${candidate.sourceProfile}, WB ${candidate.sourceWorkbenchId}) materially differs from the uploaded SCSEM row. The updater retained this direct benchmark delta for strictest-control comparison with applicable Publication 1075 and STIG evidence; NIST ${pub1075.nist?.version || "SP 800-53"} is mapping and assessment evidence only.`,
            confidence: "needs_review",
            sourceEvidence: sourceEvidence(candidate, pub1075.version, pub1075.nist?.version),
        });
    }

    for (const candidate of fallbackNewControls) {
        if (changes.length >= MAX_UPDATER_CHANGES) break;
        examinedCandidateCount++;
        const recommendation = candidate.recommendation;
        changes.push({
            action: "addControl",
            testId: `NEW-${benchmarkKindLabel(candidate.sourceKind)}-${candidate.sourceWorkbenchId}-${safeRecommendationId(recommendation.recommendation)}`,
            targetSheet: candidate.targetSheet,
            field: "newControl",
            currentValue: "Not present in current SCSEM",
            proposedValue: `${benchmarkKindLabel(candidate.sourceKind)} ${recommendation.recommendation}: ${recommendation.title}`,
            reason: `${benchmarkKindLabel(candidate.sourceKind)} ${recommendation.recommendation} appears in ${candidate.sourceBenchmarkTitle} (${candidate.sourceProfile}, WB ${candidate.sourceWorkbenchId}) but was not mapped in the uploaded SCSEM. It is a reviewer-gated directly applicable benchmark candidate that must be compared with Publication 1075 and STIG evidence so the strictest applicable control is retained.`,
            confidence: "needs_review",
            newControl: {
                nistId: null,
                nistControlName: null,
                testMethod: recommendation.assessmentStatus || "Manual",
                sectionTitle: recommendation.title,
                description: recommendation.description,
                testProcedures: recommendation.audit,
                expectedResults: recommendation.defaultValue || recommendation.audit,
                findingStatement:
                    `The expected result was not met for ${recommendation.title}.`,
                criticality: "Moderate",
                issueCode: null,
                cisBenchmarkRef: recommendation.section,
                recommendationNum: recommendation.recommendation,
                rationale: recommendation.rationale,
                impact: recommendation.impact,
                remediationProcedure: recommendation.remediation,
            },
            sourceEvidence: sourceEvidence(candidate, pub1075.version, pub1075.nist?.version),
        });
    }

    return {
        summary: `Generated deterministic CIS/CIS-STIG benchmark proposals for ${technology}${fallbackReason ? ` because ${fallbackReason}` : ""}. Each item is marked needs_review and preserved for strictest-control comparison with applicable public STIG and Publication 1075 evidence.`,
        changes,
        examinedCandidateCount,
    };
}

function partitionComplianceControls(controls: SCSEMControlEvidence[]): SCSEMControlEvidence[][] {
    const eligibleBySheet = new Map<string, SCSEMControlEvidence[]>();
    for (const control of controls.filter((candidate) => Boolean(normalizeNistControlId(candidate.nistId)))) {
        const sheetName = control.sourceSheet || "unknown";
        eligibleBySheet.set(sheetName, [...(eligibleBySheet.get(sheetName) || []), control]);
    }
    for (const sheetControls of eligibleBySheet.values()) {
        sheetControls.sort((left, right) => {
            const priority = pub1075ReviewPriority(right) - pub1075ReviewPriority(left);
            return priority || left.testId.localeCompare(right.testId, undefined, { numeric: true });
        });
    }

    // Round-robin sheets so a large general-controls tab cannot crowd out the
    // product/version-specific tabs before the bounded interactive limit.
    const eligible: SCSEMControlEvidence[] = [];
    const sheetEntries = [...eligibleBySheet.entries()];
    const indexes = new Map(sheetEntries.map(([sheetName]) => [sheetName, 0]));
    let remaining = sheetEntries.reduce((total, [, sheetControls]) => total + sheetControls.length, 0);
    while (remaining > 0) {
        for (const [sheetName, sheetControls] of sheetEntries) {
            const index = indexes.get(sheetName) || 0;
            const control = sheetControls[index];
            if (!control) continue;
            eligible.push(control);
            indexes.set(sheetName, index + 1);
            remaining--;
        }
    }
    const batches: SCSEMControlEvidence[][] = [];
    let current: SCSEMControlEvidence[] = [];
    let currentChars = 0;
    let currentControlFamilies = new Set<string>();

    for (const control of eligible) {
        const normalizedId = normalizeNistControlId(control.nistId) || "";
        const baseControlId = normalizedId.replace(/\(\d+\)$/, "");
        const wouldAddControlFamily = !currentControlFamilies.has(baseControlId);
        const estimatedChars = buildComplianceControlEvidence([control], Number.MAX_SAFE_INTEGER).length + 8;
        if (
            current.length > 0 &&
            (current.length >= COMPLIANCE_BATCH_CONTROL_LIMIT ||
                currentChars + estimatedChars > COMPLIANCE_CONTROL_EVIDENCE_LIMIT ||
                (wouldAddControlFamily &&
                    currentControlFamilies.size >= COMPLIANCE_BATCH_UNIQUE_CONTROL_LIMIT))
        ) {
            batches.push(current);
            current = [];
            currentChars = 0;
            currentControlFamilies = new Set<string>();
        }
        current.push(control);
        currentChars += estimatedChars;
        currentControlFamilies.add(baseControlId);
    }

    if (current.length > 0) batches.push(current);
    return batches;
}

async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    async function runWorker() {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await worker(items[index], index);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
    );
    return results;
}

function annotateComplianceChanges(
    changes: any[],
    controls: SCSEMControlEvidence[],
    evidence: ComplianceEvidence
): any[] {
    const pubIds = new Set(evidence.pub1075.excerptedControlIds);
    const nistIds = new Set(evidence.nist.excerptedControlIds);

    return changes.flatMap((change) => {
        const requestedSheet = typeof change.targetSheet === "string" && change.targetSheet.trim()
            ? change.targetSheet.trim()
            : null;
        const matches = controls.filter((control) =>
            control.testId === change.testId &&
            (!requestedSheet || control.sourceSheet === requestedSheet)
        );
        if (matches.length !== 1) return [];
        const control = matches[0];
        const controlId = normalizeNistControlId(control?.nistId);
        const usesPub1075 = Boolean(controlId && pubIds.has(controlId));
        const usesNistFallback = Boolean(controlId && !usesPub1075 && nistIds.has(controlId));
        if (!controlId || (!usesPub1075 && !usesNistFallback)) return [];
        const complianceSource = usesPub1075
            ? "IRS Publication 1075"
            : "NIST SP 800-53 fallback";

        return {
            ...change,
            targetSheet: control.sourceSheet,
            currentValue: String(
                (control as unknown as Record<string, unknown>)[String(change.field || "")] || ""
            ),
            reason:
                `Reviewer-gated draft for ${control.sourceSheet || "the resolved sheet"}!${control.testId} ` +
                `using the exact ${complianceSource} mapping ${controlId}. Compare the proposed replacement ` +
                "with the pinned source excerpt before approval; model-generated wording is not itself evidence.",
            confidence: "needs_review",
            sourceEvidence: {
                evidenceTier: "compliance",
                complianceSource,
                sourceSheet: control.sourceSheet,
                pub1075Version: evidence.pub1075.version,
                nistVersion: evidence.nist.version,
                pub1075ControlId: usesPub1075 ? controlId : null,
                nistFallbackControlId: usesNistFallback ? controlId : null,
                pub1075Only: usesPub1075,
                nistFallback: usesNistFallback,
            },
        };
    });
}

function deterministicComplianceGapChanges(
    controls: SCSEMControlEvidence[],
    evidence: ComplianceEvidence,
    maxChanges = 2
): any[] {
    const pubIds = new Set(evidence.pub1075.excerptedControlIds);
    const nistIds = new Set(evidence.nist.excerptedControlIds);
    const pubBlocks = evidence.pub1075.excerpts.split(/\n\n---\n\n/).filter(Boolean);
    const nistBlocks = evidence.nist.excerpts.split(/\n\n---\n\n/).filter(Boolean);
    const changes: any[] = [];

    for (const control of [...controls].sort((left, right) =>
        pub1075ReviewPriority(right) - pub1075ReviewPriority(left)
    )) {
        if (changes.length >= maxChanges) break;
        const controlId = normalizeNistControlId(control.nistId);
        if (!controlId) continue;
        const baseId = controlId.replace(/\(\d+\)$/, "");
        const usesPub1075 = pubIds.has(controlId);
        const usesNistFallback = !usesPub1075 && nistIds.has(controlId);
        const blocks = usesPub1075 ? pubBlocks : usesNistFallback ? nistBlocks : [];
        const block = blocks.find((candidate) => {
            const header = candidate.split("\n").slice(0, 2).join(" ");
            return header.includes(controlId) || header.includes(baseId);
        });
        if (!block) continue;

        const requirement = compactField(
            block.replace(/^Requested controls:[^\n]*\n/i, ""),
            1200
        );
        if (requirement.length < 40) continue;
        const sourceLabel = usesPub1075 ? "IRS Publication 1075" : "NIST SP 800-53 fallback";
        const gap = !control.description || control.description.trim().length < 12
            ? {
                field: "description",
                currentValue: control.description || "",
                proposedValue: requirement,
            }
            : !control.testProcedures || control.testProcedures.trim().length < 12
                ? {
                    field: "testProcedures",
                    currentValue: control.testProcedures || "",
                    proposedValue: `Examine applicable policies, configurations, and implementation evidence to verify this requirement: ${requirement}`,
                }
                : !control.expectedResults || control.expectedResults.trim().length < 12
                    ? {
                        field: "expectedResults",
                        currentValue: control.expectedResults || "",
                        proposedValue: `Evidence demonstrates that the following requirement is implemented: ${requirement}`,
                    }
                    : null;
        if (!gap) continue;

        changes.push({
            action: "updateField",
            testId: control.testId,
            targetSheet: control.sourceSheet,
            ...gap,
            reason: `${gap.field} is empty or non-substantive. This reviewer-gated fallback uses the mapped ${sourceLabel} requirement verbatim or as an explicitly labeled verification objective because AI reasoning was unavailable.`,
            confidence: "needs_review",
            sourceEvidence: {
                evidenceTier: "compliance",
                complianceSource: sourceLabel,
                sourceSheet: control.sourceSheet,
                pub1075Version: evidence.pub1075.version,
                nistVersion: evidence.nist.version,
                pub1075ControlId: usesPub1075 ? controlId : null,
                nistFallbackControlId: usesNistFallback ? controlId : null,
                deterministicFallback: true,
            },
        });
    }
    return changes;
}

function buildPublicDisaProposalEvidence(changes: any[], maxChars = 18000): {
    text: string;
    includedCount: number;
    totalCount: number;
    complete: boolean;
} {
    const blocks: string[] = [];
    let used = 0;
    for (const change of changes) {
        const evidence = change.sourceEvidence || {};
        const block = [
            `Target: ${change.targetSheet || evidence.sourceSheet || "unknown"}!${change.testId || "new control"} (${change.field || "newControl"})`,
            `DISA benchmark: ${evidence.stigBenchmarkId || evidence.sourceTitle || "unknown"}`,
            `DISA rule: ${evidence.stigVersion || evidence.stigRuleId || "unknown"}`,
            `NIST mappings: ${Array.isArray(evidence.nistControlIds) ? evidence.nistControlIds.join(", ") : evidence.nistControlIds || "none"}`,
            `Proposed requirement: ${change.proposedValue || change.newControl?.expectedResults || change.newControl?.description || ""}`,
            change.newControl?.testProcedures ? `Test procedure: ${change.newControl.testProcedures}` : null,
        ].filter(Boolean).join("\n");
        if (used + block.length > maxChars) break;
        blocks.push(block);
        used += block.length + 8;
    }
    return {
        text: blocks.join("\n\n---\n\n"),
        includedCount: blocks.length,
        totalCount: changes.length,
        complete: blocks.length === changes.length,
    };
}

function dedupeProposedChanges(changes: any[]): any[] {
    return annotateSCSEMStrictnessConflicts(
        dedupeSCSEMProposalsPreservingAuthorities(changes)
    );
}

function addUnambiguousTargetSheets(
    changes: any[],
    controls: SCSEMControlEvidence[]
): any[] {
    const sheetsByTestId = new Map<string, Set<string>>();
    const knownSheets = new Set<string>();
    for (const control of controls) {
        if (!control.sourceSheet) continue;
        knownSheets.add(control.sourceSheet);
        if (!sheetsByTestId.has(control.testId)) sheetsByTestId.set(control.testId, new Set());
        sheetsByTestId.get(control.testId)?.add(control.sourceSheet);
    }

    return changes.map((change) => {
        if (change.action === "addControl") {
            return change.targetSheet && knownSheets.has(change.targetSheet)
                ? change
                : { ...change, targetSheet: undefined };
        }
        const sheets = [...(sheetsByTestId.get(change.testId) || [])];
        if (change.targetSheet && sheets.includes(change.targetSheet)) return change;
        return {
            ...change,
            targetSheet: sheets.length === 1 ? sheets[0] : undefined,
        };
    });
}

async function buildCompliancePayload({
    technology,
    fileName,
    parsed,
    controls,
    pub1075: complianceOverview,
}: {
    technology: string;
    fileName: string;
    parsed: ParsedSCSEM;
    controls: SCSEMControlEvidence[];
    pub1075: ComplianceEvidence;
}) {
    const batches = partitionComplianceControls(controls);
    const nistMappedRowCount = controls.filter((control) =>
        Boolean(normalizeNistControlId(control.nistId))
    ).length;
    if (batches.length === 0) {
        return {
            summary:
                `Compliance review found no normalized NIST control identifiers in the ${technology} SCSEM rows. ` +
                "SkyShield did not invent document-section test cases; the unmapped rows require reviewer mapping before Publication 1075 or NIST can support a row-level update.",
            changes: [],
            batchCount: 0,
            completedBatchCount: 0,
            reviewedRowCount: 0,
            nistMappedRowCount: 0,
            unmappedRowCount: controls.length,
        };
    }

    const batchResults = await mapWithConcurrency(
        batches,
        COMPLIANCE_BATCH_CONCURRENCY,
        async (batch, batchIndex) => {
            const promptBudget = Math.max(24000, AI_PROMPT_CHAR_LIMIT - 12000);
            const controlEvidence = buildComplianceControlEvidence(
                batch,
                COMPLIANCE_CONTROL_EVIDENCE_LIMIT
            );
            const complianceEvidence = extractComplianceEvidence(
                batch.map((control) => control.nistId),
                {
                    maxTotalChars: Math.min(
                        40000,
                        Math.max(10000, promptBudget - controlEvidence.length)
                    ),
                }
            );
            const missingPromptEvidence = missingCompliancePromptEvidenceControlIds({
                requestedControlIds: complianceEvidence.requestedControlIds,
                pub1075ExcerptedControlIds: complianceEvidence.pub1075.excerptedControlIds,
                nistExcerptedControlIds: complianceEvidence.nist.excerptedControlIds,
            });
            if (!complianceEvidence.excerpts || missingPromptEvidence.length > 0) {
                return {
                    summary: missingPromptEvidence.length > 0
                        ? `Batch ${batchIndex + 1} omitted prompt evidence for ${missingPromptEvidence.length} mapped control identifier(s) and was marked incomplete.`
                        : `Batch ${batchIndex + 1} had no mappable Pub 1075 or NIST SP 800-53 evidence.`,
                    changes: deterministicComplianceGapChanges(batch, complianceEvidence),
                    analyzed: false,
                };
            }

            const prompt = `You are an IRS Safeguards SCSEM update analyst. Perform the primary compliance review using only the uploaded SCSEM rows and the authoritative evidence below.

Decision policy:
- This bounded step reviews the Publication 1075/NIST mapping lane only; final all-source strictness resolution occurs after direct CIS and STIG lanes complete.
- Use Publication 1075 for an existing row when an exact mapped excerpt is supplied.
- NIST SP 800-53/800-53A is mapping and assessment evidence only where this package explicitly says no Publication 1075 section was found.
- Existing IRS SCSEM rows remain the base source of truth.
- Propose an update only when the current row is materially incomplete, materially weaker, or materially inconsistent with the applicable mapped excerpt for the same control.
- Do not propose formatting-only, grammar-only, casing-only, numbering-only, or equivalent-wording changes.
- Do not rewrite a row merely because the authority uses different phrasing.
- No CIS or STIG evidence appears in this bounded prompt. Do not infer benchmark requirements here; later lanes may supersede this proposal with a stricter directly applicable benchmark control.
- Propose updateField changes only. Missing-control analysis requires workbook-wide applicability evidence and is outside this bounded row batch.
- Mark confidence "needs_review" unless the gap is direct and unambiguous.

Uploaded SCSEM:
- File name: ${fileName}
- Inferred technology: ${technology}
- Dashboard subject: ${parsed.metadata.subject || "unknown"}
- SCSEM version: ${parsed.metadata.version || "unknown"}
- Effective date: ${parsed.metadata.effectiveDate || "unknown"}
- Parsed controls: ${controls.length}
- Compliance batch: ${batchIndex + 1} of ${batches.length} (${batch.length} rows)

Compliance sources:
- IRS Publication 1075 version: ${complianceEvidence.pub1075.version}
- NIST SP 800-53 fallback version: ${complianceEvidence.nist.version}
- Pub 1075-covered IDs with excerpts in this prompt: ${complianceEvidence.pub1075.excerptedControlIds.join(", ") || "None"}
- NIST-fallback IDs with excerpts in this prompt: ${complianceEvidence.nist.excerptedControlIds.join(", ") || "None"}

SCSEM ROWS FOR COMPLIANCE REVIEW:
${controlEvidence || "No SCSEM row text was available."}

COMPLIANCE EVIDENCE — PUB 1075 FIRST, NIST FALLBACK ONLY:
${complianceEvidence.excerpts}

Return ONLY valid JSON:
{
  "summary": "1-2 sentence evidence-based summary of this bounded compliance batch.",
  "changes": [
    {
      "action": "updateField",
      "testId": "exact existing SCSEM Test ID",
      "targetSheet": "exact Sheet named with this SCSEM row",
      "field": "testProcedures|expectedResults|remediationProcedure|description|rationale|impact|sectionTitle|findingStatement",
      "currentValue": "brief current value summary",
      "proposedValue": "complete replacement text for that field",
      "reason": "specific reason citing the Publication 1075 requirement, or the NIST mapping/assessment evidence only when no Publication 1075 section was supplied",
      "confidence": "high|medium|needs_review",
      "sourceEvidence": {
        "cisRecommendation": null,
        "cisProfile": null,
        "stigRecommendation": null,
        "stigProfile": null,
        "sourceWorkbenchId": null,
        "sourceBenchmarkTitle": null,
        "pub1075Version": "${complianceEvidence.pub1075.version}",
        "nistVersion": "${complianceEvidence.nist.version}",
        "complianceSource": "IRS Publication 1075|NIST SP 800-53 fallback"
      }
    }
  ]
}

Rules:
- Include up to ${MAX_COMPLIANCE_CHANGES_PER_BATCH} changes for this batch.
- Use only Test IDs listed in SCSEM ROWS FOR COMPLIANCE REVIEW.
- Do not include changes that only restate the same control in different words.
- Do not claim Pub 1075 or NIST says something unless that exact source excerpt is present above.
- Never use NIST mapping/assessment evidence as an independent authority for an ID with a supplied Publication 1075 excerpt.
- Do not include markdown fences.`;

            if (prompt.length > AI_PROMPT_CHAR_LIMIT) {
                return {
                    summary: `Batch ${batchIndex + 1} exceeded the configured prompt limit after bounded evidence extraction.`,
                    changes: deterministicComplianceGapChanges(batch, complianceEvidence),
                    analyzed: false,
                };
            }

            if (!hasConfiguredBifrostApiKey(process.env.BIFROST_API_KEY)) {
                return {
                    summary: `Batch ${batchIndex + 1} was scanned deterministically, but AI comparison was unavailable because no approved model credential was configured.`,
                    changes: deterministicComplianceGapChanges(batch, complianceEvidence),
                    analyzed: false,
                };
            }

            const abortController = new AbortController();
            const timeout = setTimeout(() => abortController.abort(), AI_TIMEOUT_MS);
            try {
                const responseText = await generateBifrostText({
                    model: getConfiguredBifrostModel("BIFROST_SCSEM_MODEL"),
                    maxTokens: 4500,
                    temperature: 0.1,
                    system: "You generate precise JSON SCSEM recommendations for existing mapped rows using Publication 1075 requirements and NIST SP 800-53/800-53A mapping and assessment evidence. NIST does not independently create technology controls; final strictness is resolved with direct CIS and STIG lanes.",
                    prompt,
                    signal: abortController.signal,
                });
                const payload = parseJsonResponse(responseText);
                return {
                    summary: String(payload.summary || ""),
                    changes: annotateComplianceChanges(
                        (payload.changes || []).slice(0, MAX_COMPLIANCE_CHANGES_PER_BATCH),
                        batch,
                        complianceEvidence
                    ),
                    analyzed: true,
                };
            } catch (error) {
                console.warn(`SCSEM updater compliance batch ${batchIndex + 1} failed.`, error);
                return {
                    summary: `Batch ${batchIndex + 1} could not produce safe AI recommendations; only deterministic empty-field compliance gaps were retained for review.`,
                    changes: deterministicComplianceGapChanges(batch, complianceEvidence),
                    analyzed: false,
                };
            } finally {
                clearTimeout(timeout);
            }
        }
    );

    const completedBatchCount = batchResults.filter((result) => result.analyzed).length;
    const reviewedRowCount = batches.reduce((total, batch) => total + batch.length, 0);
    // Publication 1075 and NIST are used to strengthen existing mapped rows.
    // Do not turn every document section that lacks an exact workbook mapping
    // into a new technology test case; direct CIS/STIG evidence or an explicit
    // reviewer applicability decision is required before proposing a new row.
    const changes = dedupeProposedChanges(
        batchResults.flatMap((result) => result.changes)
    );
    const coverage = [
        `${batches.length} bounded batch(es)`,
        `${reviewedRowCount} NIST-mapped row(s) distributed across version/provider tabs`,
        `${completedBatchCount} completed with AI reasoning`,
        `${complianceOverview.pub1075.controlIds.length} control ID(s) mapped to Pub 1075`,
        `${complianceOverview.nist.controlIds.length} control ID(s) mapped to NIST evidence`,
        "0 document-section-only new-control candidates",
    ].join(", ");

    return {
        summary: `Publication 1075/NIST-mapping review for ${technology}: ${coverage}. Generated ${changes.length} reviewer-gated existing-row proposal(s) for later strictest-control comparison with directly applicable CIS and STIG evidence.`,
        changes,
        batchCount: batches.length,
        completedBatchCount,
        reviewedRowCount,
        nistMappedRowCount,
        unmappedRowCount: controls.length - nistMappedRowCount,
    };
}

async function buildAdjacentSourcePayload({
    technology,
    fileName,
    parsed,
    controls,
    pub1075,
    adjacentSources,
    adjacentCandidates,
}: {
    technology: string;
    fileName: string;
    parsed: ParsedSCSEM;
    controls: SCSEMControlEvidence[];
    pub1075: ComplianceEvidence;
    adjacentSources: ResolvedBenchmarkSource[];
    adjacentCandidates: AnalysisAdjacentCandidate[];
}) {
    const controlEvidence = buildPub1075ControlEvidence(controls, 18000);
    const adjacentEvidence = buildAdjacentBenchmarkEvidence(adjacentCandidates, 24000);
    const prompt = `You are an IRS Safeguards SCSEM update analyst. This uploaded workbook has no direct CIS Benchmark or CIS-STIG workbook from CIS WorkBench. Perform an adjacent-source review using the uploaded SCSEM row text, IRS Publication 1075 excerpts, and explicitly labeled adjacent CIS Benchmark/CIS-STIG patterns below.

Decision policy:
- IRS Publication 1075 is the first and governing compliance source.
- NIST SP 800-53 is fallback compliance evidence only where no Pub 1075 section was found.
- Existing IRS SCSEM rows remain the base source of truth.
- Adjacent benchmarks are NOT direct equivalents. They are reasoning evidence only.
- Use adjacent evidence only when it expresses a technology-neutral hardening pattern that reasonably applies to the uploaded SCSEM's control intent.
- Propose an update only when the current SCSEM row appears materially incomplete, materially weaker, or materially inconsistent with Pub 1075 and the adjacent pattern helps explain a concrete reviewer-worthy improvement.
- Do not copy vendor-specific commands, file paths, registry keys, product names, service names, configuration syntax, or exact platform settings into a generic SCSEM unless the uploaded SCSEM already names that same platform.
- Do not propose formatting-only, grammar-only, casing-only, numbering-only, or equivalent-wording changes.
- Prefer updateField changes to existing rows. Use addControl only when Pub 1075 clearly supports the control intent and no uploaded row covers that intent.
- Every change from adjacent evidence must be marked confidence "needs_review".
- Every change must include sourceEvidence.evidenceTier = "adjacent", sourceEvidence.sourceRelationship = "adjacent", and a short sourceEvidence.applicabilityRationale.

Uploaded SCSEM:
- File name: ${fileName}
- Inferred technology: ${technology}
- Dashboard subject: ${parsed.metadata.subject || "unknown"}
- SCSEM version: ${parsed.metadata.version || "unknown"}
- Effective date: ${parsed.metadata.effectiveDate || "unknown"}
- Parsed controls: ${controls.length}

Adjacent benchmark source summary:
${adjacentSourceSummary(adjacentSources)}

Compliance sources:
- IRS Publication 1075 version: ${pub1075.pub1075.version}
- NIST SP 800-53 fallback version: ${pub1075.nist.version}

SCSEM ROWS FOR REVIEW:
${controlEvidence || "No SCSEM row text was available."}

ADJACENT BENCHMARK EVIDENCE:
${adjacentEvidence || "No adjacent benchmark recommendations were selected."}

COMPLIANCE EVIDENCE — PUBLICATION 1075 WITH NIST MAPPING/ASSESSMENT SUPPORT:
${pub1075.excerpts || "No Publication 1075 or NIST mapping/assessment excerpts were found for the referenced controls."}

Return ONLY valid JSON:
{
  "summary": "2-3 sentence evidence-based summary of adjacent-source review coverage and limitations.",
  "changes": [
    {
      "action": "updateField",
      "testId": "exact existing SCSEM Test ID",
      "targetSheet": "exact Sheet named with this SCSEM row",
      "field": "testProcedures|expectedResults|remediationProcedure|description|rationale|impact|sectionTitle|findingStatement",
      "currentValue": "brief current value summary",
      "proposedValue": "complete replacement text for that field",
      "reason": "specific reason citing Pub 1075 and adjacent benchmark pattern; explicitly state this is adjacent-source evidence for reviewer approval",
      "confidence": "needs_review",
      "sourceEvidence": {
        "evidenceTier": "adjacent",
        "sourceRelationship": "adjacent",
        "cisRecommendation": "CIS recommendation number if CIS adjacent evidence applies, otherwise null",
        "cisProfile": "selected CIS profile if CIS adjacent evidence applies, otherwise null",
        "stigRecommendation": "CIS-STIG recommendation number if adjacent CIS-STIG evidence applies, otherwise null",
        "stigProfile": "selected CIS-STIG profile if adjacent CIS-STIG evidence applies, otherwise null",
        "sourceWorkbenchId": "WorkBench ID from the adjacent evidence source",
        "sourceBenchmarkTitle": "adjacent benchmark title",
        "adjacentSourceCategory": "category from the adjacent source summary",
        "applicabilityRationale": "why the adjacent pattern is relevant without claiming direct equivalence",
        "pub1075Version": "${pub1075.pub1075.version}",
        "nistVersion": "${pub1075.nist.version}"
      }
    },
    {
      "action": "addControl",
      "testId": "NEW-ADJACENT-<recommendation>",
      "targetSheet": "best matching existing test-case sheet",
      "field": "newControl",
      "currentValue": "Not present in current SCSEM",
      "proposedValue": "short summary of the new reviewer-only control",
      "reason": "why this adjacent-source pattern is proposed against Pub 1075 and current SCSEM evidence",
      "confidence": "needs_review",
      "newControl": {
        "nistId": null,
        "nistControlName": "best fit if obvious from Pub 1075, otherwise null",
        "testMethod": "Automated|Manual|Interview|Examine|Test",
        "sectionTitle": "SCSEM-ready generic title",
        "description": "SCSEM-ready generic description without vendor-specific commands",
        "testProcedures": "SCSEM-ready generic audit/test procedure without vendor-specific commands",
        "expectedResults": "SCSEM-ready generic expected result",
        "findingStatement": "SCSEM-ready standard failure condition grounded only in the supplied evidence; do not describe an observed agency result",
        "criticality": "Critical|Significant|Moderate|Limited|Informational",
        "issueCode": null,
        "cisBenchmarkRef": "Adjacent CIS Benchmark or CIS-STIG section number",
        "recommendationNum": "Adjacent recommendation number",
        "rationale": "SCSEM-ready rationale",
        "impact": "SCSEM-ready impact",
        "remediationProcedure": "SCSEM-ready remediation"
      },
      "sourceEvidence": {
        "evidenceTier": "adjacent",
        "sourceRelationship": "adjacent",
        "sourceWorkbenchId": "WorkBench ID from the adjacent evidence source",
        "sourceBenchmarkTitle": "adjacent benchmark title",
        "adjacentSourceCategory": "category from the adjacent source summary",
        "applicabilityRationale": "why the adjacent pattern is relevant without claiming direct equivalence",
        "pub1075Version": "${pub1075.pub1075.version}",
        "nistVersion": "${pub1075.nist.version}"
      }
    }
  ]
}

Rules:
- Include up to ${MAX_UPDATER_CHANGES} total changes.
- For updateField, only use Test IDs listed in SCSEM ROWS FOR REVIEW.
- Do not include a change unless a human reviewer could trace it to both Pub 1075/control intent and an adjacent hardening pattern.
- Do not claim any adjacent benchmark is a direct equivalent for ${technology}.
- Treat newControl.findingStatement as canonical template text describing the failed control condition, never as an observed agency response.
- Leave newControl.issueCode null. A reviewer must select an exact code from the uploaded workbook's IRS Issue Code Table before approval; never invent or infer a code outside that table.
- Do not include markdown fences.`;

    const emptyPayload = {
        summary: `No direct CIS Benchmark or CIS-STIG source was found in CIS WorkBench for ${technology}. Adjacent benchmark sources were selected for reviewer-only reasoning, but no adjacent-source changes were generated without AI reasoning.`,
        changes: [],
    };

    if (
        controls.length > AI_CONTROL_LIMIT ||
        prompt.length > AI_PROMPT_CHAR_LIMIT ||
        !pub1075.excerpts ||
        adjacentSources.length === 0 ||
        adjacentCandidates.length === 0
    ) {
        return emptyPayload;
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), AI_TIMEOUT_MS);
    try {
        const responseText = await generateBifrostText({
            model: getConfiguredBifrostModel("BIFROST_SCSEM_MODEL"),
            maxTokens: 9000,
            temperature: 0.12,
            system: "You generate precise JSON SCSEM update recommendations for human review. Adjacent benchmarks are never direct equivalents.",
            prompt,
            signal: abortController.signal,
        });
        const payload = parseJsonResponse(responseText);
        return {
            summary: payload.summary,
            changes: markAdjacentChangesForReview(payload.changes || [], pub1075.pub1075.version),
        };
    } catch (error) {
        console.warn("SCSEM updater adjacent-source analysis failed; returning no adjacent-source changes.", error);
        return emptyPayload;
    } finally {
        clearTimeout(timeout);
    }
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    let user: { id: string; organizationId: string } | null = null;
    let analysisOperationId: string | null = null;

    try {
        const access = await requireScsemSteward();
        if (!access.ok) return access.response;
        user = access.user;

        let requestedScope: SCSEMAnalysisScope = "full";
        try {
            const requestBody = await request.json() as { analysisScope?: unknown };
            if (requestBody.analysisScope !== undefined) {
                if (requestBody.analysisScope !== "full" && requestBody.analysisScope !== "compliance_only") {
                    return NextResponse.json({
                        error: "analysisScope must be full or compliance_only.",
                        code: "INVALID_ANALYSIS_SCOPE",
                    }, { status: 400 });
                }
                requestedScope = requestBody.analysisScope;
            }
        } catch {
            // Backwards compatibility for existing clients that send an empty POST.
        }

        const expectedRevision = requireSCSEMUpdaterExpectedRevision(request);
        const updaterSession = readSCSEMUpdaterSessionForUser(id, user);
        assertSCSEMUpdaterRevision(updaterSession, expectedRevision);

        let cisPreflight: {
            token: string;
            benchmarks: Awaited<ReturnType<typeof fetchAllBenchmarks>>;
            excelFiles: Awaited<ReturnType<typeof fetchAllBenchmarkExcelFiles>>;
        } | null = null;
        if (requestedScope === "full") {
            if (!hasConfiguredCISLicense()) {
                return NextResponse.json({
                    error:
                        "Full-source analysis requires an active CIS SecureSuite license. " +
                        "CIS WorkBench was not searched, so SkyShield did not start a partial analysis under the full-source label.",
                    code: "CIS_LICENSE_NOT_CONFIGURED",
                    requiredConfiguration: "CIS_LICENSE_XML_BASE64 or CIS_LICENSE_XML_PATH",
                }, { status: 424 });
            }
            try {
                const token = await getCISToken();
                const [benchmarks, excelFiles] = await Promise.all([
                    fetchAllBenchmarks(token),
                    fetchAllBenchmarkExcelFiles(token),
                ]);
                if (benchmarks.length === 0 || excelFiles.length === 0) {
                    throw new Error("The CIS WorkBench catalog contained no usable benchmark workbooks.");
                }
                cisPreflight = { token, benchmarks, excelFiles };
            } catch (error: unknown) {
                const failure = scsemBenchmarkLookupFailureDetails(error, "direct");
                console.warn("SCSEM updater full-source preflight failed.", error);
                return NextResponse.json({
                    error:
                        "Full-source analysis requires currently usable CIS WorkBench access. " +
                        "License authentication or catalog validation failed, so no partial analysis was started.",
                    code: failure.code,
                }, { status: 424 });
            }
        }

        updaterSession.analysisScope = requestedScope;
        const sourceCoverageBlockers = updaterSession.audit.structuralAdmission
            ? [updaterSession.audit.structuralAdmission.blocker]
            : [];
        const previousStatus = updaterSession.status;
        const leaseClaim = claimSCSEMAnalysisLease(
            updaterSession,
            createSCSEMAnalysisOperationId()
        );
        if (leaseClaim.outcome === "already_running") {
            return NextResponse.json({
                error: "Analysis is already running for this SCSEM updater session.",
                code: "SCSEM_ANALYSIS_ALREADY_RUNNING",
                retryAfterMs: leaseClaim.retryAfterMs,
                analysisLeaseExpiresAt: leaseClaim.lease.expiresAt,
            }, {
                status: 409,
                headers: {
                    "Retry-After": String(Math.max(1, Math.ceil(leaseClaim.retryAfterMs / 1000))),
                },
            });
        }
        const verifiedUpload = assertSCSEMUpdaterSourceIntegrity(updaterSession);
        analysisOperationId = leaseClaim.lease.operationId;
        await writeSCSEMUpdaterSession(updaterSession, expectedRevision, {
            action: leaseClaim.outcome === "reclaimed"
                ? "SCSEM_UPDATER_ANALYZE_RESTART"
                : "SCSEM_UPDATER_ANALYZE_START",
            analysisOperationId: leaseClaim.lease.operationId,
            affectedPayload: {
                before: {
                    status: previousStatus,
                    analysisLease: leaseClaim.previousLease,
                },
                staleAbort: leaseClaim.outcome === "reclaimed"
                    ? {
                        operationId: leaseClaim.previousLease?.operationId || null,
                        startedAt: leaseClaim.previousLease?.startedAt || null,
                        expiresAt: leaseClaim.previousLease?.expiresAt || null,
                        reason: "analysis_lease_expired",
                    }
                    : null,
                after: {
                    status: updaterSession.status,
                    error: null,
                    analysisScope: requestedScope,
                    analysisLease: leaseClaim.lease,
                    timeoutMs: SCSEM_ANALYSIS_LEASE_TIMEOUT_MS,
                },
                uploadedSourceSha256: verifiedUpload.sha256,
                uploadedSourceSizeBytes: verifiedUpload.sizeBytes,
            },
            ...auditRequestContext(request),
        });

        const originalPath = verifiedUpload.absolutePath;
        const uploadedParsed = parseSCSEMFile(originalPath);
        const officialReference = evaluateOfficialSCSEMReference(
            uploadedParsed,
            updaterSession.inferredTechnology,
            updaterSession.audit.uploadedSha256
        );
        const verifiedBase = officialReference?.selectedAsBase
            ? assertOfficialSCSEMReferenceIntegrity(officialReference)
            : verifiedUpload;
        const parsed = officialReference?.selectedAsBase
            ? parseSCSEMFile(verifiedBase.absolutePath)
            : uploadedParsed;
        const controls = controlsFromParsedSCSEM(parsed);
        if (controls.length === 0) {
            throw new Error("No SCSEM test case controls were found in the uploaded workbook.");
        }

        // Public DISA STIGs are an independent official source and do not
        // require a CIS SecureSuite license. Resolve the pinned public catalog
        // for every full analysis and begin downloading only exact-generation
        // direct sources while the compliance and CIS lanes run.
        const disaCatalogSources = requestedScope === "full"
            ? resolveDisaStigCatalogSources({
                technology: updaterSession.inferredTechnology,
                parsed,
                officialSource: updaterSession.audit.officialSource
                    ? {
                        fileName: updaterSession.audit.officialSource.fileName,
                        sha256: updaterSession.audit.officialSource.sha256,
                    }
                    : null,
            })
            : [];
        const disaDownloadResultsPromise = Promise.all(
            disaCatalogSources
                .filter((source) => source.sourceRelationship === "direct")
                .map(async (source) => {
                    try {
                        return {
                            source,
                            resolved: await downloadAndParseDisaStigSource(source),
                            error: null,
                        };
                    } catch (error) {
                        console.warn("SCSEM updater DISA STIG source failed validation.", error);
                        return {
                            source,
                            resolved: null,
                            error: "Official DISA STIG package could not be downloaded or validated.",
                        };
                    }
                })
        );

        // Start the independent Publication 1075/NIST-mapping lane before benchmark lookup.
        // It resolves independently so source failures remain visible, but its
        // proposals do not erase stricter directly applicable CIS or STIG evidence.
        const compliance = extractComplianceEvidence(
            controls.map((control) => control.nistId),
            {
                // This pass records workbook-wide source coverage without putting
                // full control text into one prompt. Each bounded batch below
                // re-extracts substantive excerpts for AI review.
                maxPubCharsPerControl: 180,
                maxNistCharsPerControl: 180,
                maxTotalChars: Math.max(28000, controls.length * 240),
            }
        );
        const compliancePayloadPromise = buildCompliancePayload({
            technology: updaterSession.inferredTechnology,
            fileName: updaterSession.originalFileName,
            parsed,
            controls,
            pub1075: compliance,
        });

        const cisToken = cisPreflight?.token || "";
        let benchmarkLookupError: string | undefined;
        let benchmarkLookupErrorCode: string | undefined;
        const allBenchmarks = cisPreflight?.benchmarks || [];
        const allExcelFiles = cisPreflight?.excelFiles || [];
        const downloadedBenchmarks = new Map<number, DownloadedBenchmark>();
        let resolvedSources: ResolvedBenchmarkSource[] = [];
        let benchmarkResolutionDiagnostics: BenchmarkQueryResolutionDiagnostic[] = [];

        if (requestedScope === "full" && cisPreflight) {
            const benchmarkResolution = await resolveSCSEMBenchmarkSourcesDetailed({
                token: cisToken,
                technology: updaterSession.inferredTechnology,
                parsed,
                benchmarks: allBenchmarks,
                excelFiles: allExcelFiles,
                downloadedBenchmarks,
            });
            resolvedSources = benchmarkResolution.sources;
            benchmarkResolutionDiagnostics = benchmarkResolution.diagnostics;
            const unavailableDirectQueryCount = benchmarkResolutionDiagnostics.filter((diagnostic) =>
                hasUnavailableApplicableBenchmarkQuery([diagnostic])
            ).length;
            if (unavailableDirectQueryCount > 0) {
                benchmarkLookupError =
                    `${unavailableDirectQueryCount} applicable CIS WorkBench query or workbook could not be downloaded and validated.`;
                benchmarkLookupErrorCode = "CIS_REQUIRED_WORKBOOK_UNAVAILABLE";
            }
        }

        const updateCandidates: AnalysisUpdateCandidate[] = [];
        const newControlCandidates: AnalysisNewCandidate[] = [];
        let totalUpdateCandidateCount = 0;
        let totalNewControlCandidateCount = 0;
        let comparedDirectSourceCount = 0;

        for (const source of resolvedSources) {
            const sheetComparisons = buildSheetScopedComparisonCandidates(
                controls,
                source.selectedProfile.recommendations,
                source.matchedSheets,
                UPDATER_CANDIDATE_LIMITS
            );
            if (sheetComparisons.length === 0) continue;
            comparedDirectSourceCount++;
            const label = sourceLabel(source);

            for (const candidates of sheetComparisons) {
                totalUpdateCandidateCount += candidates.totalUpdateCandidates;
                totalNewControlCandidateCount += candidates.totalNewControlCandidates;
                updateCandidates.push(...candidates.updateCandidates.map((candidate) => ({
                    ...candidate,
                    sourceKind: source.kind,
                    sourceRelationship: "direct" as const,
                    sourceLabel: label,
                    sourceProfile: source.selectedProfile.profile,
                    sourceWorkbenchId: source.downloaded.snapshot.workbenchId,
                    sourceBenchmarkTitle: source.downloaded.snapshot.benchmarkTitle,
                })));
                newControlCandidates.push(...candidates.newControlCandidates.map((recommendation) => ({
                    recommendation,
                    sourceKind: source.kind,
                    sourceRelationship: "direct" as const,
                    sourceLabel: label,
                    sourceProfile: source.selectedProfile.profile,
                    sourceWorkbenchId: source.downloaded.snapshot.workbenchId,
                    sourceBenchmarkTitle: source.downloaded.snapshot.benchmarkTitle,
                    targetSheet: candidates.sheetName,
                })));
            }
        }

        updateCandidates.sort((a, b) => b.score - a.score);

        const candidateNistIds = updateCandidates
            .map((candidate) => candidate.control.nistId)
            .filter(Boolean);
        const pub1075 = extractComplianceEvidence(
            candidateNistIds.length > 0
                ? candidateNistIds
                : controls.map((control) => control.nistId)
        );
        const cisSources = resolvedSources.filter((source) => source.kind === "CIS");
        const stigSources = resolvedSources.filter((source) => source.kind === "CIS_STIG");
        let adjacentSources: ResolvedBenchmarkSource[] = [];
        if (resolvedSources.length === 0 && cisToken && !benchmarkLookupError) {
            try {
                adjacentSources = await resolveAdjacentSCSEMBenchmarkSources({
                    token: cisToken,
                    technology: updaterSession.inferredTechnology,
                    parsed,
                    benchmarks: allBenchmarks,
                    excelFiles: allExcelFiles,
                    downloadedBenchmarks,
                    excludeSources: resolvedSources,
                });
            } catch (error: unknown) {
                const failure = scsemBenchmarkLookupFailureDetails(error, "adjacent");
                benchmarkLookupError = failure.message;
                benchmarkLookupErrorCode = failure.code;
                console.warn(
                    "SCSEM updater adjacent benchmark lookup failed; compliance results remain available.",
                    error
                );
            }
        }
        const cisAuditSources = cisSources.map((source) => auditSource(source.downloaded, source.selectedProfile, {
            sourceKind: source.kind,
            sourceRelationship: source.sourceRelationship || "direct",
            matchedSheets: source.matchedSheets,
            matchQuery: source.matchQuery,
        }));
        const stigAuditSources = stigSources.map((source) => auditSource(source.downloaded, source.selectedProfile, {
            sourceKind: source.kind,
            sourceRelationship: source.sourceRelationship || "direct",
            matchedSheets: source.matchedSheets,
            matchQuery: source.matchQuery,
        }));
        const adjacentAuditSources = adjacentSources.map((source) => auditSource(source.downloaded, source.selectedProfile, {
            sourceKind: source.kind,
            sourceRelationship: "adjacent",
            matchedSheets: source.matchedSheets,
            matchQuery: source.matchQuery,
            adjacentCategory: source.adjacentCategory,
            adjacentRationale: source.adjacentRationale,
        }));
        const disaDownloadResults = await disaDownloadResultsPromise;
        const resolvedDisaStigSources = disaDownloadResults
            .map((result) => result.resolved)
            .filter((source): source is ResolvedDisaStigSource => Boolean(source));
        const disaStigChanges = resolvedDisaStigSources.flatMap((source) => buildDisaStigChanges({
            source,
            controls,
            pub1075Version: compliance.pub1075.version,
            nistVersion: compliance.nist.version,
        }));
        const disaStigAuditSources = disaCatalogSources.map((source) => {
            const result = disaDownloadResults.find((candidate) =>
                candidate.source.catalogEntry.url === source.catalogEntry.url &&
                candidate.source.sourceRelationship === source.sourceRelationship
            );
            const resolved = result?.resolved;
            return {
                sourceKind: "STIG" as const,
                sourceRelationship: source.sourceRelationship,
                sourceTitle: resolved?.parsed.title || source.catalogEntry.name,
                sourceVersion: resolved?.parsed.version || "catalog-only",
                sourceReleaseInfo: resolved?.parsed.releaseInfo ||
                    (source.sourceRelationship === "adjacent"
                        ? "Adjacent source metadata only; content was not used as a direct benchmark."
                        : "The direct source package was not available for comparison."),
                sourceUploadDate: source.catalogEntry.uploadDate,
                sourceUrl: source.catalogEntry.url,
                catalogSourceUrl: source.catalogSourceUrl,
                catalogReviewedAt: source.catalogReviewedAt,
                benchmarkIds: source.benchmarkIds,
                ...(source.expectedPackageSha256 ? { expectedPackageSha256: source.expectedPackageSha256 } : {}),
                ...(resolved ? {
                    packageSha256: resolved.packageSha256,
                    downloadedAt: resolved.downloadedAt,
                    ruleCount: resolved.parsed.rules.length,
                } : {}),
                matchedSheets: source.matchedSheets,
                matchQuery: source.matchQuery,
                ...(result?.error ? { error: result.error } : {}),
            };
        });

        updaterSession.audit = {
            ...updaterSession.audit,
            pub1075Version: compliance.pub1075.version,
            pub1075SourcePath: compliance.pub1075.sourcePath,
            pub1075SourceSha256: compliance.pub1075.sourceSha256,
            nistVersion: compliance.nist.version,
            nistSourcePath: compliance.nist.sourcePath,
            nistSourceUrl: compliance.nist.sourceUrl,
            nistSourceCommit: compliance.nist.sourceCommit,
            nistSourceSha256: compliance.nist.sourceSha256,
            nistSnapshotSha256: compliance.nist.snapshotSha256,
            nistAssessmentControlCount: compliance.nist.assessmentControlIds.length,
            complianceCoverage: {
                requested: compliance.requestedControlIds.length,
                pub1075: compliance.pub1075.controlIds.length,
                nistFallback: compliance.nist.controlIds.length,
                uncovered: compliance.uncoveredControlIds.length,
            },
            benchmarkLookupError,
            benchmarkLookupErrorCode,
            benchmarkResolution: benchmarkResolutionDiagnostics.slice(0, 30).map((diagnostic) => ({
                kind: diagnostic.kind,
                query: diagnostic.query,
                sheetName: diagnostic.sheetName,
                catalogCandidateCount: diagnostic.catalogCandidates.length,
                attempts: diagnostic.candidateAttempts.slice(0, 5).map((attempt) => ({
                    workbenchId: attempt.workbenchId,
                    benchmarkTitle: attempt.benchmarkTitle,
                    benchmarkVersion: attempt.benchmarkVersion,
                    outcome: attempt.outcome,
                    reason: attempt.reason,
                })),
            })),
            officialReference,
            cis: cisAuditSources[0] || null,
            stig: stigAuditSources[0] || null,
            cisSources: cisAuditSources,
            stigSources: stigAuditSources,
            adjacentSources: adjacentAuditSources,
            disaStigSources: disaStigAuditSources,
        };

        if (requestedScope === "compliance_only") {
            const compliancePayload = await compliancePayloadPromise;
            const supplementalComparison: SCSEMSupplementalComparison = {
                mode: "not_requested",
                complete: true,
                candidateOnly: true,
                applicabilityStatus: "not_requested",
                directSourceCount: 0,
                comparedDirectSourceCount: 0,
                candidateCount: 0,
                comparedCandidateCount: 0,
                rawProposalCount: 0,
                evidenceBoundProposalCount: 0,
                reason: "The reviewer requested a Publication 1075 and NIST-only analysis, so SkyShield did not authenticate to CIS WorkBench or retrieve licensed benchmark material.",
            };
            updaterSession.audit.supplementalComparison = supplementalComparison;
            const analysisCoverage = buildSCSEMAnalysisCoverage({
                totalRows: controls.length,
                compliance: compliancePayload,
                uncoveredControlIdCount: compliance.uncoveredControlIds.length,
                supplementalComparison,
                additionalBlockers: sourceCoverageBlockers,
            });
            updaterSession.audit.analysisCoverage = analysisCoverage;
            const complianceOnlyChanges = dedupeProposedChanges(addUnambiguousTargetSheets([
                ...(compliancePayload.changes || []),
                ...disaStigChanges,
            ], controls));
            const validChanges = addIdsToChanges(validateChanges(
                fairlyLimitSCSEMProposals(complianceOnlyChanges, MAX_UPDATER_CHANGES),
                controls,
                MAX_UPDATER_CHANGES
            ));
            const completedAnalysisLease = clearSCSEMAnalysisLease(
                updaterSession,
                analysisOperationId
            );
            updaterSession.status = analysisCoverage.complete ? "review_ready" : "analysis_incomplete";
            updaterSession.summary = [
                compliancePayload.summary,
                "CIS Benchmark and CIS-STIG sources were intentionally excluded from this requested analysis scope.",
                analysisCoverage.complete ? null : "Analysis remains incomplete; see coverage blockers before treating this draft as release-ready.",
            ].filter(Boolean).join(" ");
            updaterSession.changes = validChanges;
            updaterSession.history.push({
                at: new Date().toISOString(),
                action: "analyze",
                description:
                    `Publication 1075/NIST-only analysis ran across ${compliancePayload.batchCount} bounded compliance batch(es), ` +
                    `skipped CIS WorkBench by reviewer request, and generated ${validChanges.length} proposed change(s).`,
            });
            await writeSCSEMUpdaterSession(updaterSession, updaterSession.revision, {
                action: "SCSEM_UPDATER_ANALYZE_FINALIZE",
                analysisOperationId: completedAnalysisLease.operationId,
                affectedPayload: {
                    input: {
                        fileName: updaterSession.originalFileName,
                        inferredTechnology: updaterSession.inferredTechnology,
                        parsedControls: controls.length,
                        analysisScope: requestedScope,
                        testCaseSheets: parsed.sheets
                            .filter((sheet) => sheet.sheetType === "test_cases")
                            .map((sheet) => sheet.sheetName),
                    },
                    output: {
                        completedAnalysisLease,
                        analysisLeaseCleared: true,
                        summary: updaterSession.summary,
                        changeCount: validChanges.length,
                        changes: validChanges,
                        candidateCounts: {
                            cisUpdates: 0,
                            cisNewControls: 0,
                            stigUpdates: 0,
                            stigNewControls: 0,
                            complianceBatches: compliancePayload.batchCount,
                            completedComplianceBatches: compliancePayload.completedBatchCount,
                            complianceChanges: compliancePayload.changes.length,
                        },
                        auditSources: updaterSession.audit,
                    },
                },
                ...auditRequestContext(request),
            });
            return NextResponse.json(
                { session: clientSafeSCSEMUpdaterSession(updaterSession) },
                { headers: { ETag: scsemUpdaterRevisionETag(updaterSession) } }
            );
        }

        if (resolvedSources.length === 0) {
            const adjacentCandidates = buildAdjacentRecommendationCandidates(adjacentSources);
            const compliancePayload = await compliancePayloadPromise;
            const adjacentPayload = adjacentCandidates.length > 0
                ? await buildAdjacentSourcePayload({
                    technology: updaterSession.inferredTechnology,
                    fileName: updaterSession.originalFileName,
                    parsed,
                    controls,
                    pub1075,
                    adjacentSources,
                    adjacentCandidates,
                })
                : { summary: "", changes: [] };
            const expectedDirectDisaSourceCount = disaCatalogSources.filter(
                (source) => source.sourceRelationship === "direct"
            ).length;
            const disaComparisonFailed = expectedDirectDisaSourceCount !== resolvedDisaStigSources.length;
            const registryNotApplicable =
                expectedDirectDisaSourceCount === 0 &&
                requestedScope === "full" &&
                Boolean(updaterSession.audit.officialSource);
            const boundAdjacentChanges = bindBenchmarkChangesToResolvedEvidence(
                adjacentPayload.changes || [],
                controls,
                adjacentCandidates,
                pub1075.pub1075.version,
                pub1075.nist.version
            );
            const rawChanges = dedupeProposedChanges(addUnambiguousTargetSheets([
                ...(compliancePayload.changes || []),
                ...disaStigChanges,
                ...boundAdjacentChanges,
            ], controls));
            const fairlyLimitedChanges = fairlyLimitSCSEMProposals(rawChanges, MAX_UPDATER_CHANGES);
            const retainedDirectProposalCount = fairlyLimitedChanges.filter(
                (change) => change.sourceEvidence?.evidenceTier === "direct"
            ).length;
            const capOmittedDirectProposalCount = Math.max(
                0,
                disaStigChanges.length - retainedDirectProposalCount
            );
            const supplementalComparison: SCSEMSupplementalComparison = {
                mode: benchmarkLookupError || disaComparisonFailed
                    ? "failed"
                    : disaStigChanges.length > 0
                        ? "deterministic_fallback"
                        : "no_delta",
                complete: !benchmarkLookupError && !disaComparisonFailed && capOmittedDirectProposalCount === 0,
                candidateOnly: true,
                applicabilityStatus: registryNotApplicable ? "not_applicable" : "review_required",
                directSourceCount: expectedDirectDisaSourceCount,
                comparedDirectSourceCount: resolvedDisaStigSources.length,
                candidateCount: disaStigChanges.length,
                comparedCandidateCount: disaStigChanges.length,
                rawProposalCount: disaStigChanges.length,
                evidenceBoundProposalCount: retainedDirectProposalCount,
                reason: benchmarkLookupError
                    ? "Configured CIS source lookup failed; public DISA results remain independently source-bound."
                    : disaComparisonFailed
                        ? "One or more exact public DISA STIG packages could not be downloaded and validated."
                        : capOmittedDirectProposalCount > 0
                            ? `The ${MAX_UPDATER_CHANGES}-proposal safety cap omitted ${capOmittedDirectProposalCount} complete direct-source proposal(s) or strictness-group member(s).`
                            : registryNotApplicable
                                ? "The pinned IRS-workbook and sheet registry records no safe direct public DISA STIG source."
                                : `All ${resolvedDisaStigSources.length} exact public DISA STIG source(s) and ${disaStigChanges.length} deterministic proposal(s) were compared and source-bound.`,
            };
            updaterSession.audit.supplementalComparison = supplementalComparison;
            const analysisCoverage = buildSCSEMAnalysisCoverage({
                totalRows: controls.length,
                compliance: compliancePayload,
                uncoveredControlIdCount: compliance.uncoveredControlIds.length,
                benchmarkLookupError,
                supplementalComparison,
                additionalBlockers: sourceCoverageBlockers,
            });
            updaterSession.audit.analysisCoverage = analysisCoverage;
            const validChanges = addIdsToChanges(
                validateChanges(fairlyLimitedChanges, controls, MAX_UPDATER_CHANGES)
            );

            const completedAnalysisLease = clearSCSEMAnalysisLease(
                updaterSession,
                analysisOperationId
            );
            updaterSession.status = analysisCoverage.complete ? "review_ready" : "analysis_incomplete";
            updaterSession.summary = [
                compliancePayload.summary,
                adjacentPayload.summary,
                resolvedDisaStigSources.length > 0
                    ? `Compared ${resolvedDisaStigSources.length} current official public DISA STIG source(s) and generated ${disaStigChanges.length} reviewer-gated proposal(s).`
                    : disaCatalogSources.length > 0
                        ? "Matched only adjacent or unavailable DISA STIG source metadata; no direct DISA content was used."
                        : "No direct current public DISA STIG source matched this technology.",
                benchmarkLookupError
                    ? `Configured CIS Benchmark lookup was unavailable (${benchmarkLookupError}); see coverage blockers before release.`
                    : "No direct licensed CIS workbook/profile matched; public DISA STIG and Publication 1075 comparisons remain independently auditable.",
            ].filter(Boolean).join(" ");
            updaterSession.changes = validChanges;
            updaterSession.history.push({
                at: new Date().toISOString(),
                action: "analyze",
                description: `Publication 1075/NIST-mapping analysis completed without a direct CIS Benchmark or CIS-STIG source and generated ${validChanges.length} proposed change(s) across ${compliancePayload.batchCount} bounded batch(es).`,
            });
            await writeSCSEMUpdaterSession(updaterSession, updaterSession.revision, {
                action: "SCSEM_UPDATER_ANALYZE_FINALIZE",
                analysisOperationId: completedAnalysisLease.operationId,
                affectedPayload: {
                    input: {
                        fileName: updaterSession.originalFileName,
                        inferredTechnology: updaterSession.inferredTechnology,
                        parsedControls: controls.length,
                        testCaseSheets: parsed.sheets
                            .filter((sheet) => sheet.sheetType === "test_cases")
                            .map((sheet) => sheet.sheetName),
                    },
                    output: {
                        completedAnalysisLease,
                        analysisLeaseCleared: true,
                        summary: updaterSession.summary,
                        changeCount: validChanges.length,
                        changes: validChanges,
                        candidateCounts: {
                            cisUpdates: 0,
                            cisNewControls: 0,
                            stigUpdates: 0,
                            stigNewControls: 0,
                            adjacentSources: adjacentSources.length,
                            adjacentRecommendations: adjacentCandidates.length,
                            disaStigSources: resolvedDisaStigSources.length,
                            disaStigChanges: disaStigChanges.length,
                            complianceBatches: compliancePayload.batchCount,
                            completedComplianceBatches: compliancePayload.completedBatchCount,
                            complianceChanges: compliancePayload.changes.length,
                        },
                        benchmarkLookupError: benchmarkLookupError || null,
                        benchmarkLookupErrorCode: benchmarkLookupErrorCode || null,
                        auditSources: updaterSession.audit,
                    },
                },
                ...auditRequestContext(request),
            });
            return NextResponse.json(
                { session: clientSafeSCSEMUpdaterSession(updaterSession) },
                { headers: { ETag: scsemUpdaterRevisionETag(updaterSession) } }
            );
        }

        const cisUpdateCandidates = updateCandidates.filter((candidate) => candidate.sourceKind === "CIS");
        const stigUpdateCandidates = updateCandidates.filter((candidate) => candidate.sourceKind === "CIS_STIG");
        const cisNewControlCandidates = newControlCandidates.filter((candidate) => candidate.sourceKind === "CIS");
        const stigNewControlCandidates = newControlCandidates.filter((candidate) => candidate.sourceKind === "CIS_STIG");

        if (updateCandidates.length === 0 && newControlCandidates.length === 0) {
            const compliancePayload = await compliancePayloadPromise;
            const expectedDirectDisaSourceCount = disaCatalogSources.filter(
                (source) => source.sourceRelationship === "direct"
            ).length;
            const noLicensedDeltaChanges = dedupeProposedChanges(addUnambiguousTargetSheets([
                ...(compliancePayload.changes || []),
                ...disaStigChanges,
            ], controls));
            const fairlyLimitedChanges = fairlyLimitSCSEMProposals(
                noLicensedDeltaChanges,
                MAX_UPDATER_CHANGES
            );
            const retainedDirectProposalCount = fairlyLimitedChanges.filter(
                (change) => change.sourceEvidence?.evidenceTier === "direct"
            ).length;
            const capOmittedDirectProposalCount = Math.max(
                0,
                disaStigChanges.length - retainedDirectProposalCount
            );
            const supplementalComparison: SCSEMSupplementalComparison = {
                mode: benchmarkLookupError
                    ? "failed"
                    : disaStigChanges.length > 0
                        ? "deterministic_fallback"
                        : "no_delta",
                complete:
                    !benchmarkLookupError &&
                    totalUpdateCandidateCount === 0 &&
                    totalNewControlCandidateCount === 0 &&
                    expectedDirectDisaSourceCount === resolvedDisaStigSources.length &&
                    capOmittedDirectProposalCount === 0,
                candidateOnly: true,
                applicabilityStatus: "review_required",
                directSourceCount: resolvedSources.length + expectedDirectDisaSourceCount,
                comparedDirectSourceCount: comparedDirectSourceCount + resolvedDisaStigSources.length,
                candidateCount: totalUpdateCandidateCount + totalNewControlCandidateCount + disaStigChanges.length,
                comparedCandidateCount: disaStigChanges.length,
                rawProposalCount: disaStigChanges.length,
                evidenceBoundProposalCount: retainedDirectProposalCount,
                reason: benchmarkLookupError
                    ? "One or more required CIS WorkBench sources could not be downloaded and validated."
                    : capOmittedDirectProposalCount > 0
                        ? `The ${MAX_UPDATER_CHANGES}-proposal safety cap omitted ${capOmittedDirectProposalCount} complete direct-source proposal(s) or strictness-group member(s).`
                        : (disaStigChanges.length > 0
                            ? "Current public DISA STIG sources produced deterministic reviewer-gated deltas; "
                            : "Validated direct source candidates produced no material field or missing-recommendation deltas; ") +
                        "the technical match remains candidate-only pending reviewer applicability confirmation.",
            };
            updaterSession.audit.supplementalComparison = supplementalComparison;
            const analysisCoverage = buildSCSEMAnalysisCoverage({
                totalRows: controls.length,
                compliance: compliancePayload,
                uncoveredControlIdCount: compliance.uncoveredControlIds.length,
                benchmarkLookupError,
                supplementalComparison,
                additionalBlockers: sourceCoverageBlockers,
            });
            updaterSession.audit.analysisCoverage = analysisCoverage;
            const validChanges = addIdsToChanges(validateChanges(
                fairlyLimitedChanges,
                controls,
                MAX_UPDATER_CHANGES
            ));
            const completedAnalysisLease = clearSCSEMAnalysisLease(
                updaterSession,
                analysisOperationId
            );
            updaterSession.status = analysisCoverage.complete ? "review_ready" : "analysis_incomplete";
            updaterSession.summary = `${compliancePayload.summary} No directly applicable CIS Benchmark or CIS-STIG deltas were detected.${analysisCoverage.complete ? "" : " Analysis remains incomplete; see coverage blockers."}`;
            updaterSession.changes = validChanges;
            updaterSession.history.push({
                at: new Date().toISOString(),
                action: "analyze",
                description: `Compliance and benchmark analysis completed across ${compliancePayload.batchCount} bounded batch(es); no directly applicable CIS Benchmark/CIS-STIG deltas were detected. Generated ${validChanges.length} proposed change(s).`,
            });
            await writeSCSEMUpdaterSession(updaterSession, updaterSession.revision, {
                action: "SCSEM_UPDATER_ANALYZE_FINALIZE",
                analysisOperationId: completedAnalysisLease.operationId,
                affectedPayload: {
                    input: {
                        fileName: updaterSession.originalFileName,
                        inferredTechnology: updaterSession.inferredTechnology,
                        parsedControls: controls.length,
                        testCaseSheets: parsed.sheets
                            .filter((sheet) => sheet.sheetType === "test_cases")
                            .map((sheet) => sheet.sheetName),
                    },
                    output: {
                        completedAnalysisLease,
                        analysisLeaseCleared: true,
                        summary: updaterSession.summary,
                        changeCount: validChanges.length,
                        changes: validChanges,
                        candidateCounts: {
                            cisUpdates: cisUpdateCandidates.length,
                            cisNewControls: cisNewControlCandidates.length,
                            stigUpdates: stigUpdateCandidates.length,
                            stigNewControls: stigNewControlCandidates.length,
                            complianceBatches: compliancePayload.batchCount,
                            completedComplianceBatches: compliancePayload.completedBatchCount,
                            complianceChanges: compliancePayload.changes.length,
                        },
                        auditSources: updaterSession.audit,
                    },
                },
                ...auditRequestContext(request),
            });
            return NextResponse.json(
                { session: clientSafeSCSEMUpdaterSession(updaterSession) },
                { headers: { ETag: scsemUpdaterRevisionETag(updaterSession) } }
            );
        }

        const cisUpdateEvidence = cisUpdateCandidates
            .map((candidate) => `Target sheet: ${candidate.control.sourceSheet || "unknown"}\n${buildControlSummary(candidate.control, candidate.recommendation, candidate.sourceLabel)}`)
            .join("\n\n---\n\n");
        const cisNewControlEvidence = cisNewControlCandidates
            .map((candidate) => `Target sheet: ${candidate.targetSheet || "unknown"}\n${buildNewControlEvidence(candidate.recommendation, candidate.sourceLabel)}`)
            .join("\n\n---\n\n");
        const stigUpdateEvidence = stigUpdateCandidates
            .map((candidate) => `Target sheet: ${candidate.control.sourceSheet || "unknown"}\n${buildControlSummary(candidate.control, candidate.recommendation, candidate.sourceLabel)}`)
            .join("\n\n---\n\n");
        const stigNewControlEvidence = stigNewControlCandidates
            .map((candidate) => `Target sheet: ${candidate.targetSheet || "unknown"}\n${buildNewControlEvidence(candidate.recommendation, candidate.sourceLabel)}`)
            .join("\n\n---\n\n");
        const publicDisaEvidence = buildPublicDisaProposalEvidence(disaStigChanges);
        const benchmarkSourceSummary = (sources: ResolvedBenchmarkSource[], kind: ResolvedBenchmarkKind) => sources.length > 0
            ? sources.map((source) => [
                `- Title: ${source.downloaded.snapshot.benchmarkTitle}`,
                `  WorkBench ID: ${source.downloaded.snapshot.workbenchId}`,
                `  Version: ${source.downloaded.snapshot.benchmarkVersion}`,
                `  Release date: ${source.downloaded.snapshot.releaseDate.toISOString().slice(0, 10)}`,
                `  Selected profile: ${source.selectedProfile.profile}`,
                `  Matched sheets: ${source.matchedSheets.join(", ")}`,
                `  Match query: ${source.matchQuery}`,
                `  Excel SHA-256: ${source.downloaded.snapshot.sha256}`,
                `  Matched existing recommendations: ${source.sharedRecommendationCount}/${source.sheetRecommendationCount}`,
            ].join("\n")).join("\n")
            : `- No matching ${benchmarkKindLabel(kind)} workbook/profile was selected for this SCSEM technology.`;

        const prompt = `You are an IRS Safeguards SCSEM update analyst. Propose human-reviewable SCSEM workbook changes using only the evidence below.

Decision policy:
- Evaluate every directly applicable source independently: current CIS Benchmark, CIS-STIG benchmark, public DISA STIG, and IRS Publication 1075.
- No authority wins merely because it is listed first. For the same control, propose the strictest applicable requirement that does not weaken another binding requirement.
- NIST SP 800-53 and 800-53A are control-mapping and assessment evidence. They may clarify a mapped control but must not create a technology-specific test case by themselves.
- If CIS Benchmark, CIS-STIG, public DISA STIG, and Publication 1075 differ, select the stricter secure setting when the supplied evidence makes that comparison clear.
- Public DISA STIG proposals are preserved independently and source-bound by the server. Do not emit a weaker CIS/CIS-STIG value for the same control; if strictness is ambiguous, leave the benchmark proposal reviewer-gated.
- If strictness or applicability is ambiguous, preserve the competing source proposal for explicit human review and mark confidence "needs_review"; never silently discard CIS or STIG evidence because a Publication 1075 proposal was generated first.
- Existing IRS SCSEM rows remain the base source of truth.
- You may propose a new SCSEM control only when a directly applicable CIS or STIG recommendation is absent from the uploaded SCSEM. Do not manufacture new controls merely from Publication 1075 or NIST section headings.
- Explain each proposed update with enough detail for a human reviewer to decide quickly.

Uploaded SCSEM:
- File name: ${updaterSession.originalFileName}
- Inferred technology: ${updaterSession.inferredTechnology}
- Dashboard subject: ${parsed.metadata.subject || "unknown"}
- SCSEM version: ${parsed.metadata.version || "unknown"}
- Effective date: ${parsed.metadata.effectiveDate || "unknown"}
- Parsed controls: ${controls.length}

CIS Benchmark Sources:
${benchmarkSourceSummary(cisSources, "CIS")}

CIS-STIG Sources from CIS WorkBench:
${benchmarkSourceSummary(stigSources, "CIS_STIG")}

Compliance sources:
- IRS Publication 1075 version: ${pub1075.pub1075.version}
- NIST SP 800-53 fallback version: ${pub1075.nist.version}

CURRENT SCSEM ROWS MATCHED TO CIS CANDIDATES:
${cisUpdateEvidence || "None"}

POTENTIAL NEW CIS ROWS NOT PRESENT IN THE SCSEM:
${cisNewControlEvidence || "None"}

CURRENT SCSEM ROWS MATCHED TO CIS-STIG CANDIDATES:
${stigUpdateEvidence || "None"}

POTENTIAL NEW CIS-STIG ROWS NOT PRESENT IN THE SCSEM:
${stigNewControlEvidence || "None"}

PUBLIC DISA STIG PROPOSALS — PRESERVED INDEPENDENTLY:
${publicDisaEvidence.text || "No directly applicable public DISA STIG proposal was generated."}

COMPLIANCE EVIDENCE — PUBLICATION 1075 WITH NIST MAPPING/ASSESSMENT SUPPORT:
${pub1075.excerpts || "No Publication 1075 or NIST mapping/assessment excerpts were found for the candidate controls."}

Return ONLY valid JSON:
{
  "summary": "2-3 sentence evidence-based summary of why this uploaded SCSEM needs review.",
  "changes": [
    {
      "action": "updateField",
      "testId": "exact existing SCSEM Test ID",
      "targetSheet": "exact Target sheet named with this candidate",
      "field": "testProcedures|expectedResults|remediationProcedure|description|rationale|impact|sectionTitle|findingStatement",
      "currentValue": "brief current value summary",
      "proposedValue": "complete replacement text for that field",
      "reason": "specific reason citing the directly applicable CIS Benchmark or CIS-STIG evidence and any Publication 1075 mapping used to select the strictest applicable requirement",
      "confidence": "high|medium|needs_review",
      "sourceEvidence": {
        "cisRecommendation": "CIS recommendation number if CIS evidence applies, otherwise null",
        "cisProfile": "selected CIS profile if CIS evidence applies, otherwise null",
        "stigRecommendation": "CIS-STIG recommendation number if CIS-STIG evidence applies, otherwise null",
        "stigProfile": "selected CIS-STIG profile if CIS-STIG evidence applies, otherwise null",
        "sourceWorkbenchId": "WorkBench ID from the evidence source",
        "sourceBenchmarkTitle": "benchmark title from the evidence source",
        "pub1075Version": "${pub1075.pub1075.version}",
        "nistVersion": "${pub1075.nist.version}"
      }
    },
    {
      "action": "addControl",
      "testId": "NEW-CIS-or-CIS-STIG-<recommendation>",
      "targetSheet": "exact Target sheet named with this candidate",
      "field": "newControl",
      "currentValue": "Not present in current SCSEM",
      "proposedValue": "short summary of the new control",
      "reason": "why this new control is proposed from the benchmark evidence",
      "confidence": "high|medium|needs_review",
      "newControl": {
        "nistId": null,
        "nistControlName": "best fit if obvious, otherwise null",
        "testMethod": "Automated|Manual|Interview|Examine|Test",
        "sectionTitle": "CIS Benchmark or CIS-STIG recommendation title",
        "description": "SCSEM-ready description",
        "testProcedures": "SCSEM-ready audit/test procedure",
        "expectedResults": "SCSEM-ready expected result",
        "findingStatement": "SCSEM-ready standard failure condition grounded only in the supplied evidence; do not describe an observed agency result",
        "criticality": "Critical|Significant|Moderate|Limited|Informational",
        "issueCode": null,
        "cisBenchmarkRef": "CIS Benchmark or CIS-STIG section number",
        "recommendationNum": "CIS Benchmark or CIS-STIG recommendation number",
        "rationale": "SCSEM-ready rationale",
        "impact": "SCSEM-ready impact",
        "remediationProcedure": "SCSEM-ready remediation"
      },
      "sourceEvidence": {
        "cisRecommendation": "CIS recommendation number if CIS evidence applies, otherwise null",
        "cisProfile": "selected CIS profile if CIS evidence applies, otherwise null",
        "stigRecommendation": "CIS-STIG recommendation number if CIS-STIG evidence applies, otherwise null",
        "stigProfile": "selected CIS-STIG profile if CIS-STIG evidence applies, otherwise null",
        "sourceWorkbenchId": "WorkBench ID from the evidence source",
        "sourceBenchmarkTitle": "benchmark title from the evidence source",
        "pub1075Version": "${pub1075.pub1075.version}",
        "nistVersion": "${pub1075.nist.version}"
      }
    }
  ]
}

Rules:
- Include up to ${MAX_UPDATER_CHANGES} total changes. Prioritize every cell-level delta that clearly needs human review, but do not create low-value wording churn.
- For updateField, only use Test IDs from CURRENT SCSEM ROWS MATCHED TO CIS CANDIDATES or CURRENT SCSEM ROWS MATCHED TO CIS-STIG CANDIDATES.
- For addControl, only use recommendation numbers from POTENTIAL NEW CIS ROWS or POTENTIAL NEW CIS-STIG ROWS.
- Do not claim Pub 1075 or NIST says something unless the corresponding excerpt is present above.
- Never treat NIST mapping/assessment evidence as an independent authority when a supplied Publication 1075 excerpt covers the control.
- Treat newControl.findingStatement as canonical template text describing the failed control condition, never as an observed agency response.
- Leave newControl.issueCode null. A reviewer must select an exact code from the uploaded workbook's IRS Issue Code Table before approval; never invent or infer a code outside that table.
- Do not include markdown fences.`;

        let payload: any;
        let comparisonMode: SCSEMSupplementalComparisonMode = "failed";
        let comparisonReason = "Supplemental comparison did not start.";
        const availableCandidateCount = updateCandidates.length + newControlCandidates.length;
        const totalCandidateCount = totalUpdateCandidateCount + totalNewControlCandidateCount;
        const aiWithinInteractiveLimits =
            controls.length <= AI_CONTROL_LIMIT &&
            prompt.length <= AI_PROMPT_CHAR_LIMIT &&
            publicDisaEvidence.complete;
        const aiConfigured = hasConfiguredBifrostApiKey(process.env.BIFROST_API_KEY);
        const deterministicFallback = (reason: string) => buildFallbackPayload({
            technology: updaterSession.inferredTechnology,
            pub1075,
            fallbackReason: reason,
            updateCandidates,
            newControlCandidates,
        });
        const preservationPayload = deterministicFallback(
            "every discovered licensed-source candidate must remain represented even if AI emits no proposal"
        );
        const preservedBoundBenchmarkChanges = bindBenchmarkChangesToResolvedEvidence(
            preservationPayload.changes,
            controls,
            [...updateCandidates, ...newControlCandidates],
            pub1075.pub1075.version,
            pub1075.nist.version
        );

        if (!aiWithinInteractiveLimits) {
            comparisonMode = "deterministic_fallback";
            comparisonReason = !publicDisaEvidence.complete
                ? `the bounded AI context included ${publicDisaEvidence.includedCount} of ${publicDisaEvidence.totalCount} public DISA proposals, so all candidates were compared deterministically instead of claiming a partial AI strictness comparison`
                : `the ${controls.length}-row workbook or ${prompt.length}-character evidence set exceeded the bounded interactive AI limits`;
            payload = deterministicFallback(comparisonReason);
        } else if (!aiConfigured) {
            comparisonMode = "deterministic_fallback";
            comparisonReason =
                "the bounded comparison AI provider was not configured, so the complete candidate set was compared deterministically";
            payload = deterministicFallback(comparisonReason);
        } else {
            const abortController = new AbortController();
            const timeout = setTimeout(() => abortController.abort(), AI_TIMEOUT_MS);

            try {
                const responseText = await generateBifrostText({
                    model: getConfiguredBifrostModel("BIFROST_SCSEM_MODEL"),
                    maxTokens: 9000,
                    temperature: 0.15,
                    system: "You generate precise JSON SCSEM recommendations by comparing directly applicable CIS Benchmark, CIS-STIG, public DISA STIG, and Publication 1075 evidence and selecting the strictest applicable control. NIST is mapping and assessment evidence only. Public DISA proposals remain independently source-bound and must not be weakened.",
                    prompt,
                    signal: abortController.signal,
                });
                payload = parseJsonResponse(responseText);
                if (!payload || typeof payload !== "object" || !Array.isArray(payload.changes)) {
                    throw new Error("AI response did not contain a changes array.");
                }
                comparisonMode = "ai";
                comparisonReason =
                    "AI compared the complete bounded candidate evidence set; every emitted proposal still requires evidence binding and human review.";
            } catch (error) {
                console.warn("SCSEM updater AI analysis failed; using deterministic fallback changes.", error);
                comparisonMode = "deterministic_fallback";
                comparisonReason = error instanceof Error && error.name === "AbortError"
                    ? "the all-source AI comparison exceeded the interactive timeout"
                    : "the all-source AI response could not be validated safely";
                payload = deterministicFallback(comparisonReason);
            } finally {
                clearTimeout(timeout);
            }
        }

        let boundBenchmarkChanges = bindBenchmarkChangesToResolvedEvidence(
            payload.changes,
            controls,
            [...updateCandidates, ...newControlCandidates],
            pub1075.pub1075.version,
            pub1075.nist.version
        );
        if (comparisonMode === "ai" && boundBenchmarkChanges.length !== payload.changes.length) {
            comparisonMode = "deterministic_fallback";
            comparisonReason =
                "one or more AI proposals could not be rebound to exact WorkBench recommendation and SCSEM row evidence";
            payload = deterministicFallback(comparisonReason);
            boundBenchmarkChanges = bindBenchmarkChangesToResolvedEvidence(
                payload.changes,
                controls,
                [...updateCandidates, ...newControlCandidates],
                pub1075.pub1075.version,
                pub1075.nist.version
            );
        }
        boundBenchmarkChanges = dedupeProposedChanges([
            ...boundBenchmarkChanges,
            ...preservedBoundBenchmarkChanges,
        ]);

        const rawEmissionCount = payload.changes.length + preservationPayload.changes.length;
        const comparedCandidateCount = comparisonMode === "ai"
            ? availableCandidateCount
            : Number(payload.examinedCandidateCount || 0);
        const expectedDirectDisaSourceCount = disaCatalogSources.filter(
            (source) => source.sourceRelationship === "direct"
        ).length;
        const disaComparisonComplete = expectedDirectDisaSourceCount === resolvedDisaStigSources.length;
        let comparisonComplete =
            !benchmarkLookupError &&
            comparedCandidateCount === totalCandidateCount &&
            (totalCandidateCount === 0 || boundBenchmarkChanges.length > 0) &&
            disaComparisonComplete;
        if (benchmarkLookupError) {
            comparisonMode = "failed";
            comparisonReason = `Required CIS WorkBench source unavailable: ${benchmarkLookupError}`;
            comparisonComplete = false;
        } else if (totalCandidateCount > 0 && boundBenchmarkChanges.length === 0) {
            comparisonMode = "failed";
            comparisonReason = "No licensed-source candidate produced a source-bound reviewer proposal.";
            comparisonComplete = false;
        } else if (!comparisonComplete) {
            comparisonReason +=
                ` Compared ${comparedCandidateCount} of ${totalCandidateCount} discovered licensed-source candidate(s), ` +
                `received ${payload.changes.length} AI/fallback emission(s), preserved ${preservationPayload.changes.length} deterministic emission(s), and retained ` +
                `${boundBenchmarkChanges.length} source-bound proposal(s).` +
                (!disaComparisonComplete
                    ? ` Compared ${resolvedDisaStigSources.length} of ${expectedDirectDisaSourceCount} pinned public DISA STIG source(s).`
                    : "");
        }
        const compliancePayload = await compliancePayloadPromise;
        const combinedChanges = dedupeProposedChanges(addUnambiguousTargetSheets([
            ...(compliancePayload.changes || []),
            ...boundBenchmarkChanges,
            ...disaStigChanges,
        ], controls));
        const uncappedDirectProposalCount = combinedChanges.filter(
            (change) => change.sourceEvidence?.evidenceTier === "direct"
        ).length;
        const fairlyLimitedChanges = fairlyLimitSCSEMProposals(combinedChanges, MAX_UPDATER_CHANGES);
        const retainedDirectProposalCount = fairlyLimitedChanges.filter(
            (change) => change.sourceEvidence?.evidenceTier === "direct"
        ).length;
        const capOmittedDirectProposalCount = Math.max(
            0,
            uncappedDirectProposalCount - retainedDirectProposalCount
        );
        if (capOmittedDirectProposalCount > 0) {
            comparisonComplete = false;
            comparisonReason +=
                ` The ${MAX_UPDATER_CHANGES}-proposal safety cap omitted ${capOmittedDirectProposalCount} complete direct-source proposal(s) or strictness-group member(s); this run cannot be release-ready.`;
        }

        const supplementalComparison: SCSEMSupplementalComparison = {
            mode: comparisonMode,
            complete: comparisonComplete,
            candidateOnly: true,
            applicabilityStatus: "review_required",
            directSourceCount: resolvedSources.length + expectedDirectDisaSourceCount,
            comparedDirectSourceCount: comparedDirectSourceCount + resolvedDisaStigSources.length,
            candidateCount: totalCandidateCount + disaStigChanges.length,
            comparedCandidateCount: comparedCandidateCount + disaStigChanges.length,
            rawProposalCount: uncappedDirectProposalCount,
            evidenceBoundProposalCount: retainedDirectProposalCount,
            reason: comparisonReason,
        };
        updaterSession.audit.supplementalComparison = supplementalComparison;
        const analysisCoverage = buildSCSEMAnalysisCoverage({
            totalRows: controls.length,
            compliance: compliancePayload,
            uncoveredControlIdCount: compliance.uncoveredControlIds.length,
            benchmarkLookupError,
            supplementalComparison,
            additionalBlockers: sourceCoverageBlockers,
        });
        updaterSession.audit.analysisCoverage = analysisCoverage;
        const validChanges = addIdsToChanges(
            validateChanges(fairlyLimitedChanges, controls, MAX_UPDATER_CHANGES)
        );

        const completedAnalysisLease = clearSCSEMAnalysisLease(
            updaterSession,
            analysisOperationId
        );
        updaterSession.status = analysisCoverage.complete ? "review_ready" : "analysis_incomplete";
        updaterSession.summary = [
            compliancePayload.summary,
            payload.summary || `CIS Benchmark/CIS-STIG strictness review generated for ${updaterSession.inferredTechnology}.`,
            resolvedDisaStigSources.length > 0
                ? `Compared ${resolvedDisaStigSources.length} exact public DISA STIG source(s) and generated ${disaStigChanges.length} source-bound proposal(s).`
                : null,
            analysisCoverage.complete ? null : "Analysis remains incomplete; see coverage blockers before treating this draft as release-ready.",
        ].filter(Boolean).join(" ");
        updaterSession.changes = validChanges;
        updaterSession.history.push({
            at: new Date().toISOString(),
            action: "analyze",
            description:
                `All-source analysis ran ${compliancePayload.batchCount} bounded Publication 1075/NIST-mapping batch(es). ` +
                `CIS Benchmark/CIS-STIG mode ${comparisonMode} compared ${comparedCandidateCount}/${totalCandidateCount} ` +
                `candidate(s), retained ${boundBenchmarkChanges.length} source-bound proposal(s) from ${rawEmissionCount} AI/fallback emission(s), and generated ` +
                `${validChanges.length} total reviewer-gated change(s).`,
        });
        await writeSCSEMUpdaterSession(updaterSession, updaterSession.revision, {
            action: "SCSEM_UPDATER_ANALYZE_FINALIZE",
            analysisOperationId: completedAnalysisLease.operationId,
            affectedPayload: {
                input: {
                    fileName: updaterSession.originalFileName,
                    inferredTechnology: updaterSession.inferredTechnology,
                    parsedControls: controls.length,
                    scsemVersion: parsed.metadata.version,
                    effectiveDate: parsed.metadata.effectiveDate,
                    aiUsed: comparisonMode === "ai",
                },
                output: {
                    completedAnalysisLease,
                    analysisLeaseCleared: true,
                    summary: updaterSession.summary,
                    changeCount: validChanges.length,
                    changes: validChanges,
                    candidateCounts: {
                        cisUpdates: cisUpdateCandidates.length,
                        cisNewControls: cisNewControlCandidates.length,
                        stigUpdates: stigUpdateCandidates.length,
                        stigNewControls: stigNewControlCandidates.length,
                        disaStigSources: resolvedDisaStigSources.length,
                        disaStigChanges: disaStigChanges.length,
                        complianceBatches: compliancePayload.batchCount,
                        completedComplianceBatches: compliancePayload.completedBatchCount,
                        complianceChanges: compliancePayload.changes.length,
                    },
                    auditSources: updaterSession.audit,
                },
            },
            ...auditRequestContext(request),
        });

        return NextResponse.json(
            { session: clientSafeSCSEMUpdaterSession(updaterSession) },
            { headers: { ETag: scsemUpdaterRevisionETag(updaterSession) } }
        );
    } catch (error: unknown) {
        console.error("SCSEM updater analysis error:", error);
        const mutationError = scsemUpdaterMutationErrorDetails(error);
        const failure = scsemAnalysisFailureDetails(error);
        if (!mutationError) {
            try {
                const updaterSession = user
                    ? readSCSEMUpdaterSessionForUser(id, user)
                    : null;
                if (!updaterSession) throw new Error("SCSEM updater session not found.");
                if (isSCSEMAnalysisLeaseOwnedBy(updaterSession, analysisOperationId)) {
                    const previousStatus = updaterSession.status;
                    const failedAnalysisLease = clearSCSEMAnalysisLease(
                        updaterSession,
                        analysisOperationId
                    );
                    updaterSession.status = "error";
                    updaterSession.error = failure.persistedError;
                    await writeSCSEMUpdaterSession(updaterSession, updaterSession.revision, {
                        action: "SCSEM_UPDATER_ANALYZE_ERROR",
                        analysisOperationId: failedAnalysisLease.operationId,
                        affectedPayload: {
                            before: {
                                status: previousStatus,
                                analysisLease: failedAnalysisLease,
                            },
                            after: {
                                status: updaterSession.status,
                                error: updaterSession.error,
                                analysisLease: null,
                            },
                        },
                        ...auditRequestContext(request),
                    });
                }
            } catch {
                // The session may not exist or may have advanced; never overwrite newer state.
            }
        }

        if (mutationError) {
            return NextResponse.json(mutationError, { status: mutationError.status });
        }

        return NextResponse.json(failure.response, { status: failure.status });
    }
}
