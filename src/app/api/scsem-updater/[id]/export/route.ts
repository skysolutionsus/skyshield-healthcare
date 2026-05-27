import * as fs from "fs";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
    readSCSEMUpdaterSession,
    resolveUpdaterPath,
} from "@/lib/scsem-updater-store";
import { parseSCSEMFile } from "@/lib/xlsx-parser";
import {
    buildSCSEMUpdaterWorkbookBuffer,
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

        const { id } = await params;
        const updaterSession = readSCSEMUpdaterSession(id);
        const originalPath = resolveUpdaterPath(updaterSession.originalFilePath);
        const approvedChanges = updaterSession.changes.filter((change) => change.status === "APPROVED");
        const buffer = approvedChanges.length === 0
            ? fs.readFileSync(originalPath)
            : await buildSCSEMUpdaterWorkbookBuffer(
                updaterSession,
                parseSCSEMFile(originalPath),
                originalPath
            );

        return new Response(new Uint8Array(buffer), {
            status: 200,
            headers: {
                "Content-Type":
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": `attachment; filename="${updatedSCSEMFileName(updaterSession.originalFileName)}"`,
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
