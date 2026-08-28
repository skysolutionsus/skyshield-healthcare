import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import {
    matchSCSEMColumnHeader,
    scsemColumnHeaderSignature,
    scsemWorkbookSheetNamesSignature,
} from '@/lib/scsem-column-schema';

XLSX.set_fs(fs);

export const SCSEM_SHEET_ROW_LIMIT = 10_000;

export interface ParsedSheet {
    sheetName: string;
    sheetType: 'test_cases' | 'dashboard' | 'results' | 'instructions' | 'changelog' | 'appendix' | 'issue_codes' | 'other';
    sheetIndex: number;
    rawData: any[][] | null;
    controls: ParsedControl[];
    changeLogEntries: ParsedChangeLog[];
}

export interface ParsedControl {
    rowIndex: number;
    testId: string;
    nistId: string | null;
    nistControlName: string | null;
    testMethod: string | null;
    sectionTitle: string | null;
    description: string | null;
    testProcedures: string | null;
    expectedResults: string | null;
    actualResults: string | null;
    status: string | null;
    findingStatement: string | null;
    notesEvidence: string | null;
    criticality: string | null;
    issueCode: string | null;
    issueCodeDescription: string | null;
    cisBenchmarkRef: string | null;
    recommendationNum: string | null;
    rationale: string | null;
    impact: string | null;
    remediationProcedure: string | null;
    remediationStatement: string | null;
    capRequestStatement: string | null;
    riskRating: string | null;
    extraColumns: Record<string, any> | null;
}

export interface ParsedChangeLog {
    version: string;
    changeDate: Date;
    description: string;
    changedBy: string | null;
}

export interface ParsedSCSEM {
    metadata: {
        subject: string | null;
        version: string | null;
        effectiveDate: string | null;
    };
    sheets: ParsedSheet[];
    totalControls: number;
}

/**
 * Classify a sheet by its name into our standardized types
 */
function classifySheet(name: string): ParsedSheet['sheetType'] {
    const lower = name.toLowerCase().trim();
    if (lower.includes('test case') || lower.includes('test cases')) return 'test_cases';
    if (lower === 'dashboard') return 'dashboard';
    if (lower === 'results') return 'results';
    if (lower === 'instructions') return 'instructions';
    if (lower.includes('change log') || lower.includes('changelog')) return 'changelog';
    if (lower === 'appendix') return 'appendix';
    if (lower.includes('issue code')) return 'issue_codes';
    // 'New Release Changes' is kept as its own sheet, not merged with changelog
    return 'other';
}

/**
 * Safely convert a cell value to string
 */
function cellStr(val: any): string | null {
    if (val === undefined || val === null || val === '') return null;
    return String(val).trim();
}

/**
 * Some older IRS workbooks have a worksheet !ref that stretches to XFD or
 * row 1,048,576 even though the cells at those coordinates are blank. Passing
 * that inflated range to SheetJS makes it walk millions of empty cells and can
 * cause an otherwise valid SCSEM upload to time out before matching begins.
 *
 * Derive the range from cells that actually contain a value or formula. This
 * leaves the workbook untouched; it only bounds the read performed by the
 * parser.
 */
function meaningfulWorksheetRange(ws: XLSX.WorkSheet): XLSX.Range | undefined {
    let maxRow = -1;
    let maxCol = -1;

    for (const address of Object.keys(ws)) {
        if (address.startsWith('!')) continue;

        const cell = ws[address] as XLSX.CellObject | undefined;
        if (!cell) continue;
        const decoded = XLSX.utils.decode_cell(address);
        // Some IRS sheets populate every remaining Excel header column through
        // XFD with generated labels such as Column16370. They are placeholders,
        // not SCSEM data, and including them would expand every parsed row to
        // 16,384 entries.
        const generatedPlaceholderHeader = decoded.r < 5 &&
            typeof cell.v === 'string' && /^column\s*\d+$/i.test(cell.v.trim());
        if (generatedPlaceholderHeader) continue;
        const hasValue = cell.v !== undefined && cell.v !== null && cell.v !== '';
        const hasFormula = typeof cell.f === 'string' && cell.f.length > 0;
        if (!hasValue && !hasFormula) continue;

        maxRow = Math.max(maxRow, decoded.r);
        maxCol = Math.max(maxCol, decoded.c);
    }

    if (maxRow < 0 || maxCol < 0) return undefined;
    return {
        // Keep A1 as the origin so parsed rowIndex/column positions retain
        // their original workbook coordinates.
        s: { r: 0, c: 0 },
        e: { r: maxRow, c: maxCol },
    };
}

function worksheetRows(ws: XLSX.WorkSheet): any[][] {
    const range = meaningfulWorksheetRange(ws);
    if (!range) return [];

    return XLSX.utils.sheet_to_json(ws, {
        header: 1,
        blankrows: false,
        defval: '',
        range,
    }) as any[][];
}

/**
 * Convert Excel serial date to JS Date
 */
function excelDateToJS(serial: number): Date {
    // Excel epoch: Jan 0, 1900 (with the Lotus 1-2-3 bug for Feb 29, 1900)
    const excelEpoch = new Date(1899, 11, 30);
    return new Date(excelEpoch.getTime() + serial * 86400000);
}

/**
 * Parse a date from various formats, returning a proper Date
 */
function parseChangeDate(val: any): Date | null {
    if (!val) return null;
    if (val instanceof Date) return val;
    if (typeof val === 'number' && val > 1000) return excelDateToJS(val);

    const str = String(val).trim();
    if (!str) return null;

    // Try ISO/standard date parse
    const d = new Date(str);
    if (!isNaN(d.getTime()) && d.getFullYear() > 1990) return d;

    // Try MM/DD/YYYY
    const match = str.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (match) {
        const year = match[3].length === 2 ? 2000 + parseInt(match[3]) : parseInt(match[3]);
        return new Date(year, parseInt(match[1]) - 1, parseInt(match[2]));
    }

    return null;
}

/**
 * Parse a "Test Cases" sheet into structured control records using dynamic header detection
 */
function parseTestCaseSheet(
    ws: XLSX.WorkSheet,
    existingRows?: any[][],
    schemaContext?: {
        workbookSha256: string;
        sheetName: string;
        workbookSheetNamesSignature: string;
    }
): ParsedControl[] {
    const data = existingRows || worksheetRows(ws);
    const controls: ParsedControl[] = [];

    // Find the header row (look for "Test ID" somewhere in first 5 rows)
    let headerRow = -1;
    const columnMapping: Map<number, keyof ParsedControl> = new Map();
    const unmappedHeaders: Map<number, string> = new Map();

    for (let i = 0; i < Math.min(5, data.length); i++) {
        const row = data[i] as any[];
        const firstCell = cellStr(row[0]);
        if (firstCell && firstCell.toLowerCase().includes('test id')) {
            headerRow = i;
            const headerSignature = scsemColumnHeaderSignature(row);

            // Build column mapping from headers
            for (let j = 0; j < row.length; j++) {
                const header = cellStr(row[j]);
                if (!header) continue;

                const field = matchSCSEMColumnHeader(header, schemaContext ? {
                    ...schemaContext,
                    headerRow: i,
                    columnIndex: j,
                    headerSignature,
                } : undefined);
                if (field) {
                    // Don't overwrite if already mapped (first match wins for duplicates)
                    if (![...columnMapping.values()].includes(field)) {
                        columnMapping.set(j, field);
                    }
                } else if (!header.toLowerCase().startsWith('column')) {
                    unmappedHeaders.set(j, header);
                }
            }
            break;
        }
    }

    if (headerRow === -1) return controls;

    // Parse all data rows after the header
    for (let i = headerRow + 1; i < data.length; i++) {
        const row = data[i] as any[];
        const testId = cellStr(row[0]);

        if (!testId) continue;
        if (testId.toLowerCase() === 'test cases' || testId.toLowerCase() === 'test id') continue;

        const control: ParsedControl = {
            rowIndex: i,
            testId,
            nistId: null, nistControlName: null, testMethod: null, sectionTitle: null,
            description: null, testProcedures: null, expectedResults: null, actualResults: null,
            status: null, findingStatement: null, notesEvidence: null, criticality: null,
            issueCode: null, issueCodeDescription: null, cisBenchmarkRef: null,
            recommendationNum: null, rationale: null, impact: null,
            remediationProcedure: null, remediationStatement: null, capRequestStatement: null,
            riskRating: null, extraColumns: null,
        };

        // Fill mapped columns
        for (const [colIdx, field] of columnMapping) {
            const val = cellStr(row[colIdx]);
            if (val && field !== 'rowIndex' && field !== 'extraColumns') {
                (control as any)[field] = val;
            }
        }

        // Collect unmapped columns with data
        const extra: Record<string, any> = {};
        for (const [colIdx, header] of unmappedHeaders) {
            const val = cellStr(row[colIdx]);
            if (val) extra[header] = val;
        }
        if (Object.keys(extra).length > 0) {
            control.extraColumns = extra;
        }

        controls.push(control);
    }

    return controls;
}

/**
 * Parse a "Change Log" sheet into structured entries
 */
function parseChangeLogSheet(ws: XLSX.WorkSheet, existingRows?: any[][]): ParsedChangeLog[] {
    const data = existingRows || worksheetRows(ws);
    const entries: ParsedChangeLog[] = [];

    // Find header row — scan each row fully before deciding
    let headerRow = -1;
    let dateCol = -1, versionCol = -1, descCol = -1, authorCol = -1;

    for (let i = 0; i < Math.min(10, data.length); i++) {
        let foundHeaderCols = 0;
        for (let j = 0; j < (data[i] as any[]).length; j++) {
            const val = cellStr(data[i][j])?.toLowerCase();
            if (!val) continue;
            if (val === 'date' || val === 'release date') { dateCol = j; foundHeaderCols++; }
            else if (val === 'version' || val === 'ver' || val === 'ver.') { versionCol = j; foundHeaderCols++; }
            else if (val.includes('description') || val === 'changes') { descCol = j; foundHeaderCols++; }
            else if (val.includes('author') || val.includes('changed by') || val.includes('updated by')) { authorCol = j; foundHeaderCols++; }
        }
        if (foundHeaderCols >= 2) {
            headerRow = i;
            break;
        }
    }

    // Fallback: detect by looking for a row with numeric version + serial date
    if (headerRow === -1) {
        for (let i = 0; i < Math.min(10, data.length); i++) {
            if (typeof data[i][0] === 'number' && typeof data[i][1] === 'number' && data[i][1] > 30000) {
                headerRow = i - 1;
                versionCol = 0; dateCol = 1; descCol = 2; authorCol = 3;
                break;
            }
        }
    }

    if (headerRow === -1) return entries;

    if (versionCol === -1) versionCol = 0;
    if (dateCol === -1) dateCol = 1;
    if (descCol === -1) descCol = 2;
    if (authorCol === -1) authorCol = 3;

    for (let i = headerRow + 1; i < data.length; i++) {
        const row = data[i] as any[];
        const dateVal = row[dateCol];
        const versionVal = cellStr(row[versionCol]);
        const descVal = cellStr(row[descCol]);
        const authorVal = cellStr(row[authorCol]);

        if (!dateVal && !versionVal && !descVal) continue;

        const changeDate = parseChangeDate(dateVal);
        if (!changeDate) continue;

        entries.push({
            version: versionVal || 'Unknown',
            changeDate,
            description: descVal || 'Version update',
            changedBy: authorVal,
        });
    }

    return entries;
}

/**
 * Extract dashboard metadata from the Dashboard sheet
 */
function parseDashboardMetadata(ws: XLSX.WorkSheet, existingRows?: any[][]): ParsedSCSEM['metadata'] {
    const data = existingRows || worksheetRows(ws);
    const metadata: ParsedSCSEM['metadata'] = { subject: null, version: null, effectiveDate: null };

    const extractMetadataDate = (value: string): string | null => {
        const labeledDate = value.match(/\b(?:SCSEM\s+)?(?:Effective|Release)\s+Date:\s*(.+)$/i)
            || value.match(/^Date:\s*(.+)$/i);
        if (!labeledDate) return null;

        const source = labeledDate[1].trim();
        const numericDate = source.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/);
        if (numericDate) return numericDate[0];

        const monthNameDate = source.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/i);
        return monthNameDate?.[0].replace(/\s+/g, ' ').replace(/(\d{1,2}),?\s+(\d{4})$/, '$1, $2') || null;
    };

    for (const row of data.slice(0, 20)) {
        for (const cell of (row as any[])) {
            const str = cellStr(cell);
            if (!str) continue;
            if (str.includes('SCSEM Subject:')) {
                metadata.subject = str.replace(/.*SCSEM Subject:\s*/i, '').trim();
            }
            if (str.includes('SCSEM Version:')) {
                metadata.version = str.replace(/.*SCSEM Version:\s*/i, '').trim();
            }
            if (str.includes('Effective Date:') || str.includes('Release Date:') || str.match(/^Date:/i)) {
                const parsedDate = extractMetadataDate(str);
                if (parsedDate) metadata.effectiveDate = parsedDate;
            }
        }
    }

    return metadata;
}

/**
 * Parse a complete SCSEM XLSX file into structured data
 */
export function parseSCSEMFile(filePath: string): ParsedSCSEM {
    const fullPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(/* turbopackIgnore: true */ process.cwd(), filePath);

    if (!fs.existsSync(fullPath)) {
        throw new Error(`SCSEM file not found: ${fullPath}`);
    }

    // Current IRS workbooks can contain hundreds of thousands of empty styled
    // rows (one RHEL tab declares all 1,048,576 Excel rows). SCSEM control
    // tables are far smaller; bounding the XML reader prevents those empty row
    // records from exhausting server memory while retaining original row
    // coordinates for every supported template.
    const sourceBuffer = fs.readFileSync(fullPath);
    const workbookSha256 = createHash('sha256').update(sourceBuffer).digest('hex');
    const wb = XLSX.read(sourceBuffer, { sheetRows: SCSEM_SHEET_ROW_LIMIT });
    const workbookSheetNamesSignature = scsemWorkbookSheetNamesSignature(wb.SheetNames);
    const sheets: ParsedSheet[] = [];
    let totalControls = 0;
    let metadata: ParsedSCSEM['metadata'] = { subject: null, version: null, effectiveDate: null };

    for (let idx = 0; idx < wb.SheetNames.length; idx++) {
        const sheetName = wb.SheetNames[idx];
        const ws = wb.Sheets[sheetName];
        const sheetType = classifySheet(sheetName);

        // Always capture raw data for every sheet so nothing is lost
        const allRows = worksheetRows(ws);

        const parsed: ParsedSheet = {
            sheetName,
            sheetType,
            sheetIndex: idx,
            rawData: allRows,
            controls: [],
            changeLogEntries: [],
        };

        // Parse structured data where applicable
        if (sheetType === 'dashboard') {
            metadata = parseDashboardMetadata(ws, allRows);
        } else if (sheetType === 'test_cases') {
            parsed.controls = parseTestCaseSheet(ws, allRows, {
                workbookSha256,
                sheetName,
                workbookSheetNamesSignature,
            });
            totalControls += parsed.controls.length;
        } else if (sheetType === 'changelog') {
            parsed.changeLogEntries = parseChangeLogSheet(ws, allRows);
        } else if (sheetType === 'other') {
            // Auto-detect: probe content for test case headers
            // Many SCSEM files have technology-specific sheets (e.g. "Tomcat9", "IIS10", "Docker")
            for (let r = 0; r < Math.min(5, allRows.length); r++) {
                const firstCell = cellStr(allRows[r]?.[0]);
                if (firstCell && firstCell.toLowerCase().includes('test id')) {
                    parsed.sheetType = 'test_cases';
                    parsed.controls = parseTestCaseSheet(ws, allRows, {
                        workbookSha256,
                        sheetName,
                        workbookSheetNamesSignature,
                    });
                    totalControls += parsed.controls.length;
                    break;
                }
            }
        }

        sheets.push(parsed);
    }

    return { metadata, sheets, totalControls };
}

/**
 * Parse all SCSEM files from the data directory
 */
export function parseAllSCSEMFiles(indexPath: string): Map<string, ParsedSCSEM> {
    const fullIndexPath = path.isAbsolute(indexPath) ? indexPath : path.join(process.cwd(), indexPath);
    const index = JSON.parse(fs.readFileSync(fullIndexPath, 'utf-8'));
    const results = new Map<string, ParsedSCSEM>();

    for (const entry of index) {
        try {
            const parsed = parseSCSEMFile(entry.file);
            results.set(entry.file, parsed);
            console.log(`  ✓ ${entry.name}: ${parsed.totalControls} controls, ${parsed.sheets.length} sheets`);
        } catch (err: any) {
            console.error(`  ✗ ${entry.name}: ${err.message}`);
        }
    }

    return results;
}
