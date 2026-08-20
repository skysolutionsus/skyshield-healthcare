import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parseSCSEMFile } from "@/lib/xlsx-parser";
import { readSCSEMIssueCodeCatalog } from "@/lib/scsem-issue-codes";
import { readSCSEMNewControlTargetSchemas } from "@/lib/scsem-new-control-schema";

export interface SCSEMStructuralAdmission {
    trust: "unverified_structural_draft";
    totalControls: number;
    testCaseSheets: string[];
    issueCodeCount: number;
    sha256: string;
    blocker: string;
}

function safeTemporaryName(fileName: string): string {
    const extension = path.extname(fileName).toLowerCase() === ".xlsm" ? ".xlsm" : ".xlsx";
    return `candidate${extension}`;
}

/**
 * Admit a non-manifest workbook only as an explicitly unverified working
 * draft. This is for new or program-supplied SCSEMs that have not yet appeared
 * as an individual hash-pinned IRS download (for example a PostgreSQL draft),
 * not for treating arbitrary spreadsheets as canonical sources.
 */
export function admitUnrecognizedSCSEMBuffer(
    fileName: string,
    workbookBuffer: Buffer
): SCSEMStructuralAdmission {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skyshield-scsem-admission-"));
    const filePath = path.join(tempDir, safeTemporaryName(fileName));
    try {
        fs.writeFileSync(filePath, workbookBuffer, { mode: 0o600 });
        const parsed = parseSCSEMFile(filePath);
        const testCaseSheets = parsed.sheets
            .filter((sheet) => sheet.sheetType === "test_cases")
            .map((sheet) => sheet.sheetName);
        if (testCaseSheets.length === 0 || parsed.totalControls === 0) {
            throw new Error(
                "The workbook is not a recognizable populated SCSEM: no test-case controls were found."
            );
        }
        if (parsed.totalControls > 20_000) {
            throw new Error("The workbook contains too many SCSEM controls for safe interactive review.");
        }

        const sha256 = createHash("sha256").update(workbookBuffer).digest("hex");
        const schemas = readSCSEMNewControlTargetSchemas(filePath, sha256, testCaseSheets);
        if (schemas.size !== testCaseSheets.length) {
            throw new Error("One or more test-case tabs do not have a uniquely identifiable SCSEM header row.");
        }
        const issueCodeCount = readSCSEMIssueCodeCatalog(filePath).size;

        const populatedAssessmentRows = parsed.sheets
            .filter((sheet) => sheet.sheetType === "test_cases")
            .flatMap((sheet) => sheet.controls.map((control) => ({ sheet: sheet.sheetName, control })))
            .filter(({ control }) => [
                control.actualResults,
                control.status,
            ].some((value) => typeof value === "string" && value.trim().length > 0));
        if (populatedAssessmentRows.length > 0) {
            const first = populatedAssessmentRows[0];
            throw new Error(
                `The unrecognized workbook contains agency assessment/response data at ` +
                `${first.sheet}!${first.control.testId}. Upload a blank template copy instead.`
            );
        }

        return {
            trust: "unverified_structural_draft",
            totalControls: parsed.totalControls,
            testCaseSheets,
            issueCodeCount,
            sha256,
            blocker:
                "The uploaded SCSEM is structurally valid but is not hash-matched to the current pinned IRS individual-source corpus. It may be analyzed and exported only as an incomplete working draft until an authorized reviewer verifies its IRS provenance and release status.",
        };
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}
