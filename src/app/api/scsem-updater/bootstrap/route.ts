import { NextResponse } from "next/server";
import { auditRequestContext } from "@/lib/audit";
import {
    fetchAllBenchmarkExcelFiles,
    fetchAllBenchmarks,
    getCISToken,
} from "@/lib/cis-api";
import {
    buildCISBootstrapBlankWorkbook,
    buildCISBootstrapChanges,
} from "@/lib/scsem-cis-bootstrap";
import { downloadAndParseBenchmark, type DownloadedBenchmark } from "@/lib/scsem-update-engine";
import {
    addIdsToChanges,
    createSCSEMUpdaterSession,
    scsemUpdaterRevisionETag,
    writeSCSEMUpdaterSession,
    type SCSEMUpdaterAuditSource,
} from "@/lib/scsem-updater-store";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";
import { clientSafeSCSEMUpdaterSession } from "@/lib/scsem-updater-client-session";
import { scsemBenchmarkLookupFailureDetails } from "@/lib/scsem-benchmark-failure";

export const runtime = "nodejs";

function benchmarkTechnology(title: string): string {
    return title
        .replace(/^CIS\s+/i, "")
        .replace(/\s+Benchmark(?:\s+v\d+(?:\.\d+)*)?\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
}

function auditSource(downloaded: DownloadedBenchmark, profile: string): SCSEMUpdaterAuditSource {
    return {
        sourceKind: "CIS",
        sourceRelationship: "direct",
        workbenchId: downloaded.snapshot.workbenchId,
        benchmarkTitle: downloaded.snapshot.benchmarkTitle,
        benchmarkVersion: downloaded.snapshot.benchmarkVersion,
        releaseDate: downloaded.snapshot.releaseDate.toISOString(),
        excelTitle: downloaded.snapshot.excelTitle,
        excelFileName: downloaded.snapshot.excelFileName,
        filePath: downloaded.snapshot.filePath,
        sha256: downloaded.snapshot.sha256,
        downloadedAt: downloaded.snapshot.downloadedAt.toISOString(),
        selectedProfile: profile,
        selectedProfileRecommendationCount: downloaded.recommendations.filter(
            (recommendation) => recommendation.profile === profile
        ).length,
        sharedRecommendationCount: 0,
        matchedSheets: ["General App Test Cases"],
        matchQuery: `Explicit CIS WorkBench ID ${downloaded.snapshot.workbenchId}`,
        sourceUrl: `https://workbench.cisecurity.org/api/vendor/v1/excel/${downloaded.snapshot.workbenchId}`,
    };
}

export async function POST(request: Request) {
    try {
        const access = await requireScsemSteward();
        if (!access.ok) return access.response;
        const user = access.user;

        const body = await request.json() as { workbenchId?: unknown; profile?: unknown };
        const workbenchId = Number(body.workbenchId);
        if (!Number.isSafeInteger(workbenchId) || workbenchId <= 0) {
            return NextResponse.json({
                error: "Enter a positive numeric CIS WorkBench ID from the benchmark URL.",
                code: "INVALID_CIS_WORKBENCH_ID",
            }, { status: 400 });
        }
        if (body.profile !== undefined && typeof body.profile !== "string") {
            return NextResponse.json({
                error: "The CIS profile must be a string.",
                code: "INVALID_CIS_PROFILE",
            }, { status: 400 });
        }
        const requestedProfile = typeof body.profile === "string" ? body.profile.trim() : "";

        const token = await getCISToken();
        const [benchmarks, excelFiles] = await Promise.all([
            fetchAllBenchmarks(token),
            fetchAllBenchmarkExcelFiles(token),
        ]);
        const benchmark = benchmarks.find((candidate) => Number(candidate.workbenchId) === workbenchId);
        const excel = excelFiles.find((candidate) => Number(candidate.workbenchId) === workbenchId);
        if (!benchmark || !excel) {
            return NextResponse.json({
                error: "That WorkBench ID is not available as a licensed CIS Benchmark Excel workbook.",
                code: "CIS_WORKBENCH_EXCEL_NOT_AVAILABLE",
            }, { status: 404 });
        }
        if ((benchmark.benchmarkStatus?.status || "").trim().toLowerCase() !== "accepted") {
            return NextResponse.json({
                error: "SkyShield only bootstraps from an accepted CIS Benchmark release.",
                code: "CIS_BENCHMARK_NOT_ACCEPTED",
            }, { status: 422 });
        }
        const workbenchStatus = (benchmark.workbenchStatus?.status || "").trim().toLowerCase();
        if (workbenchStatus && workbenchStatus !== "published") {
            return NextResponse.json({
                error: "SkyShield only bootstraps from a currently published CIS WorkBench release.",
                code: "CIS_BENCHMARK_NOT_PUBLISHED",
            }, { status: 422 });
        }
        if (/\bSTIG\b/i.test(benchmark.benchmarkTitle)) {
            return NextResponse.json({
                error: "Use a CIS Benchmark, not a CIS-STIG workbook, to bootstrap a blank SCSEM draft.",
                code: "CIS_BOOTSTRAP_REQUIRES_BENCHMARK",
            }, { status: 422 });
        }

        const downloaded = await downloadAndParseBenchmark(
            token,
            benchmark,
            excel,
            new Map<number, DownloadedBenchmark>()
        );
        const profileNames = [...new Set(
            downloaded.recommendations.map((recommendation) => recommendation.profile.trim()).filter(Boolean)
        )].sort((left, right) => left.localeCompare(right));
        if (profileNames.length === 0) {
            return NextResponse.json({
                error: "The selected CIS workbook contained no usable recommendation profile.",
                code: "CIS_WORKBOOK_HAS_NO_PROFILE",
            }, { status: 422 });
        }
        if (!requestedProfile && profileNames.length > 1) {
            return NextResponse.json({
                error: "Select the exact CIS profile to use for the blank SCSEM draft.",
                code: "CIS_PROFILE_REQUIRED",
                profiles: profileNames,
            }, { status: 409 });
        }
        const selectedProfile = requestedProfile
            ? profileNames.find((profile) => profile.toLowerCase() === requestedProfile.toLowerCase())
            : profileNames[0];
        if (!selectedProfile) {
            return NextResponse.json({
                error: "The requested profile is not present in that CIS WorkBench Excel workbook.",
                code: "CIS_PROFILE_NOT_FOUND",
                profiles: profileNames,
            }, { status: 422 });
        }
        const recommendations = downloaded.recommendations.filter(
            (recommendation) => recommendation.profile === selectedProfile
        );
        if (recommendations.length > 5000) {
            return NextResponse.json({
                error: "This profile exceeds the 5000-recommendation bootstrap limit. No session was created; select a smaller profile.",
                code: "CIS_BOOTSTRAP_TOO_MANY_RECOMMENDATIONS",
            }, { status: 422 });
        }
        const technology = benchmarkTechnology(benchmark.benchmarkTitle);
        if (!technology) {
            return NextResponse.json({
                error: "SkyShield could not derive a technology name from the CIS Benchmark title.",
                code: "CIS_TECHNOLOGY_UNRESOLVED",
            }, { status: 422 });
        }

        const blank = await buildCISBootstrapBlankWorkbook(
            technology,
            benchmark.benchmarkVersion,
            recommendations.length
        );
        const originalFileName = `Safeguards-SCSEM (${technology})-CIS-WORKING-DRAFT.xlsx`;
        const created = await createSCSEMUpdaterSession(
            originalFileName,
            blank.buffer,
            { organizationId: user.organizationId, userId: user.id },
            undefined,
            {
                action: "SCSEM_UPDATER_CIS_BOOTSTRAP",
                affectedPayload: {
                    phase: "blank_workbook_created",
                    workbenchId,
                    benchmarkTitle: benchmark.benchmarkTitle,
                    benchmarkVersion: benchmark.benchmarkVersion,
                    selectedProfile,
                    recommendationCount: recommendations.length,
                    structuralBaseline: blank.baseline,
                },
                ...auditRequestContext(request),
            }
        );

        const source = auditSource(downloaded, selectedProfile);
        const changes = addIdsToChanges(buildCISBootstrapChanges({
            recommendations,
            workbenchId,
            benchmarkTitle: benchmark.benchmarkTitle,
            benchmarkVersion: benchmark.benchmarkVersion,
            profile: selectedProfile,
            sourceSha256: downloaded.snapshot.sha256,
        }));
        created.workspaceMode = "cis_bootstrap";
        created.analysisScope = "full";
        created.status = "analysis_incomplete";
        created.summary =
            `Created a blank ${technology} SCSEM working draft with ${changes.length} reviewer-gated ` +
            `candidate control(s) from ${benchmark.benchmarkTitle} v${benchmark.benchmarkVersion}, ` +
            `profile ${selectedProfile}. Publication 1075/NIST mappings and IRS issue-code applicability ` +
            "remain unresolved, so this draft is not release-ready.";
        created.changes = changes;
        created.audit = {
            ...created.audit,
            cis: source,
            cisSources: [source],
            stig: null,
            stigSources: [],
            adjacentSources: [],
            supplementalComparison: {
                mode: "deterministic_fallback",
                complete: true,
                candidateOnly: true,
                applicabilityStatus: "review_required",
                directSourceCount: 1,
                comparedDirectSourceCount: 1,
                candidateCount: recommendations.length,
                comparedCandidateCount: recommendations.length,
                rawProposalCount: changes.length,
                evidenceBoundProposalCount: changes.length,
                reason:
                    "Every selected-profile CIS recommendation was converted to a source-bound candidate control without AI rewriting.",
            },
            analysisCoverage: {
                totalRows: 0,
                nistMappedRows: 0,
                reviewedRows: 0,
                unmappedRows: 0,
                totalBatches: 0,
                aiCompletedBatches: 0,
                supplementalComparisonComplete: true,
                complete: false,
                blockers: [
                    "CIS bootstrap candidates have not been mapped to exact Publication 1075 or NIST control evidence",
                    "An authorized reviewer must select exact IRS issue codes and confirm technology/profile applicability before release",
                ],
            },
            cisBootstrap: {
                workbenchId,
                benchmarkTitle: benchmark.benchmarkTitle,
                benchmarkVersion: benchmark.benchmarkVersion,
                selectedProfile,
                recommendationCount: recommendations.length,
                structuralBaseline: blank.baseline,
            },
        };
        created.history.push({
            at: new Date().toISOString(),
            action: "analyze",
            description:
                `Created ${changes.length} source-bound CIS bootstrap candidate(s) from WorkBench ID ${workbenchId}, profile ${selectedProfile}.`,
        });
        await writeSCSEMUpdaterSession(created, created.revision, {
            action: "SCSEM_UPDATER_CIS_BOOTSTRAP",
            affectedPayload: {
                phase: "candidate_controls_created",
                workbenchId,
                benchmarkTitle: benchmark.benchmarkTitle,
                benchmarkVersion: benchmark.benchmarkVersion,
                selectedProfile,
                recommendationCount: recommendations.length,
                changeCount: changes.length,
                sourceSha256: downloaded.snapshot.sha256,
                structuralBaseline: blank.baseline,
            },
            ...auditRequestContext(request),
        });

        return NextResponse.json(
            { session: clientSafeSCSEMUpdaterSession(created) },
            { headers: { ETag: scsemUpdaterRevisionETag(created) } }
        );
    } catch (error: unknown) {
        console.error("SCSEM CIS bootstrap error:", error);
        const failure = scsemBenchmarkLookupFailureDetails(error, "direct");
        return NextResponse.json({
            error: failure.message,
            code: failure.code,
        }, { status: 503 });
    }
}
