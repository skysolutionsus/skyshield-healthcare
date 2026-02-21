import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    try {
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
                updateReviews: {
                    orderBy: { createdAt: "desc" },
                    include: {
                        benchmark: true,
                    },
                },
            },
        });

        if (!template) {
            return NextResponse.json({ error: "SCSEM not found" }, { status: 404 });
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
