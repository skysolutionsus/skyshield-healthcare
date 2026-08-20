import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { ParsedControl, ParsedSCSEM, ParsedSheet } from "@/lib/xlsx-parser";
import type { SCSEMUpdaterChange, SCSEMUpdaterSession } from "@/lib/scsem-updater-store";
import { ALLOWED_UPDATE_FIELDS } from "@/lib/scsem-update-engine";
import { approvedProposalValidationErrors } from "@/lib/scsem-proposal-validation";
import { resolveSCSEMIssueCodeSelectionFromWorkbook } from "@/lib/scsem-issue-codes";
import { boundedStoredSCSEMBenchmarkNarrative } from "@/lib/scsem-benchmark-failure";
import {
    extendAppendedSCSEMFormulaRanges,
    hasExactSCSEMSheetQualifier,
    translateCopiedSCSEMFormula,
    translateInsertedSCSEMFormula,
} from "@/lib/scsem-formula-translation";
import {
    SCSEM_COLUMN_HEADER_PATTERNS,
    isSCSEMColumnField,
    matchSCSEMColumnHeader,
    normalizeSCSEMColumnHeader,
    scsemColumnHeaderSignature,
    scsemWorkbookSheetNamesSignature,
    type SCSEMColumnField,
    type SCSEMColumnMatchContext,
} from "@/lib/scsem-column-schema";

XLSX.set_fs(fs);

type ExportField = SCSEMColumnField;

type ExportControl = ParsedControl & {
    updateHighlight?: boolean;
};

type ExportSheet = Omit<ParsedSheet, "controls"> & {
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

type ResolvedUpdate = {
    change: SCSEMUpdaterChange;
    sheetName: string;
    row: number;
    col: number;
    address: string;
};

type ResolvedAddition = {
    change: SCSEMUpdaterChange;
    sheetName: string;
    row: number;
    newTestId: string;
    cells: Map<string, string>;
    writtenFields: Map<ExportField, string>;
    omittedFields: ExportField[];
    assessmentCells: string[];
    issueCodeAddress: string;
    riskRatingAddress: string;
    riskFormulaSourceRow: number;
    cloneSourceRow?: number;
    insertBeforeFooter?: boolean;
    footerCellAddress?: string;
    blankStructuralFooter?: boolean;
    allowedTargetMergeRefs?: string[];
    materializeRiskFormula?: boolean;
    allowHiddenStructuralFooter?: boolean;
    allowHiddenCloneSource?: boolean;
    materializeSparseRowFrom?: number;
    materializeSparseThroughColumn?: number;
    explicitRiskFormula?: {
        formula: string;
        formulaType?: "array";
        formulaRef?: string;
        styleId: string;
        calcChainSourceAddress?: string;
        calcChainSourceCount?: number;
    };
    stripFormulaCacheAddresses?: string[];
    formulaRepairs?: Array<{
        sheetName: string;
        address: string;
        formula: string;
    }>;
    doNotExtendFeatureSqrefs?: Array<{
        tag: "dataValidation" | "conditionalFormatting" | "protectedRange" | "ignoredError";
        sqref: string;
    }>;
};

type ApprovedChangePlan = {
    updates: ResolvedUpdate[];
    additions: ResolvedAddition[];
};

function exportDebug(message: string) {
    if (process.env.SCSEM_EXPORT_DEBUG === "1") console.error(`[scsem-export] ${message}`);
}

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

async function restoreReferencedCalculationChain(
    originalBuffer: Buffer,
    outputBuffer: Buffer
): Promise<Buffer> {
    const outputZip = await JSZip.loadAsync(outputBuffer);
    if (outputZip.file("xl/calcChain.xml")) return outputBuffer;

    const workbookRelationships = await outputZip
        .file("xl/_rels/workbook.xml.rels")
        ?.async("string");
    if (!workbookRelationships?.includes("relationships/calcChain")) return outputBuffer;

    const originalZip = await JSZip.loadAsync(originalBuffer);
    const originalCalculationChain = originalZip.file("xl/calcChain.xml");
    if (!originalCalculationChain) return outputBuffer;

    outputZip.file("xl/calcChain.xml", await originalCalculationChain.async("uint8array"));
    const repaired = await outputZip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return Buffer.isBuffer(repaired) ? repaired : Buffer.from(repaired);
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
    return normalizeSCSEMColumnHeader(value);
}

type WorkbookSchemaContext = Pick<
    SCSEMColumnMatchContext,
    "workbookSha256" | "sheetName" | "workbookSheetNamesSignature"
>;

function matchHeader(
    header: string,
    context?: SCSEMColumnMatchContext
): ExportField | null {
    return matchSCSEMColumnHeader(header, context);
}

function matchLogHeader(header: string): LogField | null {
    const normalized = normalizeHeader(header);
    for (const [field, patterns] of LOG_HEADER_PATTERNS) {
        if (patterns.some((pattern) => pattern.test(normalized))) return field;
    }
    return null;
}

function isExportField(value: string): value is ExportField {
    return isSCSEMColumnField(value);
}

function findHeader(worksheet: XLSX.WorkSheet, schemaContext?: WorkbookSchemaContext): {
    headerRow: number;
    testIdCol: number;
    columns: Map<ExportField, number>;
    duplicateFields: Set<ExportField>;
    range: XLSX.Range;
} | null {
    const ref = worksheet["!ref"];
    if (!ref) return null;

    const range = XLSX.utils.decode_range(ref);
    const maxHeaderRow = Math.min(range.e.r, range.s.r + 15);

    for (let row = range.s.r; row <= maxHeaderRow; row++) {
        let testIdCol = -1;
        const columns = new Map<ExportField, number>();
        const duplicateFields = new Set<ExportField>();
        const headerSignature = scsemColumnHeaderSignature(
            Array.from({ length: range.e.c + 1 }, (_, col) => cellText(worksheet, row, col))
        );

        for (let col = range.s.c; col <= range.e.c; col++) {
            const header = cellText(worksheet, row, col);
            const field = matchHeader(header, schemaContext ? {
                ...schemaContext,
                headerRow: row,
                columnIndex: col,
                headerSignature,
            } : undefined);
            if (!field) continue;
            if (columns.has(field)) {
                duplicateFields.add(field);
                continue;
            }
            columns.set(field, col);
            if (field === "testId") testIdCol = col;
        }

        if (testIdCol !== -1) {
            return { headerRow: row, testIdCol, columns, duplicateFields, range };
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

function lastPhysicalControlRow(rowByTestId: Map<string, number>): number | null {
    const rows = [...rowByTestId.values()];
    return rows.length > 0 ? Math.max(...rows) : null;
}

const CANONICAL_INSERTION_FOOTER =
    "input of test results starting with this row require corresponding test ids in column a. insert new rows above here.";
const VERIFIED_AMAZON_LINUX_FOOTER_SHA256 =
    "dfcb4946c5353b474bc35a6722a15fb308029faf748000bdcaceaa8e6463fcfa";
const VERIFIED_STRUCTURAL_FOOTER_PROFILES = new Map<string, {
    sheetName: string;
    row: number;
    cloneSourceRow?: number;
    riskFormulaSourceRow?: number;
    blankStructuralFooter?: boolean;
    allowedTargetMergeRefs?: string[];
    materializeRiskFormula?: boolean;
    allowHiddenStructuralFooter?: boolean;
    allowHiddenCloneSource?: boolean;
}>([
    [VERIFIED_AMAZON_LINUX_FOOTER_SHA256, { sheetName: "Amazon Linux 23 Test Cases", row: 180 }],
    ["9680954f5f16bdc6e192abcf7a30ced3489cbebcfe7837b0dda6b5bf4e0b026a", { sheetName: "ASA Test Cases", row: 116 }],
    ["299ea982bcba40cd0d17b993e3dd060ec3da27311bc1dc243e3f0f70f198a9a9", { sheetName: "Debian 9", row: 184 }],
    ["4a8171c90775bff42ba816fb5f6fd757474e46e51dfaca064e050ec49ca07a8a", { sheetName: "Test Cases", row: 270 }],
    ["6cecf61c875c3ca673ed50d38779b42bbf2635fa827c6d551ee5293ba3649aa4", { sheetName: "HP-UX 11i Test Cases", row: 54 }],
    ["71e7f2f298d9fcaabf9a0fc9ef76e00c22b7a82fb2c35972690e6ae4b19abae7", { sheetName: "OSX 12.0", row: 79 }],
    ["376a64a06bf0de5a5c46a6cd806ad624a6d041b3d8c35032fffb0869c3854a9b", { sheetName: "Network Test Cases", row: 53 }],
    ["53d361076d7f85fbdf669c9328d275e04919ff787a1575ba6900eccecdd27e65", { sheetName: "Network Test Cases", row: 53 }],
    ["49db7ceaa69c57ed6c647672dcb3a12639c520471b2fce791f5f87c7a47adc0e", { sheetName: "Solaris 10 Test Cases", row: 124 }],
    ["e868666306dafbc43ac681ef417c3d90528841d785535893fc93e2423dacc304", { sheetName: "Test Cases", row: 40 }],
    ["da689bdd8f3f04d36552062d36144e2350063f649bd1f0703f51762a16ebf333", { sheetName: "SUSE12 Test Cases", row: 181 }],
    ["c1f05b3c7999980edbc5e9e00a299620906ddc61e1506e39c97a8681a50ee9bd", { sheetName: "IOS 15.0M Test Cases", row: 51 }],
    ["01393f9735d24a27480837c5b97367208e0a7e59bb4b735f40330fb81ad1609e", { sheetName: "Test Cases", row: 31 }],
    ["412f6f515c582d28bdcb0d6412d9aa1ac3f206eee09b6c03a16ce27e18e6f261", { sheetName: "Remote Access VPN", row: 44 }],
    ["1ed7d8f0979adbfb3dc3af015aa230ecf4a3fd2e184da52ca6184ab3f2aa6f28", { sheetName: "Win11", row: 392 }],
    ["346793ee22e18b3b5ba26640a660c30d7d12a94432c26ee993397c07fc495772", { sheetName: "Test Cases", row: 275 }],
    ["1950a49eebca735a0f5800807f71836ca337daea055b1a634f4934d6b1153582", { sheetName: "Test Cases", row: 279 }],
    ["f13e1d3c6074fb66291a560997a6bf74e70727f007be0e5d698b2e795aac4b1f", { sheetName: "Test Cases", row: 320 }],
    ["e43942b8c598aec075f8d8aa937f31b26179118fa618c8a3e74c61c31cd2192a", { sheetName: "Test Cases Server 2019", row: 327 }],
    ["a139c9d0ce80a08f36cd18e188de54c2491f1a143ae34b15da65f9cd336b6a45", { sheetName: "Test Cases Server 2025", row: 349 }],
    ["da75cc24ecd038bdb59b971d18309348bc34eed7c7cd492e3ba1a4103b563daf", { sheetName: "Test Cases Server 2025", row: 349 }],
    ["dce856e0f534bbd9207f47c7510e927a90dc13348378f0575317a49e100dbfe3", {
        sheetName: "AIX7 Test Cases",
        row: 209,
        allowedTargetMergeRefs: ["B210:O210"],
    }],
    ["8c4ad7ed2445f76d4f78b0aa80ee6e071c51e514735e02baedfa347107c7a783", {
        sheetName: "Windows 10",
        row: 369,
        allowedTargetMergeRefs: ["B370:J370"],
    }],
    ["305e7157181c99ca12c2be3dc65b44ded6b823aa6bb580774a0e3c381c8183df", {
        sheetName: "Test Cases Server 2022",
        row: 331,
        riskFormulaSourceRow: 294,
        materializeRiskFormula: true,
    }],
    ["26c788823f7e196f1315314c438a980c84d1ec4635e23d7fc69f64b8eb7533d6", {
        sheetName: "Check Point Test Cases",
        row: 95,
        cloneSourceRow: 93,
        riskFormulaSourceRow: 93,
        blankStructuralFooter: true,
        allowedTargetMergeRefs: ["A96:AA96"],
    }],
    ["414fdf8e76d4c3bde67095bc6e7902df5aad3e8aa807825d3abbc29f09c95e5b", {
        sheetName: "PaloAlto10",
        row: 120,
        cloneSourceRow: 119,
        riskFormulaSourceRow: 50,
        materializeRiskFormula: true,
        allowHiddenStructuralFooter: true,
        allowHiddenCloneSource: true,
    }],
]);

type ExactAppendProfile = {
    sheetName: string;
    row: number;
    losslessDescriptionComposite?: boolean;
    materializeSparseRowFrom?: number;
    materializeSparseThroughColumn?: number;
    explicitRiskFormula?: ResolvedAddition["explicitRiskFormula"];
    stripFormulaCacheAddresses?: string[];
    formulaRepairs?: ResolvedAddition["formulaRepairs"];
    doNotExtendFeatureSqrefs?: ResolvedAddition["doNotExtendFeatureSqrefs"];
};

const EXACT_APPEND_PROFILES = new Map<string, ExactAppendProfile>([
    ["5a628c9286a98dfa527482f05d618abb1052510e11919d22f7c423afd4e3ec4b", {
        sheetName: "Test Cases",
        row: 68,
        materializeSparseRowFrom: 67,
        materializeSparseThroughColumn: 28,
        explicitRiskFormula: {
            formula: "IF(OR($J69=\"Fail\",ISBLANK($J69)),INDEX('Issue Code Table'!$C:$C,_xlfn.XMATCH($N69,'Issue Code Table'!A:A,0)),IF($M69=\"Critical\",6,IF($M69=\"Significant\",5,IF($M69=\"Moderate\",3,2))))",
            formulaType: "array",
            formulaRef: "AB69",
            styleId: "14",
            calcChainSourceAddress: "AB68",
            calcChainSourceCount: 2,
        },
        stripFormulaCacheAddresses: ["AD69"],
    }],
    ["0746d73ce6df6cf5935b43da471367ed24c43624c7a4f131d854be3ff15606e9", {
        sheetName: "Test Cases",
        row: 32,
        losslessDescriptionComposite: true,
    }],
    ["064f76de388b5d015e5d1d4d4fcea3f7beaf846d66afb9edc4bb9d2f45a42e3c", {
        sheetName: "Tumbleweed-Axway",
        row: 5,
        losslessDescriptionComposite: true,
        explicitRiskFormula: {
            formula: "IF(OR(H6=\"Fail\",ISBLANK(H6)),INDEX('Issue Code Table'!C:C,MATCH(K:K,'Issue Code Table'!A:A,0)),IF(J6=\"Critical\",6,IF(J6=\"Significant\",5,IF(J6=\"Moderate\",3,2))))",
            styleId: "55",
        },
        formulaRepairs: [
            ...[3, 4, 5].map((row) => ({
                sheetName: "Tumbleweed-Axway",
                address: `AA${row}`,
                formula: `IF(OR(H${row}=\"Fail\",ISBLANK(H${row})),INDEX('Issue Code Table'!C:C,MATCH(K:K,'Issue Code Table'!A:A,0)),IF(J${row}=\"Critical\",6,IF(J${row}=\"Significant\",5,IF(J${row}=\"Moderate\",3,2))))`,
            })),
            ...[3, 4].map((row) => ({
                sheetName: "Web Portal",
                address: `AA${row}`,
                formula: `IF(OR(H${row}=\"Fail\",ISBLANK(H${row})),INDEX('Issue Code Table'!C:C,MATCH(K:K,'Issue Code Table'!A:A,0)),IF(J${row}=\"Critical\",6,IF(J${row}=\"Significant\",5,IF(J${row}=\"Moderate\",3,2))))`,
            })),
            ...[3, 4].map((row) => ({
                sheetName: "IVR",
                address: `AA${row}`,
                formula: `IF(OR(H${row}=\"Fail\",ISBLANK(H${row})),INDEX('Issue Code Table'!C:C,MATCH(K:K,'Issue Code Table'!A:A,0)),IF(J${row}=\"Critical\",6,IF(J${row}=\"Significant\",5,IF(J${row}=\"Moderate\",3,2))))`,
            })),
        ],
    }],
    ["f451bae18a2372262ed7cc4471f57fa09aaa36545c6edb7dced7bfcaf65d771e", {
        sheetName: "MOT",
        row: 116,
        losslessDescriptionComposite: true,
    }],
    ["658d726e6fadb25ceb98f15602e8109a670040ea91d5014ffcd175a2393e8ea1", {
        sheetName: "Gen Firewall Test Cases",
        row: 57,
        explicitRiskFormula: {
            formula: "IF(OR(J58=\"Fail\",ISBLANK(J58)),INDEX('Issue Code Table'!C:C,MATCH(N:N,'Issue Code Table'!A:A,0)),IF(M58=\"Critical\",6,IF(M58=\"Significant\",5,IF(M58=\"Moderate\",3,2))))",
            styleId: "203",
        },
        formulaRepairs: [52, 53, 54, 55, 56, 57].map((row) => ({
            sheetName: "Gen Firewall Test Cases",
            address: `Y${row}`,
            formula: `IF(OR(J${row}=\"Fail\",ISBLANK(J${row})),INDEX('Issue Code Table'!C:C,MATCH(N:N,'Issue Code Table'!A:A,0)),IF(M${row}=\"Critical\",6,IF(M${row}=\"Significant\",5,IF(M${row}=\"Moderate\",3,2))))`,
        })),
    }],
    ["a38e9da08fb6a76c6a89b4f3e188b089543f71b633dcf06ba76e06a629c21fef", {
        sheetName: "MySQL 5.7",
        row: 54,
        explicitRiskFormula: {
            formula: "IF(OR(K55=\"Fail\",ISBLANK(K55)),INDEX('Issue Code Table'!C:C,MATCH(O:O,'Issue Code Table'!A:A,0)),IF(N55=\"Critical\",6,IF(N55=\"Significant\",5,IF(N55=\"Moderate\",3,2))))",
            styleId: "184",
        },
        doNotExtendFeatureSqrefs: [{ tag: "dataValidation", sqref: "K3:K54" }],
    }],
]);

function canonicalInsertionFooterCell(
    worksheet: XLSX.WorkSheet,
    row: number,
    range: XLSX.Range
): string | null {
    for (let col = range.s.c; col <= range.e.c; col++) {
        const value = cellText(worksheet, row, col).replace(/\s+/g, " ").trim().toLowerCase();
        if (value === CANONICAL_INSERTION_FOOTER) {
            return XLSX.utils.encode_cell({ r: row, c: col });
        }
    }
    return null;
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

    }

    if (appendRow - 1 > header.range.e.r) {
        header.range.e.r = appendRow - 1;
        worksheet["!ref"] = XLSX.utils.encode_range(header.range);
    }
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
    const initialSourceRow = lastPhysicalControlRow(rowByTestId);
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
        notesEvidence: control.notesEvidence || null,
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
    const fields = new Set<ExportField>(SCSEM_COLUMN_HEADER_PATTERNS.map(([field]) => field));
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
        sheetRows: 10_000,
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
    const repairedOutput = await restoreReferencedCalculationChain(originalBuffer, outputBuffer);
    assertVbaPreserved(originalBuffer, repairedOutput);
    return repairedOutput;
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
        sheetRows: 10_000,
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
    if (mostCommonPrefix !== undefined) {
        selectedPrefix = mostCommonPrefix;
        const widthCounts = new Map<number, number>();
        for (const testId of existingTestIds) {
            const match = testId.match(/^(.*?)(\d+)$/);
            if (!match || match[1] !== selectedPrefix || !/^0\d+/.test(match[2])) continue;
            widthCounts.set(match[2].length, (widthCounts.get(match[2].length) || 0) + 1);
        }
        selectedWidth = [...widthCounts.entries()]
            .sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]?.[0] || 1;
    }

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

function normalizedSheetKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function evidenceString(change: SCSEMUpdaterChange, key: string): string | null {
    const value = change.sourceEvidence?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function targetSheetForNewControl(
    sheets: ExportSheet[],
    change: SCSEMUpdaterChange
): ExportSheet | undefined {
    const testSheets = sheets.filter((sheet) => sheet.sheetType === "test_cases");
    const requestedNames = [
        change.targetSheet,
        evidenceString(change, "sourceSheet"),
    ].filter((value): value is string => Boolean(value));

    for (const requested of requestedNames) {
        const key = normalizedSheetKey(requested);
        const exact = testSheets.find((sheet) => normalizedSheetKey(sheet.sheetName) === key);
        if (exact) return exact;
    }

    return undefined;
}

function approvedChangeError(change: SCSEMUpdaterChange, reason: string): Error {
    return new Error(
        `Cannot export approved SCSEM change ${change.id} (${change.testId || "new control"}` +
        `${change.field ? ` ${change.field}` : ""}): ${reason}`
    );
}

function normalizedControlValue(value: unknown): string {
    if (value === undefined || value === null) return "";
    return String(value).trim();
}

function requestedTargetSheet(change: SCSEMUpdaterChange): string | null {
    return change.targetSheet?.trim() || evidenceString(change, "sourceSheet") || null;
}

function rowsForTestId(
    worksheet: XLSX.WorkSheet,
    header: NonNullable<ReturnType<typeof findHeader>>,
    testId: string
): number[] {
    const rows: number[] = [];
    const maxRow = Math.min(header.range.e.r, header.headerRow + 10000);
    for (let row = header.headerRow + 1; row <= maxRow; row++) {
        if (cellText(worksheet, row, header.testIdCol) === testId) rows.push(row);
    }
    return rows;
}

function newControlFieldValues(
    change: SCSEMUpdaterChange,
    newTestId: string,
    issueCode: { issueCode: string; issueCodeDescription: string }
): Map<ExportField, string> {
    const fields = new Map<ExportField, string>([["testId", newTestId]]);
    const values: Partial<Record<ExportField, unknown>> = {
        nistId: change.newControl?.nistId,
        nistControlName: change.newControl?.nistControlName,
        testMethod: change.newControl?.testMethod || "Manual",
        sectionTitle: change.newControl?.sectionTitle || change.proposedValue,
        description: change.newControl?.description,
        testProcedures: change.newControl?.testProcedures,
        expectedResults: change.newControl?.expectedResults,
        findingStatement: change.newControl?.findingStatement,
        criticality: change.newControl?.criticality || "Moderate",
        issueCode: issueCode.issueCode,
        issueCodeDescription: issueCode.issueCodeDescription,
        cisBenchmarkRef: change.newControl?.cisBenchmarkRef,
        recommendationNum: change.newControl?.recommendationNum,
        rationale: change.newControl?.rationale,
        impact: change.newControl?.impact,
        remediationProcedure: change.newControl?.remediationProcedure,
    };

    for (const [field, value] of Object.entries(values) as Array<[ExportField, unknown]>) {
        const normalized = normalizedControlValue(value);
        if (normalized) fields.set(field, normalized);
    }
    return fields;
}

function buildApprovedChangePlan(
    session: SCSEMUpdaterSession,
    parsed: ParsedSCSEM,
    readWorkbook: XLSX.WorkBook,
    workbookSha256: string
): ApprovedChangePlan {
    const plan: ApprovedChangePlan = { updates: [], additions: [] };
    const workbookSheetNamesSignature = scsemWorkbookSheetNamesSignature(readWorkbook.SheetNames);
    const testSheets = parsed.sheets.filter((sheet) => sheet.sheetType === "test_cases");
    const reservedTestIds = new Set(testSheets.flatMap((sheet) => sheet.controls.map((control) => control.testId)));
    const reservedTestIdsBySheet = new Map(
        testSheets.map((sheet) => [sheet.sheetName, sheet.controls.map((control) => control.testId)])
    );
    const nextAdditionRowBySheet = new Map<string, number>();

    for (const change of session.changes.filter((candidate) => candidate.status === "APPROVED")) {
        const proposalErrors = approvedProposalValidationErrors(change);
        if (proposalErrors.length > 0) {
            throw approvedChangeError(change, proposalErrors.join("; "));
        }
        if (change.action === "addControl") {
            if (!change.newControl) {
                throw approvedChangeError(change, "the approved new-control payload is missing");
            }

            const targetSheet = targetSheetForNewControl(
                testSheets.map((sheet) => ({ ...sheet, controls: sheet.controls.map((control) => ({ ...control })) })),
                change
            );
            if (!targetSheet) {
                throw approvedChangeError(change, "an exact target test-case sheet was not provided or found");
            }

            const worksheet = readWorkbook.Sheets[targetSheet.sheetName];
            const header = worksheet ? findHeader(worksheet, {
                workbookSha256,
                sheetName: targetSheet.sheetName,
                workbookSheetNamesSignature,
            }) : null;
            if (!worksheet || !header) {
                throw approvedChangeError(change, `target sheet ${targetSheet.sheetName} has no SCSEM header`);
            }
            const targetSheetIds = reservedTestIdsBySheet.get(targetSheet.sheetName)!;
            let newTestId: string;
            do {
                newTestId = generateNextTestId(targetSheetIds, fallbackPrefix(session));
                targetSheetIds.push(newTestId);
            } while (reservedTestIds.has(newTestId));
            reservedTestIds.add(newTestId);
            let issueCodeSelection: ReturnType<typeof resolveSCSEMIssueCodeSelectionFromWorkbook>;
            try {
                issueCodeSelection = resolveSCSEMIssueCodeSelectionFromWorkbook(
                    readWorkbook,
                    change.newControl.issueCode
                );
            } catch (error) {
                throw approvedChangeError(
                    change,
                    error instanceof Error ? error.message : String(error)
                );
            }
            const fieldValues = newControlFieldValues(change, newTestId, issueCodeSelection);
            const exactAppendProfileCandidate = EXACT_APPEND_PROFILES.get(session.audit.uploadedSha256);
            const exactAppendProfile =
                session.audit.officialSource?.sha256 === session.audit.uploadedSha256 &&
                exactAppendProfileCandidate?.sheetName === targetSheet.sheetName
                    ? exactAppendProfileCandidate
                    : undefined;
            const exportFieldValues = new Map(fieldValues);
            if (exactAppendProfile?.losslessDescriptionComposite) {
                const description = fieldValues.get("description");
                const procedures = fieldValues.get("testProcedures");
                if (!description || !procedures) {
                    throw approvedChangeError(
                        change,
                        "the exact legacy composite requires both Description and Test Procedures"
                    );
                }
                exportFieldValues.delete("description");
                exportFieldValues.set(
                    "testProcedures",
                    `Objective:\n${description}\n\nTest Procedures:\n${procedures}`
                );
            }
            const requiredFields: ExportField[] = [
                "testId",
                "description",
                "testProcedures",
                "expectedResults",
                "criticality",
                "issueCode",
                "issueCodeDescription",
            ];
            for (const field of requiredFields) {
                if (field === "description" && exactAppendProfile?.losslessDescriptionComposite) {
                    if (
                        !fieldValues.has("description") ||
                        !header.columns.has("testProcedures") ||
                        header.duplicateFields.has("testProcedures")
                    ) {
                        throw approvedChangeError(
                            change,
                            `target sheet ${targetSheet.sheetName} cannot losslessly represent Description in Test Procedures`
                        );
                    }
                    continue;
                }
                if (
                    !exportFieldValues.has(field) ||
                    !header.columns.has(field) ||
                    header.duplicateFields.has(field)
                ) {
                    throw approvedChangeError(
                        change,
                        `target sheet ${targetSheet.sheetName} cannot represent required new-control field ${field}`
                    );
                }
            }
            if (header.duplicateFields.has("findingStatement")) {
                throw approvedChangeError(
                    change,
                    `target sheet ${targetSheet.sheetName} has duplicate columns for findingStatement`
                );
            }
            if (header.columns.has("findingStatement") && !fieldValues.has("findingStatement")) {
                throw approvedChangeError(
                    change,
                    `target sheet ${targetSheet.sheetName} requires a nonblank standard Finding Statement`
                );
            }
            const identityFields = (["nistId", "recommendationNum"] as ExportField[])
                .filter((field) => fieldValues.has(field));
            if (!identityFields.some((field) =>
                header.columns.has(field) && !header.duplicateFields.has(field)
            )) {
                throw approvedChangeError(
                    change,
                    `target sheet ${targetSheet.sheetName} cannot represent the required NIST or benchmark identifier`
                );
            }
            const rowByTestId = buildRowByTestId(worksheet, header);
            // Active AutoFilters can mark real controls as hidden in SheetJS. The
            // insertion anchor is structural, so it must follow the last physical
            // Test ID regardless of row visibility (for example Palo Alto 10).
            const lastControlRow = lastPhysicalControlRow(rowByTestId);
            const cisBootstrapBlank =
                session.workspaceMode === "cis_bootstrap" &&
                parsed.totalControls === 0 &&
                !session.audit.officialSource;
            const blankAnchorRow = header.headerRow + 1;
            if (
                lastControlRow === null &&
                (!cisBootstrapBlank || header.range.e.r < blankAnchorRow)
            ) {
                throw approvedChangeError(change, `target sheet ${targetSheet.sheetName} has no control row to anchor a safe addition`);
            }
            const row = nextAdditionRowBySheet.get(targetSheet.sheetName) ??
                (lastControlRow === null ? blankAnchorRow + 1 : lastControlRow + 1);
            nextAdditionRowBySheet.set(targetSheet.sheetName, row + 1);
            if (exactAppendProfile && exactAppendProfile.row !== row) {
                throw approvedChangeError(
                    change,
                    `exact append profile row ${targetSheet.sheetName}!${row + 1} does not match the pinned source`
                );
            }
            const footerCellAddress = canonicalInsertionFooterCell(worksheet, row, header.range);
            const structuralFooterProfile = VERIFIED_STRUCTURAL_FOOTER_PROFILES.get(
                session.audit.uploadedSha256
            );
            const exactOfficialSource =
                session.audit.officialSource?.sha256 === session.audit.uploadedSha256;
            const structuralProfileMatches = exactOfficialSource &&
                structuralFooterProfile?.sheetName === targetSheet.sheetName &&
                structuralFooterProfile.row === row;
            // Structural insertion is enabled only for an exact, source-controlled
            // workbook profile whose row mechanics have an independent OOXML
            // regression oracle. Canonical text and the one pinned blank separator
            // are distinct preconditions and are validated again against raw XML.
            const insertBeforeFooter = Boolean(structuralProfileMatches && (
                structuralFooterProfile?.blankStructuralFooter || footerCellAddress !== null
            ));
            const allowedTargetMergeRefs = insertBeforeFooter
                ? structuralFooterProfile?.allowedTargetMergeRefs || []
                : [];
            const cells = new Map<string, string>();
            const writtenFields = new Map<ExportField, string>();
            const omittedFields: ExportField[] = [];
            for (const [field, value] of exportFieldValues) {
                const col = header.columns.get(field);
                if (col === undefined || header.duplicateFields.has(field)) {
                    omittedFields.push(field);
                    continue;
                }
                const touchingMerge = (worksheet["!merges"] || []).find((range) =>
                    row >= range.s.r && row <= range.e.r && col >= range.s.c && col <= range.e.c
                );
                const touchingMergeRef = touchingMerge
                    ? XLSX.utils.encode_range(touchingMerge)
                    : null;
                if (touchingMergeRef && !allowedTargetMergeRefs.includes(touchingMergeRef)) {
                    throw approvedChangeError(
                        change,
                        `target blank-row cell ${targetSheet.sheetName}!${XLSX.utils.encode_cell({ r: row, c: col })} is merged`
                    );
                }
                cells.set(XLSX.utils.encode_cell({ r: row, c: col }), value);
                writtenFields.set(field, value);
            }
            if (exactAppendProfile?.losslessDescriptionComposite) {
                writtenFields.set("description", fieldValues.get("description")!);
                writtenFields.set("testProcedures", fieldValues.get("testProcedures")!);
            }
            const assessmentFields: ExportField[] = [
                "actualResults",
                "status",
                "notesEvidence",
                "remediationStatement",
                "capRequestStatement",
            ];
            const assessmentCells = assessmentFields
                .map((field) => header.columns.get(field))
                .filter((col): col is number => col !== undefined)
                .map((col) => XLSX.utils.encode_cell({ r: row, c: col }));
            const issueCodeCol = header.columns.get("issueCode");
            const riskRatingCol = header.columns.get("riskRating");
            if (
                issueCodeCol === undefined ||
                header.duplicateFields.has("issueCode") ||
                riskRatingCol === undefined ||
                header.duplicateFields.has("riskRating")
            ) {
                throw approvedChangeError(
                    change,
                    `target sheet ${targetSheet.sheetName} cannot represent a unique computed risk formula tied to its issue code`
                );
            }
            const issueCodeAddress = XLSX.utils.encode_cell({ r: row, c: issueCodeCol });
            const riskRatingAddress = XLSX.utils.encode_cell({ r: row, c: riskRatingCol });
            const missingTargetCells = [...cells.keys()].filter((address) => !worksheet[address]);
            const cloneSourceRow = cisBootstrapBlank
                ? blankAnchorRow
                : insertBeforeFooter
                    ? structuralFooterProfile?.cloneSourceRow ?? row - 1
                    : (missingTargetCells.length === cells.size && cells.size > 0)
                        ? row - 1
                        : undefined;

            plan.additions.push({
                change,
                sheetName: targetSheet.sheetName,
                row,
                newTestId,
                cells,
                writtenFields,
                omittedFields,
                assessmentCells,
                issueCodeAddress,
                riskRatingAddress,
                riskFormulaSourceRow: cisBootstrapBlank
                    ? blankAnchorRow
                    : structuralProfileMatches
                        ? structuralFooterProfile?.riskFormulaSourceRow ?? row - 1
                        : row - 1,
                cloneSourceRow,
                insertBeforeFooter,
                footerCellAddress: footerCellAddress || undefined,
                blankStructuralFooter: structuralProfileMatches
                    ? structuralFooterProfile?.blankStructuralFooter
                    : undefined,
                allowedTargetMergeRefs,
                materializeRiskFormula: structuralProfileMatches
                    ? structuralFooterProfile?.materializeRiskFormula
                    : undefined,
                allowHiddenStructuralFooter: structuralProfileMatches
                    ? structuralFooterProfile?.allowHiddenStructuralFooter
                    : undefined,
                allowHiddenCloneSource: structuralProfileMatches
                    ? structuralFooterProfile?.allowHiddenCloneSource
                    : undefined,
                materializeSparseRowFrom: exactAppendProfile?.materializeSparseRowFrom,
                materializeSparseThroughColumn: exactAppendProfile?.materializeSparseThroughColumn,
                explicitRiskFormula: exactAppendProfile?.explicitRiskFormula,
                stripFormulaCacheAddresses: exactAppendProfile?.stripFormulaCacheAddresses,
                formulaRepairs: exactAppendProfile?.formulaRepairs,
                doNotExtendFeatureSqrefs: exactAppendProfile?.doNotExtendFeatureSqrefs,
            });
            continue;
        }

        if (!ALLOWED_UPDATE_FIELDS.has(change.field) || !isExportField(change.field)) {
            throw approvedChangeError(change, "the target field is not allowed for template maintenance");
        }

        const requestedSheet = requestedTargetSheet(change);
        let candidateSheets = testSheets.filter((sheet) =>
            sheet.controls.some((control) => control.testId === change.testId)
        );
        if (requestedSheet) {
            const exactSheet = testSheets.find((sheet) =>
                normalizedSheetKey(sheet.sheetName) === normalizedSheetKey(requestedSheet)
            );
            if (!exactSheet) {
                throw approvedChangeError(change, `target sheet ${requestedSheet} was not found`);
            }
            candidateSheets = exactSheet.controls.some((control) => control.testId === change.testId)
                ? [exactSheet]
                : [];
        }

        if (candidateSheets.length !== 1) {
            throw approvedChangeError(
                change,
                candidateSheets.length === 0
                    ? "the exact target Test ID was not found on the target sheet"
                    : "the Test ID is ambiguous across sheets; an exact target sheet is required"
            );
        }

        const targetSheet = candidateSheets[0];
        const parsedMatches = targetSheet.controls.filter((control) => control.testId === change.testId);
        if (parsedMatches.length !== 1) {
            throw approvedChangeError(change, "the target Test ID is duplicated on the target sheet");
        }

        const worksheet = readWorkbook.Sheets[targetSheet.sheetName];
        const header = worksheet ? findHeader(worksheet, {
            workbookSha256,
            sheetName: targetSheet.sheetName,
            workbookSheetNamesSignature,
        }) : null;
        if (!worksheet || !header) {
            throw approvedChangeError(change, `target sheet ${targetSheet.sheetName} has no SCSEM header`);
        }
        const col = header.columns.get(change.field);
        if (col === undefined || header.duplicateFields.has(change.field)) {
            throw approvedChangeError(
                change,
                header.duplicateFields.has(change.field)
                    ? `target sheet ${targetSheet.sheetName} has duplicate columns for ${change.field}`
                    : `target sheet ${targetSheet.sheetName} has no column for ${change.field}`
            );
        }

        const rows = rowsForTestId(worksheet, header, change.testId);
        if (rows.length !== 1) {
            throw approvedChangeError(change, "the physical workbook row could not be resolved uniquely");
        }
        const row = rows[0];
        const address = XLSX.utils.encode_cell({ r: row, c: col });
        if ((worksheet["!merges"] || []).some((range) =>
            row >= range.s.r && row <= range.e.r && col >= range.s.c && col <= range.e.c
        )) {
            throw approvedChangeError(
                change,
                `target cell ${targetSheet.sheetName}!${address} is merged`
            );
        }
        const cell = worksheet[address] as XLSX.CellObject | undefined;
        if (typeof cell?.f === "string" && cell.f.trim()) {
            throw approvedChangeError(change, `target cell ${targetSheet.sheetName}!${address} contains a formula`);
        }

        const workbookValue = cellText(worksheet, row, col);
        const parsedValue = normalizedControlValue(
            (parsedMatches[0] as unknown as Record<string, unknown>)[change.field]
        );
        const expectedValue = normalizedControlValue(change.currentValue);
        if (workbookValue !== expectedValue || parsedValue !== expectedValue) {
            throw approvedChangeError(
                change,
                `target cell ${targetSheet.sheetName}!${address} changed after analysis`
            );
        }
        if (normalizedControlValue(change.proposedValue) === expectedValue) {
            throw approvedChangeError(change, "the approved value is unchanged");
        }

        plan.updates.push({
            change,
            sheetName: targetSheet.sheetName,
            row,
            col,
            address,
        });
    }

    const claimedTargets = new Map<string, SCSEMUpdaterChange>();
    const claimTarget = (change: SCSEMUpdaterChange, sheetName: string, address: string) => {
        const key = `${sheetName}\u0000${address}`;
        const previous = claimedTargets.get(key);
        if (previous) {
            throw approvedChangeError(
                change,
                `target cell ${sheetName}!${address} is also targeted by approved change ${previous.id}`
            );
        }
        claimedTargets.set(key, change);
    };
    for (const operation of plan.updates) {
        claimTarget(operation.change, operation.sheetName, operation.address);
    }
    for (const operation of plan.additions) {
        for (const address of operation.cells.keys()) {
            claimTarget(operation.change, operation.sheetName, address);
        }
    }

    return plan;
}

function decodeXml(value: string): string {
    return value
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&amp;/g, "&");
}

function escapeXml(value: string): string {
    const illegal = value.match(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u)?.[0];
    if (illegal) {
        throw new Error(
            `Cannot export SCSEM workbook: text contains XML 1.0-illegal character U+${
                illegal.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")
            }.`
        );
    }
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function setXmlAttribute(tag: string, name: string, value: string): string {
    const matcher = new RegExp(`\\s${name}="[^"]*"`);
    if (matcher.test(tag)) return tag.replace(matcher, ` ${name}="${value}"`);
    return tag.endsWith("/>")
        ? tag.replace(/\s*\/>$/, ` ${name}="${value}"/>`)
        : tag.replace(/\s*>$/, ` ${name}="${value}">`);
}

function forceWorkbookCalculationOnOpen(workbookXml: string): string {
    const existing = workbookXml.match(/<calcPr\b[^>]*(?:\/>|>[\s\S]*?<\/calcPr>)/i)?.[0];
    if (existing) {
        const opening = existing.match(/^<calcPr\b[^>]*\/?\s*>/i)?.[0];
        if (!opening) throw new Error("Cannot export SCSEM workbook: calculation properties are malformed.");
        let updatedOpening = setXmlAttribute(opening, "calcMode", "auto");
        updatedOpening = setXmlAttribute(updatedOpening, "fullCalcOnLoad", "1");
        updatedOpening = setXmlAttribute(updatedOpening, "forceFullCalc", "1");
        return workbookXml.replace(existing, existing.replace(opening, updatedOpening));
    }
    let calcPr = "<calcPr/>";
    calcPr = setXmlAttribute(calcPr, "calcMode", "auto");
    calcPr = setXmlAttribute(calcPr, "fullCalcOnLoad", "1");
    calcPr = setXmlAttribute(calcPr, "forceFullCalc", "1");

    const laterNode = workbookXml.search(
        /<(?:oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b/i
    );
    if (laterNode >= 0) return workbookXml.slice(0, laterNode) + calcPr + workbookXml.slice(laterNode);
    const workbookClose = workbookXml.lastIndexOf("</workbook>");
    if (workbookClose < 0) {
        throw new Error("Cannot export SCSEM workbook: workbook XML is malformed.");
    }
    return workbookXml.slice(0, workbookClose) + calcPr + workbookXml.slice(workbookClose);
}

type AutoFilterExtension = {
    sheetName: string;
    oldRef: string;
    newRef: string;
};

function extendWorksheetAutoFilterForAddedRow(
    sheetXml: string,
    sheetName: string,
    row: number
): { xml: string; extension: AutoFilterExtension | null } {
    const opening = sheetXml.match(/<autoFilter\b[^>]*>/i)?.[0];
    if (!opening) return { xml: sheetXml, extension: null };
    const oldRef = xmlAttributes(opening).get("ref");
    if (!oldRef) return { xml: sheetXml, extension: null };
    const range = XLSX.utils.decode_range(oldRef);
    if (range.e.r !== row - 1) return { xml: sheetXml, extension: null };
    range.e.r = row;
    const newRef = XLSX.utils.encode_range(range);
    const updatedOpening = setXmlAttribute(opening, "ref", newRef);
    return {
        xml: sheetXml.replace(opening, updatedOpening),
        extension: { sheetName, oldRef, newRef },
    };
}

function extendWorkbookFilterDefinedName(
    workbookXml: string,
    sheetIndex: number,
    extension: AutoFilterExtension
): string {
    const matchingNames = (workbookXml.match(/<definedName\b[^>]*>[\s\S]*?<\/definedName>/gi) || [])
        .filter((node) => {
            const opening = node.match(/^<definedName\b[^>]*>/i)?.[0] || "";
            const attributes = xmlAttributes(opening);
            return attributes.get("name") === "_xlnm._FilterDatabase" &&
                Number(attributes.get("localSheetId")) === sheetIndex;
        });
    if (matchingNames.length === 0) return workbookXml;
    if (matchingNames.length !== 1) {
        throw new Error(
            `Cannot export SCSEM workbook: ${extension.sheetName} has ambiguous AutoFilter defined names.`
        );
    }
    const node = matchingNames[0];
    const oldAbsoluteRef = absoluteRangeRef(extension.oldRef);
    if (!node.includes(oldAbsoluteRef)) {
        throw new Error(
            `Cannot export SCSEM workbook: ${extension.sheetName} AutoFilter defined name does not match its worksheet range.`
        );
    }
    return workbookXml.replace(node, node.replace(oldAbsoluteRef, absoluteRangeRef(extension.newRef)));
}

function xmlAttributes(fragment: string): Map<string, string> {
    const attributes = new Map<string, string>();
    const matcher = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(fragment))) {
        attributes.set(match[1], decodeXml(match[2]));
    }
    return attributes;
}

function worksheetProtectionEnabled(sheetXml: string): boolean {
    const protection = sheetXml.match(/<sheetProtection\b[^>]*\/?\s*>/i)?.[0];
    if (!protection) return false;
    const attributes = xmlAttributes(protection);
    const sheet = attributes.get("sheet")?.toLowerCase();
    if (sheet === "1" || sheet === "true") return true;
    return ["password", "algorithmName", "hashValue", "saltValue", "spinCount"]
        .some((attribute) => attributes.has(attribute));
}

async function worksheetPathsByName(zip: JSZip): Promise<Map<string, string>> {
    const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
    const relationshipsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
    if (!workbookXml || !relationshipsXml) {
        throw new Error("Cannot export SCSEM workbook: workbook relationships are missing.");
    }

    const targetsById = new Map<string, string>();
    for (const relationship of relationshipsXml.match(/<Relationship\b[^>]*\/?\s*>/g) || []) {
        const attributes = xmlAttributes(relationship);
        const id = attributes.get("Id");
        const target = attributes.get("Target");
        if (!id || !target) continue;
        const normalized = target.startsWith("/")
            ? path.posix.normalize(target.slice(1))
            : path.posix.normalize(path.posix.join("xl", target));
        targetsById.set(id, normalized);
    }

    const pathsByName = new Map<string, string>();
    for (const sheet of workbookXml.match(/<sheet\b[^>]*\/?\s*>/g) || []) {
        const attributes = xmlAttributes(sheet);
        const name = attributes.get("name");
        const relationshipId = attributes.get("r:id");
        const target = relationshipId ? targetsById.get(relationshipId) : null;
        if (name && target) pathsByName.set(name, target);
    }
    return pathsByName;
}

type XmlNodeMatch = { start: number; end: number; value: string };

function findCellXml(sheetXml: string, address: string): XmlNodeMatch | null {
    const matcher = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(sheetXml))) {
        const openingTag = match[0].match(/^<c\b[^>]*>/)?.[0] || match[0];
        if (xmlAttributes(openingTag).get("r") === address) {
            return { start: match.index, end: match.index + match[0].length, value: match[0] };
        }
    }
    return null;
}

function cellColumn(address: string): number {
    return XLSX.utils.decode_cell(address).c;
}

function inlineStringCellXml(address: string, value: string, originalCell?: string): string {
    const openingTag = originalCell?.match(/^<c\b([^>]*)\/?\s*>/)?.[1] || ` r="${address}"`;
    let attributes = openingTag
        .replace(/\s+r="[^"]*"/g, "")
        .replace(/\s+t="[^"]*"/g, "")
        .replace(/\/\s*$/, "")
        .trim();
    attributes = attributes ? ` ${attributes}` : "";
    return `<c r="${address}"${attributes} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function patchCellXml(sheetXml: string, address: string, value: string): string {
    const existing = findCellXml(sheetXml, address);
    if (existing) {
        if (/<f\b/i.test(existing.value)) {
            throw new Error(`Cannot export SCSEM workbook: target cell ${address} contains a formula.`);
        }
        return sheetXml.slice(0, existing.start) +
            inlineStringCellXml(address, value, existing.value) +
            sheetXml.slice(existing.end);
    }

    const excelRow = XLSX.utils.decode_cell(address).r + 1;
    const rowMatcher = new RegExp(`<row\\b[^>]*\\br="${excelRow}"[^>]*>[\\s\\S]*?<\\/row>`);
    const rowMatch = rowMatcher.exec(sheetXml);
    if (!rowMatch) {
        throw new Error(`Cannot export SCSEM workbook: target row ${excelRow} is missing.`);
    }

    const rowXml = rowMatch[0];
    const closingIndex = rowXml.lastIndexOf("</row>");
    let insertAt = closingIndex;
    const targetCol = cellColumn(address);
    const cellMatcher = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellMatcher.exec(rowXml))) {
        const cellAddress = xmlAttributes(cellMatch[0].match(/^<c\b[^>]*>/)?.[0] || cellMatch[0]).get("r");
        if (cellAddress && cellColumn(cellAddress) > targetCol) {
            insertAt = cellMatch.index;
            break;
        }
    }

    const nextRow = rowXml.slice(0, insertAt) + inlineStringCellXml(address, value) + rowXml.slice(insertAt);
    return sheetXml.slice(0, rowMatch.index) + nextRow + sheetXml.slice(rowMatch.index + rowXml.length);
}

function pairedOrdinaryFormula(cellXml: string, address: string): string {
    const paired = cellXml.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
    if (!paired) {
        throw new Error(
            /<f\b/i.test(cellXml)
                ? `formula ${address} is self-closing or malformed`
                : `computed risk cell ${address} has no formula`
        );
    }
    const formulaType = xmlAttributes(`<f${paired[1]}>`).get("t")?.trim();
    if (formulaType) {
        throw new Error(
            `computed risk formula ${address} uses unsupported OOXML formula type ${formulaType}`
        );
    }
    if (!paired[2].trim()) {
        throw new Error(`computed risk formula ${address} is blank`);
    }
    return paired[2];
}

function formulaWithoutStringLiterals(formula: string): string {
    return formula.replace(/"(?:[^"]|"")*"/g, "\"\"");
}

function formulaReferencesLocalRow(formula: string, excelRow: number): boolean {
    const searchable = formulaWithoutStringLiterals(decodeXml(formula));
    const matcher = new RegExp(
        `(?<![\\p{L}\\p{N}_.!])\\$?[A-Z]{1,3}\\$?${excelRow}(?!\\d)`,
        "iu"
    );
    return matcher.test(searchable);
}

function formulaReferencesLocalColumn(
    formula: string,
    column: string,
    excelRow: number
): boolean {
    const searchable = formulaWithoutStringLiterals(decodeXml(formula));
    const escapedColumn = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = new RegExp(
        `(?<![\\p{L}\\p{N}_.!])\\$?${escapedColumn}(?:\\$?${excelRow}(?!\\d)|\\s*:\\s*\\$?${escapedColumn}(?![\\p{L}\\p{N}_]))`,
        "iu"
    );
    return matcher.test(searchable);
}

function assertAdditionRiskFormula(
    sourceSheetXml: string,
    targetRowXml: string,
    operation: ResolvedAddition
) {
    const targetCell = findCellXml(targetRowXml, operation.riskRatingAddress);
    const riskColumn = XLSX.utils.decode_cell(operation.riskRatingAddress).c;
    const issueCodeColumn = XLSX.utils.encode_col(
        XLSX.utils.decode_cell(operation.issueCodeAddress).c
    );
    const targetExcelRow = operation.row + 1;
    if (operation.explicitRiskFormula) {
        let targetFormula = operation.explicitRiskFormula.formula;
        if (targetCell && /<f\b/i.test(targetCell.value)) {
            const paired = targetCell.value.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
            if (!paired) {
                throw new Error(
                    `computed risk formula ${operation.riskRatingAddress} is self-closing or malformed`
                );
            }
            const attributes = xmlAttributes(`<f${paired[1]}>`);
            const expectedType = operation.explicitRiskFormula.formulaType;
            if ((attributes.get("t") || undefined) !== expectedType) {
                throw new Error(
                    `computed risk formula ${operation.riskRatingAddress} has the wrong exact formula type`
                );
            }
            if ((attributes.get("ref") || undefined) !== operation.explicitRiskFormula.formulaRef) {
                throw new Error(
                    `computed risk formula ${operation.riskRatingAddress} has the wrong exact formula reference`
                );
            }
            targetFormula = paired[2];
        }
        if (targetFormula !== operation.explicitRiskFormula.formula) {
            throw new Error(
                `computed risk formula ${operation.riskRatingAddress} does not match its pinned exact profile`
            );
        }
        if (!formulaReferencesLocalRow(targetFormula, targetExcelRow)) {
            throw new Error(
                `computed risk formula ${operation.riskRatingAddress} does not reference the new control row`
            );
        }
        if (!formulaReferencesLocalColumn(targetFormula, issueCodeColumn, targetExcelRow)) {
            throw new Error(
                `computed risk formula ${operation.riskRatingAddress} does not reference issue-code column ${issueCodeColumn}`
            );
        }
        return;
    }
    const sourceAddress = XLSX.utils.encode_cell({
        r: operation.riskFormulaSourceRow,
        c: riskColumn,
    });
    const sourceCell = findCellXml(sourceSheetXml, sourceAddress);
    if (!sourceCell) {
        throw new Error(`source computed risk cell ${sourceAddress} is missing`);
    }
    const sourceFormula = pairedOrdinaryFormula(sourceCell.value, sourceAddress);
    const sourceExcelRow = operation.riskFormulaSourceRow + 1;
    const expected = translateCopiedSCSEMFormula(
        sourceFormula,
        targetExcelRow - sourceExcelRow,
        { formulaType: null }
    );
    const targetFormula = targetCell && /<f\b/i.test(targetCell.value)
        ? pairedOrdinaryFormula(targetCell.value, operation.riskRatingAddress)
        : expected;
    if (targetFormula !== expected) {
        throw new Error(
            `computed risk formula ${operation.riskRatingAddress} is not the exact row-translated template formula`
        );
    }
    if (!formulaReferencesLocalRow(targetFormula, targetExcelRow)) {
        throw new Error(
            `computed risk formula ${operation.riskRatingAddress} does not reference the new control row`
        );
    }
    if (formulaReferencesLocalRow(targetFormula, sourceExcelRow)) {
        throw new Error(
            `computed risk formula ${operation.riskRatingAddress} still references its donor row`
        );
    }
    if (!formulaReferencesLocalColumn(targetFormula, issueCodeColumn, targetExcelRow)) {
        throw new Error(
            `computed risk formula ${operation.riskRatingAddress} does not reference issue-code column ${issueCodeColumn}`
        );
    }
}

function stripFormulaCacheAtAddress(sheetXml: string, address: string): string {
    const cell = findCellXml(sheetXml, address);
    if (!cell) throw new Error(`Cannot export SCSEM workbook: formula cell ${address} is missing.`);
    pairedOrdinaryFormula(cell.value, address);
    const withoutCache = cell.value
        .replace(/<v\b[^>]*>[\s\S]*?<\/v>/gi, "")
        .replace(/<v\b[^>]*\/>/gi, "");
    if (withoutCache === cell.value) return sheetXml;
    return sheetXml.slice(0, cell.start) + withoutCache + sheetXml.slice(cell.end);
}

function stripPairedFormulaCacheAtAddress(sheetXml: string, address: string): string {
    const cell = findCellXml(sheetXml, address);
    if (!cell || !/<f\b[^>]*>[\s\S]*?<\/f>/i.test(cell.value)) {
        throw new Error(`Cannot export SCSEM workbook: paired formula cell ${address} is missing.`);
    }
    const withoutCache = cell.value
        .replace(/<v\b[^>]*>[\s\S]*?<\/v>/gi, "")
        .replace(/<v\b[^>]*\/>/gi, "");
    return sheetXml.slice(0, cell.start) + withoutCache + sheetXml.slice(cell.end);
}

function materializeCopiedOrdinaryFormulaAtAddress(
    sheetXml: string,
    sourceAddress: string,
    targetAddress: string
): string {
    const sourceCell = findCellXml(sheetXml, sourceAddress);
    const targetCell = findCellXml(sheetXml, targetAddress);
    if (!sourceCell || !targetCell) {
        throw new Error(
            `Cannot export SCSEM workbook: formula source/target ${sourceAddress}/${targetAddress} is missing.`
        );
    }
    const sourceFormula = pairedOrdinaryFormula(sourceCell.value, sourceAddress);
    if (/<f\b/i.test(targetCell.value) || rowXmlHasMaterialValue(`<row>${targetCell.value}</row>`)) {
        throw new Error(
            `Cannot export SCSEM workbook: formula target ${targetAddress} is not an empty style cell.`
        );
    }
    const source = XLSX.utils.decode_cell(sourceAddress);
    const target = XLSX.utils.decode_cell(targetAddress);
    if (source.c !== target.c) {
        throw new Error("Cannot export SCSEM workbook: copied risk formula changed columns.");
    }
    const translated = translateCopiedSCSEMFormula(
        sourceFormula,
        target.r - source.r,
        { formulaType: null }
    );
    const opening = targetCell.value.match(/^<c\b[^>]*\/?>/)?.[0];
    if (!opening) {
        throw new Error(`Cannot export SCSEM workbook: formula target ${targetAddress} is malformed.`);
    }
    const formulaCell = /\/>$/.test(opening)
        ? opening.replace(/\/>$/, `><f>${translated}</f></c>`)
        : `${opening}<f>${translated}</f></c>`;
    return sheetXml.slice(0, targetCell.start) + formulaCell + sheetXml.slice(targetCell.end);
}

function copiedFormulaAddressesForRow(
    sheetXml: string,
    sourceZeroBasedRow: number,
    targetZeroBasedRow: number
): Array<{ source: string; target: string }> {
    const sourceRow = rowXmlByNumber(sheetXml, sourceZeroBasedRow + 1);
    if (!sourceRow) {
        throw new Error(`Cannot export SCSEM workbook: formula donor row ${sourceZeroBasedRow + 1} is missing.`);
    }
    return (sourceRow.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || []).flatMap((cellXml) => {
        if (!/<f\b/i.test(cellXml)) return [];
        const opening = cellXml.match(/^<c\b[^>]*>/)?.[0] || cellXml;
        const source = xmlAttributes(opening).get("r");
        if (!source) throw new Error("Cannot export SCSEM workbook: formula donor cell has no address.");
        pairedOrdinaryFormula(cellXml, source);
        const decoded = XLSX.utils.decode_cell(source);
        return [{
            source,
            target: XLSX.utils.encode_cell({ r: targetZeroBasedRow, c: decoded.c }),
        }];
    });
}

function materializeCopiedFormulaCellsForAppend(
    sheetXml: string,
    operation: ResolvedAddition
): {
    xml: string;
    clonedFormulaAddresses: Array<{ source: string; target: string }>;
} {
    const sourceExcelRow = operation.riskFormulaSourceRow + 1;
    const targetExcelRow = operation.row + 1;
    const sourceRow = rowXmlByNumber(sheetXml, sourceExcelRow);
    const targetRowNode = rowXmlNodeByNumber(sheetXml, targetExcelRow);
    if (!sourceRow || !targetRowNode) {
        throw new Error(
            `Cannot export SCSEM workbook: formula donor/target rows ${sourceExcelRow}/${targetExcelRow} are missing.`
        );
    }

    let targetRow = targetRowNode.value;
    const clonedFormulaAddresses: Array<{ source: string; target: string }> = [];
    for (const sourceCellXml of sourceRow.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || []) {
        if (!/<f\b/i.test(sourceCellXml)) continue;
        const sourceOpening = sourceCellXml.match(/^<c\b[^>]*>/)?.[0] || sourceCellXml;
        const sourceAddress = xmlAttributes(sourceOpening).get("r");
        if (!sourceAddress) {
            throw new Error("Cannot export SCSEM workbook: formula donor cell has no address.");
        }
        const decoded = XLSX.utils.decode_cell(sourceAddress);
        const targetAddress = XLSX.utils.encode_cell({ r: operation.row, c: decoded.c });
        if (
            operation.explicitRiskFormula &&
            decoded.c === XLSX.utils.decode_cell(operation.riskRatingAddress).c
        ) {
            continue;
        }
        const sourceFormula = pairedOrdinaryFormula(sourceCellXml, sourceAddress);
        if (operation.cells.has(targetAddress)) {
            throw new Error(
                `Cannot export SCSEM workbook: template formula ${sourceAddress} conflicts with new-control field ${targetAddress}.`
            );
        }
        const expectedFormula = translateCopiedSCSEMFormula(
            sourceFormula,
            targetExcelRow - sourceExcelRow,
            { formulaType: null }
        );
        const targetCell = findCellXml(targetRow, targetAddress);
        if (targetCell && /<f\b/i.test(targetCell.value)) {
            const targetFormula = pairedOrdinaryFormula(targetCell.value, targetAddress);
            if (targetFormula !== expectedFormula) {
                throw new Error(
                    `Cannot export SCSEM workbook: formula ${targetAddress} is not the exact row-translated donor formula.`
                );
            }
            const withoutCache = targetCell.value
                .replace(/<v\b[^>]*>[\s\S]*?<\/v>/gi, "")
                .replace(/<v\b[^>]*\/>/gi, "");
            targetRow = targetRow.slice(0, targetCell.start) + withoutCache + targetRow.slice(targetCell.end);
            continue;
        }

        const targetOpening = setXmlAttribute(sourceOpening, "r", targetAddress)
            .replace(/\s+t="[^"]*"/gi, "");
        const sourceFormulaNode = sourceCellXml.match(/<f\b([^>]*)>[\s\S]*?<\/f>/i)!;
        const targetFormulaCell = sourceCellXml
            .replace(sourceOpening, targetOpening)
            .replace(
                sourceFormulaNode[0],
                `<f${sourceFormulaNode[1]}>${expectedFormula}</f>`
            )
            .replace(/<v\b[^>]*>[\s\S]*?<\/v>/gi, "")
            .replace(/<v\b[^>]*\/>/gi, "");
        targetRow = replaceOrInsertRowCell(targetRow, targetAddress, targetFormulaCell);
        clonedFormulaAddresses.push({ source: sourceAddress, target: targetAddress });
    }

    if (operation.explicitRiskFormula) {
        const targetCell = findCellXml(targetRow, operation.riskRatingAddress);
        if (!targetCell || /<f\b/i.test(targetCell.value) || rowXmlHasMaterialValue(`<row>${targetCell?.value || ""}</row>`)) {
            throw new Error(
                `Cannot export SCSEM workbook: explicit risk target ${operation.riskRatingAddress} is not an empty style cell.`
            );
        }
        const opening = targetCell.value.match(/^<c\b[^>]*\/?\s*>/)?.[0];
        if (!opening) {
            throw new Error(
                `Cannot export SCSEM workbook: explicit risk target ${operation.riskRatingAddress} is malformed.`
            );
        }
        const targetOpening = setXmlAttribute(
            opening,
            "s",
            operation.explicitRiskFormula.styleId
        ).replace(/\s+t="[^"]*"/gi, "");
        const formulaAttributes = operation.explicitRiskFormula.formulaType
            ? ` t="${operation.explicitRiskFormula.formulaType}" ref="${operation.explicitRiskFormula.formulaRef}"`
            : "";
        const formulaCell = /\/>$/.test(targetOpening)
            ? targetOpening.replace(
                /\/>$/,
                `><f${formulaAttributes}>${operation.explicitRiskFormula.formula}</f></c>`
            )
            : `${targetOpening}<f${formulaAttributes}>${operation.explicitRiskFormula.formula}</f></c>`;
        targetRow = targetRow.slice(0, targetCell.start) + formulaCell + targetRow.slice(targetCell.end);
    }

    const updatedRiskCell = findCellXml(targetRow, operation.riskRatingAddress);
    if (!updatedRiskCell) {
        throw new Error(`Cannot export SCSEM workbook: computed risk cell ${operation.riskRatingAddress} is missing.`);
    }
    if (!operation.explicitRiskFormula) {
        pairedOrdinaryFormula(updatedRiskCell.value, operation.riskRatingAddress);
    }
    assertAdditionRiskFormula(sheetXml, targetRow, operation);
    const xml = sheetXml.slice(0, targetRowNode.start) + targetRow + sheetXml.slice(targetRowNode.end);
    return { xml, clonedFormulaAddresses };
}

function rowXmlNodeByNumber(sheetXml: string, excelRow: number): XmlNodeMatch | null {
    const matcher = /<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(sheetXml))) {
        const opening = match[0].match(/^<row\b[^>]*>/)?.[0] || match[0];
        if (Number(xmlAttributes(opening).get("r")) === excelRow) {
            return { start: match.index, end: match.index + match[0].length, value: match[0] };
        }
    }
    return null;
}

function rowXmlByNumber(sheetXml: string, excelRow: number): string | null {
    return rowXmlNodeByNumber(sheetXml, excelRow)?.value || null;
}

function rowXmlHasMaterialValue(rowXml: string): boolean {
    const matcher = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(rowXml))) {
        if (/<f\b/i.test(match[0])) return true;
        const value = match[0].match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1];
        if (value && decodeXml(value).trim()) return true;
        const inlineText = [...match[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
            .map((text) => decodeXml(text[1]).trim())
            .join("");
        if (inlineText) return true;
    }
    return false;
}

function rowXmlHasNonFormulaMaterialValue(rowXml: string): boolean {
    const matcher = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(rowXml))) {
        if (/<f\b/i.test(match[0])) continue;
        const value = match[0].match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1];
        if (value && decodeXml(value).trim()) return true;
        const inlineText = [...match[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
            .map((text) => decodeXml(text[1]).trim())
            .join("");
        if (inlineText) return true;
    }
    return false;
}

function rowXmlNodesByNumber(sheetXml: string, excelRow: number): XmlNodeMatch[] {
    const rows: XmlNodeMatch[] = [];
    const matcher = /<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(sheetXml))) {
        const opening = match[0].match(/^<row\b[^>]*>/)?.[0] || match[0];
        if (Number(xmlAttributes(opening).get("r")) === excelRow) {
            rows.push({ start: match.index, end: match.index + match[0].length, value: match[0] });
        }
    }
    return rows;
}

function clonedBlankRowXml(sourceRowXml: string, sourceExcelRow: number, targetExcelRow: number): string {
    const rowDelta = targetExcelRow - sourceExcelRow;
    const sourceOpening = sourceRowXml.match(/^<row\b[^>]*>/)?.[0];
    if (!sourceOpening) {
        throw new Error(`Cannot export SCSEM workbook: source row ${sourceExcelRow} is malformed.`);
    }
    let rowOpening = setXmlAttribute(sourceOpening, "r", String(targetExcelRow));
    rowOpening = rowOpening.replace(/\s+hidden="(?:1|true)"/i, "");
    const cells: string[] = [];
    for (const match of sourceRowXml.matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)) {
        const sourceCell = match[0];
        const opening = sourceCell.match(/^<c\b[^>]*\/?\s*>/)?.[0];
        const sourceAddress = opening ? xmlAttributes(opening).get("r") : null;
        if (!opening || !sourceAddress) {
            throw new Error(`Cannot export SCSEM workbook: source row ${sourceExcelRow} has a malformed cell.`);
        }
        const decoded = XLSX.utils.decode_cell(sourceAddress);
        const targetAddress = XLSX.utils.encode_cell({ r: targetExcelRow - 1, c: decoded.c });
        let targetOpening = setXmlAttribute(opening, "r", targetAddress);
        const formula = sourceCell.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
        if (formula) {
            const formulaAttributes = xmlAttributes(`<f${formula[1]}>`);
            cells.push(
                sourceCell
                    .replace(opening, targetOpening)
                    .replace(
                        formula[0],
                        `<f${formula[1]}>${translateCopiedSCSEMFormula(formula[2], rowDelta, {
                            formulaType: formulaAttributes.get("t") || null,
                        })}</f>`
                    )
                    .replace(/<v\b[^>]*>[\s\S]*?<\/v>/i, "")
            );
            continue;
        }
        if (/<f\b/i.test(sourceCell)) {
            throw new Error(
                `Cannot export SCSEM workbook: source formula ${sourceAddress} is self-closing or malformed and cannot be cloned safely.`
            );
        }
        targetOpening = targetOpening
            .replace(/\s+t="[^"]*"/g, "")
            .replace(/\s*\/?\s*>$/, "/>");
        cells.push(targetOpening);
    }
    return `${rowOpening}${cells.join("")}</row>`;
}

function materializeSparseTargetRowFromDonor(
    sheetXml: string,
    sourceZeroBasedRow: number,
    targetZeroBasedRow: number,
    throughColumn: number
): string {
    const sourceRow = rowXmlByNumber(sheetXml, sourceZeroBasedRow + 1);
    const targetNode = rowXmlNodeByNumber(sheetXml, targetZeroBasedRow + 1);
    if (!sourceRow || !targetNode) {
        throw new Error(
            `Cannot export SCSEM workbook: sparse-row donor/target ${sourceZeroBasedRow + 1}/${targetZeroBasedRow + 1} is missing.`
        );
    }
    let targetRow = targetNode.value;
    for (const sourceCell of sourceRow.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || []) {
        const sourceOpening = sourceCell.match(/^<c\b[^>]*\/?\s*>/)?.[0];
        const sourceAddress = sourceOpening ? xmlAttributes(sourceOpening).get("r") : null;
        if (!sourceOpening || !sourceAddress) {
            throw new Error("Cannot export SCSEM workbook: sparse-row donor has a malformed cell.");
        }
        const sourceDecoded = XLSX.utils.decode_cell(sourceAddress);
        if (sourceDecoded.c > throughColumn) continue;
        const targetAddress = XLSX.utils.encode_cell({ r: targetZeroBasedRow, c: sourceDecoded.c });
        const existing = findCellXml(targetRow, targetAddress);
        if (existing && /<f\b/i.test(existing.value)) continue;
        if (existing && rowXmlHasMaterialValue(`<row>${existing.value}</row>`)) {
            throw new Error(
                `Cannot export SCSEM workbook: sparse target cell ${targetAddress} contains template data.`
            );
        }
        const structuralCell = setXmlAttribute(sourceOpening, "r", targetAddress)
            .replace(/\s+t="[^"]*"/gi, "")
            .replace(/\s*\/?\s*>$/, "/>");
        targetRow = replaceOrInsertRowCell(targetRow, targetAddress, structuralCell);
    }
    return sheetXml.slice(0, targetNode.start) + targetRow + sheetXml.slice(targetNode.end);
}

function extendSqrefFeaturesForClonedRow(
    sheetXml: string,
    sourceZeroBasedRow: number,
    targetZeroBasedRow: number
): string {
    return sheetXml.replace(/<(?:conditionalFormatting|dataValidation)\b[^>]*>/gi, (opening) => {
        const sqref = xmlAttributes(opening).get("sqref");
        if (!sqref) return opening;
        const updated = sqref.split(/\s+/).map((token) => {
            if (!token || token.includes("$")) return token;
            const range = XLSX.utils.decode_range(token);
            if (range.e.r !== sourceZeroBasedRow || range.s.r > sourceZeroBasedRow) return token;
            range.e.r = targetZeroBasedRow;
            return XLSX.utils.encode_range(range);
        }).join(" ");
        return updated === sqref ? opening : setXmlAttribute(opening, "sqref", updated);
    });
}

function extendA1RangeTokenForAppendedRow(
    token: string,
    sourceExcelRow: number,
    targetExcelRow: number
): string {
    const match = token.match(
        /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})(?::(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6}))?$/
    );
    if (!match) {
        throw new Error(`Cannot export SCSEM workbook: unsupported append range reference ${token}.`);
    }
    const firstRow = Number(match[4]);
    const isRange = match[6] !== undefined;
    if (!isRange) {
        return firstRow === sourceExcelRow
            ? `${match[1]}${match[2]}${match[3]}${firstRow}:` +
                `${match[1]}${match[2]}${match[3]}${targetExcelRow}`
            : token;
    }
    const secondRow = Number(match[8]);
    if (secondRow !== sourceExcelRow) return token;
    return `${match[1]}${match[2]}${match[3]}${firstRow}:` +
        `${match[5]}${match[6]}${match[7]}${targetExcelRow}`;
}

function extendSqrefForAppendedRow(
    sqref: string,
    sourceExcelRow: number,
    targetExcelRow: number
): string {
    return sqref.split(/\s+/).map((token) =>
        token ? extendA1RangeTokenForAppendedRow(token, sourceExcelRow, targetExcelRow) : token
    ).join(" ");
}

function extendWorksheetFeaturesForAppendedRow(
    sheetXml: string,
    sheetName: string,
    sourceExcelRow: number,
    targetExcelRow: number,
    doNotExtend: ResolvedAddition["doNotExtendFeatureSqrefs"] = []
): string {
    const sqrefTags = new Set([
        "conditionalFormatting",
        "dataValidation",
        "protectedRange",
        "ignoredError",
    ]);
    let extended = sheetXml.replace(/<([\w:.-]+)\b[^>]*>/g, (opening, qualifiedTag: string) => {
        const localTag = qualifiedTag.split(":").at(-1)!;
        if (!sqrefTags.has(localTag)) return opening;
        const sqref = xmlAttributes(opening).get("sqref");
        if (!sqref) return opening;
        if (doNotExtend.some((exception) =>
            exception.tag === localTag && exception.sqref === sqref
        )) return opening;
        const translated = extendSqrefForAppendedRow(sqref, sourceExcelRow, targetExcelRow);
        return translated === sqref ? opening : setXmlAttribute(opening, "sqref", translated);
    });
    extended = extended.replace(
        /<(formula1|formula2|formula|xm:f)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
        (node, tag: string, attributes: string, formula: string) => {
            const translated = extendAppendedSCSEMFormulaRanges(
                formula,
                sourceExcelRow,
                targetExcelRow,
                { formulaSheet: sheetName, appendedSheet: sheetName }
            );
            return translated === formula ? node : `<${tag}${attributes}>${translated}</${tag}>`;
        }
    );
    extended = extended.replace(
        /<xm:sqref\b([^>]*)>([\s\S]*?)<\/xm:sqref>/gi,
        (node, attributes: string, sqref: string) => {
            const translated = extendSqrefForAppendedRow(sqref, sourceExcelRow, targetExcelRow);
            return translated === sqref ? node : `<xm:sqref${attributes}>${translated}</xm:sqref>`;
        }
    );
    return extended;
}

function extendWorksheetFormulaCellsForAppendedRow(
    sheetXml: string,
    formulaSheet: string,
    appendedSheet: string,
    sourceExcelRow: number,
    targetExcelRow: number
): string {
    const formulaSheetIsTarget = formulaSheet.trim().normalize("NFKC").toLocaleLowerCase("en-US") ===
        appendedSheet.trim().normalize("NFKC").toLocaleLowerCase("en-US");
    const sharedMasters = new Map<string, string[]>();
    for (const cellXml of sheetXml.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || []) {
        const match = cellXml.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
        if (!match) continue;
        const attributes = xmlAttributes(`<f${match[1]}>`);
        if (attributes.get("t") !== "shared") continue;
        const sharedIndex = attributes.get("si");
        if (!sharedIndex) continue;
        sharedMasters.set(sharedIndex, [...(sharedMasters.get(sharedIndex) || []), match[2]]);
    }
    return sheetXml.replace(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, (cellXml) => {
        const formula = cellXml.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
        if (!formula) {
            const selfClosing = cellXml.match(/<f\b([^>]*)\/>/i);
            if (!selfClosing) return cellXml;
            const attributes = xmlAttributes(`<f${selfClosing[1]}>`);
            const sharedIndex = attributes.get("si");
            const masters = sharedIndex ? sharedMasters.get(sharedIndex) || [] : [];
            if (attributes.get("t") !== "shared" || !sharedIndex || masters.length !== 1) {
                throw new Error("Cannot export SCSEM workbook: a self-closing formula has no unique shared master.");
            }
            if (!formulaSheetIsTarget && !hasExactSCSEMSheetQualifier(masters[0], appendedSheet)) {
                return cellXml;
            }
            const translatedMaster = extendAppendedSCSEMFormulaRanges(
                masters[0],
                sourceExcelRow,
                targetExcelRow,
                { formulaSheet, appendedSheet }
            );
            if (translatedMaster !== masters[0]) {
                throw new Error(
                    "Cannot export SCSEM workbook: an append-relevant shared formula requires compound-group handling."
                );
            }
            return cellXml;
        }
        if (!formulaSheetIsTarget && !hasExactSCSEMSheetQualifier(formula[2], appendedSheet)) {
            return cellXml;
        }
        const formulaAttributes = xmlAttributes(`<f${formula[1]}>`);
        const formulaType = formulaAttributes.get("t") || null;
        const translated = extendAppendedSCSEMFormulaRanges(
            formula[2],
            sourceExcelRow,
            targetExcelRow,
            { formulaSheet, appendedSheet }
        );
        if (translated === formula[2]) return cellXml;
        const cellOpening = cellXml.match(/^<c\b[^>]*>/i)?.[0] || "";
        const cellAddress = xmlAttributes(cellOpening).get("r") || null;
        const formulaRef = formulaAttributes.get("ref") || null;
        const isSingleCellArrayFormula = formulaType === "array" &&
            cellAddress !== null && formulaRef === cellAddress;
        // A legacy single-cell array formula has no compound spill/group range
        // to resize. Updating only its expression while retaining t="array" and
        // the exact single-cell ref is safe; multi-cell array/shared formulas
        // still require explicit workbook-level handling and remain blocked.
        const guardedTranslation = isSingleCellArrayFormula
            ? translated
            : extendAppendedSCSEMFormulaRanges(
                formula[2],
                sourceExcelRow,
                targetExcelRow,
                { formulaSheet, appendedSheet, formulaType }
            );
        return cellXml
            .replace(formula[0], `<f${formula[1]}>${guardedTranslation}</f>`)
            .replace(/<v\b[^>]*>[\s\S]*?<\/v>/gi, "")
            .replace(/<v\b[^>]*\/>/gi, "");
    });
}

function extendWorkbookDefinedNamesForAppendedRow(
    workbookXml: string,
    sheetNames: string[],
    appendedSheet: string,
    sourceExcelRow: number,
    targetExcelRow: number
): string {
    return workbookXml.replace(
        /<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/gi,
        (node, attributes: string, formula: string) => {
            const definedNameAttributes = xmlAttributes(`<definedName${attributes}>`);
            if (definedNameAttributes.get("name") === "_xlnm._FilterDatabase") return node;
            const localSheetId = definedNameAttributes.get("localSheetId");
            const formulaSheet = localSheetId === undefined
                ? "__workbook__"
                : sheetNames[Number(localSheetId)] || "__workbook__";
            const formulaSheetIsTarget = formulaSheet.trim().normalize("NFKC").toLocaleLowerCase("en-US") ===
                appendedSheet.trim().normalize("NFKC").toLocaleLowerCase("en-US");
            if (!formulaSheetIsTarget && !hasExactSCSEMSheetQualifier(formula, appendedSheet)) {
                return node;
            }
            const translated = extendAppendedSCSEMFormulaRanges(
                formula,
                sourceExcelRow,
                targetExcelRow,
                { formulaSheet, appendedSheet }
            );
            return translated === formula
                ? node
                : `<definedName${attributes}>${translated}</definedName>`;
        }
    );
}

function insertClonedBlankRow(
    sheetXml: string,
    sourceZeroBasedRow: number,
    targetZeroBasedRow: number
): string {
    const sourceExcelRow = sourceZeroBasedRow + 1;
    const targetExcelRow = targetZeroBasedRow + 1;
    if (rowXmlNodesByNumber(sheetXml, targetExcelRow).length > 0) {
        throw new Error(`Cannot export SCSEM workbook: clone target row ${targetExcelRow} already exists.`);
    }
    const sourceRows = rowXmlNodesByNumber(sheetXml, sourceExcelRow);
    if (sourceRows.length !== 1) {
        throw new Error(`Cannot export SCSEM workbook: clone source row ${sourceExcelRow} is not unique.`);
    }
    const touchingMerge = (sheetXml.match(/<mergeCell\b[^>]*\bref="([^"]+)"[^>]*\/>/gi) || [])
        .some((node) => {
            const ref = xmlAttributes(node).get("ref");
            if (!ref) return false;
            const range = XLSX.utils.decode_range(ref);
            return [sourceZeroBasedRow, targetZeroBasedRow].some((row) => row >= range.s.r && row <= range.e.r);
        });
    if (touchingMerge) {
        throw new Error("Cannot export SCSEM workbook: clone source/target row intersects a merged range.");
    }
    const clonedRow = clonedBlankRowXml(sourceRows[0].value, sourceExcelRow, targetExcelRow);
    const followingRow = [...sheetXml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/row>)/g)]
        .find((match) => Number(match[1]) > targetExcelRow);
    const insertAt = followingRow?.index ?? sheetXml.indexOf("</sheetData>");
    if (insertAt === undefined || insertAt < 0) {
        throw new Error("Cannot export SCSEM workbook: worksheet sheetData is malformed.");
    }
    const withRow = sheetXml.slice(0, insertAt) + clonedRow + sheetXml.slice(insertAt);
    return extendSqrefFeaturesForClonedRow(withRow, sourceZeroBasedRow, targetZeroBasedRow);
}

const EXCEL_MAX_ROW = 1_048_576;
const EXCEL_MAX_COLUMN = 16_383;

function shiftA1RangeTokenForInsertedRow(
    token: string,
    insertionExcelRow: number,
    extendRangeEndingBeforeInsertion: boolean
): string {
    const match = token.match(
        /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})(?::(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6}))?$/
    );
    if (!match) {
        throw new Error(`Cannot export SCSEM workbook: unsupported worksheet range reference ${token}.`);
    }
    const firstColumn = XLSX.utils.decode_col(match[2].toUpperCase());
    const secondColumn = XLSX.utils.decode_col((match[6] || match[2]).toUpperCase());
    let firstRow = Number(match[4]);
    let secondRow = Number(match[8] || match[4]);
    if (
        firstColumn < 0 || firstColumn > 16_383 ||
        secondColumn < 0 || secondColumn > 16_383 ||
        firstRow < 1 || firstRow > EXCEL_MAX_ROW ||
        secondRow < 1 || secondRow > EXCEL_MAX_ROW
    ) {
        throw new Error(`Cannot export SCSEM workbook: worksheet range ${token} is outside Excel limits.`);
    }

    const isRange = match[6] !== undefined;
    if (!isRange) {
        if (firstRow >= insertionExcelRow) {
            if (firstRow === EXCEL_MAX_ROW) {
                throw new Error(`Cannot export SCSEM workbook: worksheet reference ${token} would exceed Excel row limits.`);
            }
            firstRow++;
        } else if (extendRangeEndingBeforeInsertion && firstRow === insertionExcelRow - 1) {
            return `${match[1]}${match[2]}${match[3]}${firstRow}:` +
                `${match[1]}${match[2]}${match[3]}${firstRow + 1}`;
        }
        return `${match[1]}${match[2]}${match[3]}${firstRow}`;
    }

    if (firstRow >= insertionExcelRow) {
        if (firstRow === EXCEL_MAX_ROW) {
            throw new Error(`Cannot export SCSEM workbook: worksheet range ${token} would exceed Excel row limits.`);
        }
        firstRow++;
        if (secondRow < EXCEL_MAX_ROW) secondRow++;
    } else if (secondRow >= insertionExcelRow) {
        if (secondRow < EXCEL_MAX_ROW) secondRow++;
    } else if (extendRangeEndingBeforeInsertion && secondRow === insertionExcelRow - 1) {
        secondRow++;
    }

    return `${match[1]}${match[2]}${match[3]}${firstRow}:` +
        `${match[5]}${match[6]}${match[7]}${secondRow}`;
}

function shiftSqrefForInsertedRow(
    sqref: string,
    insertionExcelRow: number,
    extendRangeEndingBeforeInsertion: boolean
): string {
    return sqref.split(/\s+/).map((token) =>
        token
            ? shiftA1RangeTokenForInsertedRow(
                token,
                insertionExcelRow,
                extendRangeEndingBeforeInsertion
            )
            : token
    ).join(" ");
}

function translateWorksheetFormulaCellsForInsertedRow(
    sheetXml: string,
    formulaSheet: string,
    insertedSheet: string,
    insertionExcelRow: number
): string {
    const formulaSheetIsTarget = formulaSheet.trim().normalize("NFKC").toLocaleLowerCase("en-US") ===
        insertedSheet.trim().normalize("NFKC").toLocaleLowerCase("en-US");
    return sheetXml.replace(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, (cellXml) => {
        const formula = cellXml.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
        if (!formula) return cellXml;
        // A formula on another worksheet can only be affected by this insertion
        // when it explicitly qualifies the inserted sheet. Besides avoiding
        // unnecessary rewrites, this keeps unrelated pre-existing external or
        // structured references outside the surgical translator's fail-closed
        // path while references to the target sheet remain fully validated.
        if (!formulaSheetIsTarget && !hasExactSCSEMSheetQualifier(formula[2], insertedSheet)) {
            return cellXml;
        }
        const translated = translateInsertedSCSEMFormula(formula[2], insertionExcelRow, {
            formulaSheet,
            insertedSheet,
            extendRangesEndingBeforeInsertion: true,
        });
        if (translated === formula[2]) return cellXml;
        const formulaType = xmlAttributes(`<f${formula[1]}>`).get("t") || null;
        const guardedTranslation = translateInsertedSCSEMFormula(formula[2], insertionExcelRow, {
            formulaSheet,
            insertedSheet,
            extendRangesEndingBeforeInsertion: true,
            formulaType,
        });
        return cellXml
            .replace(formula[0], `<f${formula[1]}>${guardedTranslation}</f>`)
            .replace(/<v\b[^>]*>[\s\S]*?<\/v>/i, "");
    });
}

function shiftWorksheetRowsForInsertedRow(
    sheetXml: string,
    insertionExcelRow: number
): string {
    return sheetXml.replace(/<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g, (rowXml) => {
        const opening = rowXml.match(/^<row\b[^>]*>/)?.[0] || rowXml;
        const row = Number(xmlAttributes(opening).get("r"));
        if (!Number.isSafeInteger(row) || row < insertionExcelRow) return rowXml;
        if (row >= EXCEL_MAX_ROW) {
            if (rowXmlHasMaterialValue(rowXml)) {
                throw new Error("Cannot export SCSEM workbook: inserted worksheet row would exceed Excel row limits.");
            }
            // Excel cannot shift a style-only terminal row beyond 1,048,576.
            // Keeping that empty formatting row in place is lossless while the
            // audited insertion occurs hundreds of rows above it.
            return rowXml;
        }
        let shifted = rowXml.replace(opening, setXmlAttribute(opening, "r", String(row + 1)));
        shifted = shifted.replace(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, (cellXml) => {
            const cellOpening = cellXml.match(/^<c\b[^>]*>/)?.[0] || cellXml;
            const address = xmlAttributes(cellOpening).get("r");
            if (!address) {
                throw new Error(`Cannot export SCSEM workbook: row ${row} has a cell without an address.`);
            }
            const decoded = XLSX.utils.decode_cell(address);
            if (decoded.r !== row - 1) {
                throw new Error(`Cannot export SCSEM workbook: cell ${address} does not match its worksheet row.`);
            }
            if (/<f\b/i.test(cellXml)) {
                const pairedFormula = cellXml.match(/<f\b([^>]*)>[\s\S]*?<\/f>/i);
                const formulaType = pairedFormula
                    ? xmlAttributes(`<f${pairedFormula[1]}>`).get("t") || null
                    : "self-closing";
                if (formulaType) {
                    throw new Error(
                        `Cannot export SCSEM workbook: shifted formula ${address} uses an unsupported ${formulaType} formula.`
                    );
                }
            }
            const targetAddress = XLSX.utils.encode_cell({ r: decoded.r + 1, c: decoded.c });
            return cellXml.replace(cellOpening, setXmlAttribute(cellOpening, "r", targetAddress));
        });
        return shifted;
    });
}

function shiftWorksheetFeaturesForInsertedRow(
    sheetXml: string,
    sheetName: string,
    insertionExcelRow: number
): string {
    const refTags = new Set([
        "dimension",
        "autoFilter",
        "mergeCell",
        "hyperlink",
        "sortState",
        "sortCondition",
    ]);
    const sqrefTags = new Set([
        "conditionalFormatting",
        "dataValidation",
        "protectedRange",
        "ignoredError",
        "selection",
    ]);
    let shifted = sheetXml.replace(/<([\w:.-]+)\b[^>]*>/g, (opening, qualifiedTag: string) => {
        const localTag = qualifiedTag.split(":").at(-1)!;
        if (refTags.has(localTag)) {
            const ref = xmlAttributes(opening).get("ref");
            if (!ref) return opening;
            const extend = localTag === "autoFilter" || localTag === "dimension";
            return setXmlAttribute(
                opening,
                "ref",
                shiftSqrefForInsertedRow(ref, insertionExcelRow, extend)
            );
        }
        if (sqrefTags.has(localTag)) {
            const sqref = xmlAttributes(opening).get("sqref");
            if (!sqref) return opening;
            const extend = localTag === "conditionalFormatting" ||
                localTag === "dataValidation" ||
                localTag === "protectedRange" ||
                localTag === "ignoredError";
            return setXmlAttribute(
                opening,
                "sqref",
                shiftSqrefForInsertedRow(sqref, insertionExcelRow, extend)
            );
        }
        if (localTag === "pane") {
            const topLeftCell = xmlAttributes(opening).get("topLeftCell");
            return topLeftCell
                ? setXmlAttribute(
                    opening,
                    "topLeftCell",
                    shiftA1RangeTokenForInsertedRow(topLeftCell, insertionExcelRow, false)
                )
                : opening;
        }
        return opening;
    });

    shifted = shifted.replace(
        /<(formula1|formula2|formula|xm:f)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
        (node, tag: string, attributes: string, formula: string) => {
            const translated = translateInsertedSCSEMFormula(formula, insertionExcelRow, {
                formulaSheet: sheetName,
                insertedSheet: sheetName,
                extendRangesEndingBeforeInsertion: true,
            });
            return translated === formula ? node : `<${tag}${attributes}>${translated}</${tag}>`;
        }
    );
    shifted = shifted.replace(/<xm:sqref\b([^>]*)>([\s\S]*?)<\/xm:sqref>/gi, (node, attributes, sqref) => {
        const translated = shiftSqrefForInsertedRow(sqref, insertionExcelRow, true);
        return translated === sqref ? node : `<xm:sqref${attributes}>${translated}</xm:sqref>`;
    });
    return shifted;
}

function insertClonedRowBeforeFooter(
    sheetXml: string,
    sourceZeroBasedRow: number,
    targetZeroBasedRow: number,
    sheetName: string,
    allowedTargetMergeRefs: string[] = []
): { xml: string; clonedFormulaAddresses: Array<{ source: string; target: string }> } {
    const sourceExcelRow = sourceZeroBasedRow + 1;
    const targetExcelRow = targetZeroBasedRow + 1;
    const sourceRows = rowXmlNodesByNumber(sheetXml, sourceExcelRow);
    const footerRows = rowXmlNodesByNumber(sheetXml, targetExcelRow);
    if (sourceRows.length !== 1 || footerRows.length !== 1) {
        throw new Error(
            `Cannot export SCSEM workbook: footer insertion rows ${sourceExcelRow}/${targetExcelRow} are not unique.`
        );
    }
    const unsupportedTouchingMerge = (sheetXml.match(/<mergeCell\b[^>]*\bref="([^"]+)"[^>]*\/>/gi) || [])
        .some((node) => {
            const ref = xmlAttributes(node).get("ref");
            if (!ref) return false;
            const range = XLSX.utils.decode_range(ref);
            const touchesSource = sourceZeroBasedRow >= range.s.r && sourceZeroBasedRow <= range.e.r;
            if (touchesSource) return true;
            const touchesTarget = targetZeroBasedRow >= range.s.r && targetZeroBasedRow <= range.e.r;
            if (!touchesTarget) return false;
            return range.s.r !== targetZeroBasedRow ||
                range.e.r !== targetZeroBasedRow ||
                !allowedTargetMergeRefs.includes(ref);
        });
    if (unsupportedTouchingMerge) {
        throw new Error("Cannot export SCSEM workbook: initial footer insertion intersects a merged range.");
    }

    const clonedRow = clonedBlankRowXml(sourceRows[0].value, sourceExcelRow, targetExcelRow);
    const clonedFormulaAddresses = (sourceRows[0].value.match(
        /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g
    ) || []).flatMap((cellXml) => {
        if (!/<f\b/i.test(cellXml)) return [];
        const opening = cellXml.match(/^<c\b[^>]*>/)?.[0] || cellXml;
        const source = xmlAttributes(opening).get("r");
        if (!source) {
            throw new Error("Cannot export SCSEM workbook: cloned formula cell is missing its address.");
        }
        const decoded = XLSX.utils.decode_cell(source);
        return [{
            source,
            target: XLSX.utils.encode_cell({ r: targetExcelRow - 1, c: decoded.c }),
        }];
    });

    let transformed = translateWorksheetFormulaCellsForInsertedRow(
        sheetXml,
        sheetName,
        sheetName,
        targetExcelRow
    );
    transformed = shiftWorksheetRowsForInsertedRow(transformed, targetExcelRow);
    transformed = shiftWorksheetFeaturesForInsertedRow(transformed, sheetName, targetExcelRow);
    const shiftedFooter = rowXmlNodeByNumber(transformed, targetExcelRow + 1);
    if (!shiftedFooter || rowXmlNodesByNumber(transformed, targetExcelRow).length !== 0) {
        throw new Error("Cannot export SCSEM workbook: footer row shift did not create one insertion row.");
    }
    transformed = transformed.slice(0, shiftedFooter.start) + clonedRow + transformed.slice(shiftedFooter.start);
    return { xml: transformed, clonedFormulaAddresses };
}

function translateWorkbookDefinedNamesForInsertedRow(
    workbookXml: string,
    sheetNames: string[],
    insertedSheet: string,
    insertionExcelRow: number
): string {
    return workbookXml.replace(
        /<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/gi,
        (node, attributes: string, formula: string) => {
            const localSheetId = xmlAttributes(`<definedName${attributes}>`).get("localSheetId");
            const formulaSheet = localSheetId === undefined
                ? "__workbook__"
                : sheetNames[Number(localSheetId)] || "__workbook__";
            const formulaSheetIsTarget = formulaSheet.trim().normalize("NFKC").toLocaleLowerCase("en-US") ===
                insertedSheet.trim().normalize("NFKC").toLocaleLowerCase("en-US");
            if (!formulaSheetIsTarget && !hasExactSCSEMSheetQualifier(formula, insertedSheet)) {
                return node;
            }
            const translated = translateInsertedSCSEMFormula(formula, insertionExcelRow, {
                formulaSheet,
                insertedSheet,
                extendRangesEndingBeforeInsertion: true,
            });
            return translated === formula
                ? node
                : `<definedName${attributes}>${translated}</definedName>`;
        }
    );
}

function sheetIdForName(workbookXml: string, sheetName: string): string {
    const matching = (workbookXml.match(/<sheet\b[^>]*\/>/g) || [])
        .filter((node) => xmlAttributes(node).get("name") === sheetName);
    if (matching.length !== 1) {
        throw new Error(`Cannot export SCSEM workbook: sheet ID for ${sheetName} is ambiguous or missing.`);
    }
    const sheetId = xmlAttributes(matching[0]).get("sheetId");
    if (!sheetId) throw new Error(`Cannot export SCSEM workbook: sheet ID for ${sheetName} is missing.`);
    return sheetId;
}

function shiftCalcChainForInsertedRow(
    calcChainXml: string,
    targetSheetId: string,
    insertionExcelRow: number,
    clonedFormulaAddresses: Array<{ source: string; target: string }>
): string {
    let activeSheetId: string | null = null;
    let shifted = calcChainXml.replace(/<c\b[^>]*\/>/g, (node) => {
        const attributes = xmlAttributes(node);
        if (attributes.has("i")) activeSheetId = attributes.get("i") || null;
        if (activeSheetId !== targetSheetId) return node;
        const address = attributes.get("r");
        if (!address) throw new Error("Cannot export SCSEM workbook: calcChain entry is missing its cell reference.");
        const decoded = XLSX.utils.decode_cell(address);
        if (decoded.r + 1 < insertionExcelRow) return node;
        if (decoded.r + 1 >= EXCEL_MAX_ROW) {
            throw new Error("Cannot export SCSEM workbook: calcChain row would exceed Excel limits.");
        }
        return setXmlAttribute(
            node,
            "r",
            XLSX.utils.encode_cell({ r: decoded.r + 1, c: decoded.c })
        );
    });

    for (const clone of clonedFormulaAddresses) {
        activeSheetId = null;
        const candidates: XmlNodeMatch[] = [];
        const matcher = /<c\b[^>]*\/>/g;
        let match: RegExpExecArray | null;
        while ((match = matcher.exec(shifted))) {
            const attributes = xmlAttributes(match[0]);
            if (attributes.has("i")) activeSheetId = attributes.get("i") || null;
            if (activeSheetId === targetSheetId && attributes.get("r") === clone.source) {
                candidates.push({ start: match.index, end: match.index + match[0].length, value: match[0] });
            }
        }
        if (candidates.length !== 1) {
            throw new Error(
                `Cannot export SCSEM workbook: calcChain source ${clone.source} is missing or ambiguous.`
            );
        }
        let clonedNode = setXmlAttribute(candidates[0].value, "r", clone.target);
        clonedNode = setXmlAttribute(clonedNode, "i", targetSheetId);
        shifted = shifted.slice(0, candidates[0].end) + clonedNode + shifted.slice(candidates[0].end);
    }
    return shifted;
}

function addExplicitRiskFormulaCalcChain(
    calcChainXml: string,
    targetSheetId: string,
    targetAddress: string,
    sourceAddress?: string,
    expectedSourceCount?: number
): string {
    let activeSheetId: string | null = null;
    const targetNodes: XmlNodeMatch[] = [];
    const sourceNodes: XmlNodeMatch[] = [];
    const matcher = /<c\b[^>]*\/>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(calcChainXml))) {
        const attributes = xmlAttributes(match[0]);
        if (attributes.has("i")) activeSheetId = attributes.get("i") || null;
        if (activeSheetId !== targetSheetId) continue;
        const address = attributes.get("r");
        const node = { start: match.index, end: match.index + match[0].length, value: match[0] };
        if (address === targetAddress) targetNodes.push(node);
        if (sourceAddress && address === sourceAddress) sourceNodes.push(node);
    }
    if (targetNodes.length > 0) {
        throw new Error(
            `Cannot export SCSEM workbook: calcChain target ${targetAddress} already exists.`
        );
    }
    if (sourceAddress) {
        if (sourceNodes.length !== expectedSourceCount) {
            throw new Error(
                `Cannot export SCSEM workbook: calcChain source ${sourceAddress} count does not match its pinned profile.`
            );
        }
        const cloned = sourceNodes.map((node) =>
            setXmlAttribute(setXmlAttribute(node.value, "r", targetAddress), "i", targetSheetId)
        ).join("");
        const insertAt = sourceNodes.at(-1)!.end;
        return calcChainXml.slice(0, insertAt) + cloned + calcChainXml.slice(insertAt);
    }
    const closing = calcChainXml.lastIndexOf("</calcChain>");
    if (closing < 0) throw new Error("Cannot export SCSEM workbook: calcChain XML is malformed.");
    return calcChainXml.slice(0, closing) +
        `<c r="${targetAddress}" i="${targetSheetId}"/>` +
        calcChainXml.slice(closing);
}

function replaceOrInsertRowCell(rowXml: string, address: string, cellXml: string): string {
    const expandedRow = /\/\>\s*$/.test(rowXml)
        ? rowXml.replace(/\/\>\s*$/, "></row>")
        : rowXml;
    const existing = findCellXml(expandedRow, address);
    if (existing) {
        return expandedRow.slice(0, existing.start) + cellXml + expandedRow.slice(existing.end);
    }

    const closingIndex = expandedRow.lastIndexOf("</row>");
    if (closingIndex < 0) throw new Error(`Cannot export SCSEM workbook: row for ${address} is malformed.`);
    const targetCol = cellColumn(address);
    let insertAt = closingIndex;
    const matcher = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(expandedRow))) {
        const opening = match[0].match(/^<c\b[^>]*>/)?.[0] || match[0];
        const existingAddress = xmlAttributes(opening).get("r");
        if (existingAddress && cellColumn(existingAddress) > targetCol) {
            insertAt = match.index;
            break;
        }
    }
    return expandedRow.slice(0, insertAt) + cellXml + expandedRow.slice(insertAt);
}

function logCellXml(
    address: string,
    value: string | number,
    sourceCell: string | null
): string {
    const openingTag = sourceCell?.match(/^<c\b([^>]*)\/?\s*>/)?.[1] || "";
    let attributes = openingTag
        .replace(/\s+r="[^"]*"/g, "")
        .replace(/\s+t="[^"]*"/g, "")
        .replace(/\/\s*$/, "")
        .trim();
    attributes = attributes ? ` ${attributes}` : "";

    if (typeof value === "number") {
        return `<c r="${address}"${attributes} t="n"><v>${value}</v></c>`;
    }
    return inlineStringCellXml(address, value, `<c r="${address}"${attributes}/>`);
}

function updateDimensionForRow(sheetXml: string, excelRow: number): string {
    return sheetXml.replace(/<dimension\b([^>]*)\bref="([^"]+)"([^>]*)\/>/, (node, before, ref, after) => {
        const range = XLSX.utils.decode_range(ref);
        if (excelRow - 1 <= range.e.r) return node;
        range.e.r = excelRow - 1;
        return `<dimension${before}ref="${XLSX.utils.encode_range(range)}"${after}/>`;
    });
}

function appendChangeLogXml(
    sheetXml: string,
    readWorksheet: XLSX.WorkSheet,
    entry: ChangeLogEntry
): string {
    const header = findLogHeader(readWorksheet);
    if (!header) return sheetXml;

    const endCol = Math.max(header.range.e.c, ...header.columns.values());
    const firstDataRow = header.headerRow + 1;
    const lastDataRow = lastNonEmptyRow(
        readWorksheet,
        firstDataRow,
        header.range.e.r,
        header.range.s.c,
        endCol
    );
    let appendRow = Math.max(lastDataRow + 1, firstDataRow);
    let existingAppendRow = rowXmlNodeByNumber(sheetXml, appendRow + 1);
    while (existingAppendRow && rowXmlHasMaterialValue(existingAppendRow.value)) {
        appendRow++;
        existingAppendRow = rowXmlNodeByNumber(sheetXml, appendRow + 1);
    }
    const sourceRow = Math.max(lastDataRow, firstDataRow);
    const sourceRowXml = rowXmlByNumber(sheetXml, sourceRow + 1);
    const styleRowXml = existingAppendRow?.value || sourceRowXml;
    const sourceOpening = styleRowXml?.match(/^<row\b([^>]*)\/?>/)?.[1] || "";
    let rowAttributes = sourceOpening
        .replace(/\s+r="[^"]*"/g, "")
        .replace(/\s+spans="[^"]*"/g, "")
        .trim();
    rowAttributes = rowAttributes ? ` ${rowAttributes}` : "";

    const values: Partial<Record<LogField, string | number>> = {
        version: entry.version,
        date: excelDateSerial(entry.changeDate),
        description: entry.description,
        author: entry.changedBy || "",
        source: entry.source,
        target: entry.details?.map((detail) => detail.target).join("; ") || "Approved SCSEM updater changes",
    };
    const cells: Array<{ address: string; xml: string }> = [];
    for (const [field, col] of header.columns) {
        const value = values[field];
        if (value === undefined) continue;
        const address = XLSX.utils.encode_cell({ r: appendRow, c: col });
        const sourceAddress = XLSX.utils.encode_cell({ r: sourceRow, c: col });
        const existingCell = existingAppendRow
            ? findCellXml(existingAppendRow.value, address)?.value || null
            : null;
        const sourceCell = existingCell ||
            (sourceRowXml ? findCellXml(sourceRowXml, sourceAddress)?.value || null : null);
        cells.push({ address, xml: logCellXml(address, value, sourceCell) });
    }
    if (cells.length === 0) return sheetXml;

    if (existingAppendRow) {
        let rowXml = existingAppendRow.value;
        for (const cell of cells) {
            rowXml = replaceOrInsertRowCell(rowXml, cell.address, cell.xml);
        }
        const withUpdatedRow = sheetXml.slice(0, existingAppendRow.start) +
            rowXml +
            sheetXml.slice(existingAppendRow.end);
        return updateDimensionForRow(withUpdatedRow, appendRow + 1);
    }

    const rowXml = `<row r="${appendRow + 1}"${rowAttributes}>${cells.map((cell) => cell.xml).join("")}</row>`;
    const sheetDataClose = sheetXml.indexOf("</sheetData>");
    if (sheetDataClose < 0) return sheetXml;

    const withRow = sheetXml.slice(0, sheetDataClose) + rowXml + sheetXml.slice(sheetDataClose);
    return updateDimensionForRow(withRow, appendRow + 1);
}

async function assertRawPlanSafety(
    zip: JSZip,
    pathsByName: Map<string, string>,
    plan: ApprovedChangePlan
): Promise<void> {
    const sheetXmlByName = new Map<string, string>();
    for (const operation of [...plan.updates, ...plan.additions]) {
        if (sheetXmlByName.has(operation.sheetName)) continue;
        const worksheetPath = pathsByName.get(operation.sheetName);
        const sheetXml = worksheetPath ? await zip.file(worksheetPath)?.async("string") : null;
        if (!worksheetPath || !sheetXml) {
            throw approvedChangeError(operation.change, `worksheet XML for ${operation.sheetName} is missing`);
        }
        if (worksheetProtectionEnabled(sheetXml)) {
            throw approvedChangeError(operation.change, `target sheet ${operation.sheetName} is protected`);
        }
        sheetXmlByName.set(operation.sheetName, sheetXml);
    }

    for (const operation of plan.updates) {
        const sheetXml = sheetXmlByName.get(operation.sheetName)!;
        const cell = findCellXml(sheetXml, operation.address);
        if (cell && /<f\b/i.test(cell.value)) {
            throw approvedChangeError(
                operation.change,
                `target cell ${operation.sheetName}!${operation.address} contains a formula`
            );
        }
    }

    for (const operation of plan.additions) {
        const sheetXml = sheetXmlByName.get(operation.sheetName)!;
        if (/<tableParts\b/i.test(sheetXml)) {
            throw approvedChangeError(
                operation.change,
                `target sheet ${operation.sheetName} uses a structured table; surgical add-control export is unsupported`
            );
        }
        const excelRow = operation.row + 1;
        const matchingRows = rowXmlNodesByNumber(sheetXml, excelRow);
        let rowXml: string;
        if (operation.insertBeforeFooter) {
            if (matchingRows.length !== 1 || operation.cloneSourceRow === undefined) {
                throw approvedChangeError(
                    operation.change,
                    `canonical insertion footer row ${operation.sheetName}!${excelRow} is missing or ambiguous`
                );
            }
            const footerOpening = matchingRows[0].value.match(/^<row\b[^>]*>/)?.[0] || matchingRows[0].value;
            const footerHidden = xmlAttributes(footerOpening).get("hidden")?.toLowerCase();
            if (
                (footerHidden === "1" || footerHidden === "true") &&
                !operation.allowHiddenStructuralFooter
            ) {
                throw approvedChangeError(
                    operation.change,
                    `canonical insertion footer row ${operation.sheetName}!${excelRow} is hidden`
                );
            }
            const targetMergeRefs = (sheetXml.match(/<mergeCell\b[^>]*\bref="([^"]+)"[^>]*\/>/gi) || [])
                .map((node) => xmlAttributes(node).get("ref"))
                .filter((ref): ref is string => Boolean(ref))
                .filter((ref) => {
                    const range = XLSX.utils.decode_range(ref);
                    return operation.row >= range.s.r && operation.row <= range.e.r;
                })
                .sort();
            const expectedTargetMergeRefs = [...(operation.allowedTargetMergeRefs || [])].sort();
            if (
                targetMergeRefs.length !== expectedTargetMergeRefs.length ||
                targetMergeRefs.some((ref, index) => ref !== expectedTargetMergeRefs[index])
            ) {
                throw approvedChangeError(
                    operation.change,
                    `structural insertion merge profile at ${operation.sheetName}!${excelRow} does not match the pinned source`
                );
            }
            if (operation.blankStructuralFooter) {
                if (/<f\b/i.test(matchingRows[0].value) || rowXmlHasMaterialValue(matchingRows[0].value)) {
                    throw approvedChangeError(
                        operation.change,
                        `blank structural separator at ${operation.sheetName}!${excelRow} is malformed`
                    );
                }
            } else {
                const footerCell = operation.footerCellAddress
                    ? findCellXml(matchingRows[0].value, operation.footerCellAddress)
                    : null;
                if (!footerCell || /<f\b/i.test(footerCell.value) || !rowXmlHasNonFormulaMaterialValue(matchingRows[0].value)) {
                    throw approvedChangeError(
                        operation.change,
                        `canonical insertion footer at ${operation.sheetName}!${excelRow} is malformed`
                    );
                }
            }
            const sourceRowXml = rowXmlByNumber(sheetXml, operation.cloneSourceRow + 1);
            if (!sourceRowXml) {
                throw approvedChangeError(
                    operation.change,
                    `footer insertion source row ${operation.sheetName}!${operation.cloneSourceRow + 1} is missing`
                );
            }
            const sourceOpening = sourceRowXml.match(/^<row\b[^>]*>/)?.[0] || sourceRowXml;
            const sourceHidden = xmlAttributes(sourceOpening).get("hidden")?.toLowerCase();
            if (
                (sourceHidden === "1" || sourceHidden === "true") &&
                !operation.allowHiddenCloneSource
            ) {
                throw approvedChangeError(
                    operation.change,
                    `footer insertion source row ${operation.sheetName}!${operation.cloneSourceRow + 1} is hidden`
                );
            }
            try {
                rowXml = clonedBlankRowXml(
                    sourceRowXml,
                    operation.cloneSourceRow + 1,
                    excelRow
                );
            } catch (error) {
                throw approvedChangeError(
                    operation.change,
                    error instanceof Error ? error.message : String(error)
                );
            }
        } else if (matchingRows.length === 0 && operation.cloneSourceRow !== undefined) {
            try {
                const preview = insertClonedBlankRow(sheetXml, operation.cloneSourceRow, operation.row);
                rowXml = rowXmlByNumber(preview, excelRow)!;
            } catch (error) {
                throw approvedChangeError(
                    operation.change,
                    error instanceof Error ? error.message : String(error)
                );
            }
        } else if (matchingRows.length !== 1) {
            throw approvedChangeError(
                operation.change,
                matchingRows.length === 0
                    ? `no pre-styled blank row is available at ${operation.sheetName}!${excelRow}`
                    : `target sheet ${operation.sheetName} has duplicate row ${excelRow}`
            );
        } else {
            rowXml = matchingRows[0].value;
        }
        if (operation.materializeSparseRowFrom !== undefined) {
            try {
                const preview = materializeSparseTargetRowFromDonor(
                    sheetXml,
                    operation.materializeSparseRowFrom,
                    operation.row,
                    operation.materializeSparseThroughColumn ?? EXCEL_MAX_COLUMN
                );
                rowXml = rowXmlByNumber(preview, excelRow)!;
            } catch (error) {
                throw approvedChangeError(
                    operation.change,
                    error instanceof Error ? error.message : String(error)
                );
            }
        }
        const rowOpening = rowXml.match(/^<row\b[^>]*>/)?.[0] || rowXml;
        const hidden = xmlAttributes(rowOpening).get("hidden")?.toLowerCase();
        if (hidden === "1" || hidden === "true") {
            throw approvedChangeError(
                operation.change,
                `pre-styled blank row ${operation.sheetName}!${excelRow} is hidden`
            );
        }
        if (rowXmlHasNonFormulaMaterialValue(rowXml)) {
            throw approvedChangeError(
                operation.change,
                `row ${operation.sheetName}!${excelRow} is not blank; refusing to overwrite template content`
            );
        }
        const dimensionRef = sheetXml.match(/<dimension\b[^>]*\bref="([^"]+)"/i)?.[1];
        if (!dimensionRef || operation.row > XLSX.utils.decode_range(dimensionRef).e.r) {
            throw approvedChangeError(
                operation.change,
                `pre-styled blank row ${operation.sheetName}!${excelRow} is outside the worksheet dimension`
            );
        }
        for (const address of operation.cells.keys()) {
            const cell = findCellXml(rowXml, address);
            if (!cell) {
                throw approvedChangeError(
                    operation.change,
                    `pre-styled blank-row cell ${operation.sheetName}!${address} is missing`
                );
            }
            if (/<f\b/i.test(cell.value)) {
                throw approvedChangeError(
                    operation.change,
                    `pre-styled blank-row cell ${operation.sheetName}!${address} contains a formula`
                );
            }
        }
        for (const address of operation.assessmentCells) {
            const cell = findCellXml(rowXml, address);
            if (cell && /<f\b/i.test(cell.value)) {
                throw approvedChangeError(
                    operation.change,
                    `pre-styled blank-row agency assessment cell ${operation.sheetName}!${address} contains a formula`
                );
            }
        }
        try {
            assertAdditionRiskFormula(sheetXml, rowXml, operation);
        } catch (error) {
            throw approvedChangeError(
                operation.change,
                error instanceof Error ? error.message : String(error)
            );
        }
    }
}

async function applyFooterInsertionSurgically(
    zip: JSZip,
    pathsByName: Map<string, string>,
    readWorkbook: XLSX.WorkBook,
    operation: ResolvedAddition
): Promise<void> {
    if (!operation.insertBeforeFooter || operation.cloneSourceRow === undefined) return;
    const insertionExcelRow = operation.row + 1;
    let clonedFormulaAddresses: Array<{ source: string; target: string }> = [];

    for (const [sheetName, worksheetPath] of pathsByName) {
        const originalXml = await zip.file(worksheetPath)?.async("string");
        if (!originalXml) {
            throw approvedChangeError(operation.change, `worksheet XML for ${sheetName} is missing`);
        }
        let updatedXml: string;
        if (sheetName === operation.sheetName) {
            const inserted = insertClonedRowBeforeFooter(
                originalXml,
                operation.cloneSourceRow,
                operation.row,
                operation.sheetName,
                operation.allowedTargetMergeRefs
            );
            updatedXml = inserted.xml;
            clonedFormulaAddresses = inserted.clonedFormulaAddresses;
            if (operation.materializeRiskFormula) {
                const riskColumn = XLSX.utils.decode_cell(operation.riskRatingAddress).c;
                const sourceAddress = XLSX.utils.encode_cell({
                    r: operation.riskFormulaSourceRow,
                    c: riskColumn,
                });
                updatedXml = materializeCopiedOrdinaryFormulaAtAddress(
                    updatedXml,
                    sourceAddress,
                    operation.riskRatingAddress
                );
                clonedFormulaAddresses.push({
                    source: sourceAddress,
                    target: operation.riskRatingAddress,
                });
            }
        } else {
            updatedXml = translateWorksheetFormulaCellsForInsertedRow(
                originalXml,
                sheetName,
                operation.sheetName,
                insertionExcelRow
            );
        }
        if (updatedXml !== originalXml) {
            zip.file(worksheetPath, updatedXml, { createFolders: false });
        }
    }

    let workbookXml = await zip.file("xl/workbook.xml")?.async("string");
    if (!workbookXml) throw new Error("Cannot export SCSEM workbook: workbook XML is missing.");
    const targetSheetId = sheetIdForName(workbookXml, operation.sheetName);
    workbookXml = translateWorkbookDefinedNamesForInsertedRow(
        workbookXml,
        readWorkbook.SheetNames,
        operation.sheetName,
        insertionExcelRow
    );
    zip.file("xl/workbook.xml", workbookXml, { createFolders: false });

    const calcChainFile = zip.file("xl/calcChain.xml");
    if (calcChainFile) {
        const calcChainXml = await calcChainFile.async("string");
        zip.file(
            "xl/calcChain.xml",
            shiftCalcChainForInsertedRow(
                calcChainXml,
                targetSheetId,
                insertionExcelRow,
                clonedFormulaAddresses
            ),
            { createFolders: false }
        );
    }
}

function replaceExactOrdinaryFormulaAtAddress(
    sheetXml: string,
    address: string,
    formula: string
): string {
    const cell = findCellXml(sheetXml, address);
    if (!cell) throw new Error(`Cannot export SCSEM workbook: repair formula cell ${address} is missing.`);
    const paired = cell.value.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
    if (!paired || xmlAttributes(`<f${paired?.[1] || ""}>`).get("t")) {
        throw new Error(`Cannot export SCSEM workbook: repair formula ${address} is not paired ordinary OOXML.`);
    }
    const opening = cell.value.match(/^<c\b[^>]*>/)?.[0];
    if (!opening) throw new Error(`Cannot export SCSEM workbook: repair formula cell ${address} is malformed.`);
    const repairedOpening = opening.replace(/\s+t="[^"]*"/gi, "");
    const repairedCell = cell.value
        .replace(opening, repairedOpening)
        .replace(paired[0], `<f${paired[1]}>${formula}</f>`)
        .replace(/<v\b[^>]*>[\s\S]*?<\/v>/gi, "")
        .replace(/<v\b[^>]*\/>/gi, "");
    return sheetXml.slice(0, cell.start) + repairedCell + sheetXml.slice(cell.end);
}

async function applyExactFormulaRepairs(
    zip: JSZip,
    pathsByName: Map<string, string>,
    operation: ResolvedAddition
): Promise<void> {
    const repairsBySheet = new Map<string, NonNullable<ResolvedAddition["formulaRepairs"]>>();
    for (const repair of operation.formulaRepairs || []) {
        repairsBySheet.set(repair.sheetName, [
            ...(repairsBySheet.get(repair.sheetName) || []),
            repair,
        ]);
    }
    for (const [sheetName, repairs] of repairsBySheet) {
        const worksheetPath = pathsByName.get(sheetName);
        let sheetXml = worksheetPath ? await zip.file(worksheetPath)?.async("string") : null;
        if (!worksheetPath || !sheetXml) {
            throw approvedChangeError(operation.change, `formula-repair worksheet ${sheetName} is missing`);
        }
        try {
            for (const repair of repairs) {
                sheetXml = replaceExactOrdinaryFormulaAtAddress(
                    sheetXml,
                    repair.address,
                    repair.formula
                );
            }
        } catch (error) {
            throw approvedChangeError(
                operation.change,
                error instanceof Error ? error.message : String(error)
            );
        }
        zip.file(worksheetPath, sheetXml, { createFolders: false });
    }
}

async function applyNonStructuralAppendSurgically(
    zip: JSZip,
    pathsByName: Map<string, string>,
    readWorkbook: XLSX.WorkBook,
    operation: ResolvedAddition
): Promise<void> {
    if (operation.insertBeforeFooter) return;
    await applyExactFormulaRepairs(zip, pathsByName, operation);
    const targetPath = pathsByName.get(operation.sheetName);
    let targetXml = targetPath ? await zip.file(targetPath)?.async("string") : null;
    if (!targetPath || !targetXml) {
        throw approvedChangeError(operation.change, `worksheet XML for ${operation.sheetName} is missing`);
    }

    let clonedFormulaAddresses: Array<{ source: string; target: string }> = [];
    const targetExcelRow = operation.row + 1;
    const sourceExcelRow = operation.riskFormulaSourceRow + 1;
    if (operation.materializeSparseRowFrom !== undefined) {
        try {
            targetXml = materializeSparseTargetRowFromDonor(
                targetXml,
                operation.materializeSparseRowFrom,
                operation.row,
                operation.materializeSparseThroughColumn ?? EXCEL_MAX_COLUMN
            );
        } catch (error) {
            throw approvedChangeError(
                operation.change,
                error instanceof Error ? error.message : String(error)
            );
        }
    }
    if (
        rowXmlNodesByNumber(targetXml, targetExcelRow).length === 0 &&
        operation.cloneSourceRow !== undefined
    ) {
        try {
            clonedFormulaAddresses = copiedFormulaAddressesForRow(
                targetXml,
                operation.cloneSourceRow,
                operation.row
            );
            targetXml = insertClonedBlankRow(
                targetXml,
                operation.cloneSourceRow,
                operation.row
            );
        } catch (error) {
            throw approvedChangeError(
                operation.change,
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    try {
        const materialized = materializeCopiedFormulaCellsForAppend(targetXml, operation);
        targetXml = materialized.xml;
        clonedFormulaAddresses.push(...materialized.clonedFormulaAddresses);
    } catch (error) {
        throw approvedChangeError(
            operation.change,
            error instanceof Error ? error.message : String(error)
        );
    }
    zip.file(targetPath, targetXml, { createFolders: false });

    for (const [sheetName, worksheetPath] of pathsByName) {
        const originalXml = await zip.file(worksheetPath)?.async("string");
        if (!originalXml) {
            throw approvedChangeError(operation.change, `worksheet XML for ${sheetName} is missing`);
        }
        let updatedXml: string;
        try {
            updatedXml = extendWorksheetFormulaCellsForAppendedRow(
                originalXml,
                sheetName,
                operation.sheetName,
                sourceExcelRow,
                targetExcelRow
            );
            if (sheetName === operation.sheetName) {
                updatedXml = extendWorksheetFeaturesForAppendedRow(
                    updatedXml,
                    sheetName,
                    sourceExcelRow,
                    targetExcelRow,
                    operation.doNotExtendFeatureSqrefs
                );
            }
        } catch (error) {
            throw approvedChangeError(
                operation.change,
                error instanceof Error ? error.message : String(error)
            );
        }
        if (updatedXml !== originalXml) {
            zip.file(worksheetPath, updatedXml, { createFolders: false });
        }
    }

    let workbookXml = await zip.file("xl/workbook.xml")?.async("string");
    if (!workbookXml) throw new Error("Cannot export SCSEM workbook: workbook XML is missing.");
    try {
        workbookXml = extendWorkbookDefinedNamesForAppendedRow(
            workbookXml,
            readWorkbook.SheetNames,
            operation.sheetName,
            sourceExcelRow,
            targetExcelRow
        );
    } catch (error) {
        throw approvedChangeError(
            operation.change,
            error instanceof Error ? error.message : String(error)
        );
    }
    zip.file("xl/workbook.xml", workbookXml, { createFolders: false });

    const calcChainFile = zip.file("xl/calcChain.xml");
    if (!calcChainFile && operation.explicitRiskFormula) {
        throw approvedChangeError(operation.change, "calcChain is required by the pinned explicit risk-formula profile");
    }
    if (calcChainFile && (clonedFormulaAddresses.length > 0 || operation.explicitRiskFormula)) {
        const targetSheetId = sheetIdForName(workbookXml, operation.sheetName);
        let calcChainXml = await calcChainFile.async("string");
        try {
            if (clonedFormulaAddresses.length > 0) {
                calcChainXml = shiftCalcChainForInsertedRow(
                    calcChainXml,
                    targetSheetId,
                    EXCEL_MAX_ROW,
                    clonedFormulaAddresses
                );
            }
            if (operation.explicitRiskFormula) {
                calcChainXml = addExplicitRiskFormulaCalcChain(
                    calcChainXml,
                    targetSheetId,
                    operation.riskRatingAddress,
                    operation.explicitRiskFormula.calcChainSourceAddress,
                    operation.explicitRiskFormula.calcChainSourceCount
                );
            }
            zip.file("xl/calcChain.xml", calcChainXml, { createFolders: false });
        } catch (error) {
            throw approvedChangeError(
                operation.change,
                error instanceof Error ? error.message : String(error)
            );
        }
    }
}

async function patchApprovedChangesSurgically(
    originalBuffer: Buffer,
    readWorkbook: XLSX.WorkBook,
    plan: ApprovedChangePlan,
    changeLogs: ChangeLogEntry[]
): Promise<Buffer> {
    exportDebug("loading source zip for surgical patch");
    const zip = await JSZip.loadAsync(originalBuffer);
    exportDebug("resolving worksheet paths");
    const pathsByName = await worksheetPathsByName(zip);
    exportDebug("checking raw plan safety");
    await assertRawPlanSafety(zip, pathsByName, plan);

    const footerInsertions = plan.additions.filter((operation) => operation.insertBeforeFooter);
    if (footerInsertions.length > 1) {
        throw new Error(
            "Cannot export SCSEM workbook: multiple structural footer insertions require ordered workbook-level handling."
        );
    }
    if (footerInsertions.length === 1) {
        exportDebug(`inserting control before canonical footer on ${footerInsertions[0].sheetName}`);
        await applyFooterInsertionSurgically(zip, pathsByName, readWorkbook, footerInsertions[0]);
    }
    for (const addition of plan.additions
        .filter((operation) => !operation.insertBeforeFooter)
        .sort((left, right) => left.row - right.row)) {
        exportDebug(`extending append references on ${addition.sheetName}`);
        await applyNonStructuralAppendSurgically(zip, pathsByName, readWorkbook, addition);
    }

    const operationsBySheet = new Map<string, Array<{ address: string; value: string }>>();
    for (const operation of plan.updates) {
        operationsBySheet.set(operation.sheetName, [
            ...(operationsBySheet.get(operation.sheetName) || []),
            { address: operation.address, value: operation.change.proposedValue },
        ]);
    }
    for (const operation of plan.additions) {
        operationsBySheet.set(operation.sheetName, [
            ...(operationsBySheet.get(operation.sheetName) || []),
            ...[...operation.cells].map(([address, value]) => ({ address, value })),
        ]);
    }
    const filterExtensions: AutoFilterExtension[] = [];
    for (const [sheetName, operations] of operationsBySheet) {
        exportDebug(`patching ${sheetName}`);
        const worksheetPath = pathsByName.get(sheetName)!;
        let sheetXml = await zip.file(worksheetPath)!.async("string");
        for (const operation of operations) {
            sheetXml = patchCellXml(sheetXml, operation.address, operation.value);
        }
        for (const addition of plan.additions.filter((operation) => operation.sheetName === sheetName)) {
            try {
                sheetXml = addition.explicitRiskFormula
                    ? stripPairedFormulaCacheAtAddress(sheetXml, addition.riskRatingAddress)
                    : stripFormulaCacheAtAddress(sheetXml, addition.riskRatingAddress);
                for (const address of addition.stripFormulaCacheAddresses || []) {
                    sheetXml = stripPairedFormulaCacheAtAddress(sheetXml, address);
                }
            } catch (error) {
                throw approvedChangeError(
                    addition.change,
                    error instanceof Error ? error.message : String(error)
                );
            }
            const extended = extendWorksheetAutoFilterForAddedRow(sheetXml, sheetName, addition.row);
            sheetXml = extended.xml;
            if (extended.extension) filterExtensions.push(extended.extension);
        }
        zip.file(worksheetPath, sheetXml, { createFolders: false });
    }

    if (changeLogs.length > 0) {
        exportDebug("patching workbook change log");
        const logSheetName = readWorkbook.SheetNames.find((sheetName) =>
            normalizeHeader(sheetName) === "change log"
        );
        const logWorksheetPath = logSheetName ? pathsByName.get(logSheetName) : null;
        const logWorksheet = logSheetName ? readWorkbook.Sheets[logSheetName] : null;
        if (!logSheetName || !logWorksheetPath || !logWorksheet) {
            throw new Error("Cannot export SCSEM workbook: a writable Change Log sheet is required.");
        }
        const originalLogXml = await zip.file(logWorksheetPath)?.async("string");
        if (!originalLogXml) {
            throw new Error("Cannot export SCSEM workbook: Change Log worksheet XML is missing.");
        }
        if (worksheetProtectionEnabled(originalLogXml)) {
            throw new Error("Cannot export SCSEM workbook: the Change Log sheet is protected.");
        }
        let logXml = originalLogXml;
        for (const entry of changeLogs) {
            logXml = appendChangeLogXml(logXml, logWorksheet, entry);
        }
        if (logXml === originalLogXml) {
            throw new Error("Cannot export SCSEM workbook: the Change Log schema is not writable.");
        }
        zip.file(logWorksheetPath, logXml, { createFolders: false });
    }

    if (plan.additions.length > 0) {
        let workbookXml = await zip.file("xl/workbook.xml")?.async("string");
        if (!workbookXml) {
            throw new Error("Cannot export SCSEM workbook: workbook XML is missing.");
        }
        for (const extension of filterExtensions) {
            const sheetIndex = readWorkbook.SheetNames.indexOf(extension.sheetName);
            if (sheetIndex < 0) {
                throw new Error(
                    `Cannot export SCSEM workbook: AutoFilter sheet ${extension.sheetName} is missing.`
                );
            }
            workbookXml = extendWorkbookFilterDefinedName(workbookXml, sheetIndex, extension);
        }
        zip.file(
            "xl/workbook.xml",
            forceWorkbookCalculationOnOpen(workbookXml),
            { createFolders: false }
        );
    }

    const output = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
    });
    exportDebug("surgical zip generated");
    const outputBuffer = Buffer.isBuffer(output) ? output : Buffer.from(output);
    assertVbaPreserved(originalBuffer, outputBuffer);
    return outputBuffer;
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

function applyApprovedChanges(
    parsed: ParsedSCSEM,
    plan: ApprovedChangePlan
): {
    sheets: ExportSheet[];
    applied: string[];
} {
    const sheets = cloneParsedSheets(parsed);
    const applied: string[] = [];

    for (const { change, sheetName } of plan.updates) {
        const sheet = sheets.find((candidate) => candidate.sheetName === sheetName)!;
        const control = sheet.controls.find((candidate) => candidate.testId === change.testId)!;
        (control as unknown as Record<string, unknown>)[change.field] = change.proposedValue;
        control.updateHighlight = true;
        applied.push(`Updated ${change.testId} ${change.field} on ${sheet.sheetName}`);
    }

    for (const {
        change,
        sheetName,
        row,
        newTestId,
        writtenFields,
        omittedFields,
        formulaRepairs,
    } of plan.additions) {
        const targetSheet = sheets.find((candidate) => candidate.sheetName === sheetName)!;
        const newControl: ExportControl = {
            rowIndex: row,
            testId: newTestId,
            nistId: writtenFields.get("nistId") || null,
            nistControlName: writtenFields.get("nistControlName") || null,
            testMethod: writtenFields.get("testMethod") || null,
            sectionTitle: writtenFields.get("sectionTitle") || null,
            description: writtenFields.get("description") || null,
            testProcedures: writtenFields.get("testProcedures") || null,
            expectedResults: writtenFields.get("expectedResults") || null,
            actualResults: null,
            status: null,
            findingStatement: writtenFields.get("findingStatement") || null,
            notesEvidence: null,
            criticality: writtenFields.get("criticality") || null,
            issueCode: writtenFields.get("issueCode") || null,
            issueCodeDescription: writtenFields.get("issueCodeDescription") || null,
            cisBenchmarkRef: writtenFields.get("cisBenchmarkRef") || null,
            recommendationNum: writtenFields.get("recommendationNum") || null,
            rationale: writtenFields.get("rationale") || null,
            impact: writtenFields.get("impact") || null,
            remediationProcedure: writtenFields.get("remediationProcedure") || null,
            remediationStatement: null,
            capRequestStatement: null,
            riskRating: null,
            extraColumns: null,
            updateHighlight: true,
        };
        targetSheet.controls.push(newControl);
        applied.push(
            `Added ${newTestId} from ${change.testId} to ${targetSheet.sheetName}` +
            (omittedFields.length > 0
                ? `; omitted optional fields absent from the template schema: ${omittedFields.join(", ")}`
                : "")
        );
        for (const repair of formulaRepairs || []) {
            applied.push(`Repaired pinned source formula ${repair.sheetName}!${repair.address}`);
        }
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
    originalAbsolutePath: string,
    _uploadedAssessmentWorkbook?: ParsedSCSEM
): Promise<Buffer> {
    exportDebug("starting updater export");
    if (!fs.existsSync(originalAbsolutePath)) {
        throw new Error(`Cannot export SCSEM workbook: source file not found at ${originalAbsolutePath}.`);
    }
    const originalBuffer = fs.readFileSync(originalAbsolutePath);
    const readWorkbook = XLSX.read(originalBuffer, {
        cellDates: true,
        cellFormula: true,
        cellStyles: true,
        sheetStubs: true,
        sheetRows: 10_000,
    });
    exportDebug("source workbook parsed for validation");
    const workbookSha256 = createHash("sha256").update(originalBuffer).digest("hex");
    const plan = buildApprovedChangePlan(session, parsed, readWorkbook, workbookSha256);
    exportDebug(`approved plan resolved (${plan.updates.length} updates, ${plan.additions.length} additions)`);
    const safetyZip = await JSZip.loadAsync(originalBuffer);
    exportDebug("source zip loaded for initial safety check");
    await assertRawPlanSafety(safetyZip, await worksheetPathsByName(safetyZip), plan);
    exportDebug("initial safety check passed");
    const { applied } = applyApprovedChanges(parsed, plan);
    exportDebug("approved changes applied to export model");
    const analysisIncomplete = session.status === "analysis_incomplete";
    const benchmarkNarrative = boundedStoredSCSEMBenchmarkNarrative({
        benchmarkLookupError: session.audit.benchmarkLookupError,
        blockers: session.audit.analysisCoverage?.blockers,
    });
    const candidateState = analysisIncomplete
        ? "DRAFT-INCOMPLETE"
        : "CANDIDATE";
    const officialUpgrade = session.audit.officialReference?.selectedAsBase
        ? session.audit.officialReference
        : null;
    const changeLogs: ChangeLogEntry[] = applied.length > 0 || officialUpgrade
        ? [{
            version: `SCSEM ${candidateState} ${new Date().toISOString().slice(0, 10)}`,
            changeDate: new Date(),
            description: [
                officialUpgrade
                    ? `Rebased on official IRS SCSEM ${officialUpgrade.workbookVersion || "current version"}: ${officialUpgrade.upgradeReason}.`
                    : null,
                analysisIncomplete
                    ? `${candidateState} workbook only; not an official SCSEM release. ` +
                        `Evidence analysis is incomplete. Blockers: ${[
                            ...benchmarkNarrative.blockers,
                            benchmarkNarrative.benchmarkLookupError,
                        ].filter((value): value is string => Boolean(value?.trim())).slice(0, 4).join("; ") ||
                            "required benchmark evidence was not fully resolved"}.`
                    : `${candidateState} workbook only; not an official SCSEM release. ` +
                        `${plan.updates.length + plan.additions.length} reviewer-approved SkyShield change(s) applied after IRS Pub 1075, ` +
                        "NIST SP 800-53 fallback, and CIS Benchmark/CIS-STIG review using CIS WorkBench evidence.",
                applied.slice(0, 12).join("; "),
            ].filter(Boolean).join(" "),
            changedBy: "SkyShield SCSEM Updater",
            source: "scsem_updater",
            details: [
                ...(officialUpgrade ? [{
                    target: "Workbook structure",
                    description: `Rebased on ${officialUpgrade.sourceUrl}`,
                }] : []),
                ...applied.map(changeLogDetail),
            ],
        }]
        : [];

    return patchApprovedChangesSurgically(originalBuffer, readWorkbook, plan, changeLogs);
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
