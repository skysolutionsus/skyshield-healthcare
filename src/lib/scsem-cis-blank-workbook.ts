import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { officialSCSEMManifest, sha256Buffer } from "@/lib/scsem-official-manifest";
import { extendAppendedSCSEMFormulaRanges, translateCopiedSCSEMFormula, translateInsertedSCSEMFormula } from "@/lib/scsem-formula-translation";
import type { CISBootstrapStructuralBaseline } from "@/lib/scsem-cis-bootstrap";

// This is deliberately a generator profile, not a general workbook updater.
// Any baseline revision must get its own structural review before admission.
const SOURCE_SHA256 = "4553b3aa46ae4986084a39a5dccc0aabefb8cefa5d930de6717c94c156002217";
const TARGET = "General App Test Cases";
const CELLS = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
const ROWS = /<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g;
const attr = (xml: string, name: string) => xml.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

function escapeXml(value: string): string {
    if (/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(value)) {
        throw new Error("Cannot build CIS blank workbook: XML-illegal label text.");
    }
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function opening(cell: string): string {
    return cell.match(/^<c\b[^>]*>/)![0].replace(/\s+t="[^"]*"/g, "").replace(/\/>$/, ">");
}

function stringCell(address: string, text: string, source = `<c r="${address}">`): string {
    const tag = opening(source).replace(/\br="[^"]*"/, `r="${address}"`).replace(/>$/, ' t="inlineStr">');
    return `${tag}<is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function replaceCell(xml: string, address: string, text: string): string {
    let found = false;
    const result = xml.replace(CELLS, (cell) => {
        if (attr(cell, "r") !== address) return cell;
        found = true;
        return stringCell(address, text, cell);
    });
    if (!found) throw new Error(`Pinned bootstrap cell ${address} is missing.`);
    return result;
}

function blankRow(anchor: string, row: number, throughColumn: number, formulas: boolean): string {
    const cells = new Map((anchor.match(CELLS) || []).map((cell) => [XLSX.utils.decode_cell(attr(cell, "r")!).c, cell]));
    const rowTag = anchor.match(/^<row\b[^>]*>/)![0]
        .replace(/\br="[^"]*"/, `r="${row}"`).replace(/\s+hidden="[^"]*"/g, "")
        .replace(/\s+spans="[^"]*"/g, "");
    const result: string[] = [];
    for (let col = 0; col <= throughColumn; col++) {
        const address = `${XLSX.utils.encode_col(col)}${row}`;
        const source = cells.get(col) || cells.get(throughColumn > 26 ? 26 : col) || `<c r="${address}"/>`;
        const tag = opening(source).replace(/\br="[^"]*"/, `r="${address}"`);
        const formula = col <= 26 && formulas ? source.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/) : null;
        if (formula) {
            result.push(`${tag}<f${formula[1]}>${translateCopiedSCSEMFormula(formula[2], row - 3, { formulaType: attr(`<f${formula[1]}>`, "t") || null })}</f></c>`);
        } else result.push(tag.replace(/>$/, "/>"));
    }
    return `${rowTag}${result.join("")}</row>`;
}

/** Patch only admitted OOXML nodes; never reserialize the source through SheetJS. */
export async function buildCISBootstrapBlankWorkbook(
    technology: string,
    benchmarkVersion: string,
    candidateRowCount = 1
): Promise<{ buffer: Buffer; baseline: CISBootstrapStructuralBaseline }> {
    if (!Number.isInteger(candidateRowCount) || candidateRowCount < 1 || candidateRowCount > 5000) {
        throw new Error("CIS candidate row count must be an integer from 1 to 5000.");
    }

    escapeXml(technology);
    escapeXml(benchmarkVersion);
    const entry = officialSCSEMManifest().workbooks.find((item) => item.subject === "Generic Application");
    if (!entry) throw new Error("The pinned Generic Application SCSEM baseline is unavailable.");
    const source = fs.readFileSync(path.join(process.cwd(), entry.file));
    if (entry.sha256 !== SOURCE_SHA256 || source.length !== entry.sizeBytes || sha256Buffer(source) !== entry.sha256) {
        throw new Error("The pinned Generic Application SCSEM baseline failed integrity validation.");
    }
    const zip = await JSZip.loadAsync(source);
    const read = async (name: string) => {
        const file = zip.file(name);
        if (!file) throw new Error(`Pinned bootstrap ZIP part ${name} is missing.`);
        return file.async("string");
    };
    const write = (name: string, xml: string) => zip.file(name, xml, { createFolders: false });
    const last = candidateRowCount + 3; // row 3 is the donor; exporter begins at row 4.
    for (const [part, lastControl, allocatedLast] of [
        ["xl/worksheets/sheet4.xml", 73, last],
        ["xl/worksheets/sheet5.xml", 17, 3],
    ] as const) {
        let xml = await read(part);
        const anchor = (xml.match(ROWS) || []).find((row) => attr(row, "r") === "3");
        if (!anchor || !anchor.includes("<f>")) throw new Error("Pinned bootstrap formula/style anchor is missing.");
        const target = part.endsWith("sheet4.xml");
        const extra = target ? Math.max(0, last - 73) : 0;
        xml = xml.replace(ROWS, (rowXml) => {
            const row = Number(attr(rowXml, "r"));
            if (extra && row >= 74) {
                // Move the pinned dropdown-list tail; never overwrite it with candidates.
                return rowXml.replace(/\br="([A-Z]*)(\d+)"/g, (_, col: string, number: string) =>
                    `r="${col}${Number(number) + extra}"`);
            }
            if (row < 3 || row > lastControl) return rowXml;
            if (row <= allocatedLast) return blankRow(anchor, row, target ? 28 : 26, true);
            // Former controls disappear, but physical styles and helper-list rows remain.
            return rowXml.replace(CELLS, (cell) => opening(cell).replace(/>$/, "/>"));
        });
        if (target) {
            if (extra) {
                const additionalRows = Array.from({ length: extra }, (_, index) => blankRow(anchor, 74 + index, 28, true)).join("");
                xml = xml.replace(new RegExp(`<row\\b[^>]*\\br="${74 + extra}"`), (tag) => additionalRows + tag);
                xml = xml.replace(/(<(?:formula1|formula2)>)([^<]*)(<\/formula[12]>)/g, (_, start: string, formula: string, end: string) =>
                    start + translateInsertedSCSEMFormula(formula, 74, { formulaSheet: TARGET, insertedSheet: TARGET, rowCount: extra }) + end);
                const extend = (sqref: string) => sqref.split(/\s+/).map((token) => token.replace(/(:\$?[A-Z]+\$?)73$/, `$1${last}`)).join(" ");
                xml = xml.replace(/\bsqref="([^"]*)"/g, (_, sqref: string) => `sqref="${extend(sqref)}"`)
                    .replace(/<xm:sqref>([^<]+)<\/xm:sqref>/g, (_, sqref: string) => `<xm:sqref>${extend(sqref)}</xm:sqref>`);
            }
            xml = xml.replace(/<row\b[^>]*\br="2"[^>]*>[\s\S]*?<\/row>/, (row) => {
                const headerCell = (row.match(CELLS) || []).find((cell) => attr(cell, "r") === "AA2");
                if (!headerCell) throw new Error("Pinned bootstrap header style is missing.");
                return row.replace("</row>", stringCell("AB2", "CIS Benchmark Ref", headerCell) +
                    stringCell("AC2", "CIS Recommendation #", headerCell) + "</row>");
            });
            xml = xml.replace(/(<autoFilter\b[^>]*ref=")A2:N2"/, `$1A2:N${last}"`);
            xml = xml.replace(/(<dimension\b[^>]*ref=")[^"]+/, `$1A1:AC${88 + extra}`);
            xml = replaceCell(xml, "A1", "SkyShield WORKING DRAFT — not an official IRS SCSEM");
        }
        write(part, xml);
    }
    let dashboard = await read("xl/worksheets/sheet1.xml");
    for (const [address, text] of Object.entries({
        A1: "SkyShield WORKING DRAFT — not an official IRS SCSEM",
        A2: `CIS Benchmark revision ${benchmarkVersion}; mapping, issue-code review, QC and release approval required.`,
        A4: ` ▪ SCSEM Subject: ${technology}`,
        A5: " ▪ SCSEM Version: WORKING DRAFT",
        A6: " ▪ SCSEM Release Date: NOT RELEASED",
    })) dashboard = replaceCell(dashboard, address, text);
    write("xl/worksheets/sheet1.xml", dashboard);
    // Retain summary expressions, but never display cached scores of removed controls.
    // The pinned source has three historical General App range endpoints.
    const extendSummary = (formula: string) => [68, 70, 73].reduce((value, end) =>
        last > end ? extendAppendedSCSEMFormulaRanges(value, end, last, {
            formulaSheet: "Results", appendedSheet: TARGET,
        }) : value, formula);
    const results = (await read("xl/worksheets/sheet2.xml")).replace(CELLS, (cell) => {
        if (!/<f\b/.test(cell)) return cell;
        return cell.replace(/<v\b[^>]*(?:\/>|>[\s\S]*?<\/v>)/g, "")
            .replace(/(<f\b[^>]*>)([\s\S]*?)(<\/f>)/g,
                (_, start: string, formula: string, end: string) => start + extendSummary(formula) + end);
    });
    write("xl/worksheets/sheet2.xml", results);
    let chainSheet = "";
    let chain = (await read("xl/calcChain.xml")).replace(/<c\b[^>]*\/>/g, (node) => {
        chainSheet = attr(node, "i") || chainSheet;
        const row = XLSX.utils.decode_cell(attr(node, "r")!).r + 1;
        if ((chainSheet === "4" && row > last) || (chainSheet === "14" && row > 3)) return "";
        // Make inherited sheet IDs explicit when removing chain entries.
        return attr(node, "i") ? node : node.replace("/>", ` i="${chainSheet}"/>`);
    });
    if (last > 73) chain = chain.replace("</calcChain>",
        Array.from({ length: last - 73 }, (_, i) => `<c r="AA${74 + i}" i="4"/>`).join("") + "</calcChain>");
    write("xl/calcChain.xml", chain);
    write("xl/workbook.xml", (await read("xl/workbook.xml"))
        .replace("'General App Test Cases'!$A$2:$N$2</definedName>", `'General App Test Cases'!$A$2:$N$${last}</definedName>`)
        .replace(/<calcPr\b[^>]*\/>/, '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>'));
    return {
        buffer: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
        baseline: { sourceFileName: entry.fileName, sourceUrl: entry.sourceUrl, sourceSha256: entry.sha256,
            sourceVersion: entry.version, targetSheet: TARGET },
    };
}
