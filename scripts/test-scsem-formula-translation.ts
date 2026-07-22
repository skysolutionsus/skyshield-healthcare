import * as assert from "node:assert/strict";
import {
    extendAppendedSCSEMFormulaRanges,
    hasExactSCSEMSheetQualifier,
    SCSEM_FORMULA_CACHE_POLICY,
    SCSEMFormulaTranslationError,
    translateCopiedSCSEMFormula,
    translateInsertedSCSEMFormula,
} from "../src/lib/scsem-formula-translation";

function assertTranslationError(
    action: () => unknown,
    code: SCSEMFormulaTranslationError["code"]
) {
    assert.throws(action, (error: unknown) =>
        error instanceof SCSEMFormulaTranslationError && error.code === code
    );
}

// Function names and identifier-like defined names are not A1 references.
assert.equal(
    translateCopiedSCSEMFormula(
        "=LOG10(A1)+LOGEST(B1:B2)+Named_A1+Risk.A1+Sheet1!C1",
        2
    ),
    "=LOG10(A3)+LOGEST(B3:B4)+Named_A1+Risk.A1+Sheet1!C3"
);

// Quoted/unquoted sheets, apostrophe escaping, and mixed/absolute A1 rows.
assert.equal(
    translateCopiedSCSEMFormula(
        "='Control Sheet'!A1+'O''Brien'!$B2+Sheet_1!C$3+$A$1+A$1+$A1+A1",
        4
    ),
    "='Control Sheet'!A5+'O''Brien'!$B6+Sheet_1!C$3+$A$1+A$1+$A5+A5"
);

assert.equal(translateCopiedSCSEMFormula("=A1:B2", 2), "=A3:B4");
assert.equal(translateCopiedSCSEMFormula("=SUM(1:3)+SUM(A:B)", 2), "=SUM(3:5)+SUM(A:B)");

// Text literals, including escaped quotes and bracket-like text, are opaque.
assert.equal(
    translateCopiedSCSEMFormula('="A1 ""B2"" [book.xlsx]"&A1', 1),
    '="A1 ""B2"" [book.xlsx]"&A2'
);

// Excel's last valid cell is accepted, but crossing any grid boundary fails.
assert.equal(
    translateCopiedSCSEMFormula("=XFD1048576+$XFD$1048576", 0),
    "=XFD1048576+$XFD$1048576"
);
assertTranslationError(
    () => translateCopiedSCSEMFormula("=XFD1048576", 1),
    "INVALID_A1_REFERENCE"
);
assertTranslationError(
    () => translateCopiedSCSEMFormula("=A1", -1),
    "INVALID_A1_REFERENCE"
);
assertTranslationError(
    () => translateCopiedSCSEMFormula("=XFE1", 0),
    "INVALID_A1_REFERENCE"
);

// Unsupported OOXML/reference constructs are surfaced, never passed through.
assertTranslationError(
    () => translateCopiedSCSEMFormula("='[book.xlsx]Sheet1'!A1", 1),
    "UNSUPPORTED_BRACKET_REFERENCE"
);
assertTranslationError(
    () => translateCopiedSCSEMFormula("=Table1[Control]+A1", 1),
    "UNSUPPORTED_BRACKET_REFERENCE"
);
assertTranslationError(
    () => translateCopiedSCSEMFormula("=SUM(Sheet1:Sheet3!A1)", 1),
    "UNSUPPORTED_3D_REFERENCE"
);
assertTranslationError(
    () => translateCopiedSCSEMFormula("=SUM('Sheet 1':'Sheet 3'!A1)", 1),
    "UNSUPPORTED_3D_REFERENCE"
);
assertTranslationError(
    () => translateCopiedSCSEMFormula("=A1", 1, { formulaType: "shared" }),
    "UNSUPPORTED_FORMULA_TYPE"
);
assertTranslationError(
    () => translateCopiedSCSEMFormula("=A1", 1, { formulaType: "array" }),
    "UNSUPPORTED_FORMULA_TYPE"
);

// Structural insertion moves absolute and relative references alike.
assert.equal(
    translateInsertedSCSEMFormula("=A4+$A$5+A10:B20+C1:C4", 5, {
        formulaSheet: "Controls",
        insertedSheet: "Controls",
        rowCount: 2,
    }),
    "=A4+$A$7+A12:B22+C1:C4"
);
assert.equal(
    translateInsertedSCSEMFormula("=A1:B5", 3, {
        formulaSheet: "Controls",
        insertedSheet: "Controls",
    }),
    "=A1:B6"
);
assert.equal(
    translateInsertedSCSEMFormula("=A1:B4+SUM(1:4)", 5, {
        formulaSheet: "Controls",
        insertedSheet: "Controls",
    }),
    "=A1:B4+SUM(1:4)"
);
assert.equal(
    translateInsertedSCSEMFormula("=A1:B4+SUM(1:4)", 5, {
        formulaSheet: "Controls",
        insertedSheet: "Controls",
        rowCount: 2,
        extendRangesEndingBeforeInsertion: true,
    }),
    "=A1:B6+SUM(1:6)"
);

// Structural insertion only changes references that resolve to the inserted sheet.
assert.equal(
    translateInsertedSCSEMFormula("=Target!A9+Other!A9+A9", 9, {
        formulaSheet: "Results",
        insertedSheet: "target",
    }),
    "=Target!A10+Other!A9+A9"
);
assert.equal(
    translateInsertedSCSEMFormula("=A9+TARGET!A9+Other!A9", 9, {
        formulaSheet: "Target",
        insertedSheet: "target",
    }),
    "=A10+TARGET!A10+Other!A9"
);
assert.equal(
    translateInsertedSCSEMFormula("=Équipe!A9+Results!A9", 9, {
        formulaSheet: "Results",
        insertedSheet: "ÉQUIPE",
    }),
    "=Équipe!A10+Results!A9"
);
assert.equal(
    translateInsertedSCSEMFormula("='O''Brien'!A9:B9+'Other Sheet'!A9", 9, {
        formulaSheet: "Results",
        insertedSheet: "'o''brien'",
    }),
    "='O''Brien'!A10:B10+'Other Sheet'!A9"
);

// Non-structural append grows only matching range endpoints. Direct references,
// helper ranges, and references to other sheets do not move.
assert.equal(
    extendAppendedSCSEMFormulaRanges(
        "=COUNTA(Target!J3:J79)+Target!J79+SUM(Target!$A$3:$A$79)+" +
        "COUNTA(Other!J3:J79)+COUNTA(J3:J79)+SUM(Target!$H$84:$H$87)",
        79,
        80,
        { formulaSheet: "Results", appendedSheet: "target" }
    ),
    "=COUNTA(Target!J3:J80)+Target!J79+SUM(Target!$A$3:$A$80)+" +
    "COUNTA(Other!J3:J79)+COUNTA(J3:J79)+SUM(Target!$H$84:$H$87)"
);
assert.equal(
    extendAppendedSCSEMFormulaRanges(
        "=SUM(J3:J79)+J79+SUM(3:79)+SUM('Other Sheet'!J3:J79)",
        79,
        81,
        { formulaSheet: "Target", appendedSheet: "TARGET" }
    ),
    "=SUM(J3:J81)+J79+SUM(3:81)+SUM('Other Sheet'!J3:J79)"
);
assert.equal(
    extendAppendedSCSEMFormulaRanges(
        "=SUM('O''Brien'!A1:B9)+SUM(B1:B9)",
        9,
        10,
        { formulaSheet: "Results", appendedSheet: "'o''brien'" }
    ),
    "=SUM('O''Brien'!A1:B10)+SUM(B1:B9)"
);
assertTranslationError(
    () => extendAppendedSCSEMFormulaRanges("=A1:A2", 2, 2, {
        formulaSheet: "Target",
        appendedSheet: "Target",
    }),
    "INVALID_TRANSLATION_ARGUMENT"
);
assertTranslationError(
    () => extendAppendedSCSEMFormulaRanges("=Table1[Control]+A1:A2", 2, 3, {
        formulaSheet: "Target",
        appendedSheet: "Target",
    }),
    "UNSUPPORTED_BRACKET_REFERENCE"
);
assertTranslationError(
    () => extendAppendedSCSEMFormulaRanges("=A1:A2", 2, 3, {
        formulaSheet: "Target",
        appendedSheet: "Target",
        formulaType: "shared",
    }),
    "UNSUPPORTED_FORMULA_TYPE"
);

assert.equal(hasExactSCSEMSheetQualifier("='Target Sheet'!A1", "target sheet"), true);
assert.equal(hasExactSCSEMSheetQualifier("='O''Brien'!A1", "O'Brien"), true);
assert.equal(hasExactSCSEMSheetQualifier("=Target_1!A1", "target_1"), true);
assert.equal(hasExactSCSEMSheetQualifier("=OtherTarget!A1", "Target"), false);
assert.equal(hasExactSCSEMSheetQualifier('="Target!A1"+Other!A1', "Target"), false);
assert.equal(hasExactSCSEMSheetQualifier("=[Book.xlsx]Target!A1", "Target"), true);

assert.match(SCSEM_FORMULA_CACHE_POLICY, /cached <v>/i);
assert.match(SCSEM_FORMULA_CACHE_POLICY, /full workbook recalculation/i);

console.log("SCSEM A1 formula translation tests passed.");
