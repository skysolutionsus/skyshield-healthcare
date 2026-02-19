import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orgId = (session.user as unknown as { organizationId: string })
      .organizationId;

    const [
      openIncidents,
      totalAssessments,
      completedAssessments,
      recentLogs,
    ] = await Promise.all([
      db.incident.count({
        where: { organizationId: orgId, status: { not: "CLOSED" } },
      }),
      db.sCSEMAssessment.count({ where: { organizationId: orgId } }),
      db.sCSEMAssessment.count({
        where: { organizationId: orgId, status: "COMPLETED" },
      }),
      db.auditLog.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { user: { select: { name: true } } },
      }),
    ]);

    return NextResponse.json({
      openIncidents,
      totalAssessments,
      completedAssessments,
      recentLogs,
    });
  } catch (error) {
    console.error("Dashboard API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch dashboard data" },
      { status: 500 }
    );
  }
}
