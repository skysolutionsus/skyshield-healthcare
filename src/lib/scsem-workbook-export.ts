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
    details?: Array<{
        target: string;
        description: string;
    }>;
};

type XlsxPopulateWorkbook = any;
type XlsxPopulateSheet = any;
type LogField = "version" | "date" | "description" | "author" | "source" | "target";

type TemplateWorkbookExport = {
    filePath: string;
    sheets: Array<{
        sheetName: string;
        sheetType: string;
        sheetIndex: number;
        rawData?: unknown;
        controls: Array<Record<string, any> & {
            testId: string;
            rowIndex: number;
            updateHighlight?: boolean;
        }>;
    }>;
    changeLogs?: Array<{
        version: string;
        changeDate: Date | string;
        description: string;
        changedBy?: string | null;
        source: string;
    }>;
};

const HEADER_PATTERNS: Array<[ExportField, RegExp[]]> = [
    ["testId", [/^test id\b/i]],
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

const LOG_HEADER_PATTERNS: Array<[LogField, RegExp[]]> = [
    ["version", [/version/i, /release/i]],
    ["date", [/date/i]],
    ["description", [/description/i, /change/i, /summary/i, /revision/i]],
    ["author", [/author/i, /changed by/i, /^by$/i]],
    ["source", [/source/i]],
    ["target", [/test case/i, /control/i, /\btab\b/i]],
];

async function loadXlsxPopulate(): Promise<any> {
    const mod = await import("xlsx-populate");
    return (mod as any).default || mod;
}

function workbookExtension(fileName: string): ".xlsx" | ".xlsm" {
    return path.extname(fileName).toLowerCase() === ".xlsm" ? ".xlsm" : ".xlsx";
}

function hasVbaProject(buffer: Buffer): boolean {
    return buffer.includes(Buffer.from("xl/vbaProject.bin"));
}

function assertVbaPreserved(input: Buffer, output: Buffer) {
    if (hasVbaProject(input) && !hasVbaProject(output)) {
        throw new Error("Macro-enabled workbook export lost the VBA project.");
    }
}

function forceWorkbookRecalculation(workbook: XlsxPopulateWorkbook) {
    const workbookNode = workbook?._node;
    const children = workbookNode?.children;
    if (!Array.isArray(children)) return;

    let calcPr = children.find((child: any) => child?.name === "calcPr");
    if (!calcPr) {
        calcPr = { name: "calcPr", attributes: {}, children: [] };
        children.push(calcPr);
    }

    calcPr.attributes = {
        ...(calcPr.attributes || {}),
        calcMode: "auto",
        fullCalcOnLoad: "1",
        forceFullCalc: "1",
    };
}

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

function matchLogHeader(header: string): LogField | null {
    const normalized = normalizeHeader(header);
    for (const [field, patterns] of LOG_HEADER_PATTERNS) {
        if (patterns.some((pattern) => pattern.test(normalized))) return field;
    }
    return null;
}

function isExportField(value: string): value is ExportField {
    return HEADER_PATTERNS.some(([field]) => field === value);
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

    const maxRow = Math.min(header.range.e.r, header.headerRow + 10000);
    for (let row = header.headerRow + 1; row <= maxRow; row++) {
        const testId = cellText(worksheet, row, header.testIdCol);
        if (testId) rows.set(testId, row);
    }

    return rows;
}

function rowHidden(worksheet: XLSX.WorkSheet, row: number): boolean {
    return Boolean(worksheet["!rows"]?.[row]?.hidden);
}

function rowHasValue(
    worksheet: XLSX.WorkSheet,
    row: number,
    startCol: number,
    endCol: number
): boolean {
    for (let col = startCol; col <= endCol; col++) {
        if (cellText(worksheet, row, col)) return true;
    }
    return false;
}

function lastNonEmptyRow(
    worksheet: XLSX.WorkSheet,
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number
): number {
    for (let row = endRow; row >= startRow; row--) {
        if (rowHasValue(worksheet, row, startCol, endCol)) return row;
    }
    return startRow - 1;
}

function lastVisibleDataRow(
    worksheet: XLSX.WorkSheet,
    rowByTestId: Map<string, number>
): number | null {
    const rows = [...rowByTestId.values()].sort((a, b) => b - a);
    return rows.find((row) => !rowHidden(worksheet, row)) ?? rows[0] ?? null;
}

function autoFilterNodes(sheet: XlsxPopulateSheet): any[] {
    const children = sheet?._node?.children;
    if (!Array.isArray(children)) return [];
    return children.filter((child: any) => child?.name === "autoFilter");
}

function currentAutoFilterRef(sheet: XlsxPopulateSheet): string | null {
    return autoFilterNodes(sheet)[0]?.attributes?.ref || null;
}

function setExistingAutoFilterRef(sheet: XlsxPopulateSheet, ref: string) {
    const children = sheet?._node?.children;
    if (!Array.isArray(children)) return;

    const filters = autoFilterNodes(sheet);
    const [filter, ...duplicates] = filters;
    if (!filter) return;

    filter.attributes = {
        ...(filter.attributes || {}),
        ref,
    };

    for (const duplicate of duplicates) {
        const index = children.indexOf(duplicate);
        if (index >= 0) children.splice(index, 1);
    }
}

function extendPopulateAutoFilter(
    sheet: XlsxPopulateSheet,
    readWorksheet: XLSX.WorkSheet,
    throughRow: number
) {
    const ref = (readWorksheet as any)["!autofilter"]?.ref;
    if (!ref) return;

    const range = XLSX.utils.decode_range(ref);
    if (throughRow <= range.e.r) return;

    range.e.r = throughRow;
    setExistingAutoFilterRef(sheet, XLSX.utils.encode_range(range));
}

function quoteSheetName(sheetName: string): string {
    return `'${sheetName.replace(/'/g, "''")}'`;
}

function absoluteRangeRef(ref: string): string {
    const range = XLSX.utils.decode_range(ref);
    const start = `$${XLSX.utils.encode_col(range.s.c)}$${range.s.r + 1}`;
    const end = `$${XLSX.utils.encode_col(range.e.c)}$${range.e.r + 1}`;
    return `${start}:${end}`;
}

function syncWorkbookAutoFilterDefinedNames(
    workbook: XlsxPopulateWorkbook,
    readWorkbook: XLSX.WorkBook
) {
    const definedNames = workbook?._node?.children?.find((child: any) => child?.name === "definedNames");
    const children = definedNames?.children;
    if (!Array.isArray(children)) return;

    const filterRefsBySheetId = new Map<number, string>();
    for (const [index, sheetName] of readWorkbook.SheetNames.entries()) {
        const sheet = workbook.sheet(sheetName);
        const ref = sheet ? currentAutoFilterRef(sheet) : null;
        if (!ref) continue;
        setExistingAutoFilterRef(sheet, ref);
        filterRefsBySheetId.set(index, `${quoteSheetName(sheetName)}!${absoluteRangeRef(ref)}`);
    }

    const seenFilterSheets = new Set<number>();
    definedNames.children = children.filter((child: any) => {
        if (child?.name !== "definedName" || child?.attributes?.name !== "_xlnm._FilterDatabase") {
            return true;
        }

        const localSheetId = Number(child.attributes.localSheetId);
        if (!Number.isFinite(localSheetId)) return true;
        if (seenFilterSheets.has(localSheetId)) return false;

        const nextRef = filterRefsBySheetId.get(localSheetId);
        if (nextRef) child.children = [nextRef];
        seenFilterSheets.add(localSheetId);
        return true;
    });
}

function findLogHeader(worksheet: XLSX.WorkSheet): {
    headerRow: number;
    columns: Map<LogField, number>;
    range: XLSX.Range;
} | null {
    const ref = worksheet["!ref"];
    if (!ref) return null;

    const range = XLSX.utils.decode_range(ref);
    const maxHeaderRow = Math.min(range.e.r, range.s.r + 20);

    for (let row = range.s.r; row <= maxHeaderRow; row++) {
        const columns = new Map<LogField, number>();

        for (let col = range.s.c; col <= range.e.c; col++) {
            const header = cellText(worksheet, row, col);
            const field = matchLogHeader(header);
            if (!field || columns.has(field)) continue;
            columns.set(field, col);
        }

        if ((columns.has("description") || columns.has("date")) && columns.size >= 2) {
            return { headerRow: row, columns, range };
        }
    }

    return null;
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

function setPopulateCellValue(sheet: XlsxPopulateSheet, row: number, col: number, value: unknown) {
    const nextValue = value === undefined || value === null ? "" : value;
    sheet.cell(row + 1, col + 1).value(nextValue);
}

function excelDateSerial(date: Date): number {
    const utcDate = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const excelEpoch = Date.UTC(1899, 11, 30);
    return Math.floor((utcDate - excelEpoch) / 86_400_000);
}

function adjustFormulaRows(formula: string, fromRow: number, toRow: number): string {
    const fromExcelRow = fromRow + 1;
    const toExcelRow = toRow + 1;
    return formula.replace(
        new RegExp(`(\\$?[A-Z]{1,3}\\$?)${fromExcelRow}(?!\\d)`, "g"),
        `$1${toExcelRow}`
    );
}

function copyPopulateCellStyle(sourceCell: any, targetCell: any) {
    if (!sourceCell || !targetCell) return;

    if (sourceCell._style) {
        targetCell.style(sourceCell._style);
    } else if (sourceCell._styleId !== undefined && sourceCell._styleId !== null) {
        targetCell._styleId = sourceCell._styleId;
        targetCell._style = undefined;
    }

    if (sourceCell._remainingAttributes) {
        targetCell._remainingAttributes = { ...sourceCell._remainingAttributes };
    }
}

function copyPopulateRowFormatting(
    sheet: XlsxPopulateSheet,
    fromRow: number,
    toRow: number,
    startCol: number,
    endCol: number,
    options: { hidden?: boolean; copyFormulas?: boolean } = {}
) {
    const sourceRow = sheet.row(fromRow + 1);
    const targetRow = sheet.row(toRow + 1);
    const sourceAttributes = sourceRow?._node?.attributes;

    if (sourceAttributes && targetRow?._node) {
        targetRow._node.attributes = {
            ...sourceAttributes,
            r: toRow + 1,
        };
    }

    const sourceHeight = sourceRow.height();
    if (typeof sourceHeight === "number") targetRow.height(sourceHeight);
    targetRow.hidden(options.hidden ?? sourceRow.hidden());

    for (let col = startCol; col <= endCol; col++) {
        const sourceCell = sourceRow.cell(col + 1);
        const targetCell = targetRow.cell(col + 1);
        copyPopulateCellStyle(sourceCell, targetCell);

        if (options.copyFormulas) {
            const formula = sourceCell.formula?.();
            if (formula && formula !== "SHARED") {
                targetCell.formula(adjustFormulaRows(formula, fromRow, toRow));
            }
        }
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

function approvedFieldMap(session: SCSEMUpdaterSession): Map<string, Set<ExportField>> {
    const fieldsByTestId = new Map<string, Set<ExportField>>();

    for (const change of session.changes) {
        if (change.status !== "APPROVED" || change.action === "addControl") continue;
        if (!isExportField(change.field)) continue;

        const fields = fieldsByTestId.get(change.testId) || new Set<ExportField>();
        fields.add(change.field);
        fields.add("notesEvidence");
        fieldsByTestId.set(change.testId, fields);
    }

    return fieldsByTestId;
}

function patchTestCaseSheetPreserving(
    sheet: XlsxPopulateSheet,
    readWorksheet: XLSX.WorkSheet,
    controls: ExportControl[],
    fieldsByTestId: Map<string, Set<ExportField>>
) {
    const header = findHeader(readWorksheet);
    if (!header) return;

    const rowByTestId = buildRowByTestId(readWorksheet, header);
    const initialSourceRow = lastVisibleDataRow(readWorksheet, rowByTestId);
    let appendRow = initialSourceRow === null
        ? Math.max(header.headerRow + 1, header.range.s.r)
        : initialSourceRow + 1;
    let sourceRowForNewControls = initialSourceRow;

    for (const control of controls) {
        let row = rowByTestId.get(control.testId);
        const isNewRow = row === undefined && control.updateHighlight;
        const fieldsToWrite = fieldsByTestId.get(control.testId);

        if (!isNewRow && (!fieldsToWrite || fieldsToWrite.size === 0)) continue;

        if (isNewRow) {
            row = appendRow++;
            const sourceRow = sourceRowForNewControls ?? Math.max(header.headerRow + 1, row - 1);
            copyPopulateRowFormatting(sheet, sourceRow, row, header.range.s.c, header.range.e.c, {
                hidden: false,
                copyFormulas: true,
            });
            rowByTestId.set(control.testId, row);
            sourceRowForNewControls = row;
        }
        if (row === undefined) continue;

        const writableFields = isNewRow
            ? [...header.columns.keys()]
            : [...(fieldsToWrite || [])];

        for (const field of writableFields) {
            const col = header.columns.get(field);
            if (col === undefined) continue;
            setPopulateCellValue(sheet, row, col, getControlValue(control, field));
        }
    }

    extendPopulateAutoFilter(sheet, readWorksheet, appendRow - 1);
}

function logSheetNames(workbook: XLSX.WorkBook): string[] {
    const names = new Set<string>();

    for (const sheetName of workbook.SheetNames) {
        const normalized = normalizeHeader(sheetName);
        if (/\bchange\s*log\b/.test(normalized)) names.add(sheetName);
        if (normalized.includes("new release") && normalized.includes("change")) names.add(sheetName);
    }

    return [...names];
}

function appendLogRowsPreserving(
    sheet: XlsxPopulateSheet,
    readWorksheet: XLSX.WorkSheet,
    entries: ChangeLogEntry[]
) {
    if (entries.length === 0) return;

    const header = findLogHeader(readWorksheet);
    const range = readWorksheet["!ref"]
        ? XLSX.utils.decode_range(readWorksheet["!ref"])
        : XLSX.utils.decode_range("A1:E1");
    const columns = header?.columns || new Map([
        ["version", 0],
        ["date", 1],
        ["description", 2],
        ["author", 3],
        ["source", 4],
    ] as Array<[LogField, number]>);
    const endCol = Math.max(range.e.c, ...columns.values());
    const firstDataRow = header ? header.headerRow + 1 : range.s.r;
    const lastDataRow = lastNonEmptyRow(readWorksheet, firstDataRow, range.e.r, range.s.c, endCol);
    let appendRow = Math.max(lastDataRow + 1, firstDataRow);

    for (const entry of entries) {
        const details = columns.has("target") && entry.details?.length
            ? entry.details
            : [{ target: "Approved SCSEM updater changes", description: entry.description }];

        for (const detail of details) {
            const sourceRow = Math.max(lastDataRow, header ? header.headerRow + 1 : range.s.r);
            copyPopulateRowFormatting(sheet, sourceRow, appendRow, range.s.c, endCol, { hidden: false });

            const values = {
                version: entry.version,
                date: excelDateSerial(entry.changeDate),
                description: detail.description,
                author: entry.changedBy || "",
                source: entry.source,
                target: detail.target,
            };

            for (const [field, value] of Object.entries(values) as Array<[keyof typeof values, string | Date]>) {
                const col = columns.get(field);
                if (col === undefined) continue;
                setPopulateCellValue(sheet, appendRow, col, value);
            }

            appendRow++;
        }
    }

    if ((readWorksheet as any)["!autofilter"]?.ref) {
        extendPopulateAutoFilter(sheet, readWorksheet, appendRow - 1);
    }
}

function appendWorkbookLogSheetsPreserving(
    workbook: XlsxPopulateWorkbook,
    readWorkbook: XLSX.WorkBook,
    changeLogs: ChangeLogEntry[]
) {
    if (changeLogs.length === 0) return;

    for (const sheetName of logSheetNames(readWorkbook)) {
        const sheet = workbook.sheet(sheetName);
        const readWorksheet = readWorkbook.Sheets[sheetName];
        if (!sheet || !readWorksheet) continue;
        appendLogRowsPreserving(sheet, readWorksheet, changeLogs);
    }
}

function toExportControl(control: TemplateWorkbookExport["sheets"][number]["controls"][number]): ExportControl {
    return {
        rowIndex: control.rowIndex,
        testId: control.testId,
        nistId: control.nistId || null,
        nistControlName: control.nistControlName || null,
        testMethod: control.testMethod || null,
        sectionTitle: control.sectionTitle || null,
        description: control.description || null,
        testProcedures: control.testProcedures || null,
        expectedResults: control.expectedResults || null,
        actualResults: control.actualResults || null,
        status: control.status || null,
        findingStatement: control.findingStatement || null,
        notesEvidence: control.notesEvidence || (control.updateHighlight ? "Updated by SkyShield review" : null),
        criticality: control.criticality || null,
        issueCode: control.issueCode || null,
        issueCodeDescription: control.issueCodeDescription || null,
        cisBenchmarkRef: control.cisBenchmarkRef || null,
        recommendationNum: control.recommendationNum || null,
        rationale: control.rationale || null,
        impact: control.impact || null,
        remediationProcedure: control.remediationProcedure || null,
        remediationStatement: control.remediationStatement || null,
        capRequestStatement: control.capRequestStatement || null,
        riskRating: control.riskRating || null,
        extraColumns: (control.extraColumns as Record<string, unknown> | null | undefined) || null,
        updateHighlight: Boolean(control.updateHighlight),
    };
}

function toExportSheets(template: TemplateWorkbookExport): ExportSheet[] {
    return template.sheets.map((sheet) => ({
        sheetName: sheet.sheetName,
        sheetType: sheet.sheetType as ExportSheet["sheetType"],
        sheetIndex: sheet.sheetIndex,
        rawData: (sheet.rawData as any[][] | null | undefined) || null,
        controls: sheet.controls.map(toExportControl),
        changeLogEntries: [],
    }));
}

function toChangeLogEntries(template: TemplateWorkbookExport): ChangeLogEntry[] {
    return (template.changeLogs || [])
        .filter((entry) => entry.source !== "xlsx_import")
        .map((entry) => {
            const changeDate = entry.changeDate instanceof Date
                ? entry.changeDate
                : new Date(entry.changeDate);

            return {
                version: entry.version || "SkyShield Update",
                changeDate: Number.isNaN(changeDate.getTime()) ? new Date() : changeDate,
                description: entry.description || "SkyShield SCSEM update",
                changedBy: entry.changedBy || null,
                source: entry.source || "skyshield",
            };
        });
}

function allWritableFieldsByTestId(controls: ExportControl[]): Map<string, Set<ExportField>> {
    const fields = new Set<ExportField>(HEADER_PATTERNS.map(([field]) => field));
    const fieldsByTestId = new Map<string, Set<ExportField>>();

    for (const control of controls) {
        if (!control.updateHighlight) continue;
        fieldsByTestId.set(control.testId, fields);
    }

    return fieldsByTestId;
}

async function buildTemplateWorkbookFromOriginalPreserving(
    sourcePath: string,
    sheets: ExportSheet[],
    changeLogs: ChangeLogEntry[]
): Promise<Buffer | null> {
    if (!fs.existsSync(sourcePath)) return null;

    const originalBuffer = fs.readFileSync(sourcePath);
    const changedControls = sheets.flatMap((sheet) => sheet.controls).filter((control) => control.updateHighlight);
    if (changedControls.length === 0 && changeLogs.length === 0) return originalBuffer;

    const XlsxPopulate = await loadXlsxPopulate();
    const workbook = await XlsxPopulate.fromDataAsync(originalBuffer);
    const readWorkbook = XLSX.readFile(sourcePath, {
        cellDates: true,
        cellStyles: true,
        sheetStubs: true,
    });

    for (const sheet of sheets) {
        if (sheet.sheetType !== "test_cases" || sheet.controls.length === 0) continue;

        const populateSheet = workbook.sheet(sheet.sheetName);
        const readWorksheet = readWorkbook.Sheets[sheet.sheetName];
        if (!populateSheet || !readWorksheet) continue;

        patchTestCaseSheetPreserving(
            populateSheet,
            readWorksheet,
            sheet.controls,
            allWritableFieldsByTestId(sheet.controls)
        );
    }

    appendWorkbookLogSheetsPreserving(workbook, readWorkbook, changeLogs);
    syncWorkbookAutoFilterDefinedNames(workbook, readWorkbook);
    forceWorkbookRecalculation(workbook);

    const output = await workbook.outputAsync({ type: "nodebuffer" });
    const outputBuffer = Buffer.isBuffer(output) ? output : Buffer.from(output);
    assertVbaPreserved(originalBuffer, outputBuffer);
    return outputBuffer;
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

async function buildWorkbookFromOriginalPreserving(
    sourcePath: string,
    sheets: ExportSheet[],
    changeLogs: ChangeLogEntry[],
    session: SCSEMUpdaterSession
): Promise<Buffer | null> {
    if (!fs.existsSync(sourcePath)) return null;

    const XlsxPopulate = await loadXlsxPopulate();
    const originalBuffer = fs.readFileSync(sourcePath);
    const workbook = await XlsxPopulate.fromDataAsync(originalBuffer);
    const readWorkbook = XLSX.readFile(sourcePath, {
        cellDates: true,
        cellStyles: true,
        sheetStubs: true,
    });
    const fieldsByTestId = approvedFieldMap(session);

    for (const sheet of sheets) {
        if (sheet.sheetType !== "test_cases" || sheet.controls.length === 0) continue;

        const populateSheet = workbook.sheet(sheet.sheetName);
        const readWorksheet = readWorkbook.Sheets[sheet.sheetName];
        if (!populateSheet || !readWorksheet) continue;

        patchTestCaseSheetPreserving(populateSheet, readWorksheet, sheet.controls, fieldsByTestId);
    }

    appendWorkbookLogSheetsPreserving(workbook, readWorkbook, changeLogs);
    syncWorkbookAutoFilterDefinedNames(workbook, readWorkbook);
    forceWorkbookRecalculation(workbook);

    const output = await workbook.outputAsync({ type: "nodebuffer" });
    const outputBuffer = Buffer.isBuffer(output) ? output : Buffer.from(output);
    assertVbaPreserved(originalBuffer, outputBuffer);
    return outputBuffer;
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

function changeLogDetail(applied: string): { target: string; description: string } {
    const updated = applied.match(/^Updated\s+(.+?)\s+(.+)$/);
    if (updated) {
        return {
            target: updated[1],
            description: `Updated ${updated[2]} by SkyShield SCSEM Updater.`,
        };
    }

    const added = applied.match(/^Added\s+(.+?)(?:\s+from\s+(.+))?$/);
    if (added) {
        return {
            target: added[1],
            description: "Added control by SkyShield SCSEM Updater.",
        };
    }

    return {
        target: "Approved SCSEM updater changes",
        description: applied,
    };
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

export async function buildSCSEMTemplateWorkbookBuffer(template: TemplateWorkbookExport): Promise<Buffer> {
    const sourcePath = path.isAbsolute(template.filePath)
        ? template.filePath
        : path.join(process.cwd(), template.filePath);
    const sheets = toExportSheets(template);
    const changeLogs = toChangeLogEntries(template);

    const preservedWorkbook = await buildTemplateWorkbookFromOriginalPreserving(
        sourcePath,
        sheets,
        changeLogs
    );
    if (preservedWorkbook) return preservedWorkbook;

    const workbook = buildReconstructedWorkbook(sheets, changeLogs);
    return XLSX.write(workbook, {
        type: "buffer",
        bookType: "xlsx",
        cellStyles: true,
    });
}

export async function buildSCSEMUpdaterWorkbookBuffer(
    session: SCSEMUpdaterSession,
    parsed: ParsedSCSEM,
    originalAbsolutePath: string
): Promise<Buffer> {
    const { sheets, applied } = applyApprovedChanges(parsed, session);
    const changeLogs: ChangeLogEntry[] = applied.length > 0
        ? [{
            version: `SCSEM Updater ${new Date().toISOString().slice(0, 10)}`,
            changeDate: new Date(),
            description: `${applied.length} approved SkyShield SCSEM Updater change(s) applied after CIS, STIG, and Pub 1075 review. ${applied.slice(0, 12).join("; ")}`,
            changedBy: "SkyShield SCSEM Updater",
            source: "scsem_updater",
            details: applied.map(changeLogDetail),
        }]
        : [];

    const preservedWorkbook = await buildWorkbookFromOriginalPreserving(
        originalAbsolutePath,
        sheets,
        changeLogs,
        session
    );
    if (preservedWorkbook) return preservedWorkbook;

    const workbook = buildWorkbookFromOriginal(originalAbsolutePath, sheets, changeLogs) ||
        buildReconstructedWorkbook(sheets, changeLogs);

    return XLSX.write(workbook, {
        type: "buffer",
        bookType: "xlsx",
        cellStyles: true,
    });
}

export function updatedSCSEMFileName(originalFileName: string): string {
    const originalExtension = path.extname(originalFileName);
    const extension = workbookExtension(originalFileName);
    const base = path.basename(originalFileName, originalExtension || extension)
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "Safeguards-SCSEM";
    return `${base}-updated${extension}`;
}

export function excelContentTypeForFileName(fileName: string): string {
    return workbookExtension(fileName) === ".xlsm"
        ? "application/vnd.ms-excel.sheet.macroEnabled.12"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}
