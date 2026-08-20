export type SCSEMSupplementalComparisonMode =
    | "ai"
    | "deterministic_fallback"
    | "no_delta"
    | "not_requested"
    | "failed";

export interface SCSEMSupplementalComparison {
    mode: SCSEMSupplementalComparisonMode;
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
}

export interface SCSEMAnalysisCoverage {
    totalRows: number;
    nistMappedRows: number;
    reviewedRows: number;
    unmappedRows: number;
    totalBatches: number;
    aiCompletedBatches: number;
    supplementalComparisonComplete: boolean;
    complete: boolean;
    blockers: string[];
}

type ComplianceBatchCoverage = {
    reviewedRowCount: number;
    nistMappedRowCount: number;
    unmappedRowCount: number;
    batchCount: number;
    completedBatchCount: number;
};

export function missingCompliancePromptEvidenceControlIds({
    requestedControlIds,
    pub1075ExcerptedControlIds,
    nistExcerptedControlIds,
}: {
    requestedControlIds: string[];
    pub1075ExcerptedControlIds: string[];
    nistExcerptedControlIds: string[];
}): string[] {
    const excerpted = new Set([
        ...pub1075ExcerptedControlIds,
        ...nistExcerptedControlIds,
    ]);
    return [...new Set(requestedControlIds)].filter((controlId) => !excerpted.has(controlId));
}

/**
 * Validate the comparison record rather than trusting its `complete` flag.
 * This keeps `review_ready` fail-closed if a future path records inconsistent
 * counts or labels an incomplete comparison as successful.
 */
export function isSupplementalComparisonComplete(
    comparison: SCSEMSupplementalComparison
): boolean {
    if (!comparison.complete || comparison.mode === "failed") return false;
    if (comparison.mode === "not_requested") {
        return comparison.applicabilityStatus === "not_requested" &&
            comparison.directSourceCount === 0 &&
            comparison.comparedDirectSourceCount === 0 &&
            comparison.candidateCount === 0 &&
            comparison.comparedCandidateCount === 0 &&
            comparison.rawProposalCount === 0 &&
            comparison.evidenceBoundProposalCount === 0;
    }
    if (comparison.applicabilityStatus === "not_applicable") {
        return comparison.mode === "no_delta" &&
            comparison.directSourceCount === 0 &&
            comparison.comparedDirectSourceCount === 0 &&
            comparison.candidateCount === 0 &&
            comparison.comparedCandidateCount === 0 &&
            comparison.rawProposalCount === 0 &&
            comparison.evidenceBoundProposalCount === 0;
    }
    if (comparison.directSourceCount <= 0) return false;
    if (
        comparison.candidateCount < 0 ||
        comparison.comparedDirectSourceCount < 0 ||
        comparison.comparedDirectSourceCount > comparison.directSourceCount ||
        comparison.comparedCandidateCount < 0 ||
        comparison.comparedCandidateCount > comparison.candidateCount ||
        comparison.rawProposalCount < 0 ||
        comparison.evidenceBoundProposalCount < 0 ||
        comparison.evidenceBoundProposalCount > comparison.rawProposalCount
    ) {
        return false;
    }
    if (comparison.comparedDirectSourceCount !== comparison.directSourceCount) return false;

    if (comparison.mode === "no_delta") {
        return comparison.candidateCount === 0 &&
            comparison.comparedCandidateCount === 0 &&
            comparison.rawProposalCount === 0 &&
            comparison.evidenceBoundProposalCount === 0;
    }

    return comparison.comparedCandidateCount === comparison.candidateCount &&
        comparison.evidenceBoundProposalCount === comparison.rawProposalCount;
}

export function buildSCSEMAnalysisCoverage({
    totalRows,
    compliance,
    uncoveredControlIdCount,
    benchmarkLookupError,
    supplementalComparison,
    additionalBlockers = [],
}: {
    totalRows: number;
    compliance: ComplianceBatchCoverage;
    uncoveredControlIdCount: number;
    benchmarkLookupError?: string;
    supplementalComparison: SCSEMSupplementalComparison;
    additionalBlockers?: string[];
}): SCSEMAnalysisCoverage {
    const supplementalComparisonComplete = isSupplementalComparisonComplete(
        supplementalComparison
    );
    const blockers = [
        compliance.completedBatchCount < compliance.batchCount
            ? `${compliance.batchCount - compliance.completedBatchCount} compliance batch(es) did not complete evidence-grounded AI comparison`
            : null,
        compliance.unmappedRowCount > 0
            ? `${compliance.unmappedRowCount} row(s) have no normalized NIST control identifier`
            : null,
        uncoveredControlIdCount > 0
            ? `${uncoveredControlIdCount} requested control identifier(s) lack exact Pub 1075 or NIST coverage`
            : null,
        supplementalComparison.mode !== "not_requested" && benchmarkLookupError
            ? `Configured supplemental-source lookup unavailable: ${benchmarkLookupError}`
            : null,
        supplementalComparison.mode !== "not_requested" &&
            supplementalComparison.applicabilityStatus === "review_required" &&
            supplementalComparison.directSourceCount === 0
            ? "No direct applicable supplemental source was validated and the pinned registry does not record a not-applicable determination"
            : null,
        supplementalComparison.mode !== "not_requested" && supplementalComparison.directSourceCount > 0 && !supplementalComparisonComplete
            ? `Supplemental source comparison did not complete: ${supplementalComparison.reason}`
            : null,
        ...additionalBlockers.map((blocker) => blocker.trim()).filter(Boolean),
    ].filter((value): value is string => Boolean(value));

    return {
        totalRows,
        nistMappedRows: compliance.nistMappedRowCount,
        reviewedRows: compliance.reviewedRowCount,
        unmappedRows: compliance.unmappedRowCount,
        totalBatches: compliance.batchCount,
        aiCompletedBatches: compliance.completedBatchCount,
        supplementalComparisonComplete,
        complete: blockers.length === 0,
        blockers,
    };
}
