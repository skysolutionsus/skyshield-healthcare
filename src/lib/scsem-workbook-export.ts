import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";
import type { ParsedControl, ParsedSCSEM, ParsedSheet } from "@/lib/xlsx-parser";
import type { SCSEMUpdaterChange, SCSEMUpdaterSession } from "@/lib/scsem-updater-store";
import { ALLOWED_UPDATE_FIELDS } from "@/lib/scsem-update-engine";

type ExportField =
    | "testId"
    | "nistId"
    | "nistControlName"
    | "testMethod"
    | "sectionTitle"
    | "description"
    | "testProcedures"
    | "expectedResults"
    | "actualResults"
    | "status"
    | "findingStatement"
    | "notesEvidence"
    | "criticality"
    | "issueCode"
    | "issueCodeDescription"
    | "cisBenchmarkRef"
    | "recommendationNum"
    | "rationale"
    | "impact"
    | "remediationProcedure"
    | "remediationStatement"
    | "capRequestStatement"
    | "riskRating";

type ExportControl = ParsedControl & {
    updateHighlight?: boolean;
};

type ExportSheet = ParsedSheet & {
    controls: ExportControl[];
};

type ChangeLogEntry = {
    version: string;
    changeDate: Date;
    description: string;
    changedBy?: string | null;
    source: string;
};

const HEADER_PATTERNS: Array<[ExportField, RegExp[]]> = [
    ["testId", [/^test id$/i]],
    ["nistId", [/^nist id$/i]],
    ["nistControlName", [/^nist control/i]],
    ["testMethod", [/^test method$/i]],
    ["sectionTitle", [/^section title$/i]],
    ["description", [/^description$/i]],
    ["testProcedures", [/^test procedure/i]],
    ["expectedResults", [/^expected result/i]],
    ["actualResults", [/^actual result/i]],
    ["status", [/^status$/i]],
    ["findingStatement", [/^finding statement$/i]],
    ["notesEvidence", [/notes/i, /evidence/i]],
    ["criticality", [/^criticality$/i]],
    ["issueCodeDescription", [/^issue code description$/i]],
    ["issueCode", [/^issue code mapping$/i, /^issue code$/i]],
    ["cisBenchmarkRef", [/cis benchmark/i]],
    ["recommendationNum", [/^recommendation/i]],
    ["rationale", [/^rationale$/i]],
    ["impact", [/^impact$/i]],
    ["remediationProcedure", [/^remediation procedure$/i]],
    ["remediationStatement", [/^remediation statement$/i]],
    ["capRequestStatement", [/^cap request/i]],
    ["riskRating", [/^risk rating$/i]],
];

function cellText(worksheet: XLSX.WorkSheet, row: number, col: number): string {
    const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: col })];
    if (!cell || cell.v === undefined || cell.v === null) return "";
    return String(cell.v).trim();
}

function setCellValue(worksheet: XLSX.WorkSheet, row: number, col: number, value: unknown) {
    const address = XLSX.utils.encode_cell({ r: row, c: col });
    const existing = worksheet[address] || {};
    const nextValue = value === undefined || value === null ? "" : value;
    worksheet[address] = {
        ...existing,
        t: typeof nextValue === "number" ? "n" : typeof nextValue === "boolean" ? "b" : "s",
        v: nextValue,
    };
}

function normalizeHeader(value: string): string {
    return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function matchHeader(header: string): ExportField | null {
    const normalized = normalizeHeader(header);
    for (const [field, patterns] of HEADER_PATTERNS) {
        if (patterns.some((pattern) => pattern.test(normalized))) return field;
    }
    return null;
}

function findHeader(worksheet: XLSX.WorkSheet): {
    headerRow: number;
    testIdCol: number;
    columns: Map<ExportField, number>;
    range: XLSX.Range;
} | null {
    const ref = worksheet["!ref"];
    if (!ref) return null;

    const range = XLSX.utils.decode_range(ref);
    const maxHeaderRow = Math.min(range.e.r, range.s.r + 15);

    for (let row = range.s.r; row <= maxHeaderRow; row++) {
        let testIdCol = -1;
        const columns = new Map<ExportField, number>();

        for (let col = range.s.c; col <= range.e.c; col++) {
            const header = cellText(worksheet, row, col);
            const field = matchHeader(header);
            if (!field || columns.has(field)) continue;
            columns.set(field, col);
            if (field === "testId") testIdCol = col;
        }

        if (testIdCol !== -1) {
            return { headerRow: row, testIdCol, columns, range };
        }
    }

    return null;
}

function buildRowByTestId(worksheet: XLSX.WorkSheet, header: ReturnType<typeof findHeader>): Map<string, number> {
    const rows = new Map<string, number>();
    if (!header) return rows;

    for (let row = header.headerRow + 1; row <= header.range.e.r; row++) {
        const testId = cellText(worksheet, row, header.testIdCol);
        if (testId) rows.set(testId, row);
    }

    return rows;
}

function getControlValue(control: ExportControl, field: ExportField): string {
    return String((control as unknown as Record<string, unknown>)[field] || "");
}

function copyRowFormatting(worksheet: XLSX.WorkSheet, fromRow: number, toRow: number, range: XLSX.Range) {
    for (let col = range.s.c; col <= range.e.c; col++) {
        const fromAddress = XLSX.utils.encode_cell({ r: fromRow, c: col });
        const toAddress = XLSX.utils.encode_cell({ r: toRow, c: col });
        const source = worksheet[fromAddress];
        if (!source) continue;

        worksheet[toAddress] = {
            ...(worksheet[toAddress] || { t: "s", v: "" }),
            s: source.s,
            z: source.z,
        };
    }
}

function patchTestCaseSheet(worksheet: XLSX.WorkSheet, controls: ExportControl[]) {
    const header = findHeader(worksheet);
    if (!header) return;

    const rowByTestId = buildRowByTestId(worksheet, header);
    let appendRow = Math.max(header.range.e.r + 1, header.headerRow + 1);

    for (const control of controls) {
        let row = rowByTestId.get(control.testId);
        const isNewRow = row === undefined;

        if (isNewRow) {
            row = appendRow++;
            const sourceRow = Math.max(header.headerRow + 1, row - 1);
            copyRowFormatting(worksheet, sourceRow, row, header.range);
            rowByTestId.set(control.testId, row);
        }
        if (row === undefined) continue;

        for (const [field, col] of header.columns) {
            setCellValue(worksheet, row, col, getControlValue(control, field));
        }

        if (control.updateHighlight) {
            const notesCol = header.columns.get("notesEvidence");
            if (notesCol !== undefined && !control.notesEvidence) {
                setCellValue(worksheet, row, notesCol, "Updated by SkyShield SCSEM Updater");
            }
        }
    }

    if (appendRow - 1 > header.range.e.r) {
        header.range.e.r = appendRow - 1;
        worksheet["!ref"] = XLSX.utils.encode_range(header.range);
    }
}

function addSkyShieldChangeLog(workbook: XLSX.WorkBook, changeLogs: ChangeLogEntry[]) {
    if (changeLogs.length === 0) return;

    const sheetName = "SkyShield Change Log";
    const rows: any[][] = [
        ["Version", "Date", "Description", "Author", "Source"],
        ...changeLogs.map((entry) => [
            entry.version,
            entry.changeDate.toISOString().split("T")[0],
            entry.description,
            entry.changedBy || "",
            entry.source,
        ]),
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet["!cols"] = [
        { wch: 18 },
        { wch: 14 },
        { wch: 90 },
        { wch: 30 },
        { wch: 18 },
    ];

    workbook.Sheets[sheetName] = worksheet;
    if (!workbook.SheetNames.includes(sheetName)) {
        workbook.SheetNames.push(sheetName);
    }
}

function buildReconstructedWorkbook(sheets: ExportSheet[], changeLogs: ChangeLogEntry[]): XLSX.WorkBook {
    const workbook = XLSX.utils.book_new();

    for (const sheet of sheets) {
        let worksheet: XLSX.WorkSheet;

        if (sheet.sheetType === "test_cases" && sheet.controls.length > 0) {
            const headers = [
                "Test ID",
                "NIST ID",
                "NIST Control Name",
                "Test Method",
                "Section Title",
                "Description",
                "Test Procedures",
                "Expected Results",
                "Actual Results",
                "Status",
                "Finding Statement",
                "Notes/Evidence",
                "Criticality",
                "Issue Code",
                "Issue Code Description",
                "CIS Benchmark Section",
                "Recommendation #",
                "Rationale",
                "Impact",
                "Remediation Procedure",
                "Remediation Statement",
                "CAP Request Statement",
                "Risk Rating",
            ];

            const rows = [
                ["Test Cases"],
                headers,
                ...sheet.controls.map((control) => [
                    control.testId,
                    control.nistId || "",
                    control.nistControlName || "",
                    control.testMethod || "",
                    control.sectionTitle || "",
                    control.description || "",
                    control.testProcedures || "",
                    control.expectedResults || "",
                    control.actualResults || "",
                    control.status || "",
                    control.findingStatement || "",
                    control.notesEvidence || "",
                    control.criticality || "",
                    control.issueCode || "",
                    control.issueCodeDescription || "",
                    control.cisBenchmarkRef || "",
                    control.recommendationNum || "",
                    control.rationale || "",
                    control.impact || "",
                    control.remediationProcedure || "",
                    control.remediationStatement || "",
                    control.capRequestStatement || "",
                    control.riskRating || "",
                ]),
            ];

            worksheet = XLSX.utils.aoa_to_sheet(rows);
            worksheet["!cols"] = headers.map((header) => ({
                wch: Math.min(Math.max(header.length + 4, 14), 55),
            }));
        } else if (sheet.rawData) {
            worksheet = XLSX.utils.aoa_to_sheet(sheet.rawData as any[][]);
        } else {
            worksheet = XLSX.utils.aoa_to_sheet([[sheet.sheetName]]);
        }

        XLSX.utils.book_append_sheet(workbook, worksheet, sheet.sheetName);
    }

    addSkyShieldChangeLog(workbook, changeLogs);
    return workbook;
}

function buildWorkbookFromOriginal(sourcePath: string, sheets: ExportSheet[], changeLogs: ChangeLogEntry[]): XLSX.WorkBook | null {
    if (!fs.existsSync(sourcePath)) return null;

    const workbook = XLSX.readFile(sourcePath, {
        cellDates: true,
        cellStyles: true,
        sheetStubs: true,
    });

    for (const sheet of sheets) {
        if (sheet.sheetType !== "test_cases" || sheet.controls.length === 0) continue;

        let worksheet = workbook.Sheets[sheet.sheetName];
        if (!worksheet) {
            worksheet = XLSX.utils.aoa_to_sheet((sheet.rawData || [[sheet.sheetName]]) as any[][]);
            workbook.Sheets[sheet.sheetName] = worksheet;
            if (!workbook.SheetNames.includes(sheet.sheetName)) {
                workbook.SheetNames.push(sheet.sheetName);
            }
        }

        patchTestCaseSheet(worksheet, sheet.controls);
    }

    addSkyShieldChangeLog(workbook, changeLogs);
    return workbook;
}

function cloneParsedSheets(parsed: ParsedSCSEM): ExportSheet[] {
    return parsed.sheets.map((sheet) => ({
        ...sheet,
        controls: sheet.controls.map((control) => ({ ...control })),
        changeLogEntries: [...sheet.changeLogEntries],
    }));
}

function generateNextTestId(existingTestIds: string[], fallbackPrefix: string): string {
    let selectedPrefix = `${fallbackPrefix}-`;
    let selectedWidth = 3;
    let maxNumber = 0;
    const prefixCounts = new Map<string, number>();

    for (const testId of existingTestIds) {
        const match = testId.match(/^(.*?)(\d+)$/);
        if (!match) continue;
        const prefix = match[1];
        prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    }

    const mostCommonPrefix = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (mostCommonPrefix) selectedPrefix = mostCommonPrefix;

    for (const testId of existingTestIds) {
        const match = testId.match(/^(.*?)(\d+)$/);
        if (!match || match[1] !== selectedPrefix) continue;
        selectedWidth = Math.max(selectedWidth, match[2].length);
        maxNumber = Math.max(maxNumber, Number.parseInt(match[2], 10));
    }

    return `${selectedPrefix}${String(maxNumber + 1).padStart(selectedWidth, "0")}`;
}

function fallbackPrefix(session: SCSEMUpdaterSession): string {
    return (session.inferredTechnology || session.originalFileName || "SCSEM")
        .replace(/[^A-Z0-9]+/gi, "")
        .slice(0, 10)
        .toUpperCase() || "SCSEM";
}

function appendEvidenceNote(existing: string | null, change: SCSEMUpdaterChange): string {
    const source = [
        change.sourceEvidence?.cisRecommendation ? `CIS ${change.sourceEvidence.cisRecommendation}` : null,
        change.sourceEvidence?.stigRecommendation ? `STIG ${change.sourceEvidence.stigRecommendation}` : null,
        change.sourceEvidence?.pub1075Version ? String(change.sourceEvidence.pub1075Version) : null,
    ].filter(Boolean).join("; ");
    const note = `SkyShield SCSEM Updater: ${change.reason}${source ? ` (${source})` : ""}`;
    return existing ? `${existing}\n${note}` : note;
}

function applyApprovedChanges(parsed: ParsedSCSEM, session: SCSEMUpdaterSession): {
    sheets: ExportSheet[];
    applied: string[];
} {
    const sheets = cloneParsedSheets(parsed);
    const controls = sheets.flatMap((sheet) => sheet.controls);
    const byTestId = new Map(controls.map((control) => [control.testId, control]));
    const approvedChanges = session.changes.filter((change) => change.status === "APPROVED");
    const applied: string[] = [];

    const primarySheet = sheets.find((sheet) => sheet.sheetType === "test_cases" && sheet.controls.length > 0) ||
        sheets.find((sheet) => sheet.sheetType === "test_cases");
    const existingTestIds = controls.map((control) => control.testId);

    for (const change of approvedChanges) {
        if (change.action === "addControl") {
            if (!primarySheet || !change.newControl) continue;

            const newTestId = generateNextTestId(existingTestIds, fallbackPrefix(session));
            existingTestIds.push(newTestId);
            const maxRowIndex = primarySheet.controls.reduce((max, control) => Math.max(max, control.rowIndex), 0);
            const newControl: ExportControl = {
                rowIndex: maxRowIndex + 1,
                testId: newTestId,
                nistId: change.newControl.nistId || null,
                nistControlName: change.newControl.nistControlName || null,
                testMethod: change.newControl.testMethod || "Manual",
                sectionTitle: change.newControl.sectionTitle || change.proposedValue || null,
                description: change.newControl.description || null,
                testProcedures: change.newControl.testProcedures || null,
                expectedResults: change.newControl.expectedResults || null,
                actualResults: null,
                status: null,
                findingStatement: null,
                notesEvidence: appendEvidenceNote(null, change),
                criticality: change.newControl.criticality || "Moderate",
                issueCode: null,
                issueCodeDescription: null,
                cisBenchmarkRef: change.newControl.cisBenchmarkRef || null,
                recommendationNum: change.newControl.recommendationNum || null,
                rationale: change.newControl.rationale || null,
                impact: change.newControl.impact || null,
                remediationProcedure: change.newControl.remediationProcedure || null,
                remediationStatement: null,
                capRequestStatement: null,
                riskRating: null,
                extraColumns: {
                    source: "scsem_updater",
                    originalSuggestedTestId: change.testId,
                    reason: change.reason,
                    confidence: change.confidence || null,
                    sourceEvidence: change.sourceEvidence || null,
                },
                updateHighlight: true,
            };
            primarySheet.controls.push(newControl);
            applied.push(`Added ${newTestId} from ${change.testId}`);
            continue;
        }

        if (!ALLOWED_UPDATE_FIELDS.has(change.field)) continue;
        const control = byTestId.get(change.testId);
        if (!control) continue;

        (control as unknown as Record<string, unknown>)[change.field] = change.proposedValue;
        control.notesEvidence = appendEvidenceNote(control.notesEvidence, change);
        control.updateHighlight = true;
        applied.push(`Updated ${change.testId} ${change.field}`);
    }

    return { sheets, applied };
}

export function buildSCSEMUpdaterWorkbookBuffer(
    session: SCSEMUpdaterSession,
    parsed: ParsedSCSEM,
    originalAbsolutePath: string
): Buffer {
    const { sheets, applied } = applyApprovedChanges(parsed, session);
    const changeLogs: ChangeLogEntry[] = applied.length > 0
        ? [{
            version: `SCSEM Updater ${new Date().toISOString().slice(0, 10)}`,
            changeDate: new Date(),
            description: `${applied.length} approved SkyShield SCSEM Updater change(s) applied after CIS, STIG, and Pub 1075 review. ${applied.slice(0, 12).join("; ")}`,
            changedBy: "SkyShield SCSEM Updater",
            source: "scsem_updater",
        }]
        : [];

    const workbook = buildWorkbookFromOriginal(originalAbsolutePath, sheets, changeLogs) ||
        buildReconstructedWorkbook(sheets, changeLogs);

    return XLSX.write(workbook, {
        type: "buffer",
        bookType: "xlsx",
        cellStyles: true,
    });
}

export function updatedSCSEMFileName(originalFileName: string): string {
    const extension = path.extname(originalFileName) || ".xlsx";
    const base = path.basename(originalFileName, extension)
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "Safeguards-SCSEM";
    return `${base}-updated.xlsx`;
}
