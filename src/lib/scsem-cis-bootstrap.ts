import * as fs from "node:fs";
import * as path from "node:path";
import * as XLSX from "xlsx";
import { officialSCSEMManifest, sha256Buffer } from "@/lib/scsem-official-manifest";
import { parseSCSEMFile } from "@/lib/xlsx-parser";
import type { CISBenchmarkRecommendation } from "@/lib/cis-benchmark-xlsx";
import { translateCopiedSCSEMFormula } from "@/lib/scsem-formula-translation";

XLSX.set_fs(fs);

export const CIS_BOOTSTRAP_TARGET_SHEET = "General App Test Cases";

export interface CISBootstrapStructuralBaseline {
    sourceFileName: string;
    sourceUrl: string;
    sourceSha256: string;
    sourceVersion: string | null;
    targetSheet: string;
}

function genericApplicationBaseline() {
    const entry = officialSCSEMManifest().workbooks.find((candidate) =>
        candidate.subject === "Generic Application"
    );
    if (!entry) throw new Error("The pinned Generic Application SCSEM baseline is unavailable.");

    const absolutePath = path.join(process.cwd(), entry.file);
    const buffer = fs.readFileSync(absolutePath);
    if (buffer.length !== entry.sizeBytes || sha256Buffer(buffer) !== entry.sha256) {
        throw new Error("The pinned Generic Application SCSEM baseline failed integrity validation.");
    }
    return { entry, absolutePath, buffer };
}

function replaceDashboardMetadata(
    workbook: XLSX.WorkBook,
    technology: string,
    benchmarkVersion: string
) {
    const worksheet = workbook.Sheets.Dashboard;
    if (!worksheet) return;

    for (const address of Object.keys(worksheet)) {
        if (address.startsWith("!")) continue;
        const cell = worksheet[address];
        const value = typeof cell?.v === "string" ? cell.v : "";
        if (/SCSEM Subject:/i.test(value)) {
            cell.v = value.replace(/SCSEM Subject:\s*.*/i, `SCSEM Subject: ${technology}`);
            cell.w = undefined;
        } else if (/SCSEM Version:/i.test(value)) {
            cell.v = value.replace(/SCSEM Version:\s*.*/i, "SCSEM Version: WORKING DRAFT");
            cell.w = undefined;
        } else if (/SCSEM (?:Effective|Release) Date:/i.test(value)) {
            cell.v = value.replace(
                /SCSEM (?:Effective|Release) Date:\s*.*/i,
                "SCSEM Effective Date: NOT RELEASED"
            );
            cell.w = undefined;
        }
    }

    const noteAddress = "A20";
    worksheet[noteAddress] = {
        ...(worksheet[noteAddress] || {}),
        t: "s",
        v:
            `SkyShield CIS WorkBench bootstrap working draft. CIS Benchmark revision ${benchmarkVersion}. ` +
            "This workbook is not an official IRS SCSEM and requires Publication 1075/NIST mapping, " +
            "issue-code review, quality control, and release approval.",
    };
    if (worksheet["!ref"]) {
        const range = XLSX.utils.decode_range(worksheet["!ref"]);
        range.e.r = Math.max(range.e.r, 19);
        worksheet["!ref"] = XLSX.utils.encode_range(range);
    }
}

/**
 * Create a controlled blank working-draft shell from the pinned Generic
 * Application SCSEM. Non-control sheets and the IRS Issue Code Table remain in
 * place. The first former control row is retained as a formula/style anchor,
 * but every control value (including Test ID) is cleared.
 */
export function buildCISBootstrapBlankWorkbook(
    technology: string,
    benchmarkVersion: string,
    candidateRowCount = 1
): { buffer: Buffer; baseline: CISBootstrapStructuralBaseline } {
    const { entry, absolutePath, buffer: sourceBuffer } = genericApplicationBaseline();
    const parsed = parseSCSEMFile(absolutePath);
    const parsedTestSheets = parsed.sheets.filter((sheet) => sheet.sheetType === "test_cases");
    const targetParsedSheet = parsedTestSheets.find((sheet) =>
        sheet.sheetName === CIS_BOOTSTRAP_TARGET_SHEET
    );
    if (!targetParsedSheet || targetParsedSheet.controls.length === 0) {
        throw new Error("The pinned Generic Application baseline has no usable control-row anchor.");
    }

    const workbook = XLSX.read(sourceBuffer, {
        type: "buffer",
        cellFormula: true,
        cellStyles: true,
        cellDates: false,
    });
    for (const parsedSheet of parsedTestSheets) {
        if (parsedSheet.controls.length === 0) continue;
        const worksheet = workbook.Sheets[parsedSheet.sheetName];
        if (!worksheet?.["!ref"]) {
            throw new Error(`The pinned Generic Application sheet ${parsedSheet.sheetName} is unavailable.`);
        }
        const range = XLSX.utils.decode_range(worksheet["!ref"]);
        const sortedControlRows = [...new Set(
            parsedSheet.controls.map((control) => control.rowIndex)
        )].sort((left, right) => left - right);
        const anchorRow = sortedControlRows[0];
        const boundedCandidateRowCount = Math.max(1, Math.min(Math.floor(candidateRowCount), 5000));
        const preservedBlankRows = new Set(
            parsedSheet.sheetName === CIS_BOOTSTRAP_TARGET_SHEET
                ? Array.from(
                    { length: boundedCandidateRowCount + 1 },
                    (_, index) => anchorRow + index
                )
                : sortedControlRows.slice(0, 1)
        );
        const controlRows = new Set(sortedControlRows);

        for (const row of controlRows) {
            for (let col = range.s.c; col <= range.e.c; col++) {
                const address = XLSX.utils.encode_cell({ r: row, c: col });
                const cell = worksheet[address];
                if (!preservedBlankRows.has(row)) {
                    delete worksheet[address];
                    continue;
                }
                if (!cell) {
                    worksheet[address] = { t: "s", v: "" };
                    continue;
                }
                if (typeof cell.f === "string" && cell.f.trim()) {
                    delete cell.v;
                    delete cell.w;
                    continue;
                }
                worksheet[address] = {
                    ...cell,
                    t: "s",
                    v: "",
                    w: undefined,
                };
            }
        }

        if (parsedSheet.sheetName === CIS_BOOTSTRAP_TARGET_SHEET) {
            const headerRow = anchorRow - 1;
            const sourceHeaderAddress = XLSX.utils.encode_cell({ r: headerRow, c: range.e.c });
            const sourceHeader = worksheet[sourceHeaderAddress] || { t: "s", v: "" };
            const sourceAnchorAddress = XLSX.utils.encode_cell({ r: anchorRow, c: range.e.c });
            const sourceAnchor = worksheet[sourceAnchorAddress] || { t: "s", v: "" };
            const cisReferenceCol = range.e.c + 1;
            const recommendationCol = range.e.c + 2;
            worksheet[XLSX.utils.encode_cell({ r: headerRow, c: cisReferenceCol })] = {
                ...sourceHeader,
                t: "s",
                v: "CIS Benchmark Ref",
                w: undefined,
            };
            worksheet[XLSX.utils.encode_cell({ r: headerRow, c: recommendationCol })] = {
                ...sourceHeader,
                t: "s",
                v: "CIS Recommendation #",
                w: undefined,
            };
            for (const row of preservedBlankRows) {
                for (const col of [cisReferenceCol, recommendationCol]) {
                    worksheet[XLSX.utils.encode_cell({ r: row, c: col })] = {
                        ...sourceAnchor,
                        t: "s",
                        v: "",
                        f: undefined,
                        w: undefined,
                    };
                }
            }
            range.e.c = recommendationCol;
        }

        if (parsedSheet.sheetName === CIS_BOOTSTRAP_TARGET_SHEET) {
            for (const row of preservedBlankRows) {
                for (let col = range.s.c; col <= range.e.c; col++) {
                    const sourceAddress = XLSX.utils.encode_cell({ r: anchorRow, c: col });
                    const targetAddress = XLSX.utils.encode_cell({ r: row, c: col });
                    const source = worksheet[sourceAddress] || { t: "s", v: "" };
                    worksheet[targetAddress] = typeof source.f === "string" && source.f.trim()
                        ? {
                            ...source,
                            f: translateCopiedSCSEMFormula(
                                source.f,
                                row - anchorRow,
                                { formulaType: null }
                            ),
                            v: undefined,
                            w: undefined,
                        }
                        : {
                            ...source,
                            t: "s",
                            v: "",
                            f: undefined,
                            w: undefined,
                        };
                }
                if (worksheet["!rows"]?.[anchorRow]) {
                    worksheet["!rows"]![row] = { ...worksheet["!rows"]![anchorRow] };
                }
            }
        }

        const lastPreservedBlankRow = Math.max(...preservedBlankRows);
        range.e.r = Math.max(range.s.r, lastPreservedBlankRow);
        worksheet["!ref"] = XLSX.utils.encode_range(range);
        const sheetWithFilter = worksheet as XLSX.WorkSheet & {
            "!autofilter"?: { ref: string };
        };
        if (sheetWithFilter["!autofilter"]?.ref) {
            const filterRange = XLSX.utils.decode_range(sheetWithFilter["!autofilter"].ref);
            filterRange.e.r = Math.max(filterRange.s.r, lastPreservedBlankRow);
            sheetWithFilter["!autofilter"].ref = XLSX.utils.encode_range(filterRange);
        }
    }
    replaceDashboardMetadata(workbook, technology, benchmarkVersion);

    const output = XLSX.write(workbook, {
        type: "buffer",
        bookType: "xlsx",
        cellStyles: true,
        compression: true,
    });
    const outputBuffer = Buffer.isBuffer(output) ? output : Buffer.from(output);

    return {
        buffer: outputBuffer,
        baseline: {
            sourceFileName: entry.fileName,
            sourceUrl: entry.sourceUrl,
            sourceSha256: entry.sha256,
            sourceVersion: entry.version,
            targetSheet: CIS_BOOTSTRAP_TARGET_SHEET,
        },
    };
}

function safeRecommendationId(value: string): string {
    return value
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "RECOMMENDATION";
}

export function buildCISBootstrapChanges({
    recommendations,
    workbenchId,
    benchmarkTitle,
    benchmarkVersion,
    profile,
}: {
    recommendations: CISBenchmarkRecommendation[];
    workbenchId: number;
    benchmarkTitle: string;
    benchmarkVersion: string;
    profile: string;
}) {
    return recommendations.slice(0, 5000).map((recommendation) => ({
        action: "addControl" as const,
        testId: `NEW-CIS-${workbenchId}-${safeRecommendationId(recommendation.recommendation)}`,
        targetSheet: CIS_BOOTSTRAP_TARGET_SHEET,
        field: "newControl",
        currentValue: "Not present in the blank working-draft SCSEM.",
        proposedValue: `CIS ${recommendation.recommendation}: ${recommendation.title}`,
        reason:
            `Bootstrap candidate from ${benchmarkTitle} v${benchmarkVersion}, profile ${profile}, ` +
            `CIS WorkBench ID ${workbenchId}. The recommendation is direct licensed benchmark evidence, ` +
            "but it is not yet an IRS requirement or an applicability decision. Map Publication 1075/NIST, " +
            "select an exact IRS issue code, and edit SCSEM wording before approval.",
        confidence: "needs_review",
        newControl: {
            nistId: null,
            nistControlName: null,
            testMethod: recommendation.assessmentStatus || "Manual",
            sectionTitle: recommendation.title,
            description: recommendation.description || recommendation.title,
            testProcedures: recommendation.audit,
            expectedResults: recommendation.defaultValue || recommendation.audit,
            findingStatement: recommendation.title
                ? `The expected result was not met for ${recommendation.title}.`
                : null,
            criticality: "Moderate",
            issueCode: null,
            cisBenchmarkRef: recommendation.section,
            recommendationNum: recommendation.recommendation,
            rationale: recommendation.rationale,
            impact: recommendation.impact,
            remediationProcedure: recommendation.remediation,
        },
        sourceEvidence: {
            evidenceTier: "direct",
            sourceRelationship: "direct",
            cisRecommendation: recommendation.recommendation,
            cisProfile: profile,
            stigRecommendation: null,
            stigProfile: null,
            sourceWorkbenchId: workbenchId,
            sourceBenchmarkTitle: benchmarkTitle,
            sourceSheet: CIS_BOOTSTRAP_TARGET_SHEET,
            pub1075Version: null,
            nistVersion: null,
            bootstrapDraft: true,
        },
    }));
}
