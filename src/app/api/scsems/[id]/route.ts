import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { importSCSEMTemplateWorkbook } from "@/lib/scsem-importer";

async function fetchTemplate(id: string) {
    return db.sCSEMTemplate.findUnique({
        where: { id },
        include: {
            sheets: {
                orderBy: { sheetIndex: "asc" },
                include: {
                    controls: {
                        orderBy: { rowIndex: "asc" },
                    },
                },
            },
            changeLogs: {
                orderBy: { changeDate: "desc" },
            },
            updateReviews: {
                orderBy: { createdAt: "desc" },
                include: {
                    benchmark: true,
                },
            },
        },
    });
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    try {
        let template = await fetchTemplate(id);

        if (!template) {
            return NextResponse.json({ error: "SCSEM not found" }, { status: 404 });
        }

        if (template.sheets.length === 0) {
            const templateBeforeImport = template;
            try {
                await importSCSEMTemplateWorkbook(template.id, template.filePath);
                template = await fetchTemplate(id);
            } catch (error: any) {
                console.error(`SCSEM lazy import failed for ${templateBeforeImport.name}:`, error);
                return NextResponse.json({
                    ...templateBeforeImport,
                    sheets: [],
                    changeLogs: [],
                    importError: `Could not import source workbook: ${error.message || "Unknown error"}`,
                });
            }
        }

        if (!template) {
            return NextResponse.json({ error: "SCSEM not found after import" }, { status: 404 });
        }

        return NextResponse.json(template);
    } catch (error: any) {
        console.error("SCSEM detail error:", error);
        return NextResponse.json(
            { error: "Failed to fetch SCSEM details" },
            { status: 500 }
        );
    }
}
