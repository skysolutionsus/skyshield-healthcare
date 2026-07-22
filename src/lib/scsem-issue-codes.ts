import * as fs from "node:fs";
import * as XLSX from "xlsx";

XLSX.set_fs(fs);

const ISSUE_CODE_SHEET = "Issue Code Table";
const ISSUE_CODE_PATTERN = /^[A-Z]{2,5}\d+$/;
const MAX_SELECTED_ISSUE_CODES = 10;

export interface SCSEMIssueCodeEntry {
    code: string;
    description: string;
    weight: number;
    row: number;
}

export interface SCSEMIssueCodeSelection {
    issueCode: string;
    issueCodeDescription: string;
    entries: SCSEMIssueCodeEntry[];
}

export class SCSEMIssueCodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SCSEMIssueCodeError";
    }
}

function normalizedHeader(value: unknown): string {
    return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function requiredCellText(
    worksheet: XLSX.WorkSheet,
    address: string,
    label: string
): string {
    const value = String(worksheet[address]?.v ?? "").trim();
    if (!value) {
        throw new SCSEMIssueCodeError(
            `The ${ISSUE_CODE_SHEET} has a blank ${label} at ${address}.`
        );
    }
    return value;
}

export function readSCSEMIssueCodeCatalogFromWorkbook(
    workbook: XLSX.WorkBook
): Map<string, SCSEMIssueCodeEntry> {
    const worksheet = workbook.Sheets[ISSUE_CODE_SHEET];
    if (!worksheet) {
        throw new SCSEMIssueCodeError(
            `The workbook does not contain the required ${ISSUE_CODE_SHEET}.`
        );
    }
    if (
        normalizedHeader(worksheet.A1?.v) !== "issue code" ||
        normalizedHeader(worksheet.B1?.v) !== "description" ||
        normalizedHeader(worksheet.C1?.v) !== "weight"
    ) {
        throw new SCSEMIssueCodeError(
            `The ${ISSUE_CODE_SHEET} A1:C1 schema is not recognized.`
        );
    }

    const range = worksheet["!ref"] ? XLSX.utils.decode_range(worksheet["!ref"]) : null;
    if (!range || range.e.r < 1) {
        throw new SCSEMIssueCodeError(`${ISSUE_CODE_SHEET} contains no issue codes.`);
    }

    const catalog = new Map<string, SCSEMIssueCodeEntry>();
    for (let zeroBasedRow = 1; zeroBasedRow <= range.e.r; zeroBasedRow++) {
        const excelRow = zeroBasedRow + 1;
        const codeAddress = `A${excelRow}`;
        const descriptionAddress = `B${excelRow}`;
        const weightAddress = `C${excelRow}`;
        const rawCode = String(worksheet[codeAddress]?.v ?? "").trim();
        const rawDescription = String(worksheet[descriptionAddress]?.v ?? "").trim();
        const rawWeight = worksheet[weightAddress]?.v;
        if (!rawCode && !rawDescription && (rawWeight === undefined || rawWeight === null || rawWeight === "")) {
            continue;
        }

        const code = requiredCellText(worksheet, codeAddress, "issue code").toUpperCase();
        const description = requiredCellText(
            worksheet,
            descriptionAddress,
            "issue-code description"
        );
        const weight = Number(rawWeight);
        if (!ISSUE_CODE_PATTERN.test(code)) {
            throw new SCSEMIssueCodeError(
                `${ISSUE_CODE_SHEET} contains an unsupported issue code at ${codeAddress}.`
            );
        }
        if (!Number.isFinite(weight)) {
            throw new SCSEMIssueCodeError(
                `${ISSUE_CODE_SHEET} contains an invalid risk weight at ${weightAddress}.`
            );
        }
        if (catalog.has(code)) {
            throw new SCSEMIssueCodeError(
                `${ISSUE_CODE_SHEET} contains a duplicate issue code ${code}.`
            );
        }
        catalog.set(code, { code, description, weight, row: excelRow });
    }

    if (catalog.size === 0) {
        throw new SCSEMIssueCodeError(`${ISSUE_CODE_SHEET} contains no issue codes.`);
    }
    return catalog;
}

export function readSCSEMIssueCodeCatalog(
    filePath: string
): Map<string, SCSEMIssueCodeEntry> {
    return readSCSEMIssueCodeCatalogFromWorkbook(
        XLSX.readFile(filePath, { cellFormula: true, cellDates: false })
    );
}

export function resolveSCSEMIssueCodeSelection(
    catalog: ReadonlyMap<string, SCSEMIssueCodeEntry>,
    value: unknown
): SCSEMIssueCodeSelection {
    if (typeof value !== "string" || !value.trim()) {
        throw new SCSEMIssueCodeError(
            "A reviewer-selected issue code is required for a new canonical control."
        );
    }
    // Existing IRS templates represent multiple mappings as one code per line.
    // Comma/semicolon guessing is intentionally rejected because descriptions
    // themselves contain punctuation and silent token repair can select a
    // different risk mapping.
    const codes = value
        .split(/\r?\n/)
        .map((code) => code.trim().toUpperCase())
        .filter(Boolean);
    if (codes.length === 0 || codes.length > MAX_SELECTED_ISSUE_CODES) {
        throw new SCSEMIssueCodeError(
            `Select between 1 and ${MAX_SELECTED_ISSUE_CODES} issue codes, one per line.`
        );
    }
    if (new Set(codes).size !== codes.length) {
        throw new SCSEMIssueCodeError("The selected issue-code list contains a duplicate.");
    }

    const entries = codes.map((code) => {
        if (!ISSUE_CODE_PATTERN.test(code)) {
            throw new SCSEMIssueCodeError(
                `Issue code ${code} is not in the expected IRS issue-code format.`
            );
        }
        const entry = catalog.get(code);
        if (!entry) {
            throw new SCSEMIssueCodeError(
                `Issue code ${code} is not present in this workbook's ${ISSUE_CODE_SHEET}.`
            );
        }
        return entry;
    });

    return {
        issueCode: entries.map((entry) => entry.code).join("\n"),
        issueCodeDescription: entries
            .map((entry) => `${entry.code}: ${entry.description}`)
            .join("\n"),
        entries,
    };
}

export function resolveSCSEMIssueCodeSelectionFromWorkbook(
    workbook: XLSX.WorkBook,
    value: unknown
): SCSEMIssueCodeSelection {
    return resolveSCSEMIssueCodeSelection(
        readSCSEMIssueCodeCatalogFromWorkbook(workbook),
        value
    );
}
