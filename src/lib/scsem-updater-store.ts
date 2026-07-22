import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { atomicWriteTextFileSync } from "@/lib/atomic-file";
import {
    createAuditOperationId,
    logAudit,
    logAuditStrict,
    type AuditLogParams,
} from "@/lib/audit";
import { parseSCSEMFile, type ParsedSCSEM } from "@/lib/xlsx-parser";
import type { OfficialSCSEMReference } from "@/lib/scsem-official-reference";
import type { OfficialSCSEMManifestEntry } from "@/lib/scsem-official-manifest";
import type {
    SCSEMAnalysisCoverage,
    SCSEMSupplementalComparison,
} from "@/lib/scsem-analysis-coverage";
import {
    resolveRuntimeFilePath,
    runtimeDataDir,
    storedPathForRuntimeFile,
} from "@/lib/runtime-storage";

export type SCSEMUpdaterStatus = "uploaded" | "analyzing" | "analysis_incomplete" | "review_ready" | "error";
export type SCSEMUpdaterChangeStatus = "PENDING" | "APPROVED" | "REJECTED";

export const SCSEM_UPDATER_LOCK_STALE_MS = 10 * 60 * 1000;
export const SCSEM_ANALYSIS_LEASE_MIN_TIMEOUT_MS = 60 * 1000;
export const SCSEM_ANALYSIS_LEASE_MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const SCSEM_ANALYSIS_LEASE_DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

export function resolveSCSEMAnalysisLeaseTimeoutMs(
    configuredValue: string | number | undefined = process.env.SCSEM_UPDATER_ANALYSIS_LEASE_TIMEOUT_MS
): number {
    const parsed = typeof configuredValue === "number"
        ? configuredValue
        : Number(configuredValue);
    if (!Number.isFinite(parsed)) return SCSEM_ANALYSIS_LEASE_DEFAULT_TIMEOUT_MS;
    return Math.min(
        SCSEM_ANALYSIS_LEASE_MAX_TIMEOUT_MS,
        Math.max(SCSEM_ANALYSIS_LEASE_MIN_TIMEOUT_MS, Math.floor(parsed))
    );
}

export const SCSEM_ANALYSIS_LEASE_TIMEOUT_MS = resolveSCSEMAnalysisLeaseTimeoutMs();

export class SCSEMUpdaterConflictError extends Error {
    readonly code = "SCSEM_SESSION_CONFLICT";
    readonly status = 409;

    constructor(
        message: string,
        readonly expectedRevision: number,
        readonly actualRevision: number | null
    ) {
        super(message);
        this.name = "SCSEMUpdaterConflictError";
    }
}

export class SCSEMUpdaterPreconditionError extends Error {
    readonly code = "SCSEM_REVISION_REQUIRED";
    readonly status = 428;

    constructor(message: string) {
        super(message);
        this.name = "SCSEMUpdaterPreconditionError";
    }
}

export function scsemUpdaterMutationErrorDetails(error: unknown): {
    status: 409 | 428;
    code: string;
    error: string;
    expectedRevision?: number;
    actualRevision?: number | null;
} | null {
    if (error instanceof SCSEMUpdaterConflictError) {
        return {
            status: error.status,
            code: error.code,
            error: error.message,
            expectedRevision: error.expectedRevision,
            actualRevision: error.actualRevision,
        };
    }
    if (error instanceof SCSEMUpdaterPreconditionError) {
        return {
            status: error.status,
            code: error.code,
            error: error.message,
        };
    }
    return null;
}

export function requireSCSEMUpdaterExpectedRevision(request: Request): number {
    const ifMatch = request.headers.get("if-match")?.trim();
    const match = ifMatch?.match(/^(?:W\/)?(?:"(\d+)"|(\d+))$/i);
    const revision = match ? Number(match[1] || match[2]) : Number.NaN;
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new SCSEMUpdaterPreconditionError(
            "A valid SCSEM session revision is required in the If-Match header. Reload the session and retry."
        );
    }
    return revision;
}

export function scsemUpdaterRevisionETag(session: Pick<SCSEMUpdaterSession, "revision">): string {
    return `"${session.revision}"`;
}

export function assertSCSEMUpdaterRevision(
    session: Pick<SCSEMUpdaterSession, "revision">,
    expectedRevision: number
): void {
    if (session.revision !== expectedRevision) {
        throw new SCSEMUpdaterConflictError(
            "This SCSEM session changed after it was loaded. Reload the session before applying another update.",
            expectedRevision,
            session.revision
        );
    }
}

export function isSCSEMUpdaterReviewableStatus(status: SCSEMUpdaterStatus): boolean {
    return status === "review_ready" || status === "analysis_incomplete";
}

export interface SCSEMUpdaterNewControl {
    nistId?: string | null;
    nistControlName?: string | null;
    testMethod?: string | null;
    sectionTitle?: string | null;
    description?: string | null;
    testProcedures?: string | null;
    expectedResults?: string | null;
    findingStatement?: string | null;
    criticality?: string | null;
    issueCode?: string | null;
    cisBenchmarkRef?: string | null;
    recommendationNum?: string | null;
    rationale?: string | null;
    impact?: string | null;
    remediationProcedure?: string | null;
}

export interface SCSEMUpdaterChange {
    id: string;
    status: SCSEMUpdaterChangeStatus;
    action: "updateField" | "addControl";
    testId: string;
    field: string;
    currentValue: string;
    proposedValue: string;
    reason: string;
    confidence?: string;
    targetSheet?: string;
    sourceEvidence?: Record<string, unknown> | null;
    newControl?: SCSEMUpdaterNewControl;
}

export interface SCSEMUpdaterHistoryEntry {
    at: string;
    action: "status" | "edit" | "undo" | "analyze" | "durable_mutation";
    operationId?: string;
    analysisOperationId?: string;
    changeId?: string;
    previousStatus?: SCSEMUpdaterChangeStatus;
    nextStatus?: SCSEMUpdaterChangeStatus;
    description?: string;
}

export interface SCSEMUpdaterAuditSource {
    sourceKind?: "CIS" | "CIS_STIG" | "STIG";
    sourceRelationship?: "direct" | "adjacent";
    workbenchId: number;
    benchmarkTitle: string;
    benchmarkVersion: string;
    releaseDate: string;
    excelTitle: string;
    excelFileName: string;
    filePath: string;
    sha256: string;
    downloadedAt: string;
    selectedProfile?: string | null;
    selectedProfileRecommendationCount?: number;
    sharedRecommendationCount?: number;
    matchedSheets?: string[];
    matchQuery?: string;
    adjacentCategory?: string;
    adjacentRationale?: string;
    sourceUrl?: string;
}

export interface SCSEMUpdaterSession {
    id: string;
    revision: number;
    lastOperationId?: string;
    analysisOperationId?: string;
    analysisStartedAt?: string;
    analysisLeaseExpiresAt?: string;
    originalFileName: string;
    originalFilePath: string;
    organizationId?: string;
    createdByUserId?: string;
    uploadedAt: string;
    inferredTechnology: string;
    technologyInference?: {
        source: "official_manifest" | "content" | "subject" | "filename" | "fallback";
        confidence: "high" | "medium" | "low";
        signals: string[];
    };
    status: SCSEMUpdaterStatus;
    summary?: string;
    error?: string;
    scsem: {
        subject: string | null;
        version: string | null;
        effectiveDate: string | null;
        totalControls: number;
        testCaseSheets: string[];
    };
    changes: SCSEMUpdaterChange[];
    history: SCSEMUpdaterHistoryEntry[];
    audit: {
        uploadedSha256: string;
        uploadedSizeBytes: number;
        officialSource?: OfficialSCSEMManifestEntry;
        pub1075Version?: string;
        pub1075SourcePath?: string;
        pub1075SourceSha256?: string;
        nistVersion?: string;
        nistSourcePath?: string;
        nistSourceUrl?: string;
        nistSourceCommit?: string;
        nistSourceSha256?: string;
        nistSnapshotSha256?: string;
        nistAssessmentControlCount?: number;
        analysisCoverage?: SCSEMAnalysisCoverage;
        supplementalComparison?: SCSEMSupplementalComparison;
        complianceCoverage?: {
            requested: number;
            pub1075: number;
            nistFallback: number;
            uncovered: number;
        };
        benchmarkLookupError?: string;
        benchmarkLookupErrorCode?: string;
        benchmarkResolution?: Array<{
            kind: "CIS" | "CIS_STIG" | "STIG";
            query: string;
            sheetName: string;
            catalogCandidateCount: number;
            attempts: Array<{
                workbenchId: number;
                benchmarkTitle: string;
                benchmarkVersion: string;
                outcome: string;
                reason: string;
            }>;
        }>;
        officialReference?: OfficialSCSEMReference | null;
        cis?: SCSEMUpdaterAuditSource | null;
        stig?: SCSEMUpdaterAuditSource | null;
        cisSources?: SCSEMUpdaterAuditSource[];
        stigSources?: SCSEMUpdaterAuditSource[];
        adjacentSources?: SCSEMUpdaterAuditSource[];
    };
}

export type SCSEMUpdaterMutationAction =
    | "SCSEM_UPDATER_UPLOAD"
    | "SCSEM_UPDATER_ANALYZE_START"
    | "SCSEM_UPDATER_ANALYZE_RESTART"
    | "SCSEM_UPDATER_ANALYZE_FINALIZE"
    | "SCSEM_UPDATER_ANALYZE_ERROR"
    | "SCSEM_UPDATER_REVIEW"
    | "SCSEM_UPDATER_EDIT"
    | "SCSEM_UPDATER_UNDO";

export interface SCSEMUpdaterDurableMutation {
    action: SCSEMUpdaterMutationAction;
    /** Exact route-level inputs/outputs affected by this mutation. */
    affectedPayload: Record<string, unknown>;
    analysisOperationId?: string;
    ipAddress?: string;
    userAgent?: string;
}

interface SCSEMUpdaterAuditPersistence {
    persistIntent(params: AuditLogParams): Promise<void>;
    persistOutcome(params: AuditLogParams): Promise<void>;
}

const productionAuditPersistence: SCSEMUpdaterAuditPersistence = {
    persistIntent: logAuditStrict,
    persistOutcome: logAudit,
};

export interface SCSEMAnalysisLease {
    operationId: string;
    startedAt: string;
    expiresAt: string;
}

export type SCSEMAnalysisLeaseClaim =
    | {
        outcome: "already_running";
        lease: SCSEMAnalysisLease;
        retryAfterMs: number;
    }
    | {
        outcome: "started" | "reclaimed";
        lease: SCSEMAnalysisLease;
        previousLease: {
            operationId: string | null;
            startedAt: string | null;
            expiresAt: string | null;
        } | null;
    };

export function createSCSEMAnalysisOperationId(): string {
    return randomUUID();
}

function parsedAnalysisStart(session: SCSEMUpdaterSession): number | null {
    if (!session.analysisStartedAt) return null;
    const parsed = Date.parse(session.analysisStartedAt);
    return Number.isFinite(parsed) ? parsed : null;
}

function parsedAnalysisExpiry(session: SCSEMUpdaterSession): number | null {
    if (!session.analysisLeaseExpiresAt) return null;
    const parsed = Date.parse(session.analysisLeaseExpiresAt);
    return Number.isFinite(parsed) ? parsed : null;
}

export function claimSCSEMAnalysisLease(
    session: SCSEMUpdaterSession,
    operationId: string,
    nowMs: number = Date.now(),
    timeoutMs: number = SCSEM_ANALYSIS_LEASE_TIMEOUT_MS
): SCSEMAnalysisLeaseClaim {
    if (!/^[a-f0-9-]{36}$/i.test(operationId)) {
        throw new Error("A valid analysis operation id is required.");
    }
    if (!Number.isFinite(nowMs)) throw new Error("A valid analysis lease timestamp is required.");
    const boundedTimeoutMs = resolveSCSEMAnalysisLeaseTimeoutMs(timeoutMs);
    const previousStartedMs = parsedAnalysisStart(session);
    const persistedExpiryMs = parsedAnalysisExpiry(session);
    const effectiveExpiryMs = previousStartedMs === null
        ? null
        : persistedExpiryMs !== null &&
            persistedExpiryMs >= previousStartedMs &&
            persistedExpiryMs - previousStartedMs <= SCSEM_ANALYSIS_LEASE_MAX_TIMEOUT_MS
            ? persistedExpiryMs
            : previousStartedMs + boundedTimeoutMs;
    const previousLease = session.status === "analyzing"
        ? {
            operationId: session.analysisOperationId || null,
            startedAt: session.analysisStartedAt || null,
            expiresAt: session.analysisLeaseExpiresAt || null,
        }
        : null;
    const previousLeaseIsValid = Boolean(
        previousLease?.operationId &&
        previousStartedMs !== null &&
        effectiveExpiryMs !== null &&
        previousStartedMs <= nowMs
    );

    if (
        session.status === "analyzing" &&
        previousLeaseIsValid &&
        nowMs < (effectiveExpiryMs as number)
    ) {
        return {
            outcome: "already_running",
            lease: {
                operationId: previousLease?.operationId as string,
                startedAt: previousLease?.startedAt as string,
                expiresAt: new Date(effectiveExpiryMs as number).toISOString(),
            },
            retryAfterMs: Math.max(
                1,
                (effectiveExpiryMs as number) - nowMs
            ),
        };
    }

    const lease = {
        operationId,
        startedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + boundedTimeoutMs).toISOString(),
    };
    session.status = "analyzing";
    session.analysisOperationId = lease.operationId;
    session.analysisStartedAt = lease.startedAt;
    session.analysisLeaseExpiresAt = lease.expiresAt;
    session.error = undefined;
    return {
        outcome: previousLease ? "reclaimed" : "started",
        lease,
        previousLease,
    };
}

export function isSCSEMAnalysisLeaseOwnedBy(
    session: Pick<SCSEMUpdaterSession, "status" | "analysisOperationId">,
    operationId: string | null
): boolean {
    return Boolean(
        operationId &&
        session.status === "analyzing" &&
        session.analysisOperationId === operationId
    );
}

export function clearSCSEMAnalysisLease(
    session: SCSEMUpdaterSession,
    operationId: string | null
): SCSEMAnalysisLease {
    if (!isSCSEMAnalysisLeaseOwnedBy(session, operationId)) {
        throw new SCSEMUpdaterConflictError(
            "This analysis operation no longer owns the SCSEM session lease.",
            session.revision,
            session.revision
        );
    }
    const lease = {
        operationId: session.analysisOperationId as string,
        startedAt: session.analysisStartedAt || "",
        expiresAt: session.analysisLeaseExpiresAt || "",
    };
    delete session.analysisOperationId;
    delete session.analysisStartedAt;
    delete session.analysisLeaseExpiresAt;
    return lease;
}

function baseDir(): string {
    return runtimeDataDir("scsem-updater");
}

function sha256(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

function sha256Text(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonAuditClone(value: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function sourceHashSnapshot(session: SCSEMUpdaterSession): Record<string, unknown> {
    const benchmarkSources = [
        ...(session.audit.cisSources || []),
        ...(session.audit.stigSources || []),
        ...(session.audit.adjacentSources || []),
        ...(session.audit.cis ? [session.audit.cis] : []),
        ...(session.audit.stig ? [session.audit.stig] : []),
    ];
    const uniqueBenchmarks = new Map<string, Record<string, unknown>>();
    for (const source of benchmarkSources) {
        const key = `${source.workbenchId}:${source.sha256}:${source.selectedProfile || ""}`;
        uniqueBenchmarks.set(key, {
            sourceKind: source.sourceKind || null,
            sourceRelationship: source.sourceRelationship || null,
            workbenchId: source.workbenchId,
            benchmarkVersion: source.benchmarkVersion,
            sha256: source.sha256,
            selectedProfile: source.selectedProfile || null,
        });
    }

    return {
        uploaded: {
            sha256: session.audit.uploadedSha256,
            sizeBytes: session.audit.uploadedSizeBytes,
        },
        officialManifest: session.audit.officialSource
            ? {
                sha256: session.audit.officialSource.sha256,
                sizeBytes: session.audit.officialSource.sizeBytes,
                sourceUrl: session.audit.officialSource.sourceUrl,
            }
            : null,
        officialReference: session.audit.officialReference
            ? {
                sha256: session.audit.officialReference.sha256,
                sourceUrl: session.audit.officialReference.sourceUrl,
                selectedAsBase: session.audit.officialReference.selectedAsBase,
            }
            : null,
        pub1075: session.audit.pub1075SourceSha256
            ? {
                version: session.audit.pub1075Version || null,
                sha256: session.audit.pub1075SourceSha256,
            }
            : null,
        nist: session.audit.nistSourceSha256 || session.audit.nistSnapshotSha256
            ? {
                version: session.audit.nistVersion || null,
                sourceSha256: session.audit.nistSourceSha256 || null,
                snapshotSha256: session.audit.nistSnapshotSha256 || null,
                sourceCommit: session.audit.nistSourceCommit || null,
            }
            : null,
        benchmarks: [...uniqueBenchmarks.values()],
    };
}

function atomicWriteBufferSync(destinationPath: string, contents: Buffer): void {
    const directory = path.dirname(destinationPath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = path.join(
        directory,
        `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`
    );
    let fd: number | null = null;

    try {
        fd = fs.openSync(
            temporaryPath,
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
            0o600
        );
        fs.writeFileSync(fd, contents);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(temporaryPath, destinationPath);
        const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
        try {
            fs.fsyncSync(directoryFd);
        } finally {
            fs.closeSync(directoryFd);
        }
    } catch (error) {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch {
                // Preserve the original write failure.
            }
        }
        try {
            fs.unlinkSync(temporaryPath);
        } catch {
            // Preserve the original write failure.
        }
        throw error;
    }
}

function safeFileName(value: string): string {
    const extension = path.extname(value) || ".xlsx";
    const base = path.basename(value, extension)
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 120) || "uploaded-scsem";

    return `${base}${extension.toLowerCase()}`;
}

function safeSessionId(id: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid SCSEM updater session id.");
    return id;
}

function sessionDir(id: string): string {
    return path.join(baseDir(), safeSessionId(id));
}

function sessionJsonPath(id: string): string {
    return path.join(sessionDir(id), "session.json");
}

function sessionLockPath(id: string): string {
    return path.join(sessionDir(id), "session.json.lock");
}

function storedSessionRevision(value: unknown): number {
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Error("SCSEM updater session has an invalid revision.");
    }
    return Number(value);
}

function parseStoredSession(contents: string): SCSEMUpdaterSession {
    const parsed = JSON.parse(contents) as SCSEMUpdaterSession;
    return { ...parsed, revision: storedSessionRevision(parsed.revision) };
}

function currentSessionRevision(id: string): number | null {
    const filePath = sessionJsonPath(id);
    if (!fs.existsSync(filePath)) return null;
    return parseStoredSession(fs.readFileSync(filePath, "utf8")).revision;
}

function acquireSessionLock(id: string, expectedRevision: number): () => void {
    const lockPath = sessionLockPath(id);
    const token = `${process.pid}:${Date.now()}:${randomUUID()}`;

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = fs.openSync(
                lockPath,
                fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
                0o600
            );
            try {
                fs.writeFileSync(fd, token, "utf8");
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }

            return () => {
                try {
                    if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

            let stale = false;
            try {
                stale = Date.now() - fs.statSync(lockPath).mtimeMs > SCSEM_UPDATER_LOCK_STALE_MS;
            } catch (statError) {
                if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
                throw statError;
            }
            if (stale) {
                try {
                    fs.unlinkSync(lockPath);
                    continue;
                } catch (unlinkError) {
                    if ((unlinkError as NodeJS.ErrnoException).code === "ENOENT") continue;
                    throw unlinkError;
                }
            }

            throw new SCSEMUpdaterConflictError(
                "This SCSEM session is being updated by another request. Reload the session and retry.",
                expectedRevision,
                currentSessionRevision(id)
            );
        }
    }

    throw new SCSEMUpdaterConflictError(
        "This SCSEM session could not acquire its update lock. Reload the session and retry.",
        expectedRevision,
        currentSessionRevision(id)
    );
}

function cleanTechnologyName(value: string): string {
    const parenMatch = value.match(/Safeguards[-_\s]*SCSEM\s*\(([^)]+)\)/i);
    const fromParens = parenMatch?.[1];
    const source = fromParens || value;

    let cleaned = source
        .replace(/\.(xlsx|xlsm|xls)$/i, "")
        .replace(/^Safeguards[-_\s]*SCSEM[-_\s]*/i, "")
        .replace(/^SCSEM[-_\s]*/i, "")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .replace(/\s+\d{6,8}$/i, "")
        .replace(/\s+\d{1,2}\s+\d{1,2}\s+\d{2,4}$/i, "")
        .replace(/\s+v(?:ersion\s*)?\d+(?:[\s.]\d+){0,4}$/i, "")
        .trim();

    cleaned = cleaned
        .replace(/^Microsoft Server\b/i, "Microsoft Windows Server")
        .replace(/^Windows Server\b/i, "Microsoft Windows Server")
        .replace(/^Windows 1([01])\b/i, "Microsoft Windows 1$1")
        .replace(/\bRed Hat Linux\b/i, "Red Hat Enterprise Linux")
        .replace(/\bRHEL\b/i, "Red Hat Enterprise Linux")
        .replace(/\s*\(\s*Red Hat Enterprise Linux\s*\)\s*/gi, " ")
        .replace(/\b(Red Hat Enterprise Linux)\s+\1\b/ig, "$1")
        .replace(/\s+/g, " ")
        .trim();

    return cleaned;
}

export type SCSEMTechnologyInference = {
    technology: string;
    source: "official_manifest" | "content" | "subject" | "filename" | "fallback";
    confidence: "high" | "medium" | "low";
    signals: string[];
};

export function inferSCSEMTechnologyDetails(
    originalFileName: string,
    subject?: string | null,
    parsed?: Pick<ParsedSCSEM, "sheets">
): SCSEMTechnologyInference {
    const fromFileName = cleanTechnologyName(originalFileName);
    const fromSubject = subject ? cleanTechnologyName(subject) : "";
    const sheetNames = parsed?.sheets.map((sheet) => sheet.sheetName) || [];
    const controlSignals = (parsed?.sheets || [])
        .filter((sheet) => sheet.sheetType === "test_cases")
        .flatMap((sheet) => sheet.controls.slice(0, 12))
        .flatMap((control) => [
            control.testId,
            control.sectionTitle,
            control.description,
            control.testProcedures,
            control.expectedResults,
            control.remediationProcedure,
        ])
        .filter(Boolean)
        .map(String);
    const evidenceParts = [fromSubject, ...sheetNames, ...controlSignals].filter(Boolean);
    const evidence = evidenceParts.join("\n").toLowerCase();
    const cloudProviderSheets = sheetNames.filter((sheetName) =>
        /\b(?:aws|amazon|azure|google|office\s*365|microsoft\s*365)\b/i.test(sheetName)
    );

    // The IRS Cloud SCSEM is one workbook with separate AWS, Azure, Google,
    // and Microsoft 365 tabs. Do not collapse the entire workbook to whichever
    // provider happens to appear first; the resolver handles each provider tab.
    if (cloudProviderSheets.length >= 2) {
        return {
            technology: fromSubject || "Cloud Computing",
            source: "content",
            confidence: "high",
            signals: cloudProviderSheets.slice(0, 5),
        };
    }

    const contentRules: Array<{
        technology: string;
        patterns: RegExp[];
    }> = [
        {
            technology: "Amazon Linux 2023",
            patterns: [
                /\bamazon linux 2023\b/i,
                /\bamazon linux 23\b/i,
                /\bal2023\b/i,
                /\bamzl23[-_\s]/i,
            ],
        },
        {
            technology: "Amazon Elastic Kubernetes Service (EKS)",
            patterns: [/\bamazon elastic kubernetes service\b/i, /\bamazon eks\b/i],
        },
        {
            technology: "AWS End User Compute Services",
            patterns: [/\baws end user compute\b/i, /\bamazon workspaces\b/i, /\bappstream 2(?:\.0)?\b/i],
        },
        {
            technology: "AWS Database Services",
            patterns: [/\baws database services\b/i, /\bamazon (?:rds|dynamodb|redshift|documentdb|neptune)\b/i],
        },
        {
            technology: "AWS Storage Services",
            patterns: [/\baws storage services\b/i, /\bamazon (?:s3|efs|fsx|glacier)\b/i],
        },
        {
            technology: "AWS Compute Services",
            patterns: [/\baws compute services\b/i, /\bamazon (?:ec2|lambda|lightsail|elastic beanstalk)\b/i],
        },
        {
            technology: "Amazon Web Services Foundations",
            patterns: [/\bamazon web services foundations\b/i, /\baws foundations\b/i],
        },
        {
            technology: "Red Hat Enterprise Linux",
            patterns: [/\bred hat enterprise linux\b/i, /\brhel\s*(?:7|8|9|10)?\b/i, /\brhl(?:gen|7|8|9|10)-/i],
        },
        {
            technology: "VMware ESXi",
            patterns: [/\bvmware\s+(?:vsphere\s+)?esxi\b/i, /\besxi\s*(?:6\.7|7\.0|8\.0|9\.0)?\b/i],
        },
    ];

    for (const rule of contentRules) {
        const matched = rule.patterns.find((pattern) => pattern.test(evidence));
        if (!matched) continue;

        const matchingSignals = evidenceParts
            .filter((part) => rule.patterns.some((pattern) => pattern.test(part)))
            .slice(0, 5);
        return {
            technology: rule.technology,
            source: "content",
            confidence: "high",
            signals: matchingSignals.length > 0 ? matchingSignals : [matched.source],
        };
    }

    if (fromSubject && !/^(unknown|generic|cloud|application|operating system)$/i.test(fromSubject)) {
        return {
            technology: fromSubject,
            source: "subject",
            confidence: "medium",
            signals: [subject || fromSubject],
        };
    }

    if (fromFileName) {
        return {
            technology: fromFileName,
            source: "filename",
            confidence: "medium",
            signals: [originalFileName],
        };
    }

    return {
        technology: fromSubject || "Unknown Technology",
        source: "fallback",
        confidence: "low",
        signals: fromSubject ? [subject || fromSubject] : [],
    };
}

/**
 * Current updater uploads are exact hash-recognized IRS workbooks. Their
 * benchmark-search identity must therefore come from the pinned manifest and
 * workbook structure, never incidental product names in test procedures.
 */
export function inferOfficialSCSEMTechnologyDetails(
    officialSource: OfficialSCSEMManifestEntry,
    parsed: Pick<ParsedSCSEM, "sheets">
): SCSEMTechnologyInference {
    const identityOnlyParsed = {
        sheets: parsed.sheets.map((sheet) => ({ ...sheet, controls: [] })),
    };
    const inferred = inferSCSEMTechnologyDetails(
        officialSource.fileName,
        officialSource.subject,
        identityOnlyParsed
    );
    return {
        ...inferred,
        source: "official_manifest",
        confidence: "high",
        signals: [
            officialSource.fileName,
            officialSource.subject,
            ...officialSource.testCaseSheets,
        ].filter((value): value is string => Boolean(value)),
    };
}

export function inferSCSEMTechnology(
    originalFileName: string,
    subject?: string | null,
    parsed?: Pick<ParsedSCSEM, "sheets">
): string {
    return inferSCSEMTechnologyDetails(originalFileName, subject, parsed).technology;
}

export function resolveUpdaterPath(storedPath: string): string {
    return resolveRuntimeFilePath(storedPath);
}

function parseUploadedSCSEMBuffer(originalFileName: string, workbookBuffer: Buffer): ParsedSCSEM {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "skyshield-scsem-parse-"));
    const temporaryPath = path.join(temporaryDirectory, safeFileName(originalFileName));
    try {
        fs.writeFileSync(temporaryPath, workbookBuffer, { mode: 0o600 });
        return parseSCSEMFile(temporaryPath);
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

interface CanonicalWorkbookWrite {
    absolutePath: string;
    buffer: Buffer;
}

async function persistAuditOutcomeBestEffort(
    persistence: SCSEMUpdaterAuditPersistence,
    params: AuditLogParams
): Promise<void> {
    try {
        await persistence.persistOutcome(params);
    } catch (error) {
        console.error("[SCSEMUpdaterAudit] Failed to persist mutation outcome:", error, {
            action: params.action,
            resourceId: params.resourceId,
            operationId: params.metadata?.operationId,
        });
    }
}

async function persistSCSEMUpdaterSessionWithIntent(
    session: SCSEMUpdaterSession,
    expectedRevision: number,
    mutation: SCSEMUpdaterDurableMutation,
    persistence: SCSEMUpdaterAuditPersistence,
    canonicalWorkbook?: CanonicalWorkbookWrite
): Promise<SCSEMUpdaterSession> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new SCSEMUpdaterPreconditionError("A valid SCSEM session revision is required before writing.");
    }
    if (!session.organizationId || !session.createdByUserId) {
        throw new Error("A durable SCSEM mutation requires an owning organization and user.");
    }

    const affectedPayload = jsonAuditClone(mutation.affectedPayload);
    const affectedPayloadJson = JSON.stringify(affectedPayload);
    const dir = sessionDir(session.id);
    fs.mkdirSync(dir, { recursive: true });
    const releaseLock = acquireSessionLock(session.id, expectedRevision);
    try {
        const sessionPath = sessionJsonPath(session.id);
        const priorSessionJson = fs.existsSync(sessionPath)
            ? fs.readFileSync(sessionPath, "utf8")
            : null;
        const actualRevision = priorSessionJson === null
            ? null
            : parseStoredSession(priorSessionJson).revision;
        const creating = actualRevision === null;
        if (
            (creating && expectedRevision !== 0) ||
            (!creating && actualRevision !== expectedRevision)
        ) {
            throw new SCSEMUpdaterConflictError(
                "This SCSEM session changed after it was loaded. Reload the session before applying another update.",
                expectedRevision,
                actualRevision
            );
        }

        const operationId = createAuditOperationId();
        const intentTimestamp = new Date().toISOString();
        const targetRevision = (actualRevision ?? 0) + 1;
        const nextSession: SCSEMUpdaterSession = {
            ...session,
            revision: targetRevision,
            lastOperationId: operationId,
            history: [
                ...(session.history || []),
                {
                    at: intentTimestamp,
                    action: "durable_mutation",
                    operationId,
                    ...(mutation.analysisOperationId
                        ? { analysisOperationId: mutation.analysisOperationId }
                        : {}),
                    description: `${mutation.action} committed session revision ${targetRevision}.`,
                },
            ],
        };
        const nextSessionJson = JSON.stringify(nextSession, null, 2);
        const beforeSessionSha256 = priorSessionJson === null ? null : sha256Text(priorSessionJson);
        const afterSessionSha256 = sha256Text(nextSessionJson);
        const sourceHashes = sourceHashSnapshot(nextSession);
        const auditIdentity = {
            sessionId: session.id,
            owner: {
                organizationId: session.organizationId,
                userId: session.createdByUserId,
            },
            expectedRevision,
            targetRevision,
            mutationAction: mutation.action,
            analysisOperationId: mutation.analysisOperationId || null,
        };
        const auditContext = {
            organizationId: session.organizationId,
            userId: session.createdByUserId,
            resourceType: "scsem_updater_session",
            resourceId: session.id,
            ipAddress: mutation.ipAddress,
            userAgent: mutation.userAgent,
        };
        let intentPersisted = false;

        try {
            await persistence.persistIntent({
                ...auditContext,
                action: "SCSEM_UPDATER_DURABLE_INTENT",
                metadata: {
                    schemaVersion: 1,
                    phase: "INTENT",
                    operationId,
                    timestamp: intentTimestamp,
                    ...auditIdentity,
                    before: {
                        exists: priorSessionJson !== null,
                        revision: actualRevision,
                        sessionJsonSha256: beforeSessionSha256,
                    },
                    after: {
                        revision: targetRevision,
                        sessionJsonSha256: afterSessionSha256,
                        canonicalWorkbookSha256: canonicalWorkbook
                            ? sha256(canonicalWorkbook.buffer)
                            : null,
                    },
                    affectedPayload,
                    affectedPayloadSha256: sha256Text(affectedPayloadJson),
                    sourceHashes,
                },
            });
            intentPersisted = true;

            if (canonicalWorkbook) {
                atomicWriteBufferSync(canonicalWorkbook.absolutePath, canonicalWorkbook.buffer);
            }
            atomicWriteTextFileSync(sessionPath, nextSessionJson, { mode: 0o600 });
        } catch (error) {
            if (intentPersisted) {
                await persistAuditOutcomeBestEffort(persistence, {
                    ...auditContext,
                    action: "SCSEM_UPDATER_DURABLE_ABORTED",
                    metadata: {
                        schemaVersion: 1,
                        phase: "ABORTED",
                        operationId,
                        timestamp: new Date().toISOString(),
                        intentTimestamp,
                        ...auditIdentity,
                        beforeSessionSha256,
                        intendedAfterSessionSha256: afterSessionSha256,
                        sourceHashes,
                        failureType: error instanceof Error ? error.name : "UnknownError",
                    },
                });
            }
            throw error;
        }

        Object.assign(session, nextSession);
        await persistAuditOutcomeBestEffort(persistence, {
            ...auditContext,
            action: "SCSEM_UPDATER_DURABLE_COMPLETED",
            metadata: {
                schemaVersion: 1,
                phase: "COMPLETED",
                operationId,
                timestamp: new Date().toISOString(),
                intentTimestamp,
                ...auditIdentity,
                resultingSessionSha256: afterSessionSha256,
                sourceHashes,
            },
        });
        return session;
    } finally {
        releaseLock();
    }
}

async function createSCSEMUpdaterSessionWithPersistence(
    originalFileName: string,
    workbookBuffer: Buffer,
    owner: { organizationId: string; userId: string },
    officialSource: OfficialSCSEMManifestEntry | undefined,
    mutation: SCSEMUpdaterDurableMutation,
    persistence: SCSEMUpdaterAuditPersistence
): Promise<SCSEMUpdaterSession> {
    const id = randomUUID();
    const dir = sessionDir(id);
    const fileName = safeFileName(originalFileName);
    const absoluteFilePath = path.join(dir, fileName);
    const parsed = parseUploadedSCSEMBuffer(originalFileName, workbookBuffer);
    const technologyInference = officialSource
        ? inferOfficialSCSEMTechnologyDetails(officialSource, parsed)
        : inferSCSEMTechnologyDetails(
            originalFileName,
            parsed.metadata.subject,
            parsed
        );
    const session: SCSEMUpdaterSession = {
        id,
        revision: 0,
        originalFileName,
        originalFilePath: storedPathForRuntimeFile(absoluteFilePath),
        organizationId: owner.organizationId,
        createdByUserId: owner.userId,
        uploadedAt: new Date().toISOString(),
        inferredTechnology: technologyInference.technology,
        technologyInference: {
            source: technologyInference.source,
            confidence: technologyInference.confidence,
            signals: technologyInference.signals,
        },
        status: "uploaded",
        scsem: {
            subject: parsed.metadata.subject,
            version: parsed.metadata.version,
            effectiveDate: parsed.metadata.effectiveDate,
            totalControls: parsed.totalControls,
            testCaseSheets: parsed.sheets
                .filter((sheet) => sheet.sheetType === "test_cases")
                .map((sheet) => sheet.sheetName),
        },
        changes: [],
        history: [],
        audit: {
            uploadedSha256: sha256(workbookBuffer),
            uploadedSizeBytes: workbookBuffer.length,
            ...(officialSource ? { officialSource } : {}),
        },
    };

    return persistSCSEMUpdaterSessionWithIntent(
        session,
        0,
        mutation,
        persistence,
        { absolutePath: absoluteFilePath, buffer: workbookBuffer }
    );
}

export async function createSCSEMUpdaterSession(
    originalFileName: string,
    workbookBuffer: Buffer,
    owner: { organizationId: string; userId: string },
    officialSource: OfficialSCSEMManifestEntry | undefined,
    mutation: SCSEMUpdaterDurableMutation
): Promise<SCSEMUpdaterSession> {
    return createSCSEMUpdaterSessionWithPersistence(
        originalFileName,
        workbookBuffer,
        owner,
        officialSource,
        mutation,
        productionAuditPersistence
    );
}

export function readSCSEMUpdaterSession(id: string): SCSEMUpdaterSession {
    const filePath = sessionJsonPath(id);
    if (!fs.existsSync(filePath)) throw new Error("SCSEM updater session not found.");
    return parseStoredSession(fs.readFileSync(filePath, "utf8"));
}

export function readSCSEMUpdaterSessionForUser(
    id: string,
    user: { id: string; organizationId: string }
): SCSEMUpdaterSession {
    const session = readSCSEMUpdaterSession(id);
    if (
        !session.organizationId ||
        !session.createdByUserId ||
        session.organizationId !== user.organizationId ||
        session.createdByUserId !== user.id
    ) {
        throw new Error("SCSEM updater session not found.");
    }
    return session;
}

/**
 * Run a read-only operation against one exact updater-session revision while
 * holding the same exclusive lock used by writers. The initial owner check is
 * deliberately performed before acquiring the lock so an unauthorized caller
 * cannot block another user's session. The session is then read and checked
 * again under the lock to close the read/lock race.
 */
export async function withLockedSCSEMUpdaterSessionForUser<T>(
    id: string,
    user: { id: string; organizationId: string },
    expectedRevision: number,
    operation: (session: SCSEMUpdaterSession) => T | Promise<T>
): Promise<T> {
    readSCSEMUpdaterSessionForUser(id, user);
    const releaseLock = acquireSessionLock(id, expectedRevision);
    try {
        const session = readSCSEMUpdaterSessionForUser(id, user);
        assertSCSEMUpdaterRevision(session, expectedRevision);
        return await operation(session);
    } finally {
        releaseLock();
    }
}

export async function writeSCSEMUpdaterSession(
    session: SCSEMUpdaterSession,
    expectedRevision: number,
    mutation: SCSEMUpdaterDurableMutation
): Promise<SCSEMUpdaterSession> {
    return persistSCSEMUpdaterSessionWithIntent(
        session,
        expectedRevision,
        mutation,
        productionAuditPersistence
    );
}

export interface SCSEMUpdaterDurabilityTestSink {
    persistIntent(params: AuditLogParams): Promise<void>;
    persistOutcome(params: AuditLogParams): Promise<void>;
}

/**
 * Dependency-injected writer for runtime durability tests. Production code is
 * prevented from using this escape hatch and always uses the database-backed
 * strict intent writer above.
 */
export function createSCSEMUpdaterDurabilityTestHarness(sink: SCSEMUpdaterDurabilityTestSink) {
    if (process.env.NODE_ENV === "production") {
        throw new Error("The SCSEM updater durability test harness is unavailable in production.");
    }
    return {
        createSession(
            originalFileName: string,
            workbookBuffer: Buffer,
            owner: { organizationId: string; userId: string },
            officialSource: OfficialSCSEMManifestEntry | undefined,
            mutation: SCSEMUpdaterDurableMutation
        ) {
            return createSCSEMUpdaterSessionWithPersistence(
                originalFileName,
                workbookBuffer,
                owner,
                officialSource,
                mutation,
                sink
            );
        },
        writeSession(
            session: SCSEMUpdaterSession,
            expectedRevision: number,
            mutation: SCSEMUpdaterDurableMutation
        ) {
            return persistSCSEMUpdaterSessionWithIntent(session, expectedRevision, mutation, sink);
        },
    };
}

export function addIdsToChanges(changes: any[]): SCSEMUpdaterChange[] {
    return changes.map((change) => ({
        id: change.id || randomUUID(),
        status: change.status || "PENDING",
        action: change.action === "addControl" ? "addControl" : "updateField",
        testId: String(change.testId || ""),
        field: String(change.field || (change.action === "addControl" ? "newControl" : "")),
        currentValue: String(change.currentValue || ""),
        proposedValue: String(change.proposedValue || ""),
        reason: String(change.reason || ""),
        confidence: change.confidence,
        targetSheet: change.targetSheet || change.sourceEvidence?.sourceSheet || undefined,
        sourceEvidence: change.sourceEvidence || null,
        ...(change.newControl ? { newControl: change.newControl } : {}),
    }));
}
