import { NextResponse, NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orgId = (session.user as unknown as { organizationId: string })
      .organizationId;

    const { searchParams } = request.nextUrl;
    const status = searchParams.get("status");
    const severity = searchParams.get("severity");
    const type = searchParams.get("type");

    // Build where clause
    const where: Record<string, unknown> = { organizationId: orgId };
    if (status) where.status = status;
    if (severity) where.severity = severity;
    if (type) where.type = type;

    const incidents = await db.incident.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        assignedTo: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        _count: { select: { activities: true } },
      },
    });

    return NextResponse.json(incidents);
  } catch (error) {
    console.error("Error fetching incidents:", error);
    return NextResponse.json(
      { error: "Failed to fetch incidents" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orgId = (session.user as unknown as { organizationId: string })
      .organizationId;
    const userId = session.user.id;

    const body = await request.json();
    const { title, description, type, severity, affectedSystems, dateOccurred } =
      body;

    if (!title || !type || !severity) {
      return NextResponse.json(
        { error: "Title, type, and severity are required" },
        { status: 400 }
      );
    }

    // Validate enum values
    const validTypes = [
      "FTI_EXPOSURE",
      "PII_BREACH",
      "UNAUTHORIZED_ACCESS",
      "SYSTEM_COMPROMISE",
      "POLICY_VIOLATION",
      "AUTO_GENERATED",
    ];
    const validSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

    if (!validTypes.includes(type)) {
      return NextResponse.json(
        { error: "Invalid incident type" },
        { status: 400 }
      );
    }

    if (!validSeverities.includes(severity)) {
      return NextResponse.json(
        { error: "Invalid severity level" },
        { status: 400 }
      );
    }

    const incident = await db.incident.create({
      data: {
        title,
        description: description || null,
        type,
        severity,
        status: "OPEN",
        organizationId: orgId,
        createdById: userId,
        affectedSystems: affectedSystems || [],
        dateDiscovered: new Date(),
        dateOccurred: dateOccurred ? new Date(dateOccurred) : null,
        activities: {
          create: {
            userId,
            action: "CREATED",
            details: `Incident created: ${title}`,
          },
        },
      },
      include: {
        assignedTo: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        activities: true,
      },
    });

    return NextResponse.json(incident, { status: 201 });
  } catch (error) {
    console.error("Error creating incident:", error);
    return NextResponse.json(
      { error: "Failed to create incident" },
      { status: 500 }
    );
  }
}
