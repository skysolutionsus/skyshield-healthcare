import { resolveGeneratorPolicyEvidence } from "../src/lib/scsem-generator-evidence";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";
import * as XLSX from "xlsx";
import { officialSCSEMManifest } from "../src/lib/scsem-official-manifest";
import { parseSCSEMFile } from "../src/lib/xlsx-parser";
import { sha256Buffer } from "../src/lib/scsem-official-manifest";
import { readSCSEMIssueCodeCatalog } from "../src/lib/scsem-issue-codes";
import { addIdsToChanges, type SCSEMUpdaterSession } from "../src/lib/scsem-updater-store";
import { buildSCSEMUpdaterWorkbookBuffer } from "../src/lib/scsem-workbook-export";

// --legacy deliberately exercises the old serializer for the RED receipt.
async function main() {
    const { buildCISBootstrapBlankWorkbook: build } = process.argv.includes("--legacy")
        ? await import("../src/lib/scsem-cis-bootstrap")
        : await import("../src/lib/scsem-cis-blank-workbook");
    const entry = officialSCSEMManifest().workbooks.find((item) => item.subject === "Generic Application")!;
    const source = await JSZip.loadAsync(fs.readFileSync(entry.file));
    const shell = await build("Synthetic fidelity test & <not evidence>", "TEST-ONLY", 2);
    const output = await JSZip.loadAsync(shell.buffer);
    const parts = (zip: JSZip) => Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
    assert.deepEqual(parts(output), parts(source), "blank shell must preserve the source ZIP part inventory");
    const mutable = new Set(["xl/workbook.xml", "xl/calcChain.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet4.xml", "xl/worksheets/sheet5.xml"]);
    for (const name of parts(source)) {
        if (name === "xl/worksheets/sheet2.xml") {
            const expected = (await source.file(name)!.async("string")).replace(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g,
                (cell) => /<f\b/.test(cell) ? cell.replace(/<v\b[^>]*(?:\/>|>[\s\S]*?<\/v>)/g, "") : cell);
            assert.equal(await output.file(name)!.async("string"), expected, "Results preserved except stale formula caches");
        } else if (!mutable.has(name)) assert.deepEqual(await output.file(name)!.async("nodebuffer"), await source.file(name)!.async("nodebuffer"), `unmodified part ${name}`);
    }
    for (const name of ["sheet1", "sheet4", "sheet5"]) {
        const before = await source.file(`xl/worksheets/${name}.xml`)!.async("string");
        const after = await output.file(`xl/worksheets/${name}.xml`)!.async("string");
        for (const tag of ["dataValidations", "conditionalFormatting", "extLst", "drawing", "pageSetup", "cols"]) {
            const pattern = new RegExp(`<${tag}\\b[^>]*(?:/>|>[\\s\\S]*?</${tag}>)`, "g");
            assert.deepEqual(after.match(pattern), before.match(pattern), `${name} preserves ${tag}`);
        }
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cis-blank-fidelity-"));
    try {
        const file = path.join(dir, "synthetic-shell.xlsx");
        fs.writeFileSync(file, shell.buffer);
        assert.equal(parseSCSEMFile(file).totalControls, 0);
        const book = XLSX.read(shell.buffer, { type: "buffer", cellFormula: true, sheetStubs: true });
        const sheet = book.Sheets["General App Test Cases"];
        for (let row = 3; row <= 5; row++) {
            assert.ok(sheet[`AA${row}`]?.f, `formula anchor/allocation row ${row}`);
            assert.ok(!sheet[`AA${row}`].f!.includes("#REF!"));
            for (const col of ["A", "F", "G", "H", "I", "J", "K", "M", "N", "AB", "AC"]) {
                assert.ok(sheet[`${col}${row}`], `styled blank ${col}${row}`);
                assert.ok(!sheet[`${col}${row}`].v, `cleared ${col}${row}`);
            }
        }
        assert.equal(sheet.AB2.v, "CIS Benchmark Ref");
        assert.equal(sheet.AC2.v, "CIS Recommendation #");
        assert.equal(sheet.I78.v, "Pass", "validation list survives clearing");
        assert.equal(book.Sheets.Dashboard.A20.v, "Test Date:", "do not overwrite assessment labels");
        assert.match(String(book.Sheets.Dashboard.A1.v), /not an official IRS SCSEM/i);
        assert.match(String(book.Sheets.Dashboard.A5.v), /WORKING DRAFT/);
        assert.equal(shell.baseline.sourceSha256, entry.sha256);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    console.log("PASS: source ZIP parts, untouched payloads, validation/formatting/drawings, blank controls, formula/style allocation, visible draft labels");
    for (const count of [0, -1, 1.5, NaN, Infinity, 5001]) {
        await assert.rejects(async () => build("TEST", "TEST", count), /integer from 1 to 5000/);
    }
    const large = await build("Synthetic allocation only", "TEST", 5000);
    const largeBook = XLSX.read(large.buffer, { type: "buffer", cellFormula: true, sheetStubs: true });
    const largeSheet = largeBook.Sheets["General App Test Cases"];
    for (let row = 3; row <= 5003; row++) {
        assert.ok(largeSheet[`AA${row}`]?.f, `upper-bound formula ${row}`);
        assert.ok(!largeSheet[`AA${row}`].f!.includes("#REF!"));
        assert.ok(!largeSheet[`I${row}`]?.v, `no helper/response collision ${row}`);
        assert.ok(largeSheet[`AC${row}`], `upper-bound styled identity cell ${row}`);
    }
    const largeZip = await JSZip.loadAsync(large.buffer);
    const largeXml = await largeZip.file("xl/worksheets/sheet4.xml")!.async("string");
    const statusList = largeXml.match(/<dataValidation\b[^>]*sqref="[^"]*J3:J5003[^>]*>[\s\S]*?<formula1>([^<]+)<\/formula1>/)?.[1];
    assert.ok(statusList, "status validation extends through all allocated rows");
    const listRange = XLSX.utils.decode_range(statusList!.replace(/\$/g, ""));
    assert.deepEqual(Array.from({ length: 4 }, (_, i) => largeSheet[XLSX.utils.encode_cell({ c: listRange.s.c, r: listRange.s.r + i })].v), ["Pass", "Fail", "N/A", "Info"]);
    const chain = await largeZip.file("xl/calcChain.xml")!.async("string");
    assert.match(chain, /<c\b[^>]*r="AA5003"[^>]*i="4"/);
    console.log("PASS: invalid counts fail closed; 5000 candidates plus donor; helper lists relocated without collisions; features and calcChain cover allocation");
    const results = await output.file("xl/worksheets/sheet2.xml")!.async("string");
    for (const cell of results.match(/<c\b[^>]*>[\s\S]*?<\/c>/g) || []) {
        if (/<f\b/.test(cell)) assert.ok(!/<v\b/.test(cell), "Results must not retain cached scores from removed controls");
    }
    assert.match(largeBook.Sheets.Results.B12.f!, /\$J\$5003/);
    console.log("PASS: summary formula caches invalidated and allocated-range summaries extended");
    for (const zip of [output, largeZip]) {
        for (const name of [...mutable, "xl/worksheets/sheet2.xml"]) {
            assert.equal(XMLValidator.validate(await zip.file(name)!.async("string")), true, `well-formed ${name}`);
        }
    }
    const smallTargetXml = await output.file("xl/worksheets/sheet4.xml")!.async("string");
    assert.ok(/<autoFilter\b[^>]*ref="A2:N5"/.test(smallTargetXml), "filter covers candidates, not just the source header");
    assert.match(await output.file("xl/workbook.xml")!.async("string"), /'General App Test Cases'!\$A\$2:\$N\$5<\/definedName>/);
    const headerStyle = smallTargetXml.match(/<c\b[^>]*r="AA2"[^>]*s="(\d+)"/)![1];
    assert.match(smallTargetXml, new RegExp(`<c\\b[^>]*r="AB2"[^>]*s="${headerStyle}"`), "new identity headers inherit source style");
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "cis-blank-export-"));
    try {
        const blank = await build("SYNTHETIC-TEST", "TEST", 80);
        const file = path.join(exportDir, "synthetic-only.xlsx");
        fs.writeFileSync(file, blank.buffer);
        const parsed = parseSCSEMFile(file);
        assert.equal(parsed.totalControls, 0);
        const issueCode = [...readSCSEMIssueCodeCatalog(file).keys()][0];
        // Mechanical, synthetic reviewer payloads, NOT CIS/licensed evidence.
        const changes = addIdsToChanges(Array.from({ length: 80 }, (_, i) => ({
            action: "addControl" as const, testId: `SYNTHETIC-${i}`, targetSheet: "General App Test Cases",
            field: "newControl", currentValue: "", proposedValue: "Synthetic allocation test only",
            reason: "OOXML regression fixture; not a compliance recommendation", confidence: "needs_review",
            sourceEvidence: { bootstrapDraft: true, sourceRow: i + 2, sourceSheet: "SYNTHETIC", sourceSha256: "a".repeat(64), sourceBenchmarkVersion: "TEST", sourceRemediation: "Synthetic expected" },
            newControl: { nistId: "CM-6", sectionTitle: "Synthetic test", description: "Synthetic description", testProcedures: "Synthetic procedure",
                expectedResults: "Synthetic expected", issueCode, criticality: "Moderate", recommendationNum: `TEST-${i}` },
        })));
        const policy = resolveGeneratorPolicyEvidence("CM-6");
        for (const change of changes) {
            change.status = "APPROVED";
            change.reviewerEvidence = { expectedResultsSourceQuote: "Synthetic expected", expectedResultsRationale: "Synthetic fidelity-only fixture, not a compliance determination.", applicabilityRationale: "Synthetic test only, not licensed evidence.", policyEvidenceSha256: policy.sha256 };
        }
        const session: SCSEMUpdaterSession = {
            id: "synthetic-fidelity", revision: 1, originalFileName: "synthetic-only.xlsx", originalFilePath: file,
            organizationId: "test", createdByUserId: "test", uploadedAt: "2026-01-01T00:00:00Z",
            inferredTechnology: "SYNTHETIC", workspaceMode: "cis_bootstrap", analysisScope: "full", status: "analysis_incomplete",
            scsem: { subject: "SYNTHETIC", version: null, effectiveDate: null, totalControls: 0, testCaseSheets: ["General App Test Cases"] },
            changes, history: [], audit: { uploadedSha256: sha256Buffer(blank.buffer), uploadedSizeBytes: blank.buffer.length },
        };
        const exported = await buildSCSEMUpdaterWorkbookBuffer(session, parsed, file);
        fs.writeFileSync(file, exported);
        const controls = parseSCSEMFile(file).sheets.find((sheet) => sheet.sheetName === "General App Test Cases")!.controls;
        assert.equal(controls.length, 80);
        assert.deepEqual(controls.map((control) => control.recommendationNum), changes.map((change) => change.newControl!.recommendationNum));
        const exportedBook = XLSX.read(exported, { type: "buffer", cellFormula: true, sheetStubs: true });
        const exportedSheet = exportedBook.Sheets["General App Test Cases"];
        assert.ok(!exportedSheet.A3.v, "exporter reserves Excel row 3 as its donor");
        assert.equal(exportedSheet.A4.v, controls[0].testId, "first addition is physically on Excel row 4");
        const exportedZip = await JSZip.loadAsync(exported);
        assert.deepEqual(parts(exportedZip), parts(source));
        for (const name of parts(source).filter((name) => /drawings|media|printerSettings|styles.xml|sheet8.xml/.test(name))) {
            assert.deepEqual(await exportedZip.file(name)!.async("nodebuffer"), await source.file(name)!.async("nodebuffer"), `export retains ${name}`);
        }
        console.log("PASS: unchanged exporter accepts 80 synthetic approved rows across old control/list boundaries; identities and package fidelity retained");
    } finally { fs.rmSync(exportDir, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
