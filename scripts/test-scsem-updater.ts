import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { identifyCISProduct } from "../src/lib/cis-benchmark-xlsx";
import { extractComplianceEvidence } from "../src/lib/compliance-evidence";
import {
    evaluateOfficialSCSEMReference,
    resolveOfficialReferencePath,
} from "../src/lib/scsem-official-reference";
import { inferSCSEMTechnologyDetails, type SCSEMUpdaterSession } from "../src/lib/scsem-updater-store";
import { buildSCSEMUpdaterWorkbookBuffer } from "../src/lib/scsem-workbook-export";
import { parseSCSEMFile, type ParsedSCSEM } from "../src/lib/xlsx-parser";

const ROOT = process.cwd();
const RHEL_PATH = path.join(
    ROOT,
    "data/scsems/UNIX-Linux/Safeguards-SCSEM Red Hat Enterprise Linux (RHEL)-v7_02182025.xlsx"
);
const ESXI_PATH = path.join(
    ROOT,
    "data/scsems/Virtulization/Safeguards-SCSEM VMWare-ESXi-v5_0-0918024.xlsx"
);

function sha256(filePath: string): string {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function main() {
    assert.deepEqual(
        identifyCISProduct("CIS Red Hat Enterprise Linux 9 Benchmark v2.0.0"),
        { family: "rhel", productGeneration: "9" }
    );
    assert.deepEqual(
        identifyCISProduct("CIS VMware ESXi 8.0 Benchmark v1.3.0"),
        { family: "vmware-esxi", productGeneration: "8.0" }
    );
    assert.deepEqual(
        identifyCISProduct("CIS Amazon Web Services Foundations Benchmark v5.0.0"),
        { family: "aws-foundations", productGeneration: null }
    );

    const rhel = parseSCSEMFile(RHEL_PATH);
    assert.equal(rhel.totalControls, 685);
    assert.deepEqual(
        rhel.sheets.filter((sheet) => sheet.sheetType === "test_cases").map((sheet) => sheet.sheetName),
        ["Gen Test Cases", "RHEL 7 Test Cases", "RHEL 8 Test Cases", "RHEL 9 Test Cases"]
    );
    const inference = inferSCSEMTechnologyDetails("unhelpful-upload-name.xlsx", rhel.metadata.subject, rhel);
    assert.equal(inference.technology, "Red Hat Enterprise Linux");
    assert.equal(inference.source, "content");
    assert.equal(inference.confidence, "high");

    const compliance = extractComplianceEvidence(["AC-2", "IA-13"]);
    assert.ok(compliance.pub1075.controlIds.includes("AC-2"));
    assert.ok(!compliance.nist.controlIds.includes("AC-2"));
    assert.ok(compliance.nist.controlIds.includes("IA-13"));
    assert.equal(compliance.nist.version, "5.2.0");

    const currentReference = evaluateOfficialSCSEMReference(
        rhel,
        inference.technology,
        sha256(RHEL_PATH)
    );
    assert.equal(currentReference?.selectedAsBase, false);

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
    oldControl.actualResults = "Assessment carry-forward sentinel";
    oldControl.status = "Pass";

    const upgrade = evaluateOfficialSCSEMReference(oldEsxi, "VMware ESXi", "older-workbook");
    assert.equal(upgrade?.selectedAsBase, true);
    assert.ok(upgrade?.addedSheets.includes("ESXi8.0 Test Cases"));

    const target = esxi.sheets.find((sheet) => /ESXi8/i.test(sheet.sheetName))?.controls[0];
    assert.ok(target);
    const session = {
        originalFileName: "old-esxi7.xlsx",
        inferredTechnology: "VMware ESXi",
        changes: [{
            id: "sheet-routing-test",
            status: "APPROVED",
            action: "updateField",
            testId: target.testId,
            targetSheet: "ESXi8.0 Test Cases",
            field: "description",
            currentValue: target.description || "",
            proposedValue: `${target.description || ""} Verified update.`,
            reason: "Regression test for version-specific export routing.",
            sourceEvidence: { sourceSheet: "ESXi8.0 Test Cases", pub1075Version: "test" },
        }],
        audit: { officialReference: upgrade },
    } as unknown as SCSEMUpdaterSession;

    const outputBuffer = await buildSCSEMUpdaterWorkbookBuffer(
        session,
        esxi,
        resolveOfficialReferencePath(upgrade!),
        oldEsxi
    );
    const outputPath = path.join(os.tmpdir(), `skyshield-scsem-updater-${process.pid}.xlsx`);
    fs.writeFileSync(outputPath, outputBuffer);
    try {
        const output = parseSCSEMFile(outputPath);
        const carried = output.sheets
            .find((sheet) => /ESXI7/i.test(sheet.sheetName))
            ?.controls.find((control) => control.testId === oldControl.testId);
        const updated = output.sheets
            .find((sheet) => /ESXi8/i.test(sheet.sheetName))
            ?.controls.find((control) => control.testId === target.testId);
        assert.equal(carried?.actualResults, "Assessment carry-forward sentinel");
        assert.equal(carried?.status, "Pass");
        assert.ok(updated?.description?.endsWith("Verified update."));

        const zip = await JSZip.loadAsync(outputBuffer);
        const workbookRelationships = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
        if (workbookRelationships?.includes("relationships/calcChain")) {
            assert.ok(zip.file("xl/calcChain.xml"), "calcChain relationship must not dangle");
        }
    } finally {
        fs.rmSync(outputPath, { force: true });
    }

    console.log("SCSEM updater regression checks passed.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
