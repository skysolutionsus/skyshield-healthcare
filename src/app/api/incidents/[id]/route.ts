import { NextResponse, NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const orgId = (session.user as unknown as { organizationId: string })
      .organizationId;

    const incident = await db.incident.findFirst({
      where: { id, organizationId: orgId },
      include: {
        assignedTo: { select: { id: true, name: true, email: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        activities: {
          orderBy: { createdAt: "desc" },
          include: {
            user: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!incident) {
      return NextResponse.json(
        { error: "Incident not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(incident);
  } catch (error) {
    console.error("Error fetching incident:", error);
    return NextResponse.json(
      { error: "Failed to fetch incident" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const orgId = (session.user as unknown as { organizationId: string })
      .organizationId;
    const userId = session.user.id;

    // Verify ownership
    const existing = await db.incident.findFirst({
      where: { id, organizationId: orgId },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Incident not found" },
        { status: 404 }
      );
    }

    const body = await request.json();
    const { status, severity, remediationPlan, addNote, assignedToId } = body;

    // Build update data
    const updateData: Record<string, unknown> = {};
    const activitiesToCreate: Array<{
      userId: string;
      action: string;
      details: string;
    }> = [];

    // Handle status change
    if (status && status !== existing.status) {
      const validStatuses = [
        "OPEN",
        "INVESTIGATING",
        "REMEDIATION",
        "RESOLVED",
        "CLOSED",
      ];
      if (!validStatuses.includes(status)) {
        return NextResponse.json(
          { error: "Invalid status" },
          { status: 400 }
        );
      }

      // Validate workflow transition
      const validTransitions: Record<string, string[]> = {
        OPEN: ["INVESTIGATING"],
        INVESTIGATING: ["REMEDIATION", "RESOLVED"],
        REMEDIATION: ["RESOLVED"],
        RESOLVED: ["CLOSED"],
        CLOSED: [],
      };

      if (!validTransitions[existing.status]?.includes(status)) {
        return NextResponse.json(
          {
            error: `Cannot transition from ${existing.status} to ${status}`,
          },
          { status: 400 }
        );
      }

      updateData.status = status;

      if (status === "RESOLVED") {
        updateData.resolvedAt = new Date();
      }

      activitiesToCreate.push({
        userId,
        action: "STATUS_CHANGE",
        details: `Status changed from ${existing.status} to ${status}`,
      });
    }

    // Handle severity change
    if (severity && severity !== existing.severity) {
      const validSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
      if (!validSeverities.includes(severity)) {
        return NextResponse.json(
          { error: "Invalid severity" },
          { status: 400 }
        );
      }

      updateData.severity = severity;
      activitiesToCreate.push({
        userId,
        action: "SEVERITY_CHANGE",
        details: `Severity changed from ${existing.severity} to ${severity}`,
      });
    }

    // Handle remediation plan update
    if (remediationPlan !== undefined) {
      updateData.remediationPlan = remediationPlan;
      activitiesToCreate.push({
        userId,
        action: "REMEDIATION_UPDATED",
        details: "Remediation plan updated",
      });
    }

    // Handle assignment
    if (assignedToId !== undefined) {
      updateData.assignedToId = assignedToId || null;
      activitiesToCreate.push({
        userId,
        action: "ASSIGNED",
        details: assignedToId
          ? `Incident assigned to user`
          : "Incident unassigned",
      });
    }

    // Handle adding a note
    if (addNote) {
      activitiesToCreate.push({
        userId,
        action: "NOTE_ADDED",
        details: addNote,
      });
    }

    // Perform the update in a transaction
    const incident = await db.$transaction(async (tx) => {
      // Update the incident if there are field changes
      if (Object.keys(updateData).length > 0) {
        await tx.incident.update({
          where: { id },
          data: updateData,
        });
      }

      // Create activity entries
      if (activitiesToCreate.length > 0) {
        await tx.incidentActivity.createMany({
          data: activitiesToCreate.map((a) => ({
            incidentId: id,
            ...a,
          })),
        });
      }

      // Return the updated incident with relations
      return tx.incident.findFirst({
        where: { id },
        include: {
          assignedTo: { select: { id: true, name: true, email: true } },
          createdBy: { select: { id: true, name: true, email: true } },
          activities: {
            orderBy: { createdAt: "desc" },
            include: {
              user: { select: { id: true, name: true } },
            },
          },
        },
      });
    });

    return NextResponse.json(incident);
  } catch (error) {
    console.error("Error updating incident:", error);
    return NextResponse.json(
      { error: "Failed to update incident" },
      { status: 500 }
    );
  }
}
