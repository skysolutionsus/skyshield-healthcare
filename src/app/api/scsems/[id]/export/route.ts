import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { importSCSEMTemplateWorkbook } from "@/lib/scsem-importer";
import {
    buildSCSEMTemplateWorkbookBuffer,
    excelContentTypeForFileName,
} from "@/lib/scsem-workbook-export";
import * as path from "path";

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
            await importSCSEMTemplateWorkbook(template.id, template.filePath);
            template = await fetchTemplate(id);
        }

        if (!template) {
            return NextResponse.json({ error: "SCSEM not found after import" }, { status: 404 });
        }

        const buffer = await buildSCSEMTemplateWorkbookBuffer(template);
        const extension = path.extname(template.filePath).toLowerCase() === ".xlsm" ? ".xlsm" : ".xlsx";
        const filename = `Safeguards-SCSEM-${template.name.replace(/\s+/g, "-")}${extension}`;

        return new Response(new Uint8Array(buffer), {
            status: 200,
            headers: {
                "Content-Type": excelContentTypeForFileName(filename),
                "Content-Disposition": `attachment; filename="${filename}"`,
            },
        });
    } catch (error: any) {
        console.error("SCSEM export error:", error);
        return NextResponse.json(
            { error: "Failed to export SCSEM" },
            { status: 500 }
        );
    }
}
