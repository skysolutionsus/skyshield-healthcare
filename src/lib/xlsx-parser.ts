import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';

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
    description: string | null;
    testProcedures: string | null;
    expectedResults: string | null;
    actualResults: string | null;
    status: string | null;
    notesEvidence: string | null;
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
    if (lower.includes('new release')) return 'changelog';
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
 * Try to parse a date from various formats
 */
function parseChangeDate(val: any): Date | null {
    if (!val) return null;

    // If it's already a Date or number (Excel serial date)
    if (val instanceof Date) return val;
    if (typeof val === 'number') {
        // Excel serial date conversion
        const excelEpoch = new Date(1899, 11, 30);
        return new Date(excelEpoch.getTime() + val * 86400000);
    }

    // Try parsing as string
    const str = String(val).trim();
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d;

    // Try MM/DD/YYYY format
    const match = str.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (match) {
        const year = match[3].length === 2 ? 2000 + parseInt(match[3]) : parseInt(match[3]);
        return new Date(year, parseInt(match[1]) - 1, parseInt(match[2]));
    }

    return new Date();
}

/**
 * Parse a "Test Cases" sheet into structured control records
 */
function parseTestCaseSheet(ws: XLSX.WorkSheet): ParsedControl[] {
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' }) as any[][];
    const controls: ParsedControl[] = [];

    // Find the header row (contains "Test ID" in first column)
    let headerRow = -1;
    let extraHeaders: string[] = [];

    for (let i = 0; i < Math.min(10, data.length); i++) {
        const firstCell = cellStr(data[i][0]);
        if (firstCell && (firstCell.toLowerCase().includes('test id') || firstCell.toLowerCase() === 'test id')) {
            headerRow = i;
            // Capture any extra column headers beyond the standard 10
            if (data[i].length > 10) {
                extraHeaders = data[i].slice(10).map((h: any) => cellStr(h) || `Column ${data[i].indexOf(h)}`);
            }
            break;
        }
    }

    if (headerRow === -1) {
        // No header found — try to parse from row 1 assuming row 0 is a title
        headerRow = 0;
    }

    // Parse all data rows after the header
    for (let i = headerRow + 1; i < data.length; i++) {
        const row = data[i];
        const testId = cellStr(row[0]);

        // Skip empty rows or rows that are just spacing
        if (!testId) continue;
        // Skip if it looks like a section header (no NIST ID, no description)
        if (testId.toLowerCase() === 'test cases' || testId.toLowerCase() === 'test id') continue;

        const control: ParsedControl = {
            rowIndex: i,
            testId: testId,
            nistId: cellStr(row[1]),
            nistControlName: cellStr(row[2]),
            testMethod: cellStr(row[3]),
            description: cellStr(row[4]),
            testProcedures: cellStr(row[5]),
            expectedResults: cellStr(row[6]),
            actualResults: cellStr(row[7]),
            status: cellStr(row[8]),
            notesEvidence: cellStr(row[9]),
            extraColumns: null,
        };

        // Capture extra columns if any
        if (row.length > 10 && extraHeaders.length > 0) {
            const extra: Record<string, any> = {};
            for (let j = 10; j < row.length; j++) {
                const header = extraHeaders[j - 10] || `Column ${j}`;
                const val = cellStr(row[j]);
                if (val) extra[header] = val;
            }
            if (Object.keys(extra).length > 0) {
                control.extraColumns = extra;
            }
        }

        controls.push(control);
    }

    return controls;
}

/**
 * Parse a "Change Log" sheet into structured entries
 */
function parseChangeLogSheet(ws: XLSX.WorkSheet): ParsedChangeLog[] {
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' }) as any[][];
    const entries: ParsedChangeLog[] = [];

    // Find header row — scan each row fully before deciding
    let headerRow = -1;
    let dateCol = -1, versionCol = -1, descCol = -1, authorCol = -1;

    for (let i = 0; i < Math.min(10, data.length); i++) {
        let foundHeaderCols = 0;
        for (let j = 0; j < data[i].length; j++) {
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

    // Fallback: assume standard 4-column layout (Version, Date, Description, Author)
    if (headerRow === -1) {
        // Try to detect by looking for a row with a number (version) followed by a serial date
        for (let i = 0; i < Math.min(10, data.length); i++) {
            if (typeof data[i][0] === 'number' && typeof data[i][1] === 'number' && data[i][1] > 30000) {
                headerRow = i - 1;
                versionCol = 0;
                dateCol = 1;
                descCol = 2;
                authorCol = 3;
                break;
            }
        }
    }

    if (headerRow === -1) return entries;

    // Default column positions if not all were found
    if (versionCol === -1) versionCol = 0;
    if (dateCol === -1) dateCol = 1;
    if (descCol === -1) descCol = 2;
    if (authorCol === -1) authorCol = 3;

    for (let i = headerRow + 1; i < data.length; i++) {
        const row = data[i];
        const dateVal = row[dateCol];
        const versionVal = cellStr(row[versionCol]);
        const descVal = cellStr(row[descCol]);
        const authorVal = cellStr(row[authorCol]);

        // Skip empty rows
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
function parseDashboardMetadata(ws: XLSX.WorkSheet): ParsedSCSEM['metadata'] {
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[][];
    const metadata: ParsedSCSEM['metadata'] = { subject: null, version: null, effectiveDate: null };

    for (const row of data.slice(0, 20)) {
        for (const cell of row) {
            const str = cellStr(cell);
            if (!str) continue;
            if (str.includes('SCSEM Subject:')) {
                metadata.subject = str.replace(/.*SCSEM Subject:\s*/i, '').trim();
            }
            if (str.includes('SCSEM Version:')) {
                metadata.version = str.replace(/.*SCSEM Version:\s*/i, '').trim();
            }
            if (str.includes('Effective Date:') || str.includes('Date:')) {
                const dateMatch = str.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
                if (dateMatch) metadata.effectiveDate = dateMatch[1];
            }
        }
    }

    return metadata;
}

/**
 * Safely read a sheet as JSON array, filtering out blank rows and capping size
 */
function safeSheetToJson(ws: XLSX.WorkSheet, maxRows: number = 500): any[][] {
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' }) as any[][];
    // Filter out rows that are entirely empty strings
    const filtered = data.filter(row =>
        row.some((cell: any) => cell !== '' && cell !== null && cell !== undefined)
    );
    return filtered.slice(0, maxRows);
}

/**
 * Parse a complete SCSEM XLSX file into structured data
 */
export function parseSCSEMFile(filePath: string): ParsedSCSEM {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

    if (!fs.existsSync(fullPath)) {
        throw new Error(`SCSEM file not found: ${fullPath}`);
    }

    const wb = XLSX.readFile(fullPath);
    const sheets: ParsedSheet[] = [];
    let totalControls = 0;
    let metadata: ParsedSCSEM['metadata'] = { subject: null, version: null, effectiveDate: null };

    for (let idx = 0; idx < wb.SheetNames.length; idx++) {
        const sheetName = wb.SheetNames[idx];
        const ws = wb.Sheets[sheetName];
        const sheetType = classifySheet(sheetName);

        const parsed: ParsedSheet = {
            sheetName,
            sheetType,
            sheetIndex: idx,
            rawData: null,
            controls: [],
            changeLogEntries: [],
        };

        if (sheetType === 'dashboard') {
            metadata = parseDashboardMetadata(ws);
            parsed.rawData = safeSheetToJson(ws, 100);
        } else if (sheetType === 'test_cases') {
            parsed.controls = parseTestCaseSheet(ws);
            totalControls += parsed.controls.length;
        } else if (sheetType === 'changelog') {
            parsed.changeLogEntries = parseChangeLogSheet(ws);
            parsed.rawData = safeSheetToJson(ws, 200);
        } else if (sheetType === 'issue_codes') {
            // Issue code tables can be huge — skip raw data, just note the type
            parsed.rawData = null;
        } else {
            // Results, Instructions, Appendix — store capped raw data
            parsed.rawData = safeSheetToJson(ws, 200);
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
