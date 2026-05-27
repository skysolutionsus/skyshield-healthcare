import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createSCSEMUpdaterSession } from "@/lib/scsem-updater-store";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 75 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".xlsx", ".xlsm"]);

function extensionOf(fileName: string): string {
    const match = fileName.toLowerCase().match(/\.[a-z0-9]+$/);
    return match?.[0] || "";
}

export async function POST(request: Request) {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

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

        const updaterSession = createSCSEMUpdaterSession(file.name, buffer);
        return NextResponse.json({ session: updaterSession });
    } catch (error: any) {
        console.error("SCSEM updater upload error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to upload SCSEM workbook." },
            { status: 500 }
        );
    }
}
