export type SCSEMBenchmarkLookupFailureCode =
    | "CIS_CREDENTIALS_NOT_CONFIGURED"
    | "CIS_CREDENTIALS_UNAVAILABLE"
    | "CIS_AUTHENTICATION_UNAVAILABLE"
    | "CIS_CATALOG_UNAVAILABLE"
    | "CIS_BENCHMARK_LOOKUP_UNAVAILABLE"
    | "CIS_ADJACENT_LOOKUP_UNAVAILABLE";

export type SCSEMBenchmarkLookupFailure = {
    code: SCSEMBenchmarkLookupFailureCode;
    message: string;
};

/**
 * Convert provider, filesystem, parser, and network exceptions into bounded
 * public evidence. Callers may log the original exception server-side, but
 * only this result may enter sessions, API JSON, audit metadata, or exports.
 */
export function scsemBenchmarkLookupFailureDetails(
    error: unknown,
    phase: "direct" | "adjacent" = "direct"
): SCSEMBenchmarkLookupFailure {
    const raw = error instanceof Error ? error.message : "";
    if (raw.startsWith("CIS SecureSuite credentials are not configured.")) {
        return {
            code: "CIS_CREDENTIALS_NOT_CONFIGURED",
            message: "CIS SecureSuite credentials are not configured.",
        };
    }
    if (/CIS_LICENSE_XML_|license material/i.test(raw)) {
        return {
            code: "CIS_CREDENTIALS_UNAVAILABLE",
            message: "CIS SecureSuite credentials are unavailable or invalid.",
        };
    }
    if (/CIS SecureSuite authentication/i.test(raw)) {
        return {
            code: "CIS_AUTHENTICATION_UNAVAILABLE",
            message: "CIS SecureSuite authentication could not be completed.",
        };
    }
    if (/catalog/i.test(raw)) {
        return {
            code: "CIS_CATALOG_UNAVAILABLE",
            message: "The CIS Benchmark catalog could not be retrieved or validated.",
        };
    }
    if (phase === "adjacent") {
        return {
            code: "CIS_ADJACENT_LOOKUP_UNAVAILABLE",
            message: "Adjacent CIS Benchmark/CIS-STIG lookup could not be completed.",
        };
    }
    return {
        code: "CIS_BENCHMARK_LOOKUP_UNAVAILABLE",
        message: "CIS Benchmark/CIS-STIG lookup could not be completed.",
    };
}

export function scsemBenchmarkCandidateFailureReason(_error: unknown): string {
    return "Benchmark candidate workbook could not be downloaded or validated.";
}

const PUBLIC_LOOKUP_MESSAGES = new Set([
    "CIS SecureSuite credentials are not configured.",
    "CIS SecureSuite credentials are unavailable or invalid.",
    "CIS SecureSuite authentication could not be completed.",
    "The CIS Benchmark catalog could not be retrieved or validated.",
    "CIS Benchmark/CIS-STIG lookup could not be completed.",
    "Adjacent CIS Benchmark/CIS-STIG lookup could not be completed.",
]);

export function boundedStoredSCSEMBenchmarkLookupMessage(message: string): string {
    return PUBLIC_LOOKUP_MESSAGES.has(message)
        ? message
        : "CIS Benchmark/CIS-STIG lookup could not be completed.";
}

export type SCSEMBenchmarkStoredNarrative = {
    benchmarkLookupError?: string;
    summary?: string;
    blockers: string[];
    supplementalReason?: string;
};

function replaceExactStoredLookupMessage(
    value: string | undefined,
    storedLookupMessage: string | undefined,
    boundedLookupMessage: string | undefined
): string | undefined {
    if (!value || !storedLookupMessage || !boundedLookupMessage) return value;
    return value.split(storedLookupMessage).join(boundedLookupMessage);
}

/**
 * Bound narrative text that was derived from the session's exact stored lookup
 * failure. This deliberately does not scan or rewrite arbitrary control or
 * proposal text, where filesystem-like strings can be legitimate evidence.
 */
export function boundedStoredSCSEMBenchmarkNarrative({
    benchmarkLookupError,
    summary,
    blockers = [],
    supplementalReason,
}: {
    benchmarkLookupError?: string;
    summary?: string;
    blockers?: string[];
    supplementalReason?: string;
}): SCSEMBenchmarkStoredNarrative {
    const boundedLookupMessage = benchmarkLookupError
        ? boundedStoredSCSEMBenchmarkLookupMessage(benchmarkLookupError)
        : undefined;
    return {
        ...(boundedLookupMessage !== undefined
            ? { benchmarkLookupError: boundedLookupMessage }
            : {}),
        ...(summary !== undefined
            ? {
                summary: replaceExactStoredLookupMessage(
                    summary,
                    benchmarkLookupError,
                    boundedLookupMessage
                ),
            }
            : {}),
        blockers: blockers.map((blocker) =>
            replaceExactStoredLookupMessage(
                blocker,
                benchmarkLookupError,
                boundedLookupMessage
            ) || ""
        ),
        ...(supplementalReason !== undefined
            ? {
                supplementalReason: replaceExactStoredLookupMessage(
                    supplementalReason,
                    benchmarkLookupError,
                    boundedLookupMessage
                ),
            }
            : {}),
    };
}

export function boundedStoredSCSEMBenchmarkAttemptReason(reason: string): string {
    if (
        reason === "Benchmark candidate workbook could not be downloaded or validated." ||
        reason === "downloaded workbook contained no usable recommendation profile" ||
        /^\d+\/\d+ SCSEM recommendation IDs overlap$/.test(reason)
    ) {
        return reason;
    }
    return "Benchmark candidate resolution detail was unavailable.";
}
