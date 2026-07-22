import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { parseSCSEMFile, type ParsedSCSEM } from "@/lib/xlsx-parser";
import { officialSCSEMManifest } from "@/lib/scsem-official-manifest";

export type OfficialSCSEMReference = {
    family: "rhel" | "esxi" | "cloud" | "amazon-linux";
    filePath: string;
    sourceUrl: string;
    sourcePageUrl: string;
    sha256: string;
    workbookVersion: string | null;
    workbookEffectiveDate: string | null;
    irsEffectiveDate: string;
    testCaseSheets: string[];
    addedSheets: string[];
    selectedAsBase: boolean;
    upgradeReason: string | null;
};

type ReferenceDefinition = Pick<OfficialSCSEMReference,
    "family" | "filePath" | "sourceUrl" | "irsEffectiveDate"> & {
    expectedSha256: string;
    matches: (evidence: string) => boolean;
};

const manifest = officialSCSEMManifest();
const IRS_SCSEM_PAGE = manifest.sourcePageUrl;

function referenceDefinition(
    family: OfficialSCSEMReference["family"],
    fileName: string,
    matches: (evidence: string) => boolean
): ReferenceDefinition {
    const entry = manifest.workbooks.find((candidate) => candidate.fileName === fileName);
    if (!entry) throw new Error(`Pinned IRS SCSEM reference is missing: ${fileName}`);
    return {
        family,
        filePath: entry.file,
        sourceUrl: entry.sourceUrl,
        irsEffectiveDate: entry.effectiveDate || manifest.snapshotAcquiredAt,
        expectedSha256: entry.sha256,
        matches,
    };
}

const REFERENCES: ReferenceDefinition[] = [
    referenceDefinition(
        "amazon-linux",
        "safeguards-scsem-amazon-linux-2023-v1-0.xlsx",
        (evidence) => /\b(?:amazon linux|al2023|amzl23)\b/i.test(evidence)
    ),
    referenceDefinition(
        "rhel",
        "Safeguards-SCSEM Red Hat Enterprise Linux (RHEL)-v7_02182025.xlsx",
        (evidence) => /\b(?:red hat enterprise linux|red hat linux|rhel)\b/i.test(evidence)
    ),
    referenceDefinition(
        "esxi",
        "safeguards-scsem-vmwareesxi-v5.xlsx",
        (evidence) => /\b(?:vmware\s+)?esxi\b/i.test(evidence)
    ),
    referenceDefinition(
        "cloud",
        "safeguard-cloud-scsem-v7-0-01152025.xlsx",
        (evidence) => /\bcloud computing\b|\baws foundations\b/i.test(evidence)
    ),
];

const parsedReferenceCache = new Map<string, ParsedSCSEM>();

function normalizedSheetName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function workbookVersion(value: string | null): number[] {
    return (value || "")
        .match(/\d+/g)
        ?.map((part) => Number.parseInt(part, 10)) || [];
}

function compareVersions(left: string | null, right: string | null): number {
    const leftParts = workbookVersion(left);
    const rightParts = workbookVersion(right);
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index++) {
        const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

function parsedDate(value: string | null): number | null {
    if (!value) return null;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : timestamp;
}

function testCaseSheets(parsed: ParsedSCSEM): string[] {
    return parsed.sheets
        .filter((sheet) => sheet.sheetType === "test_cases")
        .map((sheet) => sheet.sheetName);
}

function newerGenerationMissing(
    family: OfficialSCSEMReference["family"],
    uploadedSheets: string[],
    referenceSheets: string[]
): boolean {
    const generation = (sheetName: string): number | null => {
        if (family === "rhel") {
            const match = sheetName.match(/\brhel\s*(\d{1,2})\b/i);
            return match ? Number.parseInt(match[1], 10) : null;
        }
        if (family === "esxi") {
            const match = sheetName.match(/\besxi\s*(\d{1,2})(?:\.\d+)?\b/i);
            return match ? Number.parseInt(match[1], 10) : null;
        }
        if (family === "amazon-linux") {
            if (/\b(?:amazon linux\s*(?:20)?23|al2023|amzl23)\b/i.test(sheetName)) return 2023;
        }
        return null;
    };
    const uploaded = uploadedSheets.map(generation).filter((value): value is number => value !== null);
    const reference = referenceSheets.map(generation).filter((value): value is number => value !== null);
    return reference.length > 0 && (uploaded.length === 0 || Math.max(...reference) > Math.max(...uploaded));
}

function sha256(filePath: string): string {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function resolveOfficialReferencePath(reference: Pick<OfficialSCSEMReference, "filePath">): string {
    const entry = manifest.workbooks.find((candidate) => candidate.file === reference.filePath);
    if (!entry) {
        throw new Error("Official SCSEM reference is not present in the pinned manifest.");
    }

    const fileName = path.basename(entry.file);
    const expectedManifestPath = path.posix.join("data", "scsems", "current", fileName);
    if (fileName !== entry.fileName || entry.file !== expectedManifestPath) {
        throw new Error("Pinned IRS SCSEM reference contains an invalid workbook path.");
    }

    return path.join(process.cwd(), "data", "scsems", "current", fileName);
}

export function evaluateOfficialSCSEMReference(
    uploaded: ParsedSCSEM,
    inferredTechnology: string,
    uploadedSha256?: string
): OfficialSCSEMReference | null {
    const uploadedSheets = testCaseSheets(uploaded);
    const evidence = [
        inferredTechnology,
        uploaded.metadata.subject,
        ...uploaded.sheets.map((sheet) => sheet.sheetName),
    ].filter(Boolean).join("\n");
    const definition = REFERENCES.find((candidate) => candidate.matches(evidence));
    if (!definition) return null;

    // An exact current manifest workbook is already its own authoritative
    // baseline. Incidental product names must never rebase it onto another
    // current technology template. Legacy/unrecognized older inputs retain the
    // deliberate same-family upgrade path exercised by the rebase regression.
    const admittedCurrentSource = uploadedSha256
        ? manifest.workbooks.find((candidate) => candidate.sha256 === uploadedSha256)
        : undefined;
    if (
        admittedCurrentSource &&
        admittedCurrentSource.sha256 !== definition.expectedSha256
    ) {
        return null;
    }

    const absolutePath = resolveOfficialReferencePath(definition);
    if (!fs.existsSync(absolutePath)) return null;
    const reference = parsedReferenceCache.get(absolutePath) || parseSCSEMFile(absolutePath);
    parsedReferenceCache.set(absolutePath, reference);
    const referenceSha256 = sha256(absolutePath);
    if (referenceSha256 !== definition.expectedSha256) {
        throw new Error(
            `Pinned IRS SCSEM reference hash mismatch for ${definition.filePath}. ` +
            "Refresh it only through the reviewed manifest acquisition workflow."
        );
    }
    const sameWorkbookBytes = Boolean(uploadedSha256 && uploadedSha256 === referenceSha256);
    const referenceSheets = testCaseSheets(reference);
    const uploadedSheetKeys = new Set(uploadedSheets.map(normalizedSheetName));
    const addedSheets = referenceSheets.filter((sheet) => !uploadedSheetKeys.has(normalizedSheetName(sheet)));

    const versionIsNewer = compareVersions(reference.metadata.version, uploaded.metadata.version) > 0;
    const referenceDate = parsedDate(definition.irsEffectiveDate) || parsedDate(reference.metadata.effectiveDate);
    const uploadedDate = parsedDate(uploaded.metadata.effectiveDate);
    const dateIsNewer = !sameWorkbookBytes && referenceDate !== null && uploadedDate !== null && referenceDate > uploadedDate;
    const generationIsNewer = newerGenerationMissing(definition.family, uploadedSheets, referenceSheets);
    const providerCoverageIsNewer = definition.family === "cloud" && addedSheets.some((sheet) =>
        /\b(?:aws|azure|google|office\s*365)\b/i.test(sheet)
    );

    const reasons = [
        versionIsNewer
            ? `IRS SCSEM version ${reference.metadata.version || "unknown"} is newer than uploaded version ${uploaded.metadata.version || "unknown"}`
            : null,
        generationIsNewer
            ? "the IRS workbook contains a newer platform-generation test-case tab"
            : null,
        providerCoverageIsNewer
            ? "the IRS Cloud workbook contains provider-specific test-case tabs missing from the upload"
            : null,
        dateIsNewer && !versionIsNewer
            ? `the IRS-listed effective date (${definition.irsEffectiveDate}) is newer than the upload (${uploaded.metadata.effectiveDate})`
            : null,
    ].filter(Boolean) as string[];

    return {
        family: definition.family,
        filePath: definition.filePath,
        sourceUrl: definition.sourceUrl,
        sourcePageUrl: IRS_SCSEM_PAGE,
        sha256: referenceSha256,
        workbookVersion: reference.metadata.version,
        workbookEffectiveDate: reference.metadata.effectiveDate,
        irsEffectiveDate: definition.irsEffectiveDate,
        testCaseSheets: referenceSheets,
        addedSheets,
        selectedAsBase: reasons.length > 0,
        upgradeReason: reasons.length > 0 ? reasons.join("; ") : null,
    };
}
