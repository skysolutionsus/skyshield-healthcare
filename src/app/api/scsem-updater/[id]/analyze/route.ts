import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditRequestContext, logAudit, truncateAuditText } from "@/lib/audit";
import {
    fetchAllBenchmarkExcelFiles,
    fetchAllBenchmarks,
    getCISToken,
} from "@/lib/cis-api";
import {
    selectApplicableSTIGProfiles,
    selectBestCISProfile,
    selectLatestBenchmarkForTechnology,
    selectLatestSTIGBenchmarkForTechnology,
    type CISBenchmarkRecommendation,
    type SelectedCISProfile,
} from "@/lib/cis-benchmark-xlsx";
import {
    addIdsToChanges,
    readSCSEMUpdaterSession,
    resolveUpdaterPath,
    writeSCSEMUpdaterSession,
    type SCSEMUpdaterAuditSource,
} from "@/lib/scsem-updater-store";
import { parseSCSEMFile, type ParsedSCSEM } from "@/lib/xlsx-parser";
import {
    buildComparisonCandidates,
    buildControlSummary,
    buildNewControlEvidence,
    downloadAndParseBenchmark,
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
    selectedProfile: SelectedCISProfile | null | undefined
): SCSEMUpdaterAuditSource {
    return {
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
        sourceUrl: `https://workbench.cisecurity.org/api/vendor/v1/excel/${downloaded.snapshot.workbenchId}`,
    };
}

type FallbackUpdateCandidate = {
    sourceLabel: "CIS" | "STIG";
    profile: string;
    control: SCSEMControlEvidence;
    recommendation: CISBenchmarkRecommendation;
    score: number;
};

type FallbackNewCandidate = {
    sourceLabel: "CIS" | "STIG";
    profile: string;
    recommendation: CISBenchmarkRecommendation;
};

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
    cisProfile,
    stigProfile,
    pub1075,
    fallbackReason,
    updateCandidates,
    newControlCandidates,
    stigUpdateCandidates,
    stigNewControlCandidates,
}: {
    technology: string;
    cisProfile: string;
    stigProfile: string;
    pub1075: { version: string };
    fallbackReason?: string;
    updateCandidates: ReturnType<typeof buildComparisonCandidates>["updateCandidates"];
    newControlCandidates: ReturnType<typeof buildComparisonCandidates>["newControlCandidates"];
    stigUpdateCandidates: ReturnType<typeof buildComparisonCandidates>["updateCandidates"];
    stigNewControlCandidates: ReturnType<typeof buildComparisonCandidates>["newControlCandidates"];
}) {
    const fallbackUpdates: FallbackUpdateCandidate[] = [
        ...updateCandidates.map((candidate) => ({
            ...candidate,
            sourceLabel: "CIS" as const,
            profile: cisProfile,
        })),
        ...stigUpdateCandidates.map((candidate) => ({
            ...candidate,
            sourceLabel: "STIG" as const,
            profile: stigProfile,
        })),
    ].sort((a, b) => b.score - a.score);

    const fallbackNewControls: FallbackNewCandidate[] = [
        ...newControlCandidates.map((recommendation) => ({
            recommendation,
            sourceLabel: "CIS" as const,
            profile: cisProfile,
        })),
        ...stigNewControlCandidates.map((recommendation) => ({
            recommendation,
            sourceLabel: "STIG" as const,
            profile: stigProfile,
        })),
    ];

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
            reason: `${candidate.sourceLabel} ${candidate.recommendation.recommendation} (${candidate.profile}) differs from the uploaded SCSEM row. ${pub1075.version} remains the compliance floor; this fallback proposal should be reviewed for the stricter CIS/STIG/Pub 1075 wording before approval.`,
            confidence: "needs_review",
            sourceEvidence: {
                cisRecommendation: candidate.sourceLabel === "CIS" ? candidate.recommendation.recommendation : null,
                cisProfile,
                stigRecommendation: candidate.sourceLabel === "STIG" ? candidate.recommendation.recommendation : null,
                stigProfile,
                pub1075Version: pub1075.version,
            },
        });
    }

    for (const candidate of fallbackNewControls) {
        if (changes.length >= MAX_UPDATER_CHANGES) break;
        const recommendation = candidate.recommendation;
        changes.push({
            action: "addControl",
            testId: `NEW-${candidate.sourceLabel}-${recommendation.recommendation}`,
            field: "newControl",
            currentValue: "Not present in current SCSEM",
            proposedValue: `${candidate.sourceLabel} ${recommendation.recommendation}: ${recommendation.title}`,
            reason: `${candidate.sourceLabel} ${recommendation.recommendation} appears in the selected benchmark profile but was not mapped in the uploaded SCSEM. ${pub1075.version} should be checked before approval.`,
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
            sourceEvidence: {
                cisRecommendation: candidate.sourceLabel === "CIS" ? recommendation.recommendation : null,
                cisProfile,
                stigRecommendation: candidate.sourceLabel === "STIG" ? recommendation.recommendation : null,
                stigProfile,
                pub1075Version: pub1075.version,
            },
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

    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const user = session.user as unknown as { id: string; organizationId: string };

        const updaterSession = readSCSEMUpdaterSession(id);
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

        const selected = selectLatestBenchmarkForTechnology(
            updaterSession.inferredTechnology,
            allBenchmarks,
            allExcelFiles
        );
        const selectedStig = selectLatestSTIGBenchmarkForTechnology(
            updaterSession.inferredTechnology,
            allBenchmarks,
            allExcelFiles
        );

        const downloadedBenchmarks = new Map<number, DownloadedBenchmark>();
        let downloaded: DownloadedBenchmark | null = null;
        let selectedProfile: SelectedCISProfile | null = null;

        if (selected) {
            downloaded = await downloadAndParseBenchmark(
                cisToken,
                selected.benchmark,
                selected.excel,
                downloadedBenchmarks
            );
            selectedProfile = selectBestCISProfile(
                updaterSession.inferredTechnology,
                controls,
                downloaded.recommendations
            );
        }

        let stigDownloaded: DownloadedBenchmark | null = null;
        let selectedStigProfile: SelectedCISProfile | null = null;
        let stigUpdateCandidates: ReturnType<typeof buildComparisonCandidates>["updateCandidates"] = [];
        let stigNewControlCandidates: ReturnType<typeof buildComparisonCandidates>["newControlCandidates"] = [];

        if (selectedStig) {
            stigDownloaded = await downloadAndParseBenchmark(
                cisToken,
                selectedStig.benchmark,
                selectedStig.excel,
                downloadedBenchmarks
            );
            selectedStigProfile = selectApplicableSTIGProfiles(
                updaterSession.inferredTechnology,
                controls,
                stigDownloaded.recommendations
            );

            if (selectedStigProfile) {
                const stigCandidates = buildComparisonCandidates(
                    controls,
                    selectedStigProfile.recommendations,
                    UPDATER_CANDIDATE_LIMITS
                );
                stigUpdateCandidates = stigCandidates.updateCandidates;
                stigNewControlCandidates = stigCandidates.newControlCandidates;
            }
        }

        if (!selectedProfile && !selectedStigProfile) {
            throw new Error(`No matching CIS or STIG Benchmark Excel workbook/profile was found for ${updaterSession.inferredTechnology}. Some IRS SCSEMs are generic or product-specific and do not have a direct CIS SecureSuite Excel equivalent.`);
        }

        const { updateCandidates, newControlCandidates } = selectedProfile
            ? buildComparisonCandidates(
                controls,
                selectedProfile.recommendations,
                UPDATER_CANDIDATE_LIMITS
            )
            : { updateCandidates: [], newControlCandidates: [] };

        const pub1075 = extractPub1075Sections([
            ...updateCandidates.map((candidate) => candidate.control.nistId),
            ...stigUpdateCandidates.map((candidate) => candidate.control.nistId),
        ]);

        updaterSession.audit = {
            ...updaterSession.audit,
            pub1075Version: pub1075.version,
            pub1075SourcePath: pub1075.sourcePath,
            cis: downloaded ? auditSource(downloaded, selectedProfile) : null,
            stig: stigDownloaded ? auditSource(stigDownloaded, selectedStigProfile) : null,
        };

        if (
            updateCandidates.length === 0 &&
            newControlCandidates.length === 0 &&
            stigUpdateCandidates.length === 0 &&
            stigNewControlCandidates.length === 0
        ) {
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
                            cisUpdates: updateCandidates.length,
                            cisNewControls: newControlCandidates.length,
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

CIS Benchmark:
${downloaded && selectedProfile
                ? [
                    `- Title: ${downloaded.snapshot.benchmarkTitle}`,
                    `- Version: ${downloaded.snapshot.benchmarkVersion}`,
                    `- Release date: ${downloaded.snapshot.releaseDate.toISOString().slice(0, 10)}`,
                    `- Selected profile: ${selectedProfile.profile}`,
                    `- Excel snapshot path: ${downloaded.snapshot.filePath}`,
                    `- Excel SHA-256: ${downloaded.snapshot.sha256}`,
                    `- Matched existing recommendations: ${selectedProfile.sharedRecommendationCount}/${selectedProfile.totalRecommendationCount}`,
                ].join("\n")
                : "- No matching CIS Benchmark Excel workbook/profile was selected for this SCSEM technology."}

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
        "cisProfile": "${selectedProfile?.profile || ""}",
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
        "cisProfile": "${selectedProfile?.profile || ""}",
        "stigRecommendation": "STIG recommendation number if STIG evidence applies, otherwise null",
        "stigProfile": "${selectedStigProfile?.profile || ""}",
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
                cisProfile: selectedProfile?.profile || "",
                stigProfile: selectedStigProfile?.profile || "",
                pub1075,
                fallbackReason: `the uploaded workbook has ${controls.length} parsed controls, so the updater used deterministic benchmark diffs to keep the interactive request within deploy limits`,
                updateCandidates,
                newControlCandidates,
                stigUpdateCandidates,
                stigNewControlCandidates,
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
                    cisProfile: selectedProfile?.profile || "",
                    stigProfile: selectedStigProfile?.profile || "",
                    pub1075,
                    fallbackReason: error instanceof Error && error.name === "AbortError"
                        ? "the AI analysis exceeded the interactive timeout"
                        : "the AI response could not be used safely",
                    updateCandidates,
                    newControlCandidates,
                    stigUpdateCandidates,
                    stigNewControlCandidates,
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
                        cisUpdates: updateCandidates.length,
                        cisNewControls: newControlCandidates.length,
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
            const updaterSession = readSCSEMUpdaterSession(id);
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
