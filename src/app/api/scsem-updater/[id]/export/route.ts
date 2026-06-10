import * as fs from "fs";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditRequestContext, logAudit } from "@/lib/audit";
import {
    readSCSEMUpdaterSessionForUser,
    resolveUpdaterPath,
} from "@/lib/scsem-updater-store";
import { parseSCSEMFile } from "@/lib/xlsx-parser";
import {
    buildSCSEMUpdaterWorkbookBuffer,
    excelContentTypeForFileName,
    updatedSCSEMFileName,
} from "@/lib/scsem-workbook-export";

export const runtime = "nodejs";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const user = session.user as unknown as { id: string; organizationId: string };

        const { id } = await params;
        const updaterSession = readSCSEMUpdaterSessionForUser(id, user);
        const originalPath = resolveUpdaterPath(updaterSession.originalFilePath);
        const approvedChanges = updaterSession.changes.filter((change) => change.status === "APPROVED");
        const exportFileName = updatedSCSEMFileName(updaterSession.originalFileName);
        const buffer = approvedChanges.length === 0
            ? fs.readFileSync(originalPath)
            : await buildSCSEMUpdaterWorkbookBuffer(
                updaterSession,
                parseSCSEMFile(originalPath),
                originalPath
            );

        await logAudit({
            organizationId: user.organizationId,
            userId: user.id,
            action: "SCSEM_UPDATER_EXPORT",
            resourceType: "scsem_updater_session",
            resourceId: updaterSession.id,
            metadata: {
                input: {
                    fileName: updaterSession.originalFileName,
                    inferredTechnology: updaterSession.inferredTechnology,
                    approvedChangeIds: approvedChanges.map((change) => change.id),
                },
                output: {
                    exportFileName,
                    outputSizeBytes: buffer.length,
                    changeCounts: {
                        approved: approvedChanges.length,
                        pending: updaterSession.changes.filter((change) => change.status === "PENDING").length,
                        rejected: updaterSession.changes.filter((change) => change.status === "REJECTED").length,
                    },
                    auditSources: updaterSession.audit,
                },
            },
            ...auditRequestContext(request),
        });

        return new Response(new Uint8Array(buffer), {
            status: 200,
            headers: {
                "Content-Type": excelContentTypeForFileName(exportFileName),
                "Content-Disposition": `attachment; filename="${exportFileName}"`,
            },
        });
    } catch (error: any) {
        console.error("SCSEM updater export error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to export updated SCSEM workbook." },
            { status: 500 }
        );
    }
}
