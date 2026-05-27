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
    testId: string;
    nistId: string | null;
    nistControlName: string | null;
    testMethod: string | null;
    sectionTitle: string | null;
    description: string | null;
    testProcedures: string | null;
    expectedResults: string | null;
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

export function buildComparisonCandidates(
    controls: SCSEMControlEvidence[],
    recommendations: CISBenchmarkRecommendation[]
): {
    updateCandidates: Array<{ control: SCSEMControlEvidence; recommendation: CISBenchmarkRecommendation; score: number }>;
    newControlCandidates: CISBenchmarkRecommendation[];
} {
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

            const descriptionDiff = 1 - textSimilarity(control.description, recommendation.description);
            const auditDiff = 1 - textSimilarity(control.testProcedures, recommendation.audit);
            const remediationDiff = 1 - textSimilarity(control.remediationProcedure, recommendation.remediation);
            const expectedDiff = 1 - textSimilarity(control.expectedResults, recommendation.defaultValue || recommendation.audit);
            const score = Math.max(descriptionDiff, auditDiff, remediationDiff, expectedDiff);

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
        updateCandidates: updateCandidates.slice(0, 10),
        newControlCandidates: newControlCandidates.slice(0, 10),
    };
}

export function parseJsonResponse(text: string): any {
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("AI response did not contain a JSON object.");
    return JSON.parse(cleaned.slice(start, end + 1));
}

export function validateChanges(rawChanges: any[], controls: SCSEMControlEvidence[]): any[] {
    const existingTestIds = new Set(controls.map((control) => control.testId));

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

            return existingTestIds.has(change.testId) &&
                ALLOWED_UPDATE_FIELDS.has(change.field) &&
                typeof change.proposedValue === "string" &&
                change.proposedValue.trim().length > 0;
        })
        .slice(0, 8);
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
