import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import {
    buildCISBootstrapBlankWorkbook,
    buildCISBootstrapChanges,
    CIS_BOOTSTRAP_TARGET_SHEET,
} from "../src/lib/scsem-cis-bootstrap";
import { parseSCSEMFile } from "../src/lib/xlsx-parser";
import { readSCSEMIssueCodeCatalog } from "../src/lib/scsem-issue-codes";
import { addIdsToChanges, type SCSEMUpdaterSession } from "../src/lib/scsem-updater-store";
import { buildSCSEMUpdaterWorkbookBuffer } from "../src/lib/scsem-workbook-export";
import type { CISBenchmarkRecommendation } from "../src/lib/cis-benchmark-xlsx";

async function main() {
    const blank = buildCISBootstrapBlankWorkbook("IBM Db2 11", "2.0.0", 2);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skyshield-cis-bootstrap-"));
    const blankPath = path.join(tempDir, "db2-cis-working-draft.xlsx");
    const outputPath = path.join(tempDir, "db2-cis-candidate.xlsx");
    fs.writeFileSync(blankPath, blank.buffer, { mode: 0o600 });

    try {
        const parsed = parseSCSEMFile(blankPath);
        assert.equal(parsed.totalControls, 0, "the controlled bootstrap baseline must be blank");
        assert.equal(parsed.metadata.subject, "IBM Db2 11");
        const blankTestSheets = parsed.sheets
            .filter((sheet) => sheet.sheetType === "test_cases")
            .map((sheet) => sheet.sheetName);
        assert.ok(blankTestSheets.includes(CIS_BOOTSTRAP_TARGET_SHEET));
        assert.ok(
            parsed.sheets
                .filter((sheet) => sheet.sheetType === "test_cases")
                .every((sheet) => sheet.controls.length === 0)
        );
        assert.ok(readSCSEMIssueCodeCatalog(blankPath).size > 0);

        const recommendation: CISBenchmarkRecommendation = {
            profile: "Level 1",
            sourceSheet: "Level 1",
            sourceRow: 2,
            section: "1.1",
            recommendation: "1.1.1",
            title: "Ensure the database service is securely configured",
            assessmentStatus: "Manual",
            description: "The database service must use an approved secure configuration.",
            rationale: "A secure baseline reduces avoidable exposure.",
            impact: "Configuration changes require testing.",
            remediation: "Apply the approved secure setting.",
            audit: "Examine the active database configuration and verify the approved setting.",
            additionalInfo: null,
            cisControls: null,
            references: null,
            defaultValue: "The approved secure setting is enabled.",
        };
        const secondRecommendation: CISBenchmarkRecommendation = {
            ...recommendation,
            sourceRow: 3,
            section: "1.2",
            recommendation: "1.1.2",
            title: "Ensure database audit logging is enabled",
            description: "Database audit logging must be enabled for security-relevant activity.",
        };
        const issueCode = [...readSCSEMIssueCodeCatalog(blankPath).keys()][0];
        const changes = addIdsToChanges(buildCISBootstrapChanges({
            recommendations: [recommendation, secondRecommendation],
            workbenchId: 1234,
            benchmarkTitle: "CIS IBM Db2 11 Benchmark",
            benchmarkVersion: "2.0.0",
            profile: "Level 1",
        }));
        for (const change of changes) {
            change.status = "APPROVED";
            change.newControl = {
                ...change.newControl,
                nistId: "CM-6",
                nistControlName: "Configuration Settings",
                issueCode,
            };
        }

        const hash = createHash("sha256").update(blank.buffer).digest("hex");
        const session: SCSEMUpdaterSession = {
            id: randomUUID(),
            revision: 1,
            originalFileName: "Safeguards-SCSEM (IBM Db2 11)-CIS-WORKING-DRAFT.xlsx",
            originalFilePath: blankPath,
            organizationId: "test-organization",
            createdByUserId: "test-user",
            uploadedAt: new Date().toISOString(),
            inferredTechnology: "IBM Db2 11",
            workspaceMode: "cis_bootstrap",
            analysisScope: "full",
            status: "analysis_incomplete",
            scsem: {
                subject: parsed.metadata.subject,
                version: parsed.metadata.version,
                effectiveDate: parsed.metadata.effectiveDate,
                totalControls: 0,
                testCaseSheets: [CIS_BOOTSTRAP_TARGET_SHEET],
            },
            changes,
            history: [],
            audit: {
                uploadedSha256: hash,
                uploadedSizeBytes: blank.buffer.length,
                cisBootstrap: {
                    workbenchId: 1234,
                    benchmarkTitle: "CIS IBM Db2 11 Benchmark",
                    benchmarkVersion: "2.0.0",
                    selectedProfile: "Level 1",
                    recommendationCount: 2,
                    structuralBaseline: blank.baseline,
                },
            },
        };

        const output = await buildSCSEMUpdaterWorkbookBuffer(
            session,
            parsed,
            blankPath
        );
        fs.writeFileSync(outputPath, output, { mode: 0o600 });
        const candidate = parseSCSEMFile(outputPath);
        const target = candidate.sheets.find((sheet) => sheet.sheetName === CIS_BOOTSTRAP_TARGET_SHEET);
        assert.equal(target?.controls.length, 2);
        assert.deepEqual(
            target?.controls.map((control) => control.recommendationNum),
            ["1.1.1", "1.1.2"]
        );
        assert.equal(
            target?.controls[0].description,
            "The database service must use an approved secure configuration."
        );
        assert.equal(target?.controls[0].issueCode, issueCode);

        const workbook = XLSX.read(output, { type: "buffer", cellFormula: true });
        const sheet = workbook.Sheets[CIS_BOOTSTRAP_TARGET_SHEET];
        const formulaCells = Object.keys(sheet).filter((address) =>
            !address.startsWith("!") && typeof sheet[address]?.f === "string"
        );
        assert.ok(formulaCells.length > 0, "bootstrap export must retain computed workbook formulas");
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    process.stdout.write("CIS WorkBench blank-SCSEM bootstrap tests passed.\n");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
