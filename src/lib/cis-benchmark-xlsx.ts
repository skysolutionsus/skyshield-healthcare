import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { CISBenchmark, CISExcelFile } from "@/lib/cis-api";
import type { ParsedControl } from "@/lib/xlsx-parser";
import { runtimeDataDir, storedPathForRuntimeFile } from "@/lib/runtime-storage";

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
    return selectLatestBenchmarkByKind(technology, benchmarks, excelFiles, "benchmark");
}

export function selectLatestSTIGBenchmarkForTechnology(
    technology: string,
    benchmarks: CISBenchmark[],
    excelFiles: CISExcelFile[]
): { benchmark: CISBenchmark; excel: CISExcelFile } | null {
    return selectLatestBenchmarkByKind(technology, benchmarks, excelFiles, "stig");
}

function selectLatestBenchmarkByKind(
    technology: string,
    benchmarks: CISBenchmark[],
    excelFiles: CISExcelFile[],
    kind: "benchmark" | "stig"
): { benchmark: CISBenchmark; excel: CISExcelFile } | null {
    const normalizedTechnology = normalizeTitle(technology);
    const excelById = new Map(excelFiles.map((excel) => [Number(excel.workbenchId), excel]));

    const candidates = benchmarks
        .map((benchmark) => ({
            benchmark,
            excel: excelById.get(Number(benchmark.workbenchId)),
            normalizedTitle: normalizeTitle(benchmark.benchmarkTitle),
        }))
        .filter((candidate): candidate is { benchmark: CISBenchmark; excel: CISExcelFile; normalizedTitle: string } =>
            Boolean(candidate.excel)
        )
        .filter(({ benchmark, excel, normalizedTitle }) => {
            const titleText = `${benchmark.benchmarkTitle} ${excel.excelTitle} ${excel.excelFileName}`;
            const isStig = /\bSTIG\b/i.test(titleText);
            if (kind === "benchmark" && EXCLUDED_TITLE_PATTERNS.some((pattern) => pattern.test(titleText))) return false;
            if (kind === "stig" && (!isStig || EXCLUDED_STIG_TITLE_PATTERNS.some((pattern) => pattern.test(titleText)))) return false;
            return normalizedTitle.includes(normalizedTechnology) || normalizedTechnology.includes(normalizedTitle);
        });

    candidates.sort((a, b) => {
        const acceptedScore =
            Number((b.benchmark.benchmarkStatus?.status || "").toLowerCase() === "accepted") -
            Number((a.benchmark.benchmarkStatus?.status || "").toLowerCase() === "accepted");
        if (acceptedScore !== 0) return acceptedScore;

        const versionDiff = compareVersions(b.benchmark.benchmarkVersion, a.benchmark.benchmarkVersion);
        if (versionDiff !== 0) return versionDiff;

        return (
            parseCISDate(b.benchmark.benchmarkStatus?.statusDate).getTime() -
            parseCISDate(a.benchmark.benchmarkStatus?.statusDate).getTime()
        );
    });

    const selected = candidates[0];
    return selected ? { benchmark: selected.benchmark, excel: selected.excel } : null;
}

export function saveCISBenchmarkSnapshot(
    benchmark: CISBenchmark,
    excel: CISExcelFile,
    workbookBuffer: Buffer
): CISBenchmarkSnapshot {
    const hash = sha256(workbookBuffer);
    const fileName = safePathPart(excel.excelFileName || `cis-${benchmark.workbenchId}.xlsx`);
    const snapshotDir = path.join(runtimeDataDir("cis-benchmarks"), String(benchmark.workbenchId));
    const filePath = path.join(snapshotDir, fileName);
    const downloadedAt = new Date();

    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(filePath, workbookBuffer);

    const metadata: CISBenchmarkSnapshot = {
        workbenchId: Number(benchmark.workbenchId),
        benchmarkTitle: benchmark.benchmarkTitle,
        benchmarkVersion: benchmark.benchmarkVersion,
        releaseDate: parseCISDate(benchmark.benchmarkStatus?.statusDate),
        excelTitle: excel.excelTitle,
        excelFileName: excel.excelFileName,
        filePath: storedPathForRuntimeFile(filePath),
        sha256: hash,
        downloadedAt,
    };

    fs.writeFileSync(
        path.join(snapshotDir, `${fileName}.metadata.json`),
        JSON.stringify({
            ...metadata,
            downloadedAt: downloadedAt.toISOString(),
            releaseDate: metadata.releaseDate.toISOString(),
        }, null, 2),
        "utf-8"
    );

    return metadata;
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
