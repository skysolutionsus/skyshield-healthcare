import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import {
    isSCSEMColumnField,
    matchSCSEMColumnHeader,
    scsemColumnHeaderSignature,
    scsemWorkbookSheetNamesSignature,
    type SCSEMColumnField,
    type SCSEMColumnMatchContext,
} from "../src/lib/scsem-column-schema";
import { officialSCSEMManifest, type OfficialSCSEMManifestEntry } from "../src/lib/scsem-official-manifest";
import type { SCSEMUpdaterSession } from "../src/lib/scsem-updater-store";
import {
    buildSCSEMUpdaterWorkbookBuffer,
    updatedSCSEMFileName,
} from "../src/lib/scsem-workbook-export";
import {
    extendAppendedSCSEMFormulaRanges,
    hasExactSCSEMSheetQualifier,
    translateInsertedSCSEMFormula,
} from "../src/lib/scsem-formula-translation";
import { parseSCSEMFile, type ParsedControl, type ParsedSCSEM } from "../src/lib/xlsx-parser";

XLSX.set_fs(fs);

const ROOT = process.cwd();
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const EXACT_STRUCTURAL_ADD_ORACLE_PROFILES = new Map<string, {
    cloneSourceExcelRow: number;
    riskSourceAddress: string;
    riskTargetAddress: string;
    riskTargetFormula?: string;
    blankFooter?: boolean;
}>([
    ["305e7157181c99ca12c2be3dc65b44ded6b823aa6bb580774a0e3c381c8183df", {
        cloneSourceExcelRow: 331,
        riskSourceAddress: "Z295",
        riskTargetAddress: "Z332",
        riskTargetFormula: "IF(OR(J332=\"Fail\",ISBLANK(J332)),INDEX('Issue Code Table'!C:C,MATCH(N:N,'Issue Code Table'!A:A,0)),IF(M332=\"Critical\",6,IF(M332=\"Significant\",5,IF(M332=\"Moderate\",3,2))))",
    }],
    ["26c788823f7e196f1315314c438a980c84d1ec4635e23d7fc69f64b8eb7533d6", {
        cloneSourceExcelRow: 94,
        riskSourceAddress: "AA94",
        riskTargetAddress: "AA96",
        blankFooter: true,
    }],
    ["414fdf8e76d4c3bde67095bc6e7902df5aad3e8aa807825d3abbc29f09c95e5b", {
        cloneSourceExcelRow: 120,
        riskSourceAddress: "AB51",
        riskTargetAddress: "AB121",
        riskTargetFormula: "IF(OR(J121=\"Fail\",ISBLANK(J121)),INDEX('Issue Code Table'!C:C,MATCH(N:N,'Issue Code Table'!A:A,0)),IF(M121=\"Critical\",6,IF(M121=\"Significant\",5,IF(M121=\"Moderate\",3,2))))",
    }],
]);

type ExactSpecialAddOracleProfile = {
    compositeDescription?: boolean;
    sparseDonorZeroBasedRow?: number;
    sparseThroughColumn?: number;
    riskAddress?: string;
    riskFormula?: string;
    riskFormulaType?: "array";
    riskFormulaRef?: string;
    riskStyleId?: string;
    calcChainSourceAddress?: string;
    calcChainSourceCount?: number;
    stripFormulaCacheAddresses?: string[];
    formulaRepairs?: Array<{ sheetName: string; address: string; formula: string }>;
    doNotExtendFeatureSqrefs?: Array<{ tag: string; sqref: string }>;
};

const EXACT_SPECIAL_ADD_ORACLE_PROFILES = new Map<string, ExactSpecialAddOracleProfile>([
    ["5a628c9286a98dfa527482f05d618abb1052510e11919d22f7c423afd4e3ec4b", {
        sparseDonorZeroBasedRow: 67,
        sparseThroughColumn: 28,
        riskAddress: "AB69",
        riskFormula: "IF(OR($J69=\"Fail\",ISBLANK($J69)),INDEX('Issue Code Table'!$C:$C,_xlfn.XMATCH($N69,'Issue Code Table'!A:A,0)),IF($M69=\"Critical\",6,IF($M69=\"Significant\",5,IF($M69=\"Moderate\",3,2))))",
        riskFormulaType: "array",
        riskFormulaRef: "AB69",
        riskStyleId: "14",
        calcChainSourceAddress: "AB68",
        calcChainSourceCount: 2,
        stripFormulaCacheAddresses: ["AD69"],
    }],
    ["0746d73ce6df6cf5935b43da471367ed24c43624c7a4f131d854be3ff15606e9", {
        compositeDescription: true,
    }],
    ["064f76de388b5d015e5d1d4d4fcea3f7beaf846d66afb9edc4bb9d2f45a42e3c", {
        compositeDescription: true,
        riskAddress: "AA6",
        riskFormula: "IF(OR(H6=\"Fail\",ISBLANK(H6)),INDEX('Issue Code Table'!C:C,MATCH(K:K,'Issue Code Table'!A:A,0)),IF(J6=\"Critical\",6,IF(J6=\"Significant\",5,IF(J6=\"Moderate\",3,2))))",
        riskStyleId: "55",
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
        compositeDescription: true,
    }],
    ["658d726e6fadb25ceb98f15602e8109a670040ea91d5014ffcd175a2393e8ea1", {
        riskAddress: "Y58",
        riskFormula: "IF(OR(J58=\"Fail\",ISBLANK(J58)),INDEX('Issue Code Table'!C:C,MATCH(N:N,'Issue Code Table'!A:A,0)),IF(M58=\"Critical\",6,IF(M58=\"Significant\",5,IF(M58=\"Moderate\",3,2))))",
        riskStyleId: "203",
        formulaRepairs: [52, 53, 54, 55, 56, 57].map((row) => ({
            sheetName: "Gen Firewall Test Cases",
            address: `Y${row}`,
            formula: `IF(OR(J${row}=\"Fail\",ISBLANK(J${row})),INDEX('Issue Code Table'!C:C,MATCH(N:N,'Issue Code Table'!A:A,0)),IF(M${row}=\"Critical\",6,IF(M${row}=\"Significant\",5,IF(M${row}=\"Moderate\",3,2))))`,
        })),
    }],
    ["a38e9da08fb6a76c6a89b4f3e188b089543f71b633dcf06ba76e06a629c21fef", {
        riskAddress: "AA55",
        riskFormula: "IF(OR(K55=\"Fail\",ISBLANK(K55)),INDEX('Issue Code Table'!C:C,MATCH(O:O,'Issue Code Table'!A:A,0)),IF(N55=\"Critical\",6,IF(N55=\"Significant\",5,IF(N55=\"Moderate\",3,2))))",
        riskStyleId: "184",
        doNotExtendFeatureSqrefs: [{ tag: "dataValidation", sqref: "K3:K54" }],
    }],
]);

function requestedFinalExportDir(): string | null {
    const configured = process.env.SCSEM_CORPUS_FINAL_EXPORT_DIR?.trim();
    return configured ? path.resolve(configured) : null;
}

function operationFinalExportDir(operation: CorpusOperation): string | null {
    const root = requestedFinalExportDir();
    return root ? path.join(root, operation) : null;
}

function persistValidatedCorpusExport(
    operation: CorpusOperation,
    originalFileName: string,
    outputBuffer: Buffer
): string | null {
    const directory = operationFinalExportDir(operation);
    if (!directory) return null;
    fs.mkdirSync(directory, { recursive: true });
    const outputPath = path.join(directory, updatedSCSEMFileName(originalFileName));
    fs.writeFileSync(outputPath, outputBuffer);
    return outputPath;
}

function requestedReportDir(): string | null {
    const configured = process.env.SCSEM_CORPUS_REPORT_DIR?.trim();
    return configured ? path.resolve(configured) : null;
}
const UPDATE_FIELDS: readonly SCSEMColumnField[] = [
    "description",
    "testProcedures",
    "expectedResults",
    "remediationProcedure",
    "rationale",
    "impact",
    "sectionTitle",
] as const;
const AGENCY_ASSESSMENT_FIELDS = [
    "actualResults",
    "status",
    "notesEvidence",
    "remediationStatement",
    "capRequestStatement",
] as const satisfies ReadonlyArray<keyof ParsedControl>;
const WORKSHEET_FEATURE_TAGS = [
    "mergeCells",
    "autoFilter",
    "dataValidations",
    "conditionalFormatting",
    "sheetProtection",
    "protectedRanges",
    "drawing",
    "legacyDrawing",
    "legacyDrawingHF",
    "tableParts",
] as const;

type Header = {
    headerRow: number;
    testIdCol: number;
    columns: Map<SCSEMColumnField, number>;
    duplicateFields: Set<SCSEMColumnField>;
    range: XLSX.Range;
};

type Candidate = {
    sheetName: string;
    testId: string;
    rowIndex: number;
    field: SCSEMColumnField;
    address: string;
    currentValue: string;
};

type AddTarget = {
    sheetName: string;
    row: number;
    columns: Map<SCSEMColumnField, number>;
    duplicateFields: Set<SCSEMColumnField>;
};

type AddSentinels = {
    proposedValue: string;
    nistId: string;
    nistControlName: string;
    testMethod: string;
    sectionTitle: string;
    description: string;
    testProcedures: string;
    expectedResults: string;
    findingStatement: string;
    criticality: string;
    issueCode: string;
    issueCodeDescription: string;
    recommendationNum: string;
};

type CorpusOperation = "update" | "add";

type CorpusResult = {
    index: number;
    fileName: string;
    file: string;
    sha256: string;
    sizeBytes: number;
    outcome: "supported" | "blocked" | "failed";
    reason: string;
};

type XmlNodeMatch = { start: number; end: number; value: string };

function sha256(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

function normalizeText(value: unknown): string {
    if (value === undefined || value === null) return "";
    return String(value).trim();
}

function cellText(worksheet: XLSX.WorkSheet, row: number, col: number): string {
    return normalizeText(worksheet[XLSX.utils.encode_cell({ r: row, c: col })]?.v);
}

type CorpusSchemaContext = Pick<
    SCSEMColumnMatchContext,
    "workbookSha256" | "sheetName" | "workbookSheetNamesSignature"
>;

function findHeader(worksheet: XLSX.WorkSheet, schemaContext?: CorpusSchemaContext): Header | null {
    const ref = worksheet["!ref"];
    if (!ref) return null;
    const range = XLSX.utils.decode_range(ref);
    const maxHeaderRow = Math.min(range.e.r, range.s.r + 15);

    for (let row = range.s.r; row <= maxHeaderRow; row++) {
        let testIdCol = -1;
        const columns = new Map<SCSEMColumnField, number>();
        const duplicateFields = new Set<SCSEMColumnField>();
        const headerSignature = scsemColumnHeaderSignature(
            Array.from({ length: range.e.c + 1 }, (_, col) => cellText(worksheet, row, col))
        );

        for (let col = range.s.c; col <= range.e.c; col++) {
            const field = matchSCSEMColumnHeader(
                cellText(worksheet, row, col),
                schemaContext ? {
                    ...schemaContext,
                    headerRow: row,
                    columnIndex: col,
                    headerSignature,
                } : undefined
            );
            if (!field) continue;
            if (columns.has(field)) {
                duplicateFields.add(field);
                continue;
            }
            columns.set(field, col);
            if (field === "testId") testIdCol = col;
        }
        if (testIdCol >= 0) return { headerRow: row, testIdCol, columns, duplicateFields, range };
    }
    return null;
}

function rowsByTestId(worksheet: XLSX.WorkSheet, header: Header): Map<string, number[]> {
    const rows = new Map<string, number[]>();
    const maxRow = Math.min(header.range.e.r, header.headerRow + 10_000);
    for (let row = header.headerRow + 1; row <= maxRow; row++) {
        const testId = cellText(worksheet, row, header.testIdCol);
        if (!testId) continue;
        rows.set(testId, [...(rows.get(testId) || []), row]);
    }
    return rows;
}

function isMergedCell(worksheet: XLSX.WorkSheet, row: number, col: number): boolean {
    return (worksheet["!merges"] || []).some((range) =>
        row >= range.s.r && row <= range.e.r && col >= range.s.c && col <= range.e.c
    );
}

function candidateCells(
    entry: OfficialSCSEMManifestEntry,
    parsed: ParsedSCSEM,
    filePath: string
): Candidate[] {
    const workbook = XLSX.readFile(filePath, {
        cellFormula: true,
        cellStyles: true,
        sheetStubs: true,
        sheetRows: 10_000,
    });
    const candidates: Candidate[] = [];
    const workbookSheetNamesSignature = scsemWorkbookSheetNamesSignature(workbook.SheetNames);

    for (const parsedSheet of parsed.sheets.filter((sheet) => sheet.sheetType === "test_cases")) {
        const worksheet = workbook.Sheets[parsedSheet.sheetName];
        const header = worksheet ? findHeader(worksheet, {
            workbookSha256: entry.sha256,
            sheetName: parsedSheet.sheetName,
            workbookSheetNamesSignature,
        }) : null;
        if (!worksheet || !header) continue;
        const physicalRows = rowsByTestId(worksheet, header);
        const parsedCounts = new Map<string, number>();
        for (const control of parsedSheet.controls) {
            parsedCounts.set(control.testId, (parsedCounts.get(control.testId) || 0) + 1);
        }

        for (const field of UPDATE_FIELDS) {
            const col = header.columns.get(field);
            if (col === undefined || header.duplicateFields.has(field)) continue;

            for (const control of parsedSheet.controls) {
                if (parsedCounts.get(control.testId) !== 1) continue;
                const rows = physicalRows.get(control.testId) || [];
                if (rows.length !== 1) continue;

                const currentValue = normalizeText(control[field]);
                if (!currentValue) continue;
                const row = rows[0];
                const address = XLSX.utils.encode_cell({ r: row, c: col });
                const cell = worksheet[address] as (XLSX.CellObject & { F?: string }) | undefined;
                if (!cell || cellText(worksheet, row, col) !== currentValue) continue;
                if (typeof cell.f === "string" || typeof cell.F === "string" || cell.t === "e") continue;
                if (isMergedCell(worksheet, row, col)) continue;

                candidates.push({
                    sheetName: parsedSheet.sheetName,
                    testId: control.testId,
                    rowIndex: control.rowIndex,
                    field,
                    address,
                    currentValue,
                });
            }
        }
    }
    return candidates;
}

function decodeXml(value: string): string {
    return value
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
        .replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'")
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&amp;/g, "&");
}

function xmlAttributes(fragment: string): Map<string, string> {
    const attributes = new Map<string, string>();
    const matcher = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(fragment))) attributes.set(match[1], decodeXml(match[2]));
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
    assert.ok(workbookXml, "Workbook XML is missing");
    assert.ok(relationshipsXml, "Workbook relationships are missing");

    const targetsById = new Map<string, string>();
    for (const relationship of relationshipsXml.match(/<Relationship\b[^>]*\/?\s*>/g) || []) {
        const attributes = xmlAttributes(relationship);
        const id = attributes.get("Id");
        const target = attributes.get("Target");
        if (!id || !target) continue;
        targetsById.set(id, target.startsWith("/")
            ? path.posix.normalize(target.slice(1))
            : path.posix.normalize(path.posix.join("xl", target)));
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

function maskCellXml(sheetXml: string, address: string): string {
    const cell = findCellXml(sheetXml, address);
    assert.ok(cell, `Target cell ${address} is missing from worksheet XML`);
    return sheetXml.slice(0, cell.start) + `<skyshield-target-cell r="${address}"/>` + sheetXml.slice(cell.end);
}

function tagFragments(xml: string, tag: string): string[] {
    const matcher = new RegExp(`<${tag}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/${tag}>)`, "gi");
    return xml.match(matcher) || [];
}

function worksheetFeatureSnapshot(xml: string): Record<string, string[]> {
    return Object.fromEntries(WORKSHEET_FEATURE_TAGS.map((tag) => [tag, tagFragments(xml, tag)]));
}

function formulaCells(xml: string): Map<string, string> {
    const formulas = new Map<string, string>();
    const matcher = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(xml))) {
        if (!/<f\b/i.test(match[0])) continue;
        const address = xmlAttributes(match[0].match(/^<c\b[^>]*>/)?.[0] || "").get("r");
        assert.ok(address, "Formula cell is missing its address");
        assert.ok(!formulas.has(address), `Duplicate formula cell ${address}`);
        formulas.set(address, match[0]);
    }
    return formulas;
}

function stripFormulaCacheForTest(
    sheetXml: string,
    address: string,
    label: string
): string {
    const cell = findCellXml(sheetXml, address);
    assert.ok(cell, `${label}: computed risk cell ${address} is missing`);
    assert.ok(/<f\b[^>]*>[\s\S]*?<\/f>/i.test(cell.value), `${label}: ${address} lacks a paired formula`);
    const withoutCache = cell.value
        .replace(/<v\b[^>]*>[\s\S]*?<\/v>/gi, "")
        .replace(/<v\b[^>]*\/>/gi, "");
    return sheetXml.slice(0, cell.start) + withoutCache + sheetXml.slice(cell.end);
}

function formulaWithoutStringLiteralsForTest(formula: string): string {
    return formula.replace(/"(?:[^"]|"")*"/g, "\"\"");
}

function formulaReferencesLocalRowForTest(formula: string, excelRow: number): boolean {
    return new RegExp(
        `(?<![\\p{L}\\p{N}_.!])\\$?[A-Z]{1,3}\\$?${excelRow}(?!\\d)`,
        "iu"
    ).test(formulaWithoutStringLiteralsForTest(decodeXml(formula)));
}

function formulaReferencesLocalColumnForTest(
    formula: string,
    column: string,
    excelRow: number
): boolean {
    const escapedColumn = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
        `(?<![\\p{L}\\p{N}_.!])\\$?${escapedColumn}(?:\\$?${excelRow}(?!\\d)|\\s*:\\s*\\$?${escapedColumn}(?![\\p{L}\\p{N}_]))`,
        "iu"
    ).test(formulaWithoutStringLiteralsForTest(decodeXml(formula)));
}

function assertComputedRiskFormulaOoxml(
    expectedSheetXml: string,
    outputSheetXml: string,
    target: AddTarget,
    label: string,
    exactProfile?: ExactSpecialAddOracleProfile
) {
    const riskCol = target.columns.get("riskRating");
    const issueCodeCol = target.columns.get("issueCode");
    assert.ok(riskCol !== undefined && !target.duplicateFields.has("riskRating"), `${label}: risk formula column is not unique`);
    assert.ok(issueCodeCol !== undefined && !target.duplicateFields.has("issueCode"), `${label}: issue-code column is not unique`);
    const riskAddress = XLSX.utils.encode_cell({ r: target.row, c: riskCol });
    const expectedCell = findCellXml(expectedSheetXml, riskAddress);
    const outputCell = findCellXml(outputSheetXml, riskAddress);
    assert.ok(expectedCell && outputCell, `${label}: risk formula ${riskAddress} is missing`);
    const expectedFormula = expectedCell.value.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
    const outputFormula = outputCell.value.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
    assert.ok(expectedFormula && outputFormula, `${label}: risk formula ${riskAddress} is not paired ordinary OOXML`);
    const outputFormulaAttributes = xmlAttributes(`<f${outputFormula[1]}>`);
    assert.equal(
        outputFormulaAttributes.get("t"),
        exactProfile?.riskFormulaType,
        `${label}: risk formula has the wrong exact formula type`
    );
    assert.equal(
        outputFormulaAttributes.get("ref"),
        exactProfile?.riskFormulaRef,
        `${label}: risk formula has the wrong exact formula reference`
    );
    assert.equal(outputFormula[2], expectedFormula[2], `${label}: risk formula is not the exact translated template formula`);
    assert.ok(!/<v\b/i.test(outputCell.value), `${label}: risk formula retains a stale cached value`);
    const targetExcelRow = target.row + 1;
    const donorExcelRow = target.row;
    assert.ok(
        formulaReferencesLocalRowForTest(outputFormula[2], targetExcelRow),
        `${label}: risk formula does not reference the new control row`
    );
    assert.ok(
        !formulaReferencesLocalRowForTest(outputFormula[2], donorExcelRow),
        `${label}: risk formula still references its donor row`
    );
    assert.ok(
        formulaReferencesLocalColumnForTest(
            outputFormula[2],
            XLSX.utils.encode_col(issueCodeCol),
            targetExcelRow
        ),
        `${label}: risk formula does not reference the issue-code column`
    );
}

function rowNodes(xml: string): Map<number, XmlNodeMatch> {
    const rows = new Map<number, XmlNodeMatch>();
    const matcher = /<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(xml))) {
        const opening = match[0].match(/^<row\b[^>]*>/)?.[0] || match[0];
        const rowNumber = Number(xmlAttributes(opening).get("r"));
        assert.ok(Number.isSafeInteger(rowNumber) && rowNumber > 0, "Worksheet row is missing a valid row number");
        assert.ok(!rows.has(rowNumber), `Worksheet contains duplicate row ${rowNumber}`);
        rows.set(rowNumber, { start: match.index, end: match.index + match[0].length, value: match[0] });
    }
    return rows;
}

function rowXmlHasMaterialValue(rowXml: string): boolean {
    const matcher = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(rowXml))) {
        if (/<f\b/i.test(match[0])) return true;
        if (normalizeText(match[0].match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1])) return true;
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
        if (normalizeText(match[0].match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1])) return true;
        const inlineText = [...match[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
            .map((text) => decodeXml(text[1]).trim())
            .join("");
        if (inlineText) return true;
    }
    return false;
}

function cellsByAddress(rowXml: string): Map<string, string> {
    const cells = new Map<string, string>();
    const matcher = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(rowXml))) {
        const opening = match[0].match(/^<c\b[^>]*>/)?.[0] || match[0];
        const address = xmlAttributes(opening).get("r");
        assert.ok(address, "Worksheet cell is missing its address");
        assert.ok(!cells.has(address), `Worksheet row contains duplicate cell ${address}`);
        cells.set(address, match[0]);
    }
    return cells;
}

function maskDimension(xml: string): string {
    return xml.replace(/<dimension\b[^>]*\/>/i, "<skyshield-dimension/>");
}

function dimensionRange(xml: string): XLSX.Range | null {
    const ref = xml.match(/<dimension\b[^>]*\bref="([^"]+)"/i)?.[1];
    return ref ? XLSX.utils.decode_range(ref) : null;
}

function withoutCalcPr(xml: string): string {
    return xml.replace(/<calcPr\b[^>]*(?:\/>|>[\s\S]*?<\/calcPr>)/i, "");
}

function assertForcedCalculation(sourceWorkbookXml: string, outputWorkbookXml: string, label: string) {
    assert.equal(
        withoutCalcPr(outputWorkbookXml),
        withoutCalcPr(sourceWorkbookXml),
        `${label}: workbook XML changed outside the calculation properties`
    );
    const calcPr = outputWorkbookXml.match(/<calcPr\b[^>]*(?:\/>|>[\s\S]*?<\/calcPr>)/i)?.[0];
    assert.ok(calcPr, `${label}: exported workbook lacks calculation properties`);
    const attributes = xmlAttributes(calcPr);
    assert.equal(attributes.get("calcMode"), "auto", `${label}: calcMode is not auto`);
    assert.equal(attributes.get("fullCalcOnLoad"), "1", `${label}: fullCalcOnLoad is not enabled`);
    assert.equal(attributes.get("forceFullCalc"), "1", `${label}: forceFullCalc is not enabled`);
}

function setXmlAttributeForTest(tag: string, name: string, value: string): string {
    const matcher = new RegExp(`\\s${name}="[^"]*"`);
    if (matcher.test(tag)) return tag.replace(matcher, ` ${name}="${value}"`);
    return tag.endsWith("/>")
        ? tag.replace(/\s*\/>$/, ` ${name}="${value}"/>`)
        : tag.replace(/\s*>$/, ` ${name}="${value}">`);
}

function absoluteRangeRef(ref: string): string {
    const range = XLSX.utils.decode_range(ref);
    return `$${XLSX.utils.encode_col(range.s.c)}$${range.s.r + 1}:` +
        `$${XLSX.utils.encode_col(range.e.c)}$${range.e.r + 1}`;
}

function expectedAddFilterExtension(
    sourceSheetXml: string,
    sourceWorkbookXml: string,
    sheetIndex: number,
    addedRow: number,
    label: string
): { worksheetXml: string; workbookXml: string; oldRef: string | null; newRef: string | null } {
    const opening = sourceSheetXml.match(/<autoFilter\b[^>]*>/i)?.[0];
    const oldRef = opening ? xmlAttributes(opening).get("ref") || null : null;
    if (!opening || !oldRef) {
        return { worksheetXml: sourceSheetXml, workbookXml: sourceWorkbookXml, oldRef, newRef: null };
    }
    const range = XLSX.utils.decode_range(oldRef);
    if (range.e.r !== addedRow - 1) {
        return { worksheetXml: sourceSheetXml, workbookXml: sourceWorkbookXml, oldRef, newRef: null };
    }
    range.e.r = addedRow;
    const newRef = XLSX.utils.encode_range(range);
    const worksheetXml = sourceSheetXml.replace(opening, setXmlAttributeForTest(opening, "ref", newRef));
    const matchingNames = (sourceWorkbookXml.match(/<definedName\b[^>]*>[\s\S]*?<\/definedName>/gi) || [])
        .filter((node) => {
            const definedNameOpening = node.match(/^<definedName\b[^>]*>/i)?.[0] || "";
            const attributes = xmlAttributes(definedNameOpening);
            return attributes.get("name") === "_xlnm._FilterDatabase" &&
                Number(attributes.get("localSheetId")) === sheetIndex;
        });
    assert.ok(matchingNames.length <= 1, `${label}: target sheet has ambiguous AutoFilter defined names`);
    let workbookXml = sourceWorkbookXml;
    if (matchingNames.length === 1) {
        const node = matchingNames[0];
        assert.ok(node.includes(absoluteRangeRef(oldRef)), `${label}: source AutoFilter defined name is inconsistent`);
        workbookXml = workbookXml.replace(
            node,
            node.replace(absoluteRangeRef(oldRef), absoluteRangeRef(newRef))
        );
    }
    return { worksheetXml, workbookXml, oldRef, newRef };
}

function translateCopiedFormulaForTest(formula: string, rowDelta: number): string {
    return formula.replace(/(\$?[A-Z]{1,3})(\$?)(\d+)/g, (reference, column, absoluteRow, row) =>
        absoluteRow === "$" ? reference : `${column}${Number(row) + rowDelta}`
    );
}

function expectedClonedBlankRow(sourceRowXml: string, sourceExcelRow: number, targetExcelRow: number): string {
    const sourceOpening = sourceRowXml.match(/^<row\b[^>]*>/)?.[0];
    assert.ok(sourceOpening, `Clone source row ${sourceExcelRow} is malformed`);
    let rowOpening = setXmlAttributeForTest(sourceOpening, "r", String(targetExcelRow));
    rowOpening = rowOpening.replace(/\s+hidden="(?:1|true)"/i, "");
    const cells = [...sourceRowXml.matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)].map((match) => {
        const sourceCell = match[0];
        const opening = sourceCell.match(/^<c\b[^>]*\/?\s*>/)?.[0];
        const sourceAddress = opening ? xmlAttributes(opening).get("r") : null;
        assert.ok(opening && sourceAddress, `Clone source row ${sourceExcelRow} has a malformed cell`);
        const decoded = XLSX.utils.decode_cell(sourceAddress);
        const targetAddress = XLSX.utils.encode_cell({ r: targetExcelRow - 1, c: decoded.c });
        let targetOpening = setXmlAttributeForTest(opening, "r", targetAddress);
        const formula = sourceCell.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
        if (formula) {
            assert.ok(!xmlAttributes(`<f${formula[1]}>`).has("t"), "Clone source uses shared/array formula");
            return sourceCell
                .replace(opening, targetOpening)
                .replace(
                    formula[0],
                    `<f${formula[1]}>${translateCopiedFormulaForTest(formula[2], targetExcelRow - sourceExcelRow)}</f>`
                )
                .replace(/<v\b[^>]*>[\s\S]*?<\/v>/i, "");
        }
        targetOpening = targetOpening
            .replace(/\s+t="[^"]*"/g, "")
            .replace(/\s*\/?\s*>$/, "/>");
        return targetOpening;
    });
    return `${rowOpening}${cells.join("")}</row>`;
}

function replaceOrInsertRowCellForTest(rowXml: string, address: string, cellXml: string): string {
    const existing = findCellXml(rowXml, address);
    if (existing) return rowXml.slice(0, existing.start) + cellXml + rowXml.slice(existing.end);
    const closing = rowXml.lastIndexOf("</row>");
    assert.ok(closing >= 0, `Target row for ${address} is malformed`);
    const targetCol = XLSX.utils.decode_cell(address).c;
    let insertion = closing;
    for (const match of rowXml.matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)) {
        const opening = match[0].match(/^<c\b[^>]*>/)?.[0] || match[0];
        const currentAddress = xmlAttributes(opening).get("r");
        if (currentAddress && XLSX.utils.decode_cell(currentAddress).c > targetCol) {
            insertion = match.index;
            break;
        }
    }
    return rowXml.slice(0, insertion) + cellXml + rowXml.slice(insertion);
}

function expectedFormulaRepairsForSheet(
    sourceXml: string,
    sheetName: string,
    exactProfile?: ExactSpecialAddOracleProfile
): string {
    let expected = sourceXml;
    for (const repair of exactProfile?.formulaRepairs || []) {
        if (repair.sheetName !== sheetName) continue;
        const cell = findCellXml(expected, repair.address);
        assert.ok(cell, `Exact repair source ${sheetName}!${repair.address} is missing`);
        const opening = cell.value.match(/^<c\b[^>]*>/)?.[0];
        const formula = cell.value.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
        assert.ok(opening && formula, `Exact repair source ${sheetName}!${repair.address} is malformed`);
        assert.equal(
            xmlAttributes(`<f${formula[1]}>`).get("t"),
            undefined,
            `Exact repair source ${sheetName}!${repair.address} is not ordinary`
        );
        const repaired = cell.value
            .replace(opening, opening.replace(/\s+t="[^"]*"/gi, ""))
            .replace(formula[0], `<f${formula[1]}>${repair.formula}</f>`)
            .replace(/<v\b[^>]*>[\s\S]*?<\/v>/gi, "")
            .replace(/<v\b[^>]*\/>/gi, "");
        expected = expected.slice(0, cell.start) + repaired + expected.slice(cell.end);
    }
    return expected;
}

function expectedSparseRowMaterialization(
    sourceXml: string,
    target: AddTarget,
    exactProfile?: ExactSpecialAddOracleProfile
): string {
    if (exactProfile?.sparseDonorZeroBasedRow === undefined) return sourceXml;
    const donor = rowNodes(sourceXml).get(exactProfile.sparseDonorZeroBasedRow + 1);
    const targetNode = rowNodes(sourceXml).get(target.row + 1);
    assert.ok(donor && targetNode, "Exact sparse-row donor/target is missing");
    let targetRow = targetNode.value;
    for (const sourceCell of cellsByAddress(donor.value).values()) {
        const opening = sourceCell.match(/^<c\b[^>]*\/?\s*>/)?.[0];
        const address = opening ? xmlAttributes(opening).get("r") : null;
        assert.ok(opening && address, "Exact sparse-row donor cell is malformed");
        const decoded = XLSX.utils.decode_cell(address);
        if (decoded.c > (exactProfile.sparseThroughColumn ?? 16_383)) continue;
        const targetAddress = XLSX.utils.encode_cell({ r: target.row, c: decoded.c });
        const existing = findCellXml(targetRow, targetAddress);
        if (existing && /<f\b/i.test(existing.value)) continue;
        assert.ok(!existing || !rowXmlHasMaterialValue(`<row>${existing.value}</row>`), `Sparse target ${targetAddress} contains data`);
        const structuralCell = setXmlAttributeForTest(opening, "r", targetAddress)
            .replace(/\s+t="[^"]*"/gi, "")
            .replace(/\s*\/?\s*>$/, "/>");
        targetRow = replaceOrInsertRowCellForTest(targetRow, targetAddress, structuralCell);
    }
    return sourceXml.slice(0, targetNode.start) + targetRow + sourceXml.slice(targetNode.end);
}

function expectedMaterializedAppendFormulas(
    sourceTargetXml: string,
    targetBaseXml: string,
    target: AddTarget,
    rowWasCloned: boolean,
    label: string,
    exactProfile?: ExactSpecialAddOracleProfile
): {
    xml: string;
    clonedFormulaAddresses: Array<{ source: string; target: string }>;
} {
    const sourceExcelRow = target.row;
    const targetExcelRow = target.row + 1;
    const sourceRow = rowNodes(sourceTargetXml).get(sourceExcelRow);
    const targetRowNode = rowNodes(targetBaseXml).get(targetExcelRow);
    assert.ok(sourceRow && targetRowNode, `${label}: formula donor/target row is missing`);
    let targetRow = targetRowNode.value;
    const clonedFormulaAddresses: Array<{ source: string; target: string }> = [];

    for (const sourceCell of cellsByAddress(sourceRow.value).values()) {
        if (!/<f\b/i.test(sourceCell)) continue;
        const sourceOpening = sourceCell.match(/^<c\b[^>]*>/)?.[0] || sourceCell;
        const sourceAddress = xmlAttributes(sourceOpening).get("r");
        assert.ok(sourceAddress, `${label}: formula donor cell has no address`);
        const decoded = XLSX.utils.decode_cell(sourceAddress);
        const targetAddress = XLSX.utils.encode_cell({ r: target.row, c: decoded.c });
        if (exactProfile?.riskAddress === targetAddress) continue;
        const formula = sourceCell.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
        assert.ok(formula, `${label}: formula donor ${sourceAddress} is not paired ordinary OOXML`);
        assert.equal(xmlAttributes(`<f${formula[1]}>`).get("t"), undefined, `${label}: compound formula donor ${sourceAddress}`);
        const expectedFormula = translateCopiedFormulaForTest(formula[2], targetExcelRow - sourceExcelRow);
        const targetCell = findCellXml(targetRow, targetAddress);
        if (targetCell && /<f\b/i.test(targetCell.value)) {
            const targetFormula = targetCell.value.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
            assert.ok(targetFormula, `${label}: target formula ${targetAddress} is malformed`);
            assert.equal(targetFormula[2], expectedFormula, `${label}: target formula ${targetAddress} is not translated exactly`);
            const withoutCache = targetCell.value
                .replace(/<v\b[^>]*>[\s\S]*?<\/v>/gi, "")
                .replace(/<v\b[^>]*\/>/gi, "");
            targetRow = targetRow.slice(0, targetCell.start) + withoutCache + targetRow.slice(targetCell.end);
        } else {
            const targetOpening = setXmlAttributeForTest(sourceOpening, "r", targetAddress)
                .replace(/\s+t="[^"]*"/gi, "");
            const targetCellXml = sourceCell
                .replace(sourceOpening, targetOpening)
                .replace(formula[0], `<f${formula[1]}>${expectedFormula}</f>`)
                .replace(/<v\b[^>]*>[\s\S]*?<\/v>/gi, "")
                .replace(/<v\b[^>]*\/>/gi, "");
            targetRow = replaceOrInsertRowCellForTest(targetRow, targetAddress, targetCellXml);
        }
        if (rowWasCloned || !targetCell || !/<f\b/i.test(targetCell.value)) {
            clonedFormulaAddresses.push({ source: sourceAddress, target: targetAddress });
        }
    }
    if (exactProfile?.riskAddress && exactProfile.riskFormula) {
        const targetCell = findCellXml(targetRow, exactProfile.riskAddress);
        assert.ok(targetCell && !/<f\b/i.test(targetCell.value), `${label}: exact risk target is not blank`);
        const opening = targetCell.value.match(/^<c\b[^>]*\/?\s*>/)?.[0];
        assert.ok(opening, `${label}: exact risk target is malformed`);
        const styledOpening = setXmlAttributeForTest(
            opening.replace(/\s+t="[^"]*"/gi, ""),
            "s",
            exactProfile.riskStyleId!
        );
        const formulaAttributes = exactProfile.riskFormulaType
            ? ` t="${exactProfile.riskFormulaType}" ref="${exactProfile.riskFormulaRef}"`
            : "";
        const riskCell = /\/>$/.test(styledOpening)
            ? styledOpening.replace(/\/>$/, `><f${formulaAttributes}>${exactProfile.riskFormula}</f></c>`)
            : `${styledOpening}<f${formulaAttributes}>${exactProfile.riskFormula}</f></c>`;
        targetRow = targetRow.slice(0, targetCell.start) + riskCell + targetRow.slice(targetCell.end);
    }
    for (const address of exactProfile?.stripFormulaCacheAddresses || []) {
        const targetCell = findCellXml(targetRow, address);
        assert.ok(targetCell && /<f\b[^>]*>[\s\S]*?<\/f>/i.test(targetCell.value), `${label}: cache-strip formula ${address} is missing`);
        const cacheless = targetCell.value
            .replace(/<v\b[^>]*>[\s\S]*?<\/v>/gi, "")
            .replace(/<v\b[^>]*\/>/gi, "");
        targetRow = targetRow.slice(0, targetCell.start) + cacheless + targetRow.slice(targetCell.end);
    }
    return {
        xml: targetBaseXml.slice(0, targetRowNode.start) + targetRow + targetBaseXml.slice(targetRowNode.end),
        clonedFormulaAddresses,
    };
}

function extendA1RangeTokenForAppendForTest(token: string, sourceRow: number, targetRow: number): string {
    const match = token.match(/^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})(?::(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6}))?$/);
    assert.ok(match, `Unsupported append range token ${token}`);
    if (match[6] === undefined) {
        return Number(match[4]) === sourceRow
            ? `${match[1]}${match[2]}${match[3]}${match[4]}:${match[1]}${match[2]}${match[3]}${targetRow}`
            : token;
    }
    return Number(match[8]) === sourceRow
        ? `${match[1]}${match[2]}${match[3]}${match[4]}:${match[5]}${match[6]}${match[7]}${targetRow}`
        : token;
}

function extendSqrefForAppendForTest(sqref: string, sourceRow: number, targetRow: number): string {
    return sqref.split(/\s+/).map((token) =>
        token ? extendA1RangeTokenForAppendForTest(token, sourceRow, targetRow) : token
    ).join(" ");
}

function expectedWorksheetAppendExtensions(
    xml: string,
    sheetName: string,
    targetSheetName: string,
    sourceRow: number,
    targetRow: number,
    extendFeatures: boolean,
    exactProfile?: ExactSpecialAddOracleProfile
): string {
    const formulaSheetIsTarget = sheetName.trim().normalize("NFKC").toLocaleLowerCase("en-US") ===
        targetSheetName.trim().normalize("NFKC").toLocaleLowerCase("en-US");
    let expected = xml.replace(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, (cellXml) => {
        const formula = cellXml.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
        if (!formula) return cellXml;
        if (!formulaSheetIsTarget && !hasExactSCSEMSheetQualifier(formula[2], targetSheetName)) {
            return cellXml;
        }
        const translated = extendAppendedSCSEMFormulaRanges(formula[2], sourceRow, targetRow, {
            formulaSheet: sheetName,
            appendedSheet: targetSheetName,
        });
        return translated === formula[2] ? cellXml : cellXml
            .replace(formula[0], `<f${formula[1]}>${translated}</f>`)
            .replace(/<v\b[^>]*>[\s\S]*?<\/v>/gi, "")
            .replace(/<v\b[^>]*\/>/gi, "");
    });
    if (!extendFeatures) return expected;
    expected = expected.replace(/<([\w:.-]+)\b[^>]*>/g, (opening, qualifiedTag: string) => {
        const localTag = qualifiedTag.split(":").at(-1)!;
        if (!["conditionalFormatting", "dataValidation", "protectedRange", "ignoredError"].includes(localTag)) {
            return opening;
        }
        const sqref = xmlAttributes(opening).get("sqref");
        if (!sqref) return opening;
        if (exactProfile?.doNotExtendFeatureSqrefs?.some((exception) =>
            exception.tag === localTag && exception.sqref === sqref
        )) return opening;
        return setXmlAttributeForTest(opening, "sqref", extendSqrefForAppendForTest(sqref, sourceRow, targetRow));
    });
    expected = expected.replace(
        /<(formula1|formula2|formula|xm:f)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
        (node, tag: string, attributes: string, formula: string) => {
            const translated = extendAppendedSCSEMFormulaRanges(formula, sourceRow, targetRow, {
                formulaSheet: sheetName,
                appendedSheet: targetSheetName,
            });
            return translated === formula ? node : `<${tag}${attributes}>${translated}</${tag}>`;
        }
    );
    return expected.replace(
        /<xm:sqref\b([^>]*)>([\s\S]*?)<\/xm:sqref>/gi,
        (node, attributes: string, sqref: string) => {
            const translated = extendSqrefForAppendForTest(sqref, sourceRow, targetRow);
            return translated === sqref ? node : `<xm:sqref${attributes}>${translated}</xm:sqref>`;
        }
    );
}

function expectedWorkbookAppendDefinedNames(
    workbookXml: string,
    sheetNames: string[],
    targetSheetName: string,
    sourceRow: number,
    targetRow: number
): string {
    return workbookXml.replace(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/gi,
        (node, attributes: string, formula: string) => {
            const parsed = xmlAttributes(`<definedName${attributes}>`);
            if (parsed.get("name") === "_xlnm._FilterDatabase") return node;
            const localSheetId = parsed.get("localSheetId");
            const formulaSheet = localSheetId === undefined
                ? "__workbook__"
                : sheetNames[Number(localSheetId)] || "__workbook__";
            const formulaSheetIsTarget = formulaSheet.trim().normalize("NFKC").toLocaleLowerCase("en-US") ===
                targetSheetName.trim().normalize("NFKC").toLocaleLowerCase("en-US");
            if (!formulaSheetIsTarget && !hasExactSCSEMSheetQualifier(formula, targetSheetName)) {
                return node;
            }
            const translated = extendAppendedSCSEMFormulaRanges(formula, sourceRow, targetRow, {
                formulaSheet,
                appendedSheet: targetSheetName,
            });
            return translated === formula ? node : `<definedName${attributes}>${translated}</definedName>`;
        });
}

function expectedCalcChainFormulaClones(
    calcChainXml: string,
    targetSheetId: string,
    clones: Array<{ source: string; target: string }>,
    label: string
): string {
    let expected = calcChainXml;
    for (const clone of clones) {
        let activeSheetId: string | null = null;
        const candidates: XmlNodeMatch[] = [];
        const matcher = /<c\b[^>]*\/>/g;
        let match: RegExpExecArray | null;
        while ((match = matcher.exec(expected))) {
            const attributes = xmlAttributes(match[0]);
            if (attributes.has("i")) activeSheetId = attributes.get("i") || null;
            if (activeSheetId === targetSheetId && attributes.get("r") === clone.source) {
                candidates.push({ start: match.index, end: match.index + match[0].length, value: match[0] });
            }
        }
        assert.equal(candidates.length, 1, `${label}: calcChain donor ${clone.source} is not unique`);
        let cloned = setXmlAttributeForTest(candidates[0].value, "r", clone.target);
        cloned = setXmlAttributeForTest(cloned, "i", targetSheetId);
        expected = expected.slice(0, candidates[0].end) + cloned + expected.slice(candidates[0].end);
    }
    return expected;
}

function expectedExplicitRiskCalcChain(
    calcChainXml: string,
    targetSheetId: string,
    exactProfile: ExactSpecialAddOracleProfile,
    label: string
): string {
    if (!exactProfile.riskAddress) return calcChainXml;
    let activeSheetId: string | null = null;
    const sourceNodes: XmlNodeMatch[] = [];
    const targetNodes: XmlNodeMatch[] = [];
    const matcher = /<c\b[^>]*\/>/g;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(calcChainXml))) {
        const attributes = xmlAttributes(match[0]);
        if (attributes.has("i")) activeSheetId = attributes.get("i") || null;
        if (activeSheetId !== targetSheetId) continue;
        const node = { start: match.index, end: match.index + match[0].length, value: match[0] };
        if (attributes.get("r") === exactProfile.riskAddress) targetNodes.push(node);
        if (attributes.get("r") === exactProfile.calcChainSourceAddress) sourceNodes.push(node);
    }
    assert.equal(targetNodes.length, 0, `${label}: exact risk calcChain target pre-exists`);
    if (exactProfile.calcChainSourceAddress) {
        assert.equal(
            sourceNodes.length,
            exactProfile.calcChainSourceCount,
            `${label}: exact risk calcChain source count differs`
        );
        const clones = sourceNodes.map((node) =>
            setXmlAttributeForTest(
                setXmlAttributeForTest(node.value, "r", exactProfile.riskAddress!),
                "i",
                targetSheetId
            )
        ).join("");
        const insertAt = sourceNodes.at(-1)!.end;
        return calcChainXml.slice(0, insertAt) + clones + calcChainXml.slice(insertAt);
    }
    const closing = calcChainXml.lastIndexOf("</calcChain>");
    assert.ok(closing >= 0, `${label}: calcChain XML is malformed`);
    return calcChainXml.slice(0, closing) +
        `<c r="${exactProfile.riskAddress}" i="${targetSheetId}"/>` +
        calcChainXml.slice(closing);
}

function shiftA1RangeForInsertedRowForTest(
    token: string,
    insertionExcelRow: number,
    extendBefore: boolean
): string {
    const match = token.match(/^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})(?::(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6}))?$/);
    assert.ok(match, `Unsupported structural range token ${token}`);
    let firstRow = Number(match[4]);
    let secondRow = Number(match[8] || match[4]);
    if (match[6] === undefined) {
        if (firstRow >= insertionExcelRow) {
            assert.ok(firstRow < 1_048_576, `Structural reference ${token} exceeds Excel row limits`);
            firstRow++;
        }
        else if (extendBefore && firstRow === insertionExcelRow - 1) {
            return `${match[1]}${match[2]}${match[3]}${firstRow}:` +
                `${match[1]}${match[2]}${match[3]}${firstRow + 1}`;
        }
        return `${match[1]}${match[2]}${match[3]}${firstRow}`;
    }
    if (firstRow >= insertionExcelRow) {
        firstRow++;
        if (secondRow < 1_048_576) secondRow++;
    } else if (secondRow >= insertionExcelRow || (extendBefore && secondRow === insertionExcelRow - 1)) {
        if (secondRow < 1_048_576) secondRow++;
    }
    return `${match[1]}${match[2]}${match[3]}${firstRow}:` +
        `${match[5]}${match[6]}${match[7]}${secondRow}`;
}

function shiftSqrefForInsertedRowForTest(
    sqref: string,
    insertionExcelRow: number,
    extendBefore: boolean
): string {
    return sqref.split(/\s+/).map((token) =>
        token ? shiftA1RangeForInsertedRowForTest(token, insertionExcelRow, extendBefore) : token
    ).join(" ");
}

function expectedWorksheetFormulaInsertion(
    xml: string,
    formulaSheet: string,
    insertedSheet: string,
    insertionExcelRow: number
): string {
    const localTarget = formulaSheet.trim().normalize("NFKC").toLocaleLowerCase("en-US") ===
        insertedSheet.trim().normalize("NFKC").toLocaleLowerCase("en-US");
    return xml.replace(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, (cellXml) => {
        const formula = cellXml.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
        if (!formula) return cellXml;
        if (!localTarget && !hasExactSCSEMSheetQualifier(formula[2], insertedSheet)) return cellXml;
        const translated = translateInsertedSCSEMFormula(formula[2], insertionExcelRow, {
            formulaSheet,
            insertedSheet,
            extendRangesEndingBeforeInsertion: true,
        });
        if (translated === formula[2]) return cellXml;
        assert.equal(xmlAttributes(`<f${formula[1]}>`).get("t"), undefined, `Compound inserted-row formula on ${formulaSheet}`);
        return cellXml
            .replace(formula[0], `<f${formula[1]}>${translated}</f>`)
            .replace(/<v\b[^>]*>[\s\S]*?<\/v>/gi, "")
            .replace(/<v\b[^>]*\/>/gi, "");
    });
}

function expectedWorksheetFeaturesForInsertedRow(
    xml: string,
    sheetName: string,
    insertionExcelRow: number
): string {
    const refTags = new Set(["dimension", "autoFilter", "mergeCell", "hyperlink", "sortState", "sortCondition"]);
    const sqrefTags = new Set(["conditionalFormatting", "dataValidation", "protectedRange", "ignoredError", "selection"]);
    let expected = xml.replace(/<([\w:.-]+)\b[^>]*>/g, (opening, qualifiedTag: string) => {
        const localTag = qualifiedTag.split(":").at(-1)!;
        if (refTags.has(localTag)) {
            const ref = xmlAttributes(opening).get("ref");
            if (!ref) return opening;
            return setXmlAttributeForTest(
                opening,
                "ref",
                shiftSqrefForInsertedRowForTest(
                    ref,
                    insertionExcelRow,
                    localTag === "autoFilter" || localTag === "dimension"
                )
            );
        }
        if (sqrefTags.has(localTag)) {
            const sqref = xmlAttributes(opening).get("sqref");
            if (!sqref) return opening;
            return setXmlAttributeForTest(
                opening,
                "sqref",
                shiftSqrefForInsertedRowForTest(
                    sqref,
                    insertionExcelRow,
                    ["conditionalFormatting", "dataValidation", "protectedRange", "ignoredError"].includes(localTag)
                )
            );
        }
        if (localTag === "pane") {
            const topLeftCell = xmlAttributes(opening).get("topLeftCell");
            return topLeftCell
                ? setXmlAttributeForTest(
                    opening,
                    "topLeftCell",
                    shiftA1RangeForInsertedRowForTest(topLeftCell, insertionExcelRow, false)
                )
                : opening;
        }
        return opening;
    });
    expected = expected.replace(
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
    return expected.replace(
        /<xm:sqref\b([^>]*)>([\s\S]*?)<\/xm:sqref>/gi,
        (node, attributes: string, sqref: string) => {
            const translated = shiftSqrefForInsertedRowForTest(sqref, insertionExcelRow, true);
            return translated === sqref ? node : `<xm:sqref${attributes}>${translated}</xm:sqref>`;
        }
    );
}

function expectedStructuralInsertionTargetBase(
    sourceXml: string,
    target: AddTarget,
    label: string,
    exactProfile?: {
        cloneSourceExcelRow: number;
        riskSourceAddress: string;
        riskTargetAddress: string;
        riskTargetFormula?: string;
    }
): {
    xml: string;
    clonedFormulaAddresses: Array<{ source: string; target: string }>;
} {
    const insertionExcelRow = target.row + 1;
    const sourceExcelRow = exactProfile?.cloneSourceExcelRow ?? target.row;
    const originalRows = rowNodes(sourceXml);
    const donor = originalRows.get(sourceExcelRow);
    const footer = originalRows.get(insertionExcelRow);
    assert.ok(donor && footer, `${label}: structural donor/footer row is missing`);
    const clone = expectedClonedBlankRow(donor.value, sourceExcelRow, insertionExcelRow);
    const clonedFormulaAddresses = [...cellsByAddress(donor.value)].flatMap(([source, cellXml]) => {
        if (!/<f\b/i.test(cellXml)) return [];
        const decoded = XLSX.utils.decode_cell(source);
        return [{ source, target: XLSX.utils.encode_cell({ r: target.row, c: decoded.c }) }];
    });
    let expected = expectedWorksheetFormulaInsertion(
        sourceXml,
        target.sheetName,
        target.sheetName,
        insertionExcelRow
    );
    const translatedRows = [...rowNodes(expected).entries()]
        .filter(([row]) => row >= insertionExcelRow)
        .reverse();
    for (const [rowNumber, row] of translatedRows) {
        expected = expected.slice(0, row.start) +
            shiftedRowXmlForTest(row.value, rowNumber) +
            expected.slice(row.end);
    }
    expected = expectedWorksheetFeaturesForInsertedRow(expected, target.sheetName, insertionExcelRow);
    const shiftedFooter = rowNodes(expected).get(insertionExcelRow + 1);
    assert.ok(shiftedFooter, `${label}: shifted structural footer is missing`);
    expected = expected.slice(0, shiftedFooter.start) + clone + expected.slice(shiftedFooter.start);
    if (exactProfile?.riskTargetFormula) {
        const sourceRisk = findCellXml(sourceXml, exactProfile.riskSourceAddress);
        assert.ok(sourceRisk, `${label}: exact structural risk source is missing`);
        const sourceFormula = sourceRisk.value.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
        assert.ok(sourceFormula, `${label}: exact structural risk source is not a paired formula`);
        assert.equal(
            xmlAttributes(`<f${sourceFormula[1]}>`).get("t"),
            undefined,
            `${label}: exact structural risk source is not ordinary`
        );
        const targetRisk = findCellXml(expected, exactProfile.riskTargetAddress);
        assert.ok(targetRisk && !/<f\b/i.test(targetRisk.value), `${label}: exact structural risk target is not blank`);
        const opening = targetRisk.value.match(/^<c\b[^>]*\/?>/)?.[0];
        assert.ok(opening, `${label}: exact structural risk target is malformed`);
        const riskCell = /\/>$/.test(opening)
            ? opening.replace(/\/>$/, `><f>${exactProfile.riskTargetFormula}</f></c>`)
            : `${opening}<f>${exactProfile.riskTargetFormula}</f></c>`;
        expected = expected.slice(0, targetRisk.start) + riskCell + expected.slice(targetRisk.end);
        clonedFormulaAddresses.push({
            source: exactProfile.riskSourceAddress,
            target: exactProfile.riskTargetAddress,
        });
    }
    return { xml: expected, clonedFormulaAddresses };
}

function expectedWorkbookNamesForInsertedRow(
    workbookXml: string,
    sheetNames: string[],
    insertedSheet: string,
    insertionExcelRow: number
): string {
    return workbookXml.replace(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/gi,
        (node, attributes: string, formula: string) => {
            const localSheetId = xmlAttributes(`<definedName${attributes}>`).get("localSheetId");
            const formulaSheet = localSheetId === undefined
                ? "__workbook__"
                : sheetNames[Number(localSheetId)] || "__workbook__";
            const translated = translateInsertedSCSEMFormula(formula, insertionExcelRow, {
                formulaSheet,
                insertedSheet,
                extendRangesEndingBeforeInsertion: true,
            });
            return translated === formula ? node : `<definedName${attributes}>${translated}</definedName>`;
        });
}

function expectedCalcChainInsertedRow(
    calcChainXml: string,
    targetSheetId: string,
    insertionExcelRow: number,
    clones: Array<{ source: string; target: string }>,
    label: string
): string {
    let activeSheetId: string | null = null;
    const expected = calcChainXml.replace(/<c\b[^>]*\/>/g, (node) => {
        const attributes = xmlAttributes(node);
        if (attributes.has("i")) activeSheetId = attributes.get("i") || null;
        if (activeSheetId !== targetSheetId) return node;
        const address = attributes.get("r");
        assert.ok(address, `${label}: calcChain entry has no address`);
        const decoded = XLSX.utils.decode_cell(address);
        return decoded.r + 1 >= insertionExcelRow
            ? setXmlAttributeForTest(node, "r", XLSX.utils.encode_cell({ r: decoded.r + 1, c: decoded.c }))
            : node;
    });
    return expectedCalcChainFormulaClones(expected, targetSheetId, clones, label);
}

function extendSqrefFeaturesForTest(xml: string, sourceRow: number, targetRow: number): string {
    return xml.replace(/<(?:conditionalFormatting|dataValidation)\b[^>]*>/gi, (opening) => {
        const sqref = xmlAttributes(opening).get("sqref");
        if (!sqref) return opening;
        const updated = sqref.split(/\s+/).map((token) => {
            if (!token || token.includes("$")) return token;
            const range = XLSX.utils.decode_range(token);
            if (range.e.r !== sourceRow || range.s.r > sourceRow) return token;
            range.e.r = targetRow;
            return XLSX.utils.encode_range(range);
        }).join(" ");
        return updated === sqref ? opening : setXmlAttributeForTest(opening, "sqref", updated);
    });
}

function expectedWorksheetWithClonedRow(sourceXml: string, targetZeroBasedRow: number, label: string): string {
    const sourceExcelRow = targetZeroBasedRow;
    const targetExcelRow = targetZeroBasedRow + 1;
    const rows = rowNodes(sourceXml);
    assert.ok(!rows.has(targetExcelRow), `${label}: clone target row already exists`);
    const sourceRow = rows.get(sourceExcelRow);
    assert.ok(sourceRow, `${label}: clone source row is missing`);
    const clonedRow = expectedClonedBlankRow(sourceRow.value, sourceExcelRow, targetExcelRow);
    const following = [...rows.values()].find((row) =>
        Number(xmlAttributes(row.value.match(/^<row\b[^>]*>/)?.[0] || row.value).get("r")) > targetExcelRow
    );
    const insertAt = following?.start ?? sourceXml.indexOf("</sheetData>");
    assert.ok(insertAt >= 0, `${label}: worksheet sheetData is malformed`);
    return extendSqrefFeaturesForTest(
        sourceXml.slice(0, insertAt) + clonedRow + sourceXml.slice(insertAt),
        targetZeroBasedRow - 1,
        targetZeroBasedRow
    );
}

function replaceExactlyOnceForTest(xml: string, before: string, after: string, label: string): string {
    const first = xml.indexOf(before);
    assert.ok(first >= 0, `${label}: expected OOXML fragment is missing: ${before}`);
    assert.equal(xml.indexOf(before, first + before.length), -1, `${label}: expected OOXML fragment is ambiguous: ${before}`);
    return xml.slice(0, first) + after + xml.slice(first + before.length);
}

function shiftedRowXmlForTest(rowXml: string, sourceExcelRow: number): string {
    if (sourceExcelRow === 1_048_576) {
        assert.ok(!rowXmlHasMaterialValue(rowXml), `Cannot preserve populated terminal Excel row ${sourceExcelRow}`);
        return rowXml;
    }
    assert.ok(sourceExcelRow < 1_048_576, `Cannot shift Excel row ${sourceExcelRow}`);
    const opening = rowXml.match(/^<row\b[^>]*>/)?.[0] || rowXml;
    let shifted = rowXml.replace(opening, setXmlAttributeForTest(opening, "r", String(sourceExcelRow + 1)));
    shifted = shifted.replace(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, (cellXml) => {
        assert.ok(!/<f\b/i.test(cellXml), `Amazon footer/helper row ${sourceExcelRow} unexpectedly has a formula`);
        const cellOpening = cellXml.match(/^<c\b[^>]*>/)?.[0] || cellXml;
        const address = xmlAttributes(cellOpening).get("r");
        assert.ok(address, `Amazon footer/helper row ${sourceExcelRow} has a cell without an address`);
        const decoded = XLSX.utils.decode_cell(address);
        assert.equal(decoded.r + 1, sourceExcelRow, `${address} is stored on the wrong source row`);
        return cellXml.replace(
            cellOpening,
            setXmlAttributeForTest(
                cellOpening,
                "r",
                XLSX.utils.encode_cell({ r: decoded.r + 1, c: decoded.c })
            )
        );
    });
    return shifted;
}

function shiftedAmazonProtectedRangeSqrefForTest(sqref: string): string {
    return sqref.split(/\s+/).map((token) => {
        assert.ok(token && !token.includes("$"), `Unexpected Amazon protected range ${token}`);
        const range = XLSX.utils.decode_range(token);
        if (range.s.r >= 180) {
            range.s.r++;
            if (range.e.r < 1_048_575) range.e.r++;
        } else if (range.e.r >= 180) {
            if (range.e.r < 1_048_575) range.e.r++;
        } else if (range.e.r === 179) {
            range.e.r++;
        }
        return XLSX.utils.encode_range(range);
    }).join(" ");
}

function expectedAmazonFooterInsertionBase(sourceXml: string, label: string): string {
    const rows = rowNodes(sourceXml);
    const sourceControl = rows.get(180);
    const sourceFooter = rows.get(181);
    assert.ok(sourceControl && sourceFooter, `${label}: pinned Amazon control/footer rows are missing`);
    assert.ok(rowXmlHasNonFormulaMaterialValue(sourceFooter.value), `${label}: pinned Amazon footer is blank`);
    const clone = expectedClonedBlankRow(sourceControl.value, 180, 181);

    let expected = sourceXml;
    for (const [rowNumber, row] of [...rows].filter(([rowNumber]) => rowNumber >= 181).reverse()) {
        expected = expected.slice(0, row.start) +
            shiftedRowXmlForTest(row.value, rowNumber) +
            expected.slice(row.end);
    }
    const shiftedFooter = rowNodes(expected).get(182);
    assert.ok(shiftedFooter, `${label}: expected shifted Amazon footer row is missing`);
    expected = expected.slice(0, shiftedFooter.start) + clone + expected.slice(shiftedFooter.start);
    expected = expected.replace(/<protectedRange\b[^>]*>/g, (opening) => {
        const sqref = xmlAttributes(opening).get("sqref");
        assert.ok(sqref, `${label}: Amazon protected range lacks sqref`);
        return setXmlAttributeForTest(
            opening,
            "sqref",
            shiftedAmazonProtectedRangeSqrefForTest(sqref)
        );
    });

    const exactDeltas: Array<[string, string]> = [
        ['<dimension ref="A1:XFC196"/>', '<dimension ref="A1:XFC197"/>'],
        ['sqref="AA1:AA65536"', 'sqref="AA1:AA65537"'],
        ['<autoFilter ref="A2:AB181"', '<autoFilter ref="A2:AB182"'],
        ['sqref="A1:A2 A181:A1048576"', 'sqref="A1:A2 A182:A1048576"'],
        ['sqref="A3:AB180"', 'sqref="A3:AB181"'],
        ['sqref="J3:J180" xr:uid="{809FA5F8-4965-4DC0-8D76-50E4A1B3FBA5}"', 'sqref="J3:J181" xr:uid="{809FA5F8-4965-4DC0-8D76-50E4A1B3FBA5}"'],
        ['<conditionalFormatting sqref="J3:J180">', '<conditionalFormatting sqref="J3:J181">'],
        ['sqref="M3:M180"', 'sqref="M3:M181"'],
        ['<formula1>$L$185:$L$188</formula1>', '<formula1>$L$186:$L$189</formula1>'],
        ['<formula1>$I$184:$I$187</formula1>', '<formula1>$I$185:$I$188</formula1>'],
        ['<xm:sqref>N3:N180</xm:sqref>', '<xm:sqref>N3:N181</xm:sqref>'],
    ];
    for (const [before, after] of exactDeltas) {
        expected = replaceExactlyOnceForTest(expected, before, after, label);
    }
    return expected;
}

function expectedAmazonCrossSheetFormulaExtensions(xml: string): { xml: string; changedCells: number } {
    let changedCells = 0;
    const updated = xml.replace(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, (cellXml) => {
        const formula = cellXml.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/i);
        if (!formula) return cellXml;
        const translated = formula[2]
            .replace(/'Amazon Linux 23 Test Cases'!J3:J180/g, "'Amazon Linux 23 Test Cases'!J3:J181")
            .replace(/'Amazon Linux 23 Test Cases'!A3:A180/g, "'Amazon Linux 23 Test Cases'!A3:A181");
        if (translated === formula[2]) return cellXml;
        changedCells++;
        return cellXml
            .replace(formula[0], `<f${formula[1]}>${translated}</f>`)
            .replace(/<v\b[^>]*>[\s\S]*?<\/v>/i, "");
    });
    return { xml: updated, changedCells };
}

async function assertAmazonFooterInsertionOoxml(
    sourceZip: JSZip,
    outputZip: JSZip,
    sourcePaths: Map<string, string>,
    targetPath: string,
    logPath: string,
    target: AddTarget,
    added: ParsedControl,
    sentinels: AddSentinels,
    label: string
) {
    assert.equal(target.sheetName, "Amazon Linux 23 Test Cases", `${label}: unexpected Amazon target sheet`);
    assert.equal(target.row + 1, 181, `${label}: Amazon insertion did not anchor at the canonical footer`);
    const sourceParts = Object.keys(sourceZip.files).sort();
    const outputParts = Object.keys(outputZip.files).sort();
    assert.deepEqual(outputParts, sourceParts, `${label}: Amazon footer insertion changed OOXML part inventory`);

    const sourceTargetXml = await sourceZip.file(targetPath)!.async("string");
    const outputTargetXml = await outputZip.file(targetPath)!.async("string");
    const expectedTargetBase = expectedAmazonFooterInsertionBase(sourceTargetXml, label);
    assertComputedRiskFormulaOoxml(expectedTargetBase, outputTargetXml, target, label);
    const expectedBaseRows = rowNodes(expectedTargetBase);
    const outputRows = rowNodes(outputTargetXml);
    assert.deepEqual([...outputRows.keys()], [...expectedBaseRows.keys()], `${label}: Amazon row inventory is not +1 exact`);
    assert.equal(outputRows.size, rowNodes(sourceTargetXml).size + 1, `${label}: Amazon row count did not increase by one`);

    const expectedNewRow = expectedBaseRows.get(181)!;
    const outputNewRow = outputRows.get(181)!;
    const expectedCells = cellsByAddress(expectedNewRow.value);
    const outputCells = cellsByAddress(outputNewRow.value);
    assert.deepEqual([...outputCells.keys()], [...expectedCells.keys()], `${label}: Amazon inserted-row cell inventory changed`);
    const expectedAddresses = [...addFieldValues(added.testId, sentinels)]
        .filter(([field]) => target.columns.has(field) && !target.duplicateFields.has(field))
        .map(([field, value]) => [
            XLSX.utils.encode_cell({ r: target.row, c: target.columns.get(field)! }),
            value,
        ] as const);
    const changedCells = [...outputCells].filter(([address, xml]) => expectedCells.get(address) !== xml)
        .map(([address]) => address).sort();
    assert.deepEqual(changedCells, expectedAddresses.map(([address]) => address).sort(), `${label}: Amazon wrote noncanonical cells`);
    for (const [address, value] of expectedAddresses) {
        assert.ok(outputCells.get(address)?.includes(value), `${label}: Amazon ${address} lacks its expected value`);
    }
    const maskedOutputTarget = removeNode(outputTargetXml, outputNewRow);
    const maskedExpectedTarget = removeNode(expectedTargetBase, expectedNewRow);
    if (maskedOutputTarget !== maskedExpectedTarget) {
        let difference = 0;
        while (
            difference < maskedOutputTarget.length &&
            difference < maskedExpectedTarget.length &&
            maskedOutputTarget[difference] === maskedExpectedTarget[difference]
        ) difference++;
        assert.fail(
            `${label}: Amazon target sheet differs outside the one inserted control row at XML offset ${difference}; ` +
            `output=${JSON.stringify(maskedOutputTarget.slice(difference, difference + 240))}; ` +
            `expected=${JSON.stringify(maskedExpectedTarget.slice(difference, difference + 240))}`
        );
    }
    assert.equal(
        outputRows.get(182)?.value,
        shiftedRowXmlForTest(rowNodes(sourceTargetXml).get(181)!.value, 181),
        `${label}: Amazon canonical footer was not moved intact to row 182`
    );
    assert.equal(dimensionRange(outputTargetXml)?.e.r, dimensionRange(sourceTargetXml)!.e.r + 1);

    let translatedFormulaCells = 0;
    for (const [sheetName, worksheetPath] of sourcePaths) {
        if (worksheetPath === targetPath || worksheetPath === logPath) continue;
        const sourceXml = await sourceZip.file(worksheetPath)!.async("string");
        const outputXml = await outputZip.file(worksheetPath)!.async("string");
        const expected = expectedAmazonCrossSheetFormulaExtensions(sourceXml);
        translatedFormulaCells += expected.changedCells;
        assert.equal(outputXml, expected.xml, `${label}: unexpected cross-sheet OOXML change on ${sheetName}`);
    }
    assert.equal(translatedFormulaCells, 6, `${label}: Amazon must translate exactly six cross-sheet formula cells`);

    const sourceWorkbookXml = await sourceZip.file("xl/workbook.xml")!.async("string");
    const outputWorkbookXml = await outputZip.file("xl/workbook.xml")!.async("string");
    const expectedWorkbookXml = replaceExactlyOnceForTest(
        sourceWorkbookXml,
        "'Amazon Linux 23 Test Cases'!$A$2:$AB$181",
        "'Amazon Linux 23 Test Cases'!$A$2:$AB$182",
        label
    );
    assertForcedCalculation(expectedWorkbookXml, outputWorkbookXml, label);

    const sourceCalcChain = await sourceZip.file("xl/calcChain.xml")!.async("string");
    const outputCalcChain = await outputZip.file("xl/calcChain.xml")!.async("string");
    const sourceCalcNode = '<c r="AB180" i="21"/>';
    const expectedCalcChain = replaceExactlyOnceForTest(
        sourceCalcChain,
        sourceCalcNode,
        `${sourceCalcNode}<c r="AB181" i="21"/>`,
        label
    );
    assert.equal(outputCalcChain, expectedCalcChain, `${label}: Amazon calcChain delta is not exactly AB181`);

    const allowedChangedParts = new Set([
        targetPath,
        logPath,
        "xl/workbook.xml",
        "xl/calcChain.xml",
        ...sourcePaths.values(),
    ]);
    for (const partName of sourceParts) {
        if (sourceZip.files[partName].dir || allowedChangedParts.has(partName)) continue;
        assert.deepEqual(
            await outputZip.file(partName)!.async("nodebuffer"),
            await sourceZip.file(partName)!.async("nodebuffer"),
            `${label}: Amazon changed unrelated OOXML part ${partName}`
        );
    }

    const sourceLogXml = await sourceZip.file(logPath)!.async("string");
    const outputLogXml = await outputZip.file(logPath)!.async("string");
    assertRawChangeLogFidelity(sourceLogXml, outputLogXml, added.testId, label);
}

async function assertStructuralFooterInsertionOoxml(
    sourceZip: JSZip,
    outputZip: JSZip,
    sourcePaths: Map<string, string>,
    targetPath: string,
    logPath: string,
    target: AddTarget,
    added: ParsedControl,
    sentinels: AddSentinels,
    label: string,
    exactProfile?: {
        cloneSourceExcelRow: number;
        riskSourceAddress: string;
        riskTargetAddress: string;
        riskTargetFormula?: string;
    }
) {
    const sourceParts = Object.keys(sourceZip.files).sort();
    const outputParts = Object.keys(outputZip.files).sort();
    assert.deepEqual(outputParts, sourceParts, `${label}: structural insertion changed OOXML part inventory`);
    const sourceTargetXml = await sourceZip.file(targetPath)!.async("string");
    const outputTargetXml = await outputZip.file(targetPath)!.async("string");
    const expectedTarget = expectedStructuralInsertionTargetBase(
        sourceTargetXml,
        target,
        label,
        exactProfile
    );
    assertComputedRiskFormulaOoxml(expectedTarget.xml, outputTargetXml, target, label);

    const expectedRows = rowNodes(expectedTarget.xml);
    const outputRows = rowNodes(outputTargetXml);
    assert.deepEqual([...outputRows.keys()], [...expectedRows.keys()], `${label}: structural row inventory differs`);
    assert.equal(outputRows.size, rowNodes(sourceTargetXml).size + 1, `${label}: structural insertion is not exactly +1 row`);
    const expectedNewRow = expectedRows.get(target.row + 1);
    const outputNewRow = outputRows.get(target.row + 1);
    assert.ok(expectedNewRow && outputNewRow, `${label}: structural new row is missing`);
    const expectedCells = cellsByAddress(expectedNewRow.value);
    const outputCells = cellsByAddress(outputNewRow.value);
    assert.deepEqual([...outputCells.keys()], [...expectedCells.keys()], `${label}: structural new-row cell inventory changed`);
    const expectedAddresses = [...addFieldValues(added.testId, sentinels)]
        .filter(([field]) => target.columns.has(field) && !target.duplicateFields.has(field))
        .map(([field, value]) => [
            XLSX.utils.encode_cell({ r: target.row, c: target.columns.get(field)! }),
            value,
        ] as const);
    const changedAddresses = [...outputCells].filter(([address, xml]) => expectedCells.get(address) !== xml)
        .map(([address]) => address).sort();
    assert.deepEqual(
        changedAddresses,
        expectedAddresses.map(([address]) => address).sort(),
        `${label}: structural insertion wrote noncanonical cells`
    );
    for (const [address, value] of expectedAddresses) {
        assert.ok(outputCells.get(address)?.includes(value), `${label}: structural ${address} lacks its expected value`);
    }
    const maskedOutputTarget = removeNode(outputTargetXml, outputNewRow);
    const maskedExpectedTarget = removeNode(expectedTarget.xml, expectedNewRow);
    if (maskedOutputTarget !== maskedExpectedTarget) {
        let difference = 0;
        while (
            difference < maskedOutputTarget.length &&
            difference < maskedExpectedTarget.length &&
            maskedOutputTarget[difference] === maskedExpectedTarget[difference]
        ) difference++;
        assert.fail(
            `${label}: structural target differs outside inserted row at XML offset ${difference}; ` +
            `output=${JSON.stringify(maskedOutputTarget.slice(difference, difference + 240))}; ` +
            `expected=${JSON.stringify(maskedExpectedTarget.slice(difference, difference + 240))}`
        );
    }

    const sourceWorkbookXml = await sourceZip.file("xl/workbook.xml")!.async("string");
    const outputWorkbookXml = await outputZip.file("xl/workbook.xml")!.async("string");
    const expectedWorkbookXml = expectedWorkbookNamesForInsertedRow(
        sourceWorkbookXml,
        [...sourcePaths.keys()],
        target.sheetName,
        target.row + 1
    );
    assertForcedCalculation(expectedWorkbookXml, outputWorkbookXml, label);

    for (const [sheetName, worksheetPath] of sourcePaths) {
        if (worksheetPath === targetPath || worksheetPath === logPath) continue;
        const sourceXml = await sourceZip.file(worksheetPath)!.async("string");
        const outputXml = await outputZip.file(worksheetPath)!.async("string");
        assert.equal(
            outputXml,
            expectedWorksheetFormulaInsertion(sourceXml, sheetName, target.sheetName, target.row + 1),
            `${label}: unexpected structural cross-sheet delta on ${sheetName}`
        );
    }

    const sourceCalcChain = await sourceZip.file("xl/calcChain.xml")?.async("string");
    const outputCalcChain = await outputZip.file("xl/calcChain.xml")?.async("string");
    assert.equal(Boolean(outputCalcChain), Boolean(sourceCalcChain), `${label}: structural calcChain presence changed`);
    if (sourceCalcChain && outputCalcChain) {
        const targetSheetNode = (sourceWorkbookXml.match(/<sheet\b[^>]*\/>/g) || [])
            .find((node) => xmlAttributes(node).get("name") === target.sheetName);
        const targetSheetId = targetSheetNode ? xmlAttributes(targetSheetNode).get("sheetId") : null;
        assert.ok(targetSheetId, `${label}: structural target sheet ID is missing`);
        assert.equal(
            outputCalcChain,
            expectedCalcChainInsertedRow(
                sourceCalcChain,
                targetSheetId,
                target.row + 1,
                expectedTarget.clonedFormulaAddresses,
                label
            ),
            `${label}: structural calcChain delta is not exact`
        );
    }

    const worksheetParts = new Set(sourcePaths.values());
    for (const partName of sourceParts) {
        if (
            sourceZip.files[partName].dir ||
            worksheetParts.has(partName) ||
            partName === "xl/workbook.xml" ||
            partName === "xl/calcChain.xml"
        ) continue;
        assert.deepEqual(
            await outputZip.file(partName)!.async("nodebuffer"),
            await sourceZip.file(partName)!.async("nodebuffer"),
            `${label}: structural insertion changed unrelated part ${partName}`
        );
    }

    const sourceLogXml = await sourceZip.file(logPath)!.async("string");
    const outputLogXml = await outputZip.file(logPath)!.async("string");
    assertRawChangeLogFidelity(sourceLogXml, outputLogXml, added.testId, label);
}

function removeNode(xml: string, node: XmlNodeMatch): string {
    return xml.slice(0, node.start) + xml.slice(node.end);
}

function safeTempName(fileName: string): string {
    return fileName.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-");
}

function recursiveFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...recursiveFiles(entryPath));
        else if (entry.isFile()) files.push(entryPath);
    }
    return files;
}

function assertXmlAndZipIntegrity(outputPath: string, label: string) {
    const zipTest = spawnSync("/usr/bin/unzip", ["-tqq", outputPath], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
    });
    assert.equal(
        zipTest.status,
        0,
        `${label}: ZIP integrity check failed: ${(zipTest.stderr || zipTest.stdout || "unknown unzip error").trim()}`
    );

    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "skyshield-ooxml-"));
    try {
        const extract = spawnSync("/usr/bin/unzip", ["-qq", outputPath, "-d", extractDir], {
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
        });
        assert.equal(
            extract.status,
            0,
            `${label}: OOXML extraction failed: ${(extract.stderr || extract.stdout || "unknown unzip error").trim()}`
        );
        const xmlParts = recursiveFiles(extractDir)
            .filter((filePath) => /(?:\.xml|\.rels)$/i.test(filePath))
            .sort();
        assert.ok(xmlParts.length > 0, `${label}: exported package contains no XML parts`);
        const xmlCheck = spawnSync("/usr/bin/xmllint", ["--noout", "--nonet", ...xmlParts], {
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
        });
        assert.equal(
            xmlCheck.status,
            0,
            `${label}: malformed OOXML XML part: ${(xmlCheck.stderr || xmlCheck.stdout || "unknown xmllint error").trim()}`
        );
    } finally {
        fs.rmSync(extractDir, { recursive: true, force: true });
    }
}

function buildSession(
    entry: OfficialSCSEMManifestEntry,
    parsed: ParsedSCSEM,
    candidate: Candidate,
    sentinel: string
): SCSEMUpdaterSession {
    return {
        id: `corpus-export-${entry.sha256.slice(0, 16)}`,
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
            testCaseSheets: parsed.sheets
                .filter((sheet) => sheet.sheetType === "test_cases")
                .map((sheet) => sheet.sheetName),
        },
        changes: [{
            id: `corpus-change-${entry.sha256.slice(0, 16)}`,
            status: "APPROVED",
            action: "updateField",
            testId: candidate.testId,
            targetSheet: candidate.sheetName,
            field: candidate.field,
            currentValue: candidate.currentValue,
            proposedValue: sentinel,
            reason: "All-current-SCSEM export regression test.",
            confidence: "test",
            sourceEvidence: { sourceSheet: candidate.sheetName },
        }],
        history: [],
        audit: {
            uploadedSha256: entry.sha256,
            uploadedSizeBytes: entry.sizeBytes,
            officialSource: entry,
        },
    };
}

function chooseAddTarget(
    entry: OfficialSCSEMManifestEntry,
    parsed: ParsedSCSEM,
    filePath: string,
    label: string
): AddTarget {
    const workbook = XLSX.readFile(filePath, {
        cellFormula: true,
        cellStyles: true,
        sheetStubs: true,
        sheetRows: 10_000,
    });
    const workbookSheetNamesSignature = scsemWorkbookSheetNamesSignature(workbook.SheetNames);
    const requiredFields: SCSEMColumnField[] = [
        "testId",
        "description",
        "testProcedures",
        "expectedResults",
    ];
    const identityFields: SCSEMColumnField[] = ["nistId", "recommendationNum"];
    const proposalFields: SCSEMColumnField[] = [
        ...requiredFields,
        ...identityFields,
        "nistControlName",
        "testMethod",
        "sectionTitle",
        "criticality",
    ];
    const candidates: Array<AddTarget & { score: number }> = [];

    for (const parsedSheet of parsed.sheets.filter((sheet) =>
        sheet.sheetType === "test_cases" && sheet.controls.length > 0
    )) {
        const worksheet = workbook.Sheets[parsedSheet.sheetName];
        const header = worksheet ? findHeader(worksheet, {
            workbookSha256: entry.sha256,
            sheetName: parsedSheet.sheetName,
            workbookSheetNamesSignature,
        }) : null;
        if (!worksheet || !header) continue;
        const physicalRows = [...rowsByTestId(worksheet, header).values()].flat();
        if (physicalRows.length === 0) continue;
        const row = Math.max(...physicalRows) + 1;
        const unambiguous = (field: SCSEMColumnField) =>
            header.columns.has(field) && !header.duplicateFields.has(field);
        const requiredCoverage = requiredFields.filter(unambiguous).length;
        const hasIdentity = identityFields.some(unambiguous);
        const proposalCoverage = proposalFields.filter(unambiguous).length;
        const existingCellScore = proposalFields
            .map((field) => header.columns.get(field))
            .filter((col): col is number => col !== undefined)
            .filter((col) => Boolean(worksheet[XLSX.utils.encode_cell({ r: row, c: col })]))
            .length;
        const autoFilter = (worksheet as XLSX.WorkSheet & { "!autofilter"?: { ref: string } })["!autofilter"]?.ref;
        const filterIncludesRow = !autoFilter || row <= XLSX.utils.decode_range(autoFilter).e.r;
        candidates.push({
            sheetName: parsedSheet.sheetName,
            row,
            columns: header.columns,
            duplicateFields: header.duplicateFields,
            score: (
                requiredCoverage === requiredFields.length && hasIdentity ? 1_000_000 : 0
            ) + requiredCoverage * 10_000 + (hasIdentity ? 1_000 : 0) +
                proposalCoverage * 100 + existingCellScore * 10 + (filterIncludesRow ? 1 : 0),
        });
    }

    const selected = candidates.sort((left, right) => right.score - left.score)[0];
    assert.ok(selected, `${label}: no parsed test-case sheet can host an add-control proposal`);
    return {
        sheetName: selected.sheetName,
        row: selected.row,
        columns: selected.columns,
        duplicateFields: selected.duplicateFields,
    };
}

function assertPaloAltoFilteredAnchorRegression(
    entry: OfficialSCSEMManifestEntry,
    parsed: ParsedSCSEM,
    filePath: string,
    target: AddTarget,
    label: string
) {
    if (entry.fileName !== "safeguards-scsem-palo-alto-firewall-v1.xlsx") return;
    const sheet = parsed.sheets.find((candidate) => candidate.sheetName === "PaloAlto10");
    assert.ok(sheet, `${label}: pinned PaloAlto10 sheet is missing`);
    assert.ok(
        sheet.controls.some((control) => control.rowIndex === 89 && control.testId === "PaloAlto10-17"),
        `${label}: hidden physical row 90 was not parsed as the real PaloAlto10-17 control`
    );
    assert.equal(Math.max(...sheet.controls.map((control) => control.rowIndex)), 119);
    assert.equal(target.sheetName, "PaloAlto10", `${label}: filtered Palo regression selected the wrong sheet`);
    assert.equal(target.row + 1, 121, `${label}: add-control did not anchor after the final physical control`);
    const workbook = XLSX.readFile(filePath, {
        cellFormula: true,
        cellStyles: true,
        sheetStubs: true,
        sheetRows: 10_000,
    });
    assert.equal(
        Boolean(workbook.Sheets.PaloAlto10?.["!rows"]?.[89]?.hidden),
        true,
        `${label}: pinned Palo row 90 is no longer hidden by its active AutoFilter`
    );
}

function addSentinels(entry: OfficialSCSEMManifestEntry, index: number): AddSentinels {
    const token = `${String(index + 1).padStart(2, "0")}_${entry.sha256.slice(0, 10)}`;
    return {
        proposedValue: `SKYSHIELD_ADD_CONTROL_${token}`,
        nistId: "AC-2",
        nistControlName: `Account Management ${token}`,
        testMethod: "Examine",
        sectionTitle: `Candidate section ${token}`,
        description: `Candidate objective ${token}`,
        testProcedures: `Candidate test procedure ${token}`,
        expectedResults: `Candidate expected result ${token}`,
        findingStatement: `Candidate standard finding statement ${token}`,
        criticality: "Moderate",
        issueCode: "HAC100",
        issueCodeDescription: "HAC100: Other",
        recommendationNum: `SKY-${token}`,
    };
}

function addFieldValues(testId: string, sentinels: AddSentinels): Map<SCSEMColumnField, string> {
    return new Map<SCSEMColumnField, string>([
        ["testId", testId],
        ["nistId", sentinels.nistId],
        ["nistControlName", sentinels.nistControlName],
        ["testMethod", sentinels.testMethod],
        ["sectionTitle", sentinels.sectionTitle],
        ["description", sentinels.description],
        ["testProcedures", sentinels.testProcedures],
        ["expectedResults", sentinels.expectedResults],
        ["findingStatement", sentinels.findingStatement],
        ["criticality", sentinels.criticality],
        ["issueCode", sentinels.issueCode],
        ["issueCodeDescription", sentinels.issueCodeDescription],
        ["recommendationNum", sentinels.recommendationNum],
    ]);
}

function omittedAddFields(
    target: AddTarget,
    testId: string,
    sentinels: AddSentinels,
    exactProfile?: ExactSpecialAddOracleProfile
): SCSEMColumnField[] {
    return [...addFieldValues(testId, sentinels).keys()].filter((field) =>
        !(exactProfile?.compositeDescription && field === "description") &&
        (!target.columns.has(field) || target.duplicateFields.has(field))
    );
}

function expectedDominantConventionTestId(source: ParsedSCSEM, target: AddTarget): string | null {
    const targetIds = source.sheets
        .find((sheet) => sheet.sheetName === target.sheetName)!
        .controls.map((control) => control.testId);
    const prefixCounts = new Map<string, number>();
    for (const testId of targetIds) {
        const prefix = testId.match(/^(.*?)(\d+)$/)?.[1];
        if (prefix !== undefined) prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    }
    const prefix = [...prefixCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
    if (prefix === undefined) return null;

    const suffixes = targetIds
        .map((testId) => testId.match(/^(.*?)(\d+)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match && match[1] === prefix))
        .map((match) => match[2]);
    const widthCounts = new Map<number, number>();
    for (const suffix of suffixes.filter((value) => /^0\d+/.test(value))) {
        widthCounts.set(suffix.length, (widthCounts.get(suffix.length) || 0) + 1);
    }
    const width = [...widthCounts.entries()]
        .sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]?.[0] || 1;
    let nextNumber = Math.max(...suffixes.map((suffix) => Number.parseInt(suffix, 10))) + 1;
    const globallyReserved = new Set(source.sheets.flatMap((sheet) =>
        sheet.controls.map((control) => control.testId)
    ));
    let candidate = `${prefix}${String(nextNumber).padStart(width, "0")}`;
    while (globallyReserved.has(candidate)) {
        nextNumber++;
        candidate = `${prefix}${String(nextNumber).padStart(width, "0")}`;
    }
    return candidate;
}

function buildAddSession(
    entry: OfficialSCSEMManifestEntry,
    parsed: ParsedSCSEM,
    target: AddTarget,
    sentinels: AddSentinels
): SCSEMUpdaterSession {
    return {
        id: `corpus-add-${entry.sha256.slice(0, 16)}`,
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
            testCaseSheets: parsed.sheets
                .filter((sheet) => sheet.sheetType === "test_cases")
                .map((sheet) => sheet.sheetName),
        },
        changes: [{
            id: `corpus-add-${entry.sha256.slice(0, 16)}`,
            status: "APPROVED",
            action: "addControl",
            testId: `SOURCE-${entry.sha256.slice(0, 10)}`,
            targetSheet: target.sheetName,
            field: "newControl",
            currentValue: "",
            proposedValue: sentinels.proposedValue,
            reason: "All-current-SCSEM add-control regression test.",
            confidence: "test",
            sourceEvidence: { sourceSheet: target.sheetName },
            newControl: {
                nistId: sentinels.nistId,
                nistControlName: sentinels.nistControlName,
                testMethod: sentinels.testMethod,
                sectionTitle: sentinels.sectionTitle,
                description: sentinels.description,
                testProcedures: sentinels.testProcedures,
                expectedResults: sentinels.expectedResults,
                findingStatement: sentinels.findingStatement,
                criticality: sentinels.criticality,
                issueCode: sentinels.issueCode,
                recommendationNum: sentinels.recommendationNum,
            },
        }],
        history: [],
        audit: {
            uploadedSha256: entry.sha256,
            uploadedSizeBytes: entry.sizeBytes,
            officialSource: entry,
        },
    };
}

function assertSemanticControlFidelity(
    source: ParsedSCSEM,
    output: ParsedSCSEM,
    candidate: Candidate,
    sentinel: string,
    label: string
) {
    assert.deepEqual(output.metadata, source.metadata, `${label}: workbook metadata changed`);
    assert.equal(output.totalControls, source.totalControls, `${label}: control count changed`);
    assert.equal(output.sheets.length, source.sheets.length, `${label}: parsed sheet count changed`);

    let targetCount = 0;
    for (let index = 0; index < source.sheets.length; index++) {
        const beforeSheet = source.sheets[index];
        const afterSheet = output.sheets[index];
        assert.equal(afterSheet.sheetName, beforeSheet.sheetName, `${label}: sheet order/name changed at ${index}`);
        assert.equal(afterSheet.sheetType, beforeSheet.sheetType, `${label}: sheet type changed for ${beforeSheet.sheetName}`);
        assert.equal(afterSheet.sheetIndex, beforeSheet.sheetIndex, `${label}: sheet index changed for ${beforeSheet.sheetName}`);
        assert.equal(
            afterSheet.controls.length,
            beforeSheet.controls.length,
            `${label}: control count changed on ${beforeSheet.sheetName}`
        );

        for (let controlIndex = 0; controlIndex < beforeSheet.controls.length; controlIndex++) {
            const before = beforeSheet.controls[controlIndex];
            const after = afterSheet.controls[controlIndex];
            const isTarget = beforeSheet.sheetName === candidate.sheetName &&
                before.testId === candidate.testId && before.rowIndex === candidate.rowIndex;
            const expected = { ...before } as Record<string, unknown>;
            if (isTarget) {
                targetCount++;
                expected[candidate.field] = sentinel;
            }
            assert.deepEqual(
                after,
                expected,
                `${label}: unexpected semantic change at ${beforeSheet.sheetName}/${before.testId}`
            );

            for (const field of AGENCY_ASSESSMENT_FIELDS) {
                assert.deepEqual(
                    after[field],
                    before[field],
                    `${label}: agency assessment field ${field} changed at ${beforeSheet.sheetName}/${before.testId}`
                );
            }
        }
    }
    assert.equal(targetCount, 1, `${label}: target control did not resolve exactly once`);
}

function assertAddSemanticFidelity(
    source: ParsedSCSEM,
    output: ParsedSCSEM,
    target: AddTarget,
    sentinels: AddSentinels,
    label: string,
    exactProfile?: ExactSpecialAddOracleProfile
): ParsedControl {
    assert.deepEqual(output.metadata, source.metadata, `${label}: workbook metadata changed`);
    assert.equal(output.totalControls, source.totalControls + 1, `${label}: add-control count is not exactly +1`);
    assert.equal(output.sheets.length, source.sheets.length, `${label}: parsed sheet count changed`);
    let added: ParsedControl | null = null;

    for (let sheetIndex = 0; sheetIndex < source.sheets.length; sheetIndex++) {
        const beforeSheet = source.sheets[sheetIndex];
        const afterSheet = output.sheets[sheetIndex];
        assert.equal(afterSheet.sheetName, beforeSheet.sheetName, `${label}: sheet order/name changed at ${sheetIndex}`);
        assert.equal(afterSheet.sheetType, beforeSheet.sheetType, `${label}: sheet type changed for ${beforeSheet.sheetName}`);
        assert.equal(afterSheet.sheetIndex, beforeSheet.sheetIndex, `${label}: sheet index changed for ${beforeSheet.sheetName}`);
        const expectedCount = beforeSheet.controls.length + (beforeSheet.sheetName === target.sheetName ? 1 : 0);
        assert.equal(afterSheet.controls.length, expectedCount, `${label}: unexpected control count on ${beforeSheet.sheetName}`);
        const expectedExisting = beforeSheet.controls.map((control) => ({ ...control }));
        const actualExisting = afterSheet.controls.slice(0, beforeSheet.controls.length)
            .map((control) => ({ ...control }));
        for (const repair of exactProfile?.formulaRepairs || []) {
            if (repair.sheetName !== beforeSheet.sheetName) continue;
            const repairedRow = XLSX.utils.decode_cell(repair.address).r;
            const expectedControl = expectedExisting.find((control) => control.rowIndex === repairedRow);
            const actualControl = actualExisting.find((control) => control.rowIndex === repairedRow);
            if (expectedControl && actualControl) {
                expectedControl.riskRating = null;
                actualControl.riskRating = null;
            }
        }
        assert.deepEqual(
            actualExisting,
            expectedExisting,
            `${label}: existing controls changed on ${beforeSheet.sheetName}`
        );
        if (beforeSheet.sheetName === target.sheetName) added = afterSheet.controls.at(-1) || null;
    }

    assert.ok(added, `${label}: added control was not reparsed on ${target.sheetName}`);
    assert.ok(added.testId, `${label}: generated Test ID is blank`);
    assert.ok(
        !source.sheets.some((sheet) => sheet.controls.some((control) => control.testId === added!.testId)),
        `${label}: generated Test ID is not unique`
    );
    const expectedTestId = expectedDominantConventionTestId(source, target);
    if (expectedTestId !== null) {
        assert.equal(
            added.testId,
            expectedTestId,
            `${label}: generated Test ID does not preserve the target sheet's prefix/padding convention`
        );
    }
    assert.equal(added.rowIndex, target.row, `${label}: added control did not reuse the selected blank row`);
    for (const [field, value] of addFieldValues(added.testId, sentinels)) {
        if (exactProfile?.compositeDescription && field === "description") {
            assert.equal(added.description, null, `${label}: legacy composite invented a Description column`);
            continue;
        }
        if (exactProfile?.compositeDescription && field === "testProcedures") {
            assert.equal(
                added.testProcedures,
                `Objective:\n${sentinels.description}\n\nTest Procedures:\n${sentinels.testProcedures}`,
                `${label}: legacy Description/Test Procedures composite is not lossless`
            );
            continue;
        }
        assert.deepEqual(
            added[field],
            target.columns.has(field) && !target.duplicateFields.has(field) ? value : null,
            `${label}: new-control field ${field} does not match the target schema`
        );
    }
    for (const field of AGENCY_ASSESSMENT_FIELDS) {
        assert.equal(added[field], null, `${label}: new control agency assessment field ${field} is not blank`);
    }
    return added;
}

function assertParsedChangeLog(
    source: ParsedSCSEM,
    output: ParsedSCSEM,
    logSheetName: string,
    targetTestId: string,
    label: string,
    omittedFields: SCSEMColumnField[] = []
) {
    const before = source.sheets.find((sheet) => sheet.sheetName === logSheetName);
    const after = output.sheets.find((sheet) => sheet.sheetName === logSheetName);
    assert.ok(before && after, `${label}: Change Log sheet could not be reparsed`);
    assert.equal(
        after.changeLogEntries.length,
        before.changeLogEntries.length + 1,
        `${label}: export must append exactly one parsed Change Log entry`
    );
    const appended = after.changeLogEntries.at(-1)!;
    assert.match(
        appended.version,
        /^SCSEM (?:CANDIDATE|DRAFT-INCOMPLETE)\b/i,
        `${label}: Change Log version lacks candidate-state provenance`
    );
    assert.match(
        appended.description,
        /CANDIDATE workbook only; not an official SCSEM release/i,
        `${label}: Change Log lacks the non-release warning`
    );
    assert.match(
        appended.description,
        /1 reviewer-approved SkyShield change\(s\) applied/i,
        `${label}: Change Log summary is missing`
    );
    assert.match(appended.description, new RegExp(targetTestId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${label}: Change Log omits target Test ID`);
    for (const field of omittedFields) {
        assert.match(
            appended.description,
            new RegExp(`omitted optional fields[^.]*\\b${field}\\b`, "i"),
            `${label}: Change Log does not audit omitted optional field ${field}`
        );
    }
}

function assertRawChangeLogFidelity(
    sourceLogXml: string,
    outputLogXml: string,
    targetTestId: string,
    label: string
) {
    const sourceRows = rowNodes(sourceLogXml);
    const outputRows = rowNodes(outputLogXml);
    const changedRows = [...outputRows.entries()].filter(([rowNumber, row]) =>
        sourceRows.get(rowNumber)?.value !== row.value
    );
    assert.equal(changedRows.length, 1, `${label}: export must write exactly one unique Change Log row`);
    assert.ok(
        outputRows.size === sourceRows.size || outputRows.size === sourceRows.size + 1,
        `${label}: Change Log row inventory changed unexpectedly`
    );
    const [appendedRowNumber, appendedRow] = changedRows[0];
    const replacedBlankRow = sourceRows.get(appendedRowNumber);
    if (replacedBlankRow) {
        assert.ok(
            !rowXmlHasMaterialValue(replacedBlankRow.value),
            `${label}: export overwrote a populated Change Log row ${appendedRowNumber}`
        );
    }
    for (const [rowNumber, row] of sourceRows) {
        if (rowNumber === appendedRowNumber) continue;
        assert.equal(outputRows.get(rowNumber)?.value, row.value, `${label}: existing Change Log row ${rowNumber} changed`);
    }
    assert.match(appendedRow.value, /SkyShield/i, `${label}: written Change Log row lacks provenance`);
    assert.match(
        appendedRow.value,
        new RegExp(targetTestId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${label}: written Change Log row omits target Test ID`
    );

    const sourceDimension = dimensionRange(sourceLogXml);
    const outputDimension = dimensionRange(outputLogXml);
    assert.equal(Boolean(outputDimension), Boolean(sourceDimension), `${label}: Change Log dimension appeared/disappeared`);
    if (sourceDimension && outputDimension) {
        assert.deepEqual(outputDimension.s, sourceDimension.s, `${label}: Change Log dimension origin changed`);
        assert.equal(outputDimension.e.c, sourceDimension.e.c, `${label}: Change Log dimension columns changed`);
        assert.equal(
            outputDimension.e.r,
            Math.max(sourceDimension.e.r, appendedRowNumber - 1),
            `${label}: Change Log dimension does not exactly cover the appended row`
        );
    }
    const maskedOutputLog = maskDimension(removeNode(outputLogXml, appendedRow));
    const maskedSourceLog = maskDimension(
        replacedBlankRow ? removeNode(sourceLogXml, replacedBlankRow) : sourceLogXml
    );
    assert.equal(maskedOutputLog, maskedSourceLog, `${label}: Change Log changed beyond its written row and dimension`);
}

async function assertOoxmlFidelity(
    sourceBuffer: Buffer,
    outputBuffer: Buffer,
    candidate: Candidate,
    sentinel: string,
    logSheetName: string,
    label: string
) {
    const sourceZip = await JSZip.loadAsync(sourceBuffer, { checkCRC32: true });
    const outputZip = await JSZip.loadAsync(outputBuffer, { checkCRC32: true });
    const sourceParts = Object.keys(sourceZip.files).sort();
    const outputParts = Object.keys(outputZip.files).sort();
    assert.deepEqual(outputParts, sourceParts, `${label}: OOXML part inventory changed`);

    const sourcePaths = await worksheetPathsByName(sourceZip);
    const outputPaths = await worksheetPathsByName(outputZip);
    assert.deepEqual(outputPaths, sourcePaths, `${label}: worksheet names/order/relationships changed`);
    const targetPath = sourcePaths.get(candidate.sheetName);
    const logPath = sourcePaths.get(logSheetName);
    assert.ok(targetPath, `${label}: target worksheet part is missing`);
    assert.ok(logPath, `${label}: Change Log worksheet part is missing`);
    assert.notEqual(targetPath, logPath, `${label}: target and Change Log unexpectedly share a worksheet part`);

    for (const partName of sourceParts) {
        if (sourceZip.files[partName].dir || partName === targetPath || partName === logPath) continue;
        assert.deepEqual(
            await outputZip.file(partName)!.async("nodebuffer"),
            await sourceZip.file(partName)!.async("nodebuffer"),
            `${label}: unrelated OOXML part changed: ${partName}`
        );
    }

    const sourceWorkbookXml = await sourceZip.file("xl/workbook.xml")!.async("string");
    const outputWorkbookXml = await outputZip.file("xl/workbook.xml")!.async("string");
    assert.deepEqual(
        tagFragments(outputWorkbookXml, "sheets"),
        tagFragments(sourceWorkbookXml, "sheets"),
        `${label}: workbook sheet structure changed`
    );
    assert.deepEqual(
        tagFragments(outputWorkbookXml, "definedNames"),
        tagFragments(sourceWorkbookXml, "definedNames"),
        `${label}: workbook defined names changed`
    );

    for (const [sheetName, worksheetPath] of sourcePaths) {
        const sourceXml = await sourceZip.file(worksheetPath)!.async("string");
        const outputXml = await outputZip.file(worksheetPath)!.async("string");
        assert.deepEqual(
            worksheetFeatureSnapshot(outputXml),
            worksheetFeatureSnapshot(sourceXml),
            `${label}: merges/filters/validation/formatting/protection/drawing/table features changed on ${sheetName}`
        );
        assert.deepEqual(
            formulaCells(outputXml),
            formulaCells(sourceXml),
            `${label}: formulas or cached values changed on ${sheetName}`
        );
    }

    const sourceTargetXml = await sourceZip.file(targetPath)!.async("string");
    const outputTargetXml = await outputZip.file(targetPath)!.async("string");
    const sourceTargetCell = findCellXml(sourceTargetXml, candidate.address);
    const outputTargetCell = findCellXml(outputTargetXml, candidate.address);
    assert.ok(sourceTargetCell && outputTargetCell, `${label}: target cell XML is missing`);
    assert.ok(!/<f\b/i.test(sourceTargetCell.value), `${label}: selected source target contains a formula`);
    assert.ok(!/<f\b/i.test(outputTargetCell.value), `${label}: exported target became a formula`);
    assert.notEqual(outputTargetCell.value, sourceTargetCell.value, `${label}: target cell XML did not change`);
    assert.ok(outputTargetCell.value.includes(sentinel), `${label}: sentinel is absent from target cell XML`);
    assert.equal(
        maskCellXml(outputTargetXml, candidate.address),
        maskCellXml(sourceTargetXml, candidate.address),
        `${label}: target worksheet changed outside ${candidate.sheetName}!${candidate.address}`
    );

    const sourceLogXml = await sourceZip.file(logPath)!.async("string");
    const outputLogXml = await outputZip.file(logPath)!.async("string");
    assertRawChangeLogFidelity(sourceLogXml, outputLogXml, candidate.testId, label);
}

async function assertAddOoxmlFidelity(
    sourceBuffer: Buffer,
    outputBuffer: Buffer,
    target: AddTarget,
    added: ParsedControl,
    sentinels: AddSentinels,
    logSheetName: string,
    label: string,
    exactSpecialProfile?: ExactSpecialAddOracleProfile
) {
    const sourceZip = await JSZip.loadAsync(sourceBuffer, { checkCRC32: true });
    const outputZip = await JSZip.loadAsync(outputBuffer, { checkCRC32: true });
    const sourceParts = Object.keys(sourceZip.files).sort();
    const outputParts = Object.keys(outputZip.files).sort();
    assert.deepEqual(outputParts, sourceParts, `${label}: add-control changed the OOXML part inventory`);

    const sourcePaths = await worksheetPathsByName(sourceZip);
    const outputPaths = await worksheetPathsByName(outputZip);
    assert.deepEqual(outputPaths, sourcePaths, `${label}: add-control changed worksheet names/order/relationships`);
    const targetPath = sourcePaths.get(target.sheetName);
    const logPath = sourcePaths.get(logSheetName);
    assert.ok(targetPath, `${label}: add-control target worksheet part is missing`);
    assert.ok(logPath, `${label}: add-control Change Log worksheet part is missing`);
    assert.notEqual(targetPath, logPath, `${label}: add-control target and Change Log share a worksheet part`);
    const sourceTargetXml = await sourceZip.file(targetPath)!.async("string");

    if (target.sheetName === "Amazon Linux 23 Test Cases" && target.row + 1 === 181) {
        await assertAmazonFooterInsertionOoxml(
            sourceZip,
            outputZip,
            sourcePaths,
            targetPath,
            logPath,
            target,
            added,
            sentinels,
            label
        );
        return;
    }
    const sourceInsertionRow = rowNodes(sourceTargetXml).get(target.row + 1);
    const exactStructuralProfile = EXACT_STRUCTURAL_ADD_ORACLE_PROFILES.get(sha256(sourceBuffer));
    if (
        exactStructuralProfile ||
        (sourceInsertionRow && rowXmlHasNonFormulaMaterialValue(sourceInsertionRow.value))
    ) {
        await assertStructuralFooterInsertionOoxml(
            sourceZip,
            outputZip,
            sourcePaths,
            targetPath,
            logPath,
            target,
            added,
            sentinels,
            label,
            exactStructuralProfile
        );
        return;
    }

    const worksheetParts = new Set(sourcePaths.values());
    for (const partName of sourceParts) {
        if (
            sourceZip.files[partName].dir ||
            worksheetParts.has(partName) ||
            partName === "xl/workbook.xml" ||
            partName === "xl/calcChain.xml"
        ) continue;
        assert.deepEqual(
            await outputZip.file(partName)!.async("nodebuffer"),
            await sourceZip.file(partName)!.async("nodebuffer"),
            `${label}: add-control changed unrelated OOXML part ${partName}`
        );
    }

    const sourceWorkbookXml = await sourceZip.file("xl/workbook.xml")!.async("string");
    const outputWorkbookXml = await outputZip.file("xl/workbook.xml")!.async("string");
    const targetSheetIndex = [...sourcePaths.keys()].indexOf(target.sheetName);
    assert.ok(targetSheetIndex >= 0, `${label}: target sheet index is missing`);
    const repairedSourceTargetXml = expectedFormulaRepairsForSheet(
        sourceTargetXml,
        target.sheetName,
        exactSpecialProfile
    );
    const sparseSourceTargetXml = expectedSparseRowMaterialization(
        repairedSourceTargetXml,
        target,
        exactSpecialProfile
    );
    const sourceHasTargetRow = rowNodes(sparseSourceTargetXml).has(target.row + 1);
    const expectedTargetBaseXml = sourceHasTargetRow
        ? sparseSourceTargetXml
        : expectedWorksheetWithClonedRow(sparseSourceTargetXml, target.row, label);
    const materializedFormulas = expectedMaterializedAppendFormulas(
        sparseSourceTargetXml,
        expectedTargetBaseXml,
        target,
        !sourceHasTargetRow,
        label,
        exactSpecialProfile
    );
    const sourceExcelRow = target.row;
    const targetExcelRow = target.row + 1;
    const expectedTargetAppendXml = expectedWorksheetAppendExtensions(
        materializedFormulas.xml,
        target.sheetName,
        target.sheetName,
        sourceExcelRow,
        targetExcelRow,
        true,
        exactSpecialProfile
    );
    const expectedWorkbookWithAppendNames = expectedWorkbookAppendDefinedNames(
        sourceWorkbookXml,
        [...sourcePaths.keys()],
        target.sheetName,
        sourceExcelRow,
        targetExcelRow
    );
    const expectedFilter = expectedAddFilterExtension(
        expectedTargetAppendXml,
        expectedWorkbookWithAppendNames,
        targetSheetIndex,
        target.row,
        label
    );
    assertForcedCalculation(expectedFilter.workbookXml, outputWorkbookXml, label);
    assert.deepEqual(tagFragments(outputWorkbookXml, "sheets"), tagFragments(sourceWorkbookXml, "sheets"));
    assert.deepEqual(
        tagFragments(outputWorkbookXml, "definedNames"),
        tagFragments(expectedFilter.workbookXml, "definedNames"),
        `${label}: add-control changed workbook defined names beyond exact append/filter extensions`
    );

    for (const [sheetName, worksheetPath] of sourcePaths) {
        const sourceXml = await sourceZip.file(worksheetPath)!.async("string");
        const outputXml = await outputZip.file(worksheetPath)!.async("string");
        const repairedSourceXml = expectedFormulaRepairsForSheet(
            sourceXml,
            sheetName,
            exactSpecialProfile
        );
        const expectedSheetXml = sheetName === target.sheetName
            ? expectedFilter.worksheetXml
            : expectedWorksheetAppendExtensions(
                repairedSourceXml,
                sheetName,
                target.sheetName,
                sourceExcelRow,
                targetExcelRow,
                false,
                exactSpecialProfile
            );
        assert.deepEqual(
            worksheetFeatureSnapshot(outputXml),
            worksheetFeatureSnapshot(expectedSheetXml),
            `${label}: add-control changed worksheet features on ${sheetName}`
        );
        assert.deepEqual(
            formulaCells(outputXml),
            formulaCells(expectedSheetXml),
            `${label}: add-control changed formulas or cached values on ${sheetName}`
        );
        if (sheetName !== target.sheetName && worksheetPath !== logPath) {
            assert.equal(
                outputXml,
                expectedSheetXml,
                `${label}: add-control changed unrelated worksheet XML on ${sheetName}`
            );
        }
    }

    const sourceCalcChain = await sourceZip.file("xl/calcChain.xml")?.async("string");
    const outputCalcChain = await outputZip.file("xl/calcChain.xml")?.async("string");
    assert.equal(Boolean(outputCalcChain), Boolean(sourceCalcChain), `${label}: calcChain part presence changed`);
    if (sourceCalcChain && outputCalcChain) {
        const targetSheetNode = (sourceWorkbookXml.match(/<sheet\b[^>]*\/>/g) || [])
            .find((node) => xmlAttributes(node).get("name") === target.sheetName);
        const targetSheetId = targetSheetNode ? xmlAttributes(targetSheetNode).get("sheetId") : null;
        assert.ok(targetSheetId, `${label}: target sheet ID is missing for calcChain proof`);
        let expectedCalcChain = expectedCalcChainFormulaClones(
                sourceCalcChain,
                targetSheetId,
                materializedFormulas.clonedFormulaAddresses,
                label
            );
        if (exactSpecialProfile?.riskAddress) {
            expectedCalcChain = expectedExplicitRiskCalcChain(
                expectedCalcChain,
                targetSheetId,
                exactSpecialProfile,
                label
            );
        }
        assert.equal(
            outputCalcChain,
            expectedCalcChain,
            `${label}: calcChain formula-clone delta is not exact`
        );
    }

    const outputTargetXml = await outputZip.file(targetPath)!.async("string");
    assertComputedRiskFormulaOoxml(
        expectedFilter.worksheetXml,
        outputTargetXml,
        target,
        label,
        exactSpecialProfile
    );
    assert.equal(
        dimensionRange(outputTargetXml)?.e.r,
        dimensionRange(sourceTargetXml)?.e.r,
        `${label}: add-control changed the target worksheet dimension`
    );
    const sourceRows = rowNodes(expectedFilter.worksheetXml);
    const outputRows = rowNodes(outputTargetXml);
    assert.deepEqual([...outputRows.keys()], [...sourceRows.keys()], `${label}: add-control changed target row inventory`);
    const changedRows = [...outputRows.entries()].filter(([rowNumber, row]) =>
        sourceRows.get(rowNumber)?.value !== row.value
    );
    assert.equal(changedRows.length, 1, `${label}: add-control must change exactly one pre-styled target row`);
    const [changedRowNumber, outputRow] = changedRows[0];
    assert.equal(changedRowNumber, target.row + 1, `${label}: add-control wrote the wrong physical row`);
    const sourceRow = sourceRows.get(changedRowNumber)!;
    assert.ok(
        !rowXmlHasNonFormulaMaterialValue(sourceRow.value),
        `${label}: add-control overwrote a populated target row`
    );

    const sourceCells = cellsByAddress(sourceRow.value);
    const outputCells = cellsByAddress(outputRow.value);
    assert.deepEqual([...outputCells.keys()], [...sourceCells.keys()], `${label}: add-control changed blank-row cell inventory`);
    const expectedRawFieldValues = [...addFieldValues(added.testId, sentinels)]
        .filter(([field]) => !(exactSpecialProfile?.compositeDescription && field === "description"))
        .map(([field, value]) => [
            field,
            exactSpecialProfile?.compositeDescription && field === "testProcedures"
                ? `Objective:\n${sentinels.description}\n\nTest Procedures:\n${sentinels.testProcedures}`
                : value,
        ] as const);
    const expectedAddresses = expectedRawFieldValues
        .filter(([field]) => target.columns.has(field) && !target.duplicateFields.has(field))
        .map(([field, value]) => {
            const col = target.columns.get(field);
            assert.ok(col !== undefined, `${label}: successful add-control target lacks ${field}`);
            return [XLSX.utils.encode_cell({ r: target.row, c: col }), value] as const;
        });
    const changedCellAddresses = [...outputCells].filter(([address, xml]) =>
        sourceCells.get(address) !== xml
    ).map(([address]) => address).sort();
    assert.deepEqual(
        changedCellAddresses,
        expectedAddresses.map(([address]) => address).sort(),
        `${label}: add-control changed cells outside the canonical new-control fields`
    );
    for (const [address, value] of expectedAddresses) {
        assert.ok(outputCells.get(address)?.includes(value), `${label}: ${address} lacks its expected add-control value`);
    }
    assert.equal(
        removeNode(outputTargetXml, outputRow),
        removeNode(expectedFilter.worksheetXml, sourceRow),
        `${label}: add-control changed the target worksheet outside its pre-styled row/AutoFilter extension`
    );

    const sourceLogXml = await sourceZip.file(logPath)!.async("string");
    const outputLogXml = await outputZip.file(logPath)!.async("string");
    assertRawChangeLogFidelity(sourceLogXml, outputLogXml, added.testId, label);
}

async function chooseCandidate(
    entry: OfficialSCSEMManifestEntry,
    parsed: ParsedSCSEM,
    filePath: string,
    sourceZip: JSZip,
    sourcePaths: Map<string, string>,
    label: string
): Promise<Candidate> {
    const candidates = candidateCells(entry, parsed, filePath);
    global.gc?.();
    for (const candidate of candidates) {
        assert.ok(isSCSEMColumnField(candidate.field));
        const worksheetPath = sourcePaths.get(candidate.sheetName);
        if (!worksheetPath) continue;
        const worksheetXml = await sourceZip.file(worksheetPath)?.async("string");
        if (!worksheetXml || worksheetProtectionEnabled(worksheetXml)) continue;
        const cell = findCellXml(worksheetXml, candidate.address);
        if (!cell || /<f\b/i.test(cell.value)) continue;
        return candidate;
    }
    throw new Error(`${label}: no unique, nonempty, non-formula, unmerged, unprotected canonical template field is safe to test`);
}

async function runWorkbook(index: number) {
    const manifest = officialSCSEMManifest();
    const entry = manifest.workbooks[index];
    assert.ok(entry, `Manifest entry ${index} does not exist`);
    const label = `${index + 1}/${manifest.workbooks.length} ${entry.fileName}`;
    const filePath = path.join(ROOT, entry.file);
    const sourceBuffer = fs.readFileSync(filePath);
    assert.equal(sourceBuffer.length, entry.sizeBytes, `${label}: pinned size mismatch`);
    assert.equal(sha256(sourceBuffer), entry.sha256, `${label}: pinned SHA-256 mismatch`);

    const sourceZip = await JSZip.loadAsync(sourceBuffer, { checkCRC32: true });
    const sourcePaths = await worksheetPathsByName(sourceZip);
    const parsed = parseSCSEMFile(filePath);
    assert.equal(parsed.totalControls, entry.totalControls, `${label}: manifest control count mismatch`);
    const candidate = await chooseCandidate(entry, parsed, filePath, sourceZip, sourcePaths, label);
    const sentinel = `SKYSHIELD_EXPORT_REGRESSION_${String(index + 1).padStart(2, "0")}_${entry.sha256.slice(0, 12)}`;
    assert.ok(!sourceBuffer.includes(Buffer.from(sentinel)), `${label}: sentinel already exists in source`);

    const session = buildSession(entry, parsed, candidate, sentinel);
    const outputBuffer = await buildSCSEMUpdaterWorkbookBuffer(session, parsed, filePath);
    assert.notEqual(sha256(outputBuffer), entry.sha256, `${label}: export is byte-identical to source`);
    const outputPath = path.join(
        os.tmpdir(),
        `skyshield-corpus-${process.pid}-${Date.now()}-${safeTempName(entry.fileName)}`
    );
    fs.writeFileSync(outputPath, outputBuffer);
    try {
        assertXmlAndZipIntegrity(outputPath, label);
        const output = parseSCSEMFile(outputPath);
        assertSemanticControlFidelity(parsed, output, candidate, sentinel, label);
        const logSheetName = parsed.sheets.find((sheet) =>
            sheet.sheetName.replace(/\s+/g, " ").trim().toLowerCase() === "change log"
        )?.sheetName;
        assert.ok(logSheetName, `${label}: a canonical Change Log sheet is required for auditable export`);
        assertParsedChangeLog(parsed, output, logSheetName, candidate.testId, label);
        await assertOoxmlFidelity(sourceBuffer, outputBuffer, candidate, sentinel, logSheetName, label);

        const reopened = XLSX.read(outputBuffer, {
            cellFormula: true,
            cellStyles: true,
            sheetStubs: true,
            sheetRows: 10_000,
        });
        assert.deepEqual(reopened.SheetNames, [...sourcePaths.keys()], `${label}: SheetJS reopen changed sheet order`);
        persistValidatedCorpusExport("update", entry.fileName, outputBuffer);
        process.stdout.write(
            `PASS ${label} — ${candidate.sheetName}!${candidate.address} (${candidate.testId}/${candidate.field})\n`
        );
    } finally {
        fs.rmSync(outputPath, { force: true });
    }
}

function expectedUnsupportedAddControl(error: unknown): string | null {
    const message = error instanceof Error ? error.message : String(error);
    const approvedChangeBlock = /Cannot export approved SCSEM change corpus-add-[^:]+: (?:[\s\S]*?(?:has no column|has duplicate columns|has no SCSEM header|has no control row|cannot represent|required NIST or benchmark identifier|was not provided or found|is merged|is protected|uses a structured table|no pre-styled blank row|duplicate row|is hidden|is not blank|outside the worksheet dimension|outside the existing AutoFilter range|is missing|contains a formula))/i;
    const computedRiskBlock = /Cannot export approved SCSEM change corpus-add-[^:]+: [\s\S]*?(?:computed risk (?:cell|formula)|source computed risk cell|formula [A-Z]{1,3}\d+ is self-closing)/i;
    const formulaSafetyBlock = /Cannot export approved SCSEM change corpus-add-[^:]+: [\s\S]*?(?:External workbook and structured table references are unsupported|Three-dimensional worksheet references are unsupported|unsupported OOXML formula type|shared formula requires compound-group handling|self-closing formula has no unique shared master|formula donor cell|formula donor\/target rows|formula donor row|template formula [A-Z]{1,3}\d+ conflicts|formula [A-Z]{1,3}\d+ is not the exact row-translated donor formula)/i;
    const workbookBlock = /Cannot export SCSEM workbook: (?:a writable Change Log sheet is required|Change Log worksheet XML is missing|the Change Log sheet is protected|the Change Log schema is not writable)/i;
    return approvedChangeBlock.test(message) || computedRiskBlock.test(message) ||
        formulaSafetyBlock.test(message) || workbookBlock.test(message)
        ? message
        : null;
}

async function runAddWorkbook(index: number): Promise<boolean> {
    const manifest = officialSCSEMManifest();
    const entry = manifest.workbooks[index];
    assert.ok(entry, `Manifest entry ${index} does not exist`);
    const label = `${index + 1}/${manifest.workbooks.length} ${entry.fileName}`;
    const filePath = path.join(ROOT, entry.file);
    const sourceBuffer = fs.readFileSync(filePath);
    assert.equal(sourceBuffer.length, entry.sizeBytes, `${label}: pinned size mismatch`);
    assert.equal(sha256(sourceBuffer), entry.sha256, `${label}: pinned SHA-256 mismatch`);
    const sourceZip = await JSZip.loadAsync(sourceBuffer, { checkCRC32: true });
    const sourcePaths = await worksheetPathsByName(sourceZip);
    const parsed = parseSCSEMFile(filePath);
    assert.equal(parsed.totalControls, entry.totalControls, `${label}: manifest control count mismatch`);
    const target = chooseAddTarget(entry, parsed, filePath, label);
    assertPaloAltoFilteredAnchorRegression(entry, parsed, filePath, target, label);
    global.gc?.();
    const sentinels = addSentinels(entry, index);
    const session = buildAddSession(entry, parsed, target, sentinels);
    const exactSpecialProfile = EXACT_SPECIAL_ADD_ORACLE_PROFILES.get(entry.sha256);

    let outputBuffer: Buffer;
    try {
        outputBuffer = await buildSCSEMUpdaterWorkbookBuffer(session, parsed, filePath);
    } catch (error) {
        const reason = expectedUnsupportedAddControl(error);
        if (!reason) throw error;
        process.stdout.write(`BLOCKED ${label} — ${reason}\n`);
        return false;
    }
    assert.notEqual(sha256(outputBuffer), entry.sha256, `${label}: add-control export is byte-identical to source`);
    const outputPath = path.join(
        os.tmpdir(),
        `skyshield-corpus-add-${process.pid}-${Date.now()}-${safeTempName(entry.fileName)}`
    );
    fs.writeFileSync(outputPath, outputBuffer);
    try {
        assertXmlAndZipIntegrity(outputPath, `${label} add-control`);
        const output = parseSCSEMFile(outputPath);
        const added = assertAddSemanticFidelity(
            parsed,
            output,
            target,
            sentinels,
            `${label} add-control`,
            exactSpecialProfile
        );
        const logSheetName = parsed.sheets.find((sheet) =>
            sheet.sheetName.replace(/\s+/g, " ").trim().toLowerCase() === "change log"
        )?.sheetName;
        assert.ok(logSheetName, `${label}: a canonical Change Log sheet is required for add-control export`);
        assertParsedChangeLog(
            parsed,
            output,
            logSheetName,
            added.testId,
            `${label} add-control`,
            omittedAddFields(target, added.testId, sentinels, exactSpecialProfile)
        );
        await assertAddOoxmlFidelity(
            sourceBuffer,
            outputBuffer,
            target,
            added,
            sentinels,
            logSheetName,
            `${label} add-control`,
            exactSpecialProfile
        );
        const reopened = XLSX.read(outputBuffer, {
            cellFormula: true,
            cellStyles: true,
            sheetStubs: true,
            sheetRows: 10_000,
        });
        assert.deepEqual(reopened.SheetNames, [...sourcePaths.keys()], `${label}: add-control reopen changed sheet order`);
        persistValidatedCorpusExport("add", entry.fileName, outputBuffer);
        process.stdout.write(`SUPPORTED ${label} — ${target.sheetName}!${target.row + 1} (${added.testId})\n`);
        return true;
    } finally {
        fs.rmSync(outputPath, { force: true });
    }
}

function childIndex(): number | null {
    const flagIndex = process.argv.indexOf("--entry");
    if (flagIndex < 0) return null;
    const index = Number(process.argv[flagIndex + 1]);
    assert.ok(Number.isSafeInteger(index) && index >= 0, "--entry must be a zero-based manifest index");
    return index;
}

function selectedOperation(): CorpusOperation {
    const flagIndex = process.argv.indexOf("--operation");
    if (flagIndex < 0) return "update";
    const operation = process.argv[flagIndex + 1];
    assert.ok(operation === "update" || operation === "add", "--operation must be update or add");
    return operation;
}

function corpusExportArtifacts(operation: CorpusOperation): Array<{
    fileName: string;
    sha256: string;
    sizeBytes: number;
}> {
    const directory = operationFinalExportDir(operation);
    if (!directory || !fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.xls(?:x|m)$/i.test(entry.name))
        .map((entry) => {
            const filePath = path.join(directory, entry.name);
            const bytes = fs.readFileSync(filePath);
            return {
                fileName: entry.name,
                sha256: sha256(bytes),
                sizeBytes: bytes.length,
            };
        })
        .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function writeCorpusReport(
    operation: CorpusOperation,
    results: CorpusResult[],
    expectedWorkbookCount: number
): string | null {
    const directory = requestedReportDir();
    if (!directory) return null;
    fs.mkdirSync(directory, { recursive: true });
    const reportPath = path.join(directory, `scsem-${operation}-corpus-report.json`);
    const counts = {
        supported: results.filter((result) => result.outcome === "supported").length,
        blocked: results.filter((result) => result.outcome === "blocked").length,
        failed: results.filter((result) => result.outcome === "failed").length,
    };
    const exportArtifacts = corpusExportArtifacts(operation);
    const mappedExportArtifacts = exportArtifacts.map((artifact) => {
        const source = results.find((result) =>
            updatedSCSEMFileName(result.fileName) === artifact.fileName
        );
        assert.ok(source, `${operation} export ${artifact.fileName} has no source result mapping`);
        return {
            sourceFileName: source.fileName,
            sourcePath: source.file,
            sourceSha256: source.sha256,
            sourceSizeBytes: source.sizeBytes,
            outputFileName: artifact.fileName,
            outputSha256: artifact.sha256,
            outputSizeBytes: artifact.sizeBytes,
        };
    });
    fs.writeFileSync(reportPath, `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        operation,
        expectedWorkbookCount,
        testedWorkbookCount: results.length,
        counts,
        exportArtifacts: {
            directory: operationFinalExportDir(operation),
            count: mappedExportArtifacts.length,
            files: mappedExportArtifacts,
        },
        results,
    }, null, 2)}\n`);
    return reportPath;
}

function runCorpus(operation: CorpusOperation) {
    const manifest = officialSCSEMManifest();
    assert.equal(manifest.expectedWorkbookCount, 60, "Current IRS corpus must contain exactly 60 workbooks");
    assert.equal(manifest.workbooks.length, 60, "Current IRS corpus must contain exactly 60 manifest entries");
    const failures: string[] = [];
    const results: CorpusResult[] = [];
    let supported = 0;
    let blocked = 0;
    const finalExportDir = operationFinalExportDir(operation);
    if (finalExportDir) {
        const candidateNames = manifest.workbooks.map((entry) => updatedSCSEMFileName(entry.fileName));
        assert.equal(
            new Set(candidateNames.map((name) => name.toLocaleLowerCase("en-US"))).size,
            candidateNames.length,
            `${operation} candidate export filenames are not unique`
        );
        fs.rmSync(finalExportDir, { recursive: true, force: true });
        fs.mkdirSync(finalExportDir, { recursive: true });
    }

    for (let index = 0; index < manifest.workbooks.length; index++) {
        const result = spawnSync(process.execPath, [
            "--expose-gc",
            "--max-old-space-size=4096",
            "--import",
            "tsx",
            SCRIPT_PATH,
            "--entry",
            String(index),
            "--operation",
            operation,
        ], {
            cwd: ROOT,
            env: process.env,
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
        const summaryLine = combinedOutput.split(/\r?\n/).find((line) =>
            /^(?:PASS|SUPPORTED|BLOCKED)\s/.test(line)
        );
        const reason = summaryLine?.split(" — ").slice(1).join(" — ") ||
            combinedOutput || result.error?.message || `child exited with status ${result.status}`;
        if (operation === "add" && result.status === 2) {
            blocked++;
            results.push({
                index: index + 1,
                fileName: manifest.workbooks[index].fileName,
                file: manifest.workbooks[index].file,
                sha256: manifest.workbooks[index].sha256,
                sizeBytes: manifest.workbooks[index].sizeBytes,
                outcome: "blocked",
                reason,
            });
        } else if (result.status === 0) {
            supported++;
            results.push({
                index: index + 1,
                fileName: manifest.workbooks[index].fileName,
                file: manifest.workbooks[index].file,
                sha256: manifest.workbooks[index].sha256,
                sizeBytes: manifest.workbooks[index].sizeBytes,
                outcome: "supported",
                reason,
            });
        } else {
            failures.push(manifest.workbooks[index].fileName);
            results.push({
                index: index + 1,
                fileName: manifest.workbooks[index].fileName,
                file: manifest.workbooks[index].file,
                sha256: manifest.workbooks[index].sha256,
                sizeBytes: manifest.workbooks[index].sizeBytes,
                outcome: "failed",
                reason,
            });
            break;
        }
        if ((index + 1) % 10 === 0) {
            process.stdout.write(
                operation === "add"
                    ? `PROGRESS ${index + 1}/${manifest.workbooks.length} add-control schemas: ${supported} supported, ${blocked} blocked safely.\n`
                    : `PROGRESS ${index + 1}/${manifest.workbooks.length} workbooks passed.\n`
            );
        }
    }

    if (failures.length > 0 && finalExportDir) {
        fs.rmSync(finalExportDir, { recursive: true, force: true });
    }
    const exportArtifacts = corpusExportArtifacts(operation);
    if (finalExportDir && failures.length === 0) {
        assert.equal(
            exportArtifacts.length,
            supported,
            `${operation} persisted export count must equal the supported workbook count`
        );
        process.stdout.write(
            `EXPORTS ${exportArtifacts.length} validated ${operation} workbooks persisted under ${finalExportDir}.\n`
        );
    }
    const reportPath = writeCorpusReport(operation, results, manifest.workbooks.length);
    if (reportPath) process.stdout.write(`REPORT ${reportPath}\n`);
    assert.deepEqual(failures, [], `Corpus export stopped at: ${failures.join(", ")}`);
    if (operation === "add") {
        assert.equal(
            supported,
            manifest.workbooks.length,
            "Every current IRS SCSEM must support exact-profile add-control export"
        );
        assert.equal(blocked, 0, "No current IRS SCSEM may remain safely blocked in the final add-control corpus");
        process.stdout.write(
            `Verified add-control behavior for all ${manifest.workbooks.length} current IRS SCSEMs: ` +
            `${supported} surgically supported, ${blocked} blocked safely.\n`
        );
    } else {
        process.stdout.write(`Verified surgical, auditable export fidelity for all ${manifest.workbooks.length} current IRS SCSEMs.\n`);
    }
}

const selectedIndex = childIndex();
const operation = selectedOperation();
if (selectedIndex === null) {
    runCorpus(operation);
} else {
    const run = operation === "add" ? runAddWorkbook(selectedIndex) : runWorkbook(selectedIndex);
    Promise.resolve(run).then((supported) => {
        if (operation === "add" && supported === false) process.exitCode = 2;
    }).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
