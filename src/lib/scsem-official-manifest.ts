import { createHash } from "node:crypto";
import manifestJson from "../../data/scsem-manifest.json";

export type OfficialSCSEMManifestEntry = {
    sourceUrl: string;
    sha256: string;
    sizeBytes: number;
    fileName: string;
    file: string;
    category: string;
    subject: string | null;
    version: string | null;
    effectiveDate: string | null;
    totalControls: number;
    testCaseSheets: string[];
};

export type OfficialSCSEMManifest = {
    schemaVersion: number;
    sourcePageUrl: string;
    sourcePageReviewedAt: string;
    snapshotAcquiredAt: string;
    sourcePolicy: "individual_xlsx_links";
    conflictingPackageAudit: {
        sourceUrl: string;
        auditedAt: string;
        httpLastModified: string;
        sha256: string;
        sizeBytes: number;
        status: "excluded_conflicting_snapshot";
        workbookCount: number;
        totalControls: number;
        pairedWorkbookCount: number;
        pairedControlCount: number;
        allPairedRawHashesDiffer: boolean;
        allPairedDirectCoreModifiedLater: boolean;
        packageOnly: Array<{ subject: string; version: string; controls: number }>;
        directOnly: Array<{ subject: string; version: string; controls: number }>;
    };
    expectedWorkbookCount: number;
    workbooks: OfficialSCSEMManifestEntry[];
};

const manifest = manifestJson as OfficialSCSEMManifest;

if (manifest.workbooks.length !== manifest.expectedWorkbookCount) {
    throw new Error(
        `SCSEM manifest is incomplete: expected ${manifest.expectedWorkbookCount}, ` +
        `found ${manifest.workbooks.length}.`
    );
}

const bySha256 = new Map(manifest.workbooks.map((entry) => [entry.sha256, entry]));

export function officialSCSEMManifest(): OfficialSCSEMManifest {
    return manifest;
}

export function sha256Buffer(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

export function matchOfficialSCSEM(buffer: Buffer): OfficialSCSEMManifestEntry | null {
    const match = bySha256.get(sha256Buffer(buffer));
    return match && match.sizeBytes === buffer.length ? match : null;
}
