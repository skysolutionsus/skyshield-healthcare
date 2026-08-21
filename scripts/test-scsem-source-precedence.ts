import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
    annotateSCSEMStrictnessConflicts,
    dedupeSCSEMProposalsPreservingAuthorities,
    fairlyLimitSCSEMProposals,
    strictnessApprovalErrors,
} from "../src/lib/scsem-source-precedence";
import { addIdsToChanges } from "../src/lib/scsem-updater-store";

function proposal(
    id: string,
    sourceEvidence: Record<string, unknown>,
    proposedValue: string
) {
    return {
        id,
        status: "PENDING" as const,
        action: "updateField" as const,
        targetSheet: "Linux Test Cases",
        testId: "LINUX-42",
        field: "expectedResults",
        currentValue: "Password length is at least 8 characters.",
        proposedValue,
        reason: "Source-specific proposal.",
        confidence: "needs_review",
        sourceEvidence,
    };
}

function main(): void {
    const pub = proposal("pub", {
        evidenceTier: "compliance",
        complianceSource: "IRS Publication 1075",
        pub1075ControlId: "IA-5",
        pub1075Version: "2024",
    }, "Password length is at least 12 characters.");
    const cis = proposal("cis", {
        evidenceTier: "direct",
        sourceKind: "CIS",
        sourceWorkbenchId: 321,
        cisRecommendation: "5.4.1",
        cisProfile: "Level 1",
    }, "Password length is at least 14 characters.");
    const stig = proposal("stig", {
        evidenceTier: "direct",
        sourceKind: "STIG",
        stigBenchmarkId: "RHEL_9_STIG",
        stigRuleId: "SV-123_rule",
    }, "Password length is at least 15 characters.");

    const deduped = dedupeSCSEMProposalsPreservingAuthorities([
        pub,
        { ...pub, id: "pub-duplicate" },
        cis,
        stig,
    ]);
    assert.deepEqual(
        deduped.map((change) => change.id),
        ["pub", "cis", "stig"],
        "a Pub proposal must not erase CIS/STIG proposals for the same cell, while duplicate emissions from the same authority are removed"
    );

    const annotated = annotateSCSEMStrictnessConflicts(deduped);
    for (const change of annotated) {
        assert.equal(change.confidence, "needs_review");
        assert.equal(change.sourceEvidence?.strictnessSelectionRequired, true);
        assert.equal(change.sourceEvidence?.competingAuthorityCount, 3);
        assert.match(change.reason, /Strictest-control review required/);
    }
    assert.deepEqual(
        annotated[0].sourceEvidence?.competingAuthorities,
        ["IRS Publication 1075", "CIS Benchmark", "Public DISA STIG"]
    );

    assert.deepEqual(
        strictnessApprovalErrors({
            candidate: annotated[0],
            allChanges: annotated,
            approvingIds: new Set(["pub", "cis"]),
        }).length,
        1,
        "bulk approval must not apply competing values to the same workbook cell"
    );
    assert.deepEqual(
        strictnessApprovalErrors({
            candidate: annotated[2],
            allChanges: [{ ...annotated[0], status: "APPROVED" }, annotated[1], annotated[2]],
            approvingIds: new Set(["stig"]),
        }).length,
        1,
        "a second authority cannot be approved after another proposal for the same cell"
    );
    assert.deepEqual(
        strictnessApprovalErrors({
            candidate: annotated[2],
            allChanges: annotated,
            approvingIds: new Set(["stig"]),
        }),
        [],
        "one explicitly selected strictness proposal can be approved"
    );

    const addCis = {
        ...cis,
        id: "same-id",
        action: "addControl" as const,
        testId: "NEW-CIS-5.4.1",
        field: "newControl",
        proposedValue: "Require strong password length",
        newControl: { sectionTitle: "Password length requirement", nistId: null },
    };
    const addStig = {
        ...stig,
        id: "same-id",
        action: "addControl" as const,
        testId: "NEW-STIG-SV-123",
        field: "newControl",
        proposedValue: "Require stronger password length",
        newControl: { sectionTitle: "Password length requirement", nistId: "IA-5" },
    };
    const annotatedAdds = annotateSCSEMStrictnessConflicts([addCis, addStig]);
    assert.equal(annotatedAdds[0].sourceEvidence?.strictnessSelectionRequired, true);
    assert.equal(
        strictnessApprovalErrors({
            candidate: annotatedAdds[0],
            allChanges: annotatedAdds,
            approvingIds: new Set(["same-id"]),
        }).length,
        1,
        "duplicate client/model IDs must not bypass new-control strictness exclusion"
    );

    const serverOwned = addIdsToChanges([
        { ...addCis, status: "APPROVED" },
        { ...addStig, status: "APPROVED" },
    ]);
    assert.notEqual(serverOwned[0].id, serverOwned[1].id);
    assert.ok(serverOwned.every((change) => change.status === "PENDING"));

    const manyCis = Array.from({ length: 5000 }, (_, index) => ({ ...cis, id: `cis-${index}` }));
    const fair = fairlyLimitSCSEMProposals([...manyCis, stig], 5000);
    assert.equal(fair.length, 5000);
    assert.ok(fair.some((change) => change.id === "stig"), "hard caps must not starve STIG behind CIS proposals");

    const atomic = fairlyLimitSCSEMProposals([
        ...annotatedAdds,
        { ...pub, id: "pub-single", testId: "LINUX-43" },
        { ...cis, id: "cis-single", testId: "LINUX-44" },
    ], 2);
    const retainedConflictMembers = atomic.filter((change) =>
        change.sourceEvidence?.strictnessGroupId === annotatedAdds[0].sourceEvidence?.strictnessGroupId
    );
    assert.ok(
        retainedConflictMembers.length === 0 || retainedConflictMembers.length === annotatedAdds.length,
        "a hard cap must retain or omit a strictness group atomically"
    );

    const routeSource = fs.readFileSync(
        path.join(process.cwd(), "src/app/api/scsem-updater/[id]/analyze/route.ts"),
        "utf8"
    );
    assert.doesNotMatch(
        routeSource,
        /buildMissingPub1075ControlCandidates/,
        "normal analysis must not create blanket new test cases from unmatched document sections"
    );
    assert.match(routeSource, /CIS_LICENSE_NOT_CONFIGURED/);
    assert.match(routeSource, /CIS_REQUIRED_WORKBOOK_UNAVAILABLE/);
    assert.match(routeSource, /rawProposalCount: uncappedDirectProposalCount/);
    assert.match(routeSource, /evidenceBoundProposalCount: retainedDirectProposalCount/);
    assert.match(routeSource, /publicDisaEvidence\.complete/);
    assert.match(routeSource, /all candidates were compared deterministically instead of claiming a partial AI strictness comparison/);
    assert.match(routeSource, /did not start a partial analysis under the full-source label/);
    assert.match(routeSource, /License authentication or catalog validation failed, so no partial analysis was started/);
    assert.ok(
        routeSource.indexOf("readSCSEMUpdaterSessionForUser(id, user)") < routeSource.indexOf("const token = await getCISToken()") &&
        routeSource.indexOf("const token = await getCISToken()") < routeSource.indexOf("claimSCSEMAnalysisLease("),
        "session authorization and live CIS authentication/catalog validation must complete before an analysis lease is claimed"
    );

    console.log("SCSEM source precedence, strictness conflict, CIS fail-closed, and no-redundant-section tests passed.");
}

main();
