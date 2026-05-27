import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readSCSEMUpdaterSession } from "@/lib/scsem-updater-store";

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
        return NextResponse.json({ session: updaterSession });
    } catch (error: any) {
        const status = error.message?.includes("not found") ? 404 : 500;
        return NextResponse.json(
            { error: error.message || "Failed to load SCSEM updater session." },
            { status }
        );
    }
}
