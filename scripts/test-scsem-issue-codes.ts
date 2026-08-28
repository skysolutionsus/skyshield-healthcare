import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as XLSX from "xlsx";
import {
    auditSCSEMIssueCodes,
    readSCSEMIssueCodeCatalog,
    resolveSCSEMIssueCodeSelection,
    SCSEMIssueCodeError,
} from "../src/lib/scsem-issue-codes";
import {
    parseSCSEMFile,
    SCSEM_SHEET_ROW_LIMIT,
    type ParsedSCSEM,
} from "../src/lib/xlsx-parser";
import { approvedProposalValidationErrors } from "../src/lib/scsem-proposal-validation";
import type { SCSEMUpdaterChange } from "../src/lib/scsem-updater-store";
import { scsemUpdaterAuditChange } from "../src/lib/scsem-change-audit";

XLSX.set_fs(fs);

const corpusDirectory = path.join(process.cwd(), "data", "scsems", "current");
const files = fs.readdirSync(corpusDirectory)
    .filter((fileName) => fileName.toLowerCase().endsWith(".xlsx"))
    .sort();
assert.equal(files.length, 60, "Expected the 60 pinned individual IRS SCSEM files");

let auditedTestCaseRows = 0;
let auditedIssueCodeReferences = 0;
let surfacedCorpusDiscrepancies = 0;
let fixtureParsed: ParsedSCSEM | null = null;
let fixtureCatalog: ReturnType<typeof readSCSEMIssueCodeCatalog> | null = null;

for (const fileName of files) {
    const filePath = path.join(corpusDirectory, fileName);
    const catalog = readSCSEMIssueCodeCatalog(filePath);
    assert.ok(catalog.size >= 547, `${fileName}: issue-code catalog is unexpectedly small`);
    assert.ok(catalog.size <= 571, `${fileName}: issue-code catalog is unexpectedly large`);

    const parsed = parseSCSEMFile(filePath);
    const audit = auditSCSEMIssueCodes(parsed, catalog);
    assert.equal(audit.issueCodeTableEntries, catalog.size);
    assert.equal(audit.testCaseRows, parsed.totalControls);
    assert.equal(audit.errorCount, audit.findings.length + audit.truncatedFindingCount);
    assert.ok(audit.validIssueCodeReferences <= audit.issueCodeReferences);
    auditedTestCaseRows += audit.testCaseRows;
    auditedIssueCodeReferences += audit.issueCodeReferences;
    surfacedCorpusDiscrepancies += audit.errorCount;
    if (!fixtureParsed) {
        fixtureParsed = parsed;
        fixtureCatalog = catalog;
    }

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

assert.ok(fixtureParsed && fixtureCatalog, "Expected an SCSEM fixture for issue-code audit tests");
const fixtureSheet = fixtureParsed.sheets.find((sheet) => sheet.sheetType === "test_cases");
const fixtureControl = fixtureSheet?.controls[0];
assert.ok(fixtureSheet && fixtureControl, "Expected a parsed Test Cases fixture row");
const validFixtureCode = [...fixtureCatalog.keys()][0];
const auditFixture = (issueCode: string | null) => auditSCSEMIssueCodes({
    sheets: [{
        ...fixtureSheet,
        controls: [{ ...fixtureControl, issueCode }],
    }],
}, fixtureCatalog);

const validAudit = auditFixture(validFixtureCode);
assert.equal(validAudit.complete, true);
assert.equal(validAudit.issueCodeReferences, 1);
assert.equal(validAudit.validIssueCodeReferences, 1);
assert.equal(validAudit.errorCount, 0);

const rowLimitAudit = auditSCSEMIssueCodes({
    sheets: [{
        ...fixtureSheet,
        rawData: Array.from({ length: SCSEM_SHEET_ROW_LIMIT }, () => []),
        controls: [{ ...fixtureControl, issueCode: validFixtureCode }],
    }],
}, fixtureCatalog);
assert.equal(rowLimitAudit.complete, false);
assert.equal(rowLimitAudit.errorCount, 1);
assert.equal(rowLimitAudit.findings[0]?.kind, "scan_limit_reached");
assert.match(rowLimitAudit.findings[0]?.message || "", /cannot be certified/i);

for (const scenario of [
    { issueCode: null, kind: "missing_assignment" },
    { issueCode: "HAC100,HAC1", kind: "malformed_code" },
    { issueCode: `${validFixtureCode}\n${validFixtureCode}`, kind: "duplicate_code" },
    { issueCode: "HZZ999", kind: "code_not_in_table" },
] as const) {
    const audit = auditFixture(scenario.issueCode);
    assert.equal(audit.complete, false);
    assert.equal(audit.errorCount, 1);
    assert.equal(audit.findings[0]?.kind, scenario.kind);
    assert.equal(audit.findings[0]?.sheetName, fixtureSheet.sheetName);
    assert.equal(audit.findings[0]?.row, fixtureControl.rowIndex + 1);
    assert.equal(audit.findings[0]?.testId, fixtureControl.testId);
}

const boundedAuditFixture = {
    sheets: [{
        ...fixtureSheet,
        controls: Array.from({ length: 105 }, (_, index) => ({
            ...fixtureControl,
            rowIndex: fixtureControl.rowIndex + index,
            testId: `BOUNDED-${index + 1}`,
            issueCode: null,
        })),
    }],
};
const boundedAuditBefore = JSON.stringify(boundedAuditFixture);
const boundedAudit = auditSCSEMIssueCodes(boundedAuditFixture, fixtureCatalog);
assert.equal(boundedAudit.errorCount, 105);
assert.equal(boundedAudit.findings.length, 100);
assert.equal(boundedAudit.truncatedFindingCount, 5);
assert.equal(
    JSON.stringify(boundedAuditFixture),
    boundedAuditBefore,
    "The issue-code audit must not mutate parsed Government workbook content"
);

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
assert.ok(
    analyzeRoute.includes("auditSCSEMIssueCodesFile(verifiedBase.absolutePath, parsed)") &&
    analyzeRoute.includes("issueCodeAudit,"),
    "Analysis must rerun the issue-code audit against the exact selected workbook baseline"
);

const updaterStore = fs.readFileSync(
    path.join(process.cwd(), "src/lib/scsem-updater-store.ts"),
    "utf8"
);
assert.ok(
    updaterStore.includes("issueCodeAudit: auditSCSEMIssueCodesFile(temporaryPath, parsed)") &&
    updaterStore.includes("issueCodeAudit,"),
    "Upload must persist the read-only issue-code cross-tab audit"
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
    updaterClientDto.includes("issueCodeAudit?: SCSEMUpdaterClientIssueCodeAudit") &&
    updaterUi.includes("SCSEMUpdaterClientChange as UpdaterChange") &&
    updaterUi.includes("IRS Issue Code (required; one per line)") &&
    updaterUi.includes("Standard Finding Statement (required when this template has the column)") &&
    updaterUi.includes("Automation does not choose this risk mapping") &&
    updaterUi.includes("Issue Code Table cross-check") &&
    updaterUi.includes("Existing controls were not changed automatically"),
    "The client contract and reviewer UI must expose issue-code selection and the read-only cross-tab audit"
);

process.stdout.write(
    `Verified exact Issue Code Table schemas and selections for all ${files.length} pinned IRS SCSEMs; ` +
    `cross-checked ${auditedIssueCodeReferences} references across ${auditedTestCaseRows} test cases ` +
    `and surfaced ${surfacedCorpusDiscrepancies} source discrepancy record(s) without modifying controls.\n`
);
