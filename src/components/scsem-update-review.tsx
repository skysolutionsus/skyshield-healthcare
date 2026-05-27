"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, ChevronDown, ChevronUp, Loader2, ArrowRight, PlusCircle, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { Textarea } from "@/components/ui/textarea";

interface SuggestedChange {
    action?: "updateField" | "addControl";
    testId: string;
    field: string;
    currentValue: string;
    proposedValue: string;
    reason: string;
    confidence?: string;
    newControl?: {
        nistId?: string | null;
        nistControlName?: string | null;
        testMethod?: string | null;
        sectionTitle?: string | null;
        description?: string | null;
        testProcedures?: string | null;
        expectedResults?: string | null;
        criticality?: string | null;
        cisBenchmarkRef?: string | null;
        recommendationNum?: string | null;
        rationale?: string | null;
        impact?: string | null;
        remediationProcedure?: string | null;
    };
}

interface SCSEMUpdateReviewProps {
    templateId: string;
    templateName: string;
    review: {
        id: string;
        status: string;
        source?: string;
        suggestedChanges: SuggestedChange[];
        benchmark: {
            currentVersion: string;
            changesSummary: string;
        } | null;
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
    newControl: "New Control",
};

export function SCSEMUpdateReview({ templateId, templateName, review }: SCSEMUpdateReviewProps) {
    const router = useRouter();
    const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
    const [processing, setProcessing] = useState<"ACCEPT" | "REJECT" | null>(null);
    const [changes, setChanges] = useState<SuggestedChange[]>(review?.suggestedChanges || []);

    useEffect(() => {
        setChanges(review?.suggestedChanges || []);
        setExpandedIdx(null);
    }, [review?.id, review?.suggestedChanges]);

    const updateChange = (idx: number, patch: Partial<SuggestedChange>) => {
        setChanges((prev) => prev.map((change, i) => i === idx ? { ...change, ...patch } : change));
    };

    const updateNewControl = (idx: number, field: keyof NonNullable<SuggestedChange["newControl"]>, value: string) => {
        setChanges((prev) => prev.map((change, i) => {
            if (i !== idx) return change;
            return {
                ...change,
                newControl: {
                    ...(change.newControl || {}),
                    [field]: value,
                },
            };
        }));
    };

    const resetChanges = () => {
        setChanges(review?.suggestedChanges || []);
    };

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
                    suggestedChanges: action === "ACCEPT" ? changes : undefined,
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
        const sourceLabel = review.source === "pub1075" ? "Pub 1075" : `CIS ${review.benchmark?.currentVersion || ""}`;
        return (
            <div className="bg-emerald-900/20 border border-emerald-800/50 rounded-xl p-6">
                <div className="flex items-center gap-3 mb-2">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                    <h3 className="text-base font-semibold text-emerald-400">
                        {sourceLabel} — Applied
                    </h3>
                </div>
                <p className="text-sm text-emerald-300/70">
                    {review.suggestedChanges.length} proposed change(s) applied. Updated and newly added controls are highlighted in the controls table below.
                </p>
            </div>
        );
    }

    if (review.status === "REJECTED") {
        const sourceLabel = review.source === "pub1075" ? "Pub 1075" : `CIS ${review.benchmark?.currentVersion || ""}`;
        return (
            <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-6">
                <div className="flex items-center gap-3 mb-2">
                    <XCircle className="w-5 h-5 text-red-400" />
                    <h3 className="text-base font-semibold text-red-400">
                        {sourceLabel} — Rejected
                    </h3>
                </div>
                <p className="text-sm text-red-300/70">
                    This update was reviewed and rejected. No controls were modified.
                </p>
            </div>
        );
    }

    // PENDING state
    const isPub1075 = review.source === "pub1075";
    const headerLabel = isPub1075
        ? "Pub 1075 Compliance Review"
        : `CIS ${review.benchmark?.currentVersion || ""} Update Available`;
    const headerColor = isPub1075
        ? "bg-indigo-900/20 border-indigo-800/50"
        : "bg-amber-900/20 border-amber-800/50";
    const headerTextColor = isPub1075 ? "text-indigo-400" : "text-amber-400";
    const subtitleColor = isPub1075 ? "text-indigo-300/70" : "text-amber-300/70";

    return (
        <div>
            <div className={`${headerColor} border rounded-xl p-6 mb-6`}>
                <div className="flex items-center gap-2 mb-2">
                    {isPub1075 && (
                        <span className="px-2 py-0.5 bg-indigo-500/20 text-indigo-400 rounded text-[10px] font-bold uppercase border border-indigo-500/30">
                            Pub 1075
                        </span>
                    )}
                    <h2 className={`text-lg font-semibold ${headerTextColor}`}>
                        {headerLabel}
                    </h2>
                </div>
                <p className={`text-sm ${subtitleColor} mb-4`}>
                    {review.benchmark?.changesSummary || "Review the proposed changes below for Pub 1075 compliance."}
                </p>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => handleReviewAction("ACCEPT")}
                        disabled={processing !== null}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                        {processing === "ACCEPT" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                        Accept Edited Changes
                    </button>
                    <button
                        onClick={resetChanges}
                        disabled={processing !== null}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] hover:bg-white/10 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                        <RotateCcw className="w-4 h-4" />
                        Reset Edits
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
                    Proposed Control Updates ({changes.length})
                </h3>
                {changes.map((change, idx) => {
                    const isExpanded = expandedIdx === idx;
                    const isNewControl = change.action === "addControl" || change.field === "newControl";
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
                                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${isNewControl
                                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                            : "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                            }`}>
                                            {isNewControl && <PlusCircle className="w-3 h-3" />}
                                            {isNewControl ? "New Control" : FIELD_LABELS[change.field] || change.field}
                                        </span>
                                        {change.confidence && (
                                            <span className="px-2 py-0.5 bg-[var(--sky-surface-overlay)] text-[var(--sky-text-secondary)] rounded text-xs font-medium border border-[var(--sky-border)]">
                                                {change.confidence.replace("_", " ")}
                                            </span>
                                        )}
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
                                                Current ({isNewControl ? "SCSEM" : FIELD_LABELS[change.field] || change.field})
                                            </span>
                                            <p className="text-sm text-gray-300 whitespace-pre-wrap">{change.currentValue}</p>
                                        </div>
                                        <div className="bg-emerald-900/10 border border-emerald-900/30 rounded-lg p-3">
                                            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1 block">
                                                Proposed
                                            </span>
                                            {isNewControl ? (
                                                <NewControlEditor
                                                    change={change}
                                                    onSummaryChange={(value) => updateChange(idx, { proposedValue: value })}
                                                    onReasonChange={(value) => updateChange(idx, { reason: value })}
                                                    onFieldChange={(field, value) => updateNewControl(idx, field, value)}
                                                />
                                            ) : (
                                                <div className="space-y-3">
                                                    <Textarea
                                                        value={change.proposedValue}
                                                        onChange={(event) => updateChange(idx, { proposedValue: event.target.value })}
                                                        className="min-h-[180px]"
                                                    />
                                                    <div>
                                                        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--sky-text-secondary)] mb-1 block">
                                                            Reason
                                                        </span>
                                                        <Textarea
                                                            value={change.reason}
                                                            onChange={(event) => updateChange(idx, { reason: event.target.value })}
                                                            className="min-h-[90px]"
                                                        />
                                                    </div>
                                                </div>
                                            )}
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

function NewControlEditor({
    change,
    onSummaryChange,
    onReasonChange,
    onFieldChange,
}: {
    change: SuggestedChange;
    onSummaryChange: (value: string) => void;
    onReasonChange: (value: string) => void;
    onFieldChange: (field: keyof NonNullable<SuggestedChange["newControl"]>, value: string) => void;
}) {
    const control = change.newControl || {};
    const shortFields: Array<[keyof NonNullable<SuggestedChange["newControl"]>, string]> = [
        ["sectionTitle", "Section Title"],
        ["nistId", "NIST ID"],
        ["nistControlName", "NIST Control Name"],
        ["testMethod", "Test Method"],
        ["criticality", "Criticality"],
        ["cisBenchmarkRef", "CIS Benchmark Section"],
        ["recommendationNum", "Recommendation #"],
    ];
    const longFields: Array<[keyof NonNullable<SuggestedChange["newControl"]>, string]> = [
        ["description", "Description"],
        ["testProcedures", "Test Procedures"],
        ["expectedResults", "Expected Results"],
        ["rationale", "Rationale"],
        ["impact", "Impact"],
        ["remediationProcedure", "Remediation Procedure"],
    ];

    return (
        <div className="space-y-3">
            <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--sky-text-secondary)] mb-1 block">
                    Summary
                </span>
                <Textarea
                    value={change.proposedValue}
                    onChange={(event) => onSummaryChange(event.target.value)}
                    className="min-h-[80px]"
                />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {shortFields.map(([field, label]) => (
                    <label key={field} className="block">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--sky-text-secondary)] mb-1 block">
                            {label}
                        </span>
                        <input
                            value={(control[field] as string | null | undefined) || ""}
                            onChange={(event) => onFieldChange(field, event.target.value)}
                            className="w-full rounded-md border border-[var(--sky-border)] bg-[var(--sky-navy)] px-3 py-2 text-sm text-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                        />
                    </label>
                ))}
            </div>

            {longFields.map(([field, label]) => (
                <div key={field}>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--sky-text-secondary)] mb-1 block">
                        {label}
                    </span>
                    <Textarea
                        value={(control[field] as string | null | undefined) || ""}
                        onChange={(event) => onFieldChange(field, event.target.value)}
                        className="min-h-[110px]"
                    />
                </div>
            ))}

            <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--sky-text-secondary)] mb-1 block">
                    Reason
                </span>
                <Textarea
                    value={change.reason}
                    onChange={(event) => onReasonChange(event.target.value)}
                    className="min-h-[90px]"
                />
            </div>
        </div>
    );
}
