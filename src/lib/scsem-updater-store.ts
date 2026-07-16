import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { parseSCSEMFile, type ParsedSCSEM } from "@/lib/xlsx-parser";
import type { OfficialSCSEMReference } from "@/lib/scsem-official-reference";
import {
    resolveRuntimeFilePath,
    runtimeDataDir,
    storedPathForRuntimeFile,
} from "@/lib/runtime-storage";

export type SCSEMUpdaterStatus = "uploaded" | "analyzing" | "review_ready" | "error";
export type SCSEMUpdaterChangeStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface SCSEMUpdaterNewControl {
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
    action: "status" | "edit" | "undo" | "analyze";
    changeId?: string;
    previousStatus?: SCSEMUpdaterChangeStatus;
    nextStatus?: SCSEMUpdaterChangeStatus;
    description?: string;
}

export interface SCSEMUpdaterAuditSource {
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
    originalFileName: string;
    originalFilePath: string;
    organizationId?: string;
    createdByUserId?: string;
    uploadedAt: string;
    inferredTechnology: string;
    technologyInference?: {
        source: "content" | "subject" | "filename" | "fallback";
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
        pub1075Version?: string;
        pub1075SourcePath?: string;
        nistVersion?: string;
        nistSourcePath?: string;
        nistSourceUrl?: string;
        complianceCoverage?: {
            requested: number;
            pub1075: number;
            nistFallback: number;
            uncovered: number;
        };
        benchmarkLookupError?: string;
        benchmarkResolution?: Array<{
            kind: "CIS" | "STIG";
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

function baseDir(): string {
    return runtimeDataDir("scsem-updater");
}

function sha256(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
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

export function inferSCSEMTechnologyDetails(
    originalFileName: string,
    subject?: string | null,
    parsed?: Pick<ParsedSCSEM, "sheets">
): {
    technology: string;
    source: "content" | "subject" | "filename" | "fallback";
    confidence: "high" | "medium" | "low";
    signals: string[];
} {
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

export function createSCSEMUpdaterSession(
    originalFileName: string,
    workbookBuffer: Buffer,
    owner: { organizationId: string; userId: string }
): SCSEMUpdaterSession {
    const id = randomUUID();
    const dir = sessionDir(id);
    fs.mkdirSync(dir, { recursive: true });

    const fileName = safeFileName(originalFileName);
    const absoluteFilePath = path.join(dir, fileName);
    fs.writeFileSync(absoluteFilePath, workbookBuffer);

    const parsed = parseSCSEMFile(absoluteFilePath);
    const technologyInference = inferSCSEMTechnologyDetails(
        originalFileName,
        parsed.metadata.subject,
        parsed
    );
    const session: SCSEMUpdaterSession = {
        id,
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
        },
    };

    writeSCSEMUpdaterSession(session);
    return session;
}

export function readSCSEMUpdaterSession(id: string): SCSEMUpdaterSession {
    const filePath = sessionJsonPath(id);
    if (!fs.existsSync(filePath)) throw new Error("SCSEM updater session not found.");
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as SCSEMUpdaterSession;
}

export function readSCSEMUpdaterSessionForUser(
    id: string,
    user: { organizationId: string }
): SCSEMUpdaterSession {
    const session = readSCSEMUpdaterSession(id);
    if (!session.organizationId || session.organizationId !== user.organizationId) {
        throw new Error("SCSEM updater session not found.");
    }
    return session;
}

export function writeSCSEMUpdaterSession(session: SCSEMUpdaterSession): void {
    const dir = sessionDir(session.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sessionJsonPath(session.id), JSON.stringify(session, null, 2), "utf8");
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
