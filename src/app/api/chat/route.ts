import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { detectPII } from "@/lib/pii-detection";
import { logAudit } from "@/lib/audit";
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { formatKnowledgeContext, retrieveKnowledgeChunks } from "@/lib/knowledge/retrieval";

// Helper: Get LLM settings from DB, fall back to env vars
async function getLLMSettings(): Promise<{ model: string; apiKey: string }> {
  let model = "claude-sonnet-4-6";
  let apiKey = process.env.ANTHROPIC_API_KEY || "";

  try {
    const settings = await db.systemSetting.findMany({
      where: { key: { in: ["llm_model", "llm_api_key"] } },
    });
    for (const s of settings) {
      if (s.key === "llm_model" && s.value) model = s.value;
      if (s.key === "llm_api_key" && s.value) apiKey = s.value;
    }
  } catch {
    // Fall back to defaults if DB is unavailable
  }

  return { model, apiKey };
}

// Allow up to 60s for Anthropic response (Coolify / long-running AI calls)
export const maxDuration = 60;

let cachedPub1075Text: string | null = null;
let cachedPub1075Path: string | null = null;

function loadPub1075Text(): string {
  if (cachedPub1075Text) return cachedPub1075Text;

  const candidates = [
    join(process.cwd(), "data", "pub1075", "p1075-full-text.md"),
    join("/app", "data", "pub1075", "p1075-full-text.md"),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;

    const text = readFileSync(filePath, "utf-8").trim();
    if (text.length > 1000) {
      cachedPub1075Text = text;
      cachedPub1075Path = filePath;
      return text;
    }
  }

  throw new Error(
    `Publication 1075 text file is missing or empty. Checked: ${candidates.join(", ")}`
  );
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "can",
  "does",
  "for",
  "from",
  "how",
  "into",
  "irs",
  "must",
  "pub",
  "publication",
  "should",
  "that",
  "the",
  "their",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

function getSearchTerms(message: string): string[] {
  const normalized = message.toLowerCase();
  const terms = new Set(
    (normalized.match(/[a-z0-9][a-z0-9-]{2,}/g) || []).filter(
      (term) => !STOP_WORDS.has(term)
    )
  );

  if (/\b(encrypt|encrypted|encryption|cryptographic|fips|rest|cloud|key|keys)\b/i.test(message)) {
    [
      "SC-28",
      "Protection of Information at Rest",
      "Data Encryption at Rest",
      "FIPS 140",
      "cryptographic mechanisms",
      "MP-4",
      "MP-5",
      "cloud computing",
    ].forEach((term) => terms.add(term.toLowerCase()));
  }

  if (/\b(media|removable|backup|storage|transport|laptop|mobile|device)\b/i.test(message)) {
    ["MP-4", "MP-5", "AC-19", "mobile device", "removable storage"].forEach(
      (term) => terms.add(term.toLowerCase())
    );
  }

  if (/\b(access|account|authentication|mfa|multi-factor|password|remote)\b/i.test(message)) {
    ["AC-2", "AC-3", "AC-17", "IA-2", "identification", "authentication"].forEach(
      (term) => terms.add(term.toLowerCase())
    );
  }

  return [...terms];
}

function splitPub1075Pages(text: string): Array<{ label: string; content: string }> {
  const parts = text.split(/\n--- PAGE (\d+) ---\n/g);
  const pages: Array<{ label: string; content: string }> = [];

  if (parts[0]?.trim()) {
    pages.push({ label: "front matter", content: parts[0].trim() });
  }

  for (let i = 1; i < parts.length; i += 2) {
    pages.push({ label: `page ${parts[i]}`, content: parts[i + 1]?.trim() || "" });
  }

  return pages;
}

function buildPub1075Context(message: string): string {
  const text = loadPub1075Text();
  const pages = splitPub1075Pages(text);
  const terms = getSearchTerms(message);
  const MAX_CONTEXT_CHARS = 90_000;

  const scoredPages = pages
    .map((page) => {
      const lower = page.content.toLowerCase();
      const score = terms.reduce((total, term) => {
        if (!term) return total;
        const matches = lower.split(term.toLowerCase()).length - 1;
        return total + matches * Math.max(1, Math.min(5, Math.ceil(term.length / 6)));
      }, 0);
      return { ...page, score };
    })
    .filter((page) => page.score > 0)
    .sort((a, b) => b.score - a.score);

  const selectedPages = scoredPages.length > 0 ? scoredPages : pages.slice(0, 8);
  let context = `Source: IRS Publication 1075 text loaded from ${cachedPub1075Path || "local file"}.\n`;

  for (const page of selectedPages) {
    const excerpt = `\n--- PUB 1075 EXCERPT: ${page.label} ---\n${page.content}\n`;
    if (context.length + excerpt.length > MAX_CONTEXT_CHARS) break;
    context += excerpt;
  }

  return context;
}

interface KnowledgeInventoryDocument {
  title: string;
  sourceType: string;
  sourceName: string | null;
  version: string | null;
  description: string | null;
  metadata: unknown;
  chunkCount: number;
  importedAt: Date;
}

function metadataValue(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

async function buildKnowledgeInventoryContext(): Promise<string> {
  try {
    const documents = await db.knowledgeDocument.findMany({
      where: { status: "ACTIVE" },
      orderBy: [{ sourceType: "asc" }, { importedAt: "desc" }],
      take: 50,
      select: {
        title: true,
        sourceType: true,
        sourceName: true,
        version: true,
        description: true,
        metadata: true,
        chunkCount: true,
        importedAt: true,
      },
    });

    if (documents.length === 0) {
      return "No active knowledge documents are currently registered in the database.";
    }

    return documents
      .map((document: KnowledgeInventoryDocument, index: number) => {
        const guidanceDate = metadataValue(document.metadata, "guidanceDate");
        const effectiveDate = metadataValue(document.metadata, "effectiveDate");
        const impactedSections = metadataValue(document.metadata, "impactedPub1075Sections");
        const impactedControls = metadataValue(document.metadata, "impactedControls");
        const relationship = metadataValue(document.metadata, "relationshipToPub1075");

        return [
          `${index + 1}. ${document.title}`,
          `Source type: ${document.sourceType}`,
          document.version ? `Version: ${document.version}` : null,
          document.sourceName ? `Source name: ${document.sourceName}` : null,
          document.description ? `Description: ${document.description}` : null,
          guidanceDate ? `Guidance date: ${guidanceDate}` : null,
          effectiveDate ? `Effective date: ${effectiveDate}` : null,
          relationship ? `Relationship to Pub 1075: ${relationship}` : null,
          impactedSections ? `Impacted Pub 1075 sections: ${impactedSections}` : null,
          impactedControls ? `Impacted controls: ${impactedControls}` : null,
          `Chunks: ${document.chunkCount}`,
          `Imported: ${document.importedAt.toISOString()}`,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
  } catch (err) {
    console.warn("Knowledge inventory lookup failed:", err);
    return "Knowledge inventory lookup failed for this request.";
  }
}

function buildSystemPrompt(knowledgeContext: string, knowledgeInventory: string): string {
  return `You are the IRS SkyShield AI Compliance Agent — an expert on IRS Publication 1075 and related IRS Office of Safeguards knowledge-base documents, including interim guidance that may supersede or amend Pub 1075.

RESPONSE FORMAT (follow this structure exactly):

1. Start with a clear, direct one-sentence answer on the first line. No filler. Get straight to the point.

2. Then provide a detailed explanation. Use plain language. Format clearly:
   - Use numbered lists for sequential steps or requirements
   - Use bullet points for related items
   - Bold key terms with **term**
   - Keep paragraphs short (2-3 sentences max)

3. End every response with a references section in exactly this format:
---CITATIONS---
Pub 1075 Section X.X.X: Brief description
Interim Guidance - Document Title, page Y: Brief description

STYLE RULES:
- Be authoritative and concise — no filler phrases like "Great question!" or "I'd be happy to help"
- Start directly with the answer
- Do NOT use markdown headers (no # or ##)
- Do NOT use code blocks
- When referencing a section inline, use the format [Section X.X.X]
- If the answer is from interim guidance, name the interim guidance and explain how it amends or supersedes the Pub 1075 baseline
- If the answer is not in the retrieved knowledge excerpts, clearly state that the relevant text was not found
- Do not claim that no interim guidance exists unless the active knowledge inventory below contains no interim_guidance documents

IMPORTANT RULES:
1. NEVER ask for or process any Federal Tax Information (FTI), Personally Identifiable Information (PII), named state names, named agency names, taxpayer details, case numbers, or other identifiable information
2. If a user seems to be sharing FTI/PII or identifiable state/agency information, immediately warn them and refuse to process it
3. Always ground your answers in the retrieved knowledge excerpts
4. Treat active, relevant interim guidance as higher authority than baseline Pub 1075 when the guidance date/effective date indicates it supersedes or amends Pub 1075
5. Use Pub 1075 as the baseline when no relevant interim guidance is retrieved
6. Reason through gray areas carefully. Explain the controlling requirement, practical interpretation, and any uncertainty without inventing facts
7. If uncertain about a specific requirement, say so rather than guessing
8. If the active inventory lists an interim guidance document but no relevant excerpt was retrieved, say the guidance exists in the knowledge base but the relevant text was not retrieved for this query
9. If the provided excerpts do not contain enough information to answer, say that the relevant text was not found in the loaded excerpts and ask the user to narrow the question

ACTIVE KNOWLEDGE DOCUMENT INVENTORY:
=== BEGIN KNOWLEDGE INVENTORY ===
${knowledgeInventory}
=== END KNOWLEDGE INVENTORY ===

RELEVANT KNOWLEDGE EXCERPTS FOLLOW:
=== BEGIN KNOWLEDGE EXCERPTS ===
${knowledgeContext}
=== END KNOWLEDGE EXCERPTS ===`;
}

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
      // Match strict Pub 1075 style plus broader knowledge-base source labels.
      const match = line.match(
        /^(.{3,180}?):\s*(.+)$/i
      );
      if (match) {
        citations.push({ section: match[1], text: match[2].trim() });
      }
    }
  }

  // Extract inline [Section X.X.X] and [Section SC-28] references
  // Handles: [Section 4.18], [Section SC-28], [Section 4.18, SC-28], [Section AC-19], [Section 2.B.6]
  const inlineRefs = response.matchAll(
    /\[(Section\s+[\w.\-]+(?:\s*,\s*[\w.\-]+)?|Exhibit\s+\d+)(?:\s*,\s*Page\s+\d+)?\]/gi
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

function isKnowledgeInventoryQuestion(message: string): boolean {
  return /\b(what|which|list|show|tell)\b[\s\S]{0,80}\b(documents?|knowledge|guidance|sources?|loaded|uploaded|available)\b/i.test(
    message
  );
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
      let incidentId: string | null = null;
      try {
        const incident = await db.incident.create({
          data: {
            organizationId: userInfo.organizationId,
            title: `PII/FTI Detection: ${piiResult.matches.map((m) => m.type).join(", ")}`,
            description: `Automated detection triggered in AI chat. Detected types: ${piiResult.matches.map((m) => m.type).join(", ")}. The message was blocked and NOT sent to the AI service.`,
            type: "AUTO_GENERATED",
            severity:
              piiResult.matches.some(
                (m) =>
                  m.type === "SSN" ||
                  m.type === "EIN" ||
                  m.type === "AGENCY_NAME" ||
                  m.type === "STATE_OR_TERRITORY" ||
                  m.type === "IDENTIFIER"
              )
                ? "HIGH"
                : "MEDIUM",
            status: "OPEN",
            createdById: userInfo.id,
            affectedSystems: "AI Chat Interface",
          },
        });
        incidentId = incident.id;
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
        incidentId,
        message:
          "Your message was blocked because it appears to contain sensitive data (FTI/PII) or identifiable state/agency information. This data was NOT sent to any external service. An incident report has been automatically created.",
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
    let isNewConversation = false;
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
        isNewConversation = true;
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
    const llmSettings = await getLLMSettings();

    if (!llmSettings.apiKey || llmSettings.apiKey === "sk-ant-placeholder") {
      // Demo mode - return a sample response
      const demoResponse = `Based on Publication 1075, I can provide guidance on your question.

**Note:** This is a demo response. Configure the ANTHROPIC_API_KEY environment variable to enable AI powered IRS Office of Safeguards Compliance analysis.

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
      apiKey: llmSettings.apiKey,
    });
    const knowledgeInventory = await buildKnowledgeInventoryContext();
    const retrievedChunks = await retrieveKnowledgeChunks(message, 14).catch((err) => {
      console.warn("Knowledge retrieval failed, falling back to local Pub 1075 excerpts:", err);
      return [];
    });
    const pub1075Context =
      isKnowledgeInventoryQuestion(message)
        ? "The user's question is about the active knowledge inventory. Use the inventory section first; retrieved excerpts are not required to list loaded documents."
        : retrievedChunks.length > 0
          ? formatKnowledgeContext(retrievedChunks)
          : buildPub1075Context(message);
    const systemPrompt = buildSystemPrompt(pub1075Context, knowledgeInventory);

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

    const responsePromise = anthropic.messages.create({
      model: llmSettings.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: apiMessages,
    });

    let titlePromise: Promise<string | null> = Promise.resolve(null);
    if (isNewConversation) {
      titlePromise = anthropic.messages.create({
        model: "claude-3-haiku-20240307",
        max_tokens: 15,
        system: "You are a summarization assistant. Given a user's first message, generate a concise, 3-5 word title describing the topic. Do not include quotes, periods, or intro text. Just the title.",
        messages: [{ role: "user", content: message }],
      }).then((res) => {
        return res.content[0].type === "text" ? res.content[0].text.trim() : null;
      }).catch((err) => {
        console.warn("Failed to generate Haiku title:", err);
        return null;
      });
    }

    const [response, newTitle] = await Promise.all([responsePromise, titlePromise]);

    if (newTitle && convId) {
      // Fire-and-forget DB update so we don't block returning the response
      db.conversation.update({
        where: { id: convId, userId: userInfo.id },
        data: { title: newTitle },
      }).catch(err => console.warn("Failed to update new conversation title:", err));
    }

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
