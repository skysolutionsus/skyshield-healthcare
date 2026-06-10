import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditRequestContext, logAudit, truncateAuditText } from "@/lib/audit";
import {
    readSCSEMUpdaterSessionForUser,
    writeSCSEMUpdaterSession,
    type SCSEMUpdaterHistoryEntry,
} from "@/lib/scsem-updater-store";

export const runtime = "nodejs";

function latestStatusHistory(history: SCSEMUpdaterHistoryEntry[]): SCSEMUpdaterHistoryEntry | null {
    const lastUndoIndex = history.map((entry) => entry.action).lastIndexOf("undo");
    for (let i = history.length - 1; i > lastUndoIndex; i--) {
        const entry = history[i];
        if (entry.action === "status" && entry.changeId && entry.previousStatus && entry.nextStatus) {
            return entry;
        }
    }
    return null;
}

function auditChange(change: { id: string; action: string; testId: string; field: string; status: string; currentValue: string; proposedValue: string; reason: string; confidence?: string }) {
    return {
        id: change.id,
        action: change.action,
        testId: change.testId,
        field: change.field,
        status: change.status,
        confidence: change.confidence,
        currentValue: truncateAuditText(change.currentValue, 1000),
        proposedValue: truncateAuditText(change.proposedValue, 1800),
        reason: truncateAuditText(change.reason, 1200),
    };
}

export async function POST(
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
        const before = auditChange(change);
        change.status = previousStatus;
        updaterSession.history.push({
            at: new Date().toISOString(),
            action: "undo",
            changeId: change.id,
            previousStatus: previousCurrentStatus,
            nextStatus: change.status,
            description: "Reviewer undid the most recent approve/reject action.",
        });

        writeSCSEMUpdaterSession(updaterSession);
        await logAudit({
            organizationId: user.organizationId,
            userId: user.id,
            action: "SCSEM_UPDATER_UNDO",
            resourceType: "scsem_updater_session",
            resourceId: updaterSession.id,
            metadata: {
                input: {
                    undoneHistory: lastStatusChange,
                },
                output: {
                    change: {
                        before,
                        after: auditChange(change),
                    },
                    previousStatus: previousCurrentStatus,
                    restoredStatus: change.status,
                },
            },
            ...auditRequestContext(request),
        });
        return NextResponse.json({ session: updaterSession });
    } catch (error: any) {
        console.error("SCSEM updater undo error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to undo SCSEM updater review action." },
            { status: 500 }
        );
    }
}
