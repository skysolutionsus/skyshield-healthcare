"use client";

import { useState } from "react";
import { CheckCircle2, XCircle, ChevronDown, ChevronUp, Loader2, ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";

interface SuggestedChange {
    testId: string;
    field: string;
    currentValue: string;
    proposedValue: string;
    reason: string;
}

interface SCSEMUpdateReviewProps {
    templateId: string;
    templateName: string;
    review: {
        id: string;
        status: string;
        suggestedChanges: SuggestedChange[];
        benchmark: {
            currentVersion: string;
            changesSummary: string;
        };
    } | null;
}

const FIELD_LABELS: Record<string, string> = {
    testProcedures: "Test Procedures",
    expectedResults: "Expected Results",
    remediationProcedure: "Remediation Procedure",
    description: "Description",
    rationale: "Rationale",
    impact: "Impact",
    sectionTitle: "Section Title",
    findingStatement: "Finding Statement",
};

export function SCSEMUpdateReview({ templateId, templateName, review }: SCSEMUpdateReviewProps) {
    const router = useRouter();
    const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
    const [processing, setProcessing] = useState<"ACCEPT" | "REJECT" | null>(null);

    const handleReviewAction = async (action: "ACCEPT" | "REJECT") => {
        if (!review) return;
        setProcessing(action);

        try {
            const res = await fetch(`/api/scsems/${templateId}/review`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    reviewId: review.id,
                    status: action === "ACCEPT" ? "ACCEPTED" : "REJECTED",
                }),
            });

            if (!res.ok) throw new Error("Failed to process review");
            router.refresh();
        } catch (err) {
            console.error(err);
        } finally {
            setProcessing(null);
        }
    };

    if (!review) {
        return (
            <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-8 text-center">
                <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-white mb-2">Template Up to Date</h3>
                <p className="text-[var(--sky-text-secondary)] max-w-md mx-auto">
                    This SCSEM template is currently up to date with the latest CIS Benchmark requirements.
                </p>
            </div>
        );
    }

    if (review.status === "ACCEPTED") {
        return (
            <div className="bg-emerald-900/20 border border-emerald-800/50 rounded-xl p-6">
                <div className="flex items-center gap-3 mb-2">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                    <h3 className="text-base font-semibold text-emerald-400">
                        CIS {review.benchmark.currentVersion} — Applied
                    </h3>
                </div>
                <p className="text-sm text-emerald-300/70">
                    {review.suggestedChanges.length} control(s) updated. Updated controls are highlighted in the controls table below.
                </p>
            </div>
        );
    }

    if (review.status === "REJECTED") {
        return (
            <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-6">
                <div className="flex items-center gap-3 mb-2">
                    <XCircle className="w-5 h-5 text-red-400" />
                    <h3 className="text-base font-semibold text-red-400">
                        CIS {review.benchmark.currentVersion} — Rejected
                    </h3>
                </div>
                <p className="text-sm text-red-300/70">
                    This update was reviewed and rejected. No controls were modified.
                </p>
            </div>
        );
    }

    // PENDING state
    return (
        <div>
            <div className="bg-amber-900/20 border border-amber-800/50 rounded-xl p-6 mb-6">
                <h2 className="text-lg font-semibold text-amber-400 mb-2">
                    CIS {review.benchmark.currentVersion} Update Available
                </h2>
                <p className="text-sm text-amber-300/70 mb-4">
                    {review.benchmark.changesSummary}
                </p>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => handleReviewAction("ACCEPT")}
                        disabled={processing !== null}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                        {processing === "ACCEPT" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                        Accept & Apply Changes
                    </button>
                    <button
                        onClick={() => handleReviewAction("REJECT")}
                        disabled={processing !== null}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] hover:bg-red-900/30 hover:text-red-400 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                        {processing === "REJECT" ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                        Reject
                    </button>
                </div>
            </div>

            <div className="space-y-3">
                <h3 className="text-sm font-medium text-white mb-2">
                    Proposed Control Updates ({review.suggestedChanges.length})
                </h3>
                {review.suggestedChanges.map((change, idx) => {
                    const isExpanded = expandedIdx === idx;
                    return (
                        <div
                            key={idx}
                            className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl overflow-hidden"
                        >
                            <div
                                className="flex items-center gap-3 p-4 cursor-pointer hover:bg-white/[0.03] transition-colors"
                                onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded text-xs font-mono font-medium border border-blue-500/20">
                                            {change.testId}
                                        </span>
                                        <ArrowRight className="w-3 h-3 text-[var(--sky-text-muted)]" />
                                        <span className="px-2 py-0.5 bg-purple-500/10 text-purple-400 rounded text-xs font-medium border border-purple-500/20">
                                            {FIELD_LABELS[change.field] || change.field}
                                        </span>
                                    </div>
                                    <p className="text-xs text-[var(--sky-text-secondary)] mt-1 truncate">
                                        {change.reason}
                                    </p>
                                </div>
                                {isExpanded ? (
                                    <ChevronUp className="w-4 h-4 text-[var(--sky-text-muted)] shrink-0" />
                                ) : (
                                    <ChevronDown className="w-4 h-4 text-[var(--sky-text-muted)] shrink-0" />
                                )}
                            </div>

                            {isExpanded && (
                                <div className="px-4 pb-4 border-t border-[var(--sky-border)] pt-4">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div className="bg-red-900/10 border border-red-900/30 rounded-lg p-3">
                                            <span className="text-[10px] font-bold uppercase tracking-wider text-red-400 mb-1 block">
                                                Current ({FIELD_LABELS[change.field] || change.field})
                                            </span>
                                            <p className="text-sm text-gray-300 whitespace-pre-wrap">{change.currentValue}</p>
                                        </div>
                                        <div className="bg-emerald-900/10 border border-emerald-900/30 rounded-lg p-3">
                                            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1 block">
                                                Proposed
                                            </span>
                                            <p className="text-sm text-gray-300 whitespace-pre-wrap">{change.proposedValue}</p>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
