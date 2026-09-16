import type { CISBenchmarkRecommendation } from "@/lib/cis-benchmark-xlsx";

export const CIS_BOOTSTRAP_TARGET_SHEET = "General App Test Cases";

export interface CISBootstrapStructuralBaseline {
    sourceFileName: string;
    sourceUrl: string;
    sourceSha256: string;
    sourceVersion: string | null;
    targetSheet: string;
}

export { buildCISBootstrapBlankWorkbook } from "@/lib/scsem-cis-blank-workbook";

function safeRecommendationId(value: string): string {
    return value
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "RECOMMENDATION";
}

export function buildCISBootstrapChanges({
    recommendations,
    workbenchId,
    benchmarkTitle,
    benchmarkVersion,
    profile,
    sourceSha256,
}: {
    recommendations: CISBenchmarkRecommendation[];
    workbenchId: number;
    benchmarkTitle: string;
    benchmarkVersion: string;
    profile: string;
    sourceSha256?: string;
}) {
    if (recommendations.length > 5000) throw new Error("CIS bootstrap supports at most 5000 selected recommendations; no session was created.");
    return recommendations.map((recommendation) => ({
        action: "addControl" as const,
        testId: `NEW-CIS-${workbenchId}-${safeRecommendationId(recommendation.recommendation)}`,
        targetSheet: CIS_BOOTSTRAP_TARGET_SHEET,
        field: "newControl",
        currentValue: "Not present in the blank working-draft SCSEM.",
        proposedValue: `CIS ${recommendation.recommendation}: ${recommendation.title}`,
        reason:
            `Bootstrap candidate from ${benchmarkTitle} v${benchmarkVersion}, profile ${profile}, ` +
            `CIS WorkBench ID ${workbenchId}. The recommendation is direct licensed benchmark evidence, ` +
            "but it is not yet an IRS requirement or an applicability decision. Map Publication 1075/NIST, " +
            "select an exact IRS issue code, and edit SCSEM wording before approval.",
        confidence: "needs_review",
        newControl: {
            nistId: null,
            nistControlName: null,
            testMethod: recommendation.assessmentStatus || "Manual",
            sectionTitle: recommendation.title,
            description: recommendation.description || recommendation.title,
            testProcedures: recommendation.audit,
            expectedResults: null,
            findingStatement: recommendation.title
                ? `The expected result was not met for ${recommendation.title}.`
                : null,
            criticality: null,
            issueCode: null,
            cisBenchmarkRef: recommendation.section,
            recommendationNum: recommendation.recommendation,
            rationale: recommendation.rationale,
            impact: recommendation.impact,
            remediationProcedure: recommendation.remediation,
        },
        sourceEvidence: {
            evidenceTier: "direct",
            sourceRelationship: "direct",
            cisRecommendation: recommendation.recommendation,
            cisProfile: profile,
            stigRecommendation: null,
            stigProfile: null,
            sourceWorkbenchId: workbenchId,
            sourceBenchmarkTitle: benchmarkTitle,
            sourceSheet: recommendation.sourceSheet,
            sourceRow: recommendation.sourceRow,
            sourceSha256: sourceSha256 || null,
            sourceBenchmarkVersion: benchmarkVersion,
            sourceAudit: recommendation.audit,
            sourceRemediation: recommendation.remediation,
            sourceTitle: recommendation.title,
            sourceDescription: recommendation.description,
            pub1075Version: null,
            nistVersion: null,
            bootstrapDraft: true,
        },
    }));
}
