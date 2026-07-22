import type { SCSEMUpdaterChange } from "@/lib/scsem-updater-store";

function truncate(value: string | null | undefined, maxChars: number): string {
    if (!value) return "";
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}\n\n[Truncated for audit log storage]`;
}

/**
 * Serialize one review transition for the append-only audit log. Proposal
 * summaries and machine rationale remain bounded, but the reviewer-editable
 * new-control payload is already limited to 20,000 characters per field by
 * approval validation and must be retained in full for release traceability.
 */
export function scsemUpdaterAuditChange(change: SCSEMUpdaterChange) {
    return {
        id: change.id,
        action: change.action,
        testId: change.testId,
        field: change.field,
        status: change.status,
        confidence: change.confidence,
        currentValue: truncate(change.currentValue, 1_000),
        proposedValue: truncate(change.proposedValue, 1_800),
        reason: truncate(change.reason, 1_200),
        newControl: change.newControl ? { ...change.newControl } : null,
        sourceEvidence: change.sourceEvidence || null,
    };
}
