import type { SCSEMUpdaterChange } from "@/lib/scsem-updater-store";

export type SCSEMProposalLike = Omit<Partial<SCSEMUpdaterChange>, "sourceEvidence"> & {
    sourceEvidence?: Record<string, unknown> | null;
};

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value);
}

function proposalTargetKey(change: SCSEMProposalLike): string {
    return [
        change.action || "updateField",
        change.targetSheet || text(change.sourceEvidence?.sourceSheet),
        change.testId || "",
        change.field || "",
    ].join("|");
}

export function scsemProposalSourceLabel(change: SCSEMProposalLike): string {
    const evidence = change.sourceEvidence || {};
    const sourceKind = text(evidence.sourceKind);
    if (sourceKind === "STIG") return "Public DISA STIG";
    if (sourceKind === "CIS_STIG" || text(evidence.stigRecommendation)) return "CIS-STIG benchmark";
    if (sourceKind === "CIS" || text(evidence.cisRecommendation)) return "CIS Benchmark";
    const complianceSource = text(evidence.complianceSource);
    if (complianceSource.includes("Publication 1075")) return "IRS Publication 1075";
    if (complianceSource.includes("NIST")) return "NIST mapping evidence";
    if (text(evidence.sourceRelationship) === "adjacent") return "Adjacent benchmark evidence";
    return "Unclassified evidence";
}

function proposalSourceIdentity(change: SCSEMProposalLike): string {
    const evidence = change.sourceEvidence || {};
    const sourceLabel = scsemProposalSourceLabel(change);
    if (sourceLabel === "Public DISA STIG") {
        return [sourceLabel, evidence.stigBenchmarkId, evidence.stigRuleId].map(text).join("|");
    }
    if (sourceLabel === "CIS Benchmark" || sourceLabel === "CIS-STIG benchmark") {
        return [
            sourceLabel,
            evidence.sourceWorkbenchId,
            evidence.cisRecommendation || evidence.stigRecommendation,
            evidence.cisProfile || evidence.stigProfile,
        ].map(text).join("|");
    }
    if (sourceLabel === "IRS Publication 1075" || sourceLabel === "NIST mapping evidence") {
        return [
            sourceLabel,
            evidence.pub1075ControlId || evidence.nistFallbackControlId,
            evidence.pub1075Version,
            evidence.nistVersion,
        ].map(text).join("|");
    }
    return [sourceLabel, evidence.sourceBenchmarkTitle, evidence.sourceRelationship].map(text).join("|");
}

/**
 * Remove repeated emissions from the same authority without allowing an earlier
 * Pub 1075/NIST proposal to erase a CIS or STIG proposal for the same cell.
 * Competing authorities must remain visible until strictness is resolved.
 */
export function dedupeSCSEMProposalsPreservingAuthorities<T extends SCSEMProposalLike>(changes: T[]): T[] {
    const seen = new Set<string>();
    return changes.filter((change) => {
        const key = `${proposalTargetKey(change)}|${proposalSourceIdentity(change)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Mark cells for which direct authorities propose materially different values.
 * SkyShield's AI should choose the stricter applicable requirement when it can
 * do so safely. If it cannot, this metadata forces an explicit human choice and
 * prevents bulk approval from silently applying competing values in sequence.
 */
export function annotateSCSEMStrictnessConflicts<T extends SCSEMProposalLike>(changes: T[]): T[] {
    const groups = new Map<string, T[]>();
    for (const change of changes) {
        if (change.action === "addControl") continue;
        const key = proposalTargetKey(change);
        groups.set(key, [...(groups.get(key) || []), change]);
    }

    const conflicting = new Map<string, { labels: string[]; count: number }>();
    for (const [key, group] of groups) {
        const values = new Set(group.map((change) => text(change.proposedValue).toLowerCase()).filter(Boolean));
        const labels = [...new Set(group.map(scsemProposalSourceLabel))];
        if (values.size > 1 && labels.length > 1) conflicting.set(key, { labels, count: group.length });
    }

    return changes.map((change) => {
        const key = proposalTargetKey(change);
        const conflict = conflicting.get(key);
        if (!conflict) return change;
        return {
            ...change,
            confidence: "needs_review",
            reason:
                `Strictest-control review required across ${conflict.labels.join(", ")}. ` +
                "Approve only the proposal that preserves the strictest applicable requirement; competing proposals for this cell are mutually exclusive. " +
                text(change.reason),
            sourceEvidence: {
                ...(change.sourceEvidence || {}),
                strictnessGroupId: key,
                strictnessSelectionRequired: true,
                competingAuthorityCount: conflict.count,
                competingAuthorities: conflict.labels,
            },
        } as T;
    });
}

export function strictnessApprovalErrors({
    candidate,
    allChanges,
    approvingIds,
}: {
    candidate: SCSEMProposalLike;
    allChanges: SCSEMProposalLike[];
    approvingIds: Set<string>;
}): string[] {
    const groupId = text(candidate.sourceEvidence?.strictnessGroupId);
    if (!groupId) return [];
    const conflicts = allChanges.filter((change) =>
        text(change.sourceEvidence?.strictnessGroupId) === groupId && change.id !== candidate.id
    );
    const simultaneouslyApproved = conflicts.some((change) => approvingIds.has(text(change.id)));
    const previouslyApproved = conflicts.some((change) => change.status === "APPROVED");
    if (!simultaneouslyApproved && !previouslyApproved) return [];
    return [
        "Competing source proposals for the same SCSEM cell are mutually exclusive; approve only the strictest applicable control after reviewing CIS, STIG, and Publication 1075 evidence",
    ];
}
