"use client";

import { useState } from "react";
import { CheckCircle2, XCircle, FileText, ChevronDown, ChevronUp, Loader2, Play } from "lucide-react";
import { useRouter } from "next/navigation";

interface SuggestedChange {
    controlId: string;
    change: string;
    current: string;
    proposed: string;
    nistId?: string;
    testId?: string;
    criticality?: string;
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

export function SCSEMUpdateReview({ templateId, templateName, review }: SCSEMUpdateReviewProps) {
    const router = useRouter();
    const [expandedControl, setExpandedControl] = useState<string | null>(null);
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

            if (!res.ok) {
                throw new Error("Failed to process review");
            }

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
                <h3 className="text-lg font-medium text-white mb-2">
                    Template Up to Date
                </h3>
                <p className="text-[var(--sky-text-secondary)] max-w-md mx-auto mb-6">
                    This SCSEM template is currently up to date with the latest CIS Benchmark requirements.
                </p>
            </div>
        );
    }

    return (
        <div>
            <div className="bg-amber-100 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-6 mb-6">
                <h2 className="text-lg font-semibold text-amber-800 dark:text-amber-400 mb-2">
                    CIS {review.benchmark.currentVersion} Update Available
                </h2>
                <p className="text-sm text-amber-700 dark:text-amber-500 mb-4">
                    {review.benchmark.changesSummary}
                </p>
                <div className="flex items-center gap-3 mt-4">
                    <button
                        onClick={() => handleReviewAction("ACCEPT")}
                        disabled={processing !== null}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                        {processing === "ACCEPT" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                        Accept Changes
                    </button>
                    <button
                        onClick={() => handleReviewAction("REJECT")}
                        disabled={processing !== null}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] hover:bg-red-900/30 hover:text-red-400 hover:border-red-800 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                        {processing === "REJECT" ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                        Reject
                    </button>
                </div>
            </div>

            <div className="space-y-3">
                <h3 className="text-sm font-medium text-white mb-2">Suggested Control Updates ({review.suggestedChanges.length})</h3>
                {review.suggestedChanges.map((change, idx) => {
                    const isExpanded = expandedControl === change.controlId;
                    return (
                        <div
                            key={change.controlId || idx}
                            className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl overflow-hidden"
                        >
                            <div
                                className="flex items-center gap-3 p-4 cursor-pointer hover:bg-white/[0.03] transition-colors"
                                onClick={() => setExpandedControl(isExpanded ? null : change.controlId)}
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-mono font-medium text-[var(--sky-text-secondary)]">
                                            {change.controlId}
                                        </span>
                                        <span className="text-sm font-medium text-white truncate">
                                            {change.change}
                                        </span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    {isExpanded ? (
                                        <ChevronUp className="w-4 h-4 text-[var(--sky-text-muted)]" />
                                    ) : (
                                        <ChevronDown className="w-4 h-4 text-[var(--sky-text-muted)]" />
                                    )}
                                </div>
                            </div>

                            {isExpanded && (
                                <div className="px-4 pb-4 border-t border-[var(--sky-border)] pt-4">
                                    <div className="flex flex-wrap gap-2 mb-4">
                                        <span className="px-2.5 py-1 bg-sky-500/10 text-sky-400 rounded-md text-xs font-mono font-medium border border-sky-500/20">
                                            NIST ID: {change.nistId || "N/A"}
                                        </span>
                                        <span className="px-2.5 py-1 bg-purple-500/10 text-purple-400 rounded-md text-xs font-mono font-medium border border-purple-500/20">
                                            Test ID: {change.testId || "New"}
                                        </span>
                                        <span className={`px-2.5 py-1 rounded-md text-xs font-bold border uppercase tracking-wider ${change.criticality === "CRITICAL"
                                                ? "bg-red-500/10 text-red-500 border-red-500/20"
                                                : change.criticality === "HIGH"
                                                    ? "bg-orange-500/10 text-orange-400 border-orange-500/20"
                                                    : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                            }`}>
                                            {change.criticality || "MEDIUM"}
                                        </span>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div className="bg-red-900/10 border border-red-900/30 rounded-lg p-3">
                                            <span className="text-[10px] font-bold uppercase tracking-wider text-red-400 mb-1 block">Current</span>
                                            <p className="text-sm text-gray-300">{change.current}</p>
                                        </div>
                                        <div className="bg-emerald-900/10 border border-emerald-900/30 rounded-lg p-3">
                                            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1 block">Proposed</span>
                                            <p className="text-sm text-gray-300">{change.proposed}</p>
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
