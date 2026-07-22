/**
 * Canonical SCSEM test-case fields shared by workbook parsing and export.
 *
 * IRS templates have used several labels for the same template-maintenance
 * field over time (for example Description, Test Objective, and Objective).
 * Keeping the aliases here prevents the reader and writer from disagreeing
 * about which physical Excel column owns a field.
 */
export type SCSEMColumnField =
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

export interface SCSEMColumnMatchContext {
    workbookSha256: string;
    sheetName: string;
    /** Zero-based physical worksheet row containing the header. */
    headerRow: number;
    /** Zero-based physical worksheet column containing the header. */
    columnIndex: number;
    /** Normalized, ordered values for the complete physical header row. */
    headerSignature?: string;
    /** Ordered workbook sheet names; immutable across a surgical candidate export. */
    workbookSheetNamesSignature?: string;
}

type PinnedSCSEMColumnOverride = SCSEMColumnMatchContext & {
    normalizedHeader: string;
    field: SCSEMColumnField;
    derivativeHeaderSignature?: string;
    derivativeWorkbookSheetNamesSignature?: string;
};

const GENERIC_WEB_HEADER_SIGNATURE = scsemColumnHeaderSignature([
    "Test ID",
    "NIST ID",
    "NIST Control Name",
    "Test Method",
    "Platform",
    "Test Method",
    "Test Procedures",
    "Expected Results",
    "Actual Results",
    "Status",
    "Notes/Evidence",
    "Criticality",
    "Issue Code",
    "Issue Code Mapping (Select one to enter in column M)",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "Risk Rating (Do Not Edit)",
]);

const GENERIC_WEB_SHEET_NAMES_SIGNATURE = scsemWorkbookSheetNamesSignature([
    "Dashboard",
    "Results",
    "Instructions",
    "Test Cases",
    "Change Log",
    "New Release Changes",
    "Issue Code Table",
]);

/**
 * Exact corrections for malformed headers in an official workbook. The source
 * fingerprint authorizes the pinned original; an exported derivative must
 * instead retain the complete header signature and workbook sheet order.
 * Coordinates and normalized text remain mandatory in both cases, so an
 * unrelated duplicate label is never guessed from row data.
 */
const PINNED_SCSEM_COLUMN_OVERRIDES: ReadonlyArray<PinnedSCSEMColumnOverride> = [
    {
        workbookSha256: "bbce4c778fb672d0e8a9ca948b8dbbb267b49d82baf32404df661a96fd207c7f",
        sheetName: "Test Cases",
        headerRow: 1,
        columnIndex: 3,
        normalizedHeader: "test method",
        field: "testMethod",
        derivativeHeaderSignature: GENERIC_WEB_HEADER_SIGNATURE,
        derivativeWorkbookSheetNamesSignature: GENERIC_WEB_SHEET_NAMES_SIGNATURE,
    },
    {
        workbookSha256: "bbce4c778fb672d0e8a9ca948b8dbbb267b49d82baf32404df661a96fd207c7f",
        sheetName: "Test Cases",
        headerRow: 1,
        columnIndex: 4,
        normalizedHeader: "platform",
        field: "sectionTitle",
        derivativeHeaderSignature: GENERIC_WEB_HEADER_SIGNATURE,
        derivativeWorkbookSheetNamesSignature: GENERIC_WEB_SHEET_NAMES_SIGNATURE,
    },
    {
        workbookSha256: "bbce4c778fb672d0e8a9ca948b8dbbb267b49d82baf32404df661a96fd207c7f",
        sheetName: "Test Cases",
        headerRow: 1,
        columnIndex: 5,
        normalizedHeader: "test method",
        field: "description",
        derivativeHeaderSignature: GENERIC_WEB_HEADER_SIGNATURE,
        derivativeWorkbookSheetNamesSignature: GENERIC_WEB_SHEET_NAMES_SIGNATURE,
    },
];

export const SCSEM_COLUMN_HEADER_PATTERNS: ReadonlyArray<
    readonly [SCSEMColumnField, ReadonlyArray<RegExp>]
> = [
    ["testId", [/^test id\b/i]],
    ["nistId", [/^nist id$/i]],
    ["nistControlName", [/^nist control(?: name)?$/i]],
    ["testMethod", [/^test method$/i]],
    ["sectionTitle", [/^section title$/i, /^platform$/i]],
    // "Test Object" appears in historical IRS change-log language and some
    // template variants; it is the same control objective field.
    ["description", [/^description$/i, /^test objective$/i, /^objective$/i, /^test object$/i]],
    ["testProcedures", [/^test procedures?$/i]],
    ["expectedResults", [/^expected results?$/i]],
    ["actualResults", [/^actual results?$/i]],
    ["status", [/^status$/i]],
    ["findingStatement", [
        /^finding statement$/i,
        /^finding statement \(internal use only\)$/i,
    ]],
    ["notesEvidence", [/^notes(?:\s*\/\s*|\s+and\s+)?evidence$/i, /^notes$/i, /^evidence$/i]],
    ["criticality", [/^criticality$/i, /^criticality rating$/i]],
    // In newer IRS layouts, the parenthetical "select one" mapping column
    // contains the human-readable code descriptions while the adjacent exact
    // "Issue Code" column stores the selected code. Older layouts use the
    // exact "Issue Code Mapping" label for the code itself and an adjacent
    // exact/suffixed "Issue Code Description" column. Keep these cases exact.
    ["issueCodeDescription", [
        /^issue code description$/i,
        /^issue code description \(select one to enter in column [a-z]{1,3}\)$/i,
        /^issue code mapping \(select one to enter in column [a-z]{1,3}\)$/i,
    ]],
    ["issueCode", [/^issue code mapping$/i, /^issue code$/i]],
    ["cisBenchmarkRef", [
        /^cis benchmark(?: section| reference| ref)?(?:\s*#)?$/i,
        /^cis section(?:\s*#)?$/i,
    ]],
    ["recommendationNum", [/^(?:cis\s+)?recommendation(?:\s*(?:#|number|no\.?))?$/i]],
    ["rationale", [/^rationale$/i]],
    ["impact", [/^impact$/i]],
    ["remediationProcedure", [/^remediation procedures?$/i]],
    ["remediationStatement", [
        /^remediation statement$/i,
        /^remediation statement \(internal use only\)$/i,
    ]],
    ["capRequestStatement", [
        /^cap request(?: statement)?$/i,
        /^cap request statement \(internal use only\)$/i,
    ]],
    ["riskRating", [
        /^risk rating$/i,
        /^risk rating \(do not edit\)$/i,
        /^criticality rating \(do not edit\)$/i,
    ]],
] as const;

export function normalizeSCSEMColumnHeader(value: string): string {
    return value
        .replace(/[\u00a0\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

export function scsemColumnHeaderSignature(values: ReadonlyArray<unknown>): string {
    const normalized = values.map((value) =>
        normalizeSCSEMColumnHeader(value === undefined || value === null ? "" : String(value))
    );
    while (normalized.length > 0 && normalized[normalized.length - 1] === "") {
        normalized.pop();
    }
    return normalized.join("\u001f");
}

export function scsemWorkbookSheetNamesSignature(sheetNames: ReadonlyArray<string>): string {
    return sheetNames.join("\u001f");
}

function exactIssueCodeMappingField(
    context: SCSEMColumnMatchContext | undefined
): "issueCode" | "issueCodeDescription" | null {
    if (!context?.headerSignature) return "issueCode";
    const headers = context.headerSignature.split("\u001f");
    const hasExactIssueCode = headers.includes("issue code");
    const hasDescriptionColumn = headers.some((header) =>
        /^issue code description(?: \(select one to enter in column [a-z]{1,3}\))?$/.test(header)
    );

    // Newer layouts pair exact Issue Code with exact Issue Code Mapping, where
    // Mapping contains descriptions. Older layouts pair exact Mapping (codes)
    // with an explicit Description column. A layout containing both competing
    // identities is internally ambiguous and must remain unmapped.
    if (hasExactIssueCode && hasDescriptionColumn) return null;
    if (hasExactIssueCode) return "issueCodeDescription";
    return "issueCode";
}

export function matchSCSEMColumnHeader(
    header: string,
    context?: SCSEMColumnMatchContext
): SCSEMColumnField | null {
    const normalized = normalizeSCSEMColumnHeader(header);
    if (!normalized || normalized.startsWith("column")) return null;

    if (context) {
        const pinnedOverride = PINNED_SCSEM_COLUMN_OVERRIDES.find((override) =>
            (
                override.workbookSha256 === context.workbookSha256.toLowerCase() ||
                (
                    override.derivativeHeaderSignature !== undefined &&
                    override.derivativeWorkbookSheetNamesSignature !== undefined &&
                    override.derivativeHeaderSignature === context.headerSignature &&
                    override.derivativeWorkbookSheetNamesSignature === context.workbookSheetNamesSignature
                )
            ) &&
            override.sheetName === context.sheetName &&
            override.headerRow === context.headerRow &&
            override.columnIndex === context.columnIndex &&
            override.normalizedHeader === normalized
        );
        if (pinnedOverride) return pinnedOverride.field;
    }

    if (normalized === "issue code mapping") {
        return exactIssueCodeMappingField(context);
    }

    for (const [field, patterns] of SCSEM_COLUMN_HEADER_PATTERNS) {
        if (patterns.some((pattern) => pattern.test(normalized))) return field;
    }

    return null;
}

export function isSCSEMColumnField(value: string): value is SCSEMColumnField {
    return SCSEM_COLUMN_HEADER_PATTERNS.some(([field]) => field === value);
}
