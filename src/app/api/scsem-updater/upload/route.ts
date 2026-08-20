import { NextResponse } from "next/server";
import { auditRequestContext } from "@/lib/audit";
import {
    createSCSEMUpdaterSession,
    scsemUpdaterRevisionETag,
} from "@/lib/scsem-updater-store";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";
import { matchOfficialSCSEM } from "@/lib/scsem-official-manifest";
import { admitUnrecognizedSCSEMBuffer } from "@/lib/scsem-structural-admission";
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
        let structuralAdmission: ReturnType<typeof admitUnrecognizedSCSEMBuffer> | undefined;
        if (!officialSource) {
            try {
                structuralAdmission = admitUnrecognizedSCSEMBuffer(file.name, buffer);
            } catch (error) {
                return NextResponse.json({
                    error: error instanceof Error
                        ? error.message
                        : "Workbook is not a recognizable blank SCSEM template.",
                    code: "UNRECOGNIZED_SCSEM_STRUCTURE",
                }, { status: 422 });
            }
        }

        // Exact manifest matches use canonical identity. A structurally valid
        // non-match keeps the sanitized uploaded name and is permanently gated
        // as an unverified working draft rather than being misrepresented as an
        // official current IRS source.
        const updaterSession = await createSCSEMUpdaterSession(
            officialSource?.fileName || file.name,
            buffer,
            {
                organizationId: user.organizationId,
                userId: user.id,
            },
            officialSource || undefined,
            {
                action: "SCSEM_UPDATER_UPLOAD",
                affectedPayload: {
                    fileName: file.name,
                    canonicalFileName: officialSource?.fileName || null,
                    sizeBytes: buffer.length,
                    extension,
                    uploadedSha256: officialSource?.sha256 || structuralAdmission?.sha256,
                    officialSourceUrl: officialSource?.sourceUrl || null,
                    officialSourceSha256: officialSource?.sha256 || null,
                    sourceTrust: officialSource ? "official_individual_xlsx" : structuralAdmission?.trust,
                    testCaseSheets: structuralAdmission?.testCaseSheets,
                    totalControls: structuralAdmission?.totalControls,
                },
                ...auditRequestContext(request),
            },
            structuralAdmission
                ? {
                    workspaceMode: "unverified_update",
                    structuralAdmission,
                }
                : { workspaceMode: "official_update" }
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
