import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { extractComplianceEvidence } from "@/lib/compliance-evidence";
import type { SCSEMUpdaterChange } from "@/lib/scsem-updater-store";

/** Generator-only: exact IDs, verified repository pins; no network retrieval. */
export function resolveGeneratorPolicyEvidence(nistId: string) {
    if (!/^[A-Z]{2,3}-\d+(?:\(\d+\))?$/.test(nistId)) {
        throw new Error("Enter an exact normalized NIST ID (for example CM-6).");
    }
    const evidence = extractComplianceEvidence([nistId]); // verifies catalog and Pub 1075 integrity
    const catalog = JSON.parse(fs.readFileSync(evidence.nist.sourcePath, "utf8")) as {
        controls: Array<{ id: string; title: string; statement: string; guidance: string }>;
    };
    const control = catalog.controls.find((item) => item.id === nistId);
    if (!control) throw new Error(`NIST ID ${nistId} does not exist in the pinned catalog.`);
    if (!evidence.pub1075.excerptedControlIds.includes(nistId) || !evidence.pub1075.excerpts.trim()) {
        throw new Error(`No pinned Publication 1075 evidence for ${nistId}; mapping remains blocked.`);
    }
    // Coverage is computed before excerpt clipping. It cannot establish that
    // the reviewer received the exact requirement (e.g. AC-2 CE-13).
    // Fail closed rather than fingerprinting incomplete policy evidence.
    if (evidence.pub1075.excerpts.includes("[Excerpt truncated]")) {
        throw new Error(`Publication 1075 evidence for ${nistId} is truncated; exact requirement review remains unresolved and mapping is blocked.`);
    }
    const policy = {
        nistId, nistTitle: control.title,
        pub1075Version: evidence.pub1075.version,
        pub1075Sha256: evidence.pub1075.sourceSha256,
        pub1075Citation: `${evidence.pub1075.sourcePath} — ${nistId}`,
        pub1075Excerpt: evidence.pub1075.excerpts,
        nistVersion: evidence.nist.version,
        nistSha256: evidence.nist.snapshotSha256,
        nistSourceCommit: evidence.nist.sourceCommit,
        nistCitation: `${evidence.nist.publicationUrl} — ${nistId}`,
        nistExcerpt: `${control.id} ${control.title}\n${control.statement}\n${control.guidance}`,
    };
    return { ...policy, sha256: createHash("sha256").update(JSON.stringify(policy)).digest("hex") };
}

export function generatorApprovalErrors(change: SCSEMUpdaterChange): string[] {
    const errors: string[] = [];
    const source = change.sourceEvidence;
    if (change.action !== "addControl" || source?.bootstrapDraft !== true ||
        typeof source.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sourceSha256) ||
        !Number.isInteger(source.sourceRow) || !source.sourceSheet || !source.sourceBenchmarkVersion) {
        errors.push("Immutable generator source provenance is missing; start a new bootstrap session (legacy sessions cannot be approved).");
    }
    if (!change.newControl?.criticality?.trim()) errors.push("Choose newControl.criticality explicitly; generator risk mapping is never automatic.");
    const reviewer = change.reviewerEvidence;
    for (const field of ["expectedResultsSourceQuote", "expectedResultsRationale", "applicabilityRationale", "policyEvidenceSha256"] as const) {
        const value = reviewer?.[field];
        if (typeof value !== "string" || !value.trim() || value.length > 20_000) {
            errors.push(`reviewerEvidence.${field} is required and must be at most 20000 characters.`);
        }
    }
    const quote = typeof reviewer?.expectedResultsSourceQuote === "string" ? reviewer.expectedResultsSourceQuote.trim() : "";
    if (!quote || !["sourceAudit", "sourceRemediation", "sourceTitle", "sourceDescription"].some((key) =>
        typeof source?.[key] === "string" && (source[key] as string).includes(quote))) {
        errors.push("Expected-results source quote must match immutable recommendation audit, remediation, title or description exactly.");
    }
    if (!change.newControl?.expectedResults?.trim()) errors.push("Enter a supported secure pass criterion in Expected Results.");
    try {
        const policy = resolveGeneratorPolicyEvidence(change.newControl?.nistId || "");
        if (reviewer?.policyEvidenceSha256 !== policy.sha256) {
            errors.push("Load and review the current pinned policy excerpts for this NIST ID before approval.");
        }
    } catch (error) {
        errors.push(error instanceof Error ? error.message : "Pinned policy evidence is unavailable.");
    }
    return errors;
}
