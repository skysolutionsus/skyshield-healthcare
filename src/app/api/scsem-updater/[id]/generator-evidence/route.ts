import { NextResponse } from "next/server";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";
import { readSCSEMUpdaterSessionForUser } from "@/lib/scsem-updater-store";
import { scsemUpdaterRouteFailureDetails } from "@/lib/scsem-updater-route-failure";
import { resolveGeneratorPolicyEvidence } from "@/lib/scsem-generator-evidence";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const access = await requireScsemSteward();
        if (!access.ok) return access.response;
        const { id } = await params;
        const session = readSCSEMUpdaterSessionForUser(id, access.user);
        if (session.workspaceMode !== "cis_bootstrap") return NextResponse.json({
            error: "Policy mapping evidence is available only for CIS bootstrap drafts.",
        }, { status: 409 });
        const query = new URL(request.url).searchParams;
        if (!session.changes.some((change) => change.id === query.get("changeId") && change.action === "addControl")) {
            return NextResponse.json({ error: "Generator change not found." }, { status: 404 });
        }
        try {
            return NextResponse.json({ policy: resolveGeneratorPolicyEvidence(query.get("nistId") || "") }, {
                headers: { "Cache-Control": "private, no-store" },
            });
        } catch (error) {
            return NextResponse.json({ error: error instanceof Error ? error.message : "Pinned mapping evidence is unavailable." }, { status: 422 });
        }
    } catch (error) {
        const failure = scsemUpdaterRouteFailureDetails(error, "Could not load generator mapping evidence.");
        return NextResponse.json(failure.response, { status: failure.status });
    }
}
