"use client";

import { useState, useEffect } from "react";
import {
    AlertTriangle,
    Check,
    X,
    Loader2,
    ShieldAlert,
    Clock,
} from "lucide-react";

interface FalsePositiveReport {
    id: string;
    reason: string;
    status: string;
    reviewNotes: string | null;
    createdAt: string;
    incident: {
        id: string;
        title: string;
        type: string;
        severity: string;
        status: string;
    };
    reportedBy: {
        id: string;
        name: string;
        email: string;
    };
    reviewedBy: {
        id: string;
        name: string;
    } | null;
}

const STATUS_STYLES: Record<string, string> = {
    PENDING: "bg-amber-500/15 text-amber-400",
    APPROVED: "bg-emerald-500/15 text-emerald-400",
    REJECTED: "bg-red-500/15 text-red-400",
};

const SEVERITY_STYLES: Record<string, string> = {
    CRITICAL: "bg-red-500/15 text-red-400",
    HIGH: "bg-orange-500/15 text-orange-400",
    MEDIUM: "bg-yellow-500/15 text-yellow-400",
    LOW: "bg-sky-500/15 text-sky-400",
};

export default function FalsePositivesPage() {
    const [reports, setReports] = useState<FalsePositiveReport[]>([]);
    const [loading, setLoading] = useState(true);
    const [reviewingId, setReviewingId] = useState<string | null>(null);
    const [reviewNotes, setReviewNotes] = useState("");
    const [actionLoading, setActionLoading] = useState(false);

    useEffect(() => {
        fetchReports();
    }, []);

    async function fetchReports() {
        try {
            const res = await fetch("/api/false-positives");
            if (res.ok) {
                const data = await res.json();
                setReports(data.reports || []);
            }
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }

    async function handleReview(reportId: string, action: "APPROVED" | "REJECTED") {
        setActionLoading(true);
        try {
            const res = await fetch("/api/false-positives", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    reportId,
                    action,
                    reviewNotes: reviewNotes.trim() || undefined,
                }),
            });
            if (res.ok) {
                setReviewingId(null);
                setReviewNotes("");
                fetchReports();
            }
        } catch {
            // ignore
        } finally {
            setActionLoading(false);
        }
    }

    const pendingCount = reports.filter((r) => r.status === "PENDING").length;

    if (loading) {
        return (
            <div className="p-6 lg:p-8 max-w-5xl mx-auto">
                <div className="flex items-center gap-2 text-[var(--sky-text-muted)]">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Loading reports...
                </div>
            </div>
        );
    }

    return (
        <div className="p-6 lg:p-8 max-w-5xl mx-auto">
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-white">
                    False Positive Reports
                </h1>
                <p className="text-[var(--sky-text-secondary)] mt-1">
                    Review and manage false positive escalations from PII/FTI detection
                </p>
                {pendingCount > 0 && (
                    <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm text-amber-400">
                        <Clock className="w-4 h-4" />
                        {pendingCount} pending {pendingCount === 1 ? "report" : "reports"} awaiting review
                    </div>
                )}
            </div>

            {reports.length === 0 ? (
                <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl p-12 text-center">
                    <ShieldAlert className="w-10 h-10 text-[var(--sky-text-muted)] mx-auto mb-3" />
                    <p className="text-lg font-medium text-[var(--sky-text-secondary)]">
                        No false positive reports
                    </p>
                    <p className="text-sm text-[var(--sky-text-muted)] mt-1">
                        When users flag PII detections as false positives, they will appear here for review.
                    </p>
                </div>
            ) : (
                <div className="space-y-4">
                    {reports.map((report) => (
                        <div
                            key={report.id}
                            className="bg-[var(--sky-surface)] border border-[var(--sky-border)] rounded-xl overflow-hidden"
                        >
                            <div className="p-5">
                                {/* Header */}
                                <div className="flex items-start justify-between gap-4 mb-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                                            <h3 className="text-sm font-semibold text-white truncate">
                                                {report.incident.title}
                                            </h3>
                                        </div>
                                        <p className="text-xs text-[var(--sky-text-muted)]">
                                            Reported by <span className="text-[var(--sky-text-secondary)]">{report.reportedBy.name}</span> ({report.reportedBy.email})
                                            &middot; {new Date(report.createdAt).toLocaleDateString()}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <span
                                            className={`px-2.5 py-0.5 text-xs font-semibold rounded-full ${SEVERITY_STYLES[report.incident.severity] || ""
                                                }`}
                                        >
                                            {report.incident.severity}
                                        </span>
                                        <span
                                            className={`px-2.5 py-0.5 text-xs font-semibold rounded-full ${STATUS_STYLES[report.status] || ""
                                                }`}
                                        >
                                            {report.status}
                                        </span>
                                    </div>
                                </div>

                                {/* Reason */}
                                <div className="bg-[var(--sky-surface-overlay)] rounded-lg p-3 mb-3">
                                    <p className="text-xs font-medium text-[var(--sky-text-muted)] uppercase tracking-wider mb-1">
                                        Reason
                                    </p>
                                    <p className="text-sm text-[var(--sky-text-primary)]">
                                        {report.reason}
                                    </p>
                                </div>

                                {/* Review Notes (if reviewed) */}
                                {report.reviewNotes && (
                                    <div className="bg-[var(--sky-surface-overlay)] rounded-lg p-3 mb-3">
                                        <p className="text-xs font-medium text-[var(--sky-text-muted)] uppercase tracking-wider mb-1">
                                            Review Notes
                                        </p>
                                        <p className="text-sm text-[var(--sky-text-primary)]">
                                            {report.reviewNotes}
                                        </p>
                                        {report.reviewedBy && (
                                            <p className="text-xs text-[var(--sky-text-muted)] mt-1">
                                                Reviewed by {report.reviewedBy.name}
                                            </p>
                                        )}
                                    </div>
                                )}

                                {/* Actions for pending reports */}
                                {report.status === "PENDING" && (
                                    <div>
                                        {reviewingId === report.id ? (
                                            <div className="space-y-3">
                                                <textarea
                                                    value={reviewNotes}
                                                    onChange={(e) => setReviewNotes(e.target.value)}
                                                    placeholder="Add review notes (optional)..."
                                                    rows={2}
                                                    className="w-full px-3 py-2 bg-[var(--sky-surface-overlay)] border border-[var(--sky-border)] rounded-lg text-sm text-white placeholder-[var(--sky-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--sky-blue)]/50 resize-none"
                                                />
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => handleReview(report.id, "APPROVED")}
                                                        disabled={actionLoading}
                                                        className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 rounded-lg transition-colors disabled:opacity-50"
                                                    >
                                                        {actionLoading ? (
                                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                        ) : (
                                                            <Check className="w-3.5 h-3.5" />
                                                        )}
                                                        Approve (Close Incident)
                                                    </button>
                                                    <button
                                                        onClick={() => handleReview(report.id, "REJECTED")}
                                                        disabled={actionLoading}
                                                        className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-lg transition-colors disabled:opacity-50"
                                                    >
                                                        {actionLoading ? (
                                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                        ) : (
                                                            <X className="w-3.5 h-3.5" />
                                                        )}
                                                        Reject
                                                    </button>
                                                    <button
                                                        onClick={() => {
                                                            setReviewingId(null);
                                                            setReviewNotes("");
                                                        }}
                                                        className="text-xs text-[var(--sky-text-muted)] hover:text-white transition-colors ml-2"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            </div>
                                        ) : (
                                            <button
                                                onClick={() => setReviewingId(report.id)}
                                                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[var(--sky-royal)]/20 hover:bg-[var(--sky-royal)]/30 text-[var(--sky-light)] rounded-lg transition-colors"
                                            >
                                                <ShieldAlert className="w-3.5 h-3.5" />
                                                Review Report
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
