import type { SCSEMUpdaterSession } from "@/lib/scsem-updater-store";
import { SCSEMSourceIntegrityError } from "@/lib/scsem-source-integrity";

export const SCSEM_ANALYSIS_FAILURE_MESSAGE =
    "Failed to analyze the SCSEM workbook. Retry the analysis or contact an administrator if the problem continues.";

export function isSCSEMAnalysisFailureOwnedByRevision(
    session: Pick<SCSEMUpdaterSession, "revision" | "status">,
    analysisRevision: number | null
): boolean {
    return analysisRevision !== null &&
        session.status === "analyzing" &&
        session.revision === analysisRevision;
}

export function scsemAnalysisFailureDetails(error: unknown): {
    status: 404 | 409 | 500;
    response: {
        error: string;
        code?: string;
    };
    persistedError: string;
} {
    if (error instanceof SCSEMSourceIntegrityError) {
        const message =
            "The SCSEM source workbook failed its integrity check. Start a new session from a pinned IRS workbook.";
        return {
            status: 409,
            response: { code: error.code, error: message },
            persistedError: message,
        };
    }

    if (error instanceof Error && error.message === "SCSEM updater session not found.") {
        const message = "SCSEM updater session not found.";
        return {
            status: 404,
            response: { error: message },
            persistedError: message,
        };
    }

    return {
        status: 500,
        response: { error: SCSEM_ANALYSIS_FAILURE_MESSAGE },
        persistedError: SCSEM_ANALYSIS_FAILURE_MESSAGE,
    };
}
