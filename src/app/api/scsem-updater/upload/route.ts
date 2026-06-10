import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditRequestContext, logAudit } from "@/lib/audit";
import { createSCSEMUpdaterSession } from "@/lib/scsem-updater-store";

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
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const user = session.user as unknown as { id: string; organizationId: string };

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

        const updaterSession = createSCSEMUpdaterSession(file.name, buffer, {
            organizationId: user.organizationId,
            userId: user.id,
        });
        await logAudit({
            organizationId: user.organizationId,
            userId: user.id,
            action: "SCSEM_UPDATER_UPLOAD",
            resourceType: "scsem_updater_session",
            resourceId: updaterSession.id,
            metadata: {
                input: {
                    fileName: file.name,
                    sizeBytes: buffer.length,
                    extension,
                },
                output: {
                    sessionId: updaterSession.id,
                    inferredTechnology: updaterSession.inferredTechnology,
                    totalControls: updaterSession.scsem.totalControls,
                    testCaseSheets: updaterSession.scsem.testCaseSheets,
                    scsemVersion: updaterSession.scsem.version,
                    effectiveDate: updaterSession.scsem.effectiveDate,
                    uploadedSha256: updaterSession.audit.uploadedSha256,
                },
            },
            ...auditRequestContext(request),
        });
        return NextResponse.json({ session: updaterSession });
    } catch (error: any) {
        console.error("SCSEM updater upload error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to upload SCSEM workbook." },
            { status: 500 }
        );
    }
}
