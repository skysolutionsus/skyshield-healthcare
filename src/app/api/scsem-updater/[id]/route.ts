import { NextResponse } from "next/server";
import {
    readSCSEMUpdaterSessionForUser,
    scsemUpdaterRevisionETag,
} from "@/lib/scsem-updater-store";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";
import { scsemUpdaterRouteFailureDetails } from "@/lib/scsem-updater-route-failure";
import { clientSafeSCSEMUpdaterSession } from "@/lib/scsem-updater-client-session";

export const runtime = "nodejs";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const access = await requireScsemSteward();
        if (!access.ok) return access.response;

        const { id } = await params;
        const updaterSession = readSCSEMUpdaterSessionForUser(id, access.user);
        return NextResponse.json(
            { session: clientSafeSCSEMUpdaterSession(updaterSession) },
            { headers: { ETag: scsemUpdaterRevisionETag(updaterSession) } }
        );
    } catch (error: unknown) {
        console.error("SCSEM updater session load error:", error);
        const failure = scsemUpdaterRouteFailureDetails(
            error,
            "Failed to load the SCSEM updater session."
        );
        return NextResponse.json(failure.response, { status: failure.status });
    }
}
