import * as assert from "node:assert/strict";
import {
    buildSCSEMAnalysisCoverage,
    isSupplementalComparisonComplete,
    missingCompliancePromptEvidenceControlIds,
    type SCSEMSupplementalComparison,
} from "../src/lib/scsem-analysis-coverage";

assert.deepEqual(missingCompliancePromptEvidenceControlIds({
    requestedControlIds: ["AC-2", "AC-2", "AU-2", "CM-6"],
    pub1075ExcerptedControlIds: ["AC-2"],
    nistExcerptedControlIds: ["CM-6"],
}), ["AU-2"]);

const baseComparison: SCSEMSupplementalComparison = {
    mode: "ai",
    complete: true,
    candidateOnly: true,
    applicabilityStatus: "review_required",
    directSourceCount: 1,
    comparedDirectSourceCount: 1,
    candidateCount: 12,
    comparedCandidateCount: 12,
    rawProposalCount: 3,
    evidenceBoundProposalCount: 3,
    reason: "test comparison",
};

const compliance = {
    reviewedRowCount: 50,
    nistMappedRowCount: 50,
    unmappedRowCount: 0,
    batchCount: 2,
    completedBatchCount: 2,
};

function coverage(supplementalComparison: SCSEMSupplementalComparison) {
    return buildSCSEMAnalysisCoverage({
        totalRows: 50,
        compliance,
        uncoveredControlIdCount: 0,
        supplementalComparison,
    });
}

assert.equal(isSupplementalComparisonComplete(baseComparison), true);
assert.equal(coverage(baseComparison).complete, true);

const deterministic: SCSEMSupplementalComparison = {
    ...baseComparison,
    mode: "deterministic_fallback",
    rawProposalCount: 12,
    evidenceBoundProposalCount: 12,
};
assert.equal(coverage(deterministic).complete, true);

const noDelta: SCSEMSupplementalComparison = {
    ...baseComparison,
    mode: "no_delta",
    candidateCount: 0,
    comparedCandidateCount: 0,
    rawProposalCount: 0,
    evidenceBoundProposalCount: 0,
};
assert.equal(coverage(noDelta).complete, true);

const silentlyPartial: SCSEMSupplementalComparison = {
    ...baseComparison,
    comparedCandidateCount: 11,
};
assert.equal(isSupplementalComparisonComplete(silentlyPartial), false);
assert.equal(coverage(silentlyPartial).complete, false);
assert.match(coverage(silentlyPartial).blockers.join(" "), /did not complete/);

const skippedDirectSource: SCSEMSupplementalComparison = {
    ...baseComparison,
    directSourceCount: 2,
    comparedDirectSourceCount: 1,
};
assert.equal(isSupplementalComparisonComplete(skippedDirectSource), false);
assert.equal(coverage(skippedDirectSource).complete, false);

const unboundFallback: SCSEMSupplementalComparison = {
    ...deterministic,
    evidenceBoundProposalCount: 11,
};
assert.equal(isSupplementalComparisonComplete(unboundFallback), false);
assert.equal(coverage(unboundFallback).complete, false);

const inconsistentNoDelta: SCSEMSupplementalComparison = {
    ...noDelta,
    candidateCount: 1,
};
assert.equal(isSupplementalComparisonComplete(inconsistentNoDelta), false);

const failed: SCSEMSupplementalComparison = {
    ...baseComparison,
    mode: "failed",
    complete: false,
};
assert.equal(coverage(failed).complete, false);

const noDirectSource: SCSEMSupplementalComparison = {
    ...failed,
    directSourceCount: 0,
    comparedDirectSourceCount: 0,
    candidateCount: 0,
    comparedCandidateCount: 0,
    rawProposalCount: 0,
    evidenceBoundProposalCount: 0,
};
const noDirectCoverage = coverage(noDirectSource);
assert.equal(noDirectCoverage.complete, false);
assert.match(noDirectCoverage.blockers.join(" "), /No direct applicable/);

process.stdout.write("SCSEM supplemental comparison coverage tests passed.\n");
