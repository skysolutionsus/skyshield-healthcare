import { NextResponse } from "next/server";
import { auditRequestContext } from "@/lib/audit";
import {
    createSCSEMUpdaterSession,
    scsemUpdaterRevisionETag,
} from "@/lib/scsem-updater-store";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";
import { matchOfficialSCSEM, officialSCSEMManifest } from "@/lib/scsem-official-manifest";
import { scsemUpdaterRouteFailureDetails } from "@/lib/scsem-updater-route-failure";
import { clientSafeSCSEMUpdaterSession } from "@/lib/scsem-updater-client-session";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 75 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".xlsx", ".xlsm"]);

function extensionOf(fileName: string): string {
    const match = fileName.toLowerCase().match(/\.[a-z0-9]+$/);
    return match?.[0] || "";
}

function isOpenXmlWorkbook(buffer: Buffer): boolean {
    return buffer.length >= 4 &&
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        buffer[2] === 0x03 &&
        buffer[3] === 0x04;
}

export async function POST(request: Request) {
    try {
        const access = await requireScsemSteward();
        if (!access.ok) return access.response;
        const user = access.user;

        const formData = await request.formData();
        const file = formData.get("file");
        if (!(file instanceof File)) {
            return NextResponse.json({ error: "Upload an IRS SCSEM Excel file." }, { status: 400 });
        }

        const extension = extensionOf(file.name);
        if (!ALLOWED_EXTENSIONS.has(extension)) {
            return NextResponse.json({ error: "SCSEM upload must be an Excel workbook (.xlsx or .xlsm)." }, { status: 400 });
        }

        if (file.size > MAX_UPLOAD_BYTES) {
            return NextResponse.json({ error: "SCSEM workbook is too large for upload." }, { status: 413 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        if (buffer.length === 0) {
            return NextResponse.json({ error: "Uploaded workbook was empty." }, { status: 400 });
        }

        if (!isOpenXmlWorkbook(buffer)) {
            return NextResponse.json({ error: "Uploaded file is not a valid Office Open XML workbook." }, { status: 400 });
        }

        const officialSource = matchOfficialSCSEM(buffer);
        if (!officialSource) {
            const manifest = officialSCSEMManifest();
            return NextResponse.json({
                error:
                    `Workbook does not match any of the ${manifest.expectedWorkbookCount} ` +
                    "current individual IRS-listed SCSEM source files. Use the template's " +
                    "individual XLSX link on the IRS SCSEM updates page; the separately linked " +
                    "package ZIP is not a canonical input because its workbook copies conflict " +
                    "with the current individual downloads.",
                code: "UNRECOGNIZED_SCSEM_SOURCE",
                sourcePageUrl: manifest.sourcePageUrl,
                sourcePageReviewedAt: manifest.sourcePageReviewedAt,
            }, { status: 422 });
        }

        // Canonical identity comes from the pinned manifest, not the browser's
        // user-controlled filename (the exact workbook hash has already matched).
        const updaterSession = await createSCSEMUpdaterSession(
            officialSource.fileName,
            buffer,
            {
                organizationId: user.organizationId,
                userId: user.id,
            },
            officialSource,
            {
                action: "SCSEM_UPDATER_UPLOAD",
                affectedPayload: {
                    fileName: file.name,
                    canonicalFileName: officialSource.fileName,
                    sizeBytes: buffer.length,
                    extension,
                    uploadedSha256: officialSource.sha256,
                    officialSourceUrl: officialSource.sourceUrl,
                    officialSourceSha256: officialSource.sha256,
                },
                ...auditRequestContext(request),
            }
        );
        return NextResponse.json(
            { session: clientSafeSCSEMUpdaterSession(updaterSession) },
            { headers: { ETag: scsemUpdaterRevisionETag(updaterSession) } }
        );
    } catch (error: unknown) {
        console.error("SCSEM updater upload error:", error);
        const failure = scsemUpdaterRouteFailureDetails(
            error,
            "Failed to upload the SCSEM workbook."
        );
        return NextResponse.json(failure.response, { status: failure.status });
    }
}
