import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OfficialSCSEMReference } from "../src/lib/scsem-official-reference";
import { officialSCSEMManifest } from "../src/lib/scsem-official-manifest";
import {
    assertOfficialSCSEMReferenceIntegrity,
    assertSCSEMUpdaterSourceIntegrity,
    SCSEMSourceIntegrityError,
} from "../src/lib/scsem-source-integrity";
import type { SCSEMUpdaterSession } from "../src/lib/scsem-updater-store";
import { admitUnrecognizedSCSEMBuffer } from "../src/lib/scsem-structural-admission";

function sessionFor(
    originalFilePath: string,
    entry: ReturnType<typeof officialSCSEMManifest>["workbooks"][number]
): SCSEMUpdaterSession {
    return {
        id: "00000000-0000-4000-8000-000000000001",
        revision: 0,
        originalFileName: entry.fileName,
        originalFilePath,
        organizationId: "test-organization",
        createdByUserId: "test-reviewer",
        uploadedAt: "2026-07-22T00:00:00.000Z",
        inferredTechnology: entry.subject || entry.fileName,
        status: "uploaded",
        scsem: {
            subject: entry.subject,
            version: entry.version,
            effectiveDate: entry.effectiveDate,
            totalControls: entry.totalControls,
            testCaseSheets: entry.testCaseSheets,
        },
        changes: [],
        history: [],
        audit: {
            uploadedSha256: entry.sha256,
            uploadedSizeBytes: entry.sizeBytes,
            officialSource: entry,
        },
    };
}

function main() {
    const manifest = officialSCSEMManifest();
    const entry = manifest.workbooks[0];
    assert.ok(entry, "The pinned SCSEM manifest must contain a source workbook");
    const sourcePath = path.join(process.cwd(), entry.file);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skyshield-source-integrity-"));
    const uploadedPath = path.join(tempDir, entry.fileName);

    try {
        fs.copyFileSync(sourcePath, uploadedPath);
        const session = sessionFor(uploadedPath, entry);
        const verified = assertSCSEMUpdaterSourceIntegrity(session);
        assert.equal(verified.sha256, entry.sha256);
        assert.equal(verified.sizeBytes, entry.sizeBytes);
        assert.equal(verified.sourceTrust, "official_individual_xlsx");

        assert.throws(
            () => assertSCSEMUpdaterSourceIntegrity({
                ...session,
                audit: { ...session.audit, uploadedSha256: "0".repeat(64) },
            }),
            SCSEMSourceIntegrityError
        );
        assert.throws(
            () => assertSCSEMUpdaterSourceIntegrity({
                ...session,
                audit: { ...session.audit, officialSource: undefined },
            }),
            /missing its pinned IRS source identity/
        );

        const unverifiedPath = path.join(tempDir, "Safeguards-SCSEM-PostgreSQL17.xlsx");
        const unverifiedBuffer = Buffer.concat([
            fs.readFileSync(sourcePath),
            Buffer.from("SkyShield PostgreSQL17 structural-admission regression"),
        ]);
        fs.writeFileSync(unverifiedPath, unverifiedBuffer);
        const structuralAdmission = admitUnrecognizedSCSEMBuffer(
            path.basename(unverifiedPath),
            unverifiedBuffer
        );
        const unverifiedSession: SCSEMUpdaterSession = {
            ...session,
            originalFileName: path.basename(unverifiedPath),
            originalFilePath: unverifiedPath,
            workspaceMode: "unverified_update",
            audit: {
                uploadedSha256: structuralAdmission.sha256,
                uploadedSizeBytes: unverifiedBuffer.length,
                structuralAdmission,
            },
        };
        const verifiedUnrecognized = assertSCSEMUpdaterSourceIntegrity(unverifiedSession);
        assert.equal(verifiedUnrecognized.sha256, structuralAdmission.sha256);
        assert.equal(verifiedUnrecognized.sourceTrust, "unverified_structural_draft");
        assert.equal(verifiedUnrecognized.officialSource, undefined);
        assert.throws(
            () => assertSCSEMUpdaterSourceIntegrity({
                ...unverifiedSession,
                audit: {
                    ...unverifiedSession.audit,
                    structuralAdmission: {
                        ...structuralAdmission,
                        totalControls: structuralAdmission.totalControls + 1,
                    },
                },
            }),
            /no longer matches its recorded structural-admission evidence/
        );

        fs.appendFileSync(uploadedPath, Buffer.from([0]));
        assert.throws(
            () => assertSCSEMUpdaterSourceIntegrity(session),
            /changed after upload/
        );

        const rhel = manifest.workbooks.find((candidate) =>
            candidate.fileName === "Safeguards-SCSEM Red Hat Enterprise Linux (RHEL)-v7_02182025.xlsx"
        );
        assert.ok(rhel, "The pinned RHEL rebase workbook must exist");
        const reference: OfficialSCSEMReference = {
            family: "rhel",
            filePath: rhel.file,
            sourceUrl: rhel.sourceUrl,
            sourcePageUrl: manifest.sourcePageUrl,
            sha256: rhel.sha256,
            workbookVersion: rhel.version,
            workbookEffectiveDate: rhel.effectiveDate,
            irsEffectiveDate: rhel.effectiveDate || manifest.snapshotAcquiredAt,
            testCaseSheets: rhel.testCaseSheets,
            addedSheets: [],
            selectedAsBase: true,
            upgradeReason: "targeted integrity test",
        };
        const verifiedReference = assertOfficialSCSEMReferenceIntegrity(reference);
        assert.equal(verifiedReference.sha256, rhel.sha256);
        assert.throws(
            () => assertOfficialSCSEMReferenceIntegrity({
                ...reference,
                sha256: "0".repeat(64),
            }),
            /does not match the pinned manifest/
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    process.stdout.write("SCSEM runtime source integrity tests passed.\n");
}

main();
