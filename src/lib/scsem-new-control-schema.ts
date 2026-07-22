import * as fs from "node:fs";
import * as XLSX from "xlsx";
import {
    matchSCSEMColumnHeader,
    scsemColumnHeaderSignature,
    scsemWorkbookSheetNamesSignature,
    type SCSEMColumnField,
} from "@/lib/scsem-column-schema";

export type SCSEMNewControlTargetSchema = {
    sheetName: string;
    findingStatement: "absent" | "unique" | "ambiguous";
};

function cellText(worksheet: XLSX.WorkSheet, row: number, col: number): string {
    const value = worksheet[XLSX.utils.encode_cell({ r: row, c: col })]?.v;
    return value === undefined || value === null ? "" : String(value).trim();
}

function inspectTargetSheet(
    workbook: XLSX.WorkBook,
    workbookSha256: string,
    sheetName: string
): SCSEMNewControlTargetSchema {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet?.["!ref"]) {
        throw new Error(`The selected target sheet ${sheetName} is missing or has no worksheet dimension.`);
    }
    const range = XLSX.utils.decode_range(worksheet["!ref"]);
    const workbookSheetNamesSignature = scsemWorkbookSheetNamesSignature(workbook.SheetNames);

    for (let row = range.s.r; row <= Math.min(range.e.r, range.s.r + 15); row++) {
        const headerSignature = scsemColumnHeaderSignature(
            Array.from({ length: range.e.c + 1 }, (_, col) => cellText(worksheet, row, col))
        );
        const counts = new Map<SCSEMColumnField, number>();
        for (let col = range.s.c; col <= range.e.c; col++) {
            const field = matchSCSEMColumnHeader(cellText(worksheet, row, col), {
                workbookSha256,
                sheetName,
                headerRow: row,
                columnIndex: col,
                headerSignature,
                workbookSheetNamesSignature,
            });
            if (field) counts.set(field, (counts.get(field) || 0) + 1);
        }
        if ((counts.get("testId") || 0) === 0) continue;
        const findingColumns = counts.get("findingStatement") || 0;
        return {
            sheetName,
            findingStatement:
                findingColumns === 0 ? "absent" : findingColumns === 1 ? "unique" : "ambiguous",
        };
    }

    throw new Error(`The selected target sheet ${sheetName} has no uniquely identifiable SCSEM header row.`);
}

export function readSCSEMNewControlTargetSchemas(
    absolutePath: string,
    workbookSha256: string,
    sheetNames: ReadonlyArray<string>
): Map<string, SCSEMNewControlTargetSchema> {
    const workbook = XLSX.read(fs.readFileSync(absolutePath), {
        type: "buffer",
        sheetRows: 20,
        cellFormula: true,
    });
    return new Map(
        [...new Set(sheetNames)].map((sheetName) => [
            sheetName,
            inspectTargetSheet(workbook, workbookSha256.toLowerCase(), sheetName),
        ])
    );
}
