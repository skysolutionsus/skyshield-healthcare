import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as XLSX from "xlsx";
import { matchOfficialSCSEM, officialSCSEMManifest } from "../src/lib/scsem-official-manifest";
import {
    matchSCSEMColumnHeader,
    normalizeSCSEMColumnHeader,
    scsemColumnHeaderSignature,
    scsemWorkbookSheetNamesSignature,
    type SCSEMColumnField,
} from "../src/lib/scsem-column-schema";
import { parseSCSEMFile } from "../src/lib/xlsx-parser";
import { readSCSEMNewControlTargetSchemas } from "../src/lib/scsem-new-control-schema";
import { inferOfficialSCSEMTechnologyDetails } from "../src/lib/scsem-updater-store";
import { evaluateOfficialSCSEMReference } from "../src/lib/scsem-official-reference";

XLSX.set_fs(fs);

const CURRENT_CORPUS_CIS_SECTION_HEADER_COUNT = 72;
const CURRENT_CORPUS_CIS_RECOMMENDATION_HEADER_COUNT = 21;
const CURRENT_CORPUS_ISSUE_CODE_HEADER_COUNT = 125;
const CURRENT_CORPUS_ISSUE_CODE_DESCRIPTION_HEADER_COUNT = 125;
const CURRENT_CORPUS_CRITICALITY_HEADER_COUNT = 125;
const CURRENT_CORPUS_RISK_RATING_HEADER_COUNT = 125;
const CURRENT_CORPUS_FINDING_STATEMENT_HEADER_COUNT = 72;
const CURRENT_CORPUS_REMEDIATION_STATEMENT_HEADER_COUNT = 73;
const CURRENT_CORPUS_CAP_REQUEST_STATEMENT_HEADER_COUNT = 69;

function testCaseHeaderDetails(worksheet: XLSX.WorkSheet): {
    headers: string[];
    headerRow: number;
    startColumn: number;
} {
    const ref = worksheet["!ref"];
    assert.ok(ref, "Test-case worksheet has no dimension");
    const range = XLSX.utils.decode_range(ref);

    for (let row = range.s.r; row <= Math.min(range.e.r, range.s.r + 10); row++) {
        const headers: string[] = [];
        let hasTestId = false;
        for (let col = range.s.c; col <= range.e.c; col++) {
            const value = String(
                worksheet[XLSX.utils.encode_cell({ r: row, c: col })]?.v || ""
            ).trim();
            headers.push(value);
            if (matchSCSEMColumnHeader(value) === "testId") hasTestId = true;
        }
        if (hasTestId) return { headers, headerRow: row, startColumn: range.s.c };
    }

    assert.fail("Test-case worksheet has no Test ID header row");
}

function testCaseHeaderRow(worksheet: XLSX.WorkSheet): string[] {
    return testCaseHeaderDetails(worksheet).headers;
}

function assertCurrentCorpusCISHeaders(
    entry: ReturnType<typeof officialSCSEMManifest>["workbooks"][number],
    workbook: XLSX.WorkBook
): { sectionHeaders: number; recommendationHeaders: number } {
    let sectionHeaders = 0;
    let recommendationHeaders = 0;

    for (const sheetName of entry.testCaseSheets) {
        const worksheet = workbook.Sheets[sheetName];
        assert.ok(worksheet, `${entry.file}: missing test-case sheet ${sheetName}`);
        const mappedCISColumns = new Map<SCSEMColumnField, string>();

        for (const header of testCaseHeaderRow(worksheet)) {
            const normalized = normalizeSCSEMColumnHeader(header);
            const expectedField =
                /^cis (?:benchmark(?: section)?|section)\s*#$/i.test(normalized)
                    ? "cisBenchmarkRef"
                    : /^cis recommendation\s*#$/i.test(normalized)
                        ? "recommendationNum"
                        : null;
            if (!expectedField) continue;

            assert.equal(
                matchSCSEMColumnHeader(header),
                expectedField,
                `${entry.file}/${sheetName}: unmapped CIS header ${JSON.stringify(header)}`
            );
            assert.ok(
                !mappedCISColumns.has(expectedField),
                `${entry.file}/${sheetName}: duplicate ${expectedField} columns ` +
                    `${JSON.stringify(mappedCISColumns.get(expectedField))} and ${JSON.stringify(header)}`
            );
            mappedCISColumns.set(expectedField, header);
            if (expectedField === "cisBenchmarkRef") sectionHeaders++;
            else recommendationHeaders++;
        }
    }

    return { sectionHeaders, recommendationHeaders };
}

function expectedIssueOrRiskField(
    normalized: string,
    normalizedHeaders: ReadonlyArray<string>
):
    | "issueCode"
    | "issueCodeDescription"
    | "criticality"
    | "riskRating"
    | "findingStatement"
    | "remediationStatement"
    | "capRequestStatement"
    | null {
    if (normalized === "issue code") return "issueCode";
    if (normalized === "issue code mapping") {
        return normalizedHeaders.includes("issue code")
            ? "issueCodeDescription"
            : "issueCode";
    }
    if (
        /^issue code description(?: \(select one to enter in column [a-z]{1,3}\))?$/.test(normalized) ||
        /^issue code mapping \(select one to enter in column [a-z]{1,3}\)$/.test(normalized)
    ) {
        return "issueCodeDescription";
    }
    if (/^criticality(?: rating)?$/.test(normalized)) return "criticality";
    if (/^(?:risk|criticality) rating \(do not edit\)$/.test(normalized)) return "riskRating";
    if (/^finding statement(?: \(internal use only\))?$/.test(normalized)) return "findingStatement";
    if (/^remediation statement(?: \(internal use only\))?$/.test(normalized)) {
        return "remediationStatement";
    }
    if (/^cap request statement \(internal use only\)$/.test(normalized)) {
        return "capRequestStatement";
    }
    return null;
}

function assertCurrentCorpusIssueAndRiskHeaders(
    entry: ReturnType<typeof officialSCSEMManifest>["workbooks"][number],
    workbook: XLSX.WorkBook
): {
    issueCode: number;
    issueCodeDescription: number;
    criticality: number;
    riskRating: number;
    findingStatement: number;
    remediationStatement: number;
    capRequestStatement: number;
} {
    const counts = {
        issueCode: 0,
        issueCodeDescription: 0,
        criticality: 0,
        riskRating: 0,
        findingStatement: 0,
        remediationStatement: 0,
        capRequestStatement: 0,
    };
    const workbookSheetNamesSignature = scsemWorkbookSheetNamesSignature(workbook.SheetNames);

    for (const sheetName of entry.testCaseSheets) {
        const worksheet = workbook.Sheets[sheetName];
        assert.ok(worksheet, `${entry.file}: missing test-case sheet ${sheetName}`);
        const mappedHeaders = new Map<SCSEMColumnField, string>();
        const { headers, headerRow, startColumn } = testCaseHeaderDetails(worksheet);
        const normalizedHeaders = headers.map(normalizeSCSEMColumnHeader);
        const headerSignature = scsemColumnHeaderSignature(headers);

        for (let index = 0; index < headers.length; index++) {
            const header = headers[index];
            const normalized = normalizeSCSEMColumnHeader(header);
            const expectedField = expectedIssueOrRiskField(normalized, normalizedHeaders);
            if (!expectedField) continue;

            assert.equal(
                matchSCSEMColumnHeader(header, {
                    workbookSha256: entry.sha256,
                    sheetName,
                    headerRow,
                    columnIndex: startColumn + index,
                    headerSignature,
                    workbookSheetNamesSignature,
                }),
                expectedField,
                `${entry.file}/${sheetName}: unmapped or misclassified header ${JSON.stringify(header)}`
            );
            assert.ok(
                !mappedHeaders.has(expectedField),
                `${entry.file}/${sheetName}: colliding ${expectedField} headers ` +
                    `${JSON.stringify(mappedHeaders.get(expectedField))} and ${JSON.stringify(header)}`
            );
            mappedHeaders.set(expectedField, header);
            counts[expectedField]++;
        }
    }

    return counts;
}

function sha256(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

function main() {
    assert.equal(matchSCSEMColumnHeader("CIS Benchmark Section #"), "cisBenchmarkRef");
    assert.equal(matchSCSEMColumnHeader("CIS Benchmark Section#"), "cisBenchmarkRef");
    assert.equal(matchSCSEMColumnHeader("CIS Section #"), "cisBenchmarkRef");
    assert.equal(matchSCSEMColumnHeader("CIS Benchmark #"), "cisBenchmarkRef");
    assert.equal(matchSCSEMColumnHeader("CIS Recommendation #"), "recommendationNum");
    assert.equal(matchSCSEMColumnHeader("CIS Benchmark Section guidance"), null);
    assert.equal(matchSCSEMColumnHeader("CIS Recommendation rationale"), null);
    assert.equal(matchSCSEMColumnHeader("Issue Code Mapping"), "issueCode");
    assert.equal(matchSCSEMColumnHeader("Issue Code"), "issueCode");
    assert.equal(matchSCSEMColumnHeader("Issue Code Description"), "issueCodeDescription");
    assert.equal(
        matchSCSEMColumnHeader("Issue Code Mapping (Select one to enter in column N)"),
        "issueCodeDescription"
    );
    assert.equal(
        matchSCSEMColumnHeader("Issue Code Description (Select one to enter in column L)"),
        "issueCodeDescription"
    );
    assert.equal(matchSCSEMColumnHeader("Risk Rating (Do Not Edit)"), "riskRating");
    assert.equal(matchSCSEMColumnHeader("Criticality Rating"), "criticality");
    assert.equal(matchSCSEMColumnHeader("Criticality Rating (Do Not Edit)"), "riskRating");
    assert.equal(matchSCSEMColumnHeader("Issue Code Mapping guidance"), null);
    assert.equal(
        matchSCSEMColumnHeader("Issue Code Mapping (Select one to enter in column N) extra"),
        null
    );
    assert.equal(matchSCSEMColumnHeader("Risk Rating (Do Not Edit) Notes"), null);
    assert.equal(
        matchSCSEMColumnHeader("Finding Statement (Internal Use Only)"),
        "findingStatement"
    );
    assert.equal(
        matchSCSEMColumnHeader("Remediation Statement (Internal Use Only)"),
        "remediationStatement"
    );
    assert.equal(
        matchSCSEMColumnHeader("CAP Request Statement (Internal Use Only)"),
        "capRequestStatement"
    );
    assert.equal(matchSCSEMColumnHeader("Finding Statement (Internal Use Only) Notes"), null);
    assert.equal(matchSCSEMColumnHeader("Remediation Statement (Internal Use Only) Notes"), null);
    assert.equal(matchSCSEMColumnHeader("CAP Request Statement (Internal Use Only) Notes"), null);

    const manifest = officialSCSEMManifest();
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.sourcePolicy, "individual_xlsx_links");
    assert.equal(
        manifest.conflictingPackageAudit.status,
        "excluded_conflicting_snapshot"
    );
    assert.equal(manifest.conflictingPackageAudit.workbookCount, 62);
    assert.equal(manifest.conflictingPackageAudit.totalControls, 11_564);
    assert.equal(manifest.conflictingPackageAudit.pairedWorkbookCount, 59);
    assert.equal(manifest.conflictingPackageAudit.pairedControlCount, 10_782);
    assert.equal(manifest.conflictingPackageAudit.packageOnly.length, 3);
    assert.equal(manifest.conflictingPackageAudit.directOnly.length, 1);
    assert.equal(manifest.conflictingPackageAudit.allPairedRawHashesDiffer, true);
    assert.equal(manifest.conflictingPackageAudit.allPairedDirectCoreModifiedLater, false);
    assert.match(manifest.conflictingPackageAudit.sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.expectedWorkbookCount, 60);
    assert.equal(manifest.workbooks.length, 60);
    assert.equal(new Set(manifest.workbooks.map((entry) => entry.sha256)).size, 60);
    assert.equal(new Set(manifest.workbooks.map((entry) => entry.sourceUrl)).size, 60);
    assert.equal(new Set(manifest.workbooks.map((entry) => entry.file)).size, 60);
    const index = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "data/scsem-index.json"), "utf8")
    ) as Array<{ id?: string; file: string; name: string }>;
    assert.equal(index.length, 60);
    assert.equal(new Set(index.map((entry) => entry.id)).size, 60, "SCSEM seed IDs must be unique");
    assert.ok(index.every((entry) => entry.id?.startsWith("official-")), "Every SCSEM needs a pinned seed ID");
    assert.equal(new Set(index.map((entry) => entry.file)).size, 60);
    assert.equal(new Set(index.map((entry) => entry.name)).size, 60, "SCSEM display names must be unique");

    let totalControls = 0;
    let cisSectionHeaders = 0;
    let cisRecommendationHeaders = 0;
    let issueCodeHeaders = 0;
    let issueCodeDescriptionHeaders = 0;
    let criticalityHeaders = 0;
    let riskRatingHeaders = 0;
    let findingStatementHeaders = 0;
    let remediationStatementHeaders = 0;
    let capRequestStatementHeaders = 0;
    let schemaFindingUnique = 0;
    let schemaFindingAbsent = 0;
    let schemaFindingAmbiguous = 0;
    let workbooksWithFindingColumn = 0;
    for (const entry of manifest.workbooks) {
        assert.match(entry.sourceUrl, /^https:\/\/www\.irs\.gov\/pub\/safeguard\//i);
        const filePath = path.join(process.cwd(), entry.file);
        assert.ok(fs.existsSync(filePath), `Missing pinned workbook ${entry.file}`);
        const buffer = fs.readFileSync(filePath);
        assert.equal(buffer.length, entry.sizeBytes, `Size mismatch: ${entry.file}`);
        assert.equal(sha256(buffer), entry.sha256, `Hash mismatch: ${entry.file}`);
        assert.equal(matchOfficialSCSEM(buffer)?.sourceUrl, entry.sourceUrl);

        const headerWorkbook = XLSX.read(buffer, { sheetRows: 20 });
        const cisHeaders = assertCurrentCorpusCISHeaders(entry, headerWorkbook);
        cisSectionHeaders += cisHeaders.sectionHeaders;
        cisRecommendationHeaders += cisHeaders.recommendationHeaders;
        const issueHeaders = assertCurrentCorpusIssueAndRiskHeaders(entry, headerWorkbook);
        issueCodeHeaders += issueHeaders.issueCode;
        issueCodeDescriptionHeaders += issueHeaders.issueCodeDescription;
        criticalityHeaders += issueHeaders.criticality;
        riskRatingHeaders += issueHeaders.riskRating;
        findingStatementHeaders += issueHeaders.findingStatement;
        remediationStatementHeaders += issueHeaders.remediationStatement;
        capRequestStatementHeaders += issueHeaders.capRequestStatement;

        const targetSchemas = readSCSEMNewControlTargetSchemas(
            filePath,
            entry.sha256,
            entry.testCaseSheets
        );
        assert.equal(targetSchemas.size, entry.testCaseSheets.length);
        let workbookHasFindingColumn = false;
        for (const schema of targetSchemas.values()) {
            if (schema.findingStatement === "unique") {
                schemaFindingUnique++;
                workbookHasFindingColumn = true;
            } else if (schema.findingStatement === "absent") {
                schemaFindingAbsent++;
            } else {
                schemaFindingAmbiguous++;
            }
        }
        if (workbookHasFindingColumn) workbooksWithFindingColumn++;

        const parsed = parseSCSEMFile(filePath);
        assert.equal(parsed.totalControls, entry.totalControls, `Control count mismatch: ${entry.file}`);
        assert.deepEqual(
            parsed.sheets
                .filter((sheet) => sheet.sheetType === "test_cases")
                .map((sheet) => sheet.sheetName),
            entry.testCaseSheets,
            `Test-case sheet mismatch: ${entry.file}`
        );
        assert.ok(parsed.totalControls > 0, `No controls parsed: ${entry.file}`);
        const inference = inferOfficialSCSEMTechnologyDetails(entry, parsed);
        assert.equal(
            inference.source,
            "official_manifest",
            `${entry.file}: current official identity must be manifest-bound`
        );
        const reference = evaluateOfficialSCSEMReference(
            parsed,
            inference.technology,
            entry.sha256
        );
        assert.ok(
            !reference || reference.sha256 === entry.sha256,
            `${entry.file}: exact current input resolved to a different official workbook`
        );
        assert.equal(
            reference?.selectedAsBase ?? false,
            false,
            `${entry.file}: an exact current input must remain its own analysis/export base`
        );
        const analysisRowCount = reference?.selectedAsBase
            ? parseSCSEMFile(path.join(process.cwd(), reference.filePath)).totalControls
            : parsed.totalControls;
        assert.equal(
            analysisRowCount,
            entry.totalControls,
            `${entry.file}: analysis row count must equal the admitted manifest source`
        );
        const exportBaseSha256 = reference?.selectedAsBase ? reference.sha256 : entry.sha256;
        assert.equal(
            exportBaseSha256,
            entry.sha256,
            `${entry.file}: export base must remain the admitted manifest source`
        );
        totalControls += parsed.totalControls;
        global.gc?.();
    }


    assert.equal(totalControls, 11_055);
    assert.equal(
        cisSectionHeaders,
        CURRENT_CORPUS_CIS_SECTION_HEADER_COUNT,
        "Current SCSEM corpus CIS section-header coverage changed"
    );
    assert.equal(
        cisRecommendationHeaders,
        CURRENT_CORPUS_CIS_RECOMMENDATION_HEADER_COUNT,
        "Current SCSEM corpus CIS recommendation-header coverage changed"
    );
    assert.equal(
        issueCodeHeaders,
        CURRENT_CORPUS_ISSUE_CODE_HEADER_COUNT,
        "Current SCSEM corpus Issue Code header coverage changed"
    );
    assert.equal(
        issueCodeDescriptionHeaders,
        CURRENT_CORPUS_ISSUE_CODE_DESCRIPTION_HEADER_COUNT,
        "Current SCSEM corpus Issue Code Description header coverage changed"
    );
    assert.equal(
        criticalityHeaders,
        CURRENT_CORPUS_CRITICALITY_HEADER_COUNT,
        "Current SCSEM corpus Criticality header coverage changed"
    );
    assert.equal(
        riskRatingHeaders,
        CURRENT_CORPUS_RISK_RATING_HEADER_COUNT,
        "Current SCSEM corpus Risk Rating header coverage changed"
    );
    assert.equal(
        findingStatementHeaders,
        CURRENT_CORPUS_FINDING_STATEMENT_HEADER_COUNT,
        "Current SCSEM corpus Finding Statement header coverage changed"
    );
    assert.equal(
        remediationStatementHeaders,
        CURRENT_CORPUS_REMEDIATION_STATEMENT_HEADER_COUNT,
        "Current SCSEM corpus Remediation Statement header coverage changed"
    );
    assert.equal(
        capRequestStatementHeaders,
        CURRENT_CORPUS_CAP_REQUEST_STATEMENT_HEADER_COUNT,
        "Current SCSEM corpus CAP Request Statement header coverage changed"
    );
    assert.equal(schemaFindingUnique, 72, "Finding Statement target-schema coverage changed");
    assert.equal(schemaFindingAbsent, 53, "Finding Statement-free target-schema coverage changed");
    assert.equal(schemaFindingAmbiguous, 0, "Finding Statement target schema became ambiguous");
    assert.equal(workbooksWithFindingColumn, 38, "Workbook Finding Statement coverage changed");
    process.stdout.write(`Verified all ${manifest.workbooks.length} pinned IRS SCSEMs (${totalControls} controls).\n`);
}

main();
