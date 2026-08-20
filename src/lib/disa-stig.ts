import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { textSimilarity } from "@/lib/cis-benchmark-xlsx";
import { normalizeNistControlId } from "@/lib/compliance-evidence";
import type { SCSEMControlEvidence } from "@/lib/scsem-update-engine";
import { isMaterialTextDelta } from "@/lib/scsem-update-engine";
import type { ParsedSCSEM } from "@/lib/xlsx-parser";
import { runtimeDataDir } from "@/lib/runtime-storage";

const CATALOG_PATH = "data/disa-stig-catalog.json";
const CCI_PATH = "data/disa-cci-rev5.json";
const REGISTRY_PATH = "data/scsem-disa-stig-map.json";
const CATALOG_FILE_SHA256 = "0ee5e85a3263e1554fb6419a1ead32d09afe069f8af151affdc11a0b70c19fe0";
const CCI_FILE_SHA256 = "c0d321a00342504781bab35572fb28f326940575592f2ed347a6dfaa52d62211";
const REGISTRY_FILE_SHA256 = "342fb38693dd904863c775af0ba34d893f40adf8982a1e2dec74e7b625be8826";
const MAX_STIG_PACKAGE_BYTES = 80 * 1024 * 1024;
const MAX_XCCDF_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 90_000;

export interface DisaStigCatalogEntry {
    name: string;
    downloadType: string;
    uploadDate: string;
    url: string;
    classification: string;
}

interface DisaStigCatalog {
    schemaVersion: number;
    sourceUrl: string;
    reviewedAt: string;
    entryCount: number;
    rawEntriesSha256: string;
    entries: DisaStigCatalogEntry[];
}

type DisaStigClassification = "direct" | "adjacent_version" | "adjacent_product" | "historical_sunset" | "none";

interface DisaStigRegistry {
    schemaVersion: number;
    workbookCount: number;
    entries: Array<{
        fileName: string;
        sha256: string;
        sheets: Record<string, {
            classification: DisaStigClassification;
            rationale: string;
            catalogName?: string;
            sourceUrl?: string;
            sourceUploadDate?: string;
            benchmarkIds?: string[];
            sourcePackageSha256?: string;
        }>;
    }>;
}

interface DisaCciCatalog {
    schemaVersion: number;
    sourceUrl: string;
    reviewedAt: string;
    sourceSha256: string;
    mappingCount: number;
    mappings: Record<string, string[]>;
}

export interface DisaStigRule {
    benchmarkId: string;
    ruleId: string;
    vulnerabilityId: string | null;
    version: string;
    title: string;
    description: string;
    checkContent: string;
    fixText: string;
    severity: string;
    cciIds: string[];
    nistIds: string[];
}

export interface ParsedDisaStig {
    benchmarkIds: string[];
    title: string;
    version: string;
    releaseInfo: string;
    rules: DisaStigRule[];
}

export interface ResolvedDisaStigSource {
    sourceKind: "STIG";
    sourceRelationship: "direct" | "adjacent";
    matchQuery: string;
    matchedSheets: string[];
    catalogEntry: DisaStigCatalogEntry;
    catalogReviewedAt: string;
    catalogSourceUrl: string;
    benchmarkIds: string[];
    expectedPackageSha256: string;
    packageSha256: string;
    downloadedAt: string;
    snapshotPath: string;
    parsed: ParsedDisaStig;
}

function sha256(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

function safePart(value: string): string {
    return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 140);
}

function readPinnedJson<T>(relativePath: string, expectedSha256: string): T {
    const raw = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
    if (sha256(Buffer.from(raw, "utf8")) !== expectedSha256) {
        throw new Error(`Pinned DISA data file ${relativePath} failed SHA-256 validation.`);
    }
    return JSON.parse(raw) as T;
}

function loadCatalog(): DisaStigCatalog {
    const parsed = readPinnedJson<DisaStigCatalog>(CATALOG_PATH, CATALOG_FILE_SHA256);
    if (
        parsed.schemaVersion !== 1 ||
        parsed.sourceUrl !== "https://www.cyber.mil/stigs/downloads" ||
        parsed.rawEntriesSha256 !== "febfb22ba5aeb450affec8fd0968c48cc5fff5a22d47ba65781ee65f1c2adf7a" ||
        parsed.entryCount !== parsed.entries.length ||
        parsed.entries.length < 400
    ) {
        throw new Error("The pinned DISA STIG catalog is missing or invalid.");
    }
    return parsed;
}

function loadDisaStigRegistry(): DisaStigRegistry {
    const parsed = readPinnedJson<DisaStigRegistry>(REGISTRY_PATH, REGISTRY_FILE_SHA256);
    if (parsed.schemaVersion !== 2 || parsed.workbookCount !== 60 || parsed.entries.length !== 60) {
        throw new Error("The pinned IRS-to-DISA STIG registry is missing or invalid.");
    }
    return parsed;
}

function loadCciCatalog(): DisaCciCatalog {
    const parsed = readPinnedJson<DisaCciCatalog>(CCI_PATH, CCI_FILE_SHA256);
    if (
        parsed.schemaVersion !== 1 ||
        parsed.sourceUrl !== "https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/CCI_List.zip" ||
        !/^[a-f0-9]{64}$/.test(parsed.sourceSha256) ||
        parsed.mappingCount !== Object.keys(parsed.mappings || {}).length ||
        parsed.mappingCount < 3000
    ) {
        throw new Error("The pinned DISA CCI-to-NIST mapping is missing or invalid.");
    }
    return parsed;
}

function normalized(value: string): string {
    return value.toLowerCase().replace(/\bz\s*\/\s*os\b/g, "zos").replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
}

export function resolveDisaStigCatalogSources({
    parsed,
    officialSource,
}: {
    technology: string;
    parsed: ParsedSCSEM;
    officialSource?: { fileName: string; sha256: string } | null;
}): Array<{
    sourceKind: "STIG";
    sourceRelationship: "direct" | "adjacent";
    matchQuery: string;
    matchedSheets: string[];
    catalogEntry: DisaStigCatalogEntry;
    catalogReviewedAt: string;
    catalogSourceUrl: string;
    benchmarkIds: string[];
    expectedPackageSha256: string;
}> {
    {
        if (!officialSource) return [];
        const catalog = loadCatalog();
        const registry = loadDisaStigRegistry();
        const mappedWorkbook = registry.entries.find((entry) =>
            entry.fileName === officialSource.fileName && entry.sha256 === officialSource.sha256
        );
        if (!mappedWorkbook) {
            throw new Error("The official SCSEM is missing from the pinned DISA STIG registry.");
        }
        const parsedSheets = parsed.sheets
            .filter((sheet) => sheet.sheetType === "test_cases")
            .map((sheet) => sheet.sheetName)
            .sort();
        const mappedSheets = Object.keys(mappedWorkbook.sheets).sort();
        if (
            parsedSheets.length !== mappedSheets.length ||
            parsedSheets.some((sheet, index) => sheet !== mappedSheets[index])
        ) {
            throw new Error("The official SCSEM test-case sheets do not match the pinned DISA STIG registry.");
        }

        const selected = new Map<string, {
            sourceKind: "STIG";
            sourceRelationship: "direct" | "adjacent";
            matchQuery: string;
            matchedSheets: string[];
            catalogEntry: DisaStigCatalogEntry;
            catalogReviewedAt: string;
            catalogSourceUrl: string;
            benchmarkIds: string[];
            expectedPackageSha256: string;
        }>();
        for (const [sheetName, mapping] of Object.entries(mappedWorkbook.sheets)) {
            if (mapping.classification !== "direct" && mapping.classification !== "adjacent_version") continue;
            if (!mapping.catalogName || !mapping.sourceUrl) {
                throw new Error("A mapped DISA STIG source is missing its exact catalog identity.");
            }
            if (
                mapping.classification === "direct" &&
                (
                    !mapping.benchmarkIds?.length ||
                    mapping.benchmarkIds.some((id) => !/^[A-Za-z0-9_.-]+$/.test(id)) ||
                    !/^[a-f0-9]{64}$/.test(mapping.sourcePackageSha256 || "")
                )
            ) {
                throw new Error("A direct DISA STIG source is missing its pinned package hash or exact XCCDF benchmark IDs.");
            }
            const catalogEntry = catalog.entries.find((entry) =>
                entry.name === mapping.catalogName &&
                entry.url === mapping.sourceUrl &&
                entry.uploadDate === mapping.sourceUploadDate
            );
            if (!catalogEntry) throw new Error("A pinned DISA STIG registry source is absent from the catalog snapshot.");
            const sourceUrl = new URL(catalogEntry.url);
            if (
                sourceUrl.protocol !== "https:" ||
                sourceUrl.hostname !== "dl.dod.cyber.mil" ||
                !sourceUrl.pathname.endsWith("_STIG.zip") ||
                /sunset|scap|ansible|chef|viewer|overview|gpo/i.test(`${catalogEntry.name} ${catalogEntry.downloadType}`)
            ) {
                throw new Error("A pinned DISA source is not an eligible active manual STIG package.");
            }
            const sourceRelationship = mapping.classification === "direct" ? "direct" : "adjacent";
            const benchmarkIds = [...new Set(mapping.benchmarkIds || [])].sort();
            const expectedPackageSha256 = mapping.sourcePackageSha256 || "";
            const key = `${catalogEntry.url}|${sourceRelationship}|${benchmarkIds.join(",")}`;
            const existing = selected.get(key);
            if (existing) existing.matchedSheets.push(sheetName);
            else selected.set(key, {
                sourceKind: "STIG",
                sourceRelationship,
                matchQuery: mapping.catalogName,
                matchedSheets: [sheetName],
                catalogEntry,
                catalogReviewedAt: catalog.reviewedAt,
                catalogSourceUrl: catalog.sourceUrl,
                benchmarkIds,
                expectedPackageSha256,
            });
        }
        return [...selected.values()];
    }


}

function values<T>(value: T | T[] | undefined | null): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function plainText(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join(" ");
    if (typeof value === "object") {
        return Object.entries(value as Record<string, unknown>)
            .filter(([key]) => !key.startsWith("@"))
            .map(([, child]) => plainText(child)).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    }
    return "";
}

function collectRules(node: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (!node || typeof node !== "object") return output;
    if (Array.isArray(node)) {
        for (const child of node) collectRules(child, output);
        return output;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (key === "Rule") output.push(...values(child as Record<string, unknown> | Record<string, unknown>[]));
        collectRules(child, output);
    }
    return output;
}

export function parseDisaStigXccdf(xml: Buffer): ParsedDisaStig {
    if (xml.length <= 0 || xml.length > MAX_XCCDF_BYTES) throw new Error("DISA STIG XCCDF exceeded the allowed size.");
    const xmlText = xml.toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(xmlText)) throw new Error("DISA STIG XCCDF contained a prohibited document type or entity declaration.");
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@",
        removeNSPrefix: true,
        parseTagValue: false,
        trimValues: true,
    });
    const document = parser.parse(xmlText) as { Benchmark?: Record<string, unknown> };
    const benchmark = document.Benchmark;
    if (!benchmark) throw new Error("DISA STIG package did not contain an XCCDF Benchmark document.");
    const benchmarkId = String(benchmark["@id"] || "").trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(benchmarkId)) throw new Error("DISA STIG XCCDF benchmark ID was missing or invalid.");
    const cci = loadCciCatalog();
    const rules = collectRules(benchmark).map((rule): DisaStigRule | null => {
        const ident = values(rule.ident as Record<string, unknown> | Record<string, unknown>[]);
        const cciIds = ident
            .filter((item) => String(item["@system"] || "").includes("/cci"))
            .map((item) => plainText(item))
            .filter((value) => /^CCI-\d+$/.test(value));
        const vulnerabilityId = ident
            .filter((item) => String(item["@system"] || "").includes("/legacy"))
            .map((item) => plainText(item))
            .find((value) => /^V-\d+$/.test(value)) || null;
        const nistIds = [...new Set(cciIds.flatMap((id) => cci.mappings[id] || []).map((index) => {
            const match = index.match(/^([A-Z]{2,3}-\d+(?:\s*\(\d+\))?)/i);
            return normalizeNistControlId(match?.[1]);
        }).filter((value): value is string => Boolean(value)))];
        const check = values(rule.check as Record<string, unknown> | Record<string, unknown>[])[0];
        const version = plainText(rule.version);
        const title = plainText(rule.title);
        if (!version || !title) return null;
        return {
            benchmarkId,
            ruleId: String(rule["@id"] || version),
            vulnerabilityId,
            version,
            title,
            description: plainText(rule.description),
            checkContent: plainText(check?.["check-content"]),
            fixText: plainText(rule.fixtext),
            severity: String(rule["@severity"] || "unknown"),
            cciIds: [...new Set(cciIds)],
            nistIds,
        };
    }).filter((rule): rule is DisaStigRule => Boolean(rule));
    if (rules.length === 0) throw new Error("DISA STIG XCCDF contained no usable rules.");
    if (rules.length > 5000) throw new Error("DISA STIG XCCDF exceeded the allowed rule count.");
    return {
        benchmarkIds: [benchmarkId],
        title: plainText(benchmark.title),
        version: String(benchmark["@version"] || plainText(benchmark.version) || "unknown"),
        releaseInfo: plainText(benchmark["plain-text"]),
        rules,
    };
}

interface DisaXccdfDocument {
    path: string;
    parsed: ParsedDisaStig;
}

interface DisaArchiveBudget {
    entries: number;
    uncompressedBytes: number;
}

function zipEntryWithinLimit(file: object, maxBytes: number): boolean {
    const metadata = file as { _data?: { uncompressedSize?: number } };
    const declaredSize = Number(metadata._data?.uncompressedSize || 0);
    return declaredSize <= 0 || declaredSize <= maxBytes;
}

async function findXccdfDocumentsInZip(
    buffer: Buffer,
    depth = 0,
    prefix = "",
    budget: DisaArchiveBudget = { entries: 0, uncompressedBytes: 0 }
): Promise<DisaXccdfDocument[]> {
    if (depth > 2) return [];
    const zip = await JSZip.loadAsync(buffer);
    const files = Object.values(zip.files).filter((file) => !file.dir);
    budget.entries += files.length;
    if (budget.entries > MAX_ARCHIVE_ENTRIES) throw new Error("DISA STIG package exceeded the allowed archive entry count.");
    const documents: DisaXccdfDocument[] = [];
    for (const file of files.filter((candidate) => /\.xml$/i.test(candidate.name))) {
        if (!zipEntryWithinLimit(file, MAX_XCCDF_BYTES)) continue;
        const content = Buffer.from(await file.async("uint8array"));
        if (content.length <= 0 || content.length > MAX_XCCDF_BYTES) continue;
        budget.uncompressedBytes += content.length;
        if (budget.uncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error("DISA STIG package exceeded the cumulative extraction budget.");
        const text = content.toString("utf8");
        if (/<!DOCTYPE|<!ENTITY/i.test(text)) continue;
        try {
            documents.push({
                path: `${prefix}${file.name}`,
                parsed: parseDisaStigXccdf(content),
            });
        } catch {
            // Packages contain metadata and other XML documents. Only valid,
            // bounded XCCDF Benchmark roots are eligible.
        }
    }
    for (const nested of files.filter((file) => /\.zip$/i.test(file.name))) {
        if (!zipEntryWithinLimit(nested, MAX_STIG_PACKAGE_BYTES)) continue;
        const content = Buffer.from(await nested.async("uint8array"));
        if (content.length <= 0 || content.length > MAX_STIG_PACKAGE_BYTES) continue;
        budget.uncompressedBytes += content.length;
        if (budget.uncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error("DISA STIG package exceeded the cumulative extraction budget.");
        documents.push(...await findXccdfDocumentsInZip(
            content,
            depth + 1,
            `${prefix}${nested.name}!`,
            budget
        ));
    }
    return documents;
}

export async function parseSelectedDisaStigBenchmarksFromZip(
    packageBuffer: Buffer,
    benchmarkIds: string[]
): Promise<ParsedDisaStig> {
    const expectedIds = [...new Set(benchmarkIds)].sort();
    if (expectedIds.length === 0 || expectedIds.some((id) => !/^[A-Za-z0-9_.-]+$/.test(id))) {
        throw new Error("No valid pinned XCCDF benchmark IDs were supplied.");
    }
    const documents = await findXccdfDocumentsInZip(packageBuffer);
    const selected: DisaXccdfDocument[] = [];
    for (const benchmarkId of expectedIds) {
        const matches = documents.filter((document) => document.parsed.benchmarkIds[0] === benchmarkId);
        const currentMatches = matches.filter((document) => !/supplemental/i.test(document.path));
        const candidates = currentMatches.length > 0 ? currentMatches : matches;
        if (candidates.length !== 1) {
            throw new Error(
                candidates.length === 0
                    ? `Pinned DISA XCCDF benchmark ${benchmarkId} was absent from the package.`
                    : `Pinned DISA XCCDF benchmark ${benchmarkId} was ambiguous within the package.`
            );
        }
        selected.push(candidates[0]);
    }
    const ruleKeys = new Set<string>();
    const rules = selected.flatMap((document) => document.parsed.rules).filter((rule) => {
        const key = `${rule.benchmarkId}|${rule.ruleId}`;
        if (ruleKeys.has(key)) throw new Error(`Duplicate DISA STIG rule identity ${key}.`);
        ruleKeys.add(key);
        return true;
    });
    if (rules.length === 0) throw new Error("Selected DISA STIG benchmarks contained no usable rules.");
    return {
        benchmarkIds: expectedIds,
        title: selected.map((document) => document.parsed.title).join("; "),
        version: selected.map((document) => `${document.parsed.benchmarkIds[0]}=${document.parsed.version}`).join("; "),
        releaseInfo: selected.map((document) => document.parsed.releaseInfo).filter(Boolean).join("; "),
        rules,
    };
}

async function readResponseBodyBounded(response: Response, maxBytes: number): Promise<Buffer> {
    if (!response.body) throw new Error("DISA STIG download returned no response body.");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel("size limit exceeded");
                throw new Error("DISA STIG package exceeded the allowed size.");
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
}

export async function downloadAndParseDisaStigSource(
    source: ReturnType<typeof resolveDisaStigCatalogSources>[number]
): Promise<ResolvedDisaStigSource> {
    const url = new URL(source.catalogEntry.url);
    if (url.protocol !== "https:" || url.hostname !== "dl.dod.cyber.mil" || !url.pathname.toLowerCase().endsWith(".zip")) {
        throw new Error("DISA STIG source URL was not on the approved official host.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let response: Response;
    try {
        response = await fetch(url, { signal: controller.signal, redirect: "error" });
    } finally {
        clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`DISA STIG download failed with HTTP ${response.status}.`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_STIG_PACKAGE_BYTES) throw new Error("DISA STIG package exceeded the allowed size.");
    const packageBuffer = await readResponseBodyBounded(response, MAX_STIG_PACKAGE_BYTES);
    if (packageBuffer.length <= 0 || packageBuffer.length > MAX_STIG_PACKAGE_BYTES || !packageBuffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        throw new Error("DISA STIG download was not a bounded ZIP package.");
    }
    const packageSha256 = sha256(packageBuffer);
    if (packageSha256 !== source.expectedPackageSha256) {
        throw new Error("DISA STIG package SHA-256 did not match the reviewed registry.");
    }
    const parsed = await parseSelectedDisaStigBenchmarksFromZip(packageBuffer, source.benchmarkIds);
    const snapshotDir = runtimeDataDir("disa-stig");
    fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, `${safePart(source.catalogEntry.name)}-${packageSha256.slice(0, 16)}.zip`);
    if (!fs.existsSync(snapshotPath)) fs.writeFileSync(snapshotPath, packageBuffer, { mode: 0o600 });
    return {
        ...source,
        packageSha256,
        downloadedAt: new Date().toISOString(),
        snapshotPath,
        parsed,
    };
}

function severityCriticality(value: string): string {
    if (value.toLowerCase() === "high") return "Critical";
    if (value.toLowerCase() === "low") return "Limited";
    return "Moderate";
}

function bestExistingControl(rule: DisaStigRule, controls: SCSEMControlEvidence[]): SCSEMControlEvidence | null {
    const nist = new Set(rule.nistIds);
    const matches = controls.filter((control) => {
        const id = normalizeNistControlId(control.nistId);
        return Boolean(id && nist.has(id));
    });
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    const ranked = matches.map((control) => ({
        control,
        score: textSimilarity(
            `${control.sectionTitle || ""} ${control.description || ""}`,
            `${rule.title} ${rule.description}`
        ),
    })).sort((left, right) => right.score - left.score);
    if (ranked[0].score < 0.28 || ranked[0].score - ranked[1].score < 0.08) return null;
    return ranked[0].control;
}

export function buildDisaStigChanges({
    source,
    controls,
    pub1075Version,
    nistVersion,
    maxChanges = 500,
}: {
    source: ResolvedDisaStigSource;
    controls: SCSEMControlEvidence[];
    pub1075Version: string;
    nistVersion: string;
    maxChanges?: number;
}): any[] {
    if (source.sourceRelationship !== "direct") return [];
    const scopedControls = controls.filter((control) => source.matchedSheets.includes(control.sourceSheet || ""));
    const existingRecommendationIds = new Set(scopedControls.flatMap((control) => [
        control.testId,
        control.recommendationNum,
        control.cisBenchmarkRef,
    ].filter(Boolean).map((value) => normalized(String(value)))));
    const changes: any[] = [];
    for (const rule of source.parsed.rules) {
        if (changes.length >= Math.min(maxChanges, 500)) break;
        if (existingRecommendationIds.has(normalized(rule.version)) || (rule.vulnerabilityId && existingRecommendationIds.has(normalized(rule.vulnerabilityId)))) continue;
        const hasExistingNistMapping = scopedControls.some((control) => {
            const id = normalizeNistControlId(control.nistId);
            return Boolean(id && rule.nistIds.includes(id));
        });
        const existing = bestExistingControl(rule, scopedControls);
        const evidence = {
            evidenceTier: "direct",
            sourceKind: "STIG",
            sourceRelationship: "direct",
            sourceSheet: existing?.sourceSheet || source.matchedSheets[0],
            sourceUrl: source.catalogEntry.url,
            sourceTitle: source.catalogEntry.name,
            sourceUploadDate: source.catalogEntry.uploadDate,
            sourcePackageSha256: source.packageSha256,
            stigBenchmarkId: rule.benchmarkId,
            stigRuleId: rule.ruleId,
            stigVersion: rule.version,
            stigVulnerabilityId: rule.vulnerabilityId,
            cciIds: rule.cciIds,
            nistControlIds: rule.nistIds,
            pub1075Version,
            nistVersion,
        };
        const updateChoices = existing ? [
            { field: "testProcedures", current: existing.testProcedures || "", proposed: rule.checkContent },
            { field: "remediationProcedure", current: existing.remediationProcedure || "", proposed: rule.fixText },
            { field: "description", current: existing.description || "", proposed: rule.description },
        ].filter((choice) => choice.proposed && isMaterialTextDelta(choice.current, choice.proposed)) : [];
        const update = updateChoices[0];
        if (existing && update) {
            changes.push({
                action: "updateField",
                testId: existing.testId,
                targetSheet: existing.sourceSheet,
                field: update.field,
                currentValue: update.current,
                proposedValue: update.proposed,
                reason: `The current official DISA ${source.catalogEntry.name} rule ${rule.version} provides materially different ${update.field} evidence for the exact mapped NIST control. Reviewer approval is required before replacing IRS template wording.`,
                confidence: "needs_review",
                sourceEvidence: evidence,
            });
            continue;
        }
        // A same-NIST row exists but could not be uniquely rebound. Do not turn
        // an ambiguous update into a misleading duplicate add-control proposal.
        if (!existing && hasExistingNistMapping) continue;
        // Unmatched rules need one explicit target sheet. Multi-sheet source
        // scopes may support existing-row updates but cannot choose an insertion
        // sheet without a reviewed rule-level mapping.
        if (source.matchedSheets.length !== 1) continue;
        // A new SCSEM row has one NIST mapping field. Do not force a STIG rule
        // with zero or multiple mapped controls into an invented single mapping.
        if (rule.nistIds.length !== 1) continue;
        changes.push({
            action: "addControl",
            testId: `NEW-STIG-${safePart(rule.benchmarkId)}-${safePart(rule.version || rule.ruleId)}`,
            targetSheet: source.matchedSheets[0],
            field: "newControl",
            currentValue: "No directly matched SCSEM row was found for this current DISA STIG rule.",
            proposedValue: `Review and, if applicable, add DISA STIG ${rule.version}: ${rule.title}`,
            reason: `Current official DISA source ${source.catalogEntry.name} includes rule ${rule.version}, but no directly matched SCSEM row was found by exact NIST mapping and rule identity. This is a reviewer-gated applicability candidate.`,
            confidence: "needs_review",
            newControl: {
                nistId: rule.nistIds[0] || null,
                nistControlName: null,
                testMethod: "Examine, Interview, Test",
                sectionTitle: rule.title,
                description: rule.description || rule.title,
                testProcedures: rule.checkContent || `Examine the system and supporting evidence for DISA STIG rule ${rule.version}.`,
                expectedResults: `The system satisfies applicable DISA STIG rule ${rule.version}: ${rule.title}`,
                findingStatement: `The system did not satisfy applicable DISA STIG rule ${rule.version}: ${rule.title}`,
                criticality: severityCriticality(rule.severity),
                issueCode: null,
                cisBenchmarkRef: null,
                recommendationNum: null,
                rationale: `Official DISA STIG rule mapped through ${rule.cciIds.join(", ") || "the published XCCDF source"}.`,
                impact: rule.description,
                remediationProcedure: rule.fixText || `Implement the applicable configuration required by DISA STIG rule ${rule.version}.`,
            },
            sourceEvidence: evidence,
        });
    }
    return changes;
}
