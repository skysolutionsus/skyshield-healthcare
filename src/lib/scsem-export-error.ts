export const SCSEM_EXPORT_SCHEMA_UNSUPPORTED = "SCSEM_EXPORT_SCHEMA_UNSUPPORTED";

export interface SCSEMExportFailureDetails {
    status: 422;
    code: typeof SCSEM_EXPORT_SCHEMA_UNSUPPORTED;
    error: string;
}

const SAFE_EXPORT_FAILURE_MESSAGE =
    "One or more approved changes cannot be applied safely to this workbook schema. " +
    "Remove or reject the unsupported change, or prepare an approved template row/layout for it, then retry the candidate export.";

/**
 * Export validation deliberately contains workbook coordinates and local source
 * details for server diagnostics. Convert only known fail-closed validation
 * errors into a stable, path-free API response; unexpected failures remain 500.
 */
export function scsemExportFailureDetails(error: unknown): SCSEMExportFailureDetails | null {
    const message = error instanceof Error ? error.message : "";
    if (
        message.startsWith("Cannot export approved SCSEM change ") ||
        message.startsWith("Cannot export SCSEM workbook:") ||
        message === "Macro-enabled workbook export lost the VBA project."
    ) {
        return {
            status: 422,
            code: SCSEM_EXPORT_SCHEMA_UNSUPPORTED,
            error: SAFE_EXPORT_FAILURE_MESSAGE,
        };
    }
    return null;
}
