import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const PUB_1075_PDF_URL = "https://www.irs.gov/pub/irs-pdf/p1075.pdf";
const DATA_DIR = join(process.cwd(), "data", "pub1075");
const PDF_PATH = join(DATA_DIR, "p1075.pdf");
const TEXT_PATH = join(DATA_DIR, "p1075-full-text.md");

export async function POST(request: Request) {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const userInfo = session.user as unknown as { id: string; organizationId: string };

        console.log("Downloading latest Pub 1075 from IRS...");

        // Step 1: Download the PDF
        const pdfResponse = await fetch(PUB_1075_PDF_URL);
        if (!pdfResponse.ok) {
            return NextResponse.json({
                error: `Failed to download Pub 1075 PDF: ${pdfResponse.status} ${pdfResponse.statusText}`,
            }, { status: 502 });
        }

        const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
        const pdfSizeKB = Math.round(pdfBuffer.length / 1024);
        console.log(`Downloaded ${pdfSizeKB}KB PDF`);

        // Save the PDF
        writeFileSync(PDF_PATH, pdfBuffer);

        // Step 2: Parse PDF to text
        const pdfParseModule = await import("pdf-parse") as any;
        const pdfParse = pdfParseModule.default || pdfParseModule;
        const parsed = await pdfParse(pdfBuffer);

        const pageCount = parsed.numpages;
        const rawText = parsed.text;

        // Step 3: Format content with page markers
        // pdf-parse gives us all text — format it nicely
        const header = `# IRS Publication 1075 - Tax Information Security Guidelines\n# Total Pages: ${pageCount}\n# Downloaded: ${new Date().toISOString()}\n# Source: ${PUB_1075_PDF_URL}\n\n`;

        const formattedText = header + rawText;

        // Step 4: Backup previous version
        if (existsSync(TEXT_PATH)) {
            const backupPath = TEXT_PATH.replace(".md", `.backup-${Date.now()}.md`);
            const existing = readFileSync(TEXT_PATH, "utf-8");
            writeFileSync(backupPath, existing);
            console.log(`Backed up previous version to ${backupPath}`);
        }

        // Step 5: Write new full-text file
        writeFileSync(TEXT_PATH, formattedText, "utf-8");
        console.log(`Wrote ${formattedText.length} chars to ${TEXT_PATH}`);

        // Step 6: Log the update
        await db.auditLog.create({
            data: {
                organizationId: userInfo.organizationId,
                userId: userInfo.id,
                action: "Pub 1075 Document Updated",
                resourceType: "Publication",
                resourceId: "pub1075",
                metadata: {
                    source: PUB_1075_PDF_URL,
                    pdfSizeKB,
                    pageCount,
                    textLength: formattedText.length,
                    downloadedAt: new Date().toISOString(),
                },
            },
        });

        return NextResponse.json({
            success: true,
            message: `Downloaded and parsed Pub 1075 (${pageCount} pages, ${pdfSizeKB}KB)`,
            details: {
                pageCount,
                pdfSizeKB,
                textLength: formattedText.length,
                source: PUB_1075_PDF_URL,
                updatedAt: new Date().toISOString(),
            },
            note: "Both the AI agent and Pub 1075 sync endpoint will use the updated text. Server restart may be needed for the AI agent to pick up the new text.",
        });

    } catch (error: any) {
        console.error("Pub 1075 update error:", error);
        return NextResponse.json({
            error: `Failed to update Pub 1075: ${error.message || "Unknown error"}`,
        }, { status: 500 });
    }
}

// GET — check current Pub 1075 status
export async function GET() {
    try {
        let currentInfo = null;

        if (existsSync(TEXT_PATH)) {
            const content = readFileSync(TEXT_PATH, "utf-8");
            const lines = content.split("\n");

            // Extract metadata from header
            const downloadDate = lines.find(l => l.startsWith("# Downloaded:"))?.replace("# Downloaded: ", "") || null;
            const totalPages = lines.find(l => l.startsWith("# Total Pages:"))?.replace("# Total Pages: ", "") || null;

            currentInfo = {
                exists: true,
                textLength: content.length,
                lineCount: lines.length,
                totalPages,
                downloadDate,
                source: PUB_1075_PDF_URL,
            };
        } else {
            currentInfo = { exists: false };
        }

        return NextResponse.json({
            currentVersion: currentInfo,
            updateUrl: "POST /api/scsems/update-pub1075 to download latest from IRS",
            irsSource: PUB_1075_PDF_URL,
        });

    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
