import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { CISBenchmark, CISExcelFile } from "@/lib/cis-api";
import type { ParsedControl } from "@/lib/xlsx-parser";
import { runtimeDataDir, storedPathForRuntimeFile } from "@/lib/runtime-storage";
import { atomicCreateBufferFileSync } from "@/lib/atomic-file";

XLSX.set_fs(fs);

export interface CISBenchmarkSnapshot {
    workbenchId: number;
    benchmarkTitle: string;
    benchmarkVersion: string;
    releaseDate: Date;
    excelTitle: string;
    excelFileName: string;
    filePath: string;
    sha256: string;
    downloadedAt: Date;
}

export interface CISBenchmarkRecommendation {
    profile: string;
    sourceSheet: string;
    sourceRow: number;
    section: string | null;
    recommendation: string;
    title: string;
    assessmentStatus: string | null;
    description: string | null;
    rationale: string | null;
    impact: string | null;
    remediation: string | null;
    audit: string | null;
    additionalInfo: string | null;
    cisControls: string | null;
    references: string | null;
    defaultValue: string | null;
}

export interface SelectedCISProfile {
    profile: string;
    recommendations: CISBenchmarkRecommendation[];
    sharedRecommendationCount: number;
    totalRecommendationCount: number;
}

export type CISBenchmarkKind = "benchmark" | "stig";

/**
 * Product identity is intentionally separate from the CIS benchmarkVersion.
 * For example, ESXi 8.0 is the product generation while 1.3.0 is the CIS
 * document revision.
 */
export interface CISProductIdentity {
    family: string | null;
    productGeneration: string | null;
}

export interface RankedCISBenchmarkCandidate {
    benchmark: CISBenchmark;
    excel: CISExcelFile;
    titleScore: number;
    productFamily: string | null;
    productGeneration: string | null;
}

export interface CISBenchmarkCandidateDiagnostic {
    workbenchId: number;
    benchmarkTitle: string;
    benchmarkVersion: string;
    excelFileName: string | null;
    titleScore: number;
    productFamily: string | null;
    productGeneration: string | null;
    eligible: boolean;
    rejectionReasons: string[];
}

export interface RankedCISBenchmarkCandidates {
    query: string;
    kind: CISBenchmarkKind;
    queryProduct: CISProductIdentity;
    candidates: RankedCISBenchmarkCandidate[];
    diagnostics: CISBenchmarkCandidateDiagnostic[];
}

const EXCLUDED_TITLE_PATTERNS = [
    /\bSTIG\b/i,
    /\bStand-alone\b/i,
    /\bAzure\b/i,
    /\bARCHIVE\b/i,
];

const EXCLUDED_STIG_TITLE_PATTERNS = [
    /\bStand-alone\b/i,
    /\bAzure\b/i,
    /\bARCHIVE\b/i,
];

function cellStr(value: unknown): string | null {
    if (value === undefined || value === null || value === "") return null;
    const text = String(value).replace(/\r\n/g, "\n").trim();
    return text.length > 0 ? text : null;
}

function normalizeText(value: string | null | undefined): string {
    return (value || "")
        .toLowerCase()
        .replace(/[`*_()[\]{}'":;,.\\/|-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeTitle(value: string): string {
    return normalizeText(value)
        .replace(/^cis /, "")
        .replace(/ benchmark v\d+(?:\.\d+)*/g, "")
        .replace(/\bv\d+(?:\.\d+)+\b/g, "")
        .trim();
}

function normalizeBenchmarkSearchText(value: string | null | undefined): string {
    return normalizeText(value)
        .replace(/\bms\s+sql\b/g, "sql server")
        .replace(/\bsqlserver\b/g, "sql server")
        .replace(/\baws\b/g, "amazon web services")
        .replace(/\bred\s+hat\s+linux\b/g, "red hat enterprise linux")
        .replace(/\brhel\b/g, "red hat enterprise linux")
        .replace(/\boel\b/g, "oracle linux")
        .replace(/\boracle\s+enterprise\s+linux\b/g, "oracle linux")
        .replace(/\bmicrosoft\s+server\b/g, "microsoft windows server")
        .replace(/\bwindows\s+1([01])\b/g, "microsoft windows 1$1")
        .replace(/\bwindows\s+server\b/g, "microsoft windows server")
        .replace(/\s+\d{6,8}$/g, "")
        .replace(/\s+\d{1,2}\s+\d{1,2}\s+\d{2,4}$/g, "")
        .replace(/\s+v(?:ersion\s*)?\d+(?:\s+\d+){0,4}$/g, "")
        .replace(/\bcis\b/g, " ")
        .replace(/\bbenchmark\b/g, " ")
        .replace(/\bstig\b/g, " ")
        .replace(/\bprofile\b/g, " ")
        .replace(/\blevel\s+\d+\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

const MATCH_STOPWORDS = new Set([
    "and",
    "for",
    "the",
    "with",
    "edition",
    "editions",
    "enterprise",
    "server",
    "desktop",
    "workstation",
    "standalone",
    "stand",
    "alone",
]);

function searchTokens(value: string): Set<string> {
    return new Set(value
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 1)
        .filter((token) => !MATCH_STOPWORDS.has(token)));
}

function numericTokens(value: string): Set<string> {
    return new Set(value.match(/\b\d{1,4}\b/g) || []);
}

function productIdentityText(value: string): string {
    return value
        .toLowerCase()
        // A trailing benchmark vX.Y.Z is the document revision, not a product version.
        .replace(/\bbenchmark\s+v(?:ersion\s*)?\d+(?:\.\d+)+\b/gi, " ")
        .replace(/[_/\\:;,|-]+/g, " ")
        .replace(/[^a-z0-9.]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function firstMatch(value: string, patterns: RegExp[]): string | null {
    for (const pattern of patterns) {
        const match = value.match(pattern);
        if (match?.[1]) return match[1];
    }
    return null;
}

/**
 * Extracts identities only for product families where a number in the title is
 * known to be a product generation. This deliberately does not interpret the
 * version of AWS Foundations/Compute/Storage/Database benchmarks as a product
 * generation.
 */
export function identifyCISProduct(value: string): CISProductIdentity {
    const text = productIdentityText(value);

    if (/\b(?:ibm\s+)?db2\b/.test(text)) {
        const isZos = /\bz\s*\/?\s*os\b|\bzos\b/.test(text);
        return {
            family: isZos ? "ibm-db2-zos" : "ibm-db2-distributed",
            productGeneration: firstMatch(text, [
                /\bdb2\s+(?:version\s+|v\s*)?(\d{1,2}(?:\.\d+)?)\b/,
            ]),
        };
    }

    if (
        /\brhel\s*\d*\b.*\bibm z\b/.test(text) ||
        /\bibm z\b.*\brhel\s*\d*\b/.test(text) ||
        /\bred hat enterprise linux\b.*\bibm z\b/.test(text)
    ) {
        return {
            family: "rhel-ibm-z",
            productGeneration: firstMatch(text, [
                /\brhel\s*(\d{1,2})\b/,
                /\bred hat enterprise linux\s*(\d{1,2})\b/,
            ]),
        };
    }

    if (/\bred hat enterprise linux\b|\brhel\s*\d*\b/.test(text)) {
        return {
            family: "rhel",
            productGeneration: firstMatch(text, [
                /\brhel\s*(\d{1,2})\b/,
                /\bred hat enterprise linux\s*(\d{1,2})\b/,
            ]),
        };
    }

    if (/\besxi\b|\besxi\s*\d/.test(text)) {
        return {
            family: "vmware-esxi",
            productGeneration: firstMatch(text, [
                /\besxi\s*(\d+(?:\.\d+)?)\b/,
                /\bvsphere\s*(\d+(?:\.\d+)?)\s+esxi\b/,
            ]),
        };
    }

    if (/\bamazon elastic kubernetes service\b|\baws eks\b/.test(text)) {
        return { family: "amazon-eks", productGeneration: null };
    }

    if (/\bamazon linux\b/.test(text)) {
        return {
            family: "amazon-linux",
            productGeneration: firstMatch(text, [/\bamazon linux\s*(2023|\d+)\b/]),
        };
    }

    if (/\bamazon web services\b|\baws\b/.test(text)) {
        if (/\bend user compute(?: services)?\b/.test(text)) {
            return { family: "aws-end-user-compute", productGeneration: null };
        }
        if (/\bcompute services?\b/.test(text)) {
            return { family: "aws-compute", productGeneration: null };
        }
        if (/\bstorage services?\b/.test(text)) {
            return { family: "aws-storage", productGeneration: null };
        }
        if (/\bdatabase services?\b/.test(text)) {
            return { family: "aws-database", productGeneration: null };
        }
        if (/\bfoundations?\b/.test(text)) {
            return { family: "aws-foundations", productGeneration: null };
        }
        return { family: "aws", productGeneration: null };
    }

    if (/\boracle linux\b/.test(text)) {
        return {
            family: "oracle-linux",
            productGeneration: firstMatch(text, [/\boracle linux\s*(\d{1,2})\b/]),
        };
    }

    if (/\bwindows server\b/.test(text)) {
        return {
            family: "windows-server",
            productGeneration: firstMatch(text, [/\bwindows server\s*(\d{4})\b/]),
        };
    }

    if (/\bwindows\s+(?:10|11)\b/.test(text)) {
        return {
            family: "windows-client",
            productGeneration: firstMatch(text, [/\bwindows\s*(10|11)\b/]),
        };
    }

    return { family: null, productGeneration: null };
}

function familiesAreCompatible(queryFamily: string | null, candidateFamily: string | null): boolean {
    if (!queryFamily) return true;
    if (queryFamily === "aws") {
        return candidateFamily === "aws" || Boolean(candidateFamily?.startsWith("aws-"));
    }
    return queryFamily === candidateFamily;
}

function generationParts(value: string | null): number[] {
    if (!value) return [];
    return value
        .split(".")
        .map((part) => Number.parseInt(part, 10))
        .filter((part) => Number.isFinite(part));
}

function compareProductGenerations(a: string | null, b: string | null): number {
    const left = generationParts(a);
    const right = generationParts(b);
    const max = Math.max(left.length, right.length);
    for (let i = 0; i < max; i++) {
        const diff = (left[i] || 0) - (right[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function sameProductGeneration(a: string, b: string): boolean {
    return compareProductGenerations(a, b) === 0;
}

function matchingScore(technology: string, titleText: string): number {
    const normalizedTechnology = normalizeBenchmarkSearchText(technology);
    const normalizedTitle = normalizeBenchmarkSearchText(titleText);
    if (!normalizedTechnology || !normalizedTitle) return 0;

    if (normalizedTitle.includes(normalizedTechnology) || normalizedTechnology.includes(normalizedTitle)) {
        return 1000;
    }

    const technologyTokens = searchTokens(normalizedTechnology);
    const titleTokens = searchTokens(normalizedTitle);
    if (technologyTokens.size === 0 || titleTokens.size === 0) return 0;

    let matched = 0;
    for (const token of technologyTokens) {
        if (titleTokens.has(token)) matched++;
    }

    const recall = matched / technologyTokens.size;
    const precision = matched / Math.min(titleTokens.size, technologyTokens.size + 3);
    let score = (recall * 75) + (precision * 25);

    const technologyNumbers = numericTokens(normalizedTechnology);
    const titleNumbers = numericTokens(normalizedTitle);
    if (technologyNumbers.size > 0) {
        const sharedNumber = [...technologyNumbers].some((token) => titleNumbers.has(token));
        if (!sharedNumber) score -= 35;
        else score += 20;
    }

    if (/\bwindows\b/.test(normalizedTechnology) !== /\bwindows\b/.test(normalizedTitle)) score -= 25;
    if (/\blinux\b/.test(normalizedTechnology) !== /\blinux\b/.test(normalizedTitle)) score -= 20;

    return score;
}

function parseVersion(value: string | null | undefined): number[] {
    return (value || "")
        .split(".")
        .map((part) => Number.parseInt(part.replace(/\D/g, ""), 10))
        .filter((part) => Number.isFinite(part));
}

function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
    const left = parseVersion(a);
    const right = parseVersion(b);
    const max = Math.max(left.length, right.length);
    for (let i = 0; i < max; i++) {
        const diff = (left[i] || 0) - (right[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function parseCISDate(value: string | null | undefined): Date {
    const parsed = new Date(value || "");
    return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function extractVersionFromTitle(title: string): string | null {
    return title.match(/\bv(\d+(?:\.\d+)+)\b/i)?.[1] || null;
}

function safePathPart(value: string): string {
    return value
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 120);
}

function sha256(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

function headerIndex(headers: string[], patterns: RegExp[]): number {
    return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
}

function valueAt(row: unknown[], index: number): string | null {
    return index >= 0 ? cellStr(row[index]) : null;
}

export function normalizeRecommendation(value: string | null | undefined): string | null {
    if (!value) return null;
    const normalized = String(value).trim().replace(/\s+/g, "");
    return normalized.length > 0 ? normalized : null;
}

export function selectLatestBenchmarkForTechnology(
    technology: string,
    benchmarks: CISBenchmark[],
    excelFiles: CISExcelFile[]
): { benchmark: CISBenchmark; excel: CISExcelFile } | null {
    const selected = rankCISBenchmarkCandidatesForTechnology(
        technology,
        benchmarks,
        excelFiles,
        "benchmark"
    ).candidates[0];
    return selected ? { benchmark: selected.benchmark, excel: selected.excel } : null;
}

export function selectLatestSTIGBenchmarkForTechnology(
    technology: string,
    benchmarks: CISBenchmark[],
    excelFiles: CISExcelFile[]
): { benchmark: CISBenchmark; excel: CISExcelFile } | null {
    const selected = rankCISBenchmarkCandidatesForTechnology(
        technology,
        benchmarks,
        excelFiles,
        "stig"
    ).candidates[0];
    return selected ? { benchmark: selected.benchmark, excel: selected.excel } : null;
}

/**
 * Returns every eligible catalog candidate in resolution order plus explicit
 * rejection diagnostics. Callers that can validate workbook contents should
 * walk this list until a candidate passes that validation instead of assuming
 * the first title match is usable.
 */
export function rankCISBenchmarkCandidatesForTechnology(
    technology: string,
    benchmarks: CISBenchmark[],
    excelFiles: CISExcelFile[],
    kind: CISBenchmarkKind = "benchmark"
): RankedCISBenchmarkCandidates {
    const excelById = new Map(excelFiles.map((excel) => [Number(excel.workbenchId), excel]));
    const queryProduct = identifyCISProduct(technology);
    const candidates: RankedCISBenchmarkCandidate[] = [];
    const diagnostics: CISBenchmarkCandidateDiagnostic[] = [];

    for (const benchmark of benchmarks) {
        const excel = excelById.get(Number(benchmark.workbenchId));
        const titleText = [
            benchmark.benchmarkTitle,
            excel?.excelTitle,
            excel?.excelFileName,
        ].filter(Boolean).join(" ");
        const titleScore = matchingScore(technology, titleText);
        const candidateProduct = identifyCISProduct(titleText);
        const rejectionReasons: string[] = [];
        const isStig = /\bSTIG\b/i.test(titleText);
        const publicationStatus = (benchmark.benchmarkStatus?.status || "").trim().toLowerCase();
        const workbenchStatus = (benchmark.workbenchStatus?.status || "").trim().toLowerCase();

        if (!excel) rejectionReasons.push("no CIS Excel workbook is available");
        if (publicationStatus !== "accepted") {
            rejectionReasons.push(
                publicationStatus
                    ? `benchmark publication status is ${publicationStatus}, not accepted`
                    : "benchmark publication status is missing"
            );
        }
        if (workbenchStatus && workbenchStatus !== "published") {
            rejectionReasons.push(`CIS WorkBench status is ${workbenchStatus}, not published`);
        }
        if (kind === "benchmark" && EXCLUDED_TITLE_PATTERNS.some((pattern) => pattern.test(titleText))) {
            rejectionReasons.push(isStig ? "STIG benchmark requested separately" : "excluded benchmark variant");
        }
        if (
            kind === "stig" &&
            (!isStig || EXCLUDED_STIG_TITLE_PATTERNS.some((pattern) => pattern.test(titleText)))
        ) {
            rejectionReasons.push(!isStig ? "not a STIG benchmark" : "excluded STIG variant");
        }

        if (!familiesAreCompatible(queryProduct.family, candidateProduct.family)) {
            rejectionReasons.push(
                `product family mismatch (${queryProduct.family || "unknown"} vs ${candidateProduct.family || "unknown"})`
            );
        }

        if (queryProduct.productGeneration) {
            if (!candidateProduct.productGeneration) {
                rejectionReasons.push(
                    `candidate does not identify target product generation ${queryProduct.productGeneration}`
                );
            } else if (!sameProductGeneration(
                queryProduct.productGeneration,
                candidateProduct.productGeneration
            )) {
                rejectionReasons.push(
                    `product generation mismatch (${queryProduct.productGeneration} vs ${candidateProduct.productGeneration})`
                );
            }
        }

        if (titleScore < 65) rejectionReasons.push(`title similarity ${titleScore.toFixed(1)} is below 65`);

        diagnostics.push({
            workbenchId: Number(benchmark.workbenchId),
            benchmarkTitle: benchmark.benchmarkTitle,
            benchmarkVersion: benchmark.benchmarkVersion,
            excelFileName: excel?.excelFileName || null,
            titleScore,
            productFamily: candidateProduct.family,
            productGeneration: candidateProduct.productGeneration,
            eligible: rejectionReasons.length === 0,
            rejectionReasons,
        });

        if (!excel || rejectionReasons.length > 0) continue;
        candidates.push({
            benchmark,
            excel,
            titleScore,
            productFamily: candidateProduct.family,
            productGeneration: candidateProduct.productGeneration,
        });
    }

    candidates.sort((a, b) => {
        if (!queryProduct.family) {
            const scoreDiff = b.titleScore - a.titleScore;
            if (scoreDiff !== 0) return scoreDiff;
        }

        // With a family-only query, product generation is the primary version
        // axis. This is what makes a generic ESXi query prefer ESXi 8 over an
        // ESXi 7 document that happens to have a larger benchmark revision.
        if (queryProduct.family && !queryProduct.productGeneration) {
            const generationDiff = compareProductGenerations(
                b.productGeneration,
                a.productGeneration
            );
            if (generationDiff !== 0) return generationDiff;
        }

        if (queryProduct.family === "aws") {
            const familyPreference = (family: string | null) => family === "aws-foundations" ? 1 : 0;
            const familyDiff = familyPreference(b.productFamily) - familyPreference(a.productFamily);
            if (familyDiff !== 0) return familyDiff;
        }

        if (queryProduct.family) {
            const scoreDiff = b.titleScore - a.titleScore;
            if (scoreDiff !== 0) return scoreDiff;
        }

        const versionDiff = compareVersions(b.benchmark.benchmarkVersion, a.benchmark.benchmarkVersion);
        if (versionDiff !== 0) return versionDiff;

        return (
            parseCISDate(b.benchmark.benchmarkStatus?.statusDate).getTime() -
            parseCISDate(a.benchmark.benchmarkStatus?.statusDate).getTime()
        );
    });

    const rankByWorkbenchId = new Map(candidates.map((candidate, index) => [
        Number(candidate.benchmark.workbenchId),
        index,
    ]));
    diagnostics.sort((a, b) => {
        if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
        const leftRank = rankByWorkbenchId.get(a.workbenchId);
        const rightRank = rankByWorkbenchId.get(b.workbenchId);
        if (leftRank !== undefined || rightRank !== undefined) {
            return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
        }
        return b.titleScore - a.titleScore;
    });

    return {
        query: technology,
        kind,
        queryProduct,
        candidates,
        diagnostics,
    };
}

export function saveCISBenchmarkSnapshot(
    benchmark: CISBenchmark,
    excel: CISExcelFile,
    workbookBuffer: Buffer
): CISBenchmarkSnapshot {
    const hash = sha256(workbookBuffer);
    const fileName = safePathPart(
        excel.excelFileName || `cis-${benchmark.workbenchId}.xlsx`
    ) || `cis-${benchmark.workbenchId}.xlsx`;
    const snapshotDir = path.join(
        runtimeDataDir("cis-benchmarks"),
        String(benchmark.workbenchId),
        hash
    );
    const filePath = path.join(snapshotDir, fileName);
    const storedFilePath = storedPathForRuntimeFile(filePath);
    const metadataPath = path.join(snapshotDir, `${fileName}.metadata.json`);
    const downloadedAt = new Date();

    fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
    atomicCreateBufferFileSync(filePath, workbookBuffer, { mode: 0o600 });
    const persistedWorkbook = fs.readFileSync(filePath);
    if (
        sha256(persistedWorkbook) !== hash ||
        (fs.statSync(filePath).mode & 0o077) !== 0
    ) {
        throw new Error("Stored CIS benchmark evidence failed integrity validation.");
    }

    const proposedMetadata: CISBenchmarkSnapshot = {
        workbenchId: Number(benchmark.workbenchId),
        benchmarkTitle: benchmark.benchmarkTitle,
        benchmarkVersion: benchmark.benchmarkVersion,
        releaseDate: parseCISDate(benchmark.benchmarkStatus?.statusDate),
        excelTitle: excel.excelTitle,
        excelFileName: excel.excelFileName,
        filePath: storedFilePath,
        sha256: hash,
        downloadedAt,
    };

    atomicCreateBufferFileSync(
        metadataPath,
        Buffer.from(JSON.stringify({
            ...proposedMetadata,
            downloadedAt: downloadedAt.toISOString(),
            releaseDate: proposedMetadata.releaseDate.toISOString(),
        }, null, 2), "utf8"),
        { mode: 0o600 }
    );

    let storedMetadata: Record<string, unknown>;
    try {
        storedMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    } catch {
        throw new Error("Stored CIS benchmark evidence metadata failed integrity validation.");
    }
    const storedDownloadedAt = new Date(String(storedMetadata.downloadedAt || ""));
    const storedReleaseDate = new Date(String(storedMetadata.releaseDate || ""));
    if (
        storedMetadata.workbenchId !== proposedMetadata.workbenchId ||
        storedMetadata.benchmarkTitle !== proposedMetadata.benchmarkTitle ||
        storedMetadata.benchmarkVersion !== proposedMetadata.benchmarkVersion ||
        storedMetadata.excelTitle !== proposedMetadata.excelTitle ||
        storedMetadata.excelFileName !== proposedMetadata.excelFileName ||
        storedMetadata.filePath !== storedFilePath ||
        storedMetadata.sha256 !== hash ||
        storedReleaseDate.getTime() !== proposedMetadata.releaseDate.getTime() ||
        Number.isNaN(storedDownloadedAt.getTime()) ||
        Number.isNaN(storedReleaseDate.getTime()) ||
        (fs.statSync(metadataPath).mode & 0o077) !== 0
    ) {
        throw new Error("Stored CIS benchmark evidence metadata failed integrity validation.");
    }

    return {
        workbenchId: proposedMetadata.workbenchId,
        benchmarkTitle: String(storedMetadata.benchmarkTitle || ""),
        benchmarkVersion: String(storedMetadata.benchmarkVersion || ""),
        releaseDate: storedReleaseDate,
        excelTitle: String(storedMetadata.excelTitle || ""),
        excelFileName: String(storedMetadata.excelFileName || ""),
        filePath: storedFilePath,
        sha256: hash,
        downloadedAt: storedDownloadedAt,
    };
}

export function parseCISBenchmarkExcel(bufferOrPath: Buffer | string): CISBenchmarkRecommendation[] {
    const workbook = Buffer.isBuffer(bufferOrPath)
        ? XLSX.read(bufferOrPath, { type: "buffer" })
        : XLSX.readFile(bufferOrPath);

    const recommendations: CISBenchmarkRecommendation[] = [];

    for (const sheetName of workbook.SheetNames) {
        if (/license|combined/i.test(sheetName)) continue;

        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, {
            header: 1,
            blankrows: false,
            defval: "",
        }) as unknown[][];

        const headerRowIndex = rows.findIndex((row) => {
            const headers = row.map((cell) => normalizeText(cellStr(cell)));
            return headers.some((header) => header === "recommendation") ||
                headers.some((header) => header === "recommendation #");
        });

        if (headerRowIndex === -1) continue;

        const headers = rows[headerRowIndex].map((cell) => normalizeText(cellStr(cell)));
        const sectionIdx = headerIndex(headers, [/^section #?$/, /^section$/]);
        const recommendationIdx = headerIndex(headers, [/^recommendation #?$/, /^recommendation$/]);
        const titleIdx = headerIndex(headers, [/^title$/]);
        const assessmentIdx = headerIndex(headers, [/^assessment status$/]);
        const descriptionIdx = headerIndex(headers, [/^description$/]);
        const rationaleIdx = headerIndex(headers, [/^rationale statement$/, /^rationale$/]);
        const impactIdx = headerIndex(headers, [/^impact statement$/, /^impact$/]);
        const remediationIdx = headerIndex(headers, [/^remediation procedure$/, /^remediation$/]);
        const auditIdx = headerIndex(headers, [/^audit procedure$/, /^audit$/]);
        const additionalIdx = headerIndex(headers, [/^additional information$/]);
        const controlsIdx = headerIndex(headers, [/^cis controls$/]);
        const referencesIdx = headerIndex(headers, [/^references$/]);
        const defaultIdx = headerIndex(headers, [/^default value$/]);

        if (recommendationIdx === -1 || titleIdx === -1) continue;

        for (let i = headerRowIndex + 1; i < rows.length; i++) {
            const row = rows[i];
            const recommendation = normalizeRecommendation(valueAt(row, recommendationIdx));
            const title = valueAt(row, titleIdx);

            if (!recommendation || !title) continue;

            recommendations.push({
                profile: sheetName,
                sourceSheet: sheetName,
                sourceRow: i + 1,
                section: valueAt(row, sectionIdx),
                recommendation,
                title,
                assessmentStatus: valueAt(row, assessmentIdx),
                description: valueAt(row, descriptionIdx),
                rationale: valueAt(row, rationaleIdx),
                impact: valueAt(row, impactIdx),
                remediation: valueAt(row, remediationIdx),
                audit: valueAt(row, auditIdx),
                additionalInfo: valueAt(row, additionalIdx),
                cisControls: valueAt(row, controlsIdx),
                references: valueAt(row, referencesIdx),
                defaultValue: valueAt(row, defaultIdx),
            });
        }
    }

    return recommendations;
}

export function selectBestCISProfile(
    templateName: string,
    scsemControls: Pick<ParsedControl, "recommendationNum">[],
    recommendations: CISBenchmarkRecommendation[]
): SelectedCISProfile | null {
    const scsemRecommendations = new Set(
        scsemControls
            .map((control) => normalizeRecommendation(control.recommendationNum))
            .filter(Boolean) as string[]
    );
    const byProfile = new Map<string, CISBenchmarkRecommendation[]>();

    for (const recommendation of recommendations) {
        if (!byProfile.has(recommendation.profile)) byProfile.set(recommendation.profile, []);
        byProfile.get(recommendation.profile)?.push(recommendation);
    }

    const template = normalizeText(templateName);
    const candidates = [...byProfile.entries()].map(([profile, profileRecommendations]) => {
        const profileKey = normalizeText(profile);
        const profileRecommendationIds = new Set(profileRecommendations.map((rec) => rec.recommendation));
        const sharedRecommendationCount = [...scsemRecommendations].filter((rec) => profileRecommendationIds.has(rec)).length;
        let profilePreference = 0;
        if (profileKey.includes("level 1")) profilePreference += 4;
        if (profileKey.includes("member server")) profilePreference += template.includes("server") ? 3 : 1;
        if (profileKey.includes("domain controller")) profilePreference += template.includes("domain") ? 3 : 0;

        return {
            profile,
            recommendations: profileRecommendations,
            sharedRecommendationCount,
            totalRecommendationCount: profileRecommendations.length,
            score: sharedRecommendationCount * 10 + profilePreference,
        };
    });

    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates[0];
    if (!selected) return null;

    return {
        profile: selected.profile,
        recommendations: selected.recommendations,
        sharedRecommendationCount: selected.sharedRecommendationCount,
        totalRecommendationCount: selected.totalRecommendationCount,
    };
}

export function selectApplicableSTIGProfiles(
    templateName: string,
    scsemControls: Pick<ParsedControl, "recommendationNum">[],
    recommendations: CISBenchmarkRecommendation[]
): SelectedCISProfile | null {
    const template = normalizeText(templateName);
    const wantsDomainController = /\bdc\b|domain controller/.test(template);
    const wantedPrefix = wantsDomainController ? "dc" : "ms";
    const byProfile = new Map<string, CISBenchmarkRecommendation[]>();

    for (const recommendation of recommendations) {
        if (!byProfile.has(recommendation.profile)) byProfile.set(recommendation.profile, []);
        byProfile.get(recommendation.profile)?.push(recommendation);
    }

    const matchingProfiles = [...byProfile.entries()].filter(([profile]) => {
        const profileKey = normalizeText(profile);
        return profileKey.startsWith(`${wantedPrefix} severity`) ||
            (wantsDomainController && profileKey.includes("domain controller")) ||
            (!wantsDomainController && profileKey.includes("member server"));
    });

    if (matchingProfiles.length === 0) {
        return selectBestCISProfile(templateName, scsemControls, recommendations);
    }

    const scsemRecommendations = new Set(
        scsemControls
            .map((control) => normalizeRecommendation(control.recommendationNum))
            .filter(Boolean) as string[]
    );
    const combined = matchingProfiles.flatMap(([, profileRecommendations]) => profileRecommendations);
    const combinedRecommendationIds = new Set(combined.map((rec) => rec.recommendation));
    const sharedRecommendationCount = [...scsemRecommendations].filter((rec) => combinedRecommendationIds.has(rec)).length;

    return {
        profile: matchingProfiles.map(([profile]) => profile).join(", "),
        recommendations: combined,
        sharedRecommendationCount,
        totalRecommendationCount: combined.length,
    };
}

export function textSimilarity(a: string | null | undefined, b: string | null | undefined): number {
    const left = new Set(normalizeText(a).split(" ").filter((word) => word.length > 3));
    const right = new Set(normalizeText(b).split(" ").filter((word) => word.length > 3));
    if (left.size === 0 && right.size === 0) return 1;
    if (left.size === 0 || right.size === 0) return 0;

    let intersection = 0;
    for (const word of left) {
        if (right.has(word)) intersection++;
    }

    return intersection / (left.size + right.size - intersection);
}

export function recommendationEvidenceSummary(
    recommendation: CISBenchmarkRecommendation,
    sourceLabel = "CIS"
): string {
    return [
        `Profile: ${recommendation.profile}`,
        `${sourceLabel} ${recommendation.recommendation}: ${recommendation.title}`,
        recommendation.assessmentStatus ? `Assessment: ${recommendation.assessmentStatus}` : null,
        recommendation.description ? `Description: ${recommendation.description.slice(0, 900)}` : null,
        recommendation.audit ? `Audit: ${recommendation.audit.slice(0, 700)}` : null,
        recommendation.remediation ? `Remediation: ${recommendation.remediation.slice(0, 700)}` : null,
        recommendation.defaultValue ? `Default: ${recommendation.defaultValue.slice(0, 300)}` : null,
    ].filter(Boolean).join("\n");
}
