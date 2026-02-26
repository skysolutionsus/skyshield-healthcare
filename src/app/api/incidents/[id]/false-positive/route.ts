import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";

// POST /api/incidents/[id]/false-positive — Report a false positive
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const userInfo = session.user as unknown as {
            id: string;
            organizationId: string;
        };

        const { id: incidentId } = await params;
        const { reason } = await request.json();

        if (!reason || typeof reason !== "string" || reason.trim().length < 5) {
            return NextResponse.json(
                { error: "Please provide a reason (at least 5 characters)" },
                { status: 400 }
            );
        }

        // Verify the incident exists and belongs to the user's org
        const incident = await db.incident.findFirst({
            where: {
                id: incidentId,
                organizationId: userInfo.organizationId,
            },
        });

        if (!incident) {
            return NextResponse.json(
                { error: "Incident not found" },
                { status: 404 }
            );
        }

        // Check if user already reported this as false positive
        const existing = await db.falsePositiveReport.findFirst({
            where: {
                incidentId,
                reportedById: userInfo.id,
                status: "PENDING",
            },
        });

        if (existing) {
            return NextResponse.json(
                { error: "You have already reported this as a false positive" },
                { status: 409 }
            );
        }

        // Create the false positive report
        const report = await db.falsePositiveReport.create({
            data: {
                incidentId,
                reportedById: userInfo.id,
                reason: reason.trim(),
            },
        });

        // Log to audit
        try {
            await logAudit({
                organizationId: userInfo.organizationId,
                userId: userInfo.id,
                action: "FALSE_POSITIVE_REPORTED",
                resourceType: "incident",
                resourceId: incidentId,
                metadata: {
                    reportId: report.id,
                    incidentTitle: incident.title,
                },
                ipAddress:
                    request.headers.get("x-forwarded-for") ||
                    request.headers.get("x-real-ip") ||
                    undefined,
                userAgent: request.headers.get("user-agent") || undefined,
            });
        } catch {
            // ignore
        }

        return NextResponse.json({ success: true, reportId: report.id });
    } catch (error) {
        console.error("False positive report error:", error);
        return NextResponse.json(
            { error: "Failed to submit report" },
            { status: 500 }
        );
    }
}
