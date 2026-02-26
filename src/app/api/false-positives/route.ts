import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";

// GET /api/false-positives — List false positive reports (admin-only)
export async function GET() {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const userInfo = session.user as unknown as {
            role: string;
            organizationId: string;
        };

        if (userInfo.role !== "ADMIN") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const reports = await db.falsePositiveReport.findMany({
            orderBy: { createdAt: "desc" },
            include: {
                incident: {
                    select: {
                        id: true,
                        title: true,
                        type: true,
                        severity: true,
                        status: true,
                        organizationId: true,
                    },
                },
                reportedBy: {
                    select: { id: true, name: true, email: true },
                },
                reviewedBy: {
                    select: { id: true, name: true },
                },
            },
        });

        // Filter to only the admin's org
        const orgReports = reports.filter(
            (r) => r.incident.organizationId === userInfo.organizationId
        );

        return NextResponse.json({ reports: orgReports });
    } catch (error) {
        console.error("False positives GET error:", error);
        return NextResponse.json(
            { error: "Failed to fetch reports" },
            { status: 500 }
        );
    }
}

// PATCH /api/false-positives — Approve or reject a false positive report (admin-only)
export async function PATCH(request: NextRequest) {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const userInfo = session.user as unknown as {
            id: string;
            role: string;
            organizationId: string;
        };

        if (userInfo.role !== "ADMIN") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const { reportId, action, reviewNotes } = await request.json();

        if (!reportId || !action || !["APPROVED", "REJECTED"].includes(action)) {
            return NextResponse.json(
                { error: "reportId and action (APPROVED/REJECTED) are required" },
                { status: 400 }
            );
        }

        const report = await db.falsePositiveReport.findUnique({
            where: { id: reportId },
            include: {
                incident: { select: { id: true, organizationId: true, title: true } },
            },
        });

        if (!report || report.incident.organizationId !== userInfo.organizationId) {
            return NextResponse.json({ error: "Report not found" }, { status: 404 });
        }

        if (report.status !== "PENDING") {
            return NextResponse.json(
                { error: "Report has already been reviewed" },
                { status: 409 }
            );
        }

        // Update the report
        await db.falsePositiveReport.update({
            where: { id: reportId },
            data: {
                status: action,
                reviewedById: userInfo.id,
                reviewNotes: reviewNotes || null,
            },
        });

        // If approved, close the incident
        if (action === "APPROVED") {
            await db.incident.update({
                where: { id: report.incidentId },
                data: {
                    status: "CLOSED",
                    resolvedAt: new Date(),
                },
            });

            // Add activity to incident
            try {
                await db.incidentActivity.create({
                    data: {
                        incidentId: report.incidentId,
                        userId: userInfo.id,
                        action: "FALSE_POSITIVE_APPROVED",
                        details: `False positive report approved. Incident closed. ${reviewNotes ? `Notes: ${reviewNotes}` : ""}`,
                    },
                });
            } catch {
                // ignore
            }
        }

        // Audit log
        try {
            await logAudit({
                organizationId: userInfo.organizationId,
                userId: userInfo.id,
                action: `FALSE_POSITIVE_${action}`,
                resourceType: "false_positive_report",
                resourceId: reportId,
                metadata: {
                    incidentId: report.incidentId,
                    incidentTitle: report.incident.title,
                    reviewNotes: reviewNotes || null,
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

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("False positives PATCH error:", error);
        return NextResponse.json(
            { error: "Failed to review report" },
            { status: 500 }
        );
    }
}
