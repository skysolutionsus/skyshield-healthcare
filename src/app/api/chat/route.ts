import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { detectPII } from "@/lib/pii-detection";
import { logAudit } from "@/lib/audit";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";

// Load Pub 1075 text once at module level
let pub1075Text: string = "";
try {
  pub1075Text = readFileSync(
    join(process.cwd(), "data/pub1075/p1075-full-text.md"),
    "utf-8"
  );
} catch {
  console.warn("Could not load Publication 1075 text");
}

const SYSTEM_PROMPT = `You are the IRS SkyShield AI Compliance Agent — an expert on IRS Publication 1075 (Tax Information Security Guidelines for Federal, State, and Local Agencies).

YOUR PRIMARY DIRECTIVE:
You help compliance workers understand and implement Publication 1075 requirements. Every answer MUST cite specific sections, paragraphs, and/or page references from Publication 1075.

RESPONSE FORMAT:
- Always cite specific Pub 1075 sections (e.g., "Section 9.3.16.6", "Section 4.3", "Exhibit 7")
- If the answer is NOT in Pub 1075, clearly state that and offer to provide general guidance
- Be precise, authoritative, and actionable
- Use bullet points for clarity when listing requirements
- When referencing controls, map them to specific SCSEM categories when relevant

CITATION FORMAT:
When citing, use the format: [Section X.X.X] or [Exhibit X] or [Section X.X, Page X]
At the end of your response, list all citations in a structured format like:
---CITATIONS---
Section X.X.X: Brief description
Section Y.Y: Brief description

IMPORTANT RULES:
1. NEVER ask for or process any Federal Tax Information (FTI) or Personally Identifiable Information (PII)
2. If a user seems to be sharing FTI/PII, immediately warn them and refuse to process it
3. Always ground your answers in the actual Publication 1075 text
4. If you're uncertain about a specific requirement, say so rather than guessing

THE FULL TEXT OF IRS PUBLICATION 1075 FOLLOWS:
=== BEGIN PUBLICATION 1075 ===
${pub1075Text}
=== END PUBLICATION 1075 ===`;

function extractCitations(
  response: string
): { section: string; text: string }[] {
  const citations: { section: string; text: string }[] = [];

  // Extract from ---CITATIONS--- block
  const citationBlock = response.match(
    /---CITATIONS---\s*([\s\S]*?)(?:$|---)/
  );
  if (citationBlock) {
    const lines = citationBlock[1].trim().split("\n");
    for (const line of lines) {
      const match = line.match(
        /^(Section\s+[\d.]+|Exhibit\s+\d+):\s*(.+)/i
      );
      if (match) {
        citations.push({ section: match[1], text: match[2].trim() });
      }
    }
  }

  // Also extract inline [Section X.X.X] references
  const inlineRefs = response.matchAll(
    /\[(Section\s+[\d.]+(?:\.\d+)*|Exhibit\s+\d+)(?:,\s*Page\s+\d+)?\]/gi
  );
  for (const match of inlineRefs) {
    const section = match[1];
    if (!citations.find((c) => c.section === section)) {
      citations.push({ section, text: "" });
    }
  }

  return citations;
}

function cleanResponseText(response: string): string {
  // Remove the ---CITATIONS--- block from the displayed response
  return response.replace(/---CITATIONS---[\s\S]*?(?:---|$)/, "").trim();
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userInfo = session.user as unknown as {
      id: string;
      organizationId: string;
    };
    const { message, conversationId } = await request.json();

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    // PII/FTI Detection - MUST happen before sending to Anthropic
    const piiResult = detectPII(message);

    if (piiResult.hasPII) {
      // Auto-create incident
      try {
        await db.incident.create({
          data: {
            organizationId: userInfo.organizationId,
            title: `PII/FTI Detection: ${piiResult.matches.map((m) => m.type).join(", ")}`,
            description: `Automated detection triggered in AI chat. Detected types: ${piiResult.matches.map((m) => m.type).join(", ")}. The message was blocked and NOT sent to the AI service.`,
            type: "AUTO_GENERATED",
            severity:
              piiResult.matches.some(
                (m) => m.type === "SSN" || m.type === "EIN"
              )
                ? "HIGH"
                : "MEDIUM",
            status: "OPEN",
            createdById: userInfo.id,
            affectedSystems: "AI Chat Interface",
          },
        });
      } catch {
        // Log failure but don't block the response
      }

      // Log the PII detection
      try {
        await logAudit({
          organizationId: userInfo.organizationId,
          userId: userInfo.id,
          action: "PII_DETECTED",
          resourceType: "chat",
          metadata: {
            types: piiResult.matches.map((m) => m.type),
            confidence: piiResult.matches.map((m) => m.confidence),
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

      return NextResponse.json({
        piiBlocked: true,
        message:
          "Your message was blocked because it appears to contain sensitive data (FTI/PII). This data was NOT sent to any external service. An incident report has been automatically created.",
        piiTypes: piiResult.matches.map((m) => m.type),
      });
    }

    // Log the AI query
    try {
      await logAudit({
        organizationId: userInfo.organizationId,
        userId: userInfo.id,
        action: "AI_QUERY",
        resourceType: "chat",
        metadata: { questionLength: message.length },
        ipAddress:
          request.headers.get("x-forwarded-for") ||
          request.headers.get("x-real-ip") ||
          undefined,
        userAgent: request.headers.get("user-agent") || undefined,
      });
    } catch {
      // ignore
    }

    // Get or create conversation
    let convId = conversationId;
    if (!convId) {
      try {
        const conv = await db.conversation.create({
          data: {
            userId: userInfo.id,
            title:
              message.length > 60
                ? message.substring(0, 60) + "..."
                : message,
          },
        });
        convId = conv.id;
      } catch {
        // If DB fails, continue without persistence
      }
    }

    // Save user message
    if (convId) {
      try {
        await db.message.create({
          data: {
            conversationId: convId,
            role: "user",
            content: message,
          },
        });
      } catch {
        // ignore
      }
    }

    // Get conversation history for context
    let previousMessages: Array<{
      role: "user" | "assistant";
      content: string;
    }> = [];
    if (convId) {
      try {
        const dbMessages = await db.message.findMany({
          where: { conversationId: convId },
          orderBy: { createdAt: "asc" },
          take: 20,
          select: { role: true, content: true },
        });
        previousMessages = dbMessages.map((m: { role: string; content: string }) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
      } catch {
        // ignore
      }
    }

    // Call Anthropic API
    if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === "sk-ant-placeholder") {
      // Demo mode - return a sample response
      const demoResponse = `Based on Publication 1075, I can provide guidance on your question.

**Note:** This is a demo response. Configure the ANTHROPIC_API_KEY environment variable to enable AI-powered responses with full Publication 1075 analysis.

Your question: "${message}"

For full Pub 1075 guidance, please ensure the Anthropic API key is configured.

---CITATIONS---
Section 1.1: Introduction to Publication 1075
Section 3.1: General Requirements`;

      const citations = extractCitations(demoResponse);
      const cleanedResponse = cleanResponseText(demoResponse);

      // Save assistant message
      if (convId) {
        try {
          await db.message.create({
            data: {
              conversationId: convId,
              role: "assistant",
              content: cleanedResponse,
              citations: citations.length > 0 ? citations : undefined,
            },
          });
        } catch {
          // ignore
        }
      }

      return NextResponse.json({
        response: cleanedResponse,
        citations,
        conversationId: convId,
      });
    }

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Build message history
    const apiMessages: Array<{
      role: "user" | "assistant";
      content: string;
    }> = [];

    // Add recent conversation history (skip the last user message we just added)
    for (const msg of previousMessages.slice(0, -1)) {
      apiMessages.push(msg);
    }

    // Add current message
    apiMessages.push({ role: "user", content: message });

    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: apiMessages,
    });

    const assistantContent =
      response.content[0].type === "text" ? response.content[0].text : "";
    const citations = extractCitations(assistantContent);
    const cleanedResponse = cleanResponseText(assistantContent);

    // Save assistant message
    if (convId) {
      try {
        await db.message.create({
          data: {
            conversationId: convId,
            role: "assistant",
            content: cleanedResponse,
            citations: citations.length > 0 ? citations : undefined,
          },
        });
      } catch {
        // ignore
      }
    }

    return NextResponse.json({
      response: cleanedResponse,
      citations,
      conversationId: convId,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Chat API error:", errorMessage, error);

    if (errorMessage.includes("DATABASE_URL") || errorMessage.includes("prisma") || errorMessage.toLowerCase().includes("connect")) {
      return NextResponse.json(
        { error: `Database error: ${errorMessage}` },
        { status: 503 }
      );
    }

    if (errorMessage.includes("401") || errorMessage.includes("Unauthorized") || errorMessage.includes("auth")) {
      return NextResponse.json(
        { error: `Auth error: ${errorMessage}` },
        { status: 401 }
      );
    }

    if (errorMessage.includes("anthropic") || errorMessage.includes("Anthropic") || errorMessage.includes("model") || errorMessage.includes("api_key")) {
      return NextResponse.json(
        { error: `AI API error: ${errorMessage}` },
        { status: 502 }
      );
    }

    return NextResponse.json(
      { error: `Failed to process request: ${errorMessage}` },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userInfo = session.user as unknown as { id: string };
    const { searchParams } = new URL(request.url);

    // List conversations
    if (searchParams.get("list") === "true") {
      const conversations = await db.conversation.findMany({
        where: { userId: userInfo.id },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: {
          id: true,
          title: true,
          bookmarked: true,
          updatedAt: true,
        },
      });
      return NextResponse.json({ conversations });
    }

    // Get specific conversation
    const convId = searchParams.get("conversationId");
    if (convId) {
      const conversation = await db.conversation.findFirst({
        where: { id: convId, userId: userInfo.id },
        include: {
          messages: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              role: true,
              content: true,
              citations: true,
              createdAt: true,
            },
          },
        },
      });

      if (!conversation) {
        return NextResponse.json(
          { error: "Conversation not found" },
          { status: 404 }
        );
      }

      return NextResponse.json({
        messages: conversation.messages,
        bookmarked: conversation.bookmarked,
      });
    }

    return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
  } catch (error) {
    console.error("Chat GET error:", error);
    return NextResponse.json(
      { error: "Failed to fetch data" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userInfo = session.user as unknown as { id: string };
    const { conversationId, bookmarked } = await request.json();

    await db.conversation.update({
      where: { id: conversationId, userId: userInfo.id },
      data: { bookmarked },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Chat PATCH error:", error);
    return NextResponse.json(
      { error: "Failed to update" },
      { status: 500 }
    );
  }
}
