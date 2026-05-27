import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
    readSCSEMUpdaterSession,
    writeSCSEMUpdaterSession,
    type SCSEMUpdaterChange,
    type SCSEMUpdaterChangeStatus,
} from "@/lib/scsem-updater-store";

export const runtime = "nodejs";

const STATUSES = new Set(["PENDING", "APPROVED", "REJECTED"]);

function isStatus(value: unknown): value is SCSEMUpdaterChangeStatus {
    return typeof value === "string" && STATUSES.has(value);
}

function mergeEditableChange(current: SCSEMUpdaterChange, patch: Partial<SCSEMUpdaterChange>): SCSEMUpdaterChange {
    return {
        ...current,
        proposedValue: typeof patch.proposedValue === "string" ? patch.proposedValue : current.proposedValue,
        reason: typeof patch.reason === "string" ? patch.reason : current.reason,
        confidence: typeof patch.confidence === "string" ? patch.confidence : current.confidence,
        sourceEvidence: patch.sourceEvidence && typeof patch.sourceEvidence === "object"
            ? patch.sourceEvidence
            : current.sourceEvidence,
        newControl: patch.newControl && typeof patch.newControl === "object"
            ? { ...(current.newControl || {}), ...patch.newControl }
            : current.newControl,
    };
}

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { id } = await params;
        const body = await request.json();
        const nextStatus = body.status;
        if (nextStatus !== undefined && !isStatus(nextStatus)) {
            return NextResponse.json({ error: "Invalid change status." }, { status: 400 });
        }

        const changeIds = Array.isArray(body.changeIds)
            ? body.changeIds
            : body.changeId
                ? [body.changeId]
                : [];

        if (changeIds.length === 0) {
            return NextResponse.json({ error: "Missing change id." }, { status: 400 });
        }

        const updaterSession = readSCSEMUpdaterSession(id);
        const ids = new Set(changeIds.map(String));
        let touched = 0;

        updaterSession.changes = updaterSession.changes.map((change) => {
            if (!ids.has(change.id)) return change;
            touched++;

            const edited = body.change && body.changeId === change.id
                ? mergeEditableChange(change, body.change)
                : change;
            const previousStatus = edited.status;
            const updated = nextStatus ? { ...edited, status: nextStatus } : edited;

            if (nextStatus && previousStatus !== nextStatus) {
                updaterSession.history.push({
                    at: new Date().toISOString(),
                    action: "status",
                    changeId: change.id,
                    previousStatus,
                    nextStatus,
                });
            } else if (body.change && body.changeId === change.id) {
                updaterSession.history.push({
                    at: new Date().toISOString(),
                    action: "edit",
                    changeId: change.id,
                    description: "Reviewer adjusted proposed SCSEM updater change.",
                });
            }

            return updated;
        });

        if (touched === 0) {
            return NextResponse.json({ error: "SCSEM updater change not found." }, { status: 404 });
        }

        writeSCSEMUpdaterSession(updaterSession);
        return NextResponse.json({ session: updaterSession });
    } catch (error: any) {
        console.error("SCSEM updater change update error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to update SCSEM updater change." },
            { status: 500 }
        );
    }
}
