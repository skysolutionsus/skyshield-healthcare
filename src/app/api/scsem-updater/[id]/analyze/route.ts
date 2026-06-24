import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditRequestContext, logAudit, truncateAuditText } from "@/lib/audit";
import {
    fetchAllBenchmarkExcelFiles,
    fetchAllBenchmarks,
    getCISToken,
} from "@/lib/cis-api";
import {
    type CISBenchmarkRecommendation,
    type SelectedCISProfile,
} from "@/lib/cis-benchmark-xlsx";
import {
    resolveSCSEMBenchmarkSources,
    type ResolvedBenchmarkKind,
    type ResolvedBenchmarkSource,
} from "@/lib/scsem-benchmark-resolver";
import {
    addIdsToChanges,
    readSCSEMUpdaterSessionForUser,
    resolveUpdaterPath,
    writeSCSEMUpdaterSession,
    type SCSEMUpdaterAuditSource,
} from "@/lib/scsem-updater-store";
import { parseSCSEMFile, type ParsedSCSEM } from "@/lib/xlsx-parser";
import {
    buildComparisonCandidates,
    buildControlSummary,
    buildNewControlEvidence,
    extractPub1075Sections,
    parseJsonResponse,
    validateChanges,
    type DownloadedBenchmark,
    type SCSEMControlEvidence,
} from "@/lib/scsem-update-engine";
import { generateBifrostText, getConfiguredBifrostModel } from "@/lib/ai/bifrost";

export const runtime = "nodejs";

const UPDATER_CANDIDATE_LIMITS = {
    maxUpdateCandidates: 25,
    maxNewControlCandidates: 15,
};
const MAX_UPDATER_CHANGES = 25;
const AI_CONTROL_LIMIT = Number(process.env.SCSEM_UPDATER_AI_CONTROL_LIMIT || 500);
const AI_PROMPT_CHAR_LIMIT = Number(process.env.SCSEM_UPDATER_AI_PROMPT_CHAR_LIMIT || 90000);
const AI_TIMEOUT_MS = Number(process.env.SCSEM_UPDATER_AI_TIMEOUT_MS || 25000);

function changePreview(changes: any[]) {
    return changes.slice(0, 25).map((change) => ({
        id: change.id,
        action: change.action,
        testId: change.testId,
        field: change.field,
        status: change.status,
        confidence: change.confidence,
        currentValue: truncateAuditText(change.currentValue, 1200),
        proposedValue: truncateAuditText(change.proposedValue, 2400),
        reason: truncateAuditText(change.reason, 1600),
        sourceEvidence: change.sourceEvidence || null,
    }));
}

function controlsFromParsedSCSEM(parsed: ParsedSCSEM): SCSEMControlEvidence[] {
    return parsed.sheets
        .filter((sheet) => sheet.sheetType === "test_cases")
        .flatMap((sheet) => sheet.controls.map((control) => ({
            id: `${sheet.sheetName}:${control.rowIndex}`,
            sourceSheet: sheet.sheetName,
            testId: control.testId,
            nistId: control.nistId,
            nistControlName: control.nistControlName,
            testMethod: control.testMethod,
            sectionTitle: control.sectionTitle,
            description: control.description,
            testProcedures: control.testProcedures,
            expectedResults: control.expectedResults,
            criticality: control.criticality,
            cisBenchmarkRef: control.cisBenchmarkRef,
            recommendationNum: control.recommendationNum,
            rationale: control.rationale,
            impact: control.impact,
            remediationProcedure: control.remediationProcedure,
        })));
}

function auditSource(
    downloaded: DownloadedBenchmark,
    selectedProfile: SelectedCISProfile | null | undefined,
    context?: {
        sourceKind?: ResolvedBenchmarkKind;
        matchedSheets?: string[];
        matchQuery?: string;
    }
): SCSEMUpdaterAuditSource {
    return {
        sourceKind: context?.sourceKind,
        workbenchId: downloaded.snapshot.workbenchId,
        benchmarkTitle: downloaded.snapshot.benchmarkTitle,
        benchmarkVersion: downloaded.snapshot.benchmarkVersion,
        releaseDate: downloaded.snapshot.releaseDate.toISOString(),
        excelTitle: downloaded.snapshot.excelTitle,
        excelFileName: downloaded.snapshot.excelFileName,
        filePath: downloaded.snapshot.filePath,
        sha256: downloaded.snapshot.sha256,
        downloadedAt: downloaded.snapshot.downloadedAt.toISOString(),
        selectedProfile: selectedProfile?.profile || null,
        selectedProfileRecommendationCount: selectedProfile?.totalRecommendationCount || 0,
        sharedRecommendationCount: selectedProfile?.sharedRecommendationCount || 0,
        matchedSheets: context?.matchedSheets,
        matchQuery: context?.matchQuery,
        sourceUrl: `https://workbench.cisecurity.org/api/vendor/v1/excel/${downloaded.snapshot.workbenchId}`,
    };
}

type AnalysisUpdateCandidate = {
    sourceKind: ResolvedBenchmarkKind;
    sourceLabel: string;
    sourceProfile: string;
    sourceWorkbenchId: number;
    sourceBenchmarkTitle: string;
    control: SCSEMControlEvidence;
    recommendation: CISBenchmarkRecommendation;
    score: number;
};

type AnalysisNewCandidate = {
    sourceKind: ResolvedBenchmarkKind;
    sourceLabel: string;
    sourceProfile: string;
    sourceWorkbenchId: number;
    sourceBenchmarkTitle: string;
    recommendation: CISBenchmarkRecommendation;
};

function sourceLabel(source: ResolvedBenchmarkSource): string {
    return `${source.kind} WB ${source.downloaded.snapshot.workbenchId} ${source.downloaded.snapshot.benchmarkTitle} (${source.selectedProfile.profile})`;
}

function sourceEvidence(candidate: Pick<AnalysisUpdateCandidate | AnalysisNewCandidate,
    "sourceKind" | "sourceProfile" | "sourceWorkbenchId" | "sourceBenchmarkTitle" | "recommendation">, pub1075Version: string) {
    return {
        cisRecommendation: candidate.sourceKind === "CIS" ? candidate.recommendation.recommendation : null,
        cisProfile: candidate.sourceKind === "CIS" ? candidate.sourceProfile : null,
        stigRecommendation: candidate.sourceKind === "STIG" ? candidate.recommendation.recommendation : null,
        stigProfile: candidate.sourceKind === "STIG" ? candidate.sourceProfile : null,
        sourceWorkbenchId: candidate.sourceWorkbenchId,
        sourceBenchmarkTitle: candidate.sourceBenchmarkTitle,
        pub1075Version,
    };
}

function safeRecommendationId(value: string): string {
    return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function chooseFallbackField(
    control: SCSEMControlEvidence,
    recommendation: CISBenchmarkRecommendation
): { field: string; currentValue: string; proposedValue: string } | null {
    const choices = [
        { field: "testProcedures", currentValue: control.testProcedures || "", proposedValue: recommendation.audit || "" },
        { field: "remediationProcedure", currentValue: control.remediationProcedure || "", proposedValue: recommendation.remediation || "" },
        { field: "description", currentValue: control.description || "", proposedValue: recommendation.description || "" },
        { field: "rationale", currentValue: control.rationale || "", proposedValue: recommendation.rationale || "" },
        { field: "impact", currentValue: control.impact || "", proposedValue: recommendation.impact || "" },
    ];

    return choices.find((choice) => choice.proposedValue.trim().length > 0 &&
        choice.proposedValue.trim() !== choice.currentValue.trim()) || null;
}

function buildFallbackPayload({
    technology,
    pub1075,
    fallbackReason,
    updateCandidates,
    newControlCandidates,
}: {
    technology: string;
    pub1075: { version: string };
    fallbackReason?: string;
    updateCandidates: AnalysisUpdateCandidate[];
    newControlCandidates: AnalysisNewCandidate[];
}) {
    const fallbackUpdates = [...updateCandidates].sort((a, b) => b.score - a.score);
    const fallbackNewControls = [...newControlCandidates];

    const changes: any[] = [];

    for (const candidate of fallbackUpdates) {
        if (changes.length >= 15) break;
        const selectedField = chooseFallbackField(candidate.control, candidate.recommendation);
        if (!selectedField) continue;

        changes.push({
            action: "updateField",
            testId: candidate.control.testId,
            field: selectedField.field,
            currentValue: selectedField.currentValue.slice(0, 1200),
            proposedValue: selectedField.proposedValue,
            reason: `${candidate.sourceKind} ${candidate.recommendation.recommendation} (${candidate.sourceProfile}, WB ${candidate.sourceWorkbenchId}) differs from the uploaded SCSEM row. ${pub1075.version} remains the compliance floor; this fallback proposal should be reviewed for the stricter CIS/STIG/Pub 1075 wording before approval.`,
            confidence: "needs_review",
            sourceEvidence: sourceEvidence(candidate, pub1075.version),
        });
    }

    for (const candidate of fallbackNewControls) {
        if (changes.length >= MAX_UPDATER_CHANGES) break;
        const recommendation = candidate.recommendation;
        changes.push({
            action: "addControl",
            testId: `NEW-${candidate.sourceKind}-${candidate.sourceWorkbenchId}-${safeRecommendationId(recommendation.recommendation)}`,
            field: "newControl",
            currentValue: "Not present in current SCSEM",
            proposedValue: `${candidate.sourceKind} ${recommendation.recommendation}: ${recommendation.title}`,
            reason: `${candidate.sourceKind} ${recommendation.recommendation} appears in ${candidate.sourceBenchmarkTitle} (${candidate.sourceProfile}, WB ${candidate.sourceWorkbenchId}) but was not mapped in the uploaded SCSEM. ${pub1075.version} should be checked before approval.`,
            confidence: "needs_review",
            newControl: {
                nistId: null,
                nistControlName: null,
                testMethod: recommendation.assessmentStatus || "Manual",
                sectionTitle: recommendation.title,
                description: recommendation.description,
                testProcedures: recommendation.audit,
                expectedResults: recommendation.defaultValue || recommendation.audit,
                criticality: "Moderate",
                cisBenchmarkRef: recommendation.section,
                recommendationNum: recommendation.recommendation,
                rationale: recommendation.rationale,
                impact: recommendation.impact,
                remediationProcedure: recommendation.remediation,
            },
            sourceEvidence: sourceEvidence(candidate, pub1075.version),
        });
    }

    return {
        summary: `Generated deterministic review items for ${technology}${fallbackReason ? ` because ${fallbackReason}` : ""}. Each item is marked needs_review and is grounded directly in the selected CIS/STIG workbook evidence with ${pub1075.version} as the compliance floor.`,
        changes,
    };
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    let user: { id: string; organizationId: string } | null = null;

    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        user = session.user as unknown as { id: string; organizationId: string };

        const updaterSession = readSCSEMUpdaterSessionForUser(id, user);
        updaterSession.status = "analyzing";
        updaterSession.error = undefined;
        writeSCSEMUpdaterSession(updaterSession);

        const originalPath = resolveUpdaterPath(updaterSession.originalFilePath);
        const parsed = parseSCSEMFile(originalPath);
        const controls = controlsFromParsedSCSEM(parsed);
        if (controls.length === 0) {
            throw new Error("No SCSEM test case controls were found in the uploaded workbook.");
        }

        let cisToken = "";
        try {
            cisToken = await getCISToken();
        } catch (error: any) {
            throw new Error(`CIS authentication failed: ${error.message || "unknown error"}`);
        }

        const [allBenchmarks, allExcelFiles] = await Promise.all([
            fetchAllBenchmarks(cisToken),
            fetchAllBenchmarkExcelFiles(cisToken),
        ]);

        const downloadedBenchmarks = new Map<number, DownloadedBenchmark>();
        const resolvedSources = await resolveSCSEMBenchmarkSources({
            token: cisToken,
            technology: updaterSession.inferredTechnology,
            parsed,
            benchmarks: allBenchmarks,
            excelFiles: allExcelFiles,
            downloadedBenchmarks,
        });

        const updateCandidates: AnalysisUpdateCandidate[] = [];
        const newControlCandidates: AnalysisNewCandidate[] = [];

        for (const source of resolvedSources) {
            const scopedControls = controls.filter((control) =>
                source.matchedSheets.includes(control.sourceSheet || "")
            );
            if (scopedControls.length === 0) continue;

            const candidates = buildComparisonCandidates(
                scopedControls,
                source.selectedProfile.recommendations,
                UPDATER_CANDIDATE_LIMITS
            );
            const label = sourceLabel(source);

            updateCandidates.push(...candidates.updateCandidates.map((candidate) => ({
                ...candidate,
                sourceKind: source.kind,
                sourceLabel: label,
                sourceProfile: source.selectedProfile.profile,
                sourceWorkbenchId: source.downloaded.snapshot.workbenchId,
                sourceBenchmarkTitle: source.downloaded.snapshot.benchmarkTitle,
            })));
            newControlCandidates.push(...candidates.newControlCandidates.map((recommendation) => ({
                recommendation,
                sourceKind: source.kind,
                sourceLabel: label,
                sourceProfile: source.selectedProfile.profile,
                sourceWorkbenchId: source.downloaded.snapshot.workbenchId,
                sourceBenchmarkTitle: source.downloaded.snapshot.benchmarkTitle,
            })));
        }

        updateCandidates.sort((a, b) => b.score - a.score);

        const candidateNistIds = [
            ...updateCandidates.map((candidate) => candidate.control.nistId),
        ];
        const pub1075 = extractPub1075Sections(
            candidateNistIds.length > 0
                ? candidateNistIds
                : controls.map((control) => control.nistId)
        );
        const cisSources = resolvedSources.filter((source) => source.kind === "CIS");
        const stigSources = resolvedSources.filter((source) => source.kind === "STIG");
        const cisAuditSources = cisSources.map((source) => auditSource(source.downloaded, source.selectedProfile, {
            sourceKind: source.kind,
            matchedSheets: source.matchedSheets,
            matchQuery: source.matchQuery,
        }));
        const stigAuditSources = stigSources.map((source) => auditSource(source.downloaded, source.selectedProfile, {
            sourceKind: source.kind,
            matchedSheets: source.matchedSheets,
            matchQuery: source.matchQuery,
        }));

        updaterSession.audit = {
            ...updaterSession.audit,
            pub1075Version: pub1075.version,
            pub1075SourcePath: pub1075.sourcePath,
            cis: cisAuditSources[0] || null,
            stig: stigAuditSources[0] || null,
            cisSources: cisAuditSources,
            stigSources: stigAuditSources,
        };

        if (resolvedSources.length === 0) {
            updaterSession.status = "review_ready";
            updaterSession.summary = `No matching CIS or STIG Benchmark Excel workbook/profile was found for ${updaterSession.inferredTechnology}. The uploaded SCSEM parsed successfully with ${controls.length} controls, but this IRS SCSEM appears to be generic or product-specific and has no direct CIS SecureSuite benchmark equivalent, so no benchmark-driven changes were generated.`;
            updaterSession.changes = [];
            updaterSession.history.push({
                at: new Date().toISOString(),
                action: "analyze",
                description: "Analysis completed without a matching CIS or STIG benchmark source.",
            });
            writeSCSEMUpdaterSession(updaterSession);
            await logAudit({
                organizationId: user.organizationId,
                userId: user.id,
                action: "SCSEM_UPDATER_ANALYZE",
                resourceType: "scsem_updater_session",
                resourceId: updaterSession.id,
                metadata: {
                    input: {
                        fileName: updaterSession.originalFileName,
                        inferredTechnology: updaterSession.inferredTechnology,
                        parsedControls: controls.length,
                        testCaseSheets: parsed.sheets
                            .filter((sheet) => sheet.sheetType === "test_cases")
                            .map((sheet) => sheet.sheetName),
                    },
                    output: {
                        summary: updaterSession.summary,
                        changeCount: 0,
                        candidateCounts: {
                            cisUpdates: 0,
                            cisNewControls: 0,
                            stigUpdates: 0,
                            stigNewControls: 0,
                        },
                        auditSources: updaterSession.audit,
                    },
                },
                ...auditRequestContext(request),
            });
            return NextResponse.json({ session: updaterSession });
        }

        const cisUpdateCandidates = updateCandidates.filter((candidate) => candidate.sourceKind === "CIS");
        const stigUpdateCandidates = updateCandidates.filter((candidate) => candidate.sourceKind === "STIG");
        const cisNewControlCandidates = newControlCandidates.filter((candidate) => candidate.sourceKind === "CIS");
        const stigNewControlCandidates = newControlCandidates.filter((candidate) => candidate.sourceKind === "STIG");

        if (updateCandidates.length === 0 && newControlCandidates.length === 0) {
            updaterSession.status = "review_ready";
            updaterSession.summary = "No CIS or STIG deltas were detected for the uploaded SCSEM workbook.";
            updaterSession.changes = [];
            updaterSession.history.push({
                at: new Date().toISOString(),
                action: "analyze",
                description: "Analysis completed with no proposed changes.",
            });
            writeSCSEMUpdaterSession(updaterSession);
            await logAudit({
                organizationId: user.organizationId,
                userId: user.id,
                action: "SCSEM_UPDATER_ANALYZE",
                resourceType: "scsem_updater_session",
                resourceId: updaterSession.id,
                metadata: {
                    input: {
                        fileName: updaterSession.originalFileName,
                        inferredTechnology: updaterSession.inferredTechnology,
                        parsedControls: controls.length,
                        testCaseSheets: parsed.sheets
                            .filter((sheet) => sheet.sheetType === "test_cases")
                            .map((sheet) => sheet.sheetName),
                    },
                    output: {
                        summary: updaterSession.summary,
                        changeCount: 0,
                        candidateCounts: {
                            cisUpdates: cisUpdateCandidates.length,
                            cisNewControls: cisNewControlCandidates.length,
                            stigUpdates: stigUpdateCandidates.length,
                            stigNewControls: stigNewControlCandidates.length,
                        },
                        auditSources: updaterSession.audit,
                    },
                },
                ...auditRequestContext(request),
            });
            return NextResponse.json({ session: updaterSession });
        }

        const cisUpdateEvidence = cisUpdateCandidates
            .map((candidate) => buildControlSummary(candidate.control, candidate.recommendation, candidate.sourceLabel))
            .join("\n\n---\n\n");
        const cisNewControlEvidence = cisNewControlCandidates
            .map((candidate) => buildNewControlEvidence(candidate.recommendation, candidate.sourceLabel))
            .join("\n\n---\n\n");
        const stigUpdateEvidence = stigUpdateCandidates
            .map((candidate) => buildControlSummary(candidate.control, candidate.recommendation, candidate.sourceLabel))
            .join("\n\n---\n\n");
        const stigNewControlEvidence = stigNewControlCandidates
            .map((candidate) => buildNewControlEvidence(candidate.recommendation, candidate.sourceLabel))
            .join("\n\n---\n\n");
        const benchmarkSourceSummary = (sources: ResolvedBenchmarkSource[], kind: ResolvedBenchmarkKind) => sources.length > 0
            ? sources.map((source) => [
                `- Title: ${source.downloaded.snapshot.benchmarkTitle}`,
                `  WorkBench ID: ${source.downloaded.snapshot.workbenchId}`,
                `  Version: ${source.downloaded.snapshot.benchmarkVersion}`,
                `  Release date: ${source.downloaded.snapshot.releaseDate.toISOString().slice(0, 10)}`,
                `  Selected profile: ${source.selectedProfile.profile}`,
                `  Matched sheets: ${source.matchedSheets.join(", ")}`,
                `  Match query: ${source.matchQuery}`,
                `  Excel snapshot path: ${source.downloaded.snapshot.filePath}`,
                `  Excel SHA-256: ${source.downloaded.snapshot.sha256}`,
                `  Matched existing recommendations: ${source.sharedRecommendationCount}/${source.sheetRecommendationCount}`,
            ].join("\n")).join("\n")
            : `- No matching ${kind} Benchmark Excel workbook/profile was selected for this SCSEM technology.`;

        const prompt = `You are an IRS Safeguards SCSEM update analyst. Propose human-reviewable SCSEM workbook changes using only the evidence below.

Decision policy:
- IRS Publication 1075 is the governing compliance floor.
- CIS Benchmark Excel rows are security-hardening evidence.
- STIG benchmark rows are security-hardening evidence and must be checked alongside CIS.
- If Pub 1075 is stricter than CIS or STIG, propose Pub 1075-aligned text.
- If CIS or STIG is stricter and does not conflict with Pub 1075, propose the stricter CIS/STIG-aligned text.
- If CIS and STIG differ, propose the stricter secure setting when clear; otherwise mark confidence "needs_review".
- If strictness is ambiguous, include the item only when it is clearly useful for human review and mark confidence "needs_review".
- Existing IRS SCSEM rows remain the base source of truth.
- You may propose new SCSEM controls when the CIS or STIG row is missing from the uploaded SCSEM and appears security-relevant.
- Explain each proposed update with enough detail for a human reviewer to decide quickly.

Uploaded SCSEM:
- File name: ${updaterSession.originalFileName}
- Inferred technology: ${updaterSession.inferredTechnology}
- Dashboard subject: ${parsed.metadata.subject || "unknown"}
- SCSEM version: ${parsed.metadata.version || "unknown"}
- Effective date: ${parsed.metadata.effectiveDate || "unknown"}
- Parsed controls: ${controls.length}

CIS Benchmark Sources:
${benchmarkSourceSummary(cisSources, "CIS")}

STIG Benchmark Sources:
${benchmarkSourceSummary(stigSources, "STIG")}

Publication 1075:
- Version: ${pub1075.version}
- Local source: ${pub1075.sourcePath}

CURRENT SCSEM ROWS MATCHED TO CIS CANDIDATES:
${cisUpdateEvidence || "None"}

POTENTIAL NEW CIS ROWS NOT PRESENT IN THE SCSEM:
${cisNewControlEvidence || "None"}

CURRENT SCSEM ROWS MATCHED TO STIG CANDIDATES:
${stigUpdateEvidence || "None"}

POTENTIAL NEW STIG ROWS NOT PRESENT IN THE SCSEM:
${stigNewControlEvidence || "None"}

PUBLICATION 1075 EXCERPTS FOR REFERENCED NIST CONTROLS:
${pub1075.excerpts || "No direct Pub 1075 excerpts were found for the candidate NIST controls."}

Return ONLY valid JSON:
{
  "summary": "2-3 sentence evidence-based summary of why this uploaded SCSEM needs review.",
  "changes": [
    {
      "action": "updateField",
      "testId": "exact existing SCSEM Test ID",
      "field": "testProcedures|expectedResults|remediationProcedure|description|rationale|impact|sectionTitle|findingStatement",
      "currentValue": "brief current value summary",
      "proposedValue": "complete replacement text for that field",
      "reason": "specific reason citing CIS recommendation number, STIG evidence, and Pub 1075 section when available",
      "confidence": "high|medium|needs_review",
      "sourceEvidence": {
        "cisRecommendation": "CIS recommendation number if CIS evidence applies, otherwise null",
        "cisProfile": "selected CIS profile if CIS evidence applies, otherwise null",
        "stigRecommendation": "STIG recommendation number if STIG evidence applies, otherwise null",
        "stigProfile": "selected STIG profile if STIG evidence applies, otherwise null",
        "sourceWorkbenchId": "WorkBench ID from the evidence source",
        "sourceBenchmarkTitle": "benchmark title from the evidence source",
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
        "sectionTitle": "CIS or STIG recommendation title",
        "description": "SCSEM-ready description",
        "testProcedures": "SCSEM-ready audit/test procedure",
        "expectedResults": "SCSEM-ready expected result",
        "criticality": "Critical|Significant|Moderate|Limited|Informational",
        "cisBenchmarkRef": "CIS or STIG section number",
        "recommendationNum": "CIS or STIG recommendation number",
        "rationale": "SCSEM-ready rationale",
        "impact": "SCSEM-ready impact",
        "remediationProcedure": "SCSEM-ready remediation"
      },
      "sourceEvidence": {
        "cisRecommendation": "CIS recommendation number if CIS evidence applies, otherwise null",
        "cisProfile": "selected CIS profile if CIS evidence applies, otherwise null",
        "stigRecommendation": "STIG recommendation number if STIG evidence applies, otherwise null",
        "stigProfile": "selected STIG profile if STIG evidence applies, otherwise null",
        "sourceWorkbenchId": "WorkBench ID from the evidence source",
        "sourceBenchmarkTitle": "benchmark title from the evidence source",
        "pub1075Version": "${pub1075.version}"
      }
    }
  ]
}

Rules:
- Include up to ${MAX_UPDATER_CHANGES} total changes. Prioritize every cell-level delta that clearly needs human review, but do not create low-value wording churn.
- For updateField, only use Test IDs from CURRENT SCSEM ROWS MATCHED TO CIS CANDIDATES or CURRENT SCSEM ROWS MATCHED TO STIG CANDIDATES.
- For addControl, only use recommendation numbers from POTENTIAL NEW CIS ROWS or POTENTIAL NEW STIG ROWS.
- Do not claim Pub 1075 says something unless the excerpt is present above.
- Do not include markdown fences.`;

        let payload: any;
        const shouldUseAI = controls.length <= AI_CONTROL_LIMIT && prompt.length <= AI_PROMPT_CHAR_LIMIT;

        if (!shouldUseAI) {
            payload = buildFallbackPayload({
                technology: updaterSession.inferredTechnology,
                pub1075,
                fallbackReason: `the uploaded workbook has ${controls.length} parsed controls, so the updater used deterministic benchmark diffs to keep the interactive request within deploy limits`,
                updateCandidates,
                newControlCandidates,
            });
        } else {
            const abortController = new AbortController();
            const timeout = setTimeout(() => abortController.abort(), AI_TIMEOUT_MS);

            try {
                const responseText = await generateBifrostText({
                    model: getConfiguredBifrostModel("BIFROST_SCSEM_MODEL"),
                    maxTokens: 9000,
                    temperature: 0.15,
                    system: "You generate precise JSON SCSEM update recommendations grounded in CIS, STIG, and IRS Pub 1075 evidence.",
                    prompt,
                    signal: abortController.signal,
                });
                payload = parseJsonResponse(responseText);
            } catch (error) {
                console.warn("SCSEM updater AI analysis failed; using deterministic fallback changes.", error);
                payload = buildFallbackPayload({
                    technology: updaterSession.inferredTechnology,
                    pub1075,
                    fallbackReason: error instanceof Error && error.name === "AbortError"
                        ? "the AI analysis exceeded the interactive timeout"
                        : "the AI response could not be used safely",
                    updateCandidates,
                    newControlCandidates,
                });
            } finally {
                clearTimeout(timeout);
            }
        }
        const validChanges = addIdsToChanges(validateChanges(payload.changes || [], controls, MAX_UPDATER_CHANGES));

        updaterSession.status = "review_ready";
        updaterSession.summary = payload.summary || `CIS/STIG review generated for ${updaterSession.inferredTechnology}.`;
        updaterSession.changes = validChanges;
        updaterSession.history.push({
            at: new Date().toISOString(),
            action: "analyze",
            description: `Analysis generated ${validChanges.length} proposed change(s).`,
        });
        writeSCSEMUpdaterSession(updaterSession);

        await logAudit({
            organizationId: user.organizationId,
            userId: user.id,
            action: "SCSEM_UPDATER_ANALYZE",
            resourceType: "scsem_updater_session",
            resourceId: updaterSession.id,
            metadata: {
                input: {
                    fileName: updaterSession.originalFileName,
                    inferredTechnology: updaterSession.inferredTechnology,
                    parsedControls: controls.length,
                    scsemVersion: parsed.metadata.version,
                    effectiveDate: parsed.metadata.effectiveDate,
                    aiUsed: shouldUseAI,
                },
                output: {
                    summary: updaterSession.summary,
                    changeCount: validChanges.length,
                    changes: changePreview(validChanges),
                    candidateCounts: {
                        cisUpdates: cisUpdateCandidates.length,
                        cisNewControls: cisNewControlCandidates.length,
                        stigUpdates: stigUpdateCandidates.length,
                        stigNewControls: stigNewControlCandidates.length,
                    },
                    auditSources: updaterSession.audit,
                },
            },
            ...auditRequestContext(request),
        });

        return NextResponse.json({ session: updaterSession });
    } catch (error: any) {
        console.error("SCSEM updater analysis error:", error);
        try {
            const updaterSession = user
                ? readSCSEMUpdaterSessionForUser(id, user)
                : null;
            if (!updaterSession) throw new Error("SCSEM updater session not found.");
            updaterSession.status = "error";
            updaterSession.error = error.message || "Failed to analyze uploaded SCSEM workbook.";
            writeSCSEMUpdaterSession(updaterSession);
        } catch {
            // The session may not exist; the response below still carries the failure.
        }

        return NextResponse.json(
            { error: error.message || "Failed to analyze uploaded SCSEM workbook." },
            { status: 500 }
        );
    }
}
