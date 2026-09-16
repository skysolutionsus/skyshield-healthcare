"use client";
import React, { useState } from "react";
import type { SCSEMUpdaterClientChange } from "@/lib/scsem-updater-client-session";
import type { SCSEMGeneratorReviewerEvidence } from "@/lib/scsem-updater-store";
import type { resolveGeneratorPolicyEvidence } from "@/lib/scsem-generator-evidence";

type Policy = ReturnType<typeof resolveGeneratorPolicyEvidence>;
export function GeneratorEvidenceEditor({ sessionId, change, onChange }: {
    sessionId: string;
    change: SCSEMUpdaterClientChange;
    onChange: (evidence: SCSEMGeneratorReviewerEvidence) => void;
}) {
    const [policy, setPolicy] = useState<Policy | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const evidence = change.reviewerEvidence || { expectedResultsSourceQuote: "", expectedResultsRationale: "", applicabilityRationale: "", policyEvidenceSha256: "" };
    const currentPolicy = policy?.nistId === change.newControl?.nistId ? policy : null;
    async function loadPolicy() {
        setLoading(true);
        setError(null);
        setPolicy(null);
        try {
            const query = new URLSearchParams({ changeId: change.id, nistId: change.newControl?.nistId || "" });
            const response = await fetch(`/api/scsem-updater/${sessionId}/generator-evidence?${query}`, { cache: "no-store" });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Could not load pinned mapping evidence.");
            setPolicy(data.policy);
        } catch (error) {
            setError(error instanceof Error ? error.message : "Could not load pinned mapping evidence.");
        } finally { setLoading(false); }
    }
    return <section className="mt-4 space-y-3 rounded-lg border border-amber-500/30 p-4 text-sm text-[var(--sky-text-primary)]">
        <h3 className="font-semibold">Generator evidence review — human decisions, not machine source evidence</h3>
        <p>Enter a secure pass criterion in Expected Results above. Defaults and audit instructions are not presumed secure outcomes. Quote immutable source text and explain how it supports the pass criterion. Review exact policy excerpts and explain technology/profile applicability. This remains an incomplete draft, not an all-source comparison.</p>
        <details><summary>Immutable recommendation source — {String(change.sourceEvidence?.sourceSheet || "missing; start a new session")} / row {String(change.sourceEvidence?.sourceRow || "missing")}</summary>
            {["sourceTitle", "sourceDescription", "sourceAudit", "sourceRemediation", "sourceBenchmarkVersion", "sourceSha256"].map((key) => <div key={key}><strong>{key}: </strong><span className="whitespace-pre-wrap break-words">{String(change.sourceEvidence?.[key] || "Not recorded")}</span></div>)}
        </details>
        {([
            ["expectedResultsSourceQuote", "Expected-results source quote"],
            ["expectedResultsRationale", "Pass-criterion rationale"],
            ["applicabilityRationale", "Technology/profile applicability rationale"],
        ] as const).map(([key, label]) => <label key={key} className="block">{label}
            <textarea className="mt-1 min-h-24 w-full rounded border border-[var(--sky-border)] bg-[var(--sky-navy)] p-2" maxLength={20000} value={evidence[key]} onChange={(event) => onChange({ ...evidence, [key]: event.target.value })} />
        </label>)}
        <button type="button" disabled={loading} onClick={() => void loadPolicy()} className="rounded border px-3 py-2">{loading ? "Loading…" : "Load pinned policy excerpts"}</button>
        {error && <p role="alert" className="text-red-300">{error}</p>}
        {currentPolicy && <div className="space-y-3">
            <p>{currentPolicy.nistId} — {currentPolicy.nistTitle}</p>
            <p>{currentPolicy.pub1075Citation} ({currentPolicy.pub1075Version}) — SHA-256 {currentPolicy.pub1075Sha256}</p>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{currentPolicy.pub1075Excerpt}</pre>
            <p>{currentPolicy.nistCitation} ({currentPolicy.nistVersion}) — SHA-256 {currentPolicy.nistSha256}; source commit {currentPolicy.nistSourceCommit}</p>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{currentPolicy.nistExcerpt}</pre>
            <label className="flex items-start gap-2"><input type="checkbox" checked={evidence.policyEvidenceSha256 === currentPolicy.sha256} onChange={(event) => onChange({ ...evidence, policyEvidenceSha256: event.target.checked ? currentPolicy.sha256 : "" })} />I reviewed these exact pinned excerpts and supplied an applicability rationale.</label>
        </div>}
        {!currentPolicy && <p>Load the selected NIST ID to inspect exact excerpts. Missing Pub 1075 coverage or a nonexistent ID blocks approval.</p>}
    </section>;
}
