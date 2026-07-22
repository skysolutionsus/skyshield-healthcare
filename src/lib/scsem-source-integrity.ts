import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { OfficialSCSEMReference } from "@/lib/scsem-official-reference";
import {
    matchOfficialSCSEM,
    officialSCSEMManifest,
    type OfficialSCSEMManifestEntry,
} from "@/lib/scsem-official-manifest";
import type { SCSEMUpdaterSession } from "@/lib/scsem-updater-store";
import { resolveRuntimeFilePath } from "@/lib/runtime-storage";

export class SCSEMSourceIntegrityError extends Error {
    readonly code = "SCSEM_SOURCE_INTEGRITY_FAILURE";

    constructor(message: string) {
        super(message);
        this.name = "SCSEMSourceIntegrityError";
    }
}

export type VerifiedSCSEMSource = {
    absolutePath: string;
    sha256: string;
    sizeBytes: number;
    officialSource: OfficialSCSEMManifestEntry;
};

const PINNED_SCSEM_DIRECTORY = path.join(process.cwd(), "data", "scsems", "current");

export function sha256Hex(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

function integrityFailure(message: string): never {
    throw new SCSEMSourceIntegrityError(message);
}

function resolvePinnedSCSEMPath(canonical: OfficialSCSEMManifestEntry): string {
    const fileName = path.basename(canonical.file);
    const expectedManifestPath = path.posix.join("data", "scsems", "current", fileName);
    if (fileName !== canonical.fileName || canonical.file !== expectedManifestPath) {
        integrityFailure("The pinned SCSEM manifest contains an invalid workbook path.");
    }

    // Keep the dynamic filename statically scoped to the pinned corpus directory.
    // This prevents Next.js output tracing from treating the entire project as a
    // possible runtime dependency while retaining a fail-closed path boundary.
    return path.join(PINNED_SCSEM_DIRECTORY, fileName);
}

function readSource(absolutePath: string, label: string): Buffer {
    try {
        return fs.readFileSync(absolutePath);
    } catch {
        return integrityFailure(`${label} is missing or unreadable; start a new updater session from a pinned IRS workbook.`);
    }
}

function assertRecordedOfficialIdentity(
    recorded: OfficialSCSEMManifestEntry | undefined,
    canonical: OfficialSCSEMManifestEntry,
    originalFileName: string
) {
    if (!recorded) {
        integrityFailure("The updater session is missing its pinned IRS source identity; upload the workbook again.");
    }

    if (
        recorded.sha256 !== canonical.sha256 ||
        recorded.sizeBytes !== canonical.sizeBytes ||
        recorded.file !== canonical.file ||
        recorded.fileName !== canonical.fileName ||
        recorded.sourceUrl !== canonical.sourceUrl ||
        originalFileName !== canonical.fileName
    ) {
        integrityFailure("The updater session's recorded IRS source identity no longer matches the pinned manifest.");
    }
}

/**
 * Revalidate the creator-scoped upload immediately before analysis or export.
 * The bytes must agree with the session audit record and with a current pinned
 * manifest entry; trusting the session JSON alone would make its provenance
 * claim stale if the runtime workbook were overwritten after upload.
 */
export function assertSCSEMUpdaterSourceIntegrity(
    session: SCSEMUpdaterSession
): VerifiedSCSEMSource {
    const absolutePath = resolveRuntimeFilePath(session.originalFilePath);
    const buffer = readSource(absolutePath, "The stored uploaded SCSEM workbook");
    const sizeBytes = buffer.length;
    const sha256 = sha256Hex(buffer);

    if (
        sizeBytes !== session.audit.uploadedSizeBytes ||
        sha256 !== session.audit.uploadedSha256
    ) {
        integrityFailure("The stored uploaded SCSEM workbook changed after upload; analysis and export are blocked.");
    }

    const canonical = matchOfficialSCSEM(buffer);
    if (!canonical) {
        integrityFailure("The stored uploaded SCSEM workbook no longer matches a pinned IRS source workbook.");
    }
    assertRecordedOfficialIdentity(session.audit.officialSource, canonical, session.originalFileName);

    return { absolutePath, sha256, sizeBytes, officialSource: canonical };
}

/** Verify a selected official rebase workbook against both session metadata and the manifest. */
export function assertOfficialSCSEMReferenceIntegrity(
    reference: OfficialSCSEMReference
): VerifiedSCSEMSource {
    const canonical = officialSCSEMManifest().workbooks.find((entry) =>
        entry.file === reference.filePath &&
        entry.sourceUrl === reference.sourceUrl
    );
    if (!canonical || canonical.sha256 !== reference.sha256) {
        integrityFailure("The selected official SCSEM rebase identity does not match the pinned manifest.");
    }

    const absolutePath = resolvePinnedSCSEMPath(canonical);
    const buffer = readSource(absolutePath, "The selected official SCSEM rebase workbook");
    const sizeBytes = buffer.length;
    const sha256 = sha256Hex(buffer);
    if (sizeBytes !== canonical.sizeBytes || sha256 !== canonical.sha256) {
        integrityFailure("The selected official SCSEM rebase workbook failed its pinned size or SHA-256 check.");
    }

    return { absolutePath, sha256, sizeBytes, officialSource: canonical };
}
