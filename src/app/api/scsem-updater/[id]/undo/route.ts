import { NextResponse } from "next/server";
import { auditRequestContext } from "@/lib/audit";
import {
    assertSCSEMUpdaterRevision,
    readSCSEMUpdaterSessionForUser,
    isSCSEMUpdaterReviewableStatus,
    requireSCSEMUpdaterExpectedRevision,
    scsemUpdaterRevisionETag,
    writeSCSEMUpdaterSession,
    type SCSEMUpdaterHistoryEntry,
} from "@/lib/scsem-updater-store";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";
import { scsemUpdaterRouteFailureDetails } from "@/lib/scsem-updater-route-failure";
import { clientSafeSCSEMUpdaterSession } from "@/lib/scsem-updater-client-session";

export const runtime = "nodejs";

function latestStatusHistory(history: SCSEMUpdaterHistoryEntry[]): SCSEMUpdaterHistoryEntry | null {
    const lastBoundaryIndex = history.reduce((latest, entry, index) =>
        (["undo", "edit", "analyze"].includes(entry.action) ? index : latest), -1);
    for (let i = history.length - 1; i > lastBoundaryIndex; i--) {
        const entry = history[i];
        if (entry.action === "status" && entry.changeId && entry.previousStatus && entry.nextStatus) {
            return entry;
        }
    }
    return null;
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const access = await requireScsemSteward();
        if (!access.ok) return access.response;
        const user = access.user;

        const { id } = await params;
        const expectedRevision = requireSCSEMUpdaterExpectedRevision(request);
        const updaterSession = readSCSEMUpdaterSessionForUser(id, user);
        assertSCSEMUpdaterRevision(updaterSession, expectedRevision);
        if (!isSCSEMUpdaterReviewableStatus(updaterSession.status)) {
            return NextResponse.json({
                error: "Review actions can only be undone after analysis has finished.",
                code: "SCSEM_SESSION_NOT_REVIEWABLE",
            }, { status: 409 });
        }
        const lastStatusChange = latestStatusHistory(updaterSession.history);
        if (!lastStatusChange) {
            return NextResponse.json({ error: "No review action is available to undo." }, { status: 400 });
        }

        const change = updaterSession.changes.find((candidate) => candidate.id === lastStatusChange.changeId);
        if (!change) {
            return NextResponse.json({ error: "The change for the last review action no longer exists." }, { status: 404 });
        }

        const previousStatus = lastStatusChange.previousStatus;
        if (!previousStatus) {
            return NextResponse.json({ error: "No review action is available to undo." }, { status: 400 });
        }

        const previousCurrentStatus = change.status;
        const before = structuredClone(change);
        change.status = previousStatus;
        updaterSession.history.push({
            at: new Date().toISOString(),
            action: "undo",
            changeId: change.id,
            previousStatus: previousCurrentStatus,
            nextStatus: change.status,
            description: "Reviewer undid the most recent approve/reject action.",
        });

        await writeSCSEMUpdaterSession(updaterSession, expectedRevision, {
            action: "SCSEM_UPDATER_UNDO",
            affectedPayload: {
                request: {
                    undoneHistory: lastStatusChange,
                },
                result: {
                    change: {
                        before,
                        after: change,
                    },
                    previousStatus: previousCurrentStatus,
                    restoredStatus: change.status,
                },
            },
            ...auditRequestContext(request),
        });
        return NextResponse.json(
            { session: clientSafeSCSEMUpdaterSession(updaterSession) },
            { headers: { ETag: scsemUpdaterRevisionETag(updaterSession) } }
        );
    } catch (error: unknown) {
        console.error("SCSEM updater undo error:", error);
        const failure = scsemUpdaterRouteFailureDetails(
            error,
            "Failed to undo the SCSEM updater review action."
        );
        return NextResponse.json(failure.response, { status: failure.status });
    }
}
