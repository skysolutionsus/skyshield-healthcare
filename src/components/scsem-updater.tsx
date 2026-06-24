"use client";

import { useMemo, useRef, useState } from "react";
import {
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Download,
    FileSpreadsheet,
    Loader2,
    PlusCircle,
    RotateCcw,
    Save,
    SearchCheck,
    ShieldCheck,
    Upload,
    XCircle,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

type ChangeStatus = "PENDING" | "APPROVED" | "REJECTED";

interface UpdaterChange {
    id: string;
    status: ChangeStatus;
    action: "updateField" | "addControl";
    testId: string;
    field: string;
    currentValue: string;
    proposedValue: string;
    reason: string;
    confidence?: string;
    sourceEvidence?: Record<string, unknown> | null;
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

interface AuditSource {
    sourceKind?: "CIS" | "STIG";
    sourceRelationship?: "direct" | "adjacent";
    workbenchId: number;
    benchmarkTitle: string;
    benchmarkVersion: string;
    releaseDate: string;
    excelTitle: string;
    excelFileName: string;
    filePath: string;
    sha256: string;
    selectedProfile?: string | null;
    sharedRecommendationCount?: number;
    selectedProfileRecommendationCount?: number;
    matchedSheets?: string[];
    matchQuery?: string;
    adjacentCategory?: string;
    adjacentRationale?: string;
}

interface UpdaterSession {
    id: string;
    originalFileName: string;
    uploadedAt: string;
    inferredTechnology: string;
    status: "uploaded" | "analyzing" | "review_ready" | "error";
    summary?: string;
    error?: string;
    scsem: {
        subject: string | null;
        version: string | null;
        effectiveDate: string | null;
        totalControls: number;
        testCaseSheets: string[];
    };
    changes: UpdaterChange[];
    history: Array<{
        action: string;
        changeId?: string;
        previousStatus?: ChangeStatus;
        nextStatus?: ChangeStatus;
    }>;
    audit: {
        uploadedSha256: string;
        uploadedSizeBytes: number;
        pub1075Version?: string;
        cis?: AuditSource | null;
        stig?: AuditSource | null;
        cisSources?: AuditSource[];
        stigSources?: AuditSource[];
        adjacentSources?: AuditSource[];
    };
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

const STATUS_STYLES: Record<ChangeStatus, string> = {
    PENDING: "bg-amber-500/10 text-amber-300 border-amber-500/25",
    APPROVED: "bg-emerald-500/10 text-emerald-300 border-emerald-500/25",
    REJECTED: "bg-red-500/10 text-red-300 border-red-500/25",
};

async function readApiJson<T>(res: Response, fallbackMessage: string): Promise<T> {
    const text = await res.text();
    if (!text) return {} as T;

    try {
        return JSON.parse(text) as T;
    } catch {
        const isHtml = text.trimStart().startsWith("<");
        const compactText = text
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 180);
        const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;

        throw new Error(isHtml
            ? `${fallbackMessage}: the server returned an HTML error page instead of JSON (${status}). The analysis may have timed out or hit the app error page; retry after the latest deploy finishes.`
            : `${fallbackMessage}: the server returned an unreadable response (${status})${compactText ? `: ${compactText}` : "."}`);
    }
}

export function SCSEMUpdater() {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [session, setSession] = useState<UpdaterSession | null>(null);
    const [expandedChangeId, setExpandedChangeId] = useState<string | null>(null);
    const [dragActive, setDragActive] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const counts = useMemo(() => {
        const base = { pending: 0, approved: 0, rejected: 0 };
        for (const change of session?.changes || []) {
            if (change.status === "APPROVED") base.approved++;
            else if (change.status === "REJECTED") base.rejected++;
            else base.pending++;
        }
        return base;
    }, [session?.changes]);

    const canUndo = useMemo(() => {
        const history = session?.history || [];
        const lastUndoIndex = history.map((entry) => entry.action).lastIndexOf("undo");
        return history.slice(lastUndoIndex + 1).some((entry) => entry.action === "status");
    }, [session?.history]);

    const cisAuditSources = useMemo(() => {
        if (!session) return [];
        return session.audit.cisSources?.length
            ? session.audit.cisSources
            : session.audit.cis
                ? [session.audit.cis]
                : [];
    }, [session]);

    const stigAuditSources = useMemo(() => {
        if (!session) return [];
        return session.audit.stigSources?.length
            ? session.audit.stigSources
            : session.audit.stig
                ? [session.audit.stig]
                : [];
    }, [session]);

    const adjacentAuditSources = useMemo(() => {
        return session?.audit.adjacentSources || [];
    }, [session]);

    async function uploadFile(file: File) {
        setBusy("upload");
        setError(null);
        try {
            const formData = new FormData();
            formData.append("file", file);
            const res = await fetch("/api/scsem-updater/upload", {
                method: "POST",
                body: formData,
            });
            const data = await readApiJson<{ error?: string; session: UpdaterSession }>(res, "Upload failed");
            if (!res.ok) throw new Error(data.error || "Upload failed.");
            setSession(data.session);
            setExpandedChangeId(null);
        } catch (err: any) {
            setError(err.message || "Upload failed.");
        } finally {
            setBusy(null);
        }
    }

    async function runAnalysis() {
        if (!session) return;
        setBusy("analyze");
        setError(null);
        setSession({ ...session, status: "analyzing" });
        try {
            const res = await fetch(`/api/scsem-updater/${session.id}/analyze`, {
                method: "POST",
            });
            const data = await readApiJson<{ error?: string; session: UpdaterSession }>(res, "Analysis failed");
            if (!res.ok) throw new Error(data.error || "Analysis failed.");
            setSession(data.session);
            setExpandedChangeId(data.session?.changes?.[0]?.id || null);
        } catch (err: any) {
            setError(err.message || "Analysis failed.");
            setSession((current) => current ? { ...current, status: "error", error: err.message } : current);
        } finally {
            setBusy(null);
        }
    }

    async function updateChange(changeId: string, status?: ChangeStatus, change?: UpdaterChange) {
        if (!session) return;
        setBusy(`${status || "save"}:${changeId}`);
        setError(null);
        try {
            const res = await fetch(`/api/scsem-updater/${session.id}/changes`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ changeId, status, change }),
            });
            const data = await readApiJson<{ error?: string; session: UpdaterSession }>(res, "Could not update change");
            if (!res.ok) throw new Error(data.error || "Could not update change.");
            setSession(data.session);
        } catch (err: any) {
            setError(err.message || "Could not update change.");
        } finally {
            setBusy(null);
        }
    }

    async function batchStatus(status: ChangeStatus) {
        if (!session) return;
        const pendingIds = session.changes
            .filter((change) => change.status === "PENDING")
            .map((change) => change.id);
        if (pendingIds.length === 0) return;

        setBusy(`batch:${status}`);
        setError(null);
        try {
            const res = await fetch(`/api/scsem-updater/${session.id}/changes`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ changeIds: pendingIds, status }),
            });
            const data = await readApiJson<{ error?: string; session: UpdaterSession }>(res, "Could not update changes");
            if (!res.ok) throw new Error(data.error || "Could not update changes.");
            setSession(data.session);
        } catch (err: any) {
            setError(err.message || "Could not update changes.");
        } finally {
            setBusy(null);
        }
    }

    async function undoLastAction() {
        if (!session) return;
        setBusy("undo");
        setError(null);
        try {
            const res = await fetch(`/api/scsem-updater/${session.id}/undo`, {
                method: "POST",
            });
            const data = await readApiJson<{ error?: string; session: UpdaterSession }>(res, "Could not undo review action");
            if (!res.ok) throw new Error(data.error || "Could not undo review action.");
            setSession(data.session);
        } catch (err: any) {
            setError(err.message || "Could not undo review action.");
        } finally {
            setBusy(null);
        }
    }

    function updateLocalChange(changeId: string, patch: Partial<UpdaterChange>) {
        setSession((current) => {
            if (!current) return current;
            return {
                ...current,
                changes: current.changes.map((change) =>
                    change.id === changeId ? { ...change, ...patch } : change
                ),
            };
        });
    }

    function updateLocalNewControl(
        changeId: string,
        field: keyof NonNullable<UpdaterChange["newControl"]>,
        value: string
    ) {
        setSession((current) => {
            if (!current) return current;
            return {
                ...current,
                changes: current.changes.map((change) =>
                    change.id === changeId
                        ? {
                            ...change,
                            newControl: {
                                ...(change.newControl || {}),
                                [field]: value,
                            },
                        }
                        : change
                ),
            };
        });
    }

    function handleDrop(event: React.DragEvent<HTMLDivElement>) {
        event.preventDefault();
        setDragActive(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void uploadFile(file);
    }

    return (
        <div className="p-6 lg:p-8 max-w-7xl mx-auto">
            <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-white">SCSEM Updater</h1>
                    <p className="mt-1 text-sm text-[var(--sky-text-secondary)]">
                        Upload an IRS Safeguards SCSEM workbook, review benchmark-driven changes, and export the approved XLSX.
                    </p>
                </div>
                {session && (
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            onClick={undoLastAction}
                            disabled={!canUndo || busy === "undo"}
                            className="inline-flex items-center gap-2 rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-3 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50"
                        >
                            {busy === "undo" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                            Undo
                        </button>
                        <a
                            href={`/api/scsem-updater/${session.id}/export`}
                            className="inline-flex items-center gap-2 rounded-lg bg-[var(--sky-royal)] px-3 py-2 text-sm font-medium text-white transition hover:bg-[var(--sky-blue)]"
                        >
                            <Download className="h-4 w-4" />
                            Export Updated XLSX
                        </a>
                    </div>
                )}
            </div>

            {error && (
                <div className="mb-4 flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                    <span>{error}</span>
                </div>
            )}

            <section className="mb-6 rounded-xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-5">
                <div
                    onDragOver={(event) => {
                        event.preventDefault();
                        setDragActive(true);
                    }}
                    onDragLeave={() => setDragActive(false)}
                    onDrop={handleDrop}
                    className={`flex min-h-[176px] flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-6 text-center transition ${dragActive
                        ? "border-[var(--sky-blue)] bg-blue-500/10"
                        : "border-[var(--sky-border)] bg-[var(--sky-surface-overlay)]"
                        }`}
                >
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--sky-navy)] border border-[var(--sky-border)]">
                        <FileSpreadsheet className="h-6 w-6 text-emerald-300" />
                    </div>
                    <div>
                        <p className="text-sm font-semibold text-white">
                            {session ? session.originalFileName : "Drop IRS SCSEM workbook"}
                        </p>
                        <p className="mt-1 text-xs text-[var(--sky-text-muted)]">
                            {session
                                ? `${session.inferredTechnology} - ${session.scsem.totalControls} controls`
                                : "Safeguards-SCSEM XLSX"}
                        </p>
                    </div>
                    <input
                        ref={inputRef}
                        type="file"
                        accept=".xlsx,.xlsm"
                        className="hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void uploadFile(file);
                            event.currentTarget.value = "";
                        }}
                    />
                    <button
                        onClick={() => inputRef.current?.click()}
                        disabled={busy === "upload"}
                        className="inline-flex items-center gap-2 rounded-lg bg-[var(--sky-royal)] px-4 py-2 text-sm font-medium text-white transition hover:bg-[var(--sky-blue)] disabled:opacity-50"
                    >
                        {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                        Choose Workbook
                    </button>
                </div>
            </section>

            {session && (
                <section className="mb-6 rounded-xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4 lg:flex-1">
                            <Stat label="Technology" value={session.inferredTechnology} />
                            <Stat label="SCSEM Version" value={session.scsem.version || "Unknown"} />
                            <Stat label="Effective Date" value={session.scsem.effectiveDate || "Unknown"} />
                            <Stat label="Controls" value={String(session.scsem.totalControls)} />
                        </div>
                        <button
                            onClick={runAnalysis}
                            disabled={busy === "analyze" || session.status === "analyzing"}
                            className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
                        >
                            {busy === "analyze" || session.status === "analyzing"
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <SearchCheck className="h-4 w-4" />}
                            Run Update Analysis
                        </button>
                    </div>
                </section>
            )}

            {session && (cisAuditSources.length > 0 || stigAuditSources.length > 0 || adjacentAuditSources.length > 0 || session.audit.pub1075Version) && (
                <section className="mb-6 rounded-xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-5">
                    <div className="mb-4 flex items-center gap-2">
                        <ShieldCheck className="h-5 w-5 text-[var(--sky-light)]" />
                        <h2 className="text-base font-semibold text-white">Evidence Sources</h2>
                    </div>
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                        {cisAuditSources.length > 0
                            ? cisAuditSources.map((source, index) => (
                                <AuditSourceCard
                                    key={`cis-${source.workbenchId}-${index}`}
                                    title={cisAuditSources.length > 1 ? `CIS Benchmark ${index + 1}` : "CIS Benchmark"}
                                    source={source}
                                />
                            ))
                            : <AuditSourceCard title="CIS Benchmark" source={null} />}
                        {stigAuditSources.length > 0
                            ? stigAuditSources.map((source, index) => (
                                <AuditSourceCard
                                    key={`stig-${source.workbenchId}-${index}`}
                                    title={stigAuditSources.length > 1 ? `STIG Benchmark ${index + 1}` : "STIG Benchmark"}
                                    source={source}
                                />
                            ))
                            : <AuditSourceCard title="STIG Benchmark" source={null} />}
                        {adjacentAuditSources.map((source, index) => (
                            <AuditSourceCard
                                key={`adjacent-${source.workbenchId}-${index}`}
                                title={adjacentAuditSources.length > 1 ? `Adjacent Source ${index + 1}` : "Adjacent Source"}
                                source={source}
                            />
                        ))}
                        <article className="rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] p-4">
                            <p className="text-xs font-semibold uppercase text-[var(--sky-text-muted)]">Publication 1075</p>
                            <p className="mt-2 text-sm font-medium text-white">{session.audit.pub1075Version || "Unknown"}</p>
                            <p className="mt-1 text-xs text-[var(--sky-text-secondary)]">Compliance floor for final recommendation text</p>
                        </article>
                    </div>
                </section>
            )}

            {session && session.status === "review_ready" && (
                <section className="rounded-xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-5">
                    <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="text-base font-semibold text-white">Proposed Updates</h2>
                                <span className="rounded-full border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-2 py-0.5 text-xs text-[var(--sky-text-secondary)]">
                                    {session.changes.length} total
                                </span>
                            </div>
                            {session.summary && (
                                <p className="mt-2 max-w-4xl text-sm leading-6 text-[var(--sky-text-secondary)]">
                                    {session.summary}
                                </p>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <StatusPill status="PENDING" count={counts.pending} />
                            <StatusPill status="APPROVED" count={counts.approved} />
                            <StatusPill status="REJECTED" count={counts.rejected} />
                            <button
                                onClick={() => batchStatus("APPROVED")}
                                disabled={counts.pending === 0 || busy === "batch:APPROVED"}
                                className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-200 transition hover:bg-emerald-500/20 disabled:opacity-50"
                            >
                                {busy === "batch:APPROVED" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                                Approve Pending
                            </button>
                            <button
                                onClick={() => batchStatus("REJECTED")}
                                disabled={counts.pending === 0 || busy === "batch:REJECTED"}
                                className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-200 transition hover:bg-red-500/20 disabled:opacity-50"
                            >
                                {busy === "batch:REJECTED" ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                                Reject Pending
                            </button>
                        </div>
                    </div>

                    {session.changes.length === 0 ? (
                        <div className="rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] p-5 text-sm text-[var(--sky-text-secondary)]">
                            No proposed control updates are available for review. See the analysis summary above for source coverage and reasoning status.
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {session.changes.map((change) => (
                                <ChangeReview
                                    key={change.id}
                                    change={change}
                                    expanded={expandedChangeId === change.id}
                                    busy={busy}
                                    onToggle={() => setExpandedChangeId(expandedChangeId === change.id ? null : change.id)}
                                    onLocalChange={(patch) => updateLocalChange(change.id, patch)}
                                    onLocalNewControl={(field, value) => updateLocalNewControl(change.id, field, value)}
                                    onSave={() => updateChange(change.id, undefined, change)}
                                    onApprove={() => updateChange(change.id, "APPROVED", change)}
                                    onReject={() => updateChange(change.id, "REJECTED", change)}
                                />
                            ))}
                        </div>
                    )}
                </section>
            )}
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-3 py-2">
            <p className="text-[10px] font-semibold uppercase text-[var(--sky-text-muted)]">{label}</p>
            <p className="mt-1 truncate text-sm font-medium text-white" title={value}>{value}</p>
        </div>
    );
}

function StatusPill({ status, count }: { status: ChangeStatus; count: number }) {
    return (
        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[status]}`}>
            {status.toLowerCase()} {count}
        </span>
    );
}

function AuditSourceCard({ title, source }: { title: string; source: AuditSource | null }) {
    if (!source) {
        return (
            <article className="rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] p-4">
                <p className="text-xs font-semibold uppercase text-[var(--sky-text-muted)]">{title}</p>
                <p className="mt-2 text-sm font-medium text-[var(--sky-text-secondary)]">No matching workbook selected</p>
            </article>
        );
    }

    return (
        <article className="rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] p-4">
            <p className="text-xs font-semibold uppercase text-[var(--sky-text-muted)]">{title}</p>
            <p className="mt-2 text-sm font-medium text-white">{source.benchmarkTitle}</p>
            {source.sourceRelationship === "adjacent" && (
                <div className="mt-2 rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">
                    Adjacent evidence only. Reviewer approval required.
                </div>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[var(--sky-text-secondary)]">
                <span>v{source.benchmarkVersion}</span>
                <span>WB {source.workbenchId}</span>
                <span className="col-span-2 truncate" title={source.selectedProfile || ""}>
                    {source.selectedProfile || "Profile not selected"}
                </span>
                {source.matchedSheets?.length ? (
                    <span className="col-span-2 truncate" title={source.matchedSheets.join(", ")}>
                        Sheets: {source.matchedSheets.join(", ")}
                    </span>
                ) : null}
                {source.matchQuery ? (
                    <span className="col-span-2 truncate" title={source.matchQuery}>
                        Query: {source.matchQuery}
                    </span>
                ) : null}
                {source.adjacentCategory ? (
                    <span className="col-span-2 truncate" title={source.adjacentCategory}>
                        Category: {source.adjacentCategory}
                    </span>
                ) : null}
                {source.adjacentRationale ? (
                    <span className="col-span-2 line-clamp-2" title={source.adjacentRationale}>
                        {source.adjacentRationale}
                    </span>
                ) : null}
                <span className="col-span-2 truncate font-mono" title={source.sha256}>
                    SHA {source.sha256.slice(0, 16)}...
                </span>
            </div>
        </article>
    );
}

function sourceEvidenceText(evidence: Record<string, unknown> | null | undefined, key: string): string | null {
    const value = evidence?.[key];
    if (value === null || value === undefined || value === "") return null;
    return String(value);
}

function evidenceTier(change: UpdaterChange): "direct" | "adjacent" | "pub1075" | null {
    const tier = sourceEvidenceText(change.sourceEvidence, "evidenceTier");
    const relationship = sourceEvidenceText(change.sourceEvidence, "sourceRelationship");
    if (tier === "adjacent" || relationship === "adjacent") return "adjacent";
    if (sourceEvidenceText(change.sourceEvidence, "pub1075Only") === "true") return "pub1075";
    if (change.sourceEvidence) return "direct";
    return null;
}

function EvidenceTierBadge({ change }: { change: UpdaterChange }) {
    const tier = evidenceTier(change);
    if (!tier) return null;

    const styles = {
        direct: "border-blue-500/25 bg-blue-500/10 text-blue-300",
        adjacent: "border-amber-500/25 bg-amber-500/10 text-amber-300",
        pub1075: "border-indigo-500/25 bg-indigo-500/10 text-indigo-300",
    };
    const labels = {
        direct: "direct source",
        adjacent: "adjacent source",
        pub1075: "Pub 1075",
    };

    return (
        <span className={`rounded border px-2 py-0.5 text-xs font-medium ${styles[tier]}`}>
            {labels[tier]}
        </span>
    );
}

function SourceEvidencePanel({ change }: { change: UpdaterChange }) {
    if (!change.sourceEvidence) return null;

    const evidence = change.sourceEvidence;
    const rows = [
        ["Tier", evidenceTier(change) || sourceEvidenceText(evidence, "evidenceTier")],
        ["Benchmark", sourceEvidenceText(evidence, "sourceBenchmarkTitle")],
        ["Workbench", sourceEvidenceText(evidence, "sourceWorkbenchId")],
        ["CIS", sourceEvidenceText(evidence, "cisRecommendation")],
        ["CIS Profile", sourceEvidenceText(evidence, "cisProfile")],
        ["STIG", sourceEvidenceText(evidence, "stigRecommendation")],
        ["STIG Profile", sourceEvidenceText(evidence, "stigProfile")],
        ["Adjacent Category", sourceEvidenceText(evidence, "adjacentSourceCategory")],
        ["Applicability", sourceEvidenceText(evidence, "applicabilityRationale")],
        ["Pub 1075", sourceEvidenceText(evidence, "pub1075Version")],
    ].filter(([, value]) => Boolean(value));

    if (rows.length === 0) return null;

    return (
        <div className="mt-4 rounded-lg border border-[var(--sky-border)] bg-[var(--sky-navy)] p-3">
            <p className="mb-2 text-[10px] font-bold uppercase text-[var(--sky-text-muted)]">
                Source Evidence
            </p>
            <div className="grid grid-cols-1 gap-2 text-xs text-[var(--sky-text-secondary)] sm:grid-cols-2">
                {rows.map(([label, value]) => (
                    <div key={label || ""} className="min-w-0">
                        <span className="font-semibold text-[var(--sky-text-primary)]">{label}: </span>
                        <span className="break-words">{value}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function ChangeReview({
    change,
    expanded,
    busy,
    onToggle,
    onLocalChange,
    onLocalNewControl,
    onSave,
    onApprove,
    onReject,
}: {
    change: UpdaterChange;
    expanded: boolean;
    busy: string | null;
    onToggle: () => void;
    onLocalChange: (patch: Partial<UpdaterChange>) => void;
    onLocalNewControl: (field: keyof NonNullable<UpdaterChange["newControl"]>, value: string) => void;
    onSave: () => void;
    onApprove: () => void;
    onReject: () => void;
}) {
    const isNewControl = change.action === "addControl" || change.field === "newControl";
    const statusBusy = busy?.endsWith(`:${change.id}`) || false;

    return (
        <article className="overflow-hidden rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)]">
            <button
                onClick={onToggle}
                className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-white/[0.03]"
            >
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 font-mono text-xs font-medium text-blue-300">
                            {change.testId}
                        </span>
                        <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium ${isNewControl
                            ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                            : "border-purple-500/25 bg-purple-500/10 text-purple-300"
                            }`}>
                            {isNewControl && <PlusCircle className="h-3 w-3" />}
                            {isNewControl ? "New Control" : FIELD_LABELS[change.field] || change.field}
                        </span>
                        <span className={`rounded border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[change.status]}`}>
                            {change.status.toLowerCase()}
                        </span>
                        {change.confidence && (
                            <span className="rounded border border-[var(--sky-border)] bg-[var(--sky-navy)] px-2 py-0.5 text-xs text-[var(--sky-text-secondary)]">
                                {change.confidence.replace("_", " ")}
                            </span>
                        )}
                        <EvidenceTierBadge change={change} />
                    </div>
                    <p className="mt-1 truncate text-xs text-[var(--sky-text-secondary)]">{change.reason}</p>
                </div>
                {expanded ? <ChevronUp className="h-4 w-4 shrink-0 text-[var(--sky-text-muted)]" /> : <ChevronDown className="h-4 w-4 shrink-0 text-[var(--sky-text-muted)]" />}
            </button>

            {expanded && (
                <div className="border-t border-[var(--sky-border)] p-4">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <div className="rounded-lg border border-red-500/25 bg-red-950/30 p-3">
                            <span className="mb-2 block text-[10px] font-bold uppercase text-red-200">
                                Current {isNewControl ? "SCSEM" : FIELD_LABELS[change.field] || change.field}
                            </span>
                            <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--sky-text-primary)]">{change.currentValue}</p>
                        </div>
                        <div className="rounded-lg border border-emerald-500/25 bg-emerald-950/30 p-3">
                            <span className="mb-2 block text-[10px] font-bold uppercase text-emerald-200">
                                Proposed
                            </span>
                            {isNewControl ? (
                                <NewControlEditor
                                    change={change}
                                    onSummaryChange={(value) => onLocalChange({ proposedValue: value })}
                                    onReasonChange={(value) => onLocalChange({ reason: value })}
                                    onFieldChange={onLocalNewControl}
                                />
                            ) : (
                                <div className="space-y-3">
                                    <Textarea
                                        value={change.proposedValue}
                                        onChange={(event) => onLocalChange({ proposedValue: event.target.value })}
                                        className="min-h-[180px]"
                                    />
                                    <div>
                                        <span className="mb-1 block text-[10px] font-bold uppercase text-[var(--sky-text-primary)]">
                                            Explanation
                                        </span>
                                        <Textarea
                                            value={change.reason}
                                            onChange={(event) => onLocalChange({ reason: event.target.value })}
                                            className="min-h-[90px]"
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    <SourceEvidencePanel change={change} />

                    <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                        <button
                            onClick={onSave}
                            disabled={statusBusy}
                            className="inline-flex items-center gap-2 rounded-lg border border-[var(--sky-border)] bg-[var(--sky-navy)] px-3 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50"
                        >
                            {busy === `save:${change.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            Save
                        </button>
                        <button
                            onClick={onApprove}
                            disabled={statusBusy}
                            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
                        >
                            {busy === `APPROVED:${change.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                            Approve
                        </button>
                        <button
                            onClick={onReject}
                            disabled={statusBusy}
                            className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-200 transition hover:bg-red-500/20 disabled:opacity-50"
                        >
                            {busy === `REJECTED:${change.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                            Reject
                        </button>
                    </div>
                </div>
            )}
        </article>
    );
}

function NewControlEditor({
    change,
    onSummaryChange,
    onReasonChange,
    onFieldChange,
}: {
    change: UpdaterChange;
    onSummaryChange: (value: string) => void;
    onReasonChange: (value: string) => void;
    onFieldChange: (field: keyof NonNullable<UpdaterChange["newControl"]>, value: string) => void;
}) {
    const control = change.newControl || {};
    const shortFields: Array<[keyof NonNullable<UpdaterChange["newControl"]>, string]> = [
        ["sectionTitle", "Section Title"],
        ["nistId", "NIST ID"],
        ["nistControlName", "NIST Control Name"],
        ["testMethod", "Test Method"],
        ["criticality", "Criticality"],
        ["cisBenchmarkRef", "CIS Benchmark Section"],
        ["recommendationNum", "Recommendation #"],
    ];
    const longFields: Array<[keyof NonNullable<UpdaterChange["newControl"]>, string]> = [
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
                <span className="mb-1 block text-[10px] font-bold uppercase text-[var(--sky-text-primary)]">
                    Summary
                </span>
                <Textarea
                    value={change.proposedValue}
                    onChange={(event) => onSummaryChange(event.target.value)}
                    className="min-h-[80px]"
                />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {shortFields.map(([field, label]) => (
                    <label key={field} className="block">
                        <span className="mb-1 block text-[10px] font-bold uppercase text-[var(--sky-text-primary)]">
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
                    <span className="mb-1 block text-[10px] font-bold uppercase text-[var(--sky-text-primary)]">
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
                <span className="mb-1 block text-[10px] font-bold uppercase text-[var(--sky-text-primary)]">
                    Explanation
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
