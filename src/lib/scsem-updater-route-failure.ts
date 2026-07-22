import { scsemExportFailureDetails } from "@/lib/scsem-export-error";
import { SCSEMSourceIntegrityError } from "@/lib/scsem-source-integrity";
import { scsemUpdaterMutationErrorDetails } from "@/lib/scsem-updater-store";

export function scsemUpdaterRouteFailureDetails(
    error: unknown,
    unexpectedErrorMessage: string
): {
    status: 404 | 409 | 422 | 428 | 500;
    response: Record<string, unknown> & { error: string };
} {
    const mutationError = scsemUpdaterMutationErrorDetails(error);
    if (mutationError) {
        return {
            status: mutationError.status,
            response: mutationError,
        };
    }

    const exportFailure = scsemExportFailureDetails(error);
    if (exportFailure) {
        return {
            status: exportFailure.status,
            response: {
                code: exportFailure.code,
                error: exportFailure.error,
            },
        };
    }

    if (error instanceof SCSEMSourceIntegrityError) {
        return {
            status: 409,
            response: {
                code: error.code,
                error: "The SCSEM source workbook failed its integrity check. Start a new session from a pinned IRS workbook.",
            },
        };
    }

    if (error instanceof Error && error.message === "SCSEM updater session not found.") {
        return {
            status: 404,
            response: { error: "SCSEM updater session not found." },
        };
    }

    return {
        status: 500,
        response: { error: unexpectedErrorMessage },
    };
}
