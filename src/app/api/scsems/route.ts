import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/scsems - List all SCSEM templates with assessments for the current org
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orgId = (session.user as unknown as { organizationId: string })
      .organizationId;

    const templates = await db.sCSEMTemplate.findMany({
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: {
        assessments: {
          where: { organizationId: orgId },
          select: {
            id: true,
            status: true,
            complianceScore: true,
            updatedAt: true,
            assessedBy: {
              select: { id: true, name: true },
            },
          },
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
      },
    });

    return NextResponse.json({ templates });
  } catch (error) {
    console.error("Error fetching SCSEM templates:", error);
    return NextResponse.json(
      { error: "Failed to fetch SCSEM templates" },
      { status: 500 }
    );
  }
}

// POST /api/scsems - Create or resume an assessment for a template
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orgId = (session.user as unknown as { organizationId: string })
      .organizationId;
    const userId = session.user.id;

    const body = await request.json();
    const { templateId } = body;

    if (!templateId) {
      return NextResponse.json(
        { error: "templateId is required" },
        { status: 400 }
      );
    }

    // Verify template exists
    const template = await db.sCSEMTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      return NextResponse.json(
        { error: "SCSEM template not found" },
        { status: 404 }
      );
    }

    // Check for existing assessment
    const existingAssessment = await db.sCSEMAssessment.findFirst({
      where: {
        templateId,
        organizationId: orgId,
      },
      include: {
        controlResults: {
          orderBy: { controlId: "asc" },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    if (existingAssessment) {
      // Return existing assessment
      return NextResponse.json({ assessment: existingAssessment });
    }

    // Create new assessment with control results
    // Generate placeholder controls based on controlCount
    const controlResultsData = [];
    for (let i = 1; i <= template.controlCount; i++) {
      controlResultsData.push({
        controlId: `CTRL-${String(i).padStart(3, "0")}`,
        controlName: `Control ${i}`,
        status: "IN_PROGRESS" as const,
      });
    }

    const assessment = await db.sCSEMAssessment.create({
      data: {
        templateId,
        organizationId: orgId,
        assessedById: userId,
        status: "IN_PROGRESS",
        controlResults: {
          create: controlResultsData,
        },
      },
      include: {
        controlResults: {
          orderBy: { controlId: "asc" },
        },
        assessedBy: {
          select: { id: true, name: true },
        },
      },
    });

    // Log the action
    try {
      await db.auditLog.create({
        data: {
          organizationId: orgId,
          userId,
          action: "Started SCSEM assessment",
          resourceType: "SCSEMAssessment",
          resourceId: assessment.id,
          metadata: {
            templateId: template.id,
            templateName: template.name,
            category: template.category,
          },
        },
      });
    } catch {
      // Audit log failure should not block the response
    }

    return NextResponse.json({ assessment }, { status: 201 });
  } catch (error) {
    console.error("Error creating SCSEM assessment:", error);
    return NextResponse.json(
      { error: "Failed to create SCSEM assessment" },
      { status: 500 }
    );
  }
}
