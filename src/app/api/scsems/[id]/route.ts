import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/scsems/[id] - Get SCSEM template or assessment detail with controls
export async function GET(
  request: Request,
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

    // First try to find as a template ID
    const template = await db.sCSEMTemplate.findUnique({
      where: { id },
      include: {
        assessments: {
          where: { organizationId: orgId },
          orderBy: { updatedAt: "desc" },
          take: 1,
          include: {
            assessedBy: {
              select: { id: true, name: true },
            },
            controlResults: {
              orderBy: { controlId: "asc" },
            },
          },
        },
      },
    });

    if (template) {
      return NextResponse.json({ template });
    }

    // Try to find as an assessment ID
    const assessment = await db.sCSEMAssessment.findUnique({
      where: { id },
      include: {
        template: true,
        assessedBy: {
          select: { id: true, name: true },
        },
        controlResults: {
          orderBy: { controlId: "asc" },
        },
      },
    });

    if (!assessment) {
      return NextResponse.json(
        { error: "SCSEM template or assessment not found" },
        { status: 404 }
      );
    }

    // Validate org ownership
    if (assessment.organizationId !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ assessment });
  } catch (error) {
    console.error("Error fetching SCSEM detail:", error);
    return NextResponse.json(
      { error: "Failed to fetch SCSEM detail" },
      { status: 500 }
    );
  }
}

// PUT /api/scsems/[id] - Update assessment control results (bulk update)
export async function PUT(
  request: Request,
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

    // Find the assessment (id param is the assessment ID)
    const assessment = await db.sCSEMAssessment.findUnique({
      where: { id },
      include: {
        template: true,
      },
    });

    if (!assessment) {
      return NextResponse.json(
        { error: "Assessment not found" },
        { status: 404 }
      );
    }

    // Validate org ownership
    if (assessment.organizationId !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { controlResults } = body;

    if (!controlResults || !Array.isArray(controlResults)) {
      return NextResponse.json(
        { error: "controlResults array is required" },
        { status: 400 }
      );
    }

    // Validate status values
    const validStatuses = [
      "COMPLIANT",
      "NON_COMPLIANT",
      "NOT_APPLICABLE",
      "IN_PROGRESS",
    ];

    for (const cr of controlResults) {
      if (cr.status && !validStatuses.includes(cr.status)) {
        return NextResponse.json(
          {
            error: `Invalid status "${cr.status}" for control ${cr.controlId}. Must be one of: ${validStatuses.join(", ")}`,
          },
          { status: 400 }
        );
      }
    }

    // Bulk update control results
    const updatePromises = controlResults.map(
      (cr: {
        id: string;
        controlId: string;
        controlName: string;
        status: string;
        notes?: string;
        evidence?: string;
      }) =>
        db.sCSEMControlResult.update({
          where: { id: cr.id },
          data: {
            status: cr.status as
              | "COMPLIANT"
              | "NON_COMPLIANT"
              | "NOT_APPLICABLE"
              | "IN_PROGRESS",
            notes: cr.notes || null,
            evidence: cr.evidence || null,
          },
        })
    );

    await Promise.all(updatePromises);

    // Recalculate compliance score
    const updatedControls = await db.sCSEMControlResult.findMany({
      where: { assessmentId: id },
    });

    const compliantCount = updatedControls.filter(
      (c) => c.status === "COMPLIANT"
    ).length;
    const naCount = updatedControls.filter(
      (c) => c.status === "NOT_APPLICABLE"
    ).length;
    const applicableCount = updatedControls.length - naCount;
    const complianceScore =
      applicableCount > 0
        ? Math.round((compliantCount / applicableCount) * 100 * 100) / 100
        : 0;

    // Determine assessment status based on control results
    const allResolved = updatedControls.every(
      (c) =>
        c.status === "COMPLIANT" ||
        c.status === "NON_COMPLIANT" ||
        c.status === "NOT_APPLICABLE"
    );

    const hasNonCompliant = updatedControls.some(
      (c) => c.status === "NON_COMPLIANT"
    );

    let assessmentStatus: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "REVIEW_NEEDED";
    if (allResolved && hasNonCompliant) {
      assessmentStatus = "REVIEW_NEEDED";
    } else if (allResolved) {
      assessmentStatus = "COMPLETED";
    } else {
      assessmentStatus = "IN_PROGRESS";
    }

    // Update assessment with new score and status
    const updatedAssessment = await db.sCSEMAssessment.update({
      where: { id },
      data: {
        complianceScore,
        status: assessmentStatus,
      },
      include: {
        assessedBy: {
          select: { id: true, name: true },
        },
        controlResults: {
          orderBy: { controlId: "asc" },
        },
      },
    });

    // Log the action
    try {
      await db.auditLog.create({
        data: {
          organizationId: orgId,
          userId,
          action: "Updated SCSEM assessment controls",
          resourceType: "SCSEMAssessment",
          resourceId: id,
          metadata: {
            templateName: assessment.template.name,
            controlsUpdated: controlResults.length,
            complianceScore,
            status: assessmentStatus,
          },
        },
      });
    } catch {
      // Audit log failure should not block the response
    }

    return NextResponse.json({ assessment: updatedAssessment });
  } catch (error) {
    console.error("Error updating SCSEM assessment:", error);
    return NextResponse.json(
      { error: "Failed to update SCSEM assessment" },
      { status: 500 }
    );
  }
}
