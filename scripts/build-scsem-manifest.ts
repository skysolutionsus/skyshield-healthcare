import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSCSEMFile } from "../src/lib/xlsx-parser";

const SOURCE_PAGE_URL =
    "https://www.irs.gov/privacy-disclosure/computer-security-compliance-references-and-related-topics-scsem-updates";

const CONFLICTING_PACKAGE_AUDIT = {
    sourceUrl: "https://www.irs.gov/pub/safeguard/scsem-package-05262026-current.zip",
    auditedAt: "2026-08-20",
    httpLastModified: "2026-08-04T00:38:02Z",
    sha256: "62f43d9fcf2af8cfc92c7c90393d012edb8fcbe4aa2d27ce15b2ee8b3ce4ecd0",
    sizeBytes: 13_860_534,
    status: "excluded_conflicting_snapshot",
    workbookCount: 62,
    totalControls: 11_564,
    pairedWorkbookCount: 59,
    pairedControlCount: 10_782,
    allPairedRawHashesDiffer: true,
    allPairedDirectCoreModifiedLater: false,
    packageOnly: [
        { subject: "SQL Server", version: "5.0", controls: 243 },
        { subject: "Oracle Solaris", version: "3.4", controls: 486 },
        { subject: "NGINX Web Server", version: "1.0", controls: 53 },
    ],
    directOnly: [
        { subject: "Microsoft Server 2012", version: "3.6", controls: 273 },
    ],
} as const;

type ManifestEntry = {
    sourceUrl: string;
    sha256: string;
    sizeBytes: number;
    fileName: string;
    file: string;
    category: string;
    subject: string | null;
    version: string | null;
    effectiveDate: string | null;
    totalControls: number;
    testCaseSheets: string[];
};

function argument(name: string): string {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1 || !process.argv[index + 1]) {
        throw new Error(`Missing required --${name} argument.`);
    }
    return path.resolve(process.argv[index + 1]);
}

function optionalArgument(name: string, fallback: string): string {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 || !process.argv[index + 1] ? fallback : process.argv[index + 1];
}

function normalizedFileName(value: string): string {
    return value
        .replace(/^\d{2}-/, "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

function displayNameFromFileName(fileName: string): string {
    return path.basename(fileName, path.extname(fileName))
        .replace(/^safeguards?-scsem[-_\s]*/i, "")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function categoryFor(fileName: string): string {
    const name = fileName.toLowerCase();

    if (name.includes("container")) return "Containers";
    if (name.includes("mot-")) return "MOT";
    if (/vmware|generic-vdi/.test(name)) return "Virtualization";
    if (/acf2|racf|ibmi|top-secret|unisys/.test(name)) return "Mainframe";
    if (/sql|oracle(?!-solaris)|db2|mongodb|mysql|data-warehouse|generic-db/.test(name)) {
        return "Database";
    }
    if (/apache24-iis|generic-web-server/.test(name)) return "Web";
    if (/firewall|fortigate|network-assessment|switch-router|\bsan\b|voip|vpn|wireless/.test(name)) {
        return "Network";
    }
    if (/windows/.test(name) || /win-server/.test(name)) return "Windows";
    if (/aix|amazon-linux|debian|generic-unix|hpux|oel|oracle-solaris|rhel|red-hat|rocky|suse/.test(name)) {
        return "UNIX-Linux";
    }
    if (/macos/.test(name)) return "MacOS";
    if (/apple-ios|cloud-scsem|generic-os|printer/.test(name)) return "Others";
    return "Application";
}

function workbookLinks(pageHtml: string): string[] {
    const matches = [...pageHtml.matchAll(/href=["']([^"']+\.xlsx(?:\?[^"']*)?)["']/gi)];
    const urls = matches.map((match) => new URL(match[1], SOURCE_PAGE_URL).toString());
    return [...new Set(urls)];
}

function sha256(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

function main() {
    const pagePath = argument("page");
    const downloadsPath = argument("downloads");
    const reviewedAt = optionalArgument("page-reviewed-at", "2026-08-20");
    const acquiredAt = optionalArgument("acquired-at", "2026-08-20");
    const root = process.cwd();
    const destination = path.join(root, "data", "scsems", "current");

    const links = workbookLinks(fs.readFileSync(pagePath, "utf8"));
    if (links.length !== 60) {
        throw new Error(`Expected 60 current IRS workbook links, found ${links.length}.`);
    }

    const downloads = fs.readdirSync(downloadsPath)
        .filter((fileName) => /\.xlsx$/i.test(fileName));
    const downloadByName = new Map(
        downloads.map((fileName) => [normalizedFileName(fileName), fileName])
    );
    if (downloadByName.size !== 60) {
        throw new Error(`Expected 60 unique downloaded workbooks, found ${downloadByName.size}.`);
    }

    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });
    const entries: ManifestEntry[] = [];

    for (const sourceUrl of links) {
        const fileName = decodeURIComponent(path.basename(new URL(sourceUrl).pathname));
        const downloadedName = downloadByName.get(normalizedFileName(fileName));
        if (!downloadedName) {
            throw new Error(`No downloaded workbook matches ${fileName}.`);
        }

        const sourcePath = path.join(downloadsPath, downloadedName);
        const targetPath = path.join(destination, fileName);
        const buffer = fs.readFileSync(sourcePath);
        fs.copyFileSync(sourcePath, targetPath);
        const parsed = parseSCSEMFile(targetPath);

        entries.push({
            sourceUrl,
            sha256: sha256(buffer),
            sizeBytes: buffer.length,
            fileName,
            file: path.relative(root, targetPath).split(path.sep).join("/"),
            category: categoryFor(fileName),
            subject: parsed.metadata.subject,
            version: parsed.metadata.version,
            effectiveDate: parsed.metadata.effectiveDate,
            totalControls: parsed.totalControls,
            testCaseSheets: parsed.sheets
                .filter((sheet) => sheet.sheetType === "test_cases")
                .map((sheet) => sheet.sheetName),
        });

        global.gc?.();
    }

    const manifest = {
        schemaVersion: 1,
        sourcePageUrl: SOURCE_PAGE_URL,
        sourcePageReviewedAt: reviewedAt,
        snapshotAcquiredAt: acquiredAt,
        sourcePolicy: "individual_xlsx_links",
        conflictingPackageAudit: CONFLICTING_PACKAGE_AUDIT,
        expectedWorkbookCount: 60,
        workbooks: entries,
    };
    fs.writeFileSync(
        path.join(root, "data", "scsem-manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`
    );
    fs.writeFileSync(
        path.join(root, "data", "scsem-index.json"),
        `${JSON.stringify(entries.map((entry) => ({
            id: `official-${entry.sha256.slice(0, 20)}`,
            file: entry.file,
            category: entry.category,
            name: [entry.subject || displayNameFromFileName(entry.fileName), entry.version && `v${entry.version}`]
                .filter(Boolean)
                .join(" "),
        })), null, 2)}\n`
    );

    process.stdout.write(`Pinned ${entries.length} IRS SCSEM workbooks in ${destination}.\n`);
}

main();
