import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as XLSX from "xlsx";
import {
    readSCSEMIssueCodeCatalog,
    resolveSCSEMIssueCodeSelection,
    SCSEMIssueCodeError,
} from "../src/lib/scsem-issue-codes";
import { approvedProposalValidationErrors } from "../src/lib/scsem-proposal-validation";
import type { SCSEMUpdaterChange } from "../src/lib/scsem-updater-store";
import { scsemUpdaterAuditChange } from "../src/lib/scsem-change-audit";

XLSX.set_fs(fs);

const corpusDirectory = path.join(process.cwd(), "data", "scsems", "current");
const files = fs.readdirSync(corpusDirectory)
    .filter((fileName) => fileName.toLowerCase().endsWith(".xlsx"))
    .sort();
assert.equal(files.length, 58, "Expected the 58 pinned individual IRS SCSEM files");

for (const fileName of files) {
    const catalog = readSCSEMIssueCodeCatalog(path.join(corpusDirectory, fileName));
    assert.ok(catalog.size >= 547, `${fileName}: issue-code catalog is unexpectedly small`);
    assert.ok(catalog.size <= 566, `${fileName}: issue-code catalog is unexpectedly large`);

    const other = resolveSCSEMIssueCodeSelection(catalog, "hac100");
    assert.equal(other.issueCode, "HAC100");
    assert.equal(other.issueCodeDescription, "HAC100: Other");
    assert.equal(other.entries[0].weight, 2);

    const twoCodes = [...catalog.keys()].slice(0, 2);
    const multiple = resolveSCSEMIssueCodeSelection(catalog, twoCodes.join("\r\n"));
    assert.equal(multiple.issueCode, twoCodes.join("\n"));
    assert.equal(multiple.entries.length, 2);
    for (const entry of multiple.entries) {
        assert.ok(multiple.issueCodeDescription.includes(`${entry.code}: ${entry.description}`));
    }

    assert.throws(
        () => resolveSCSEMIssueCodeSelection(catalog, "HZZ999"),
        (error: unknown) => error instanceof SCSEMIssueCodeError && /not present/i.test(error.message)
    );
    assert.throws(
        () => resolveSCSEMIssueCodeSelection(catalog, "HAC100\nHAC100"),
        (error: unknown) => error instanceof SCSEMIssueCodeError && /duplicate/i.test(error.message)
    );
    assert.throws(
        () => resolveSCSEMIssueCodeSelection(catalog, "HAC100,HAU1"),
        (error: unknown) => error instanceof SCSEMIssueCodeError && /format/i.test(error.message)
    );
}

const completeNewControlChange: SCSEMUpdaterChange = {
    id: "issue-code-proposal-contract",
    status: "APPROVED",
    action: "addControl",
    testId: "SOURCE-ROW",
    targetSheet: "Test Cases",
    field: "newControl",
    currentValue: "Not present",
    proposedValue: "Add a new canonical control",
    reason: "Issue-code proposal validation regression.",
    newControl: {
        nistId: "AC-2",
        sectionTitle: "Account management",
        description: "Define the canonical control objective.",
        testProcedures: "Examine the approved account-management configuration.",
        expectedResults: "The approved account-management configuration is enforced.",
        findingStatement: "The approved account-management configuration is not enforced.",
        criticality: "Moderate",
        issueCode: "HAC100",
    },
};
assert.ok(
    !approvedProposalValidationErrors(completeNewControlChange)
        .some((error) => error.includes("issueCode")),
    "A populated issue code should satisfy the general proposal contract"
);
assert.ok(
    approvedProposalValidationErrors({
        ...completeNewControlChange,
        newControl: { ...completeNewControlChange.newControl, issueCode: null },
    }).includes("newControl.issueCode must not be blank"),
    "An add-control proposal must not be approvable without an issue code"
);
assert.ok(
    !approvedProposalValidationErrors({
        ...completeNewControlChange,
        newControl: { ...completeNewControlChange.newControl, findingStatement: null },
    }).some((error) => error.includes("findingStatement")),
    "Finding text is conditionally required by the selected physical template schema"
);

const longReviewerDescription = "Reviewer-authored canonical objective. ".repeat(160);
const auditedChange = scsemUpdaterAuditChange({
    ...completeNewControlChange,
    newControl: {
        ...completeNewControlChange.newControl,
        description: longReviewerDescription,
        rationale: "Retain this complete reviewer rationale in the audit record.",
    },
});
assert.deepEqual(
    auditedChange.newControl,
    {
        ...completeNewControlChange.newControl,
        description: longReviewerDescription,
        rationale: "Retain this complete reviewer rationale in the audit record.",
    },
    "The append-only review audit must retain the complete bounded newControl payload"
);
assert.ok(
    !String(auditedChange.newControl?.description).includes("[Truncated for audit log storage]"),
    "Reviewer-authored newControl fields must not be truncated in the audit record"
);

const changesRoute = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/scsem-updater/[id]/changes/route.ts"),
    "utf8"
);
for (const requiredGuard of [
    "requireScsemSteward",
    "requireSCSEMUpdaterExpectedRevision",
    "assertSCSEMUpdaterRevision",
    "assertSCSEMUpdaterSourceIntegrity",
    "readSCSEMIssueCodeCatalog",
    "resolveSCSEMIssueCodeSelection",
    "await writeSCSEMUpdaterSession(updaterSession, expectedRevision, {",
    "scsemUpdaterRouteFailureDetails",
    "scsemUpdaterAuditChange",
    "readSCSEMNewControlTargetSchemas",
    "newControl.findingStatement must not be blank for the selected template sheet",
]) {
    assert.ok(changesRoute.includes(requiredGuard), `Changes route is missing ${requiredGuard}`);
}
assert.ok(
    changesRoute.indexOf("assertSCSEMUpdaterSourceIntegrity") <
    changesRoute.indexOf("readSCSEMIssueCodeCatalog(verifiedSource.absolutePath)"),
    "Issue-code approval must verify the exact uploaded source before reading its catalog"
);
assert.ok(
    changesRoute.includes('"issueCode"') && changesRoute.includes("EDITABLE_NEW_CONTROL_KEYS"),
    "Reviewer issueCode selection must be an explicitly allowed newControl edit"
);

const analyzeRoute = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/scsem-updater/[id]/analyze/route.ts"),
    "utf8"
);
assert.ok(
    (analyzeRoute.match(/issueCode:\s*null/g) || []).length >= 2 &&
    (analyzeRoute.match(/"issueCode": null/g) || []).length >= 2,
    "Every model schema and generated add-control path must leave issueCode for reviewer selection"
);
assert.ok(
    (analyzeRoute.match(/Leave newControl\.issueCode null/g) || []).length >= 2,
    "Both direct and adjacent model prompts must prohibit invented issue codes"
);
assert.ok(
    (analyzeRoute.match(/newControl\.findingStatement as canonical template text/g) || []).length >= 2,
    "Both direct and adjacent model prompts must distinguish standard finding text from agency responses"
);

const updaterUi = fs.readFileSync(
    path.join(process.cwd(), "src/components/scsem-updater.tsx"),
    "utf8"
);
const updaterClientDto = fs.readFileSync(
    path.join(process.cwd(), "src/lib/scsem-updater-client-session.ts"),
    "utf8"
);
assert.ok(
    updaterClientDto.includes("issueCode?: string | null") &&
    updaterClientDto.includes("findingStatement?: string | null") &&
    updaterUi.includes("SCSEMUpdaterClientChange as UpdaterChange") &&
    updaterUi.includes("IRS Issue Code (required; one per line)") &&
    updaterUi.includes("Standard Finding Statement (required when this template has the column)") &&
    updaterUi.includes("Automation does not choose this risk mapping"),
    "The exact client DTO and reviewer UI must expose and explain issue-code selection"
);

process.stdout.write(
    `Verified exact Issue Code Table schemas and selections for all ${files.length} pinned IRS SCSEMs.\n`
);
