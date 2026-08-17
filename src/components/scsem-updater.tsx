"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import type {
    SCSEMUpdaterClientAuditSource as AuditSource,
    SCSEMUpdaterClientChange as UpdaterChange,
    SCSEMUpdaterClientSession as UpdaterSession,
} from "@/lib/scsem-updater-client-session";

type ChangeStatus = "PENDING" | "APPROVED" | "REJECTED";

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

const MAX_ANALYSIS_LEASE_MS = 6 * 60 * 60 * 1000;
const LEASE_TIMER_GRACE_MS = 100;

type AnalysisLeaseViewState = "none" | "checking" | "fresh" | "stale";

export function scsemAnalysisLeaseViewState(
    session: Pick<
        UpdaterSession,
        "status" | "analysisLeasePresent" | "analysisStartedAt" | "analysisLeaseExpiresAt"
    > | null,
    nowMs: number | null,
    serverRetryNotBeforeMs: number | null = null
): {
    state: AnalysisLeaseViewState;
    expiresAtMs: number | null;
    retryAfterMs: number;
    invalid: boolean;
} {
    if (session?.status !== "analyzing") {
        return { state: "none", expiresAtMs: null, retryAfterMs: 0, invalid: false };
    }
    if (nowMs === null) {
        return { state: "checking", expiresAtMs: null, retryAfterMs: 0, invalid: false };
    }

    const startedAtMs = Date.parse(session.analysisStartedAt || "");
    const expiresAtMs = Date.parse(session.analysisLeaseExpiresAt || "");
    const metadataValid = Boolean(
        session.analysisLeasePresent &&
        Number.isFinite(startedAtMs) &&
        Number.isFinite(expiresAtMs) &&
        startedAtMs <= nowMs &&
        expiresAtMs > startedAtMs &&
        expiresAtMs - startedAtMs <= MAX_ANALYSIS_LEASE_MS
    );
    const boundedServerRetryMs = Number.isFinite(serverRetryNotBeforeMs)
        ? Math.min(
            Math.max((serverRetryNotBeforeMs as number) - nowMs, 0),
            MAX_ANALYSIS_LEASE_MS
        )
        : 0;
    const persistedRetryMs = metadataValid
        ? Math.min(Math.max(expiresAtMs - nowMs, 0), MAX_ANALYSIS_LEASE_MS)
        : 0;
    const retryAfterMs = Math.max(boundedServerRetryMs, persistedRetryMs);

    if (retryAfterMs > 0) {
        return {
            state: "fresh",
            expiresAtMs: metadataValid ? expiresAtMs : null,
            retryAfterMs,
            invalid: !metadataValid,
        };
    }
    return {
        state: "stale",
        expiresAtMs: metadataValid ? expiresAtMs : null,
        retryAfterMs: 0,
        invalid: !metadataValid,
    };
}

function formatLeaseDeadline(expiresAtMs: number): string {
    return new Date(expiresAtMs)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, " UTC");
}

function formatRetryWindow(milliseconds: number): string {
    const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes === 0
        ? `${hours} hour${hours === 1 ? "" : "s"}`
        : `${hours}h ${remainingMinutes}m`;
}

function supplementalComparisonLabel(
    mode: "ai" | "deterministic_fallback" | "no_delta" | "failed"
): string {
    if (mode === "ai") return "AI evidence comparison";
    if (mode === "deterministic_fallback") return "Deterministic evidence comparison";
    if (mode === "no_delta") return "Direct sources checked — no material delta";
    return "Supplemental comparison failed or unavailable";
}

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

function safeExportFileName(contentDisposition: string | null, fallback: string): string {
    const encoded = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const quoted = contentDisposition?.match(/filename="([^"]+)"/i)?.[1];
    let candidate = quoted || fallback;
    if (encoded) {
        try {
            candidate = decodeURIComponent(encoded);
        } catch {
            candidate = quoted || fallback;
        }
    }

    const sanitized = candidate
        .replace(/[\u0000-\u001f\u007f"/\\:]+/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
    return sanitized || fallback;
}

export function SCSEMUpdater() {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [session, setSession] = useState<UpdaterSession | null>(null);
    const [expandedChangeId, setExpandedChangeId] = useState<string | null>(null);
    const [dragActive, setDragActive] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [leaseClockMs, setLeaseClockMs] = useState<number | null>(null);
    const [analysisRetryNotBeforeMs, setAnalysisRetryNotBeforeMs] = useState<number | null>(null);

    const sessionStatus = session?.status || null;
    const analysisLeasePresent = session?.analysisLeasePresent || false;
    const analysisStartedAt = session?.analysisStartedAt || null;
    const analysisLeaseExpiresAt = session?.analysisLeaseExpiresAt || null;

    useEffect(() => {
        if (sessionStatus !== "analyzing") {
            setLeaseClockMs(null);
            setAnalysisRetryNotBeforeMs(null);
            return;
        }

        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let cancelled = false;
        const refreshAtLeaseBoundary = () => {
            if (cancelled) return;
            const nowMs = Date.now();
            setLeaseClockMs(nowMs);
            const view = scsemAnalysisLeaseViewState({
                status: "analyzing",
                analysisLeasePresent,
                analysisStartedAt: analysisStartedAt || undefined,
                analysisLeaseExpiresAt: analysisLeaseExpiresAt || undefined,
            }, nowMs, analysisRetryNotBeforeMs);
            if (view.state === "fresh") {
                timeoutId = setTimeout(
                    refreshAtLeaseBoundary,
                    Math.max(1, view.retryAfterMs + LEASE_TIMER_GRACE_MS)
                );
            }
        };

        refreshAtLeaseBoundary();
        return () => {
            cancelled = true;
            if (timeoutId !== null) clearTimeout(timeoutId);
        };
    }, [
        sessionStatus,
        analysisLeasePresent,
        analysisStartedAt,
        analysisLeaseExpiresAt,
        analysisRetryNotBeforeMs,
    ]);

    const analysisLeaseView = scsemAnalysisLeaseViewState(
        session,
        leaseClockMs,
        analysisRetryNotBeforeMs
    );
    const analysisBusy = busy === "analyze" || busy === "recover-analysis";
    const staleAnalysisRecoverable = sessionStatus === "analyzing" &&
        analysisLeaseView.state === "stale";
    const activeAnalysisProtected = sessionStatus === "analyzing" &&
        analysisLeaseView.state !== "stale";

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

    const cisResolutionMessage = useMemo(() => {
        const diagnostics = session?.audit.benchmarkResolution?.filter((item) => item.kind === "CIS") || [];
        const attempted = diagnostics.find((item) => item.attempts.length > 0);
        if (attempted) {
            const lastAttempt = attempted.attempts[attempted.attempts.length - 1];
            return `Tried ${attempted.sheetName} as “${attempted.query}”; ${lastAttempt.reason}`;
        }
        const catalogMiss = diagnostics.find((item) => item.catalogCandidateCount === 0);
        return catalogMiss
            ? `No CIS catalog candidate matched ${catalogMiss.sheetName} as “${catalogMiss.query}”.`
            : null;
    }, [session]);

    async function reloadLatestSession(sessionId: string): Promise<boolean> {
        const latestResponse = await fetch(`/api/scsem-updater/${sessionId}`, {
            cache: "no-store",
        });
        const latest = await readApiJson<{ session?: UpdaterSession }>(
            latestResponse,
            "Could not reload the latest SCSEM session"
        );
        if (!latestResponse.ok || !latest.session) return false;
        setSession(latest.session);
        setAnalysisRetryNotBeforeMs(null);
        return true;
    }

    async function throwMutationError(
        res: Response,
        data: {
            error?: string;
            code?: string;
            retryAfterMs?: number;
            analysisLeaseExpiresAt?: string;
        },
        fallback: string,
        sessionId: string
    ): Promise<never> {
        if (res.status === 409 && data.code === "SCSEM_SESSION_CONFLICT") {
            try {
                await reloadLatestSession(sessionId);
            } catch {
                // Keep the conflict visible even if the convenience reload fails.
            }
            const conflict = new Error(
                `${data.error || fallback} The latest saved session was reloaded when available.`
            );
            conflict.name = "SCSEM_SESSION_CONFLICT";
            throw conflict;
        }
        if (res.status === 409 && data.code === "SCSEM_ANALYSIS_ALREADY_RUNNING") {
            const retryAfterMs = Number.isFinite(data.retryAfterMs) && Number(data.retryAfterMs) > 0
                ? Math.min(Number(data.retryAfterMs), MAX_ANALYSIS_LEASE_MS)
                : 60_000;
            const nowMs = Date.now();
            setLeaseClockMs(nowMs);
            setAnalysisRetryNotBeforeMs(nowMs + retryAfterMs);
            if (data.analysisLeaseExpiresAt) {
                setSession((current) => current?.id === sessionId
                    ? {
                        ...current,
                        status: "analyzing",
                        analysisLeaseExpiresAt: data.analysisLeaseExpiresAt,
                    }
                    : current
                );
            }
            const activeLease = new Error(
                `${data.error || fallback} Retry after the active server lease expires.`
            );
            activeLease.name = "SCSEM_ANALYSIS_ALREADY_RUNNING";
            throw activeLease;
        }
        throw new Error(data.error || fallback);
    }

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
        const recoveringStaleLease = staleAnalysisRecoverable;
        setBusy(recoveringStaleLease ? "recover-analysis" : "analyze");
        setError(null);
        try {
            const res = await fetch(`/api/scsem-updater/${session.id}/analyze`, {
                method: "POST",
                headers: { "If-Match": `"${session.revision}"` },
            });
            const data = await readApiJson<{
                error?: string;
                code?: string;
                retryAfterMs?: number;
                analysisLeaseExpiresAt?: string;
                session?: UpdaterSession;
            }>(res, "Analysis failed");
            if (!res.ok) await throwMutationError(res, data, "Analysis failed.", session.id);
            if (!data.session) throw new Error("Analysis completed without returning the updated session.");
            setAnalysisRetryNotBeforeMs(null);
            setSession(data.session);
            setExpandedChangeId(data.session?.changes?.[0]?.id || null);
        } catch (err: any) {
            setError(err.message || "Analysis failed.");
            if (
                err.name !== "SCSEM_SESSION_CONFLICT" &&
                err.name !== "SCSEM_ANALYSIS_ALREADY_RUNNING"
            ) {
                try {
                    await reloadLatestSession(session.id);
                } catch {
                    // Preserve the last canonical client snapshot if reload is unavailable.
                }
            }
        } finally {
            setBusy(null);
        }
    }

    async function updateChange(changeId: string, status?: ChangeStatus, change?: UpdaterChange) {
        if (!session) return;
        setBusy(`${status || "save"}:${changeId}`);
        setError(null);
        try {
            const editableChange = change
                ? {
                    proposedValue: change.proposedValue,
                    ...(change.newControl ? { newControl: change.newControl } : {}),
                }
                : undefined;
            const res = await fetch(`/api/scsem-updater/${session.id}/changes`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "If-Match": `"${session.revision}"`,
                },
                body: JSON.stringify({ changeId, status, change: editableChange }),
            });
            const data = await readApiJson<{ error?: string; code?: string; session: UpdaterSession }>(res, "Could not update change");
            if (!res.ok) await throwMutationError(res, data, "Could not update change.", session.id);
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
                headers: {
                    "Content-Type": "application/json",
                    "If-Match": `"${session.revision}"`,
                },
                body: JSON.stringify({ changeIds: pendingIds, status }),
            });
            const data = await readApiJson<{ error?: string; code?: string; session: UpdaterSession }>(res, "Could not update changes");
            if (!res.ok) await throwMutationError(res, data, "Could not update changes.", session.id);
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
                headers: { "If-Match": `"${session.revision}"` },
            });
            const data = await readApiJson<{ error?: string; code?: string; session: UpdaterSession }>(res, "Could not undo review action");
            if (!res.ok) await throwMutationError(res, data, "Could not undo review action.", session.id);
            setSession(data.session);
        } catch (err: any) {
            setError(err.message || "Could not undo review action.");
        } finally {
            setBusy(null);
        }
    }

    async function exportCandidate() {
        if (!session) return;
        setBusy("export");
        setError(null);
        try {
            const suffix = session.status === "analysis_incomplete"
                ? "?draft=1"
                : "";
            const res = await fetch(`/api/scsem-updater/${session.id}/export${suffix}`, {
                headers: { "If-Match": `"${session.revision}"` },
                cache: "no-store",
            });
            if (!res.ok) {
                const data = await readApiJson<{ error?: string; code?: string }>(
                    res,
                    "Could not export the candidate workbook"
                );
                await throwMutationError(
                    res,
                    data,
                    "Could not export the candidate workbook.",
                    session.id
                );
            }

            const exportedRevisionHeader = res.headers.get("X-SCSEM-Revision");
            const exportedRevision = exportedRevisionHeader === null
                ? Number.NaN
                : Number(exportedRevisionHeader);
            if (!Number.isSafeInteger(exportedRevision) || exportedRevision !== session.revision) {
                throw new Error(
                    "The export response did not match the reviewed session revision. Reload the session and retry."
                );
            }

            const fallbackName = session.originalFileName.replace(
                /(\.xlsx|\.xlsm)$/i,
                session.status === "analysis_incomplete"
                    ? "-updated-DRAFT-INCOMPLETE$1"
                    : "-updated-CANDIDATE$1"
            );
            const fileName = safeExportFileName(
                res.headers.get("Content-Disposition"),
                fallbackName
            );
            const blob = await res.blob();
            const downloadUrl = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = downloadUrl;
            anchor.download = fileName;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
        } catch (err: unknown) {
            setError(err instanceof Error
                ? err.message
                : "Could not export the candidate workbook.");
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

    const analysisButtonLabel = analysisBusy
        ? busy === "recover-analysis"
            ? "Recovering analysis…"
            : "Generating candidate updates…"
        : staleAnalysisRecoverable
            ? "Recover stale analysis"
            : activeAnalysisProtected
                ? "Analysis in progress"
                : "Generate Candidate Updates";
    const leaseDeadlineLabel = analysisLeaseView.expiresAtMs === null
        ? null
        : formatLeaseDeadline(analysisLeaseView.expiresAtMs);
    const leaseRetryWindow = analysisLeaseView.retryAfterMs > 0
        ? formatRetryWindow(analysisLeaseView.retryAfterMs)
        : null;

    return (
        <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
            <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-white">SCSEM Updater</h1>
                    <p className="mt-1 text-sm text-[var(--sky-text-secondary)]">
                        Internal Office of Safeguards workspace for drafting canonical SCSEM template updates. This is not an agency assessment or compliance-certification tool.
                    </p>
                    <p className="mt-2 max-w-4xl text-xs leading-5 text-[var(--sky-text-muted)]">
                        Start from a pinned official IRS source, review every candidate change and unresolved source condition, then export a candidate workbook for separate quality-control and release approval.
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
                        <button
                            onClick={() => void exportCandidate()}
                            disabled={Boolean(busy)}
                            className="inline-flex items-center gap-2 rounded-lg bg-[var(--sky-royal)] px-3 py-2 text-sm font-medium text-white transition hover:bg-[var(--sky-blue)] disabled:opacity-50"
                        >
                            {busy === "export"
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Download className="h-4 w-4" />}
                            {session.status === "analysis_incomplete" ? "Export Incomplete Draft XLSX" : "Export Candidate XLSX"}
                        </button>
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
                        <p className="max-w-full break-all text-sm font-semibold text-white">
                            {session ? session.originalFileName : "Drop official IRS SCSEM template"}
                        </p>
                        <p className="mt-1 text-xs text-[var(--sky-text-muted)]">
                            {session
                                ? `${session.inferredTechnology} - ${session.scsem.totalControls} controls`
                                : "Pinned Safeguards-SCSEM XLSX source only"}
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
                        Choose Official Template
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
                            disabled={analysisBusy || activeAnalysisProtected}
                            type="button"
                            className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
                        >
                            {analysisBusy || activeAnalysisProtected
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : staleAnalysisRecoverable
                                    ? <RotateCcw className="h-4 w-4" />
                                    : <SearchCheck className="h-4 w-4" />}
                            {analysisButtonLabel}
                        </button>
                    </div>
                    {session.status === "analyzing" && (
                        <div
                            role={staleAnalysisRecoverable ? "alert" : "status"}
                            className={`mt-3 flex items-start gap-3 rounded-lg border px-3 py-3 text-xs leading-5 ${staleAnalysisRecoverable
                                ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
                                : "border-blue-500/25 bg-blue-500/10 text-blue-100"
                                }`}
                        >
                            {staleAnalysisRecoverable
                                ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                                : <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-300" />}
                            <div>
                                {analysisLeaseView.state === "checking" ? (
                                    <p>Checking the persisted server analysis lease before enabling recovery.</p>
                                ) : analysisLeaseView.state === "fresh" ? (
                                    <p>
                                        {analysisLeaseView.invalid || !leaseDeadlineLabel
                                            ? "The server confirmed that another analysis lease is still active."
                                            : <>
                                                The persisted analysis lease remains active until{" "}
                                                <time dateTime={session.analysisLeaseExpiresAt}>
                                                    {leaseDeadlineLabel}
                                                </time>.
                                            </>}
                                        {leaseRetryWindow
                                            ? ` Recovery remains locked for up to ${leaseRetryWindow}.`
                                            : " Recovery remains locked while that lease is active."}
                                    </p>
                                ) : (
                                    <>
                                        <p className="font-medium">
                                            {analysisLeaseView.invalid || !leaseDeadlineLabel
                                                ? "The saved analysis lease is missing or invalid."
                                                : `The saved analysis lease expired at ${leaseDeadlineLabel}.`}
                                        </p>
                                        <p className="mt-1 text-amber-100/80">
                                            Recover stale analysis submits this exact session revision through the normal audited analysis route. It does not clear or overwrite analysis state in the browser.
                                        </p>
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                    {session.technologyInference && (
                        <div className="mt-3 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-[var(--sky-text-secondary)]">
                            Identified automatically from {session.technologyInference.source} evidence
                            {` (${session.technologyInference.confidence} confidence)`}
                            {session.technologyInference.signals.length > 0
                                ? `: ${session.technologyInference.signals.join(", ")}`
                                : "."}
                        </div>
                    )}
                </section>
            )}

            {session && (cisAuditSources.length > 0 || stigAuditSources.length > 0 || adjacentAuditSources.length > 0 || session.audit.pub1075Version || session.audit.nistVersion || session.audit.officialReference || session.audit.benchmarkLookupError || session.audit.supplementalComparison) && (
                <section className="mb-6 rounded-xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-5">
                    <div className="mb-4 flex items-center gap-2">
                        <ShieldCheck className="h-5 w-5 text-[var(--sky-light)]" />
                        <h2 className="text-base font-semibold text-white">Evidence Sources</h2>
                    </div>
                    <p className="mb-4 text-xs leading-5 text-[var(--sky-text-muted)]">
                        CIS access uses POST /license, then GET /benchmarks and GET /excel; selected workbooks use GET /excel/&#123;workbenchId&#125;.
                        SkyShield matches CIS Benchmark and CIS-published STIG profile workbooks (CIS-STIG) returned by CIS WorkBench. Licensed access or a technical match does not establish applicability; an authorized reviewer must verify the source, profile, permitted use, and proposed change. Independent DISA STIG release validation is not implemented.
                    </p>
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                        {session.audit.supplementalComparison && (
                            <article className="rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] p-4">
                                <p className="text-xs font-semibold uppercase text-[var(--sky-text-muted)]">Supplemental Comparison</p>
                                <p className="mt-2 text-sm font-medium text-white">
                                    {supplementalComparisonLabel(session.audit.supplementalComparison.mode)}
                                </p>
                                <div className={`mt-2 rounded border px-2 py-1 text-xs ${session.audit.supplementalComparison.complete
                                    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
                                    : "border-amber-500/25 bg-amber-500/10 text-amber-200"
                                    }`}>
                                    {session.audit.supplementalComparison.complete
                                        ? "Comparison completed; source matching remains candidate-only."
                                        : "Comparison incomplete; this session cannot be review-ready."}
                                </div>
                                <p className="mt-2 text-xs leading-5 text-[var(--sky-text-secondary)]">
                                    Compared {session.audit.supplementalComparison.comparedDirectSourceCount} of {session.audit.supplementalComparison.directSourceCount} direct source(s).{" "}
                                    Compared {session.audit.supplementalComparison.comparedCandidateCount} of {session.audit.supplementalComparison.candidateCount} candidate(s); rebound {session.audit.supplementalComparison.evidenceBoundProposalCount} of {session.audit.supplementalComparison.rawProposalCount} proposal(s) to exact evidence.
                                </p>
                                <p className="mt-2 text-xs leading-5 text-[var(--sky-text-secondary)]">
                                    {session.audit.supplementalComparison.reason}
                                </p>
                                <p className="mt-2 text-xs leading-5 text-blue-200">
                                    A technical source match is not an applicability decision. The reviewer must confirm technology, generation, profile, scope, authority, and permitted use.
                                </p>
                            </article>
                        )}
                        {cisAuditSources.length > 0
                            ? cisAuditSources.map((source, index) => (
                                <AuditSourceCard
                                    key={`cis-${source.workbenchId}-${index}`}
                                    title={cisAuditSources.length > 1 ? `CIS Benchmark ${index + 1}` : "CIS Benchmark"}
                                    source={source}
                                />
                            ))
                            : <AuditSourceCard
                                title="CIS Benchmark"
                                source={null}
                                emptyMessage={session.audit.benchmarkLookupError
                                    ? `CIS source unresolved: ${session.audit.benchmarkLookupError}. Reviewer disposition is required before release.`
                                    : `${cisResolutionMessage || "No direct workbook passed content/profile validation."} CIS applicability remains unresolved until a reviewer records a disposition.`}
                            />}
                        {stigAuditSources.length > 0
                            ? stigAuditSources.map((source, index) => (
                                <AuditSourceCard
                                    key={`stig-${source.workbenchId}-${index}`}
                                    title={stigAuditSources.length > 1 ? `CIS-STIG Workbook ${index + 1}` : "CIS-STIG Workbook"}
                                    source={source}
                                />
                            ))
                            : <AuditSourceCard title="CIS-STIG Workbook" source={null} emptyMessage="No direct CIS-STIG workbook from CIS WorkBench passed content/profile validation. Applicability remains unresolved until a reviewer records a disposition; independent DISA STIG validation is not implemented." />}
                        {adjacentAuditSources.map((source, index) => (
                            <AuditSourceCard
                                key={`adjacent-${source.workbenchId}-${index}`}
                                title={adjacentAuditSources.length > 1 ? `Adjacent Source ${index + 1}` : "Adjacent Source"}
                                source={source}
                            />
                        ))}
                        <article className="rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] p-4">
                            <p className="text-xs font-semibold uppercase text-[var(--sky-text-muted)]">Pinned Publication 1075</p>
                            <p className="mt-2 text-sm font-medium text-white">{session.audit.pub1075Version || "Unknown"}</p>
                            <p className="mt-1 text-xs text-[var(--sky-text-secondary)]">
                                Governing policy evidence for candidate drafting · {session.audit.complianceCoverage?.pub1075 ?? 0} mapped control ID(s)
                            </p>
                        </article>
                        <article className="rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] p-4">
                            <p className="text-xs font-semibold uppercase text-[var(--sky-text-muted)]">Pinned NIST SP 800-53 Mapping</p>
                            <p className="mt-2 text-sm font-medium text-white">{session.audit.nistVersion || "Unknown"}</p>
                            <p className="mt-1 text-xs text-[var(--sky-text-secondary)]">
                                Secondary mapping when Pub 1075 has no matching section · {session.audit.complianceCoverage?.nistFallback ?? 0} mapped ID(s)
                            </p>
                        </article>
                        {session.audit.officialReference && (
                            <article className="rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] p-4">
                                <p className="text-xs font-semibold uppercase text-[var(--sky-text-muted)]">Pinned Official IRS SCSEM Source</p>
                                <p className="mt-2 text-sm font-medium text-white">
                                    v{session.audit.officialReference.workbookVersion || "current"}
                                    {session.audit.officialReference.selectedAsBase ? " used as candidate drafting baseline" : " — uploaded source is structurally current"}
                                </p>
                                <p className="mt-1 text-xs text-[var(--sky-text-secondary)]">
                                    IRS-listed effective date: {session.audit.officialReference.irsEffectiveDate}
                                </p>
                                <p className="mt-1 text-xs leading-5 text-[var(--sky-text-secondary)]">
                                    {session.audit.officialReference.upgradeReason || "No newer official version or platform tab was detected."}
                                </p>
                                {session.audit.officialReference.addedSheets.length > 0 && (
                                    <p className="mt-2 text-xs text-emerald-300">
                                        Adds: {session.audit.officialReference.addedSheets.join(", ")}
                                    </p>
                                )}
                            </article>
                        )}
                    </div>
                </section>
            )}

            {session && (session.status === "review_ready" || session.status === "analysis_incomplete") && (
                <section className="rounded-xl border border-[var(--sky-border)] bg-[var(--sky-surface)] p-5">
                    {session.status === "analysis_incomplete" && (
                        <div className="mb-5 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                            <p>
                                Analysis is incomplete because one or more required source, AI, or applicability checks could not be resolved. You may inspect proposals and export an explicitly marked working draft, but this session is not release-ready.
                            </p>
                        </div>
                    )}
                    <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="text-base font-semibold text-white">Candidate Template Changes</h2>
                                <span className="rounded-full border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] px-2 py-0.5 text-xs text-[var(--sky-text-secondary)]">
                                    {session.changes.length} total
                                </span>
                            </div>
                            {session.summary && (
                                <p className="mt-2 max-w-4xl text-sm leading-6 text-[var(--sky-text-secondary)]">
                                    {session.summary}
                                </p>
                            )}
                            <p className="mt-2 max-w-4xl text-xs leading-5 text-amber-200">
                                Automation output is advisory. Approval includes a change in this candidate draft only; it does not certify completeness, compliance, applicability, or official release.
                            </p>
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
                                Approve Pending for Draft
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
                            No candidate template changes are available. Review the source-coverage diagnostics above; an empty proposal list does not certify that the template is complete or release-ready.
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

function AuditSourceCard({
    title,
    source,
    emptyMessage = "No matching workbook selected",
}: {
    title: string;
    source: AuditSource | null;
    emptyMessage?: string;
}) {
    if (!source) {
        return (
            <article className="rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)] p-4">
                <p className="text-xs font-semibold uppercase text-[var(--sky-text-muted)]">{title}</p>
                <p className="mt-2 text-sm leading-5 text-[var(--sky-text-secondary)]">{emptyMessage}</p>
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
            {source.sourceRelationship === "direct" && (
                <div className="mt-2 rounded border border-blue-500/25 bg-blue-500/10 px-2 py-1 text-xs text-blue-200">
                    Candidate source match only. Reviewer applicability confirmation required.
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

function evidenceTier(change: UpdaterChange): "direct" | "adjacent" | "pub1075" | "nist" | null {
    const tier = sourceEvidenceText(change.sourceEvidence, "evidenceTier");
    const relationship = sourceEvidenceText(change.sourceEvidence, "sourceRelationship");
    const complianceSource = sourceEvidenceText(change.sourceEvidence, "complianceSource") || "";
    if (tier === "adjacent" || relationship === "adjacent") return "adjacent";
    if (complianceSource.includes("NIST")) return "nist";
    if (complianceSource.includes("Publication 1075") || sourceEvidenceText(change.sourceEvidence, "pub1075Only") === "true") return "pub1075";
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
        nist: "border-cyan-500/25 bg-cyan-500/10 text-cyan-300",
    };
    const labels = {
        direct: "direct source",
        adjacent: "adjacent source",
        pub1075: "Pub 1075",
        nist: "NIST fallback",
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
        ["CIS-STIG", sourceEvidenceText(evidence, "stigRecommendation")],
        ["CIS-STIG Profile", sourceEvidenceText(evidence, "stigProfile")],
        ["Adjacent Category", sourceEvidenceText(evidence, "adjacentSourceCategory")],
        ["Applicability", sourceEvidenceText(evidence, "applicabilityRationale")],
        ["Target sheet", change.targetSheet || sourceEvidenceText(evidence, "sourceSheet")],
        ["Pub 1075", sourceEvidenceText(evidence, "pub1075Version")],
        ["NIST fallback", sourceEvidenceText(evidence, "nistVersion")],
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
    const fieldLabel = FIELD_LABELS[change.field] || change.field;
    const actionSummary = isNewControl ? "Add new control" : `Update ${fieldLabel}`;

    return (
        <article className="overflow-hidden rounded-lg border border-[var(--sky-border)] bg-[var(--sky-surface-overlay)]">
            <button
                onClick={onToggle}
                className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-white/[0.03]"
            >
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="max-w-full break-all rounded border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 font-mono text-xs font-medium text-blue-300">
                            {change.testId}
                        </span>
                        {change.targetSheet && (
                            <span className="max-w-64 truncate rounded border border-[var(--sky-border)] bg-[var(--sky-navy)] px-2 py-0.5 text-xs text-[var(--sky-text-secondary)]" title={change.targetSheet}>
                                {change.targetSheet}
                            </span>
                        )}
                        <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium ${isNewControl
                            ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                            : "border-purple-500/25 bg-purple-500/10 text-purple-300"
                            }`}>
                            {isNewControl && <PlusCircle className="h-3 w-3" />}
                            {isNewControl ? "New Control" : fieldLabel}
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
                    <p className="mt-2 text-sm font-semibold text-white">{actionSummary}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--sky-text-secondary)]">{change.reason}</p>
                </div>
                {expanded ? <ChevronUp className="h-4 w-4 shrink-0 text-[var(--sky-text-muted)]" /> : <ChevronDown className="h-4 w-4 shrink-0 text-[var(--sky-text-muted)]" />}
            </button>

            {expanded && (
                <div className="border-t border-[var(--sky-border)] p-4">
                    <div className="mb-4 rounded-lg border border-[var(--sky-border)] bg-[var(--sky-navy)] p-3">
                        <span className="mb-2 block text-[10px] font-bold uppercase text-[var(--sky-text-muted)]">
                            Why This Is Proposed
                        </span>
                        <p className="break-words [overflow-wrap:anywhere] whitespace-pre-wrap text-sm leading-6 text-[var(--sky-text-secondary)]">
                            {change.reason}
                        </p>
                    </div>

                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <div className="rounded-lg border border-red-500/25 bg-red-950/30 p-3">
                            <span className="mb-2 block text-[10px] font-bold uppercase text-red-200">
                                {isNewControl ? "Current SCSEM Coverage" : `Current ${fieldLabel} In Uploaded SCSEM`}
                            </span>
                            <p className="break-words [overflow-wrap:anywhere] whitespace-pre-wrap text-sm leading-6 text-[var(--sky-text-primary)]">{change.currentValue}</p>
                        </div>
                        <div className="rounded-lg border border-emerald-500/25 bg-emerald-950/30 p-3">
                            <span className="mb-2 block text-[10px] font-bold uppercase text-emerald-200">
                                {isNewControl ? "Proposed New Control" : `Proposed ${fieldLabel} Replacement`}
                            </span>
                            {isNewControl ? (
                                <NewControlEditor
                                    change={change}
                                    onSummaryChange={(value) => onLocalChange({ proposedValue: value })}
                                    onFieldChange={onLocalNewControl}
                                />
                            ) : (
                                <Textarea
                                    value={change.proposedValue}
                                    onChange={(event) => onLocalChange({ proposedValue: event.target.value })}
                                    className="min-h-[220px]"
                                />
                            )}
                        </div>
                    </div>

                    <SourceEvidencePanel change={change} />

                    <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
                        <button
                            onClick={onSave}
                            disabled={statusBusy}
                            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-[var(--sky-border)] bg-[var(--sky-navy)] px-3 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50 sm:w-auto"
                        >
                            {busy === `save:${change.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            Save
                        </button>
                        <button
                            onClick={onApprove}
                            disabled={statusBusy}
                            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50 sm:w-auto"
                        >
                            {busy === `APPROVED:${change.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                            Approve for Draft
                        </button>
                        <button
                            onClick={onReject}
                            disabled={statusBusy}
                            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-200 transition hover:bg-red-500/20 disabled:opacity-50 sm:w-auto"
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
    onFieldChange,
}: {
    change: UpdaterChange;
    onSummaryChange: (value: string) => void;
    onFieldChange: (field: keyof NonNullable<UpdaterChange["newControl"]>, value: string) => void;
}) {
    const control = change.newControl || {};
    const shortFields: Array<[keyof NonNullable<UpdaterChange["newControl"]>, string]> = [
        ["sectionTitle", "Section Title"],
        ["nistId", "NIST ID"],
        ["nistControlName", "NIST Control Name"],
        ["testMethod", "Test Method"],
        ["criticality", "Criticality"],
        ["issueCode", "IRS Issue Code (required; one per line)"],
        ["cisBenchmarkRef", "CIS Benchmark Section"],
        ["recommendationNum", "Recommendation #"],
    ];
    const longFields: Array<[keyof NonNullable<UpdaterChange["newControl"]>, string]> = [
        ["description", "Description"],
        ["testProcedures", "Test Procedures"],
        ["expectedResults", "Expected Results"],
        ["findingStatement", "Standard Finding Statement (required when this template has the column)"],
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
                        {field === "issueCode" ? (
                            <Textarea
                                value={(control[field] as string | null | undefined) || ""}
                                onChange={(event) => onFieldChange(field, event.target.value)}
                                className="min-h-[72px]"
                            />
                        ) : (
                            <input
                                value={(control[field] as string | null | undefined) || ""}
                                onChange={(event) => onFieldChange(field, event.target.value)}
                                className="w-full rounded-md border border-[var(--sky-border)] bg-[var(--sky-navy)] px-3 py-2 text-sm text-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                            />
                        )}
                        {field === "issueCode" && (
                            <span className="mt-1 block text-[10px] leading-4 text-amber-200">
                                Must match the uploaded template&apos;s Issue Code Table exactly. Automation does not choose this risk mapping.
                            </span>
                        )}
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

        </div>
    );
}
