import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as XLSX from "xlsx";
import {
    matchSCSEMColumnHeader,
    scsemColumnHeaderSignature,
    scsemWorkbookSheetNamesSignature,
} from "../src/lib/scsem-column-schema";
import { officialSCSEMManifest } from "../src/lib/scsem-official-manifest";
import type { SCSEMUpdaterSession } from "../src/lib/scsem-updater-store";
import { buildSCSEMUpdaterWorkbookBuffer } from "../src/lib/scsem-workbook-export";
import { parseSCSEMFile, type ParsedControl } from "../src/lib/xlsx-parser";

XLSX.set_fs(fs);

const GENERIC_WEB_FILE_NAME = "safeguards-scsem-generic-web-server.xlsx";

function cellText(worksheet: XLSX.WorkSheet, address: string): string {
    return String(worksheet[address]?.v || "").trim();
}

async function main() {
    const entry = officialSCSEMManifest().workbooks.find((candidate) =>
        candidate.fileName === GENERIC_WEB_FILE_NAME
    );
    assert.ok(entry, "Pinned Generic Web SCSEM is missing from the manifest");
    const filePath = path.resolve(entry.file);
    const context = {
        workbookSha256: entry.sha256,
        sheetName: "Test Cases",
        headerRow: 1,
    };

    assert.equal(matchSCSEMColumnHeader("Test Method", { ...context, columnIndex: 3 }), "testMethod");
    assert.equal(matchSCSEMColumnHeader("Platform", { ...context, columnIndex: 4 }), "sectionTitle");
    assert.equal(matchSCSEMColumnHeader("Test Method", { ...context, columnIndex: 5 }), "description");
    assert.equal(
        matchSCSEMColumnHeader("Test Method", {
            ...context,
            workbookSha256: "0".repeat(64),
            columnIndex: 5,
        }),
        "testMethod",
        "An unpinned duplicate Test Method header must not be guessed as description"
    );
    assert.equal(
        matchSCSEMColumnHeader("Test Procedures", { ...context, columnIndex: 5 }),
        "testProcedures",
        "A pinned coordinate with the wrong header text must fall back to its actual header meaning"
    );

    const sourceWorkbook = XLSX.readFile(filePath, {
        cellFormula: true,
        cellStyles: true,
        sheetStubs: true,
        sheetRows: 10_000,
    });
    const sourceWorksheet = sourceWorkbook.Sheets["Test Cases"];
    assert.ok(sourceWorksheet, "Generic Web Test Cases sheet is missing");
    const headerSignature = scsemColumnHeaderSignature(
        Array.from({ length: 27 }, (_, columnIndex) =>
            cellText(sourceWorksheet, XLSX.utils.encode_cell({ r: 1, c: columnIndex }))
        )
    );
    const workbookSheetNamesSignature = scsemWorkbookSheetNamesSignature(sourceWorkbook.SheetNames);
    const derivativeContext = {
        ...context,
        workbookSha256: "0".repeat(64),
        headerSignature,
        workbookSheetNamesSignature,
    };
    assert.equal(
        matchSCSEMColumnHeader("Test Method", { ...derivativeContext, columnIndex: 5 }),
        "description",
        "An exact derivative workbook schema must preserve the malformed Generic Web description mapping"
    );
    assert.equal(
        matchSCSEMColumnHeader("Test Method", {
            ...derivativeContext,
            columnIndex: 5,
            headerSignature: scsemColumnHeaderSignature([
                "Test ID",
                "NIST ID",
                "NIST Control Name",
                "Test Method",
                "Platform",
                "Changed Header",
            ]),
        }),
        "testMethod",
        "A derivative override must fail closed when the complete header signature changes"
    );
    assert.equal(
        matchSCSEMColumnHeader("Test Method", {
            ...derivativeContext,
            columnIndex: 5,
            workbookSheetNamesSignature: scsemWorkbookSheetNamesSignature(["Test Cases"]),
        }),
        "testMethod",
        "A derivative override must fail closed when the workbook sheet structure changes"
    );
    const parsed = parseSCSEMFile(filePath);
    const parsedSheet = parsed.sheets.find((sheet) => sheet.sheetName === "Test Cases");
    assert.ok(parsedSheet, "Generic Web Test Cases sheet was not parsed");
    assert.equal(parsedSheet.controls.length, 38);

    for (const control of parsedSheet.controls) {
        const excelRow = control.rowIndex + 1;
        assert.equal(control.testMethod, cellText(sourceWorksheet, `D${excelRow}`));
        assert.equal(control.sectionTitle, cellText(sourceWorksheet, `E${excelRow}`));
        assert.equal(control.description, cellText(sourceWorksheet, `F${excelRow}`));
    }

    const target = parsedSheet.controls[0];
    assert.equal(target.testId, "WEB-01");
    assert.ok(target.description, "Pinned Generic Web description was not parsed");
    const sentinel = `SKYSHIELD_GENERIC_WEB_DESCRIPTION_${entry.sha256.slice(0, 12)}`;
    const session: SCSEMUpdaterSession = {
        id: `column-schema-${entry.sha256.slice(0, 16)}`,
        revision: 0,
        originalFileName: entry.fileName,
        originalFilePath: entry.file,
        uploadedAt: new Date(0).toISOString(),
        inferredTechnology: entry.subject || entry.category,
        status: "review_ready",
        scsem: {
            subject: parsed.metadata.subject,
            version: parsed.metadata.version,
            effectiveDate: parsed.metadata.effectiveDate,
            totalControls: parsed.totalControls,
            testCaseSheets: entry.testCaseSheets,
        },
        changes: [{
            id: `column-schema-change-${entry.sha256.slice(0, 12)}`,
            status: "APPROVED",
            action: "updateField",
            testId: target.testId,
            targetSheet: "Test Cases",
            field: "description",
            currentValue: target.description,
            proposedValue: sentinel,
            reason: "Pinned Generic Web column-schema regression.",
            confidence: "test",
            sourceEvidence: { sourceSheet: "Test Cases" },
        }],
        history: [],
        audit: {
            uploadedSha256: entry.sha256,
            uploadedSizeBytes: entry.sizeBytes,
            officialSource: entry,
        },
    };

    const outputBuffer = await buildSCSEMUpdaterWorkbookBuffer(session, parsed, filePath);
    const outputWorkbook = XLSX.read(outputBuffer, {
        cellFormula: true,
        cellStyles: true,
        sheetStubs: true,
        sheetRows: 10_000,
    });
    const outputWorksheet = outputWorkbook.Sheets["Test Cases"];
    assert.ok(outputWorksheet, "Exported Generic Web Test Cases sheet is missing");
    assert.equal(
        scsemColumnHeaderSignature(
            Array.from({ length: 27 }, (_, columnIndex) =>
                cellText(outputWorksheet, XLSX.utils.encode_cell({ r: 1, c: columnIndex }))
            )
        ),
        headerSignature,
        "Surgical export changed the Generic Web header schema"
    );
    assert.equal(
        scsemWorkbookSheetNamesSignature(outputWorkbook.SheetNames),
        workbookSheetNamesSignature,
        "Surgical export changed the Generic Web sheet structure"
    );
    assert.equal(cellText(outputWorksheet, "F3"), sentinel, "Description was not written to F3");
    for (const address of ["D3", "E3", "G3", "H3"]) {
        assert.equal(
            cellText(outputWorksheet, address),
            cellText(sourceWorksheet, address),
            `${address} changed while updating the pinned description column`
        );
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skyshield-generic-web-schema-"));
    try {
        const outputPath = path.join(tempRoot, "generic-web-candidate.xlsx");
        fs.writeFileSync(outputPath, outputBuffer);
        const reparsed = parseSCSEMFile(outputPath);
        const reparsedSheet = reparsed.sheets.find((sheet) => sheet.sheetName === "Test Cases");
        assert.ok(reparsedSheet, "Exported Generic Web Test Cases sheet was not reparsed");
        assert.equal(reparsedSheet.controls.length, parsedSheet.controls.length);
        for (const sourceControl of parsedSheet.controls) {
            const candidateControl: ParsedControl | undefined = reparsedSheet.controls.find((control) =>
                control.testId === sourceControl.testId
            );
            assert.ok(candidateControl, `Exported Generic Web control ${sourceControl.testId} is missing`);
            assert.equal(candidateControl.testMethod, sourceControl.testMethod);
            assert.equal(candidateControl.sectionTitle, sourceControl.sectionTitle);
            assert.equal(
                candidateControl.description,
                sourceControl.testId === target.testId ? sentinel : sourceControl.description,
                `Exported Generic Web control ${sourceControl.testId} lost its description mapping`
            );
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    process.stdout.write(
        "Verified pinned and derivative Generic Web D/E/F schema resolution, 38 descriptions, and surgical F3 round trip.\n"
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
