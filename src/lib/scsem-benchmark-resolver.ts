import type { CISBenchmark, CISExcelFile } from "@/lib/cis-api";
import {
    isExactCISProductIdentity,
    normalizeRecommendation,
    rankCISBenchmarkCandidatesForTechnology,
    selectApplicableSTIGProfiles,
    selectBestCISProfile,
    type CISBenchmarkCandidateDiagnostic,
    type SelectedCISProfile,
} from "@/lib/cis-benchmark-xlsx";
import {
    downloadAndParseBenchmark,
    type DownloadedBenchmark,
} from "@/lib/scsem-update-engine";
import type { ParsedControl, ParsedSCSEM } from "@/lib/xlsx-parser";
import { scsemBenchmarkCandidateFailureReason } from "@/lib/scsem-benchmark-failure";

export type ResolvedBenchmarkKind = "CIS" | "CIS_STIG";

export interface ResolvedBenchmarkSource {
    kind: ResolvedBenchmarkKind;
    sourceRelationship?: "direct" | "adjacent";
    matchQuery: string;
    matchedSheets: string[];
    selectedProfile: SelectedCISProfile;
    downloaded: DownloadedBenchmark;
    sheetRecommendationCount: number;
    sharedRecommendationCount: number;
    adjacentCategory?: string;
    adjacentRationale?: string;
}

export interface ResolveSCSEMBenchmarkSourcesInput {
    token: string;
    technology: string;
    parsed: ParsedSCSEM;
    benchmarks: CISBenchmark[];
    excelFiles: CISExcelFile[];
    downloadedBenchmarks: Map<number, DownloadedBenchmark>;
}

export type BenchmarkCandidateResolutionOutcome =
    | "accepted"
    | "download_failed"
    | "no_profile"
    | "insufficient_control_overlap";

export interface BenchmarkCandidateResolutionDiagnostic {
    kind: ResolvedBenchmarkKind;
    query: string;
    sheetName: string;
    workbenchId: number;
    benchmarkTitle: string;
    benchmarkVersion: string;
    productFamily: string | null;
    productGeneration: string | null;
    titleScore: number;
    outcome: BenchmarkCandidateResolutionOutcome;
    reason: string;
    sharedRecommendationCount?: number;
    sheetRecommendationCount?: number;
}

export interface BenchmarkQueryResolutionDiagnostic {
    kind: ResolvedBenchmarkKind;
    query: string;
    sheetName: string;
    catalogCandidates: CISBenchmarkCandidateDiagnostic[];
    candidateAttempts: BenchmarkCandidateResolutionDiagnostic[];
}

export interface ResolveSCSEMBenchmarkSourcesDetailedResult {
    sources: ResolvedBenchmarkSource[];
    diagnostics: BenchmarkQueryResolutionDiagnostic[];
}

export function hasUnavailableApplicableBenchmarkQuery(
    diagnostics: BenchmarkQueryResolutionDiagnostic[]
): boolean {
    return diagnostics.some((diagnostic) =>
        diagnostic.candidateAttempts.some((attempt) => attempt.outcome === "download_failed") &&
        !diagnostic.candidateAttempts.some((attempt) => attempt.outcome === "accepted")
    );
}

type CandidateSelection = {
    query: string;
    downloaded: DownloadedBenchmark;
    selectedProfile: SelectedCISProfile;
    sheetRecommendationCount: number;
    sharedRecommendationCount: number;
    score: number;
};

type QueryEvaluationResult = {
    selection: CandidateSelection | null;
    diagnostic: BenchmarkQueryResolutionDiagnostic;
};

type KindResolutionResult = {
    source: ResolvedBenchmarkSource | null;
    diagnostics: BenchmarkQueryResolutionDiagnostic[];
};

type AdjacentBenchmarkPlan = {
    category: string;
    rationale: string;
    queries: string[];
};

const MAX_CANDIDATE_DOWNLOADS_PER_QUERY = 8;
const MAX_CATALOG_DIAGNOSTICS_PER_QUERY = 40;

function normalizeText(value: string | null | undefined): string {
    return (value || "")
        .toLowerCase()
        .replace(/[_/\\:-]+/g, " ")
        .replace(/[^a-z0-9.]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function compactText(value: string | null | undefined): string {
    return normalizeText(value).replace(/[^a-z0-9]+/g, "");
}

function unique(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const value of values) {
        const cleaned = value.replace(/\s+/g, " ").trim();
        const key = cleaned.toLowerCase();
        if (!cleaned || seen.has(key)) continue;
        seen.add(key);
        out.push(cleaned);
    }

    return out;
}

function recommendationCount(controls: Pick<ParsedControl, "recommendationNum">[]): number {
    return controls.filter((control) =>
        Boolean(normalizeRecommendation(control.recommendationNum))
    ).length;
}

function sheetBaseName(sheetName: string): string {
    return normalizeText(sheetName)
        .replace(/\btest cases?\b/g, " ")
        .replace(/\bgeneral\b/g, " ")
        .replace(/\bgen\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isGenericSheetBase(value: string): boolean {
    const normalized = normalizeText(value);
    return !normalized ||
        normalized === "test cases" ||
        normalized === "general test cases" ||
        normalized === "gen test cases" ||
        normalized === "general" ||
        normalized === "gen";
}

function matchedVersion(value: string, patterns: RegExp[]): string | null {
    for (const pattern of patterns) {
        const match = value.match(pattern);
        if (match?.[1]) return match[1];
    }
    return null;
}

function aliasesForText(value: string): string[] {
    const normalized = normalizeText(value);
    const compact = compactText(value);
    const aliases: string[] = [];

    if (compact.includes("db2")) {
        const db2Generation = matchedVersion(normalized, [
            /\bdb2\s*v(?:ersion\s*)?(\d{1,2}(?:\.\d+)?)\b/,
            /\bdb2\s+(\d{1,2}(?:\.\d+)?)\b/,
        ]);
        const isZos = compact.includes("zos") || normalized.includes("z os");
        if (db2Generation) {
            aliases.push(`IBM Db2 ${db2Generation}${isZos ? " for z/OS" : ""}`);
        } else {
            aliases.push(`IBM Db2${isZos ? " for z/OS" : ""}`);
        }
    }

    if (compact.includes("apache24") || /apache.*2\s*\.?\s*4/.test(normalized)) {
        aliases.push("Apache HTTP Server 2.4");
    } else if (normalized.includes("apache http")) {
        aliases.push("Apache HTTP Server");
    }

    if (compact.includes("iis10") || /iis\s*10/.test(normalized)) {
        aliases.push("Microsoft IIS 10");
    } else if (/\biis\b/.test(normalized)) {
        aliases.push("Microsoft IIS");
    }

    if (compact.includes("tomcat9") || /tomcat\s*9/.test(normalized)) aliases.push("Apache Tomcat 9");
    else if (normalized.includes("tomcat")) aliases.push("Apache Tomcat");

    if (normalized.includes("nginx")) aliases.push("NGINX");
    if (normalized.includes("mysql")) {
        const version = matchedVersion(normalized, [/\bmysql\s*(\d+(?:\.\d+)?)\b/]);
        aliases.push(version ? `MySQL ${version}` : "MySQL");
    }
    if (normalized.includes("mongodb")) {
        const version = matchedVersion(normalized, [/\bmongodb\s*(\d+(?:\.\d+)?)\b/]);
        aliases.push(version ? `MongoDB ${version}` : "MongoDB");
    }
    if (normalized.includes("postgresql")) {
        const version = matchedVersion(normalized, [/\bpostgresql\s*(\d+(?:\.\d+)?)\b/]);
        aliases.push(version ? `PostgreSQL ${version}` : "PostgreSQL");
    }
    if (normalized.includes("microsoft sql server") || /\bsql server\b/.test(normalized) || /\bsql\s*\d{4}\b/.test(normalized)) {
        const version = matchedVersion(normalized, [
            /\bsql server\s*(\d{4})\b/,
            /\bsql\s*(\d{4})\b/,
        ]);
        aliases.push(version ? `Microsoft SQL Server ${version}` : "Microsoft SQL Server");
    }
    if (normalized.includes("oracle database") || normalized === "oracle" || (/\boracle\b/.test(normalized) && normalized.includes("rdbms"))) {
        const databaseVersion = matchedVersion(normalized, [/\boracle database\s*(\d{1,2}(?:c|ai)?)/]);
        const rdbmsVersion = matchedVersion(normalized, [/\boracle\s*(\d{1,2})\s+rdbms\b/]);
        const version = databaseVersion || (rdbmsVersion ? `${rdbmsVersion}c` : null);
        aliases.push(version ? `Oracle Database ${version}` : "Oracle Database");
    }
    if (normalized.includes("teradata")) aliases.push("Teradata");

    if (normalized.includes("red hat enterprise linux") || /\brhel\s*\d*\b/.test(normalized)) {
        const rhelGeneration = matchedVersion(normalized, [
            /\brhel\s*(\d{1,2})\b/,
            /\bred hat enterprise linux\s*(\d{1,2})\b/,
        ]);
        aliases.push(rhelGeneration
            ? `Red Hat Enterprise Linux ${rhelGeneration}`
            : "Red Hat Enterprise Linux");
    }
    if (normalized.includes("oracle linux") || /\boel\b/.test(normalized)) aliases.push("Oracle Linux");
    if (normalized.includes("suse")) aliases.push("SUSE Linux Enterprise");
    if (normalized.includes("debian")) aliases.push("Debian Linux");
    if (normalized.includes("aix")) aliases.push("IBM AIX");
    if (normalized.includes("solaris")) aliases.push("Oracle Solaris");

    if (normalized.includes("vmware") || normalized.includes("esxi")) {
        const esxiGeneration = matchedVersion(normalized, [
            /\besxi\s*(\d+(?:\.\d+)?)\b/,
            /\bvsphere\s*(\d+(?:\.\d+)?)\s+esxi\b/,
        ]);
        aliases.push(esxiGeneration ? `VMware ESXi ${esxiGeneration}` : "VMware ESXi");
    }

    if (normalized.includes("amazon linux")) {
        const amazonLinuxGeneration = matchedVersion(normalized, [
            /\bamazon linux\s*(2023|\d+)\b/,
        ]);
        aliases.push(amazonLinuxGeneration
            ? `Amazon Linux ${amazonLinuxGeneration}`
            : "Amazon Linux");
    } else if (/\baws\b/.test(normalized) || normalized.includes("amazon web services")) {
        if (normalized.includes("end user compute")) {
            aliases.push("AWS End User Compute Services");
        } else if (/\bcompute(?: services?)?\b/.test(normalized)) {
            aliases.push("AWS Compute Services");
        } else if (/\bstorage(?: services?)?\b/.test(normalized)) {
            aliases.push("AWS Storage Services");
        } else if (/\bdatabase(?: services?)?\b/.test(normalized)) {
            aliases.push("AWS Database Services");
        } else if (/\bfoundations?\b/.test(normalized)) {
            aliases.push("Amazon Web Services Foundations");
        } else {
            // A generic AWS workbook may span multiple benchmark families. Each
            // is evaluated against the actual SCSEM recommendation IDs and the
            // best-supported family wins.
            aliases.push(
                "Amazon Web Services Foundations",
                "AWS Compute Services",
                "AWS Storage Services",
                "AWS Database Services",
                "AWS End User Compute Services"
            );
        }
    }
    if (normalized.includes("windows server 2022")) aliases.push("Microsoft Windows Server 2022");
    else if (normalized.includes("windows server 2019")) aliases.push("Microsoft Windows Server 2019");
    else if (normalized.includes("windows server 2016")) aliases.push("Microsoft Windows Server 2016");
    else if (normalized.includes("windows server 2012")) aliases.push("Microsoft Windows Server 2012 R2");
    else if (normalized.includes("windows 11")) aliases.push("Microsoft Windows 11");
    else if (normalized.includes("windows 10")) aliases.push("Microsoft Windows 10");
    if (normalized.includes("macos") || normalized.includes("mac os")) aliases.push("Apple macOS");
    if (normalized.includes("rocky")) aliases.push("Rocky Linux");
    if (normalized.includes("fortigate")) aliases.push("Fortinet FortiGate");
    if (normalized.includes("check point")) aliases.push("Check Point Firewall");
    if (normalized.includes("cisco asa")) aliases.push("Cisco ASA");
    if (normalized.includes("palo alto")) aliases.push("Palo Alto Firewall");
    if (normalized.includes("apple") && (normalized.includes("ios") || normalized.includes("ipados"))) {
        aliases.push("Apple iOS");
    }

    return unique(aliases);
}

function unsafeBroadQuery(query: string): boolean {
    const normalized = normalizeText(query);
    if (/\bgeneric\b/.test(normalized)) return true;

    if (normalized.includes("storage area network") || normalized.includes("network attached storage")) return true;

    return normalized === "web server" ||
        normalized === "webserver" ||
        normalized === "generic web server" ||
        normalized === "san" ||
        normalized === "nas" ||
        normalized === "database" ||
        normalized === "generic database" ||
        normalized === "application" ||
        normalized === "generic application" ||
        normalized === "cloud" ||
        normalized === "network assessment" ||
        normalized === "voip network" ||
        normalized === "wireless networking" ||
        normalized === "printer" ||
        normalized === "containers" ||
        normalized === "operating system" ||
        normalized === "generic os";
}

function adjacentPlansForTechnology(technology: string, parsed: ParsedSCSEM): AdjacentBenchmarkPlan[] {
    const haystack = normalizeText([
        technology,
        parsed.metadata.subject,
        ...parsed.sheets.map((sheet) => sheet.sheetName),
    ].filter(Boolean).join(" "));

    const plans: AdjacentBenchmarkPlan[] = [];

    if (
        haystack.includes("storage area network") ||
        haystack.includes("network attached storage") ||
        /\bsan\b/.test(haystack) ||
        /\bnas\b/.test(haystack)
    ) {
        plans.push({
            category: "Network management-plane hardening patterns",
            rationale: "No storage-array CIS Benchmark or CIS-STIG workbook was found in CIS WorkBench. Network device benchmarks are adjacent evidence for AAA, management access, logging, time sync, encryption, configuration backup, and administrative-plane controls that commonly apply to SAN/NAS management interfaces.",
            queries: [
                "Cisco NX-OS",
                "Cisco IOS XE 17.x",
                "HPE Aruba Networking CX Switch",
                "ExtremeNetworks-SLX-OS-20.X.X",
            ],
        });
    }

    if (haystack.includes("generic web server") || haystack.includes("web server") || haystack.includes("webserver")) {
        plans.push({
            category: "Web platform hardening patterns",
            rationale: "No single generic web-server CIS Benchmark or CIS-STIG workbook exists in CIS WorkBench. Apache HTTP Server, NGINX, IIS, and Tomcat benchmarks are adjacent evidence for TLS, request handling, authentication, directory exposure, logging, error handling, and management hardening patterns.",
            queries: [
                "Apache HTTP Server 2.4",
                "NGINX",
                "Microsoft IIS 10",
                "Apache Tomcat 10.1",
            ],
        });
    }

    if (haystack.includes("gentax")) {
        plans.push({
            category: "Enterprise application platform hardening patterns",
            rationale: "No GenTax-specific CIS Benchmark or CIS-STIG workbook was found in CIS WorkBench. Web/application server and database benchmarks are adjacent evidence for authentication, session handling, audit logging, encryption, service accounts, and data-tier privilege patterns that may apply to an enterprise tax application SCSEM.",
            queries: [
                "Apache Tomcat 10.1",
                "Microsoft IIS 10",
                "Oracle Database 19c",
                "Microsoft SQL Server 2022 Database",
            ],
        });
    }

    return plans;
}

function rawQuery(value: string | null | undefined): string | null {
    const normalized = normalizeText(value)
        .replace(/\bscsem\b/g, " ")
        .replace(/\btest cases?\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!normalized || unsafeBroadQuery(normalized)) return null;
    return normalized;
}

function workbookLevelQueries(technology: string, parsed: ParsedSCSEM): string[] {
    return unique([
        ...aliasesForText(technology),
        ...aliasesForText(parsed.metadata.subject || ""),
        rawQuery(technology) || "",
        rawQuery(parsed.metadata.subject) || "",
    ]).filter((query) => !unsafeBroadQuery(query));
}

function sheetQueries(sheetName: string, technology: string, parsed: ParsedSCSEM): string[] {
    const base = sheetBaseName(sheetName);
    const sheetAliases = aliasesForText(base);
    if (sheetAliases.length > 0) {
        return sheetAliases.filter((query) => !unsafeBroadQuery(query));
    }

    if (isGenericSheetBase(sheetName) || isGenericSheetBase(base)) {
        return workbookLevelQueries(technology, parsed);
    }

    return unique([
        ...aliasesForText(sheetName),
        ...workbookLevelQueries(technology, parsed),
    ]).filter((query) => !unsafeBroadQuery(query));
}

/**
 * Returns the exact WorkBench lookup queries used for one SCSEM tab. Keeping
 * this visible to tests prevents a version-specific tab from silently gaining
 * a broad family fallback that can select a different product generation.
 */
export function scsemBenchmarkQueriesForSheet(
    sheetName: string,
    technology: string,
    parsed: ParsedSCSEM
): string[] {
    return sheetQueries(sheetName, technology, parsed);
}

function sourceKey(kind: ResolvedBenchmarkKind, downloaded: DownloadedBenchmark, profile: string): string {
    return `${kind}:${Number(downloaded.snapshot.workbenchId)}:${profile}`;
}

function mergeSource(
    byKey: Map<string, ResolvedBenchmarkSource>,
    source: ResolvedBenchmarkSource
) {
    const key = sourceKey(source.kind, source.downloaded, source.selectedProfile.profile);
    const existing = byKey.get(key);
    if (!existing) {
        byKey.set(key, source);
        return;
    }

    existing.matchQuery = unique([existing.matchQuery, source.matchQuery]).join(", ");
    existing.matchedSheets = unique([...existing.matchedSheets, ...source.matchedSheets]);
    existing.sheetRecommendationCount += source.sheetRecommendationCount;
    existing.sharedRecommendationCount += source.sharedRecommendationCount;
}

function selectionScore(selection: SelectedCISProfile, sheetRefCount: number): number {
    if (sheetRefCount <= 0) return 0;
    const sharedRatio = selection.sharedRecommendationCount / sheetRefCount;
    const profileRatio = selection.totalRecommendationCount > 0
        ? selection.sharedRecommendationCount / selection.totalRecommendationCount
        : 0;
    return selection.sharedRecommendationCount * 2 + sharedRatio * 100 + profileRatio * 35;
}

export function isCISBenchmarkSelectionAccepted(
    selection: SelectedCISProfile,
    sheetRefCount: number,
    exactProductIdentity: boolean
): boolean {
    if (selection.totalRecommendationCount <= 0) return false;
    if (sheetRefCount <= 0) return exactProductIdentity;
    const shared = selection.sharedRecommendationCount;
    const sharedRatio = shared / sheetRefCount;

    if (sheetRefCount <= 5 && shared === sheetRefCount) return true;
    if (shared >= 5 && sharedRatio >= 0.45) return true;

    // A newly accepted benchmark can renumber, split, or add recommendations,
    // which is exactly when the updater must surface new CIS controls. Requiring
    // 45% overlap made an exact product/generation match disappear whenever the
    // new benchmark changed enough to need review. Catalog ranking has already
    // rejected wrong families, generations, unpublished workbooks, and STIG
    // variants before this point. Only an exact recognized product/generation
    // identity can proceed with low or zero recommendation-ID overlap;
    // substring title similarity alone is never sufficient.
    return exactProductIdentity;
}

async function evaluateQuery({
    kind,
    query,
    sheetName,
    controls,
    token,
    benchmarks,
    excelFiles,
    downloadedBenchmarks,
}: {
    kind: ResolvedBenchmarkKind;
    query: string;
    sheetName: string;
    controls: ParsedControl[];
    token: string;
    benchmarks: CISBenchmark[];
    excelFiles: CISExcelFile[];
    downloadedBenchmarks: Map<number, DownloadedBenchmark>;
}): Promise<QueryEvaluationResult> {
    const ranking = rankCISBenchmarkCandidatesForTechnology(
        query,
        benchmarks,
        excelFiles,
        kind === "CIS" ? "benchmark" : "stig"
    );
    const candidateAttempts: BenchmarkCandidateResolutionDiagnostic[] = [];
    const sheetRecommendationCount = recommendationCount(controls);
    const diagnostic = (): BenchmarkQueryResolutionDiagnostic => ({
        kind,
        query,
        sheetName,
        catalogCandidates: ranking.diagnostics.slice(0, MAX_CATALOG_DIAGNOSTICS_PER_QUERY),
        candidateAttempts,
    });

    for (const candidate of ranking.candidates.slice(0, MAX_CANDIDATE_DOWNLOADS_PER_QUERY)) {
        const attemptBase = {
            kind,
            query,
            sheetName,
            workbenchId: Number(candidate.benchmark.workbenchId),
            benchmarkTitle: candidate.benchmark.benchmarkTitle,
            benchmarkVersion: candidate.benchmark.benchmarkVersion,
            productFamily: candidate.productFamily,
            productGeneration: candidate.productGeneration,
            titleScore: candidate.titleScore,
            sheetRecommendationCount,
        };
        let downloaded: DownloadedBenchmark;

        try {
            downloaded = await downloadAndParseBenchmark(
                token,
                candidate.benchmark,
                candidate.excel,
                downloadedBenchmarks
            );
        } catch (error) {
            candidateAttempts.push({
                ...attemptBase,
                outcome: "download_failed",
                reason: scsemBenchmarkCandidateFailureReason(error),
            });
            continue;
        }

        const selectedProfile = kind === "CIS"
            ? selectBestCISProfile(sheetName, controls, downloaded.recommendations)
            : selectApplicableSTIGProfiles(sheetName, controls, downloaded.recommendations);
        if (!selectedProfile) {
            candidateAttempts.push({
                ...attemptBase,
                outcome: "no_profile",
                reason: "downloaded workbook contained no usable recommendation profile",
            });
            continue;
        }

        const candidateTitleText = [
            candidate.benchmark.benchmarkTitle,
            candidate.excel.excelTitle,
            candidate.excel.excelFileName,
        ].filter(Boolean).join(" ");
        const exactProductIdentity = isExactCISProductIdentity(query, candidateTitleText);
        if (!isCISBenchmarkSelectionAccepted(selectedProfile, sheetRecommendationCount, exactProductIdentity)) {
            candidateAttempts.push({
                ...attemptBase,
                outcome: "insufficient_control_overlap",
                reason: `${selectedProfile.sharedRecommendationCount}/${sheetRecommendationCount} SCSEM recommendation IDs overlap`,
                sharedRecommendationCount: selectedProfile.sharedRecommendationCount,
            });
            continue;
        }

        candidateAttempts.push({
            ...attemptBase,
            outcome: "accepted",
            reason: `${selectedProfile.sharedRecommendationCount}/${sheetRecommendationCount} SCSEM recommendation IDs overlap`,
            sharedRecommendationCount: selectedProfile.sharedRecommendationCount,
        });

        return {
            selection: {
                query,
                downloaded,
                selectedProfile,
                sheetRecommendationCount,
                sharedRecommendationCount: selectedProfile.sharedRecommendationCount,
                score: selectionScore(selectedProfile, sheetRecommendationCount),
            },
            diagnostic: diagnostic(),
        };
    }

    return {
        selection: null,
        diagnostic: diagnostic(),
    };
}

async function evaluateAdjacentQuery({
    kind,
    query,
    category,
    rationale,
    parsed,
    token,
    benchmarks,
    excelFiles,
    downloadedBenchmarks,
}: {
    kind: ResolvedBenchmarkKind;
    query: string;
    category: string;
    rationale: string;
    parsed: ParsedSCSEM;
    token: string;
    benchmarks: CISBenchmark[];
    excelFiles: CISExcelFile[];
    downloadedBenchmarks: Map<number, DownloadedBenchmark>;
}): Promise<ResolvedBenchmarkSource | null> {
    const allControls = parsed.sheets
        .filter((candidate) => candidate.sheetType === "test_cases")
        .flatMap((sheet) => sheet.controls);
    const ranking = rankCISBenchmarkCandidatesForTechnology(
        query,
        benchmarks,
        excelFiles,
        kind === "CIS" ? "benchmark" : "stig"
    );

    for (const candidate of ranking.candidates.slice(0, MAX_CANDIDATE_DOWNLOADS_PER_QUERY)) {
        let downloaded: DownloadedBenchmark;
        try {
            downloaded = await downloadAndParseBenchmark(
                token,
                candidate.benchmark,
                candidate.excel,
                downloadedBenchmarks
            );
        } catch {
            continue;
        }

        const selectedProfile = kind === "CIS"
            ? selectBestCISProfile(query, allControls, downloaded.recommendations)
            : selectApplicableSTIGProfiles(query, allControls, downloaded.recommendations);
        if (!selectedProfile) continue;

        return {
            kind,
            sourceRelationship: "adjacent",
            matchQuery: query,
            matchedSheets: parsed.sheets
                .filter((candidateSheet) => candidateSheet.sheetType === "test_cases")
                .map((sheet) => sheet.sheetName),
            selectedProfile,
            downloaded,
            sheetRecommendationCount: recommendationCount(allControls),
            sharedRecommendationCount: selectedProfile.sharedRecommendationCount,
            adjacentCategory: category,
            adjacentRationale: rationale,
        };
    }

    return null;
}

async function resolveKindForSheet({
    kind,
    queries,
    sheetName,
    controls,
    token,
    benchmarks,
    excelFiles,
    downloadedBenchmarks,
}: {
    kind: ResolvedBenchmarkKind;
    queries: string[];
    sheetName: string;
    controls: ParsedControl[];
    token: string;
    benchmarks: CISBenchmark[];
    excelFiles: CISExcelFile[];
    downloadedBenchmarks: Map<number, DownloadedBenchmark>;
}): Promise<KindResolutionResult> {
    const evaluations = await Promise.all(queries.map((query) => evaluateQuery({
        kind,
        query,
        sheetName,
        controls,
        token,
        benchmarks,
        excelFiles,
        downloadedBenchmarks,
    })));
    const selected = evaluations
        .map((evaluation) => evaluation.selection)
        .filter((candidate): candidate is CandidateSelection => Boolean(candidate))
        .sort((a, b) => b.score - a.score)[0];
    const diagnostics = evaluations.map((evaluation) => evaluation.diagnostic);
    if (!selected) return { source: null, diagnostics };

    return {
        source: {
            kind,
            sourceRelationship: "direct",
            matchQuery: selected.query,
            matchedSheets: [sheetName],
            selectedProfile: selected.selectedProfile,
            downloaded: selected.downloaded,
            sheetRecommendationCount: selected.sheetRecommendationCount,
            sharedRecommendationCount: selected.sharedRecommendationCount,
        },
        diagnostics,
    };
}

export async function resolveSCSEMBenchmarkSourcesDetailed({
    token,
    technology,
    parsed,
    benchmarks,
    excelFiles,
    downloadedBenchmarks,
}: ResolveSCSEMBenchmarkSourcesInput): Promise<ResolveSCSEMBenchmarkSourcesDetailedResult> {
    const byKey = new Map<string, ResolvedBenchmarkSource>();
    const diagnostics: BenchmarkQueryResolutionDiagnostic[] = [];

    for (const sheet of parsed.sheets.filter((candidate) => candidate.sheetType === "test_cases")) {
        if (sheet.controls.length === 0) continue;

        const queries = sheetQueries(sheet.sheetName, technology, parsed);
        if (queries.length === 0) continue;

        const [cisResolution, stigResolution] = await Promise.all([
            resolveKindForSheet({
                kind: "CIS",
                queries,
                sheetName: sheet.sheetName,
                controls: sheet.controls,
                token,
                benchmarks,
                excelFiles,
                downloadedBenchmarks,
            }),
            resolveKindForSheet({
                kind: "CIS_STIG",
                queries,
                sheetName: sheet.sheetName,
                controls: sheet.controls,
                token,
                benchmarks,
                excelFiles,
                downloadedBenchmarks,
            }),
        ]);

        diagnostics.push(...cisResolution.diagnostics, ...stigResolution.diagnostics);
        if (cisResolution.source) mergeSource(byKey, cisResolution.source);
        if (stigResolution.source) mergeSource(byKey, stigResolution.source);
    }

    const sources = [...byKey.values()].sort((a, b) => {
        const kindDiff = a.kind.localeCompare(b.kind);
        if (kindDiff !== 0) return kindDiff;
        return a.downloaded.snapshot.benchmarkTitle.localeCompare(b.downloaded.snapshot.benchmarkTitle);
    });

    return { sources, diagnostics };
}

/**
 * Backwards-compatible source-only resolver. New diagnostic consumers can call
 * resolveSCSEMBenchmarkSourcesDetailed without requiring route/UI changes here.
 */
export async function resolveSCSEMBenchmarkSources(
    input: ResolveSCSEMBenchmarkSourcesInput
): Promise<ResolvedBenchmarkSource[]> {
    return (await resolveSCSEMBenchmarkSourcesDetailed(input)).sources;
}

export async function resolveAdjacentSCSEMBenchmarkSources({
    token,
    technology,
    parsed,
    benchmarks,
    excelFiles,
    downloadedBenchmarks,
    excludeSources = [],
}: ResolveSCSEMBenchmarkSourcesInput & {
    excludeSources?: ResolvedBenchmarkSource[];
}): Promise<ResolvedBenchmarkSource[]> {
    const plans = adjacentPlansForTechnology(technology, parsed);
    if (plans.length === 0) return [];

    const excluded = new Set(excludeSources.map((source) =>
        sourceKey(source.kind, source.downloaded, source.selectedProfile.profile)
    ));
    const byKey = new Map<string, ResolvedBenchmarkSource>();

    for (const plan of plans) {
        const sourceSets = await Promise.all(plan.queries.map(async (query) => {
            const [cisSource, stigSource] = await Promise.all([
                evaluateAdjacentQuery({
                    kind: "CIS",
                    query,
                    category: plan.category,
                    rationale: plan.rationale,
                    parsed,
                    token,
                    benchmarks,
                    excelFiles,
                    downloadedBenchmarks,
                }),
                evaluateAdjacentQuery({
                    kind: "CIS_STIG",
                    query,
                    category: plan.category,
                    rationale: plan.rationale,
                    parsed,
                    token,
                    benchmarks,
                    excelFiles,
                    downloadedBenchmarks,
                }),
            ]);

            return [cisSource, stigSource].filter(Boolean) as ResolvedBenchmarkSource[];
        }));

        for (const source of sourceSets.flat()) {
            const key = sourceKey(source.kind, source.downloaded, source.selectedProfile.profile);
            if (excluded.has(key) || byKey.has(key)) continue;
            byKey.set(key, source);
        }
    }

    return [...byKey.values()]
        .sort((a, b) => {
            const categoryDiff = (a.adjacentCategory || "").localeCompare(b.adjacentCategory || "");
            if (categoryDiff !== 0) return categoryDiff;
            const kindDiff = a.kind.localeCompare(b.kind);
            if (kindDiff !== 0) return kindDiff;
            return a.downloaded.snapshot.benchmarkTitle.localeCompare(b.downloaded.snapshot.benchmarkTitle);
        })
        .slice(0, 6);
}
