import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { parseSCSEMFile } from "../src/lib/xlsx-parser";

XLSX.set_fs(fs);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const EXPECTED_WORKBOOK_COUNT = 58;
const DEFAULT_ROUNDTRIP_ROOT =
    "/Users/jamesgalang/Documents/Mac Mini/skyshield-retest-20260721/native-excel-roundtrip";
const DEFAULT_REPORT_PATH =
    "/Users/jamesgalang/Documents/Mac Mini/skyshield-retest-20260721/corpus-reports/native-excel-roundtrip-report.json";
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 600_000;
const OPERATIONS = ["update", "add"] as const;

type Operation = typeof OPERATIONS[number];
type RunMode = "run" | "preflight" | "self-test" | "help";

type CliOptions = {
    mode: RunMode;
    finalExportDir?: string;
    outputDir?: string;
    reportPath?: string;
    sourceManifestPath?: string;
    corpusReportDir?: string;
    timeoutMs?: number;
};

type HarnessConfig = {
    finalExportDir: string;
    outputDir: string;
    reportPath: string;
    sourceManifestPath: string;
    corpusReportDir: string | null;
    timeoutMs: number;
};

type ManifestEntry = {
    fileName: string;
    file: string;
    sha256: string;
    sizeBytes: number;
    totalControls: number;
};

type SourceManifest = {
    expectedWorkbookCount: number;
    workbooks: ManifestEntry[];
};

type FileEvidence = {
    path: string;
    sha256: string;
    sizeBytes: number;
};

type WorkItem = {
    operation: Operation;
    index: number;
    source: FileEvidence & { fileName: string; totalControls: number };
    export: FileEvidence & { fileName: string };
    roundtripPath: string;
};

type Blocker = {
    code: string;
    message: string;
};

type PreflightFacts = {
    platform: string;
    screenLocked: boolean | null;
    lockSource: string;
    excelAppPath: string | null;
    excelVersion: string | null;
    excelBuild: string | null;
    excelRunning: boolean | null;
    candidateCounts: Record<Operation, number | null>;
    plannedWorkbookCount: number;
    outputWasEmpty: boolean | null;
};

type PreflightResult = {
    ready: boolean;
    blockers: Blocker[];
    facts: PreflightFacts;
    workItems: WorkItem[];
};

type CanonicalCell = {
    type: string;
    value: string | number | boolean | null;
};

type CanonicalFormula = {
    formula: string | null;
    arrayRef: string | null;
};

type ControlIdentity = {
    sheetName: string;
    rowIndex: number;
    testId: string;
};

type WorkbookSnapshot = {
    sheetOrder: string[];
    sheetVisibility: Array<{ sheetName: string; hidden: number }>;
    controls: ControlIdentity[];
    nonFormulaCells: Record<string, CanonicalCell>;
    formulas: Record<string, CanonicalFormula>;
    styleProjection: Record<string, unknown>;
    mergedRanges: Record<string, string[]>;
    definedNames: Array<Record<string, unknown>>;
    printAreas: Array<Record<string, unknown>>;
    worksheetFeatures: Record<string, Record<string, string[]>>;
    workbookProtection: string[];
    tableAutoFilters: string[];
    formulaCacheErrors: Array<{ sheetName: string; address: string; error: string }>;
};

type VerificationCheck = {
    name: string;
    passed: boolean;
    expectedCount?: number;
    actualCount?: number;
    expectedSha256: string;
    actualSha256: string;
    difference?: string;
};

type VerificationResult = {
    success: boolean;
    checks: VerificationCheck[];
    formulaCacheErrors: {
        count: number;
        sample: Array<{ sheetName: string; address: string; error: string }>;
        note: string;
    };
    approvedOrAddDeltaPreserved: boolean;
    visualVerificationPerformed: false;
};

const EXCEL_ERROR_CODES: Record<number, string> = {
    0: "#NULL!",
    7: "#DIV/0!",
    15: "#VALUE!",
    23: "#REF!",
    29: "#NAME?",
    36: "#NUM!",
    42: "#N/A",
    43: "#GETTING_DATA",
};

type RoundtripEntry = {
    operation: Operation;
    index: number;
    source: FileEvidence & { fileName: string };
    export: FileEvidence & { fileName: string };
    roundtrip: (FileEvidence & { fileName: string }) | null;
    durationMs: number | null;
    verificationDurationMs: number | null;
    excelVersion: string | null;
    excelBuild: string | null;
    success: boolean;
    blocker: Blocker | null;
    verification: VerificationResult | null;
};

type HarnessReport = {
    schemaVersion: 1;
    kind: "native-microsoft-excel-corpus-roundtrip";
    generatedAt: string;
    updatedAt: string;
    status: "blocked" | "ready" | "running" | "failed" | "passed";
    mode: RunMode;
    scope: {
        expectedPerOperation: number;
        expectedTotal: number;
        operations: readonly Operation[];
    };
    limitations: {
        visualVerificationPerformed: false;
        complianceCertificationPerformed: false;
        note: string;
    };
    configuration: Partial<HarnessConfig>;
    preflight: Omit<PreflightResult, "workItems"> | null;
    summary: {
        attempted: number;
        passed: number;
        failed: number;
        remaining: number;
    };
    entries: RoundtripEntry[];
};

class HarnessBlocker extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "HarnessBlocker";
        this.code = code;
    }
}

const EXCEL_APPLESCRIPT = String.raw`on run argv
    set sourcePath to item 1 of argv
    set outputPath to item 2 of argv
    set sourceWorkbook to missing value
    tell application id "com.microsoft.Excel"
        set priorDisplayAlerts to display alerts
        set display alerts to true
        try
            if (count of workbooks) is not 0 then
                error "SAFETY_BLOCKER_EXISTING_WORKBOOKS: Excel has an open workbook; save and close all Excel workbooks before running this harness."
            end if
            set sourceWorkbook to open workbook workbook file name sourcePath update links do not update links read only true add to mru false
            calculate full rebuild
            save workbook as sourceWorkbook filename outputPath file format Excel XML file format
            set runtimeVersion to version as string
            set runtimeBuild to build as string
            close sourceWorkbook saving no
            set sourceWorkbook to missing value
            set display alerts to priorDisplayAlerts
            return "OK" & tab & runtimeVersion & tab & runtimeBuild
        on error errorMessage number errorNumber
            if sourceWorkbook is not missing value then
                try
                    close sourceWorkbook saving no
                end try
            end if
            try
                set display alerts to priorDisplayAlerts
            end try
            error errorMessage number errorNumber
        end try
    end tell
end run`;

function usage(): string {
    return [
        "Native Microsoft Excel round-trip validation for all 116 final SCSEM candidates.",
        "",
        "Required:",
        "  SCSEM_CORPUS_FINAL_EXPORT_DIR=<directory containing update/ and add/>",
        "",
        "Optional:",
        `  SCSEM_NATIVE_EXCEL_OUTPUT_DIR=${DEFAULT_ROUNDTRIP_ROOT}`,
        `  SCSEM_NATIVE_EXCEL_REPORT_PATH=${DEFAULT_REPORT_PATH}`,
        "  SCSEM_NATIVE_EXCEL_SOURCE_MANIFEST=<path> (default: data/scsem-manifest.json)",
        "  SCSEM_CORPUS_REPORT_DIR=<directory containing scsem-{update,add}-corpus-report.json>",
        `  SCSEM_NATIVE_EXCEL_TIMEOUT_MS=${DEFAULT_TIMEOUT_MS} (${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS})`,
        "",
        "Modes:",
        "  --preflight   Read-only checks only; never launches Excel.",
        "  --self-test   Static/unit tests only; never launches Excel.",
        "  --help        Show this help.",
        "",
        "The default mode performs one-file-at-a-time Excel round trips only after preflight passes.",
        "Existing output files are never overwritten, and Excel is never quit or force-quit.",
    ].join("\n");
}

function parseInteger(value: string, label: string): number {
    if (!/^\d+$/.test(value)) throw new HarnessBlocker("INVALID_ARGUMENT", `${label} must be an integer.`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new HarnessBlocker("INVALID_ARGUMENT", `${label} is outside the safe integer range.`);
    return parsed;
}

function parseCli(argv: string[]): CliOptions {
    const options: CliOptions = { mode: "run" };
    const setMode = (mode: RunMode) => {
        if (options.mode !== "run" && options.mode !== mode) {
            throw new HarnessBlocker("INVALID_ARGUMENT", "Choose only one of --preflight, --self-test, or --help.");
        }
        options.mode = mode;
    };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === "--preflight") setMode("preflight");
        else if (argument === "--self-test") setMode("self-test");
        else if (argument === "--help" || argument === "-h") setMode("help");
        else if (argument === "--final-export-dir") options.finalExportDir = requiredArgument(argv, ++index, argument);
        else if (argument === "--output-dir") options.outputDir = requiredArgument(argv, ++index, argument);
        else if (argument === "--report-path") options.reportPath = requiredArgument(argv, ++index, argument);
        else if (argument === "--source-manifest") options.sourceManifestPath = requiredArgument(argv, ++index, argument);
        else if (argument === "--corpus-report-dir") options.corpusReportDir = requiredArgument(argv, ++index, argument);
        else if (argument === "--timeout-ms") options.timeoutMs = parseInteger(requiredArgument(argv, ++index, argument), argument);
        else throw new HarnessBlocker("INVALID_ARGUMENT", `Unknown argument: ${argument}`);
    }
    return options;
}

function requiredArgument(argv: string[], index: number, option: string): string {
    const value = argv[index]?.trim();
    if (!value || value.startsWith("--")) throw new HarnessBlocker("INVALID_ARGUMENT", `${option} requires a value.`);
    return value;
}

function optionalPath(cliValue: string | undefined, envValue: string | undefined): string | undefined {
    const value = cliValue?.trim() || envValue?.trim();
    return value ? path.resolve(value) : undefined;
}

function buildConfig(
    options: CliOptions,
    env: Readonly<Record<string, string | undefined>> = process.env
): HarnessConfig {
    const finalExportDir = optionalPath(options.finalExportDir, env.SCSEM_CORPUS_FINAL_EXPORT_DIR);
    if (!finalExportDir) {
        throw new HarnessBlocker(
            "FINAL_EXPORT_DIR_REQUIRED",
            "SCSEM_CORPUS_FINAL_EXPORT_DIR is required and must contain update/ and add/ candidate directories."
        );
    }
    const timeoutMs = options.timeoutMs ?? parseInteger(env.SCSEM_NATIVE_EXCEL_TIMEOUT_MS?.trim() || String(DEFAULT_TIMEOUT_MS), "timeout");
    if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
        throw new HarnessBlocker(
            "INVALID_TIMEOUT",
            `Per-file timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} milliseconds.`
        );
    }
    return {
        finalExportDir,
        outputDir: optionalPath(options.outputDir, env.SCSEM_NATIVE_EXCEL_OUTPUT_DIR) || DEFAULT_ROUNDTRIP_ROOT,
        reportPath: optionalPath(options.reportPath, env.SCSEM_NATIVE_EXCEL_REPORT_PATH) || DEFAULT_REPORT_PATH,
        sourceManifestPath: optionalPath(options.sourceManifestPath, env.SCSEM_NATIVE_EXCEL_SOURCE_MANIFEST) ||
            path.join(ROOT, "data", "scsem-manifest.json"),
        corpusReportDir: optionalPath(options.corpusReportDir, env.SCSEM_CORPUS_REPORT_DIR) || null,
        timeoutMs,
    };
}

function sha256(buffer: Buffer | string): string {
    return createHash("sha256").update(buffer).digest("hex");
}

function evidence(filePath: string): FileEvidence {
    const bytes = fs.readFileSync(filePath);
    return { path: filePath, sha256: sha256(bytes), sizeBytes: bytes.length };
}

function updatedSCSEMFileName(originalFileName: string): string {
    const originalExtension = path.extname(originalFileName);
    const extension = originalExtension.toLowerCase() === ".xlsm" ? ".xlsm" : ".xlsx";
    const base = path.basename(originalFileName, originalExtension || extension)
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "Safeguards-SCSEM";
    return `${base}-updated${extension}`;
}

function caseKey(value: string): string {
    return value.toLocaleLowerCase("en-US");
}

function loadSourceManifest(manifestPath: string, expectedCount = EXPECTED_WORKBOOK_COUNT): SourceManifest {
    if (!fs.existsSync(manifestPath)) throw new HarnessBlocker("SOURCE_MANIFEST_MISSING", `Source manifest is missing: ${manifestPath}`);
    let manifest: SourceManifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as SourceManifest;
    } catch (error) {
        throw new HarnessBlocker("SOURCE_MANIFEST_INVALID", `Cannot parse source manifest ${manifestPath}: ${errorMessage(error)}`);
    }
    if (manifest.expectedWorkbookCount !== expectedCount || !Array.isArray(manifest.workbooks) || manifest.workbooks.length !== expectedCount) {
        throw new HarnessBlocker(
            "SOURCE_MANIFEST_COUNT_WRONG",
            `Source manifest must declare exactly ${expectedCount} workbooks; found ${manifest.workbooks?.length ?? "invalid"}.`
        );
    }
    const names = manifest.workbooks.map((entry) => caseKey(updatedSCSEMFileName(entry.fileName)));
    if (new Set(names).size !== names.length) {
        throw new HarnessBlocker("SOURCE_MANIFEST_DUPLICATE_OUTPUT", "Source manifest produces duplicate candidate filenames.");
    }
    return manifest;
}

function resolveSourcePath(entry: ManifestEntry): string {
    return path.isAbsolute(entry.file) ? entry.file : path.join(ROOT, entry.file);
}

function listCandidateFiles(directory: string): string[] {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith("~$") && /\.xlsx$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
}

type CorpusReportArtifact = {
    sourceFileName: string;
    sourcePath: string;
    sourceSha256: string;
    sourceSizeBytes: number;
    outputFileName: string;
    outputSha256: string;
    outputSizeBytes: number;
};

function loadCorpusReportArtifacts(config: HarnessConfig, operation: Operation): Map<string, CorpusReportArtifact> | null {
    if (!config.corpusReportDir) return null;
    const reportPath = path.join(config.corpusReportDir, `scsem-${operation}-corpus-report.json`);
    if (!fs.existsSync(reportPath)) {
        throw new HarnessBlocker("CORPUS_REPORT_MISSING", `Configured corpus report is missing: ${reportPath}`);
    }
    let parsed: { operation?: string; expectedWorkbookCount?: number; exportArtifacts?: { count?: number; files?: CorpusReportArtifact[] } };
    try {
        parsed = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    } catch (error) {
        throw new HarnessBlocker("CORPUS_REPORT_INVALID", `Cannot parse ${reportPath}: ${errorMessage(error)}`);
    }
    const files = parsed.exportArtifacts?.files;
    if (parsed.operation !== operation || parsed.expectedWorkbookCount !== EXPECTED_WORKBOOK_COUNT ||
        parsed.exportArtifacts?.count !== EXPECTED_WORKBOOK_COUNT || !Array.isArray(files) || files.length !== EXPECTED_WORKBOOK_COUNT) {
        throw new HarnessBlocker(
            "CORPUS_REPORT_INCOMPLETE",
            `${reportPath} must map exactly ${EXPECTED_WORKBOOK_COUNT} validated ${operation} exports.`
        );
    }
    const mapped = new Map<string, CorpusReportArtifact>();
    for (const artifact of files) {
        const key = caseKey(artifact.outputFileName);
        if (mapped.has(key)) throw new HarnessBlocker("CORPUS_REPORT_DUPLICATE", `${reportPath} repeats ${artifact.outputFileName}.`);
        mapped.set(key, artifact);
    }
    return mapped;
}

function discoverWorkItems(
    config: HarnessConfig,
    manifest: SourceManifest,
    expectedCount = EXPECTED_WORKBOOK_COUNT
): { items: WorkItem[]; counts: Record<Operation, number> } {
    const items: WorkItem[] = [];
    const counts = { update: 0, add: 0 };
    for (const operation of OPERATIONS) {
        const directory = path.join(config.finalExportDir, operation);
        const names = listCandidateFiles(directory);
        counts[operation] = names.length;
        if (names.length !== expectedCount) {
            throw new HarnessBlocker(
                "CANDIDATE_COUNT_WRONG",
                `${operation} must contain exactly ${expectedCount} XLSX candidates; found ${names.length} in ${directory}.`
            );
        }
        const byName = new Map<string, string>();
        for (const name of names) {
            const key = caseKey(name);
            if (byName.has(key)) throw new HarnessBlocker("CANDIDATE_DUPLICATE", `${operation} contains a case-insensitive duplicate: ${name}.`);
            byName.set(key, name);
        }
        const reportArtifacts = expectedCount === EXPECTED_WORKBOOK_COUNT
            ? loadCorpusReportArtifacts(config, operation)
            : null;
        const expectedNames = new Set<string>();
        for (let index = 0; index < manifest.workbooks.length; index++) {
            const entry = manifest.workbooks[index];
            const expectedName = updatedSCSEMFileName(entry.fileName);
            const key = caseKey(expectedName);
            expectedNames.add(key);
            const actualName = byName.get(key);
            if (!actualName) throw new HarnessBlocker("CANDIDATE_MAPPING_MISSING", `${operation} is missing ${expectedName}.`);
            const sourcePath = resolveSourcePath(entry);
            if (!fs.existsSync(sourcePath)) throw new HarnessBlocker("SOURCE_FILE_MISSING", `Official source is missing: ${sourcePath}`);
            const sourceEvidence = evidence(sourcePath);
            if (sourceEvidence.sha256 !== entry.sha256 || sourceEvidence.sizeBytes !== entry.sizeBytes) {
                throw new HarnessBlocker("SOURCE_HASH_MISMATCH", `Official source hash/size does not match the manifest: ${sourcePath}`);
            }
            const exportPath = path.join(directory, actualName);
            const exportEvidence = evidence(exportPath);
            const artifact = reportArtifacts?.get(key);
            if (reportArtifacts && !artifact) {
                throw new HarnessBlocker("CORPUS_REPORT_MAPPING_MISSING", `${operation} report does not map ${actualName}.`);
            }
            if (artifact && (
                caseKey(artifact.sourceFileName) !== caseKey(entry.fileName) ||
                artifact.sourceSha256 !== entry.sha256 ||
                artifact.sourceSizeBytes !== entry.sizeBytes ||
                artifact.outputSha256 !== exportEvidence.sha256 ||
                artifact.outputSizeBytes !== exportEvidence.sizeBytes
            )) {
                throw new HarnessBlocker("CORPUS_REPORT_HASH_MISMATCH", `${operation} report mapping/hash is stale for ${actualName}.`);
            }
            items.push({
                operation,
                index: index + 1,
                source: { ...sourceEvidence, fileName: entry.fileName, totalControls: entry.totalControls },
                export: { ...exportEvidence, fileName: actualName },
                roundtripPath: path.join(config.outputDir, operation, actualName),
            });
        }
        const extras = [...byName.keys()].filter((name) => !expectedNames.has(name));
        if (extras.length > 0) {
            throw new HarnessBlocker("CANDIDATE_MAPPING_EXTRA", `${operation} contains unmapped candidates: ${extras.join(", ")}.`);
        }
    }
    return { items, counts };
}

function readPlistValue(infoPlist: string, key: string): string | null {
    const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, infoPlist], {
        encoding: "utf8",
        timeout: 5_000,
    });
    return result.status === 0 ? result.stdout.trim() || null : null;
}

function locateExcel(): { appPath: string; version: string; build: string } {
    const candidates = [
        "/Applications/Microsoft Excel.app",
        path.join(os.homedir(), "Applications", "Microsoft Excel.app"),
    ];
    const appPath = candidates.find((candidate) => fs.existsSync(path.join(candidate, "Contents", "Info.plist")));
    if (!appPath) throw new HarnessBlocker("EXCEL_UNAVAILABLE", "Microsoft Excel.app is not installed in /Applications or ~/Applications.");
    const infoPlist = path.join(appPath, "Contents", "Info.plist");
    const version = readPlistValue(infoPlist, "CFBundleShortVersionString");
    const build = readPlistValue(infoPlist, "CFBundleVersion");
    if (!version || !build) throw new HarnessBlocker("EXCEL_VERSION_UNAVAILABLE", `Cannot read Excel version/build from ${infoPlist}.`);
    return { appPath, version, build };
}

type ConsoleUser = {
    kCGSSessionOnConsoleKey?: unknown;
    CGSSessionScreenIsLocked?: unknown;
};

function parseScreenLockedFromIoregJson(value: unknown): boolean {
    const root = Array.isArray(value) ? value[0] : value;
    if (!root || typeof root !== "object") {
        throw new HarnessBlocker("LOCK_STATE_UNKNOWN", "ioreg did not return a root session object.");
    }
    const users = (root as { IOConsoleUsers?: unknown }).IOConsoleUsers;
    if (!Array.isArray(users)) {
        throw new HarnessBlocker("LOCK_STATE_UNKNOWN", "ioreg did not expose IOConsoleUsers; failing closed.");
    }
    const consoleUsers = users.filter((entry): entry is ConsoleUser =>
        Boolean(entry && typeof entry === "object" && (entry as ConsoleUser).kCGSSessionOnConsoleKey === true)
    );
    if (consoleUsers.length !== 1 || typeof consoleUsers[0].CGSSessionScreenIsLocked !== "boolean") {
        throw new HarnessBlocker(
            "LOCK_STATE_UNKNOWN",
            "Expected exactly one on-console session with an explicit CGSSessionScreenIsLocked boolean; failing closed."
        );
    }
    return consoleUsers[0].CGSSessionScreenIsLocked;
}

function readScreenLocked(): boolean {
    const ioreg = spawnSync("/usr/sbin/ioreg", ["-n", "Root", "-d", "1", "-a"], {
        encoding: null,
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024,
    });
    if (ioreg.status !== 0 || !ioreg.stdout?.length) {
        throw new HarnessBlocker("LOCK_STATE_UNKNOWN", `Cannot read macOS console session state: ${bufferText(ioreg.stderr) || "ioreg failed"}.`);
    }
    const plutil = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
        input: ioreg.stdout,
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024,
    });
    if (plutil.status !== 0) {
        throw new HarnessBlocker("LOCK_STATE_UNKNOWN", `Cannot decode macOS console session state: ${plutil.stderr.trim() || "plutil failed"}.`);
    }
    try {
        return parseScreenLockedFromIoregJson(JSON.parse(plutil.stdout));
    } catch (error) {
        if (error instanceof HarnessBlocker) throw error;
        throw new HarnessBlocker("LOCK_STATE_UNKNOWN", `Cannot parse macOS console session state: ${errorMessage(error)}.`);
    }
}

function excelIsRunning(): boolean {
    const result = spawnSync("/usr/bin/pgrep", ["-x", "Microsoft Excel"], { encoding: "utf8", timeout: 5_000 });
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new HarnessBlocker("EXCEL_PROCESS_CHECK_FAILED", `Cannot determine whether Excel is running: ${result.stderr.trim() || "pgrep failed"}.`);
}

function pathsOverlap(left: string, right: string): boolean {
    const relative = path.relative(path.resolve(left), path.resolve(right));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function directoryHasEntries(directory: string): boolean {
    if (!fs.existsSync(directory)) return false;
    if (!fs.statSync(directory).isDirectory()) throw new HarnessBlocker("OUTPUT_PATH_INVALID", `Output path is not a directory: ${directory}`);
    return fs.readdirSync(directory).some((name) => name !== ".DS_Store");
}

function nearestExistingDirectory(candidate: string): string {
    let current = path.resolve(candidate);
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return current;
}

function validateOutputSafety(config: HarnessConfig): void {
    if (pathsOverlap(config.finalExportDir, config.outputDir) || pathsOverlap(config.outputDir, config.finalExportDir)) {
        throw new HarnessBlocker("OUTPUT_OVERLAPS_INPUT", "Round-trip output and final export input directories must not overlap.");
    }
    for (const operation of OPERATIONS) {
        const operationDir = path.join(config.outputDir, operation);
        if (directoryHasEntries(operationDir)) {
            throw new HarnessBlocker(
                "OUTPUT_NOT_EMPTY",
                `${operationDir} is not empty. This harness never overwrites or deletes prior round-trip evidence.`
            );
        }
    }
    const writableAncestor = nearestExistingDirectory(config.outputDir);
    try {
        fs.accessSync(writableAncestor, fs.constants.W_OK);
    } catch {
        throw new HarnessBlocker("OUTPUT_NOT_WRITABLE", `Output ancestor is not writable: ${writableAncestor}`);
    }
}

function collectPreflight(config: HarnessConfig): PreflightResult {
    const blockers: Blocker[] = [];
    const facts: PreflightFacts = {
        platform: process.platform,
        screenLocked: null,
        lockSource: "ioreg Root.IOConsoleUsers[on-console].CGSSessionScreenIsLocked",
        excelAppPath: null,
        excelVersion: null,
        excelBuild: null,
        excelRunning: null,
        candidateCounts: { update: null, add: null },
        plannedWorkbookCount: 0,
        outputWasEmpty: null,
    };
    let workItems: WorkItem[] = [];
    const capture = (fn: () => void) => {
        try {
            fn();
        } catch (error) {
            blockers.push(asBlocker(error));
        }
    };

    if (process.platform !== "darwin") {
        blockers.push({ code: "MACOS_REQUIRED", message: `Native Excel validation requires macOS; current platform is ${process.platform}.` });
    } else {
        capture(() => {
            facts.screenLocked = readScreenLocked();
            if (facts.screenLocked) {
                throw new HarnessBlocker(
                    "MACOS_LOCKED",
                    "The on-console macOS session is locked. Unlock it before native Excel validation; Excel was not launched."
                );
            }
        });
        capture(() => {
            const excel = locateExcel();
            facts.excelAppPath = excel.appPath;
            facts.excelVersion = excel.version;
            facts.excelBuild = excel.build;
        });
        capture(() => {
            facts.excelRunning = excelIsRunning();
            if (facts.excelRunning) {
                throw new HarnessBlocker(
                    "EXCEL_ALREADY_RUNNING",
                    "Excel is already running. Save and close every Excel window and quit Excel manually before the corpus run; the harness will not quit it."
                );
            }
        });
        if (!fs.existsSync("/usr/bin/osascript")) {
            blockers.push({ code: "OSASCRIPT_UNAVAILABLE", message: "/usr/bin/osascript is unavailable." });
        }
    }

    capture(() => {
        for (const operation of OPERATIONS) {
            facts.candidateCounts[operation] = listCandidateFiles(path.join(config.finalExportDir, operation)).length;
        }
        const manifest = loadSourceManifest(config.sourceManifestPath);
        const discovered = discoverWorkItems(config, manifest);
        facts.candidateCounts = discovered.counts;
        facts.plannedWorkbookCount = discovered.items.length;
        workItems = discovered.items;
    });
    capture(() => {
        validateOutputSafety(config);
        facts.outputWasEmpty = true;
    });

    return { ready: blockers.length === 0, blockers, facts, workItems };
}

function decodeXml(value: string): string {
    return value
        .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&amp;/g, "&");
}

function localName(name: string): string {
    return name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
}

function xmlAttributes(tag: string): Array<[string, string]> {
    const attributes: Array<[string, string]> = [];
    const attributePattern = /([^\s=<>]+)\s*=\s*(["'])([\s\S]*?)\2/g;
    let match: RegExpExecArray | null;
    while ((match = attributePattern.exec(tag)) !== null) {
        const originalName = match[1];
        if (/^xmlns(?::|$)/i.test(originalName)) continue;
        const name = localName(originalName);
        let value = decodeXml(match[3]).replace(/\r\n?/g, "\n");
        if (name === "sqref") value = value.trim().split(/\s+/).sort().join(" ");
        if (value === "true") value = "1";
        if (value === "false") value = "0";
        if (/^(?:xr\d*|x14):(?:uid|id)$/i.test(originalName) && /^\{?[0-9a-f-]{32,38}\}?$/i.test(value)) continue;
        attributes.push([name, value]);
    }
    return attributes.sort(([leftName, leftValue], [rightName, rightValue]) =>
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    );
}

type CanonicalXmlNode = {
    name: string;
    attributes: Array<[string, string]>;
    children: Array<CanonicalXmlNode | string>;
};

function canonicalXml(fragment: string): string {
    const root: CanonicalXmlNode = { name: "__root__", attributes: [], children: [] };
    const stack: CanonicalXmlNode[] = [root];
    const tokens = fragment.match(/<[^>]+>|[^<]+/g) || [];
    for (const token of tokens) {
        if (token.startsWith("<?") || token.startsWith("<!--") || token.startsWith("<!DOCTYPE")) continue;
        if (token.startsWith("<![CDATA[")) {
            stack.at(-1)!.children.push(token.slice(9, -3).replace(/\r\n?/g, "\n"));
            continue;
        }
        if (token.startsWith("</")) {
            if (stack.length > 1) stack.pop();
            continue;
        }
        if (token.startsWith("<")) {
            const nameMatch = token.match(/^<\s*([^\s/>]+)/);
            if (!nameMatch) continue;
            const node: CanonicalXmlNode = {
                name: localName(nameMatch[1]),
                attributes: xmlAttributes(token),
                children: [],
            };
            stack.at(-1)!.children.push(node);
            if (!/\/\s*>$/.test(token)) stack.push(node);
            continue;
        }
        if (!/^\s+$/.test(token)) {
            let text = decodeXml(token).replace(/\r\n?/g, "\n");
            if (stack.at(-1)?.name === "id" && /^\{?[0-9a-f-]{32,38}\}?$/i.test(text.trim())) text = "{GUID}";
            stack.at(-1)!.children.push(text);
        }
    }
    return JSON.stringify(root.children);
}

function findTagEnd(xml: string, start: number): number {
    let quote: string | null = null;
    for (let index = start; index < xml.length; index++) {
        const character = xml[index];
        if (quote) {
            if (character === quote) quote = null;
        } else if (character === '"' || character === "'") quote = character;
        else if (character === ">") return index;
    }
    return -1;
}

function extractElements(xml: string, tagName: string): string[] {
    const output: string[] = [];
    const startPattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tagName}\\b`, "gi");
    let start: RegExpExecArray | null;
    while ((start = startPattern.exec(xml)) !== null) {
        const openingEnd = findTagEnd(xml, start.index);
        if (openingEnd < 0) break;
        if (/\/\s*>$/.test(xml.slice(start.index, openingEnd + 1))) {
            output.push(xml.slice(start.index, openingEnd + 1));
            startPattern.lastIndex = openingEnd + 1;
            continue;
        }
        const sameTag = new RegExp(`<(/?)(?:[A-Za-z_][\\w.-]*:)?${tagName}\\b`, "gi");
        sameTag.lastIndex = openingEnd + 1;
        let depth = 1;
        let match: RegExpExecArray | null;
        let end = -1;
        while ((match = sameTag.exec(xml)) !== null) {
            const tagEnd = findTagEnd(xml, match.index);
            if (tagEnd < 0) break;
            const closing = match[1] === "/";
            const selfClosing = /\/\s*>$/.test(xml.slice(match.index, tagEnd + 1));
            if (closing) depth--;
            else if (!selfClosing) depth++;
            sameTag.lastIndex = tagEnd + 1;
            if (depth === 0) {
                end = tagEnd + 1;
                break;
            }
        }
        if (end < 0) break;
        output.push(xml.slice(start.index, end));
        startPattern.lastIndex = end;
    }
    return output;
}

function canonicalElements(xml: string, tagName: string): string[] {
    return extractElements(xml, tagName).map(canonicalXml).sort();
}

function stableValue(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .filter(([, child]) => child !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, stableValue(child)]));
    }
    return value;
}

function stableJson(value: unknown): string {
    return JSON.stringify(stableValue(value));
}

function canonicalCellValue(cell: XLSX.CellObject): CanonicalCell {
    let value: CanonicalCell["value"];
    if (cell.v instanceof Date) value = cell.v.toISOString();
    else if (typeof cell.v === "string") value = cell.v.replace(/\r\n?/g, "\n");
    else if (typeof cell.v === "number") value = Object.is(cell.v, -0) ? 0 : cell.v;
    else if (typeof cell.v === "boolean" || cell.v === null) value = cell.v;
    else if (cell.v === undefined) value = null;
    else value = String(cell.v);
    if (cell.t === "e" && cell.w) value = cell.w;
    return { type: cell.t || typeof value, value };
}

function formulaCacheError(cell: XLSX.CellObject): string | null {
    if (typeof cell.w === "string" && cell.w.startsWith("#")) return cell.w;
    if (cell.t === "e" && typeof cell.v === "number") return EXCEL_ERROR_CODES[cell.v] || String(cell.v);
    if (cell.t === "e" && cell.v !== undefined) return String(cell.v);
    return null;
}

function cellKey(sheetName: string, address: string): string {
    return `${sheetName}\u0000${address}`;
}

function sortedRecord<T>(entries: Array<[string, T]>): Record<string, T> {
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function canonicalDefinedNames(workbook: XLSX.WorkBook): Array<Record<string, unknown>> {
    return (workbook.Workbook?.Names || []).map((entry) => stableValue({
        name: entry.Name,
        ref: typeof entry.Ref === "string" ? entry.Ref.replace(/\r\n?/g, "\n") : entry.Ref,
        sheet: entry.Sheet ?? null,
        hidden: (entry as typeof entry & { Hidden?: boolean }).Hidden ?? false,
        comment: entry.Comment ?? null,
    }) as Record<string, unknown>).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function parseAttributesFromTag(tag: string): Record<string, string> {
    return Object.fromEntries(xmlAttributes(tag));
}

async function worksheetXmlByName(zip: JSZip, workbook: XLSX.WorkBook): Promise<Record<string, string>> {
    const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
    const relationshipsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
    if (!workbookXml || !relationshipsXml) throw new Error("Workbook XML or workbook relationships are missing.");
    const relationshipTargets = new Map<string, string>();
    for (const relationship of extractElements(relationshipsXml, "Relationship")) {
        const attributes = parseAttributesFromTag(relationship.slice(0, findTagEnd(relationship, 0) + 1));
        if (attributes.Id && attributes.Target) relationshipTargets.set(attributes.Id, attributes.Target);
    }
    const result: Record<string, string> = {};
    for (const sheet of extractElements(workbookXml, "sheet")) {
        const attributes = parseAttributesFromTag(sheet.slice(0, findTagEnd(sheet, 0) + 1));
        const target = relationshipTargets.get(attributes.id);
        if (!attributes.name || !target) throw new Error("A workbook sheet relationship is incomplete.");
        const partPath = target.startsWith("/")
            ? target.slice(1)
            : path.posix.normalize(path.posix.join("xl", target));
        const xml = await zip.file(partPath)?.async("string");
        if (!xml) throw new Error(`Worksheet part is missing for ${attributes.name}: ${partPath}`);
        result[attributes.name] = xml;
    }
    if (Object.keys(result).length !== workbook.SheetNames.length) {
        throw new Error(`Worksheet relationship count ${Object.keys(result).length} does not match workbook count ${workbook.SheetNames.length}.`);
    }
    return result;
}

const WORKSHEET_FEATURES = [
    "autoFilter",
    "dataValidations",
    "conditionalFormatting",
    "sheetProtection",
    "protectedRanges",
    "printOptions",
    "pageMargins",
    "pageSetup",
    "headerFooter",
    "rowBreaks",
    "colBreaks",
    "extLst",
] as const;

async function snapshotWorkbook(filePath: string): Promise<WorkbookSnapshot> {
    const bytes = fs.readFileSync(filePath);
    const workbook = XLSX.read(bytes, {
        cellFormula: true,
        cellNF: true,
        cellStyles: true,
        sheetStubs: false,
        raw: true,
    });
    if (!workbook.SheetNames.length) throw new Error("Workbook has no worksheets.");
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const sheetXml = await worksheetXmlByName(zip, workbook);
    const nonFormulaCells: Array<[string, CanonicalCell]> = [];
    const formulas: Array<[string, CanonicalFormula]> = [];
    const styleProjection: Array<[string, unknown]> = [];
    const mergedRanges: Record<string, string[]> = {};
    const formulaCacheErrors: WorkbookSnapshot["formulaCacheErrors"] = [];

    for (const sheetName of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sheetName];
        mergedRanges[sheetName] = (worksheet["!merges"] || []).map(XLSX.utils.encode_range).sort();
        for (const address of Object.keys(worksheet).filter((key) => !key.startsWith("!")).sort()) {
            const cell = worksheet[address] as XLSX.CellObject | undefined;
            if (!cell) continue;
            const hasFormula = typeof cell.f === "string" || typeof cell.F === "string";
            const hasValue = cell.v !== undefined && cell.v !== null && cell.v !== "";
            if (!hasFormula && !hasValue) continue;
            const key = cellKey(sheetName, address);
            if (hasFormula) {
                formulas.push([key, {
                    formula: typeof cell.f === "string" ? cell.f.replace(/\r\n?/g, "\n") : null,
                    arrayRef: typeof cell.F === "string" ? cell.F : null,
                }]);
                const cachedError = formulaCacheError(cell);
                if (cachedError) formulaCacheErrors.push({ sheetName, address, error: cachedError });
            } else {
                nonFormulaCells.push([key, canonicalCellValue(cell)]);
            }
            styleProjection.push([key, stableValue({ numberFormat: cell.z ?? null, style: cell.s ?? null })]);
        }
    }

    const parsed = parseSCSEMFile(filePath);
    const controls = parsed.sheets.flatMap((sheet) => sheet.controls.map((control) => ({
        sheetName: sheet.sheetName,
        rowIndex: control.rowIndex,
        testId: control.testId,
    })));
    const definedNames = canonicalDefinedNames(workbook);
    const worksheetFeatures: WorkbookSnapshot["worksheetFeatures"] = {};
    for (const sheetName of workbook.SheetNames) {
        worksheetFeatures[sheetName] = Object.fromEntries(WORKSHEET_FEATURES.map((feature) => [
            feature,
            canonicalElements(sheetXml[sheetName], feature),
        ]));
    }
    const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
    const tableAutoFilters: string[] = [];
    for (const partName of Object.keys(zip.files).filter((name) => /^xl\/tables\/[^/]+\.xml$/i.test(name)).sort()) {
        const xml = await zip.file(partName)!.async("string");
        tableAutoFilters.push(...canonicalElements(xml, "autoFilter"));
    }
    tableAutoFilters.sort();

    return {
        sheetOrder: [...workbook.SheetNames],
        sheetVisibility: workbook.SheetNames.map((sheetName, index) => ({
            sheetName,
            hidden: Number(workbook.Workbook?.Sheets?.[index]?.Hidden || 0),
        })),
        controls,
        nonFormulaCells: sortedRecord(nonFormulaCells),
        formulas: sortedRecord(formulas),
        styleProjection: sortedRecord(styleProjection),
        mergedRanges,
        definedNames,
        printAreas: definedNames.filter((entry) => entry.name === "_xlnm.Print_Area"),
        worksheetFeatures,
        workbookProtection: canonicalElements(workbookXml, "workbookProtection"),
        tableAutoFilters,
        formulaCacheErrors,
    };
}

function countValue(value: unknown): number | undefined {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === "object") return Object.keys(value).length;
    return undefined;
}

function firstDifference(expected: unknown, actual: unknown): string {
    if (Array.isArray(expected) && Array.isArray(actual)) {
        const limit = Math.max(expected.length, actual.length);
        for (let index = 0; index < limit; index++) {
            if (stableJson(expected[index]) !== stableJson(actual[index])) return `first difference at array index ${index}`;
        }
    }
    if (expected && actual && typeof expected === "object" && typeof actual === "object") {
        const left = expected as Record<string, unknown>;
        const right = actual as Record<string, unknown>;
        for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
            if (!(key in left)) return `unexpected key ${printableKey(key)}`;
            if (!(key in right)) return `missing key ${printableKey(key)}`;
            if (stableJson(left[key]) !== stableJson(right[key])) return `first changed key ${printableKey(key)}`;
        }
    }
    return "values differ";
}

function printableKey(key: string): string {
    return key.replace("\u0000", "!");
}

function verificationCheck(name: string, expected: unknown, actual: unknown): VerificationCheck {
    const expectedJson = stableJson(expected);
    const actualJson = stableJson(actual);
    const passed = expectedJson === actualJson;
    return {
        name,
        passed,
        expectedCount: countValue(expected),
        actualCount: countValue(actual),
        expectedSha256: sha256(expectedJson),
        actualSha256: sha256(actualJson),
        ...(passed ? {} : { difference: firstDifference(expected, actual) }),
    };
}

function compareSnapshots(exported: WorkbookSnapshot, roundtrip: WorkbookSnapshot): VerificationResult {
    const cachedRefErrors = roundtrip.formulaCacheErrors.filter((entry) => /^#REF!/i.test(entry.error));
    const checks = [
        verificationCheck("sheet order/count", exported.sheetOrder, roundtrip.sheetOrder),
        verificationCheck("sheet visibility", exported.sheetVisibility, roundtrip.sheetVisibility),
        verificationCheck("control identities/count", exported.controls, roundtrip.controls),
        verificationCheck("canonical non-formula cell values", exported.nonFormulaCells, roundtrip.nonFormulaCells),
        verificationCheck("formulas by sheet/address/text", exported.formulas, roundtrip.formulas),
        verificationCheck("cell style projection", exported.styleProjection, roundtrip.styleProjection),
        verificationCheck("merged ranges", exported.mergedRanges, roundtrip.mergedRanges),
        verificationCheck("defined names", exported.definedNames, roundtrip.definedNames),
        verificationCheck("print areas", exported.printAreas, roundtrip.printAreas),
        verificationCheck("AutoFilters, DV, CF, protection, and print XML", exported.worksheetFeatures, roundtrip.worksheetFeatures),
        verificationCheck("workbook protection", exported.workbookProtection, roundtrip.workbookProtection),
        verificationCheck("table AutoFilters", exported.tableAutoFilters, roundtrip.tableAutoFilters),
        verificationCheck("no cached #REF! formula results after full rebuild", [], cachedRefErrors),
    ];
    return {
        success: checks.every((check) => check.passed),
        checks,
        formulaCacheErrors: {
            count: roundtrip.formulaCacheErrors.length,
            sample: roundtrip.formulaCacheErrors.slice(0, 20),
            note: "Formula cached results are reported but intentionally excluded from equality because Excel full recalculation may change caches.",
        },
        approvedOrAddDeltaPreserved: checks.every((check) => check.passed),
        visualVerificationPerformed: false,
    };
}

function identityMultiset(controls: ControlIdentity[]): Map<string, number> {
    const result = new Map<string, number>();
    for (const control of controls) {
        const key = `${control.sheetName}\u0000${control.testId}`;
        result.set(key, (result.get(key) || 0) + 1);
    }
    return result;
}

function validateSourceDelta(
    operation: Operation,
    sourceControls: ControlIdentity[],
    exportControls: ControlIdentity[],
    expectedSourceCount: number,
    label: string
): { addedControl: string | null } {
    if (sourceControls.length !== expectedSourceCount) {
        throw new Error(`${label}: source parser found ${sourceControls.length} controls; manifest expects ${expectedSourceCount}.`);
    }
    const source = identityMultiset(sourceControls);
    const exported = identityMultiset(exportControls);
    if (operation === "update") {
        assert.equal(exportControls.length, sourceControls.length, `${label}: update changed the control count.`);
        assert.equal(stableJson([...exported.entries()].sort()), stableJson([...source.entries()].sort()), `${label}: update changed control identities.`);
        return { addedControl: null };
    }
    assert.equal(exportControls.length, sourceControls.length + 1, `${label}: add export is not exactly +1 control.`);
    for (const [key, count] of source) {
        assert.ok((exported.get(key) || 0) >= count, `${label}: add export lost source control ${printableKey(key)}.`);
    }
    const additions: string[] = [];
    for (const [key, count] of exported) {
        for (let index = source.get(key) || 0; index < count; index++) additions.push(key);
    }
    assert.equal(additions.length, 1, `${label}: add export does not have one unambiguous added control identity.`);
    return { addedControl: printableKey(additions[0]) };
}

type SubprocessResult = {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    error: string | null;
};

function runBoundedSubprocess(
    executable: string,
    args: string[],
    options: { input?: string; timeoutMs: number; maxOutputBytes?: number }
): Promise<SubprocessResult> {
    const started = Date.now();
    const maxOutputBytes = options.maxOutputBytes || 1024 * 1024;
    return new Promise((resolve) => {
        const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let timedOut = false;
        let spawnError: string | null = null;
        let killTimer: NodeJS.Timeout | null = null;
        const append = (
            current: Buffer<ArrayBufferLike>,
            chunk: Buffer<ArrayBufferLike>
        ): Buffer<ArrayBufferLike> => {
            if (current.length >= maxOutputBytes) return current;
            return Buffer.concat([current, chunk.subarray(0, maxOutputBytes - current.length)]);
        };
        child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
        child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
        child.on("error", (error) => { spawnError = error.message; });
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
            killTimer.unref();
        }, options.timeoutMs);
        timeout.unref();
        child.on("close", (status, signal) => {
            clearTimeout(timeout);
            if (killTimer) clearTimeout(killTimer);
            resolve({
                status,
                signal,
                stdout: stdout.toString("utf8").trim(),
                stderr: stderr.toString("utf8").trim(),
                durationMs: Date.now() - started,
                timedOut,
                error: spawnError,
            });
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.input || "");
    });
}

async function runExcelRoundtrip(sourcePath: string, outputPath: string, timeoutMs: number): Promise<{
    durationMs: number;
    excelVersion: string;
    excelBuild: string;
}> {
    if (fs.existsSync(outputPath)) {
        throw new HarnessBlocker("OUTPUT_EXISTS", `Refusing to overwrite existing round-trip output: ${outputPath}`);
    }
    const result = await runBoundedSubprocess("/usr/bin/osascript", ["-", sourcePath, outputPath], {
        input: EXCEL_APPLESCRIPT,
        timeoutMs,
    });
    if (result.timedOut) {
        throw new HarnessBlocker(
            "EXCEL_DIALOG_OR_TIMEOUT",
            `Excel round trip timed out after ${result.durationMs} ms. Excel may be showing a repair, security, link, or save dialog. No dialog was accepted; only osascript was stopped, and Excel was not quit or force-quit.`
        );
    }
    if (result.error || result.status !== 0) {
        throw new HarnessBlocker(
            "EXCEL_APPLESCRIPT_FAILED",
            `Excel AppleScript failed (${result.status ?? result.signal ?? "spawn error"}): ${result.stderr || result.stdout || result.error || "unknown error"}. Excel was not quit or force-quit.`
        );
    }
    const [status, excelVersion, excelBuild] = result.stdout.split("\t");
    if (status !== "OK" || !excelVersion || !excelBuild) {
        throw new HarnessBlocker("EXCEL_RESULT_INVALID", `Unexpected Excel AppleScript response: ${result.stdout || "empty response"}.`);
    }
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        throw new HarnessBlocker("ROUNDTRIP_OUTPUT_MISSING", `Excel reported success but did not create a non-empty output: ${outputPath}`);
    }
    return { durationMs: result.durationMs, excelVersion, excelBuild };
}

function sourceControls(filePath: string): ControlIdentity[] {
    const parsed = parseSCSEMFile(filePath);
    return parsed.sheets.flatMap((sheet) => sheet.controls.map((control) => ({
        sheetName: sheet.sheetName,
        rowIndex: control.rowIndex,
        testId: control.testId,
    })));
}

function baseReport(mode: RunMode, config: Partial<HarnessConfig>): HarnessReport {
    const now = new Date().toISOString();
    return {
        schemaVersion: 1,
        kind: "native-microsoft-excel-corpus-roundtrip",
        generatedAt: now,
        updatedAt: now,
        status: "blocked",
        mode,
        scope: {
            expectedPerOperation: EXPECTED_WORKBOOK_COUNT,
            expectedTotal: EXPECTED_WORKBOOK_COUNT * OPERATIONS.length,
            operations: OPERATIONS,
        },
        limitations: {
            visualVerificationPerformed: false,
            complianceCertificationPerformed: false,
            note: "This harness records native Excel round trips and semantic OOXML checks. It does not provide visual proof or certify regulatory compliance.",
        },
        configuration: config,
        preflight: null,
        summary: { attempted: 0, passed: 0, failed: 0, remaining: EXPECTED_WORKBOOK_COUNT * OPERATIONS.length },
        entries: [],
    };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });
    fs.renameSync(temporary, filePath);
}

function persistReport(report: HarnessReport, reportPath: string): void {
    report.updatedAt = new Date().toISOString();
    report.summary = {
        attempted: report.entries.length,
        passed: report.entries.filter((entry) => entry.success).length,
        failed: report.entries.filter((entry) => !entry.success).length,
        remaining: EXPECTED_WORKBOOK_COUNT * OPERATIONS.length - report.entries.length,
    };
    writeJsonAtomic(reportPath, report);
}

async function executeCorpus(config: HarnessConfig, preflight: PreflightResult, report: HarnessReport): Promise<void> {
    fs.mkdirSync(path.join(config.outputDir, "update"), { recursive: true });
    fs.mkdirSync(path.join(config.outputDir, "add"), { recursive: true });
    report.status = "running";
    persistReport(report, config.reportPath);
    const sourceControlCache = new Map<string, ControlIdentity[]>();

    for (const item of preflight.workItems) {
        const entry: RoundtripEntry = {
            operation: item.operation,
            index: item.index,
            source: { path: item.source.path, fileName: item.source.fileName, sha256: item.source.sha256, sizeBytes: item.source.sizeBytes },
            export: { path: item.export.path, fileName: item.export.fileName, sha256: item.export.sha256, sizeBytes: item.export.sizeBytes },
            roundtrip: null,
            durationMs: null,
            verificationDurationMs: null,
            excelVersion: null,
            excelBuild: null,
            success: false,
            blocker: null,
            verification: null,
        };
        try {
            if (readScreenLocked()) {
                throw new HarnessBlocker("MACOS_LOCKED", "macOS became locked during the corpus run; Excel was not invoked for this file.");
            }
            const currentExport = evidence(item.export.path);
            if (currentExport.sha256 !== item.export.sha256 || currentExport.sizeBytes !== item.export.sizeBytes) {
                throw new HarnessBlocker("EXPORT_CHANGED_AFTER_PREFLIGHT", `Candidate changed after preflight: ${item.export.path}`);
            }
            const exportSnapshot = await snapshotWorkbook(item.export.path);
            let originalControls = sourceControlCache.get(item.source.path);
            if (!originalControls) {
                originalControls = sourceControls(item.source.path);
                sourceControlCache.set(item.source.path, originalControls);
            }
            validateSourceDelta(
                item.operation,
                originalControls,
                exportSnapshot.controls,
                item.source.totalControls,
                `${item.operation} ${item.source.fileName}`
            );
            const excel = await runExcelRoundtrip(item.export.path, item.roundtripPath, config.timeoutMs);
            entry.durationMs = excel.durationMs;
            entry.excelVersion = excel.excelVersion;
            entry.excelBuild = excel.excelBuild;
            const verificationStarted = Date.now();
            const roundtripSnapshot = await snapshotWorkbook(item.roundtripPath);
            entry.verification = compareSnapshots(exportSnapshot, roundtripSnapshot);
            entry.verificationDurationMs = Date.now() - verificationStarted;
            const roundtripEvidence = evidence(item.roundtripPath);
            entry.roundtrip = { ...roundtripEvidence, fileName: path.basename(item.roundtripPath) };
            if (!entry.verification.success) {
                const failed = entry.verification.checks.filter((check) => !check.passed).map((check) => check.name).join(", ");
                throw new HarnessBlocker("ROUNDTRIP_FIDELITY_FAILED", `Excel round-trip semantic verification failed: ${failed}.`);
            }
            entry.success = true;
            report.entries.push(entry);
            persistReport(report, config.reportPath);
            process.stdout.write(`PASS ${item.operation} ${item.index}/${EXPECTED_WORKBOOK_COUNT} ${item.export.fileName}\n`);
        } catch (error) {
            entry.blocker = asBlocker(error);
            if (fs.existsSync(item.roundtripPath) && fs.statSync(item.roundtripPath).isFile()) {
                const roundtripEvidence = evidence(item.roundtripPath);
                entry.roundtrip = { ...roundtripEvidence, fileName: path.basename(item.roundtripPath) };
            }
            report.entries.push(entry);
            report.status = "failed";
            persistReport(report, config.reportPath);
            throw error;
        }
    }
    report.status = "passed";
    persistReport(report, config.reportPath);
}

function asBlocker(error: unknown): Blocker {
    if (error instanceof HarnessBlocker) return { code: error.code, message: error.message };
    return { code: "VALIDATION_FAILED", message: errorMessage(error) };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function bufferText(value: Buffer | string | null | undefined): string {
    return Buffer.isBuffer(value) ? value.toString("utf8").trim() : String(value || "").trim();
}

function staticAppleScriptTest(): void {
    assert.match(EXCEL_APPLESCRIPT, /display alerts to true/);
    assert.match(EXCEL_APPLESCRIPT, /update links do not update links/);
    assert.match(EXCEL_APPLESCRIPT, /calculate full rebuild/);
    assert.match(EXCEL_APPLESCRIPT, /file format Excel XML file format/);
    assert.match(EXCEL_APPLESCRIPT, /count of workbooks/);
    assert.doesNotMatch(EXCEL_APPLESCRIPT, /\b(?:quit|force-quit|killall)\b/i);
    if (process.platform === "darwin" && fs.existsSync("/Applications/Microsoft Excel.app")) {
        const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skyshield-excel-script-")), "roundtrip.scpt");
        const compiled = spawnSync("/usr/bin/osacompile", ["-o", output, "-"], {
            input: EXCEL_APPLESCRIPT,
            encoding: "utf8",
            timeout: 10_000,
        });
        try {
            assert.equal(compiled.status, 0, `AppleScript did not compile: ${compiled.stderr}`);
        } finally {
            fs.rmSync(path.dirname(output), { recursive: true, force: true });
        }
    }
}

async function runSelfTests(): Promise<void> {
    const parsed = parseCli([
        "--preflight",
        "--final-export-dir", "/tmp/exports",
        "--timeout-ms", "30000",
    ]);
    assert.equal(parsed.mode, "preflight");
    assert.equal(parsed.timeoutMs, 30_000);
    assert.throws(() => parseCli(["--wat"]), /Unknown argument/);
    assert.throws(() => buildConfig({ mode: "run" }, {}), /SCSEM_CORPUS_FINAL_EXPORT_DIR/);
    assert.throws(() => buildConfig({ mode: "run", finalExportDir: "/tmp/x", timeoutMs: 1 }), /between/);
    assert.equal(updatedSCSEMFileName("Safeguards SCSEM (Thing).xlsx"), "Safeguards-SCSEM-Thing-updated.xlsx");

    assert.equal(parseScreenLockedFromIoregJson({
        IOConsoleUsers: [{ kCGSSessionOnConsoleKey: true, CGSSessionScreenIsLocked: true }],
    }), true);
    assert.equal(parseScreenLockedFromIoregJson({
        IOConsoleLocked: true,
        IOConsoleUsers: [{ kCGSSessionOnConsoleKey: true, CGSSessionScreenIsLocked: false }],
    }), false);
    assert.throws(() => parseScreenLockedFromIoregJson({ IOConsoleUsers: [] }), /failing closed/);
    assert.throws(() => parseScreenLockedFromIoregJson({
        IOConsoleUsers: [{ kCGSSessionOnConsoleKey: true }],
    }), /failing closed/);

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skyshield-native-corpus-"));
    try {
        const exportRoot = path.join(temporaryRoot, "exports");
        const outputRoot = path.join(temporaryRoot, "output");
        const manifestEntries: ManifestEntry[] = [];
        for (let index = 0; index < 2; index++) {
            const sourcePath = path.join(temporaryRoot, `source ${index}.xlsx`);
            fs.writeFileSync(sourcePath, `source-${index}`);
            const sourceEvidence = evidence(sourcePath);
            const fileName = `source ${index}.xlsx`;
            manifestEntries.push({ fileName, file: sourcePath, ...sourceEvidence, totalControls: 0 });
            for (const operation of OPERATIONS) {
                fs.mkdirSync(path.join(exportRoot, operation), { recursive: true });
                fs.writeFileSync(path.join(exportRoot, operation, updatedSCSEMFileName(fileName)), `${operation}-${index}`);
            }
        }
        const config: HarnessConfig = {
            finalExportDir: exportRoot,
            outputDir: outputRoot,
            reportPath: path.join(temporaryRoot, "report.json"),
            sourceManifestPath: path.join(temporaryRoot, "manifest.json"),
            corpusReportDir: null,
            timeoutMs: DEFAULT_TIMEOUT_MS,
        };
        const manifest = { expectedWorkbookCount: 2, workbooks: manifestEntries };
        fs.writeFileSync(config.sourceManifestPath, JSON.stringify(manifest));
        assert.equal(loadSourceManifest(config.sourceManifestPath, 2).workbooks.length, 2);
        assert.equal(discoverWorkItems(config, manifest, 2).items.length, 4);
        fs.rmSync(path.join(exportRoot, "add", updatedSCSEMFileName(manifestEntries[0].fileName)));
        assert.throws(() => discoverWorkItems(config, manifest, 2), /exactly 2 XLSX candidates/);
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }

    const emptySnapshot: WorkbookSnapshot = {
        sheetOrder: ["Sheet1"],
        sheetVisibility: [{ sheetName: "Sheet1", hidden: 0 }],
        controls: [],
        nonFormulaCells: { "Sheet1\u0000A1": { type: "s", value: "value" } },
        formulas: { "Sheet1\u0000B1": { formula: "A1", arrayRef: null } },
        styleProjection: {},
        mergedRanges: { Sheet1: [] },
        definedNames: [],
        printAreas: [],
        worksheetFeatures: { Sheet1: {} },
        workbookProtection: [],
        tableAutoFilters: [],
        formulaCacheErrors: [],
    };
    assert.equal(compareSnapshots(emptySnapshot, structuredClone(emptySnapshot)).success, true);
    const changed = structuredClone(emptySnapshot);
    changed.formulas["Sheet1\u0000B1"].formula = "A2";
    assert.equal(compareSnapshots(emptySnapshot, changed).success, false);
    const cachedRef = structuredClone(emptySnapshot);
    cachedRef.formulaCacheErrors.push({ sheetName: "Sheet1", address: "B1", error: "#REF!" });
    const cachedRefResult = compareSnapshots(emptySnapshot, cachedRef);
    assert.equal(cachedRefResult.success, false);
    assert.equal(
        cachedRefResult.checks.find((check) => check.name.includes("#REF!"))?.passed,
        false
    );

    const sourceManifest = loadSourceManifest(path.join(ROOT, "data", "scsem-manifest.json"));
    const fixturePath = resolveSourcePath(sourceManifest.workbooks[0]);
    const fixtureSnapshot = await snapshotWorkbook(fixturePath);
    assert.ok(fixtureSnapshot.sheetOrder.length > 0);
    assert.equal(fixtureSnapshot.controls.length, sourceManifest.workbooks[0].totalControls);
    assert.equal(compareSnapshots(fixtureSnapshot, structuredClone(fixtureSnapshot)).success, true);
    staticAppleScriptTest();
    process.stdout.write("PASS native Excel corpus harness self-tests (no Excel launch).\n");
}

async function main(): Promise<void> {
    let options: CliOptions;
    try {
        options = parseCli(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`BLOCKED ${asBlocker(error).code}: ${asBlocker(error).message}\n${usage()}\n`);
        process.exitCode = 2;
        return;
    }
    if (options.mode === "help") {
        process.stdout.write(`${usage()}\n`);
        return;
    }
    if (options.mode === "self-test") {
        await runSelfTests();
        return;
    }

    const fallbackReportPath = optionalPath(options.reportPath, process.env.SCSEM_NATIVE_EXCEL_REPORT_PATH) || DEFAULT_REPORT_PATH;
    let config: HarnessConfig;
    try {
        config = buildConfig(options);
    } catch (error) {
        const blocker = asBlocker(error);
        const report = baseReport(options.mode, {});
        report.preflight = {
            ready: false,
            blockers: [blocker],
            facts: {
                platform: process.platform,
                screenLocked: null,
                lockSource: "not evaluated",
                excelAppPath: null,
                excelVersion: null,
                excelBuild: null,
                excelRunning: null,
                candidateCounts: { update: null, add: null },
                plannedWorkbookCount: 0,
                outputWasEmpty: null,
            },
        };
        persistReport(report, fallbackReportPath);
        process.stderr.write(`BLOCKED ${blocker.code}: ${blocker.message}\nREPORT ${fallbackReportPath}\n`);
        process.exitCode = 2;
        return;
    }

    const report = baseReport(options.mode, config);
    const preflight = collectPreflight(config);
    report.preflight = { ready: preflight.ready, blockers: preflight.blockers, facts: preflight.facts };
    report.status = preflight.ready ? "ready" : "blocked";
    persistReport(report, config.reportPath);
    if (!preflight.ready) {
        for (const blocker of preflight.blockers) process.stderr.write(`BLOCKED ${blocker.code}: ${blocker.message}\n`);
        process.stderr.write(`REPORT ${config.reportPath}\n`);
        process.exitCode = 2;
        return;
    }
    if (options.mode === "preflight") {
        process.stdout.write(`READY 116 candidates mapped; native Excel was not launched.\nREPORT ${config.reportPath}\n`);
        return;
    }

    try {
        await executeCorpus(config, preflight, report);
        process.stdout.write(`PASS 116/116 native Excel round trips and semantic verifications.\nREPORT ${config.reportPath}\n`);
    } catch (error) {
        const blocker = asBlocker(error);
        process.stderr.write(`BLOCKED ${blocker.code}: ${blocker.message}\nREPORT ${config.reportPath}\n`);
        process.exitCode = blocker.code === "ROUNDTRIP_FIDELITY_FAILED" || blocker.code === "VALIDATION_FAILED" ? 1 : 2;
    }
}

main().catch((error) => {
    process.stderr.write(`FAILED ${errorMessage(error)}\n`);
    process.exitCode = 1;
});
