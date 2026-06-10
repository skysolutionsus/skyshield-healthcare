import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditRequestContext, logAudit, truncateAuditText } from "@/lib/audit";
import {
    readSCSEMUpdaterSessionForUser,
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

function auditChange(change: SCSEMUpdaterChange) {
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
        sourceEvidence: change.sourceEvidence || null,
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
        const user = session.user as unknown as { id: string; organizationId: string };

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

        const updaterSession = readSCSEMUpdaterSessionForUser(id, user);
        const ids = new Set(changeIds.map(String));
        let touched = 0;
        const affectedChanges: Array<{
            before: ReturnType<typeof auditChange>;
            after: ReturnType<typeof auditChange>;
            previousStatus: SCSEMUpdaterChangeStatus;
            nextStatus: SCSEMUpdaterChangeStatus;
            edited: boolean;
        }> = [];

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

            affectedChanges.push({
                before: auditChange(change),
                after: auditChange(updated),
                previousStatus,
                nextStatus: updated.status,
                edited: Boolean(body.change && body.changeId === change.id),
            });

            return updated;
        });

        if (touched === 0) {
            return NextResponse.json({ error: "SCSEM updater change not found." }, { status: 404 });
        }

        writeSCSEMUpdaterSession(updaterSession);
        await logAudit({
            organizationId: user.organizationId,
            userId: user.id,
            action: nextStatus ? "SCSEM_UPDATER_REVIEW" : "SCSEM_UPDATER_EDIT",
            resourceType: "scsem_updater_session",
            resourceId: updaterSession.id,
            metadata: {
                input: {
                    changeIds: changeIds.map(String),
                    requestedStatus: nextStatus || null,
                    editedChangeId: body.changeId || null,
                },
                output: {
                    touched,
                    affectedChanges,
                    totals: {
                        pending: updaterSession.changes.filter((change) => change.status === "PENDING").length,
                        approved: updaterSession.changes.filter((change) => change.status === "APPROVED").length,
                        rejected: updaterSession.changes.filter((change) => change.status === "REJECTED").length,
                    },
                },
            },
            ...auditRequestContext(request),
        });
        return NextResponse.json({ session: updaterSession });
    } catch (error: any) {
        console.error("SCSEM updater change update error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to update SCSEM updater change." },
            { status: 500 }
        );
    }
}
