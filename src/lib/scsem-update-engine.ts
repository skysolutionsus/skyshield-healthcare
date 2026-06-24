import * as fs from "fs";
import * as path from "path";
import {
    downloadBenchmarkExcel,
    type CISBenchmark,
    type CISExcelFile,
} from "@/lib/cis-api";
import {
    normalizeRecommendation,
    parseCISBenchmarkExcel,
    recommendationEvidenceSummary,
    saveCISBenchmarkSnapshot,
    textSimilarity,
    type CISBenchmarkRecommendation,
    type CISBenchmarkSnapshot,
} from "@/lib/cis-benchmark-xlsx";
import { detectPub1075Version } from "@/lib/knowledge/ingest";

export const ALLOWED_UPDATE_FIELDS = new Set([
    "testProcedures",
    "expectedResults",
    "remediationProcedure",
    "description",
    "rationale",
    "impact",
    "sectionTitle",
    "findingStatement",
]);

export type SCSEMControlEvidence = {
    id: string;
    sourceSheet?: string;
    testId: string;
    nistId: string | null;
    nistControlName: string | null;
    testMethod: string | null;
    sectionTitle: string | null;
    description: string | null;
    testProcedures: string | null;
    expectedResults: string | null;
    findingStatement?: string | null;
    criticality: string | null;
    cisBenchmarkRef: string | null;
    recommendationNum: string | null;
    rationale: string | null;
    impact: string | null;
    remediationProcedure: string | null;
};

export type DownloadedBenchmark = {
    benchmark: CISBenchmark;
    excel: CISExcelFile;
    snapshot: CISBenchmarkSnapshot;
    recommendations: CISBenchmarkRecommendation[];
};

export function extractPub1075Sections(nistIds: Array<string | null | undefined>): {
    version: string;
    sourcePath: string;
    excerpts: string;
} {
    const pub1075Path = path.join(process.cwd(), "data", "pub1075", "p1075-full-text.md");
    if (!fs.existsSync(pub1075Path)) {
        return {
            version: "Unknown",
            sourcePath: "data/pub1075/p1075-full-text.md",
            excerpts: "",
        };
    }

    const fullText = fs.readFileSync(pub1075Path, "utf8");
    const version = detectPub1075Version(fullText);
    const lines = fullText.split("\n");
    const controlPrefixes = new Set<string>();

    for (const nistId of nistIds) {
        const match = (nistId || "").match(/^([A-Z]{2}-\d+)/);
        if (match) controlPrefixes.add(match[1]);
    }

    if (controlPrefixes.size === 0) {
        return {
            version,
            sourcePath: "data/pub1075/p1075-full-text.md",
            excerpts: "",
        };
    }

    const sections: string[] = [];
    let currentSection = "";
    let capturing = false;
    let totalChars = 0;
    const maxCharsPerSection = 2200;
    const maxTotalChars = 14000;

    for (const line of lines) {
        if (totalChars >= maxTotalChars) break;

        const sectionMatch = line.match(/^([A-Z]{2}-\d+)[\s:]/);
        if (sectionMatch) {
            if (capturing && currentSection.length > 0) {
                sections.push(currentSection.trim());
                totalChars += currentSection.length;
            }

            capturing = controlPrefixes.has(sectionMatch[1]);
            currentSection = capturing ? `${line}\n` : "";
            continue;
        }

        if (capturing && currentSection.length < maxCharsPerSection) {
            currentSection += `${line}\n`;
        }
    }

    if (capturing && currentSection.length > 0 && totalChars < maxTotalChars) {
        sections.push(currentSection.trim());
    }

    return {
        version,
        sourcePath: "data/pub1075/p1075-full-text.md",
        excerpts: sections.join("\n\n---\n\n"),
    };
}

export function buildControlSummary(
    control: SCSEMControlEvidence,
    recommendation: CISBenchmarkRecommendation,
    sourceLabel = "CIS"
): string {
    return [
        `SCSEM Test ID: ${control.testId}`,
        `NIST: ${control.nistId || "N/A"} | Control: ${control.nistControlName || "N/A"} | Criticality: ${control.criticality || "N/A"}`,
        `SCSEM CIS Ref: ${control.cisBenchmarkRef || "N/A"} | Recommendation: ${control.recommendationNum || "N/A"}`,
        `Current description: ${(control.description || "").slice(0, 700)}`,
        `Current test procedure: ${(control.testProcedures || "").slice(0, 700)}`,
        `Current expected result: ${(control.expectedResults || "").slice(0, 700)}`,
        control.remediationProcedure ? `Current remediation: ${control.remediationProcedure.slice(0, 500)}` : null,
        "",
        recommendationEvidenceSummary(recommendation, sourceLabel),
    ].filter(Boolean).join("\n");
}

export function buildNewControlEvidence(recommendation: CISBenchmarkRecommendation, sourceLabel = "CIS"): string {
    return [
        `Potential new control from ${sourceLabel} ${recommendation.recommendation}`,
        recommendationEvidenceSummary(recommendation, sourceLabel),
    ].join("\n");
}

function normalizeMaterialText(value: string | null | undefined): string {
    return (value || "")
        .toLowerCase()
        .replace(/\r\n/g, "\n")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function materialTokenSimilarity(left: string, right: string): number {
    const leftTokens = new Set(left.split(/\s+/).filter((token) => token.length > 1));
    const rightTokens = new Set(right.split(/\s+/).filter((token) => token.length > 1));
    if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

    let intersection = 0;
    for (const token of leftTokens) {
        if (rightTokens.has(token)) intersection++;
    }

    return intersection / (leftTokens.size + rightTokens.size - intersection);
}

export function isMaterialTextDelta(
    currentValue: string | null | undefined,
    proposedValue: string | null | undefined
): boolean {
    const current = (currentValue || "").trim();
    const proposed = (proposedValue || "").trim();
    if (!proposed) return false;
    if (!current) return proposed.length >= 12;

    const normalizedCurrent = normalizeMaterialText(current);
    const normalizedProposed = normalizeMaterialText(proposed);
    if (!normalizedCurrent) return normalizedProposed.length >= 12;
    if (!normalizedProposed || normalizedCurrent === normalizedProposed) return false;

    const similarity = textSimilarity(normalizedCurrent, normalizedProposed);
    const tokenSimilarity = materialTokenSimilarity(normalizedCurrent, normalizedProposed);
    const lengthRatio = normalizedProposed.length / Math.max(normalizedCurrent.length, 1);
    const containsExisting = normalizedProposed.includes(normalizedCurrent) || normalizedCurrent.includes(normalizedProposed);

    if (tokenSimilarity >= 0.92 && lengthRatio >= 0.7 && lengthRatio <= 1.45) return false;
    if (similarity >= 0.92 && lengthRatio >= 0.75 && lengthRatio <= 1.35) return false;
    if (containsExisting && similarity >= 0.84 && lengthRatio >= 0.8 && lengthRatio <= 1.45) return false;

    return (similarity < 0.84 && tokenSimilarity < 0.86) || lengthRatio < 0.7 || lengthRatio > 1.45;
}

function materialFieldScore(currentValue: string | null | undefined, proposedValue: string | null | undefined): number {
    if (!isMaterialTextDelta(currentValue, proposedValue)) return 0;
    return 1 - textSimilarity(currentValue, proposedValue);
}

export function isUsableBenchmarkDefaultValue(value: string | null | undefined): boolean {
    const normalized = normalizeMaterialText(value);
    if (!normalized) return false;

    return !new Set([
        "n a",
        "na",
        "none",
        "not applicable",
        "not configured",
        "not installed",
        "not set",
        "varies",
        "varies by environment",
    ]).has(normalized);
}

export function buildComparisonCandidates(
    controls: SCSEMControlEvidence[],
    recommendations: CISBenchmarkRecommendation[],
    options: {
        maxUpdateCandidates?: number;
        maxNewControlCandidates?: number;
    } = {}
): {
    updateCandidates: Array<{ control: SCSEMControlEvidence; recommendation: CISBenchmarkRecommendation; score: number }>;
    newControlCandidates: CISBenchmarkRecommendation[];
} {
    const maxUpdateCandidates = options.maxUpdateCandidates ?? 10;
    const maxNewControlCandidates = options.maxNewControlCandidates ?? 10;
    const recById = new Map(recommendations.map((rec) => [rec.recommendation, rec]));
    const scsemRecommendationIds = new Set(
        controls
            .map((control) => normalizeRecommendation(control.recommendationNum))
            .filter(Boolean) as string[]
    );

    const updateCandidates = controls
        .map((control) => {
            const recommendationNum = normalizeRecommendation(control.recommendationNum);
            const recommendation = recommendationNum ? recById.get(recommendationNum) : null;
            if (!recommendation) return null;

            const descriptionDiff = materialFieldScore(control.description, recommendation.description);
            const auditDiff = materialFieldScore(control.testProcedures, recommendation.audit);
            const remediationDiff = materialFieldScore(control.remediationProcedure, recommendation.remediation);
            const expectedDiff = isUsableBenchmarkDefaultValue(recommendation.defaultValue)
                ? materialFieldScore(control.expectedResults, recommendation.defaultValue)
                : 0;
            const score = Math.max(descriptionDiff, auditDiff, remediationDiff, expectedDiff);
            if (score <= 0) return null;

            return { control, recommendation, score };
        })
        .filter(Boolean) as Array<{ control: SCSEMControlEvidence; recommendation: CISBenchmarkRecommendation; score: number }>;

    updateCandidates.sort((a, b) => b.score - a.score);

    const newControlCandidates = recommendations
        .filter((recommendation) => !scsemRecommendationIds.has(recommendation.recommendation))
        .filter((recommendation) => recommendation.title && recommendation.description)
        .sort((a, b) => {
            const automatedDiff =
                Number((b.assessmentStatus || "").toLowerCase() === "automated") -
                Number((a.assessmentStatus || "").toLowerCase() === "automated");
            if (automatedDiff !== 0) return automatedDiff;
            return a.recommendation.localeCompare(b.recommendation, undefined, { numeric: true });
        });

    return {
        updateCandidates: updateCandidates.slice(0, maxUpdateCandidates),
        newControlCandidates: newControlCandidates.slice(0, maxNewControlCandidates),
    };
}

export function parseJsonResponse(text: string): any {
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const jsonObject = extractBalancedJsonObject(cleaned);
    const candidates = [
        jsonObject,
        repairCommonJsonIssues(jsonObject),
    ];

    let lastError: unknown = null;
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError instanceof Error
        ? new Error(`AI response did not contain valid JSON: ${lastError.message}`)
        : new Error("AI response did not contain valid JSON.");
}

function extractBalancedJsonObject(text: string): string {
    const start = text.indexOf("{");
    if (start === -1) throw new Error("AI response did not contain a JSON object.");

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index++) {
        const char = text[index];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"") {
            inString = true;
            continue;
        }

        if (char === "{") depth++;
        if (char === "}") depth--;
        if (depth === 0) return text.slice(start, index + 1);
    }

    return text.slice(start);
}

function repairCommonJsonIssues(jsonText: string): string {
    let repaired = jsonText
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
        .replace(/[“”]/g, "\"")
        .replace(/[‘’]/g, "'");

    repaired = insertMissingCommasBetweenObjects(repaired);
    repaired = repaired.replace(/,\s*([}\]])/g, "$1");
    return repaired;
}

function insertMissingCommasBetweenObjects(jsonText: string): string {
    let repaired = "";
    let inString = false;
    let escaped = false;

    for (let index = 0; index < jsonText.length; index++) {
        const char = jsonText[index];
        repaired += char;

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"") {
            inString = true;
            continue;
        }

        if (char !== "}") continue;

        let nextIndex = index + 1;
        while (/\s/.test(jsonText[nextIndex] || "")) nextIndex++;
        if (jsonText[nextIndex] === "{") {
            repaired += ",";
        }
    }

    return repaired;
}

export function validateChanges(rawChanges: any[], controls: SCSEMControlEvidence[], maxChanges = 8): any[] {
    const existingTestIds = new Set(controls.map((control) => control.testId));
    const controlByTestId = new Map(controls.map((control) => [control.testId, control]));

    return rawChanges
        .filter((change) => change && typeof change === "object")
        .map((change) => ({
            action: change.action === "addControl" ? "addControl" : "updateField",
            ...change,
        }))
        .filter((change) => {
            if (change.action === "addControl") {
                return Boolean(change.newControl?.recommendationNum && change.newControl?.description);
            }

            const control = controlByTestId.get(change.testId);
            const currentValue = control ? String((control as any)[change.field] || "") : "";

            return existingTestIds.has(change.testId) &&
                ALLOWED_UPDATE_FIELDS.has(change.field) &&
                typeof change.proposedValue === "string" &&
                isMaterialTextDelta(currentValue, change.proposedValue);
        })
        .slice(0, maxChanges);
}

export async function downloadAndParseBenchmark(
    token: string,
    benchmark: CISBenchmark,
    excel: CISExcelFile,
    cache: Map<number, DownloadedBenchmark>
): Promise<DownloadedBenchmark> {
    const workbenchId = Number(benchmark.workbenchId);
    const cached = cache.get(workbenchId);
    if (cached) return cached;

    const workbookBuffer = await downloadBenchmarkExcel(token, workbenchId);
    const snapshot = saveCISBenchmarkSnapshot(benchmark, excel, workbookBuffer);
    const recommendations = parseCISBenchmarkExcel(workbookBuffer);
    const downloaded = { benchmark, excel, snapshot, recommendations };
    cache.set(workbenchId, downloaded);
    return downloaded;
}
