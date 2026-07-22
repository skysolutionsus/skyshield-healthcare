import { NextResponse } from "next/server";
import { auditRequestContext } from "@/lib/audit";
import {
    assertSCSEMUpdaterRevision,
    readSCSEMUpdaterSessionForUser,
    isSCSEMUpdaterReviewableStatus,
    requireSCSEMUpdaterExpectedRevision,
    scsemUpdaterRevisionETag,
    writeSCSEMUpdaterSession,
    type SCSEMUpdaterChange,
    type SCSEMUpdaterChangeStatus,
} from "@/lib/scsem-updater-store";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";
import { approvedProposalValidationErrors } from "@/lib/scsem-proposal-validation";
import { scsemUpdaterRouteFailureDetails } from "@/lib/scsem-updater-route-failure";
import {
    readSCSEMIssueCodeCatalog,
    resolveSCSEMIssueCodeSelection,
    SCSEMIssueCodeError,
    type SCSEMIssueCodeEntry,
} from "@/lib/scsem-issue-codes";
import { assertSCSEMUpdaterSourceIntegrity } from "@/lib/scsem-source-integrity";
import { scsemUpdaterAuditChange } from "@/lib/scsem-change-audit";
import { clientSafeSCSEMUpdaterSession } from "@/lib/scsem-updater-client-session";
import {
    readSCSEMNewControlTargetSchemas,
    type SCSEMNewControlTargetSchema,
} from "@/lib/scsem-new-control-schema";

export const runtime = "nodejs";

const STATUSES = new Set(["PENDING", "APPROVED", "REJECTED"]);
const EDITABLE_CHANGE_KEYS = new Set(["proposedValue", "newControl"]);
const EDITABLE_NEW_CONTROL_KEYS = new Set([
    "nistId",
    "nistControlName",
    "testMethod",
    "sectionTitle",
    "description",
    "testProcedures",
    "expectedResults",
    "findingStatement",
    "criticality",
    "issueCode",
    "cisBenchmarkRef",
    "recommendationNum",
    "rationale",
    "impact",
    "remediationProcedure",
]);

function isStatus(value: unknown): value is SCSEMUpdaterChangeStatus {
    return typeof value === "string" && STATUSES.has(value);
}

function mergeEditableChange(current: SCSEMUpdaterChange, patch: Partial<SCSEMUpdaterChange>): SCSEMUpdaterChange {
    const editableNewControl = patch.newControl && typeof patch.newControl === "object"
        ? Object.fromEntries(Object.entries(patch.newControl).filter(([key, value]) =>
            EDITABLE_NEW_CONTROL_KEYS.has(key) && (typeof value === "string" || value === null)
        ))
        : null;
    return {
        ...current,
        proposedValue: typeof patch.proposedValue === "string" ? patch.proposedValue : current.proposedValue,
        newControl: editableNewControl
            ? { ...(current.newControl || {}), ...editableNewControl }
            : current.newControl,
    };
}

function invalidEditableKeys(patch: unknown): string[] {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return [];
    const value = patch as Record<string, unknown>;
    const invalid = Object.keys(value).filter((key) => !EDITABLE_CHANGE_KEYS.has(key));
    if (value.newControl && typeof value.newControl === "object" && !Array.isArray(value.newControl)) {
        invalid.push(...Object.keys(value.newControl as Record<string, unknown>)
            .filter((key) => !EDITABLE_NEW_CONTROL_KEYS.has(key))
            .map((key) => `newControl.${key}`));
    }
    return invalid;
}

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const access = await requireScsemSteward();
        if (!access.ok) return access.response;
        const user = access.user;

        const { id } = await params;
        const expectedRevision = requireSCSEMUpdaterExpectedRevision(request);
        const body = await request.json();
        if (
            body.change !== undefined &&
            (!body.change || typeof body.change !== "object" || Array.isArray(body.change))
        ) {
            return NextResponse.json({ error: "Change edits must be a JSON object." }, { status: 400 });
        }
        const invalidKeys = invalidEditableKeys(body.change);
        if (invalidKeys.length > 0) {
            return NextResponse.json({
                error: "Proposal evidence, target identity, confidence, and machine rationale are immutable.",
                invalidFields: invalidKeys,
            }, { status: 400 });
        }
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
        assertSCSEMUpdaterRevision(updaterSession, expectedRevision);
        if (!isSCSEMUpdaterReviewableStatus(updaterSession.status)) {
            return NextResponse.json({
                error: "Proposals can only be reviewed after analysis has finished.",
                code: "SCSEM_SESSION_NOT_REVIEWABLE",
            }, { status: 409 });
        }
        const ids = new Set(changeIds.map(String));
        let issueCodeCatalog: Map<string, SCSEMIssueCodeEntry> | null = null;
        let targetSchemas = new Map<string, SCSEMNewControlTargetSchema>();
        const approvingNewControl = nextStatus === "APPROVED" && updaterSession.changes.some(
            (change) => ids.has(change.id) && change.action === "addControl"
        );
        if (approvingNewControl) {
            const verifiedSource = assertSCSEMUpdaterSourceIntegrity(updaterSession);
            issueCodeCatalog = readSCSEMIssueCodeCatalog(verifiedSource.absolutePath);
            const targetSheets = updaterSession.changes
                .filter((change) => ids.has(change.id) && change.action === "addControl")
                .map((change) => change.targetSheet?.trim() || "")
                .filter(Boolean);
            targetSchemas = readSCSEMNewControlTargetSchemas(
                verifiedSource.absolutePath,
                verifiedSource.sha256,
                targetSheets
            );
        }
        let touched = 0;
        const approvalErrors: Array<{ changeId: string; errors: string[] }> = [];
        const affectedChanges: Array<{
            before: ReturnType<typeof scsemUpdaterAuditChange>;
            after: ReturnType<typeof scsemUpdaterAuditChange>;
            previousStatus: SCSEMUpdaterChangeStatus;
            nextStatus: SCSEMUpdaterChangeStatus;
            edited: boolean;
        }> = [];

        updaterSession.changes = updaterSession.changes.map((change) => {
            if (!ids.has(change.id)) return change;
            touched++;

            const wasEdited = Boolean(body.change && body.changeId === change.id);
            const edited = wasEdited
                ? mergeEditableChange(change, body.change)
                : change;
            const previousStatus = change.status;
            // A saved edit invalidates an earlier approval unless the reviewer
            // explicitly approves the edited value in this same request.
            const resolvedStatus = nextStatus || (wasEdited ? "PENDING" : edited.status);
            let updated = { ...edited, status: resolvedStatus };
            if (resolvedStatus === "APPROVED") {
                const errors = approvedProposalValidationErrors(updated);
                if (updated.action === "addControl" && issueCodeCatalog) {
                    const targetSheet = updated.targetSheet?.trim() || "";
                    const targetSchema = targetSchemas.get(targetSheet);
                    if (!targetSheet || !targetSchema) {
                        errors.push("newControl requires an exact target SCSEM sheet");
                    } else if (targetSchema.findingStatement === "ambiguous") {
                        errors.push(
                            `target sheet ${targetSheet} has ambiguous Finding Statement columns`
                        );
                    } else if (
                        targetSchema.findingStatement === "unique" &&
                        !updated.newControl?.findingStatement?.trim()
                    ) {
                        errors.push(
                            "newControl.findingStatement must not be blank for the selected template sheet"
                        );
                    }
                    try {
                        const selection = resolveSCSEMIssueCodeSelection(
                            issueCodeCatalog,
                            updated.newControl?.issueCode
                        );
                        updated = {
                            ...updated,
                            newControl: {
                                ...(updated.newControl || {}),
                                issueCode: selection.issueCode,
                            },
                        };
                    } catch (error) {
                        errors.push(error instanceof SCSEMIssueCodeError
                            ? error.message
                            : "The selected issue code could not be validated.");
                    }
                }
                if (errors.length > 0) approvalErrors.push({ changeId: change.id, errors });
            }

            if (nextStatus && previousStatus !== nextStatus) {
                updaterSession.history.push({
                    at: new Date().toISOString(),
                    action: "status",
                    changeId: change.id,
                    previousStatus,
                    nextStatus,
                });
            } else if (wasEdited) {
                updaterSession.history.push({
                    at: new Date().toISOString(),
                    action: "edit",
                    changeId: change.id,
                    description: "Reviewer adjusted proposed SCSEM updater change.",
                });
            }

            affectedChanges.push({
                before: scsemUpdaterAuditChange(change),
                after: scsemUpdaterAuditChange(updated),
                previousStatus,
                nextStatus: updated.status,
                edited: wasEdited,
            });

            return updated;
        });

        if (touched === 0) {
            return NextResponse.json({ error: "SCSEM updater change not found." }, { status: 404 });
        }
        if (approvalErrors.length > 0) {
            return NextResponse.json({
                error: "One or more proposals are not complete enough to approve.",
                code: "INVALID_APPROVED_PROPOSAL",
                changes: approvalErrors,
            }, { status: 400 });
        }

        await writeSCSEMUpdaterSession(updaterSession, expectedRevision, {
            action: nextStatus ? "SCSEM_UPDATER_REVIEW" : "SCSEM_UPDATER_EDIT",
            affectedPayload: {
                request: {
                    changeIds: changeIds.map(String),
                    requestedStatus: nextStatus || null,
                    editedChangeId: body.changeId || null,
                },
                result: {
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
        return NextResponse.json(
            { session: clientSafeSCSEMUpdaterSession(updaterSession) },
            { headers: { ETag: scsemUpdaterRevisionETag(updaterSession) } }
        );
    } catch (error: unknown) {
        console.error("SCSEM updater change update error:", error);
        const failure = scsemUpdaterRouteFailureDetails(
            error,
            "Failed to update the SCSEM updater change."
        );
        return NextResponse.json(failure.response, { status: failure.status });
    }
}
