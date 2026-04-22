import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";

async function requireAdmin() {
  const session = await auth();
  const user = session?.user as
    | { id: string; role: string; organizationId: string }
    | undefined;

  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  if (user.role !== "ADMIN") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { user };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAdmin();
  if (error) return error;

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const page = Number(searchParams.get("page") || "1");
  const pageSize = Math.min(Number(searchParams.get("pageSize") || "25"), 100);

  try {
    const [document, chunks, totalChunks] = await Promise.all([
      db.knowledgeDocument.findUnique({
        where: { id },
        include: {
          importedBy: { select: { name: true, email: true } },
        },
      }),
      db.knowledgeChunk.findMany({
        where: { documentId: id },
        orderBy: { chunkIndex: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          chunkIndex: true,
          content: true,
          pageStart: true,
          pageEnd: true,
          section: true,
          heading: true,
          metadata: true,
          tokenCount: true,
          contentHash: true,
          createdAt: true,
        },
      }),
      db.knowledgeChunk.count({ where: { documentId: id } }),
    ]);

    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    return NextResponse.json({
      document,
      chunks,
      page,
      totalChunks,
      totalPages: Math.ceil(totalChunks / pageSize),
    });
  } catch (err) {
    console.error("Knowledge detail GET error:", err);
    return NextResponse.json(
      { error: "Failed to fetch document" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireAdmin();
  if (error) return error;

  const { id } = await params;
  const body = await request.json();

  try {
    const document = await db.knowledgeDocument.update({
      where: { id },
      data: {
        title: typeof body.title === "string" ? body.title : undefined,
        sourceType: typeof body.sourceType === "string" ? body.sourceType : undefined,
        sourceName: typeof body.sourceName === "string" ? body.sourceName : undefined,
        version: typeof body.version === "string" ? body.version : undefined,
        description:
          typeof body.description === "string" ? body.description : undefined,
        status: typeof body.status === "string" ? body.status : undefined,
      },
    });

    await logAudit({
      organizationId: user!.organizationId,
      userId: user!.id,
      action: "KNOWLEDGE_DOCUMENT_UPDATE",
      resourceType: "knowledge_document",
      resourceId: id,
      metadata: { title: document.title, status: document.status },
      ipAddress:
        request.headers.get("x-forwarded-for") ||
        request.headers.get("x-real-ip") ||
        undefined,
      userAgent: request.headers.get("user-agent") || undefined,
    });

    return NextResponse.json({ success: true, document });
  } catch (err) {
    console.error("Knowledge PATCH error:", err);
    return NextResponse.json(
      { error: "Failed to update document" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireAdmin();
  if (error) return error;

  const { id } = await params;

  try {
    const document = await db.knowledgeDocument.delete({ where: { id } });

    await logAudit({
      organizationId: user!.organizationId,
      userId: user!.id,
      action: "KNOWLEDGE_DOCUMENT_DELETE",
      resourceType: "knowledge_document",
      resourceId: id,
      metadata: { title: document.title, sourceType: document.sourceType },
      ipAddress:
        request.headers.get("x-forwarded-for") ||
        request.headers.get("x-real-ip") ||
        undefined,
      userAgent: request.headers.get("user-agent") || undefined,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Knowledge DELETE error:", err);
    return NextResponse.json(
      { error: "Failed to delete document" },
      { status: 500 }
    );
  }
}
