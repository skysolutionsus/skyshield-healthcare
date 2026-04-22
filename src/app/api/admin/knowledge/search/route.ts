import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { retrieveKnowledgeChunks } from "@/lib/knowledge/retrieval";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const session = await auth();
  const user = session?.user as { role: string } | undefined;

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  if (!q) {
    return NextResponse.json({ results: [] });
  }

  try {
    const results = await retrieveKnowledgeChunks(q, 12);
    return NextResponse.json({ results });
  } catch (err) {
    console.error("Knowledge search error:", err);
    return NextResponse.json(
      { error: "Failed to search knowledge base" },
      { status: 500 }
    );
  }
}
