const EXCEL_MAX_ROW = 1_048_576;
const EXCEL_MAX_COLUMN = 16_384;

export type SCSEMFormulaTranslationErrorCode =
    | "INVALID_TRANSLATION_ARGUMENT"
    | "INVALID_A1_REFERENCE"
    | "MALFORMED_FORMULA"
    | "UNSUPPORTED_BRACKET_REFERENCE"
    | "UNSUPPORTED_3D_REFERENCE"
    | "UNSUPPORTED_FORMULA_TYPE";

/**
 * A formula translation failure is deliberately fatal. Raw OOXML surgery must
 * never silently leave a reference behind when its meaning is uncertain.
 */
export class SCSEMFormulaTranslationError extends Error {
    readonly code: SCSEMFormulaTranslationErrorCode;
    readonly formulaIndex?: number;

    constructor(
        code: SCSEMFormulaTranslationErrorCode,
        message: string,
        formulaIndex?: number
    ) {
        super(message);
        this.name = "SCSEMFormulaTranslationError";
        this.code = code;
        this.formulaIndex = formulaIndex;
    }
}

export interface SCSEMFormulaContext {
    /** The value of an OOXML `<f t="...">` attribute, when present. */
    formulaType?: string | null;
}

export interface SCSEMInsertedRowsFormulaOptions extends SCSEMFormulaContext {
    /** Worksheet containing the formula cell (plain name or quoted formula name). */
    formulaSheet: string;
    /** Worksheet receiving the structural row insertion. */
    insertedSheet: string;
    /** Number of worksheet rows inserted. Defaults to one. */
    rowCount?: number;
    /**
     * Extend `A1:B9` to `A1:B10` when a row is inserted at row 10.
     * This is opt-in because Excel's desired behavior at an adjacent range
     * boundary depends on the worksheet operation being modeled.
     */
    extendRangesEndingBeforeInsertion?: boolean;
}

export interface SCSEMAppendedRowFormulaOptions extends SCSEMFormulaContext {
    /** Worksheet containing the formula cell (plain name or quoted formula name). */
    formulaSheet: string;
    /** Worksheet receiving the non-structural appended row. */
    appendedSheet: string;
}

/**
 * Translating a formula invalidates its cached `<v>` result. The OOXML caller
 * must remove that cache and request a full Excel recalculation on open; this
 * string is exported so the policy remains visible to tests and callers.
 */
export const SCSEM_FORMULA_CACHE_POLICY =
    "Remove the translated formula cell's cached <v> value and force a full workbook recalculation on open.";

type RowReferenceToken = {
    start: number;
    end: number;
    row: number;
    rowAbsolute: boolean;
    render: (row: number) => string;
    rangeEnd: boolean;
    /** null means the reference is local to the worksheet containing the formula. */
    qualifiedSheetName: string | null;
};

type ParsedSheetName = {
    end: number;
    name: string;
    quoted: boolean;
};

function fail(
    code: SCSEMFormulaTranslationErrorCode,
    message: string,
    formulaIndex?: number
): never {
    throw new SCSEMFormulaTranslationError(code, message, formulaIndex);
}

function assertFormulaType(context: SCSEMFormulaContext | undefined) {
    const formulaType = context?.formulaType?.trim();
    if (formulaType) {
        fail(
            "UNSUPPORTED_FORMULA_TYPE",
            `Cannot translate an OOXML ${formulaType} formula; shared, array, and other compound formula constructs require workbook-level handling.`
        );
    }
}

function columnNumber(column: string): number {
    let value = 0;
    for (const character of column.toUpperCase()) {
        value = value * 26 + character.charCodeAt(0) - 64;
    }
    return value;
}

function assertColumn(column: string, formulaIndex: number) {
    const value = columnNumber(column);
    if (value < 1 || value > EXCEL_MAX_COLUMN) {
        fail(
            "INVALID_A1_REFERENCE",
            `Formula reference column ${column} is outside Excel's A:XFD column limits.`,
            formulaIndex
        );
    }
}

function assertRow(row: number, formulaIndex: number) {
    if (!Number.isSafeInteger(row) || row < 1 || row > EXCEL_MAX_ROW) {
        fail(
            "INVALID_A1_REFERENCE",
            `Formula reference row ${row} is outside Excel's 1:${EXCEL_MAX_ROW} row limits.`,
            formulaIndex
        );
    }
}

function isIdentifierCharacter(character: string | undefined): boolean {
    return Boolean(character && /[\p{L}\p{N}_.\\]/u.test(character));
}

function hasReferenceBoundaries(
    formula: string,
    start: number,
    end: number,
    excludeFunctionCall = false
): boolean {
    if (isIdentifierCharacter(formula[start - 1])) return false;
    if (isIdentifierCharacter(formula[end])) return false;
    if (formula[end] === "!") return false;
    if (excludeFunctionCall && /^\s*\(/.test(formula.slice(end))) return false;
    return true;
}

function parseQuotedSheetName(formula: string, start: number): ParsedSheetName {
    let index = start + 1;
    let name = "";
    while (index < formula.length) {
        if (formula[index] !== "'") {
            name += formula[index];
            index++;
            continue;
        }
        if (formula[index + 1] === "'") {
            name += "'";
            index += 2;
            continue;
        }
        return { end: index + 1, name, quoted: true };
    }
    fail(
        "MALFORMED_FORMULA",
        "Formula contains an unterminated quoted worksheet name.",
        start
    );
}

function parseSheetName(formula: string, start: number): ParsedSheetName | null {
    if (formula[start] === "'") return parseQuotedSheetName(formula, start);
    const unquoted = formula
        .slice(start)
        .match(/^[\p{L}_\\][\p{L}\p{N}_.\\]*/u);
    if (!unquoted) return null;
    return {
        end: start + unquoted[0].length,
        name: unquoted[0],
        quoted: false,
    };
}

function assertNoBracketReference(value: string, formulaIndex: number) {
    if (value.includes("[") || value.includes("]")) {
        fail(
            "UNSUPPORTED_BRACKET_REFERENCE",
            "External workbook and structured table references are unsupported for surgical formula translation.",
            formulaIndex
        );
    }
}

/**
 * If `start` is a sheet qualifier, return the first character after `!`.
 * If it begins a 3-D qualifier, fail closed. Otherwise return null.
 */
function consumeSheetQualifier(
    formula: string,
    start: number
): { afterBang: number; sheetName: string } | null {
    const first = parseSheetName(formula, start);
    if (!first) return null;
    assertNoBracketReference(first.name, start);

    if (formula[first.end] === "!") {
        if (first.name.includes(":")) {
            fail(
                "UNSUPPORTED_3D_REFERENCE",
                "Three-dimensional worksheet references are unsupported for surgical formula translation.",
                start
            );
        }
        return { afterBang: first.end + 1, sheetName: first.name };
    }

    if (formula[first.end] === ":") {
        const second = parseSheetName(formula, first.end + 1);
        if (second && formula[second.end] === "!") {
            assertNoBracketReference(second.name, first.end + 1);
            fail(
                "UNSUPPORTED_3D_REFERENCE",
                "Three-dimensional worksheet references are unsupported for surgical formula translation.",
                start
            );
        }
    }

    if (first.quoted) {
        fail(
            "MALFORMED_FORMULA",
            "A quoted worksheet name must be followed by an exclamation mark.",
            start
        );
    }
    return null;
}

function skipDoubleQuotedString(formula: string, start: number): number {
    let index = start + 1;
    while (index < formula.length) {
        if (formula[index] !== '"') {
            index++;
            continue;
        }
        if (formula[index + 1] === '"') {
            index += 2;
            continue;
        }
        return index + 1;
    }
    fail("MALFORMED_FORMULA", "Formula contains an unterminated string literal.", start);
}

function parseWholeRowRange(
    formula: string,
    start: number,
    qualifiedSheetName: string | null = null
): { end: number; tokens: [RowReferenceToken, RowReferenceToken] } | null {
    const match = formula.slice(start).match(/^(\$?)(\d+)(\s*:\s*)(\$?)(\d+)/);
    if (!match) return null;
    const end = start + match[0].length;
    if (!hasReferenceBoundaries(formula, start, end)) return null;

    const firstRow = Number(match[2]);
    const secondRow = Number(match[5]);
    const firstEnd = start + match[1].length + match[2].length;
    const secondStart = firstEnd + match[3].length;
    assertRow(firstRow, start);
    assertRow(secondRow, secondStart);

    return {
        end,
        tokens: [
            {
                start,
                end: firstEnd,
                row: firstRow,
                rowAbsolute: match[1] === "$",
                render: (row) => `${match[1]}${row}`,
                rangeEnd: false,
                qualifiedSheetName,
            },
            {
                start: secondStart,
                end,
                row: secondRow,
                rowAbsolute: match[4] === "$",
                render: (row) => `${match[4]}${row}`,
                rangeEnd: true,
                qualifiedSheetName,
            },
        ],
    };
}

function parseWholeColumnRange(formula: string, start: number): number | null {
    const match = formula
        .slice(start)
        .match(/^(\$?)([A-Za-z]{1,3})(\s*:\s*)(\$?)([A-Za-z]{1,3})/);
    if (!match) return null;
    const end = start + match[0].length;
    if (!hasReferenceBoundaries(formula, start, end)) return null;
    assertColumn(match[2], start + match[1].length);
    const secondStart = start + match[1].length + match[2].length + match[3].length;
    assertColumn(match[5], secondStart + match[4].length);
    return end;
}

function parseCellReference(
    formula: string,
    start: number,
    qualifiedSheetName: string | null = null
): RowReferenceToken | null {
    const match = formula.slice(start).match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/);
    if (!match) return null;
    const end = start + match[0].length;
    if (!hasReferenceBoundaries(formula, start, end, true)) return null;

    assertColumn(match[2], start + match[1].length);
    const row = Number(match[4]);
    assertRow(row, start + match[1].length + match[2].length + match[3].length);
    return {
        start,
        end,
        row,
        rowAbsolute: match[3] === "$",
        render: (nextRow) => `${match[1]}${match[2]}${match[3]}${nextRow}`,
        rangeEnd: false,
        qualifiedSheetName,
    };
}

function scanQualifiedReference(
    formula: string,
    start: number,
    sheetName: string
): { end: number; tokens: RowReferenceToken[] } | null {
    const rowRange = parseWholeRowRange(formula, start, sheetName);
    if (rowRange) return rowRange;

    const columnRangeEnd = parseWholeColumnRange(formula, start);
    if (columnRangeEnd !== null) return { end: columnRangeEnd, tokens: [] };

    const cell = parseCellReference(formula, start, sheetName);
    return cell ? { end: cell.end, tokens: [cell] } : null;
}

function scanRowReferences(formula: string): RowReferenceToken[] {
    const tokens: RowReferenceToken[] = [];
    for (let index = 0; index < formula.length;) {
        const character = formula[index];
        if (character === '"') {
            index = skipDoubleQuotedString(formula, index);
            continue;
        }
        if (character === "[" || character === "]") {
            fail(
                "UNSUPPORTED_BRACKET_REFERENCE",
                "External workbook and structured table references are unsupported for surgical formula translation.",
                index
            );
        }

        const qualifier = consumeSheetQualifier(formula, index);
        if (qualifier !== null) {
            const qualifiedReference = scanQualifiedReference(
                formula,
                qualifier.afterBang,
                qualifier.sheetName
            );
            if (qualifiedReference) {
                tokens.push(...qualifiedReference.tokens);
                index = qualifiedReference.end;
                continue;
            }
            // A sheet-scoped defined name is valid, but it must not leak its
            // qualifier onto a later, unrelated reference.
            index = qualifier.afterBang;
            continue;
        }

        const rowRange = parseWholeRowRange(formula, index);
        if (rowRange) {
            tokens.push(...rowRange.tokens);
            index = rowRange.end;
            continue;
        }

        const columnRangeEnd = parseWholeColumnRange(formula, index);
        if (columnRangeEnd !== null) {
            index = columnRangeEnd;
            continue;
        }

        const cell = parseCellReference(formula, index);
        if (cell) {
            tokens.push(cell);
            index = cell.end;
            continue;
        }
        index++;
    }

    for (let index = 0; index + 1 < tokens.length; index++) {
        const left = tokens[index];
        const right = tokens[index + 1];
        if (/^\s*:\s*$/.test(formula.slice(left.end, right.start))) {
            right.rangeEnd = true;
            // In `Target!A1:B2`, the qualifier applies to both endpoints.
            if (left.qualifiedSheetName && !right.qualifiedSheetName) {
                right.qualifiedSheetName = left.qualifiedSheetName;
            }
        }
    }
    return tokens;
}

function applyRowTranslations(
    formula: string,
    tokens: RowReferenceToken[],
    translate: (token: RowReferenceToken) => number
): string {
    let output = formula;
    for (let index = tokens.length - 1; index >= 0; index--) {
        const token = tokens[index];
        const row = translate(token);
        assertRow(row, token.start);
        if (row === token.row) continue;
        output = output.slice(0, token.start) + token.render(row) + output.slice(token.end);
    }
    return output;
}

/**
 * Translate A1 row references as Excel does when a formula-bearing row is
 * copied. Relative row references move by `rowDelta`; `$`-absolute rows stay.
 */
export function translateCopiedSCSEMFormula(
    formula: string,
    rowDelta: number,
    context?: SCSEMFormulaContext
): string {
    if (!Number.isSafeInteger(rowDelta)) {
        fail(
            "INVALID_TRANSLATION_ARGUMENT",
            "Copied-row formula translation requires a safe integer row delta."
        );
    }
    assertFormulaType(context);
    const tokens = scanRowReferences(formula);
    return applyRowTranslations(formula, tokens, (token) =>
        token.rowAbsolute ? token.row : token.row + rowDelta
    );
}

/**
 * Translate A1 row references for structural worksheet row insertion.
 * Absolute markers do not suppress structural updates: every referenced row at
 * or after `insertionRow` moves. Ranges spanning the insertion naturally grow;
 * an immediately-adjacent range can be grown with the explicit option.
 */
export function translateInsertedSCSEMFormula(
    formula: string,
    insertionRow: number,
    options: SCSEMInsertedRowsFormulaOptions
): string {
    const rowCount = options.rowCount ?? 1;
    const formulaSheet = normalizeSheetIdentity(options.formulaSheet);
    const insertedSheet = normalizeSheetIdentity(options.insertedSheet);
    if (
        !formulaSheet ||
        !insertedSheet ||
        !Number.isSafeInteger(insertionRow) ||
        insertionRow < 1 ||
        insertionRow > EXCEL_MAX_ROW ||
        !Number.isSafeInteger(rowCount) ||
        rowCount < 1 ||
        rowCount > EXCEL_MAX_ROW - insertionRow + 1
    ) {
        fail(
            "INVALID_TRANSLATION_ARGUMENT",
            "Inserted-row formula translation requires a valid 1-based insertion row and positive row count within Excel limits."
        );
    }
    assertFormulaType(options);
    const tokens = scanRowReferences(formula);
    return applyRowTranslations(formula, tokens, (token) => {
        const referencedSheet = token.qualifiedSheetName
            ? normalizeSheetIdentity(token.qualifiedSheetName)
            : formulaSheet;
        if (referencedSheet !== insertedSheet) return token.row;
        if (token.row >= insertionRow) return token.row + rowCount;
        if (
            options.extendRangesEndingBeforeInsertion &&
            token.rangeEnd &&
            token.row === insertionRow - 1
        ) {
            return token.row + rowCount;
        }
        return token.row;
    });
}

/**
 * Extend ranges for a non-structural row append without moving any other
 * reference. Only a range endpoint that resolves to `appendedSheet` and is
 * exactly `sourceRow` is changed to `targetRow`; direct references and helper
 * ranges therefore remain untouched.
 */
export function extendAppendedSCSEMFormulaRanges(
    formula: string,
    sourceRow: number,
    targetRow: number,
    options: SCSEMAppendedRowFormulaOptions
): string {
    const formulaSheet = normalizeSheetIdentity(options.formulaSheet);
    const appendedSheet = normalizeSheetIdentity(options.appendedSheet);
    if (
        !formulaSheet ||
        !appendedSheet ||
        !Number.isSafeInteger(sourceRow) ||
        sourceRow < 1 ||
        sourceRow >= EXCEL_MAX_ROW ||
        !Number.isSafeInteger(targetRow) ||
        targetRow <= sourceRow ||
        targetRow > EXCEL_MAX_ROW
    ) {
        fail(
            "INVALID_TRANSLATION_ARGUMENT",
            "Appended-row formula translation requires valid 1-based source and target rows, with the target after the source and within Excel limits."
        );
    }
    assertFormulaType(options);
    const tokens = scanRowReferences(formula);
    return applyRowTranslations(formula, tokens, (token) => {
        if (!token.rangeEnd || token.row !== sourceRow) return token.row;
        const referencedSheet = token.qualifiedSheetName
            ? normalizeSheetIdentity(token.qualifiedSheetName)
            : formulaSheet;
        return referencedSheet === appendedSheet ? targetRow : token.row;
    });
}

/**
 * Return whether a formula contains an exact quoted or unquoted worksheet
 * qualifier for `sheetName`. Double-quoted Excel string literals are skipped;
 * matching a name as a mere substring is never sufficient.
 */
export function hasExactSCSEMSheetQualifier(formula: string, sheetName: string): boolean {
    const target = normalizeSheetIdentity(sheetName);
    if (!target) {
        fail("INVALID_TRANSLATION_ARGUMENT", "Worksheet qualifier matching requires a nonblank sheet name.");
    }

    let index = 0;
    while (index < formula.length) {
        if (formula[index] === '"') {
            index = skipDoubleQuotedString(formula, index);
            continue;
        }
        const parsed = parseSheetName(formula, index);
        if (!parsed) {
            index++;
            continue;
        }
        if (formula[parsed.end] === "!") {
            if (normalizeSheetIdentity(parsed.name) === target) return true;
            index = parsed.end + 1;
            continue;
        }
        index = Math.max(index + 1, parsed.end);
    }
    return false;
}

function normalizeSheetIdentity(value: string): string {
    let normalized = value.trim();
    if (normalized.endsWith("!")) normalized = normalized.slice(0, -1).trim();
    if (normalized.startsWith("'") && normalized.endsWith("'") && normalized.length >= 2) {
        normalized = normalized.slice(1, -1).replace(/''/g, "'");
    }
    return normalized.normalize("NFKC").toLocaleLowerCase("en-US");
}
