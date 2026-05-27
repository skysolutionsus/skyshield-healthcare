import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
    downloadBenchmarkExcel,
    fetchAllBenchmarkExcelFiles,
    fetchAllBenchmarks,
    getCISToken,
    type CISBenchmark,
    type CISExcelFile,
} from "@/lib/cis-api";
import {
    parseCISBenchmarkExcel,
    recommendationEvidenceSummary,
    saveCISBenchmarkSnapshot,
    selectApplicableSTIGProfiles,
    selectBestCISProfile,
    selectLatestBenchmarkForTechnology,
    selectLatestSTIGBenchmarkForTechnology,
    textSimilarity,
    normalizeRecommendation,
    type CISBenchmarkRecommendation,
    type CISBenchmarkSnapshot,
} from "@/lib/cis-benchmark-xlsx";
import { detectPub1075Version } from "@/lib/knowledge/ingest";
import { isAdminRole } from "@/lib/roles";
import { generateBifrostText, getConfiguredBifrostModel } from "@/lib/ai/bifrost";
import * as fs from "fs";
import * as path from "path";

const ALLOWED_UPDATE_FIELDS = new Set([
    "testProcedures",
    "expectedResults",
    "remediationProcedure",
    "description",
    "rationale",
    "impact",
    "sectionTitle",
    "findingStatement",
]);

type SCSEMControlEvidence = {
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

type DownloadedBenchmark = {
    benchmark: CISBenchmark;
    excel: CISExcelFile;
    snapshot: CISBenchmarkSnapshot;
    recommendations: CISBenchmarkRecommendation[];
};

function extractPub1075Sections(nistIds: Array<string | null | undefined>): {
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

function buildControlSummary(
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

function buildNewControlEvidence(recommendation: CISBenchmarkRecommendation, sourceLabel = "CIS"): string {
    return [
        `Potential new control from ${sourceLabel} ${recommendation.recommendation}`,
        recommendationEvidenceSummary(recommendation, sourceLabel),
    ].join("\n");
}

function buildComparisonCandidates(
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

function parseJsonResponse(text: string): any {
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("AI response did not contain a JSON object.");
    return JSON.parse(cleaned.slice(start, end + 1));
}

function validateChanges(rawChanges: any[], controls: SCSEMControlEvidence[]): any[] {
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

async function downloadAndParseBenchmark(
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

export async function POST(request: Request) {
    try {
        const authHeader = request.headers.get("authorization");
        const expectedSecret = process.env.CRON_SECRET || "demo-secret";
        const isCron = authHeader === `Bearer ${expectedSecret}`;

        let session;
        if (!isCron) {
            session = await auth();
            if (!session?.user) {
                return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
            }
            if (!isAdminRole((session.user as unknown as { role: string }).role)) {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
        }

        const orgId = session?.user
            ? (session.user as unknown as { organizationId: string }).organizationId
            : "system-cron";
        const userId = session?.user?.id || "system";

        let cisToken = "";
        try {
            cisToken = await getCISToken();
        } catch (error: any) {
            console.error("CIS Auth failed:", error.message);
            return NextResponse.json({ error: "CIS authentication failed" }, { status: 502 });
        }

        const [allBenchmarks, allExcelFiles] = await Promise.all([
            fetchAllBenchmarks(cisToken),
            fetchAllBenchmarkExcelFiles(cisToken),
        ]);

        const templates = await db.sCSEMTemplate.findMany({
            where: { cisTechnology: { not: null } },
        });

        if (templates.length === 0) {
            return NextResponse.json({ message: "No templates with CIS technology mapping.", count: 0 });
        }

        const downloadedBenchmarks = new Map<number, DownloadedBenchmark>();
        let updatesGenerated = 0;
        const syncResults: Array<Record<string, unknown>> = [];

        for (const template of templates) {
            const existingReview = await db.sCSEMUpdateReview.findFirst({
                where: { templateId: template.id, status: "PENDING" },
            });
            if (existingReview) {
                syncResults.push({ template: template.name, status: "skipped", reason: "pending review already exists" });
                continue;
            }

            const selected = selectLatestBenchmarkForTechnology(
                template.cisTechnology || "",
                allBenchmarks,
                allExcelFiles
            );
            const selectedStig = selectLatestSTIGBenchmarkForTechnology(
                template.cisTechnology || "",
                allBenchmarks,
                allExcelFiles
            );

            if (!selected) {
                syncResults.push({ template: template.name, status: "skipped", reason: "no matching CIS Excel benchmark" });
                continue;
            }

            const reviewVersion = `${selected.benchmark.benchmarkVersion}${selectedStig ? ` + STIG ${selectedStig.benchmark.benchmarkVersion}` : ""}`;

            if (template.lastCisBenchmarkVersion === reviewVersion) {
                syncResults.push({
                    template: template.name,
                    status: "skipped",
                    reason: `already reviewed CIS/STIG v${reviewVersion}`,
                });
                continue;
            }

            const controls = await db.sCSEMControl.findMany({
                where: { sheet: { templateId: template.id } },
                select: {
                    id: true,
                    testId: true,
                    nistId: true,
                    nistControlName: true,
                    testMethod: true,
                    sectionTitle: true,
                    description: true,
                    testProcedures: true,
                    expectedResults: true,
                    criticality: true,
                    cisBenchmarkRef: true,
                    recommendationNum: true,
                    rationale: true,
                    impact: true,
                    remediationProcedure: true,
                },
                orderBy: { rowIndex: "asc" },
            });

            if (controls.length === 0) {
                syncResults.push({ template: template.name, status: "skipped", reason: "no SCSEM controls loaded" });
                continue;
            }

            const downloaded = await downloadAndParseBenchmark(
                cisToken,
                selected.benchmark,
                selected.excel,
                downloadedBenchmarks
            );
            const selectedProfile = selectBestCISProfile(template.name, controls, downloaded.recommendations);

            if (!selectedProfile) {
                syncResults.push({ template: template.name, status: "skipped", reason: "no parseable CIS profile" });
                continue;
            }

            let stigDownloaded: DownloadedBenchmark | null = null;
            let selectedStigProfile: ReturnType<typeof selectBestCISProfile> = null;
            let stigUpdateCandidates: Array<{ control: SCSEMControlEvidence; recommendation: CISBenchmarkRecommendation; score: number }> = [];
            let stigNewControlCandidates: CISBenchmarkRecommendation[] = [];

            if (selectedStig) {
                stigDownloaded = await downloadAndParseBenchmark(
                    cisToken,
                    selectedStig.benchmark,
                    selectedStig.excel,
                    downloadedBenchmarks
                );
                selectedStigProfile = selectApplicableSTIGProfiles(template.name, controls, stigDownloaded.recommendations);

                if (selectedStigProfile) {
                    const stigCandidates = buildComparisonCandidates(
                        controls,
                        selectedStigProfile.recommendations
                    );
                    stigUpdateCandidates = stigCandidates.updateCandidates;
                    stigNewControlCandidates = stigCandidates.newControlCandidates;
                }
            }

            const { updateCandidates, newControlCandidates } = buildComparisonCandidates(
                controls,
                selectedProfile.recommendations
            );

            if (
                updateCandidates.length === 0 &&
                newControlCandidates.length === 0 &&
                stigUpdateCandidates.length === 0 &&
                stigNewControlCandidates.length === 0
            ) {
                syncResults.push({ template: template.name, status: "skipped", reason: "no CIS/STIG deltas detected" });
                continue;
            }

            const pub1075 = extractPub1075Sections([
                ...updateCandidates.map((candidate) => candidate.control.nistId),
                ...stigUpdateCandidates.map((candidate) => candidate.control.nistId),
            ]);
            const updateEvidence = updateCandidates
                .map((candidate) => buildControlSummary(candidate.control, candidate.recommendation, "CIS"))
                .join("\n\n---\n\n");
            const newControlEvidence = newControlCandidates
                .map((recommendation) => buildNewControlEvidence(recommendation, "CIS"))
                .join("\n\n---\n\n");
            const stigUpdateEvidence = stigUpdateCandidates
                .map((candidate) => buildControlSummary(candidate.control, candidate.recommendation, "STIG"))
                .join("\n\n---\n\n");
            const stigNewControlEvidence = stigNewControlCandidates
                .map((recommendation) => buildNewControlEvidence(recommendation, "STIG"))
                .join("\n\n---\n\n");
            const stigSourceSummary = stigDownloaded
                ? selectedStigProfile
                    ? [
                        `- Title: ${stigDownloaded.snapshot.benchmarkTitle}`,
                        `- Version: ${stigDownloaded.snapshot.benchmarkVersion}`,
                        `- Release date: ${stigDownloaded.snapshot.releaseDate.toISOString().slice(0, 10)}`,
                        `- Selected profile: ${selectedStigProfile.profile}`,
                        `- Excel snapshot path: ${stigDownloaded.snapshot.filePath}`,
                        `- Excel SHA-256: ${stigDownloaded.snapshot.sha256}`,
                        `- Matched existing recommendations: ${selectedStigProfile.sharedRecommendationCount}/${selectedStigProfile.totalRecommendationCount}`,
                    ].join("\n")
                    : `- STIG benchmark found (${stigDownloaded.snapshot.benchmarkTitle} v${stigDownloaded.snapshot.benchmarkVersion}), but no parseable matching profile was selected.`
                : "- No matching CIS SecureSuite STIG Excel benchmark was found for this SCSEM technology.";

            const prompt = `You are an IRS Safeguards SCSEM update analyst. Propose human-reviewable SCSEM changes using only the evidence below.

Decision policy:
- IRS Publication 1075 is the governing compliance floor.
- CIS Benchmark Excel rows are security-hardening evidence.
- STIG benchmark rows are security-hardening evidence and must be checked alongside CIS.
- If Pub 1075 is stricter than CIS or STIG, propose Pub 1075-aligned text.
- If CIS or STIG is stricter and does not conflict with Pub 1075, propose the stricter CIS/STIG-aligned text.
- If CIS and STIG differ, propose the stricter secure setting when clear; otherwise mark confidence "needs_review".
- If strictness is ambiguous, include the item only when it is clearly useful for human review and mark confidence "needs_review".
- Existing IRS SCSEM rows remain the base source of truth.
- You may propose new SCSEM controls when the CIS or STIG row is missing from the current SCSEM and appears security-relevant.

SCSEM:
- Name: ${template.name}
- Technology: ${template.cisTechnology}
- Current SCSEM version: ${template.version || "unknown"}
- Current tracked CIS version: ${template.lastCisBenchmarkVersion || "none"}

CIS Benchmark:
- Title: ${downloaded.snapshot.benchmarkTitle}
- Version: ${downloaded.snapshot.benchmarkVersion}
- Release date: ${downloaded.snapshot.releaseDate.toISOString().slice(0, 10)}
- Selected profile: ${selectedProfile.profile}
- Excel snapshot path: ${downloaded.snapshot.filePath}
- Excel SHA-256: ${downloaded.snapshot.sha256}
- Matched existing recommendations: ${selectedProfile.sharedRecommendationCount}/${selectedProfile.totalRecommendationCount}

STIG Benchmark:
${stigSourceSummary}

Publication 1075:
- Version: ${pub1075.version}
- Local source: ${pub1075.sourcePath}

CURRENT SCSEM ROWS MATCHED TO CIS CANDIDATES:
${updateEvidence || "None"}

POTENTIAL NEW CIS ROWS NOT PRESENT IN THE SCSEM:
${newControlEvidence || "None"}

CURRENT SCSEM ROWS MATCHED TO STIG CANDIDATES:
${stigUpdateEvidence || "None"}

POTENTIAL NEW STIG ROWS NOT PRESENT IN THE SCSEM:
${stigNewControlEvidence || "None"}

PUBLICATION 1075 EXCERPTS FOR REFERENCED NIST CONTROLS:
${pub1075.excerpts || "No direct Pub 1075 excerpts were found for the candidate NIST controls."}

Return ONLY valid JSON:
{
  "summary": "2-3 sentence evidence-based summary of why this SCSEM needs review.",
  "changes": [
    {
      "action": "updateField",
      "testId": "exact existing SCSEM Test ID",
      "field": "testProcedures|expectedResults|remediationProcedure|description|rationale|impact|sectionTitle|findingStatement",
      "currentValue": "brief current value summary",
      "proposedValue": "complete replacement text for that field",
      "reason": "specific reason citing CIS recommendation number and Pub 1075 section when available",
      "confidence": "high|medium|needs_review",
      "sourceEvidence": {
        "cisRecommendation": "CIS recommendation number if CIS evidence applies, otherwise null",
        "cisProfile": "${selectedProfile.profile}",
        "stigRecommendation": "STIG recommendation number if STIG evidence applies, otherwise null",
        "stigProfile": "${selectedStigProfile?.profile || ""}",
        "pub1075Version": "${pub1075.version}"
      }
    },
    {
      "action": "addControl",
      "testId": "NEW-CIS-or-STIG-<recommendation>",
      "field": "newControl",
      "currentValue": "Not present in current SCSEM",
      "proposedValue": "short summary of the new control",
      "reason": "why a new control should be reviewed",
      "confidence": "high|medium|needs_review",
      "newControl": {
        "nistId": null,
        "nistControlName": "best fit if obvious, otherwise null",
        "testMethod": "Automated|Manual|Interview|Examine|Test",
        "sectionTitle": "CIS recommendation title",
        "description": "SCSEM-ready description",
        "testProcedures": "SCSEM-ready audit/test procedure",
        "expectedResults": "SCSEM-ready expected result",
        "criticality": "Critical|Significant|Moderate|Limited|Informational",
        "cisBenchmarkRef": "CIS section number",
        "recommendationNum": "CIS recommendation number",
        "rationale": "SCSEM-ready rationale",
        "impact": "SCSEM-ready impact",
        "remediationProcedure": "SCSEM-ready remediation"
      },
      "sourceEvidence": {
        "cisRecommendation": "CIS recommendation number if CIS evidence applies, otherwise null",
        "cisProfile": "${selectedProfile.profile}",
        "stigRecommendation": "STIG recommendation number if STIG evidence applies, otherwise null",
        "stigProfile": "${selectedStigProfile?.profile || ""}",
        "pub1075Version": "${pub1075.version}"
      }
    }
  ]
}

Rules:
- Include 3-8 total changes.
- For updateField, only use Test IDs from CURRENT SCSEM ROWS MATCHED TO CIS CANDIDATES or CURRENT SCSEM ROWS MATCHED TO STIG CANDIDATES.
- For addControl, only use recommendation numbers from POTENTIAL NEW CIS ROWS or POTENTIAL NEW STIG ROWS.
- Do not claim Pub 1075 says something unless the excerpt is present above.
- Do not include markdown fences.`;

            const responseText = await generateBifrostText({
                model: getConfiguredBifrostModel("BIFROST_SCSEM_MODEL"),
                maxTokens: 5000,
                temperature: 0.15,
                system: "You generate precise JSON SCSEM update recommendations grounded in provided CIS and IRS Pub 1075 evidence.",
                prompt,
            });

            let payload;
            try {
                payload = parseJsonResponse(responseText);
            } catch (error) {
                console.error(`  ${template.name}: failed to parse AI response.`, error);
                syncResults.push({ template: template.name, status: "skipped", reason: "AI response did not parse" });
                continue;
            }

            const validChanges = validateChanges(payload.changes || [], controls);
            if (validChanges.length === 0) {
                syncResults.push({ template: template.name, status: "skipped", reason: "no valid AI changes" });
                continue;
            }

            const benchmark = await db.cISBenchmarkVersion.create({
                data: {
                    technology: template.cisTechnology || "Unknown",
                    currentVersion: reviewVersion,
                    releaseDate: stigDownloaded
                        ? new Date(Math.max(downloaded.snapshot.releaseDate.getTime(), stigDownloaded.snapshot.releaseDate.getTime()))
                        : downloaded.snapshot.releaseDate,
                    changesSummary: payload.summary || `CIS/STIG ${template.cisTechnology} review generated for ${reviewVersion}`,
                    workbenchId: downloaded.snapshot.workbenchId,
                    benchmarkTitle: downloaded.snapshot.benchmarkTitle,
                    benchmarkFileName: downloaded.snapshot.excelFileName,
                    benchmarkFilePath: downloaded.snapshot.filePath,
                    benchmarkSha256: downloaded.snapshot.sha256,
                    downloadedAt: downloaded.snapshot.downloadedAt,
                    sourceUrl: `https://workbench.cisecurity.org/api/vendor/v1/excel/${downloaded.snapshot.workbenchId}`,
                    metadata: {
                        excelTitle: downloaded.snapshot.excelTitle,
                        selectedProfile: selectedProfile.profile,
                        selectedProfileRecommendationCount: selectedProfile.totalRecommendationCount,
                        sharedRecommendationCount: selectedProfile.sharedRecommendationCount,
                        pub1075Version: pub1075.version,
                        pub1075SourcePath: pub1075.sourcePath,
                        stig: stigDownloaded ? {
                            workbenchId: stigDownloaded.snapshot.workbenchId,
                            benchmarkTitle: stigDownloaded.snapshot.benchmarkTitle,
                            benchmarkVersion: stigDownloaded.snapshot.benchmarkVersion,
                            releaseDate: stigDownloaded.snapshot.releaseDate.toISOString(),
                            excelTitle: stigDownloaded.snapshot.excelTitle,
                            excelFileName: stigDownloaded.snapshot.excelFileName,
                            filePath: stigDownloaded.snapshot.filePath,
                            sha256: stigDownloaded.snapshot.sha256,
                            downloadedAt: stigDownloaded.snapshot.downloadedAt.toISOString(),
                            selectedProfile: selectedStigProfile?.profile || null,
                            selectedProfileRecommendationCount: selectedStigProfile?.totalRecommendationCount || 0,
                            sharedRecommendationCount: selectedStigProfile?.sharedRecommendationCount || 0,
                        } : null,
                    },
                },
            });

            const review = await db.sCSEMUpdateReview.create({
                data: {
                    templateId: template.id,
                    benchmarkId: benchmark.id,
                    source: "cis",
                    status: "PENDING",
                    suggestedChanges: validChanges,
                },
            });

            await db.auditLog.create({
                data: {
                    organizationId: orgId,
                    userId,
                    action: "CIS/STIG Benchmark Excel Sync",
                    resourceType: "SCSEMUpdateReview",
                    resourceId: review.id,
                    metadata: {
                        templateName: template.name,
                        technology: benchmark.technology,
                        version: benchmark.currentVersion,
                        previousVersion: template.lastCisBenchmarkVersion,
                        changesCount: validChanges.length,
                        workbenchId: benchmark.workbenchId,
                        benchmarkFilePath: benchmark.benchmarkFilePath,
                        benchmarkSha256: benchmark.benchmarkSha256,
                        selectedProfile: selectedProfile.profile,
                        stigVersion: stigDownloaded?.snapshot.benchmarkVersion || null,
                        stigWorkbenchId: stigDownloaded?.snapshot.workbenchId || null,
                        stigBenchmarkFilePath: stigDownloaded?.snapshot.filePath || null,
                        stigBenchmarkSha256: stigDownloaded?.snapshot.sha256 || null,
                        selectedStigProfile: selectedStigProfile?.profile || null,
                        pub1075Version: pub1075.version,
                    },
                },
            });

            updatesGenerated++;
            syncResults.push({
                template: template.name,
                status: "review_created",
                cisVersion: benchmark.currentVersion,
                workbenchId: benchmark.workbenchId,
                stigVersion: stigDownloaded?.snapshot.benchmarkVersion || null,
                stigWorkbenchId: stigDownloaded?.snapshot.workbenchId || null,
                changesCount: validChanges.length,
                selectedProfile: selectedProfile.profile,
                selectedStigProfile: selectedStigProfile?.profile || null,
                snapshot: benchmark.benchmarkFilePath,
            });
        }

        return NextResponse.json({
            success: true,
            message: `Generated ${updatesGenerated} CIS/STIG benchmark review(s) from downloaded Excel evidence.`,
            count: updatesGenerated,
            results: syncResults,
        });
    } catch (error: any) {
        console.error("CIS Sync error:", error);
        return NextResponse.json({
            error: `Failed to sync CIS benchmarks: ${error.message || "Unknown Error"}`,
        }, { status: 500 });
    }
}
