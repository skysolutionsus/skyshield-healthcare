import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { SCSEMUpdaterSession } from "../src/lib/scsem-updater-store";
import type { ParsedControl, ParsedSCSEM } from "../src/lib/xlsx-parser";
import { scsemBenchmarkLookupFailureDetails } from "../src/lib/scsem-benchmark-failure";

const ROOT = process.cwd();
const CURRENT_SCSEM_DIR = path.join(ROOT, "data/scsems/current");
const ESXI_PATH = path.join(CURRENT_SCSEM_DIR, "safeguards-scsem-vmwareesxi-v5.xlsx");
const APPLICATION_PATH = path.join(CURRENT_SCSEM_DIR, "safeguards-scsem-application-v4-1.xlsx");
const FORTIGATE_PATH = path.join(CURRENT_SCSEM_DIR, "Safeguards-SCSEM-Fortigate-v10-120124.xlsx");
const APPLICATION_TEST_SHEET = "General App Test Cases";
const APPLICATION_SHEET_XML = "xl/worksheets/sheet4.xml";
const APPLICATION_CHANGE_LOG_XML = "xl/worksheets/sheet6.xml";
const FORTIGATE_SHEET_XML = "xl/worksheets/sheet3.xml";

async function loadUpdaterModules() {
    const [parser, exporter] = await Promise.all([
        import("../src/lib/xlsx-parser"),
        import("../src/lib/scsem-workbook-export"),
    ]);
    return { ...parser, ...exporter };
}

async function loadJSZip() {
    const loadedModule = await import("jszip");
    return loadedModule.default;
}

function applicationControl(parsed: ParsedSCSEM, testId = "APP-31"): ParsedControl {
    const control = parsed.sheets
        .find((sheet) => sheet.sheetName === APPLICATION_TEST_SHEET)
        ?.controls.find((candidate) => candidate.testId === testId);
    assert.ok(control, `${testId} must exist on ${APPLICATION_TEST_SHEET}`);
    return control;
}

function updaterSession(
    change: Partial<SCSEMUpdaterSession["changes"][number]>,
    officialReference: SCSEMUpdaterSession["audit"]["officialReference"] = null
): SCSEMUpdaterSession {
    return {
        revision: 0,
        originalFileName: path.basename(APPLICATION_PATH),
        inferredTechnology: "Generic Application",
        changes: [{
            id: "application-export-test",
            status: "APPROVED",
            action: "updateField",
            testId: "APP-31",
            targetSheet: APPLICATION_TEST_SHEET,
            field: "description",
            currentValue: "",
            proposedValue: "Approved export sentinel",
            reason: "SCSEM updater regression test.",
            sourceEvidence: { sourceSheet: APPLICATION_TEST_SHEET },
            ...change,
        }],
        audit: { officialReference },
    } as unknown as SCSEMUpdaterSession;
}

function fortigateAddControlSession(): SCSEMUpdaterSession {
    return {
        revision: 0,
        originalFileName: path.basename(FORTIGATE_PATH),
        inferredTechnology: "Fortinet Fortigate Firewall",
        status: "review_ready",
        changes: [{
            id: "shared-formula-clone-guard",
            status: "APPROVED",
            action: "addControl",
            testId: "SOURCE-SHARED-FORMULA",
            targetSheet: "Fortigate Test Cases",
            field: "newControl",
            currentValue: "",
            proposedValue: "Synthetic shared-formula clone guard",
            reason: "SCSEM updater shared-formula regression test.",
            sourceEvidence: { sourceSheet: "Fortigate Test Cases" },
            newControl: {
                nistId: "AC-2",
                nistControlName: "Account Management",
                testMethod: "Examine",
                sectionTitle: "Synthetic regression section",
                description: "Synthetic regression objective",
                testProcedures: "Inspect the configured control.",
                expectedResults: "The configured control meets the approved requirement.",
                findingStatement: "The configured control does not meet the approved requirement.",
                criticality: "Moderate",
                issueCode: "HAC100",
                recommendationNum: "SYNTHETIC-SHARED-FORMULA",
            },
        }],
        audit: {},
    } as unknown as SCSEMUpdaterSession;
}

async function writeTemporaryWorkbook(buffer: Buffer, label: string): Promise<string> {
    const filePath = path.join(os.tmpdir(), `skyshield-${label}-${process.pid}-${Date.now()}.xlsx`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

function xmlFeature(xml: string, tag: string, attribute: string): string | null {
    return xml.match(new RegExp(`<${tag}\\b[^>]*\\b${attribute}="([^"]+)"`, "i"))?.[1] || null;
}

function formulaCells(xml: string): Map<string, string> {
    const formulas = new Map<string, string>();
    const matcher = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(xml))) {
        if (!/<f\b/.test(match[0])) continue;
        const address = match[0].match(/\br="([^"]+)"/)?.[1];
        if (address) formulas.set(address, match[0]);
    }
    return formulas;
}

function replaceRawCell(
    sheetXml: string,
    address: string,
    replace: (cellXml: string) => string
): string {
    const matcher = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(sheetXml))) {
        if (match[0].match(/\br="([^"]+)"/)?.[1] !== address) continue;
        return sheetXml.slice(0, match.index) + replace(match[0]) + sheetXml.slice(match.index + match[0].length);
    }
    throw new Error(`Test fixture cell ${address} was not found.`);
}

function addRawMerge(sheetXml: string, ref: string): string {
    const existing = sheetXml.match(/<mergeCells\b[^>]*>[\s\S]*?<\/mergeCells>/);
    if (existing) {
        const count = Number(existing[0].match(/\bcount="(\d+)"/)?.[1] || "0") + 1;
        const updated = existing[0]
            .replace(/\bcount="\d+"/, `count="${count}"`)
            .replace("</mergeCells>", `<mergeCell ref="${ref}"/></mergeCells>`);
        return sheetXml.slice(0, existing.index!) + updated + sheetXml.slice(existing.index! + existing[0].length);
    }
    return sheetXml.replace(
        "</sheetData>",
        `</sheetData><mergeCells count="1"><mergeCell ref="${ref}"/></mergeCells>`
    );
}

async function mutateApplicationWorkbook(
    label: string,
    mutateSheet: (sheetXml: string) => string
): Promise<string> {
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(fs.readFileSync(APPLICATION_PATH));
    const sheetXml = await zip.file(APPLICATION_SHEET_XML)!.async("string");
    zip.file(APPLICATION_SHEET_XML, mutateSheet(sheetXml));
    return writeTemporaryWorkbook(
        await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
        label
    );
}

async function mutateFortigateWorkbook(
    label: string,
    mutateSheet: (sheetXml: string) => string
): Promise<string> {
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(fs.readFileSync(FORTIGATE_PATH));
    const sheetXml = await zip.file(FORTIGATE_SHEET_XML)!.async("string");
    zip.file(FORTIGATE_SHEET_XML, mutateSheet(sheetXml));
    return writeTemporaryWorkbook(
        await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
        label
    );
}

async function assertApplicationParserAndSurgicalExport() {
    const [{ parseSCSEMFile, buildSCSEMUpdaterWorkbookBuffer }, JSZip] = await Promise.all([
        loadUpdaterModules(),
        loadJSZip(),
    ]);
    const parsed = parseSCSEMFile(APPLICATION_PATH);
    const control = applicationControl(parsed);
    assert.equal(control.rowIndex, 48, "APP-31 must remain on Excel row 49");
    assert.equal(
        control.description,
        "COTS products are configured to agency security configuration policy.",
        "Test Objective must parse as the canonical description field"
    );

    const sentinel = "APP-31 approved Test Objective sentinel";
    const assessmentCopy = parseSCSEMFile(APPLICATION_PATH);
    const assessmentControl = applicationControl(assessmentCopy);
    assessmentControl.actualResults = "DO NOT CARRY ACTUAL RESULTS";
    assessmentControl.status = "DO NOT CARRY STATUS";
    assessmentControl.findingStatement = "DO NOT CARRY FINDING";
    assessmentControl.notesEvidence = "DO NOT CARRY NOTES";
    assessmentControl.remediationStatement = "DO NOT CARRY REMEDIATION";
    assessmentControl.capRequestStatement = "DO NOT CARRY CAP";
    assessmentControl.riskRating = "DO NOT CARRY RISK";

    const session = updaterSession({
        currentValue: control.description || "",
        proposedValue: sentinel,
    });
    const outputBuffer = await buildSCSEMUpdaterWorkbookBuffer(
        session,
        parsed,
        APPLICATION_PATH,
        assessmentCopy
    );
    const outputPath = await writeTemporaryWorkbook(outputBuffer, "application-approved");
    try {
        const output = parseSCSEMFile(outputPath);
        const updated = applicationControl(output);
        assert.equal(updated.description, sentinel, "approved value must reach F49");
        assert.equal(updated.actualResults, control.actualResults);
        assert.equal(updated.status, control.status);
        assert.equal(updated.findingStatement, control.findingStatement);
        assert.equal(updated.notesEvidence, control.notesEvidence);
        assert.equal(updated.remediationStatement, control.remediationStatement);
        assert.equal(updated.capRequestStatement, control.capRequestStatement);
        assert.equal(updated.riskRating, control.riskRating);
        assert.ok(
            !String(updated.notesEvidence || "").includes("SkyShield SCSEM Updater"),
            "updater provenance must not be written into agency Notes/Evidence"
        );

        const originalZip = await JSZip.loadAsync(fs.readFileSync(APPLICATION_PATH));
        const outputZip = await JSZip.loadAsync(outputBuffer);
        const originalParts = Object.keys(originalZip.files).sort();
        const outputParts = Object.keys(outputZip.files).sort();
        assert.deepEqual(outputParts, originalParts, "surgical export must not add or remove OOXML parts");
        for (const partName of originalParts) {
            if (originalZip.files[partName].dir) continue;
            if ([APPLICATION_SHEET_XML, APPLICATION_CHANGE_LOG_XML].includes(partName)) continue;
            assert.deepEqual(
                await outputZip.file(partName)!.async("nodebuffer"),
                await originalZip.file(partName)!.async("nodebuffer"),
                `unrelated OOXML part changed: ${partName}`
            );
        }

        const originalSheetXml = await originalZip.file(APPLICATION_SHEET_XML)!.async("string");
        const outputSheetXml = await outputZip.file(APPLICATION_SHEET_XML)!.async("string");
        assert.equal(
            xmlFeature(outputSheetXml, "dimension", "ref"),
            xmlFeature(originalSheetXml, "dimension", "ref"),
            "updating an existing cell must preserve sheet dimensions"
        );
        assert.equal(
            xmlFeature(outputSheetXml, "autoFilter", "ref"),
            xmlFeature(originalSheetXml, "autoFilter", "ref"),
            "updating an existing cell must preserve filter ranges"
        );
        assert.deepEqual(
            formulaCells(outputSheetXml),
            formulaCells(originalSheetXml),
            "formulas and their cached values must remain byte-for-byte unchanged"
        );
        assert.match(outputSheetXml, /<c\b[^>]*\br="F49"[^>]*>[\s\S]*APP-31 approved Test Objective sentinel[\s\S]*?<\/c>/);
    } finally {
        fs.rmSync(outputPath, { force: true });
    }
}

async function assertFailClosedExportGuards() {
    const { parseSCSEMFile, buildSCSEMUpdaterWorkbookBuffer } = await loadUpdaterModules();
    const parsed = parseSCSEMFile(APPLICATION_PATH);
    const control = applicationControl(parsed);
    const currentValue = control.description || "";

    await assert.rejects(
        buildSCSEMUpdaterWorkbookBuffer(
            updaterSession({ targetSheet: "Missing Test Cases", currentValue }),
            parsed,
            APPLICATION_PATH
        ),
        /target sheet Missing Test Cases was not found/
    );
    await assert.rejects(
        buildSCSEMUpdaterWorkbookBuffer(
            updaterSession({ field: "rationale", currentValue: "" }),
            parsed,
            APPLICATION_PATH
        ),
        /has no column for rationale/
    );
    await assert.rejects(
        buildSCSEMUpdaterWorkbookBuffer(
            updaterSession({ currentValue: "stale value from analysis" }),
            parsed,
            APPLICATION_PATH
        ),
        /changed after analysis/
    );
    await assert.rejects(
        buildSCSEMUpdaterWorkbookBuffer(
            updaterSession({ currentValue, proposedValue: "invalid\u0000proposal" }),
            parsed,
            APPLICATION_PATH
        ),
        /illegal in XML 1\.0/
    );
    const invalidBlockerSession = updaterSession({ currentValue });
    invalidBlockerSession.status = "analysis_incomplete";
    invalidBlockerSession.audit.analysisCoverage = {
        totalRows: parsed.totalControls,
        nistMappedRows: parsed.totalControls,
        reviewedRows: 0,
        unmappedRows: 0,
        totalBatches: 1,
        aiCompletedBatches: 0,
        supplementalComparisonComplete: false,
        complete: false,
        blockers: ["invalid\u0000blocker"],
    };
    await assert.rejects(
        buildSCSEMUpdaterWorkbookBuffer(invalidBlockerSession, parsed, APPLICATION_PATH),
        /XML 1\.0-illegal character/
    );
    const duplicateTargetSession = updaterSession({
        currentValue,
        proposedValue: "First approved value for one target",
    });
    duplicateTargetSession.changes.push({
        ...duplicateTargetSession.changes[0],
        id: "application-export-test-duplicate-target",
        proposedValue: "Second approved value for the same target",
    });
    await assert.rejects(
        buildSCSEMUpdaterWorkbookBuffer(duplicateTargetSession, parsed, APPLICATION_PATH),
        /target cell General App Test Cases!F49 is also targeted by approved change application-export-test/
    );

    const formulaPath = await mutateApplicationWorkbook("formula-target", (sheetXml) =>
        replaceRawCell(sheetXml, "F49", (cellXml) => {
            const opening = cellXml.match(/^<c\b([^>]*)/)?.[1]
                ?.replace(/\s+t="[^"]*"/g, "") || ' r="F49"';
            return `<c${opening}><f>1+1</f><v>2</v></c>`;
        })
    );
    const protectedPath = await mutateApplicationWorkbook("protected-target", (sheetXml) =>
        sheetXml.replace("</sheetData>", "</sheetData><sheetProtection sheet=\"1\"/>")
    );
    const mergedPath = await mutateApplicationWorkbook("merged-target", (sheetXml) =>
        addRawMerge(sheetXml, "F49:G49")
    );
    const duplicateHeaderPath = await mutateApplicationWorkbook("duplicate-header", (sheetXml) =>
        replaceRawCell(sheetXml, "G2", (cellXml) => {
            const opening = cellXml.match(/^<c\b([^>]*)/)?.[1]
                ?.replace(/\s+t="[^"]*"/g, "") || ' r="G2"';
            return `<c${opening} t="inlineStr"><is><t>Description</t></is></c>`;
        })
    );
    const selfClosingSharedFormulaPath = await mutateFortigateWorkbook(
        "self-closing-shared-formula",
        (sheetXml) => replaceRawCell(sheetXml, "AB79", (cellXml) => {
            const opening = cellXml.match(/^<c\b[^>]*>/)?.[0];
            assert.ok(opening, "Fortigate AB79 must have a writable cell opening");
            return `${opening}<f t="shared" si="77"/><v>2</v></c>`;
        })
    );
    try {
        const formulaParsed = parseSCSEMFile(formulaPath);
        await assert.rejects(
            buildSCSEMUpdaterWorkbookBuffer(
                updaterSession({ currentValue: applicationControl(formulaParsed).description || "" }),
                formulaParsed,
                formulaPath
            ),
            /contains a formula/
        );

        const protectedParsed = parseSCSEMFile(protectedPath);
        await assert.rejects(
            buildSCSEMUpdaterWorkbookBuffer(
                updaterSession({ currentValue: applicationControl(protectedParsed).description || "" }),
                protectedParsed,
                protectedPath
            ),
            /target sheet General App Test Cases is protected/
        );

        const mergedParsed = parseSCSEMFile(mergedPath);
        await assert.rejects(
            buildSCSEMUpdaterWorkbookBuffer(
                updaterSession({ currentValue: applicationControl(mergedParsed).description || "" }),
                mergedParsed,
                mergedPath
            ),
            /target cell General App Test Cases!F49 is merged/
        );

        const duplicateHeaderParsed = parseSCSEMFile(duplicateHeaderPath);
        await assert.rejects(
            buildSCSEMUpdaterWorkbookBuffer(
                updaterSession({
                    currentValue: applicationControl(duplicateHeaderParsed).description || "",
                }),
                duplicateHeaderParsed,
                duplicateHeaderPath
            ),
            /target sheet General App Test Cases has duplicate columns for description/
        );

        const fortigateParsed = parseSCSEMFile(FORTIGATE_PATH);
        await assert.rejects(
            buildSCSEMUpdaterWorkbookBuffer(
                fortigateAddControlSession(),
                fortigateParsed,
                selfClosingSharedFormulaPath
            ),
            /source formula AB79 is self-closing or malformed and cannot be cloned safely/
        );
    } finally {
        fs.rmSync(formulaPath, { force: true });
        fs.rmSync(protectedPath, { force: true });
        fs.rmSync(mergedPath, { force: true });
        fs.rmSync(duplicateHeaderPath, { force: true });
        fs.rmSync(selfClosingSharedFormulaPath, { force: true });
    }
}

async function assertIncompleteAnalysisChangeLogWarning() {
    const { parseSCSEMFile, buildSCSEMUpdaterWorkbookBuffer } = await loadUpdaterModules();
    const parsed = parseSCSEMFile(APPLICATION_PATH);
    const control = applicationControl(parsed);
    const session = updaterSession({
        currentValue: control.description || "",
        proposedValue:
            "Incomplete-analysis warning sentinel; verify /app/skyshield/config and /etc/ssh/sshd_config.",
        reason:
            "/app/skyshield/config and /etc/ssh/sshd_config are legitimate reviewer-visible control text.",
    });
    const injectedPath = "/Users/private/runtime/cis/benchmark.xlsx";
    const injectedLookupError = `EACCES: permission denied, open '${injectedPath}'`;
    assert.deepEqual(
        scsemBenchmarkLookupFailureDetails(new Error(injectedLookupError)),
        {
            code: "CIS_BENCHMARK_LOOKUP_UNAVAILABLE",
            message: "CIS Benchmark/CIS-STIG lookup could not be completed.",
        }
    );
    session.status = "analysis_incomplete";
    // Model a pre-fix/injected persisted session: the export boundary must
    // replace only this exact stored lookup failure, not proposal text.
    session.audit.benchmarkLookupError = injectedLookupError;
    session.summary = `Analysis incomplete because ${injectedLookupError}.`;
    session.audit.analysisCoverage = {
        totalRows: parsed.totalControls,
        nistMappedRows: parsed.totalControls,
        reviewedRows: 0,
        unmappedRows: 0,
        totalBatches: 1,
        aiCompletedBatches: 0,
        supplementalComparisonComplete: false,
        complete: false,
        blockers: [
            `CIS Benchmark/CIS-STIG lookup unavailable: ${injectedLookupError}`,
        ],
    };
    const outputBuffer = await buildSCSEMUpdaterWorkbookBuffer(session, parsed, APPLICATION_PATH);
    const outputPath = await writeTemporaryWorkbook(outputBuffer, "incomplete-warning");
    try {
        const output = parseSCSEMFile(outputPath);
        const entry = output.sheets.find((sheet) => sheet.sheetName === "Change Log")?.changeLogEntries.at(-1);
        assert.ok(entry);
        assert.match(entry.version, /^SCSEM DRAFT-INCOMPLETE\b/);
        assert.match(entry.description, /Evidence analysis is incomplete/i);
        assert.match(
            entry.description,
            /CIS Benchmark\/CIS-STIG lookup could not be completed\./i
        );
        assert.doesNotMatch(entry.description, /EACCES|Users\/private|runtime\/cis/i);
        assert.doesNotMatch(entry.description, /change\(s\) applied after IRS Pub 1075/i);
        assert.equal(
            applicationControl(output).description,
            "Incomplete-analysis warning sentinel; verify /app/skyshield/config and /etc/ssh/sshd_config.",
            "Benchmark failure sanitization must not rewrite legitimate proposal/control text"
        );
    } finally {
        fs.rmSync(outputPath, { force: true });
    }
}

async function assertOfficialRebaseDoesNotCarryAssessmentData() {
    const [
        { parseSCSEMFile, buildSCSEMUpdaterWorkbookBuffer },
        { evaluateOfficialSCSEMReference },
    ] = await Promise.all([
        loadUpdaterModules(),
        import("../src/lib/scsem-official-reference"),
    ]);
    const esxi = parseSCSEMFile(ESXI_PATH);
    const oldEsxi = {
        ...esxi,
        metadata: { ...esxi.metadata, version: "4.0", effectiveDate: "2020-01-01" },
        sheets: esxi.sheets
            .filter((sheet) => !/ESXi8/i.test(sheet.sheetName))
            .map((sheet) => ({
                ...sheet,
                controls: sheet.controls.map((control) => ({ ...control })),
            })),
    } as ParsedSCSEM;
    const oldControl = oldEsxi.sheets.find((sheet) => /ESXI7/i.test(sheet.sheetName))?.controls[0];
    assert.ok(oldControl);
    const officialControl = esxi.sheets
        .find((sheet) => /ESXI7/i.test(sheet.sheetName))
        ?.controls.find((control) => control.testId === oldControl.testId);
    assert.ok(officialControl);
    oldControl.actualResults = "DO NOT CARRY ASSESSMENT RESULT";
    oldControl.status = "DO NOT CARRY ASSESSMENT STATUS";
    oldControl.notesEvidence = "DO NOT CARRY ASSESSMENT NOTES";

    const upgrade = evaluateOfficialSCSEMReference(oldEsxi, "VMware ESXi", "older-workbook");
    assert.equal(upgrade?.selectedAsBase, true);
    assert.ok(upgrade?.addedSheets.includes("ESXi8.0 Test Cases"));

    const targetSheet = esxi.sheets.find((sheet) => /ESXi8/i.test(sheet.sheetName));
    const target = targetSheet?.controls[0];
    assert.ok(targetSheet && target);
    const session = updaterSession({
        id: "sheet-routing-test",
        testId: target.testId,
        targetSheet: targetSheet.sheetName,
        currentValue: target.description || "",
        proposedValue: `${target.description || ""} Verified update.`,
        sourceEvidence: { sourceSheet: targetSheet.sheetName },
    }, upgrade);
    session.originalFileName = "old-esxi7.xlsx";
    session.inferredTechnology = "VMware ESXi";

    const outputBuffer = await buildSCSEMUpdaterWorkbookBuffer(session, esxi, ESXI_PATH, oldEsxi);
    const outputPath = await writeTemporaryWorkbook(outputBuffer, "official-rebase");
    try {
        const output = parseSCSEMFile(outputPath);
        const notCarried = output.sheets
            .find((sheet) => /ESXI7/i.test(sheet.sheetName))
            ?.controls.find((control) => control.testId === oldControl.testId);
        const updated = output.sheets
            .find((sheet) => sheet.sheetName === targetSheet.sheetName)
            ?.controls.find((control) => control.testId === target.testId);
        assert.equal(notCarried?.actualResults, officialControl.actualResults);
        assert.equal(notCarried?.status, officialControl.status);
        assert.equal(notCarried?.notesEvidence, officialControl.notesEvidence);
        assert.ok(updated?.description?.endsWith("Verified update."));
    } finally {
        fs.rmSync(outputPath, { force: true });
    }
}

async function assertBenchmarkIdentity() {
    const { identifyCISProduct } = await import("../src/lib/cis-benchmark-xlsx");
    assert.deepEqual(
        identifyCISProduct("CIS Red Hat Enterprise Linux 9 Benchmark v2.0.0"),
        { family: "rhel", productGeneration: "9" }
    );

    console.log("SCSEM updater: benchmark identity checks passed.");
    assert.deepEqual(
        identifyCISProduct("CIS VMware ESXi 8.0 Benchmark v1.3.0"),
        { family: "vmware-esxi", productGeneration: "8.0" }
    );
    assert.deepEqual(
        identifyCISProduct("CIS Amazon Web Services Foundations Benchmark v5.0.0"),
        { family: "aws-foundations", productGeneration: null }
    );
}

type RegressionGroup = "benchmark" | "application" | "guards" | "incomplete" | "rebase";

function runRegressionGroup(group: RegressionGroup) {
    execFileSync(
        process.execPath,
        ["--import", "tsx", path.resolve("scripts/test-scsem-updater.ts")],
        {
            cwd: ROOT,
            env: { ...process.env, SCSEM_UPDATER_TEST_GROUP: group },
            stdio: "inherit",
        }
    );
}

async function runSelectedRegressionGroup(group: string) {
    if (group === "benchmark") return assertBenchmarkIdentity();
    if (group === "guards") return assertFailClosedExportGuards();
    if (group === "incomplete") return assertIncompleteAnalysisChangeLogWarning();
    if (group === "rebase") return assertOfficialRebaseDoesNotCarryAssessmentData();
    if (group === "application") return assertApplicationParserAndSurgicalExport();
    throw new Error(`Unknown SCSEM updater regression group: ${group}`);
}

async function main() {
    runRegressionGroup("benchmark");
    console.log("SCSEM updater: benchmark identity checks passed.");

    runRegressionGroup("guards");
    console.log("SCSEM updater: fail-closed export checks passed.");
    runRegressionGroup("incomplete");
    console.log("SCSEM updater: incomplete-analysis Change Log warning passed.");
    runRegressionGroup("rebase");
    console.log("SCSEM updater: official rebase scope checks passed.");
    runRegressionGroup("application");
    console.log("SCSEM updater: Application parser/export fidelity checks passed.");
    console.log("SCSEM updater regression checks passed.");
}

const selectedGroup = process.env.SCSEM_UPDATER_TEST_GROUP;
const execution = selectedGroup ? runSelectedRegressionGroup(selectedGroup) : main();
execution.catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
