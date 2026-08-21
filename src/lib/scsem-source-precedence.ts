import type { SCSEMUpdaterChange } from "@/lib/scsem-updater-store";

export type SCSEMProposalLike = Omit<Partial<SCSEMUpdaterChange>, "sourceEvidence"> & {
    sourceEvidence?: Record<string, unknown> | null;
};

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value);
}

function semanticNewControlIdentity(change: SCSEMProposalLike): string {
    const newControl = change.newControl || {};
    const nistId = text(newControl.nistId).toUpperCase().replace(/\s+/g, "");
    const title = text(newControl.sectionTitle || change.proposedValue)
        .toLowerCase()
        .replace(/\b(?:cis|disa|stig|benchmark|recommendation|review|applicable|ensure|that|the|a|an)\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return `nist:${nistId || "none"}|title:${title}`;
}

function proposalTargetKey(change: SCSEMProposalLike): string {
    const action = change.action || "updateField";
    const targetSheet = change.targetSheet || text(change.sourceEvidence?.sourceSheet);
    if (action === "addControl") {
        return [action, targetSheet, semanticNewControlIdentity(change), "newControl"].join("|");
    }
    return [action, targetSheet, change.testId || "", change.field || ""].join("|");
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
        const key = proposalTargetKey(change);
        groups.set(key, [...(groups.get(key) || []), change]);
    }

    const conflicting = new Map<string, { labels: string[]; count: number }>();
    for (const [key, group] of groups) {
        const values = new Set(group.map((change) => text(change.proposedValue).toLowerCase()).filter(Boolean));
        const labels = [...new Set(group.map(scsemProposalSourceLabel))];
        const newControlConflict = group.some((change) => change.action === "addControl") && labels.length > 1;
        if ((values.size > 1 && labels.length > 1) || newControlConflict) {
            conflicting.set(key, { labels, count: group.length });
        }
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
    const candidateIdentity = proposalSourceIdentity(candidate);
    let skippedCandidate = false;
    const conflicts = allChanges.filter((change) => {
        if (text(change.sourceEvidence?.strictnessGroupId) !== groupId) return false;
        const isCandidate = !skippedCandidate &&
            proposalSourceIdentity(change) === candidateIdentity &&
            text(change.proposedValue) === text(candidate.proposedValue);
        if (isCandidate) {
            skippedCandidate = true;
            return false;
        }
        return true;
    });
    const simultaneouslyApproved = conflicts.some((change) => approvingIds.has(text(change.id)));
    const previouslyApproved = conflicts.some((change) => change.status === "APPROVED");
    if (!simultaneouslyApproved && !previouslyApproved) return [];
    return [
        "Competing source proposals for the same SCSEM control are mutually exclusive; approve only the strictest applicable control after reviewing CIS, STIG, and Publication 1075 evidence",
    ];
}

/** Round-robin authority classes before applying a hard proposal cap. */
export function fairlyLimitSCSEMProposals<T extends SCSEMProposalLike>(changes: T[], limit: number): T[] {
    if (limit <= 0) return [];
    if (changes.length <= limit) return changes;
    const buckets = new Map<string, T[]>();
    for (const change of changes) {
        const label = scsemProposalSourceLabel(change);
        buckets.set(label, [...(buckets.get(label) || []), change]);
    }
    const labels = [...buckets.keys()];
    const indexes = new Map(labels.map((label) => [label, 0]));
    const selected: T[] = [];
    while (selected.length < limit) {
        let added = false;
        for (const label of labels) {
            if (selected.length >= limit) break;
            const index = indexes.get(label) || 0;
            const candidate = buckets.get(label)?.[index];
            if (!candidate) continue;
            selected.push(candidate);
            indexes.set(label, index + 1);
            added = true;
        }
        if (!added) break;
    }
    return selected;
}
