import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { detectPII } from "@/lib/pii-detection";
import { logAudit } from "@/lib/audit";
import Anthropic from "@anthropic-ai/sdk";
import {
  handleKnowledgeSearch,
  KNOWLEDGE_SEARCH_TOOL,
  type KnowledgeSearchInput,
} from "@/lib/knowledge/agent-tools";
import { buildFallbackContext } from "@/lib/knowledge/fallback-context";

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

// Allow up to 60s for the full agent loop (multiple tool rounds + final answer).
export const maxDuration = 60;

// Agent loop bounds: 5 tool rounds is enough for "search baseline → search
// interim guidance → refine" compliance flows without runaway.
const MAX_TOOL_ROUNDS = 5;
const MAX_TOKENS_PER_ROUND = 4096;

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

async function buildKnowledgeInventoryContext(): Promise<{
  content: string;
  available: boolean;
}> {
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
      return {
        content: "No active knowledge documents are currently registered in the database.",
        available: false,
      };
    }

    const content = documents
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

    return { content, available: true };
  } catch (err) {
    console.warn("Knowledge inventory lookup failed:", err);
    return {
      content: "Knowledge inventory lookup failed for this request.",
      available: false,
    };
  }
}

function buildSystemPrompt(options: {
  knowledgeInventory: string;
  fallbackWarning: string | null;
  fallbackContext: string | null;
}): string {
  const { knowledgeInventory, fallbackWarning, fallbackContext } = options;

  const retrievalInstructions = fallbackContext
    ? `RETRIEVAL MODE: DEGRADED. Live knowledge retrieval is unavailable. A pre-loaded fallback excerpt set is provided below — use it to answer. Do NOT call the knowledge_search tool; it will fail.`
    : `RETRIEVAL MODE: AGENTIC. You have access to a knowledge_search tool. You MUST call knowledge_search to ground every compliance answer.

WHEN TO CALL knowledge_search:
- On every user message about Pub 1075, FTI, IRS Safeguards, or any compliance topic
- Use multiple calls for multi-faceted questions: search the Pub 1075 baseline first, then search for any impacting interim guidance
- If the first result is a short fragment, call again with expand_neighbors=true or a more specific query
- If the user asks about a NIST control (e.g., SC-28), search that control ID directly AND search for interim guidance that references it
- Do NOT answer from memory for anything beyond the most general framing

WHEN NOT TO CALL knowledge_search:
- Questions purely about the active knowledge inventory below (e.g., "what documents are loaded")
- Pure conversational acknowledgements
- Questions about your own capabilities`;

  return `You are the IRS SkyShield AI Compliance Agent — an expert on IRS Publication 1075 and related IRS Office of Safeguards knowledge-base documents, including interim guidance that may supersede or amend Pub 1075.

${retrievalInstructions}

RESPONSE FORMAT (follow this structure exactly):

1. LEAD (required). First line = one-sentence direct answer. No preamble, no filler, no "Great question". State the controlling rule. Follow it with a blank line.

2. EXPLANATION. Then expand with the detail a reviewer needs. Keep it scannable:
   - Short paragraphs (2-3 sentences) separated by blank lines
   - Bullet points ("- ") for parallel items (requirements, prohibitions, conditions)
   - Numbered lists ("1. ") ONLY for true sequential steps, never as pseudo-headers
   - Bold inline labels for grouped points: **SC-28 (Protection at Rest):** followed by the explanation. Do NOT use a standalone numbered/bulleted line as a section title.
   - Inline section references use [Section X.X.X]

3. CITATIONS (required). End with exactly this block, nothing after it:
---CITATIONS---
Pub 1075 Section X.X.X: Brief description
Interim Guidance - Document Title, page Y: Brief description

RENDERING CONSTRAINTS (the chat UI is a minimal renderer — violating these produces visible junk):
- NEVER output horizontal rule separators ("---", "***", "___") inside the body. The only "---" allowed in the entire response is the "---CITATIONS---" delimiter.
- NEVER output markdown tables (no "|" column syntax, no "---|---" rows). Tables render as literal pipe characters. Use a bullet list instead: "- **Requirement:** Standard".
- NEVER use markdown headers (#, ##, ###).
- NEVER use fenced code blocks (triple backticks), blockquotes (leading ">"), or images.
- NEVER use emojis or decorative symbols (⚠️, ✅, →, etc.).
- Supported formatting is ONLY: plain paragraphs, "- " bullets, "1. " numbered lists, **bold**, single-backtick inline code, and [Section X.X.X] references.

STYLE RULES:
- Be authoritative and concise. No filler phrases.
- If the answer is from interim guidance, name the interim guidance and explain how it amends or supersedes the Pub 1075 baseline.
- If the retrieved excerpts do not answer the question, say so explicitly — do not fabricate.
- Do not claim that no interim guidance exists unless the active knowledge inventory below contains no interim_guidance documents.

IMPORTANT RULES:
1. NEVER ask for or process any Federal Tax Information (FTI), Personally Identifiable Information (PII), named state names, named agency names, taxpayer details, case numbers, or other identifiable information
2. If a user seems to be sharing FTI/PII or identifiable state/agency information, immediately warn them and refuse to process it
3. Always ground your answers in the retrieved knowledge excerpts (from knowledge_search) or the pre-loaded fallback excerpts when in degraded mode
4. Treat active, relevant interim guidance as higher authority than baseline Pub 1075 when the guidance date/effective date indicates it supersedes or amends Pub 1075
5. Use Pub 1075 as the baseline when no relevant interim guidance is retrieved
6. Reason through gray areas carefully. Explain the controlling requirement, practical interpretation, and any uncertainty without inventing facts
7. If uncertain about a specific requirement, say so rather than guessing
8. If the active inventory lists an interim guidance document but no relevant excerpt was retrieved, say the guidance exists in the knowledge base but was not retrieved for this query — and consider calling knowledge_search again with the document title

${fallbackWarning ? `\nDEGRADED NOTICE: ${fallbackWarning}\n` : ""}
ACTIVE KNOWLEDGE DOCUMENT INVENTORY:
=== BEGIN KNOWLEDGE INVENTORY ===
${knowledgeInventory}
=== END KNOWLEDGE INVENTORY ===
${fallbackContext ? `

PRE-LOADED FALLBACK EXCERPTS (use these; knowledge_search is unavailable):
=== BEGIN FALLBACK EXCERPTS ===
${fallbackContext}
=== END FALLBACK EXCERPTS ===
` : ""}`;
}

function extractCitations(
  response: string
): { section: string; text: string }[] {
  const citations: { section: string; text: string }[] = [];

  const citationBlock = response.match(
    /---CITATIONS---\s*([\s\S]*?)(?:$|---)/
  );
  if (citationBlock) {
    const lines = citationBlock[1].trim().split("\n");
    for (const line of lines) {
      const match = line.match(/^(.{3,180}?):\s*(.+)$/i);
      if (match) {
        citations.push({ section: match[1], text: match[2].trim() });
      }
    }
  }

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
  return response.replace(/---CITATIONS---[\s\S]*?(?:---|$)/, "").trim();
}

/**
 * Run the Anthropic agent loop with the knowledge_search tool. Executes up to
 * MAX_TOOL_ROUNDS rounds; returns the final assistant text and telemetry.
 */
async function runAgentLoop(
  anthropic: Anthropic,
  model: string,
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  enableTools: boolean
): Promise<{
  finalText: string;
  toolCallsExecuted: number;
  rounds: number;
  stopReason: string;
}> {
  let toolCallsExecuted = 0;
  let rounds = 0;
  let finalText = "";
  let stopReason = "unknown";

  // Use a mutable working copy of the messages array.
  const working: Anthropic.MessageParam[] = [...messages];

  while (rounds < MAX_TOOL_ROUNDS) {
    const response: Anthropic.Message = await anthropic.messages.create({
      model,
      max_tokens: MAX_TOKENS_PER_ROUND,
      system: systemPrompt,
      tools: enableTools ? [KNOWLEDGE_SEARCH_TOOL] : undefined,
      messages: working,
    });

    stopReason = response.stop_reason || "unknown";

    // Always append the assistant turn to the working history.
    working.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      for (const block of response.content) {
        if (block.type === "text") finalText += block.text;
      }
      break;
    }

    // Execute each tool_use block in parallel.
    const toolBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    const toolResults = await Promise.all(
      toolBlocks.map(async (block) => {
        toolCallsExecuted += 1;
        if (block.name !== "knowledge_search") {
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: `ERROR: unknown tool '${block.name}'. Only knowledge_search is available.`,
            is_error: true,
          };
        }

        const input = block.input as KnowledgeSearchInput;
        const outcome = await handleKnowledgeSearch(input);
        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: outcome.content,
        };
      })
    );

    working.push({ role: "user", content: toolResults });
    rounds += 1;
  }

  if (!finalText) {
    // Loop hit MAX_TOOL_ROUNDS without producing final text. Force a final turn
    // with tools disabled so the model must synthesize an answer from context.
    const finalResponse: Anthropic.Message = await anthropic.messages.create({
      model,
      max_tokens: MAX_TOKENS_PER_ROUND,
      system:
        systemPrompt +
        "\n\nYou have reached the maximum number of tool-use rounds. Produce the best answer you can from the tool results already in the conversation. Do not call any more tools.",
      messages: working,
    });
    stopReason = finalResponse.stop_reason || stopReason;
    for (const block of finalResponse.content) {
      if (block.type === "text") finalText += block.text;
    }
  }

  return { finalText, toolCallsExecuted, rounds, stopReason };
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
        // ignore
      }

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

    const llmSettings = await getLLMSettings();

    if (!llmSettings.apiKey || llmSettings.apiKey === "sk-ant-placeholder") {
      const demoResponse = `Based on Publication 1075, I can provide guidance on your question.

**Note:** This is a demo response. Configure the ANTHROPIC_API_KEY environment variable to enable AI powered IRS Office of Safeguards Compliance analysis.

Your question: "${message}"

For full Pub 1075 guidance, please ensure the Anthropic API key is configured.

---CITATIONS---
Section 1.1: Introduction to Publication 1075
Section 3.1: General Requirements`;

      const citations = extractCitations(demoResponse);
      const cleanedResponse = cleanResponseText(demoResponse);

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

    const anthropic = new Anthropic({ apiKey: llmSettings.apiKey });
    const inventory = await buildKnowledgeInventoryContext();

    // Decide if we should run in degraded (fallback) mode: DB appears unhealthy.
    const useFallback = !inventory.available;
    const fallback = useFallback ? buildFallbackContext({ message }) : null;

    const systemPrompt = buildSystemPrompt({
      knowledgeInventory: inventory.content,
      fallbackWarning: fallback?.warning ?? null,
      fallbackContext: fallback?.context ?? null,
    });

    const apiMessages: Anthropic.MessageParam[] = [];
    for (const msg of previousMessages.slice(0, -1)) {
      apiMessages.push({ role: msg.role, content: msg.content });
    }
    apiMessages.push({ role: "user", content: message });

    const agentPromise = runAgentLoop(
      anthropic,
      llmSettings.model,
      systemPrompt,
      apiMessages,
      !useFallback
    );

    let titlePromise: Promise<string | null> = Promise.resolve(null);
    if (isNewConversation) {
      titlePromise = anthropic.messages
        .create({
          model: "claude-3-haiku-20240307",
          max_tokens: 15,
          system:
            "You are a summarization assistant. Given a user's first message, generate a concise, 3-5 word title describing the topic. Do not include quotes, periods, or intro text. Just the title.",
          messages: [{ role: "user", content: message }],
        })
        .then((res) => (res.content[0].type === "text" ? res.content[0].text.trim() : null))
        .catch((err) => {
          console.warn("Failed to generate Haiku title:", err);
          return null;
        });
    }

    const [agentResult, newTitle] = await Promise.all([agentPromise, titlePromise]);

    if (newTitle && convId) {
      db.conversation
        .update({ where: { id: convId, userId: userInfo.id }, data: { title: newTitle } })
        .catch((err) => console.warn("Failed to update new conversation title:", err));
    }

    const citations = extractCitations(agentResult.finalText);
    const cleanedResponse = cleanResponseText(agentResult.finalText);

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
      retrieval: {
        mode: useFallback ? "degraded-fallback" : "agentic",
        toolCallsExecuted: agentResult.toolCallsExecuted,
        rounds: agentResult.rounds,
        stopReason: agentResult.stopReason,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Chat API error:", errorMessage, error);

    if (
      errorMessage.includes("DATABASE_URL") ||
      errorMessage.includes("prisma") ||
      errorMessage.toLowerCase().includes("connect")
    ) {
      return NextResponse.json(
        { error: `Database error: ${errorMessage}` },
        { status: 503 }
      );
    }

    if (
      errorMessage.includes("401") ||
      errorMessage.includes("Unauthorized") ||
      errorMessage.includes("auth")
    ) {
      return NextResponse.json(
        { error: `Auth error: ${errorMessage}` },
        { status: 401 }
      );
    }

    if (
      errorMessage.includes("anthropic") ||
      errorMessage.includes("Anthropic") ||
      errorMessage.includes("model") ||
      errorMessage.includes("api_key")
    ) {
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
