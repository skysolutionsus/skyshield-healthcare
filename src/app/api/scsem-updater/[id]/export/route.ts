import { NextResponse } from "next/server";
import { generatorApprovalErrors } from "@/lib/scsem-generator-evidence";
import { auditRequestContext, createAuditOperationId, logAuditStrict } from "@/lib/audit";
import {
    requireSCSEMUpdaterExpectedRevision,
    scsemUpdaterMutationErrorDetails,
    scsemUpdaterRevisionETag,
    withLockedSCSEMUpdaterSessionForUser,
} from "@/lib/scsem-updater-store";
import { parseSCSEMFile } from "@/lib/xlsx-parser";
import {
    buildSCSEMUpdaterWorkbookBuffer,
    excelContentTypeForFileName,
    updatedSCSEMFileName,
} from "@/lib/scsem-workbook-export";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";
import { scsemExportFailureDetails } from "@/lib/scsem-export-error";
import {
    assertOfficialSCSEMReferenceIntegrity,
    assertSCSEMUpdaterSourceIntegrity,
    SCSEMSourceIntegrityError,
    sha256Hex,
} from "@/lib/scsem-source-integrity";
import {
    boundedStoredSCSEMBenchmarkAttemptReason,
    boundedStoredSCSEMBenchmarkNarrative,
} from "@/lib/scsem-benchmark-failure";

export const runtime = "nodejs";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const access = await requireScsemSteward();
        if (!access.ok) return access.response;
        const user = access.user;

        const { id } = await params;
        const expectedRevision = requireSCSEMUpdaterExpectedRevision(request);
        return await withLockedSCSEMUpdaterSessionForUser(
            id,
            user,
            expectedRevision,
            async (updaterSession) => {
                const benchmarkNarrative = boundedStoredSCSEMBenchmarkNarrative({
                    benchmarkLookupError: updaterSession.audit.benchmarkLookupError,
                    summary: updaterSession.summary,
                    blockers: updaterSession.audit.analysisCoverage?.blockers,
                    supplementalReason: updaterSession.audit.supplementalComparison?.reason,
                });
                const verifiedUpload = assertSCSEMUpdaterSourceIntegrity(updaterSession);
                const pendingChanges = updaterSession.changes.filter((change) => change.status === "PENDING");
                const approvedChanges = updaterSession.changes.filter((change) => change.status === "APPROVED");
                if (!["review_ready", "analysis_incomplete"].includes(updaterSession.status)) {
                    return NextResponse.json({
                        error: "Run the evidence analysis before exporting a candidate workbook.",
                    }, { status: 409 });
                }
                if (pendingChanges.length > 0) {
                    return NextResponse.json({
                        error: `Review all proposed changes before export (${pendingChanges.length} still pending).`,
                    }, { status: 409 });
                }
                if (approvedChanges.length === 0) {
                    return NextResponse.json({
                        error: "Approve at least one evidence-backed change before exporting a candidate workbook.",
                    }, { status: 409 });
                }

                if (updaterSession.workspaceMode === "cis_bootstrap") {
                    const changes = approvedChanges.map((change) => ({ changeId: change.id, errors: generatorApprovalErrors(change) }))
                        .filter((change) => change.errors.length > 0);
                    if (changes.length > 0) return NextResponse.json({
                        error: "Generator evidence must be reviewed before export.",
                        code: "INVALID_GENERATOR_EVIDENCE", changes,
                    }, { status: 400 });
                }
                const draftRequested = new URL(request.url).searchParams.get("draft") === "1";
                if (updaterSession.status === "analysis_incomplete" && !draftRequested) {
                    return NextResponse.json({
                        error: "Analysis coverage is incomplete. Only an explicitly labeled draft candidate may be exported.",
                        code: "ANALYSIS_INCOMPLETE",
                        blockers: benchmarkNarrative.blockers,
                        draftExportUrl: `/api/scsem-updater/${updaterSession.id}/export?draft=1`,
                    }, { status: 409 });
                }

                const officialReference = updaterSession.audit.officialReference?.selectedAsBase
                    ? updaterSession.audit.officialReference
                    : null;
                const verifiedBase = officialReference
                    ? assertOfficialSCSEMReferenceIntegrity(officialReference)
                    : verifiedUpload;
                const baseWorkbookPath = verifiedBase.absolutePath;
                const candidateFileName = updatedSCSEMFileName(updaterSession.originalFileName);
                const exportFileName = updaterSession.status === "analysis_incomplete"
                    ? candidateFileName.replace(/(\.xlsx|\.xlsm)$/i, "-DRAFT-INCOMPLETE$1")
                    : candidateFileName.replace(/(\.xlsx|\.xlsm)$/i, "-CANDIDATE$1");
                const buffer = await buildSCSEMUpdaterWorkbookBuffer(
                    updaterSession,
                    parseSCSEMFile(baseWorkbookPath),
                    baseWorkbookPath
                );
                const candidateSha256 = sha256Hex(buffer);

                const operationId = createAuditOperationId();
                await logAuditStrict({
                    organizationId: user.organizationId,
                    userId: user.id,
                    action: "SCSEM_UPDATER_EXPORT",
                    resourceType: "scsem_updater_session",
                    resourceId: updaterSession.id,
                    metadata: {
                        schemaVersion: 1,
                        phase: "EXPORT_READY",
                        operationId,
                        timestamp: new Date().toISOString(),
                        input: {
                            sessionRevision: updaterSession.revision,
                            fileName: updaterSession.originalFileName,
                            inferredTechnology: updaterSession.inferredTechnology,
                            approvedChangeIds: approvedChanges.map((change) => change.id),
                            officialReference: officialReference?.sourceUrl || null,
                            draft: updaterSession.status === "analysis_incomplete",
                            uploadedSourceSha256: verifiedUpload.sha256,
                            uploadedSourceSizeBytes: verifiedUpload.sizeBytes,
                            exportBaseSha256: verifiedBase.sha256,
                            exportBaseSizeBytes: verifiedBase.sizeBytes,
                        },
                        output: {
                            sessionRevision: updaterSession.revision,
                            exportFileName,
                            outputSizeBytes: buffer.length,
                            outputSha256: candidateSha256,
                            changeCounts: {
                                approved: approvedChanges.length,
                                pending: pendingChanges.length,
                                rejected: updaterSession.changes.filter((change) => change.status === "REJECTED").length,
                            },
                            auditSources: {
                                ...updaterSession.audit,
                                ...(benchmarkNarrative.benchmarkLookupError !== undefined
                                    ? {
                                        benchmarkLookupError:
                                            benchmarkNarrative.benchmarkLookupError,
                                    }
                                    : {}),
                                ...(updaterSession.audit.analysisCoverage !== undefined
                                    ? {
                                        analysisCoverage: {
                                            ...updaterSession.audit.analysisCoverage,
                                            blockers: benchmarkNarrative.blockers,
                                        },
                                    }
                                    : {}),
                                ...(updaterSession.audit.supplementalComparison !== undefined
                                    ? {
                                        supplementalComparison: {
                                            ...updaterSession.audit.supplementalComparison,
                                            reason: benchmarkNarrative.supplementalReason ??
                                                updaterSession.audit.supplementalComparison.reason,
                                        },
                                    }
                                    : {}),
                                ...(updaterSession.audit.benchmarkResolution !== undefined
                                    ? {
                                        benchmarkResolution:
                                            updaterSession.audit.benchmarkResolution.map(
                                                (diagnostic) => ({
                                                    ...diagnostic,
                                                    attempts: diagnostic.attempts.map((attempt) => ({
                                                        ...attempt,
                                                        reason: boundedStoredSCSEMBenchmarkAttemptReason(
                                                            attempt.reason
                                                        ),
                                                    })),
                                                })
                                            ),
                                    }
                                    : {}),
                            },
                        },
                    },
                    ...auditRequestContext(request),
                });

                return new Response(new Uint8Array(buffer), {
                    status: 200,
                    headers: {
                        "Content-Type": excelContentTypeForFileName(exportFileName),
                        "Content-Disposition": `attachment; filename="${exportFileName}"`,
                        "Cache-Control": "private, no-store",
                        "ETag": scsemUpdaterRevisionETag(updaterSession),
                        "X-SCSEM-Revision": String(updaterSession.revision),
                        "X-SCSEM-SHA256": candidateSha256,
                        "X-SCSEM-Operation-ID": operationId,
                    },
                });
            }
        );
    } catch (error: unknown) {
        console.error("SCSEM updater export error:", error);
        const mutationError = scsemUpdaterMutationErrorDetails(error);
        if (mutationError) {
            return NextResponse.json(mutationError, { status: mutationError.status });
        }
        const exportFailure = scsemExportFailureDetails(error);
        if (exportFailure) {
            return NextResponse.json(
                { code: exportFailure.code, error: exportFailure.error },
                { status: exportFailure.status }
            );
        }
        if (error instanceof SCSEMSourceIntegrityError) {
            return NextResponse.json({
                code: error.code,
                error: "The SCSEM source workbook failed its integrity check. Start a new session from a pinned IRS workbook.",
            }, { status: 409 });
        }
        if (error instanceof Error && error.message.includes("not found")) {
            return NextResponse.json({ error: "SCSEM updater session not found." }, { status: 404 });
        }
        return NextResponse.json(
            { error: "Failed to export candidate SCSEM workbook." },
            { status: 500 }
        );
    }
}
