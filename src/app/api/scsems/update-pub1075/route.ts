import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadOfficialPub1075FromIrs, PUB_1075_PDF_URL } from "@/lib/knowledge/ingest";
import { isAdminRole } from "@/lib/roles";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data", "pub1075");
const TEXT_PATH = join(DATA_DIR, "p1075-full-text.md");

export const runtime = "nodejs";

export async function POST() {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        if (!isAdminRole((session.user as unknown as { role: string }).role)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const userInfo = session.user as unknown as { id: string; organizationId: string };

        console.log("Downloading latest Pub 1075 from IRS...");

        const pub1075 = await loadOfficialPub1075FromIrs();
        mkdirSync(DATA_DIR, { recursive: true });

        // Step 4: Backup previous version
        if (existsSync(TEXT_PATH)) {
            const backupPath = TEXT_PATH.replace(".md", `.backup-${Date.now()}.md`);
            const existing = readFileSync(TEXT_PATH, "utf-8");
            writeFileSync(backupPath, existing);
            console.log(`Backed up previous version to ${backupPath}`);
        }

        // Step 5: Write new full-text file
        writeFileSync(TEXT_PATH, pub1075.content, "utf-8");
        console.log(`Wrote ${pub1075.content.length} chars to ${TEXT_PATH}`);

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
                    pdfSizeKB: pub1075.pdfSizeKB,
                    pageCount: pub1075.pageCount,
                    textLength: pub1075.content.length,
                    downloadedAt: pub1075.downloadedAt,
                    pdfSha256: pub1075.pdfSha256,
                    textSha256: pub1075.textSha256,
                },
            },
        });

        return NextResponse.json({
            success: true,
            message: `Downloaded and parsed Pub 1075 (${pub1075.pageCount} pages, ${pub1075.pdfSizeKB}KB)`,
            details: {
                pageCount: pub1075.pageCount,
                pdfSizeKB: pub1075.pdfSizeKB,
                textLength: pub1075.content.length,
                source: PUB_1075_PDF_URL,
                updatedAt: pub1075.downloadedAt,
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
