import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import * as XLSX from "xlsx";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    try {
        // Fetch the template with all sheets and controls
        const template = await db.sCSEMTemplate.findUnique({
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

        if (!template) {
            return NextResponse.json({ error: "SCSEM not found" }, { status: 404 });
        }

        // Create a new workbook
        const wb = XLSX.utils.book_new();

        for (const sheet of template.sheets) {
            let ws: XLSX.WorkSheet;

            if (sheet.sheetType === "test_cases" && sheet.controls.length > 0) {
                // Reconstruct test cases sheet with proper headers
                const headers = [
                    "Test ID",
                    "NIST ID",
                    "NIST Control Name",
                    "Test Method",
                    "Description",
                    "Test Procedures",
                    "Expected Results",
                    "Actual Results",
                    "Status",
                    "Notes/Evidence",
                ];

                // Add title row
                const data: any[][] = [
                    ["Test Cases"],
                    headers,
                ];

                for (const control of sheet.controls) {
                    const row = [
                        control.testId,
                        control.nistId || "",
                        control.nistControlName || "",
                        control.testMethod || "",
                        control.description || "",
                        control.testProcedures || "",
                        control.expectedResults || "",
                        control.actualResults || "",
                        control.status || "",
                        control.notesEvidence || "",
                    ];

                    // Add extra columns if present
                    if (control.extraColumns) {
                        const extra = control.extraColumns as Record<string, any>;
                        for (const val of Object.values(extra)) {
                            row.push(val || "");
                        }
                    }

                    data.push(row);
                }

                ws = XLSX.utils.aoa_to_sheet(data);

                // Set column widths for readability
                ws["!cols"] = [
                    { wch: 12 }, // Test ID
                    { wch: 10 }, // NIST ID
                    { wch: 30 }, // NIST Control Name
                    { wch: 15 }, // Test Method
                    { wch: 40 }, // Description
                    { wch: 50 }, // Test Procedures
                    { wch: 40 }, // Expected Results
                    { wch: 30 }, // Actual Results
                    { wch: 10 }, // Status
                    { wch: 30 }, // Notes/Evidence
                ];
            } else if (sheet.rawData) {
                // Reconstruct from stored raw data
                ws = XLSX.utils.aoa_to_sheet(sheet.rawData as any[][]);
            } else {
                // Empty sheet placeholder
                ws = XLSX.utils.aoa_to_sheet([[sheet.sheetName]]);
            }

            XLSX.utils.book_append_sheet(wb, ws, sheet.sheetName);
        }

        // Add a Change Log sheet if we have changelog data and it wasn't already included
        const hasChangeLogSheet = template.sheets.some(
            (s) => s.sheetType === "changelog"
        );
        if (!hasChangeLogSheet && template.changeLogs.length > 0) {
            const clData: any[][] = [
                ["Change Log"],
                ["Version", "Date", "Description", "Author", "Source"],
            ];

            for (const cl of template.changeLogs) {
                clData.push([
                    cl.version,
                    cl.changeDate.toISOString().split("T")[0],
                    cl.description,
                    cl.changedBy || "",
                    cl.source,
                ]);
            }

            const clWs = XLSX.utils.aoa_to_sheet(clData);
            clWs["!cols"] = [
                { wch: 10 },
                { wch: 12 },
                { wch: 60 },
                { wch: 30 },
                { wch: 15 },
            ];
            XLSX.utils.book_append_sheet(wb, clWs, "Change Log (SkyShield)");
        }

        // Generate the XLSX buffer
        const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

        // Build a clean filename
        const filename = `Safeguards-SCSEM-${template.name.replace(/\s+/g, "-")}.xlsx`;

        return new Response(buf, {
            status: 200,
            headers: {
                "Content-Type":
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
