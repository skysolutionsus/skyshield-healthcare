import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditRequestContext, logAudit, truncateAuditText } from "@/lib/audit";
import {
    fetchAllBenchmarkExcelFiles,
    fetchAllBenchmarks,
    getCISToken,
} from "@/lib/cis-api";
import {
    recommendationEvidenceSummary,
    type CISBenchmarkRecommendation,
    type SelectedCISProfile,
} from "@/lib/cis-benchmark-xlsx";
import {
    resolveAdjacentSCSEMBenchmarkSources,
    resolveSCSEMBenchmarkSourcesDetailed,
    type BenchmarkQueryResolutionDiagnostic,
    type ResolvedBenchmarkKind,
    type ResolvedBenchmarkSource,
} from "@/lib/scsem-benchmark-resolver";
import {
    addIdsToChanges,
    readSCSEMUpdaterSessionForUser,
    resolveUpdaterPath,
    writeSCSEMUpdaterSession,
    type SCSEMUpdaterAuditSource,
} from "@/lib/scsem-updater-store";
import { parseSCSEMFile, type ParsedSCSEM } from "@/lib/xlsx-parser";
import {
    evaluateOfficialSCSEMReference,
    resolveOfficialReferencePath,
} from "@/lib/scsem-official-reference";
import {
    buildComparisonCandidates,
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
import { generateBifrostText, getConfiguredBifrostModel } from "@/lib/ai/bifrost";

export const runtime = "nodejs";

const UPDATER_CANDIDATE_LIMITS = {
    maxUpdateCandidates: 25,
    maxNewControlCandidates: 15,
};
const MAX_UPDATER_CHANGES = 25;
const AI_CONTROL_LIMIT = Number(process.env.SCSEM_UPDATER_AI_CONTROL_LIMIT || 500);
const AI_PROMPT_CHAR_LIMIT = Number(process.env.SCSEM_UPDATER_AI_PROMPT_CHAR_LIMIT || 90000);
const AI_TIMEOUT_MS = Number(process.env.SCSEM_UPDATER_AI_TIMEOUT_MS || 25000);
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
const MAX_COMPLIANCE_BATCHES = Math.max(
    1,
    Math.min(Number(process.env.SCSEM_UPDATER_COMPLIANCE_MAX_BATCHES || 6), 12)
);
const COMPLIANCE_BATCH_UNIQUE_CONTROL_LIMIT = Math.max(
    4,
    Math.min(Number(process.env.SCSEM_UPDATER_COMPLIANCE_BATCH_UNIQUE_CONTROLS || 11), 12)
);
const MAX_COMPLIANCE_CHANGES_PER_BATCH = 6;

function changePreview(changes: any[]) {
    return changes.slice(0, 25).map((change) => ({
        id: change.id,
        action: change.action,
        testId: change.testId,
        targetSheet: change.targetSheet,
        field: change.field,
        status: change.status,
        confidence: change.confidence,
        currentValue: truncateAuditText(change.currentValue, 1200),
        proposedValue: truncateAuditText(change.proposedValue, 2400),
        reason: truncateAuditText(change.reason, 1600),
        sourceEvidence: change.sourceEvidence || null,
    }));
}

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
    return `${source.kind} WB ${source.downloaded.snapshot.workbenchId} ${source.downloaded.snapshot.benchmarkTitle} (${source.selectedProfile.profile})`;
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
        cisRecommendation: candidate.sourceKind === "CIS" ? candidate.recommendation.recommendation : null,
        cisProfile: candidate.sourceKind === "CIS" ? candidate.sourceProfile : null,
        stigRecommendation: candidate.sourceKind === "STIG" ? candidate.recommendation.recommendation : null,
        stigProfile: candidate.sourceKind === "STIG" ? candidate.sourceProfile : null,
        sourceWorkbenchId: candidate.sourceWorkbenchId,
        sourceBenchmarkTitle: candidate.sourceBenchmarkTitle,
        pub1075Version,
        nistVersion: nistVersion || null,
    };
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
    const fallbackUpdates = [...updateCandidates].sort((a, b) => b.score - a.score);
    const fallbackNewControls = [...newControlCandidates];

    const changes: any[] = [];

    for (const candidate of fallbackUpdates) {
        if (changes.length >= 15) break;
        const selectedField = chooseFallbackField(candidate.control, candidate.recommendation);
        if (!selectedField) continue;

        changes.push({
            action: "updateField",
            testId: candidate.control.testId,
            targetSheet: candidate.control.sourceSheet,
            field: selectedField.field,
            currentValue: selectedField.currentValue.slice(0, 1200),
            proposedValue: selectedField.proposedValue,
            reason: `${candidate.sourceKind} ${candidate.recommendation.recommendation} (${candidate.sourceProfile}, WB ${candidate.sourceWorkbenchId}) materially differs from the uploaded SCSEM row. The updater selected ${selectedField.field} because the benchmark provides supplemental hardening evidence after applying ${pub1075.version} first and NIST ${pub1075.nist?.version || "SP 800-53"} only where Pub 1075 has no control section.`,
            confidence: "needs_review",
            sourceEvidence: sourceEvidence(candidate, pub1075.version, pub1075.nist?.version),
        });
    }

    for (const candidate of fallbackNewControls) {
        if (changes.length >= MAX_UPDATER_CHANGES) break;
        const recommendation = candidate.recommendation;
        changes.push({
            action: "addControl",
            testId: `NEW-${candidate.sourceKind}-${candidate.sourceWorkbenchId}-${safeRecommendationId(recommendation.recommendation)}`,
            targetSheet: candidate.targetSheet,
            field: "newControl",
            currentValue: "Not present in current SCSEM",
            proposedValue: `${candidate.sourceKind} ${recommendation.recommendation}: ${recommendation.title}`,
            reason: `${candidate.sourceKind} ${recommendation.recommendation} appears in ${candidate.sourceBenchmarkTitle} (${candidate.sourceProfile}, WB ${candidate.sourceWorkbenchId}) but was not mapped in the uploaded SCSEM. It is a reviewer-gated supplemental hardening candidate after applying ${pub1075.version} first and NIST ${pub1075.nist?.version || "SP 800-53"} only as fallback.`,
            confidence: "needs_review",
            newControl: {
                nistId: null,
                nistControlName: null,
                testMethod: recommendation.assessmentStatus || "Manual",
                sectionTitle: recommendation.title,
                description: recommendation.description,
                testProcedures: recommendation.audit,
                expectedResults: recommendation.defaultValue || recommendation.audit,
                criticality: "Moderate",
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
        summary: `Generated deterministic supplemental hardening items for ${technology}${fallbackReason ? ` because ${fallbackReason}` : ""}. Each item is marked needs_review and follows the ${pub1075.version}-first, NIST-fallback source hierarchy.`,
        changes,
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
                currentChars + estimatedChars > COMPLIANCE_BATCH_CHAR_LIMIT ||
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
    return batches.slice(0, MAX_COMPLIANCE_BATCHES);
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
    const pubIds = new Set(evidence.pub1075.controlIds);
    const nistIds = new Set(evidence.nist.controlIds);

    return changes.map((change) => {
        const matches = controls.filter((control) => control.testId === change.testId);
        const control = matches[0];
        const controlId = normalizeNistControlId(control?.nistId);
        const usesPub1075 = Boolean(controlId && pubIds.has(controlId));
        const usesNistFallback = Boolean(controlId && !usesPub1075 && nistIds.has(controlId));

        return {
            ...change,
            targetSheet: change.targetSheet || (matches.length === 1 ? control?.sourceSheet : undefined),
            sourceEvidence: {
                ...(change.sourceEvidence || {}),
                evidenceTier: "compliance",
                complianceSource: usesPub1075
                    ? "IRS Publication 1075"
                    : usesNistFallback
                        ? "NIST SP 800-53 fallback"
                        : "Compliance evidence",
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
    const pubIds = new Set(evidence.pub1075.controlIds);
    const nistIds = new Set(evidence.nist.controlIds);
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

function dedupeProposedChanges(changes: any[]): any[] {
    const seen = new Set<string>();
    return changes.filter((change) => {
        const key = [
            change.action || "updateField",
            change.targetSheet || "",
            change.testId || "",
            change.field || "",
        ].join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
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
    if (batches.length === 0) {
        return {
            summary: `Compliance review found no normalized NIST control identifiers in the ${technology} SCSEM rows, so Pub 1075 and NIST evidence could not be mapped safely.`,
            changes: [],
            batchCount: 0,
            completedBatchCount: 0,
        };
    }

    const batchResults = await mapWithConcurrency(
        batches,
        COMPLIANCE_BATCH_CONCURRENCY,
        async (batch, batchIndex) => {
            const promptBudget = Math.max(24000, AI_PROMPT_CHAR_LIMIT - 12000);
            const controlEvidenceBudget = Math.min(
                COMPLIANCE_BATCH_CHAR_LIMIT,
                Math.max(9000, Math.floor(promptBudget * 0.46))
            );
            const controlEvidence = buildComplianceControlEvidence(batch, controlEvidenceBudget);
            const complianceEvidence = extractComplianceEvidence(
                batch.map((control) => control.nistId),
                {
                    maxTotalChars: Math.min(
                        40000,
                        Math.max(10000, promptBudget - controlEvidence.length)
                    ),
                }
            );
            if (!complianceEvidence.excerpts) {
                return {
                    summary: `Batch ${batchIndex + 1} had no mappable Pub 1075 or NIST SP 800-53 evidence.`,
                    changes: [],
                    analyzed: false,
                };
            }

            const prompt = `You are an IRS Safeguards SCSEM update analyst. Perform the primary compliance review using only the uploaded SCSEM rows and the authoritative evidence below.

Decision policy:
- IRS Publication 1075 is the first and governing source. When a Pub 1075 excerpt exists for a control, use it and do not let NIST or a benchmark weaken, replace, or override it.
- NIST SP 800-53 is fallback evidence only for controls where this evidence package explicitly says no Pub 1075 section was found.
- Existing IRS SCSEM rows remain the base source of truth.
- Propose an update only when the current row is materially incomplete, materially weaker, or materially inconsistent with the applicable compliance excerpt for the same control.
- Do not propose formatting-only, grammar-only, casing-only, numbering-only, or equivalent-wording changes.
- Do not rewrite a row merely because the authority uses different phrasing.
- Do not invent product-specific benchmark requirements. CIS and STIG are assessed separately as supplemental hardening evidence.
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
- IRS Publication 1075 local source: ${complianceEvidence.pub1075.sourcePath}
- NIST SP 800-53 fallback version: ${complianceEvidence.nist.version}
- NIST fallback local source: ${complianceEvidence.nist.sourcePath}
- Pub 1075-covered IDs: ${complianceEvidence.pub1075.controlIds.join(", ") || "None"}
- NIST-fallback IDs: ${complianceEvidence.nist.controlIds.join(", ") || "None"}

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
      "reason": "specific reason citing the Pub 1075 requirement, or the NIST fallback control only when no Pub 1075 section was supplied",
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
- Never use NIST fallback evidence for an ID listed under Pub 1075-covered IDs.
- Do not include markdown fences.`;

            if (prompt.length > AI_PROMPT_CHAR_LIMIT) {
                return {
                    summary: `Batch ${batchIndex + 1} exceeded the configured prompt limit after bounded evidence extraction.`,
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
                    system: "You generate precise JSON SCSEM recommendations using IRS Pub 1075 first and NIST SP 800-53 only as fallback evidence.",
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
    const changes = dedupeProposedChanges(batchResults.flatMap((result) => result.changes));
    const coverage = [
        `${batches.length} bounded batch(es)`,
        `${reviewedRowCount} highest-priority row(s) distributed across version/provider tabs`,
        `${completedBatchCount} completed with AI reasoning`,
        `${complianceOverview.pub1075.controlIds.length} control ID(s) mapped to Pub 1075`,
        `${complianceOverview.nist.controlIds.length} control ID(s) mapped to NIST fallback`,
    ].join(", ");

    return {
        summary: `Primary compliance review for ${technology}: ${coverage}. Generated ${changes.length} reviewer-gated proposal(s) before supplemental CIS/STIG hardening review.`,
        changes,
        batchCount: batches.length,
        completedBatchCount,
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
    const prompt = `You are an IRS Safeguards SCSEM update analyst. This uploaded workbook has no direct CIS SecureSuite or STIG benchmark Excel source. Perform an adjacent-source review using the uploaded SCSEM row text, IRS Publication 1075 excerpts, and explicitly labeled adjacent CIS/STIG benchmark patterns below.

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
- IRS Publication 1075 local source: ${pub1075.pub1075.sourcePath}
- NIST SP 800-53 fallback version: ${pub1075.nist.version}
- NIST fallback local source: ${pub1075.nist.sourcePath}

SCSEM ROWS FOR REVIEW:
${controlEvidence || "No SCSEM row text was available."}

ADJACENT BENCHMARK EVIDENCE:
${adjacentEvidence || "No adjacent benchmark recommendations were selected."}

COMPLIANCE EVIDENCE — PUB 1075 FIRST, NIST FALLBACK ONLY:
${pub1075.excerpts || "No Pub 1075 or NIST fallback excerpts were found for the referenced controls."}

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
        "stigRecommendation": "STIG recommendation number if STIG adjacent evidence applies, otherwise null",
        "stigProfile": "selected STIG profile if STIG adjacent evidence applies, otherwise null",
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
        "criticality": "Critical|Significant|Moderate|Limited|Informational",
        "cisBenchmarkRef": "Adjacent CIS/STIG section number",
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
- Do not include markdown fences.`;

    const emptyPayload = {
        summary: `No direct CIS or STIG benchmark source was found for ${technology}. Adjacent benchmark sources were selected for reviewer-only reasoning, but no adjacent-source changes were generated without AI reasoning.`,
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

    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        user = session.user as unknown as { id: string; organizationId: string };

        const updaterSession = readSCSEMUpdaterSessionForUser(id, user);
        updaterSession.status = "analyzing";
        updaterSession.error = undefined;
        writeSCSEMUpdaterSession(updaterSession);

        const originalPath = resolveUpdaterPath(updaterSession.originalFilePath);
        const uploadedParsed = parseSCSEMFile(originalPath);
        const officialReference = evaluateOfficialSCSEMReference(
            uploadedParsed,
            updaterSession.inferredTechnology,
            updaterSession.audit.uploadedSha256
        );
        const parsed = officialReference?.selectedAsBase
            ? parseSCSEMFile(resolveOfficialReferencePath(officialReference))
            : uploadedParsed;
        const controls = controlsFromParsedSCSEM(parsed);
        if (controls.length === 0) {
            throw new Error("No SCSEM test case controls were found in the uploaded workbook.");
        }

        // Start the governing compliance review before attempting any benchmark lookup.
        // This promise resolves independently, so CIS credentials, catalog availability,
        // or title/profile matching can never suppress Pub 1075/NIST analysis.
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

        let cisToken = "";
        let benchmarkLookupError: string | undefined;
        let allBenchmarks: Awaited<ReturnType<typeof fetchAllBenchmarks>> = [];
        let allExcelFiles: Awaited<ReturnType<typeof fetchAllBenchmarkExcelFiles>> = [];
        const downloadedBenchmarks = new Map<number, DownloadedBenchmark>();
        let resolvedSources: ResolvedBenchmarkSource[] = [];
        let benchmarkResolutionDiagnostics: BenchmarkQueryResolutionDiagnostic[] = [];

        try {
            cisToken = await getCISToken();
            [allBenchmarks, allExcelFiles] = await Promise.all([
                fetchAllBenchmarks(cisToken),
                fetchAllBenchmarkExcelFiles(cisToken),
            ]);
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
        } catch (error: any) {
            benchmarkLookupError = error?.message || "Unknown CIS benchmark lookup error";
            console.warn(
                "SCSEM updater benchmark lookup failed; continuing with compliance-first analysis.",
                error
            );
        }

        const updateCandidates: AnalysisUpdateCandidate[] = [];
        const newControlCandidates: AnalysisNewCandidate[] = [];

        for (const source of resolvedSources) {
            const scopedControls = controls.filter((control) =>
                source.matchedSheets.includes(control.sourceSheet || "")
            );
            if (scopedControls.length === 0) continue;

            const candidates = buildComparisonCandidates(
                scopedControls,
                source.selectedProfile.recommendations,
                UPDATER_CANDIDATE_LIMITS
            );
            const label = sourceLabel(source);

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
                targetSheet: source.matchedSheets[0],
            })));
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
        const stigSources = resolvedSources.filter((source) => source.kind === "STIG");
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
            } catch (error: any) {
                benchmarkLookupError = error?.message || "Adjacent CIS/STIG benchmark lookup failed";
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

        updaterSession.audit = {
            ...updaterSession.audit,
            pub1075Version: compliance.pub1075.version,
            pub1075SourcePath: compliance.pub1075.sourcePath,
            nistVersion: compliance.nist.version,
            nistSourcePath: compliance.nist.sourcePath,
            nistSourceUrl: compliance.nist.sourceUrl,
            complianceCoverage: {
                requested: compliance.requestedControlIds.length,
                pub1075: compliance.pub1075.controlIds.length,
                nistFallback: compliance.nist.controlIds.length,
                uncovered: compliance.uncoveredControlIds.length,
            },
            benchmarkLookupError,
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
        };

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
            const rawChanges = dedupeProposedChanges(addUnambiguousTargetSheets([
                ...(compliancePayload.changes || []),
                ...(adjacentPayload.changes || []),
            ], controls));
            const validChanges = addIdsToChanges(
                validateChanges(rawChanges, controls, MAX_UPDATER_CHANGES)
            );

            updaterSession.status = "review_ready";
            updaterSession.summary = [
                compliancePayload.summary,
                adjacentPayload.summary,
                benchmarkLookupError
                    ? `CIS/STIG lookup was unavailable (${benchmarkLookupError}); compliance results were still produced.`
                    : `No direct CIS or STIG workbook/profile matched ${updaterSession.inferredTechnology}; compliance review still completed.`,
            ].filter(Boolean).join(" ");
            updaterSession.changes = validChanges;
            updaterSession.history.push({
                at: new Date().toISOString(),
                action: "analyze",
                description: `Pub 1075-first/NIST-fallback compliance analysis completed without a direct CIS or STIG source and generated ${validChanges.length} proposed change(s) across ${compliancePayload.batchCount} bounded batch(es).`,
            });
            writeSCSEMUpdaterSession(updaterSession);
            await logAudit({
                organizationId: user.organizationId,
                userId: user.id,
                action: "SCSEM_UPDATER_ANALYZE",
                resourceType: "scsem_updater_session",
                resourceId: updaterSession.id,
                metadata: {
                    input: {
                        fileName: updaterSession.originalFileName,
                        inferredTechnology: updaterSession.inferredTechnology,
                        parsedControls: controls.length,
                        testCaseSheets: parsed.sheets
                            .filter((sheet) => sheet.sheetType === "test_cases")
                            .map((sheet) => sheet.sheetName),
                    },
                    output: {
                        summary: updaterSession.summary,
                        changeCount: validChanges.length,
                        changes: changePreview(validChanges),
                        candidateCounts: {
                            cisUpdates: 0,
                            cisNewControls: 0,
                            stigUpdates: 0,
                            stigNewControls: 0,
                            adjacentSources: adjacentSources.length,
                            adjacentRecommendations: adjacentCandidates.length,
                            complianceBatches: compliancePayload.batchCount,
                            completedComplianceBatches: compliancePayload.completedBatchCount,
                            complianceChanges: compliancePayload.changes.length,
                        },
                        benchmarkLookupError: benchmarkLookupError || null,
                        auditSources: updaterSession.audit,
                    },
                },
                ...auditRequestContext(request),
            });
            return NextResponse.json({ session: updaterSession });
        }

        const cisUpdateCandidates = updateCandidates.filter((candidate) => candidate.sourceKind === "CIS");
        const stigUpdateCandidates = updateCandidates.filter((candidate) => candidate.sourceKind === "STIG");
        const cisNewControlCandidates = newControlCandidates.filter((candidate) => candidate.sourceKind === "CIS");
        const stigNewControlCandidates = newControlCandidates.filter((candidate) => candidate.sourceKind === "STIG");

        if (updateCandidates.length === 0 && newControlCandidates.length === 0) {
            const compliancePayload = await compliancePayloadPromise;
            const validChanges = addIdsToChanges(validateChanges(
                dedupeProposedChanges(addUnambiguousTargetSheets(
                    compliancePayload.changes || [],
                    controls
                )),
                controls,
                MAX_UPDATER_CHANGES
            ));
            updaterSession.status = "review_ready";
            updaterSession.summary = `${compliancePayload.summary} No supplemental CIS or STIG deltas were detected.`;
            updaterSession.changes = validChanges;
            updaterSession.history.push({
                at: new Date().toISOString(),
                action: "analyze",
                description: `Compliance analysis completed across ${compliancePayload.batchCount} bounded batch(es); no supplemental CIS/STIG deltas were detected. Generated ${validChanges.length} proposed change(s).`,
            });
            writeSCSEMUpdaterSession(updaterSession);
            await logAudit({
                organizationId: user.organizationId,
                userId: user.id,
                action: "SCSEM_UPDATER_ANALYZE",
                resourceType: "scsem_updater_session",
                resourceId: updaterSession.id,
                metadata: {
                    input: {
                        fileName: updaterSession.originalFileName,
                        inferredTechnology: updaterSession.inferredTechnology,
                        parsedControls: controls.length,
                        testCaseSheets: parsed.sheets
                            .filter((sheet) => sheet.sheetType === "test_cases")
                            .map((sheet) => sheet.sheetName),
                    },
                    output: {
                        summary: updaterSession.summary,
                        changeCount: validChanges.length,
                        changes: changePreview(validChanges),
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
            return NextResponse.json({ session: updaterSession });
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
        const benchmarkSourceSummary = (sources: ResolvedBenchmarkSource[], kind: ResolvedBenchmarkKind) => sources.length > 0
            ? sources.map((source) => [
                `- Title: ${source.downloaded.snapshot.benchmarkTitle}`,
                `  WorkBench ID: ${source.downloaded.snapshot.workbenchId}`,
                `  Version: ${source.downloaded.snapshot.benchmarkVersion}`,
                `  Release date: ${source.downloaded.snapshot.releaseDate.toISOString().slice(0, 10)}`,
                `  Selected profile: ${source.selectedProfile.profile}`,
                `  Matched sheets: ${source.matchedSheets.join(", ")}`,
                `  Match query: ${source.matchQuery}`,
                `  Excel snapshot path: ${source.downloaded.snapshot.filePath}`,
                `  Excel SHA-256: ${source.downloaded.snapshot.sha256}`,
                `  Matched existing recommendations: ${source.sharedRecommendationCount}/${source.sheetRecommendationCount}`,
            ].join("\n")).join("\n")
            : `- No matching ${kind} Benchmark Excel workbook/profile was selected for this SCSEM technology.`;

        const prompt = `You are an IRS Safeguards SCSEM update analyst. Propose human-reviewable SCSEM workbook changes using only the evidence below.

Decision policy:
- IRS Publication 1075 is the first and governing compliance source.
- NIST SP 800-53 is fallback compliance evidence only for controls where no Pub 1075 section was found.
- CIS Benchmark Excel rows and STIG rows are supplemental security-hardening evidence.
- Pub 1075 always wins over NIST, CIS, or STIG for a covered control.
- If a NIST fallback requirement is stricter than CIS or STIG and Pub 1075 has no section for that control, propose NIST-aligned text.
- If CIS or STIG is stricter and does not conflict with the applicable Pub 1075 requirement or NIST fallback, propose the stricter CIS/STIG-aligned text.
- If CIS and STIG differ, propose the stricter secure setting when clear; otherwise mark confidence "needs_review".
- If strictness is ambiguous, include the item only when it is clearly useful for human review and mark confidence "needs_review".
- Existing IRS SCSEM rows remain the base source of truth.
- You may propose new SCSEM controls when the CIS or STIG row is missing from the uploaded SCSEM and appears security-relevant.
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

STIG Benchmark Sources:
${benchmarkSourceSummary(stigSources, "STIG")}

Compliance sources:
- IRS Publication 1075 version: ${pub1075.pub1075.version}
- IRS Publication 1075 local source: ${pub1075.pub1075.sourcePath}
- NIST SP 800-53 fallback version: ${pub1075.nist.version}
- NIST fallback local source: ${pub1075.nist.sourcePath}

CURRENT SCSEM ROWS MATCHED TO CIS CANDIDATES:
${cisUpdateEvidence || "None"}

POTENTIAL NEW CIS ROWS NOT PRESENT IN THE SCSEM:
${cisNewControlEvidence || "None"}

CURRENT SCSEM ROWS MATCHED TO STIG CANDIDATES:
${stigUpdateEvidence || "None"}

POTENTIAL NEW STIG ROWS NOT PRESENT IN THE SCSEM:
${stigNewControlEvidence || "None"}

COMPLIANCE EVIDENCE — PUB 1075 FIRST, NIST FALLBACK ONLY:
${pub1075.excerpts || "No Pub 1075 or NIST fallback excerpts were found for the candidate controls."}

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
      "reason": "specific reason citing Pub 1075 first, NIST only when it is the supplied fallback, and any supplemental CIS/STIG evidence used",
      "confidence": "high|medium|needs_review",
      "sourceEvidence": {
        "cisRecommendation": "CIS recommendation number if CIS evidence applies, otherwise null",
        "cisProfile": "selected CIS profile if CIS evidence applies, otherwise null",
        "stigRecommendation": "STIG recommendation number if STIG evidence applies, otherwise null",
        "stigProfile": "selected STIG profile if STIG evidence applies, otherwise null",
        "sourceWorkbenchId": "WorkBench ID from the evidence source",
        "sourceBenchmarkTitle": "benchmark title from the evidence source",
        "pub1075Version": "${pub1075.pub1075.version}",
        "nistVersion": "${pub1075.nist.version}"
      }
    },
    {
      "action": "addControl",
      "testId": "NEW-CIS-or-STIG-<recommendation>",
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
        "sectionTitle": "CIS or STIG recommendation title",
        "description": "SCSEM-ready description",
        "testProcedures": "SCSEM-ready audit/test procedure",
        "expectedResults": "SCSEM-ready expected result",
        "criticality": "Critical|Significant|Moderate|Limited|Informational",
        "cisBenchmarkRef": "CIS or STIG section number",
        "recommendationNum": "CIS or STIG recommendation number",
        "rationale": "SCSEM-ready rationale",
        "impact": "SCSEM-ready impact",
        "remediationProcedure": "SCSEM-ready remediation"
      },
      "sourceEvidence": {
        "cisRecommendation": "CIS recommendation number if CIS evidence applies, otherwise null",
        "cisProfile": "selected CIS profile if CIS evidence applies, otherwise null",
        "stigRecommendation": "STIG recommendation number if STIG evidence applies, otherwise null",
        "stigProfile": "selected STIG profile if STIG evidence applies, otherwise null",
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
- For updateField, only use Test IDs from CURRENT SCSEM ROWS MATCHED TO CIS CANDIDATES or CURRENT SCSEM ROWS MATCHED TO STIG CANDIDATES.
- For addControl, only use recommendation numbers from POTENTIAL NEW CIS ROWS or POTENTIAL NEW STIG ROWS.
- Do not claim Pub 1075 or NIST says something unless the corresponding excerpt is present above.
- Never use NIST fallback evidence for a control covered by a supplied Pub 1075 excerpt.
- Do not include markdown fences.`;

        let payload: any;
        const shouldUseAI = controls.length <= AI_CONTROL_LIMIT && prompt.length <= AI_PROMPT_CHAR_LIMIT;

        if (!shouldUseAI) {
            payload = buildFallbackPayload({
                technology: updaterSession.inferredTechnology,
                pub1075,
                fallbackReason: `the uploaded workbook has ${controls.length} parsed controls, so the updater used deterministic benchmark diffs to keep the interactive request within deploy limits`,
                updateCandidates,
                newControlCandidates,
            });
        } else {
            const abortController = new AbortController();
            const timeout = setTimeout(() => abortController.abort(), AI_TIMEOUT_MS);

            try {
                const responseText = await generateBifrostText({
                    model: getConfiguredBifrostModel("BIFROST_SCSEM_MODEL"),
                    maxTokens: 9000,
                    temperature: 0.15,
                    system: "You generate precise JSON SCSEM recommendations using IRS Pub 1075 first, NIST SP 800-53 only as fallback, and CIS/STIG as supplemental hardening evidence.",
                    prompt,
                    signal: abortController.signal,
                });
                payload = parseJsonResponse(responseText);
            } catch (error) {
                console.warn("SCSEM updater AI analysis failed; using deterministic fallback changes.", error);
                payload = buildFallbackPayload({
                    technology: updaterSession.inferredTechnology,
                    pub1075,
                    fallbackReason: error instanceof Error && error.name === "AbortError"
                        ? "the AI analysis exceeded the interactive timeout"
                        : "the AI response could not be used safely",
                    updateCandidates,
                    newControlCandidates,
                });
            } finally {
                clearTimeout(timeout);
            }
        }
        const compliancePayload = await compliancePayloadPromise;
        const combinedChanges = dedupeProposedChanges(addUnambiguousTargetSheets([
            ...(compliancePayload.changes || []),
            ...(payload.changes || []),
        ],
            controls
        ));
        const validChanges = addIdsToChanges(
            validateChanges(combinedChanges, controls, MAX_UPDATER_CHANGES)
        );

        updaterSession.status = "review_ready";
        updaterSession.summary = [
            compliancePayload.summary,
            payload.summary || `Supplemental CIS/STIG review generated for ${updaterSession.inferredTechnology}.`,
        ].filter(Boolean).join(" ");
        updaterSession.changes = validChanges;
        updaterSession.history.push({
            at: new Date().toISOString(),
            action: "analyze",
            description: `Pub 1075-first/NIST-fallback analysis completed across ${compliancePayload.batchCount} bounded compliance batch(es), followed by supplemental CIS/STIG review, and generated ${validChanges.length} proposed change(s).`,
        });
        writeSCSEMUpdaterSession(updaterSession);

        await logAudit({
            organizationId: user.organizationId,
            userId: user.id,
            action: "SCSEM_UPDATER_ANALYZE",
            resourceType: "scsem_updater_session",
            resourceId: updaterSession.id,
            metadata: {
                input: {
                    fileName: updaterSession.originalFileName,
                    inferredTechnology: updaterSession.inferredTechnology,
                    parsedControls: controls.length,
                    scsemVersion: parsed.metadata.version,
                    effectiveDate: parsed.metadata.effectiveDate,
                    aiUsed: shouldUseAI,
                },
                output: {
                    summary: updaterSession.summary,
                    changeCount: validChanges.length,
                    changes: changePreview(validChanges),
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

        return NextResponse.json({ session: updaterSession });
    } catch (error: any) {
        console.error("SCSEM updater analysis error:", error);
        try {
            const updaterSession = user
                ? readSCSEMUpdaterSessionForUser(id, user)
                : null;
            if (!updaterSession) throw new Error("SCSEM updater session not found.");
            updaterSession.status = "error";
            updaterSession.error = error.message || "Failed to analyze uploaded SCSEM workbook.";
            writeSCSEMUpdaterSession(updaterSession);
        } catch {
            // The session may not exist; the response below still carries the failure.
        }

        return NextResponse.json(
            { error: error.message || "Failed to analyze uploaded SCSEM workbook." },
            { status: 500 }
        );
    }
}
