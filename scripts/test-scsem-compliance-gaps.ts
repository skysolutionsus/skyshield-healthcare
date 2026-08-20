import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
    buildMissingPub1075ControlCandidates,
    listPub1075ControlRequirements,
} from "../src/lib/scsem-compliance-gap-candidates";
import { extractComplianceEvidence, normalizeNistControlId } from "../src/lib/compliance-evidence";
import { validateChanges, type SCSEMControlEvidence } from "../src/lib/scsem-update-engine";
import { parseSCSEMFile, type ParsedSCSEM } from "../src/lib/xlsx-parser";

const corpusDir = path.join(process.cwd(), "data", "scsems", "current");
const files = fs.readdirSync(corpusDir).filter((fileName) => /\.xlsx$/i.test(fileName)).sort();
assert.equal(files.length, 60);

function controlsFrom(parsed: ParsedSCSEM): SCSEMControlEvidence[] {
    return parsed.sheets.filter((sheet) => sheet.sheetType === "test_cases")
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

const requirements = listPub1075ControlRequirements();
assert.ok(requirements.length >= 150, "Expected the complete pinned Publication 1075 control catalog");
assert.equal(new Set(requirements.map((item) => item.controlId)).size, requirements.length);
assert.ok(requirements.every((item) => /^[A-Z]{2,3}-\d+$/.test(item.controlId)));
assert.ok(requirements.every((item) => /^[a-f0-9]{64}$/.test(item.sourceSha256)));

let totalCandidates = 0;
const reports: Array<{ fileName: string; candidates: number }> = [];
for (const fileName of files) {
    const parsed = parseSCSEMFile(path.join(corpusDir, fileName));
    const controls = controlsFrom(parsed);
    const compliance = extractComplianceEvidence(controls.map((control) => control.nistId));
    const candidates = buildMissingPub1075ControlCandidates({
        parsed,
        controls,
        pub1075Version: compliance.pub1075.version,
        nistVersion: compliance.nist.version,
    });
    assert.ok(candidates.length > 0, `${fileName} should surface missing Publication 1075 coverage candidates`);
    assert.equal(
        validateChanges(candidates, controls, 5000).length,
        candidates.length,
        `${fileName} deterministic candidates must survive the production proposal validator`
    );
    const sheetNames = new Set(parsed.sheets.filter((sheet) => sheet.sheetType === "test_cases").map((sheet) => sheet.sheetName));
    const presentIds = new Set(controls.map((control) => normalizeNistControlId(control.nistId)).filter(Boolean));
    for (const candidate of candidates) {
        assert.equal(candidate.action, "addControl");
        assert.ok(sheetNames.has(candidate.targetSheet));
        assert.equal(candidate.confidence, "needs_review");
        assert.equal(candidate.newControl.issueCode, null);
        assert.ok(candidate.newControl.findingStatement);
        assert.ok(candidate.newControl.testProcedures);
        assert.equal(candidate.sourceEvidence.complianceSource, "IRS Publication 1075");
        assert.equal(candidate.sourceEvidence.gapType, "missing_control_id");
        assert.equal(candidate.sourceEvidence.applicabilityReviewRequired, true);
        assert.equal(presentIds.has(candidate.newControl.nistId), false);
    }
    totalCandidates += candidates.length;
    reports.push({ fileName, candidates: candidates.length });
}

const fullyCoveredParsed = parseSCSEMFile(path.join(corpusDir, files[0]));
const fullyCoveredSheet = fullyCoveredParsed.sheets.find((sheet) => sheet.sheetType === "test_cases")?.sheetName;
assert.ok(fullyCoveredSheet);
const fullyCoveredControls: SCSEMControlEvidence[] = requirements.map((requirement, index) => ({
    id: `covered:${index}`,
    sourceSheet: fullyCoveredSheet,
    testId: `COVERED-${index + 1}`,
    nistId: requirement.controlId,
    nistControlName: requirement.title,
    testMethod: "Examine",
    sectionTitle: requirement.title,
    description: requirement.pub1075Text,
    testProcedures: requirement.assessmentProcedure,
    expectedResults: "Covered",
    findingStatement: "Not covered",
    criticality: "Moderate",
    cisBenchmarkRef: null,
    recommendationNum: null,
    rationale: null,
    impact: null,
    remediationProcedure: null,
}));
assert.equal(buildMissingPub1075ControlCandidates({
    parsed: fullyCoveredParsed,
    controls: fullyCoveredControls,
    pub1075Version: "Rev. 11-2021",
    nistVersion: "5.2.0",
}).length, 0, "A fully covered workbook must complete with zero genuine Publication 1075 gaps");

const db2 = reports.find((entry) => entry.fileName.includes("db2-luw-zos"));
assert.ok(db2 && db2.candidates > 0, "DB2 should have explicit missing Publication 1075 candidates");
console.log(
    `Verified deterministic Publication 1075 missing-control proposals across ${files.length} SCSEMs: ` +
    `${totalCandidates} reviewer-gated applicability candidates.`
);
