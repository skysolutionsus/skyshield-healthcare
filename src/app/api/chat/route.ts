import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { detectPII } from "@/lib/pii-detection";
import { auditRequestContext, logAudit, truncateAuditText } from "@/lib/audit";
import { handleKnowledgeSearch } from "@/lib/knowledge/agent-tools";
import { buildFallbackContext } from "@/lib/knowledge/fallback-context";
import {
  generateBifrostText,
  getConfiguredBifrostModel,
  hasConfiguredBifrostApiKey,
  isLikelyBifrostVirtualKey,
  normalizeBifrostModel,
  parseBifrostToolArguments,
} from "@/lib/ai/bifrost";

// Helper: Get LLM settings from DB, fall back to env vars
async function getLLMSettings(): Promise<{ model: string; apiKey: string }> {
  let model = getConfiguredBifrostModel("BIFROST_MODEL");
  let apiKey = hasConfiguredBifrostApiKey(process.env.BIFROST_API_KEY)
    ? process.env.BIFROST_API_KEY || ""
    : "";

  try {
    const settings = await db.systemSetting.findMany({
      where: { key: { in: ["llm_model", "llm_api_key"] } },
    });
    for (const s of settings) {
      if (s.key === "llm_model" && s.value) model = normalizeBifrostModel(s.value);
      if (
        !apiKey &&
        s.key === "llm_api_key" &&
        isLikelyBifrostVirtualKey(s.value) &&
        hasConfiguredBifrostApiKey(s.value)
      ) {
        apiKey = s.value;
      }
    }
  } catch {
    // Fall back to defaults if DB is unavailable
  }

  return { model, apiKey };
}

// Allow up to 60s for retrieval plus the final Bifrost answer call.
export const maxDuration = 60;

const CHAT_MAX_TOKENS = Number(process.env.BIFROST_CHAT_MAX_TOKENS || 1800);
const RETRIEVAL_LIMIT = Number(process.env.BIFROST_CHAT_RETRIEVAL_LIMIT || 6);
const MAX_RETRIEVAL_CONTEXT_CHARS = Number(process.env.BIFROST_CHAT_CONTEXT_CHARS || 14000);
const MAX_HISTORY_CHARS = 2500;

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

function currentSafeguardsResponseDate(): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  }).format(new Date());
}

async function buildKnowledgeInventoryContext(): Promise<{
  content: string;
  available: boolean;
}> {
  try {
    const documents = await db.knowledgeDocument.findMany({
      where: { status: "ACTIVE" },
      orderBy: [{ sourceType: "asc" }, { importedAt: "desc" }],
      take: 12,
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
  retrievalContext: string;
  fallbackWarning: string | null;
  fallbackContext: string | null;
}): string {
  const { knowledgeInventory, retrievalContext, fallbackWarning, fallbackContext } = options;
  const responseDate = currentSafeguardsResponseDate();

  return `You are the IRS SkyShield AI Compliance Agent — an expert on IRS Publication 1075 and related IRS Office of Safeguards knowledge-base documents, including interim guidance that may supersede or amend Pub 1075.

RETRIEVAL MODE: ${fallbackContext ? "DEGRADED. Live retrieval is unavailable; use the fallback excerpts below." : "PRE-RETRIEVED. The application has already searched the knowledge base for this question."}

Use ONLY the retrieved excerpts and active inventory below for specific compliance claims. Do not call tools. If the excerpts do not answer the question, say that the loaded knowledge base did not retrieve a specific answer.

VISIBLE RESPONSE FORMAT (follow this structure exactly; this is the text the user sees):

Hello,

Thank you for reaching out to the IRS Office of Safeguards on ${responseDate}, regarding [brief plain-language summary of the inquiry]. Please see the IRS response below.

Response: [Bottom-line answer in 1-3 direct sentences. Answer the question first. If the retrieved excerpts do not answer it, say that clearly here.]

Support and References:
- [Explain the controlling requirement, practical interpretation, or limitation in clear language.]
- [Cite the specific retrieved Pub 1075 section or interim guidance document and explain how it supports the response.]

If you have any further questions regarding this inquiry or have any other issues, please reach out to the IRS Office of Safeguards mailbox: SafeguardReports@irs.gov.

Thank you,

Office of Safeguards

MANDATORY FIXED TEXT:
- The first paragraph after "Hello," must always be exactly: "Thank you for reaching out to the IRS Office of Safeguards on ${responseDate}, regarding [brief plain-language summary of the inquiry]. Please see the IRS response below."
- Replace only the bracketed inquiry summary. Do not omit, paraphrase, quote, bold, or move this paragraph.
- The closing paragraph before "Thank you," must always be exactly: "If you have any further questions regarding this inquiry or have any other issues, please reach out to the IRS Office of Safeguards mailbox: SafeguardReports@irs.gov."
- Do not omit, paraphrase, quote, bold, or move the closing paragraph.
- Do not add an "Inquiry:" heading for a single-question response.

MULTIPLE INQUIRIES:
- If the user asks more than one question, keep the mandatory greeting and closing once, and include one "Response to Inquiry N:" and "Support and References:" block for each question.
- Keep each response independent and easy to scan.
- Put the shared closing only once at the end.

SUPPORT AND REFERENCES RULES:
- The Support and References section must be visible in the answer. Do not put all support only in the hidden citations block.
- Use bullet points ("- ") for support items.
- Each support bullet should be concise and tied to the response.
- Inline section references use [Section X.X.X] when available.
- If interim guidance applies, name it and explain whether it amends or supersedes the Pub 1075 baseline.
- If no relevant excerpt was retrieved, state that the loaded knowledge base did not retrieve a specific answer and avoid inventing a requirement.

HIDDEN MACHINE CITATIONS (required). After the visible signature, end with exactly this block, nothing after it. This block is stripped from the displayed answer and used for reference chips:
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
- Be authoritative, plainspoken, and concise.
- Keep the answer under 700 words unless the user explicitly asks for a longer analysis.
- Do not use conversational filler such as "Great question" or "Happy to help."
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
8. If the active inventory lists an interim guidance document but no relevant excerpt was retrieved, say the guidance exists in the knowledge base but was not retrieved for this query

${fallbackWarning ? `\nDEGRADED NOTICE: ${fallbackWarning}\n` : ""}
ACTIVE KNOWLEDGE DOCUMENT INVENTORY:
=== BEGIN KNOWLEDGE INVENTORY ===
${knowledgeInventory}
=== END KNOWLEDGE INVENTORY ===
RETRIEVED EXCERPTS:
=== BEGIN RETRIEVED EXCERPTS ===
${retrievalContext}
=== END RETRIEVED EXCERPTS ===`;
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

function limitText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[Context truncated for Bifrost timeout protection.]`;
}

function formatConversationContext(
  messages: Array<{ role: "user" | "assistant"; content: string }>
): string {
  const recent = messages.slice(-6);
  const formatted = recent
    .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
    .join("\n\n");
  return limitText(formatted, MAX_HISTORY_CHARS);
}

async function writeChatAudit(options: {
  request: Request;
  organizationId: string;
  userId: string;
  conversationId?: string | null;
  input: string;
  output: string;
  citations: { section: string; text: string }[];
  retrieval?: {
    mode: "retrieved" | "degraded-fallback";
    toolCallsExecuted: number;
    rounds: number;
    stopReason: string;
  };
  model?: string;
  demoMode?: boolean;
}) {
  await logAudit({
    organizationId: options.organizationId,
    userId: options.userId,
    action: "AI_QUERY",
    resourceType: "chat",
    resourceId: options.conversationId || undefined,
    metadata: {
      input: {
        message: truncateAuditText(options.input, 6000),
        messageLength: options.input.length,
      },
      output: {
        response: truncateAuditText(options.output, 10000),
        responseLength: options.output.length,
        citations: options.citations,
      },
      retrieval: options.retrieval || null,
      model: options.model || null,
      demoMode: Boolean(options.demoMode),
    },
    ...auditRequestContext(options.request),
  });
}

async function retrieveGroundingContext(message: string): Promise<{
  content: string;
  toolCallsExecuted: number;
  mode: "retrieved" | "degraded-fallback";
  fallbackWarning: string | null;
  fallbackContext: string | null;
  inventory: { content: string; available: boolean };
}> {
  const inventory = await buildKnowledgeInventoryContext();
  const fallback = !inventory.available ? buildFallbackContext({ message }) : null;

  if (fallback) {
    return {
      content: limitText(fallback.context, MAX_RETRIEVAL_CONTEXT_CHARS),
      toolCallsExecuted: 0,
      mode: "degraded-fallback",
      fallbackWarning: fallback.warning,
      fallbackContext: fallback.context,
      inventory,
    };
  }

  const outcome = await handleKnowledgeSearch({
    query: message,
    limit: RETRIEVAL_LIMIT,
    expand_neighbors: true,
  });

  return {
    content: limitText(outcome.content, MAX_RETRIEVAL_CONTEXT_CHARS),
    toolCallsExecuted: 1,
    mode: "retrieved",
    fallbackWarning: null,
    fallbackContext: null,
    inventory,
  };
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

    // PII/FTI Detection - MUST happen before sending to the AI provider
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
          ...auditRequestContext(request),
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

    if (!hasConfiguredBifrostApiKey(llmSettings.apiKey)) {
      const responseDate = currentSafeguardsResponseDate();
      const demoResponse = `Hello,

Thank you for reaching out to the IRS Office of Safeguards on ${responseDate}, regarding your Safeguards compliance inquiry. Please see the IRS response below.

Response: The AI agent is currently running in demo mode because the Bifrost API key is not configured. A grounded IRS Office of Safeguards response cannot be generated until the AI service is configured.

Support and References:
- The request was not sent to the AI model because no configured Bifrost virtual key was available.
- Configure the BIFROST_API_KEY environment variable or the LLM settings page to enable grounded Pub 1075 and interim guidance responses.
- Once configured, the agent will answer using retrieved knowledge-base excerpts and visible Support and References.

If you have any further questions regarding this inquiry or have any other issues, please reach out to the IRS Office of Safeguards mailbox: SafeguardReports@irs.gov.

Thank you,

Office of Safeguards

---CITATIONS---
System Configuration: Bifrost API key is required for grounded AI responses`;

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

      try {
        await writeChatAudit({
          request,
          organizationId: userInfo.organizationId,
          userId: userInfo.id,
          conversationId: convId,
          input: message,
          output: cleanedResponse,
          citations,
          model: "demo",
          demoMode: true,
        });
      } catch {
        // ignore
      }

      return NextResponse.json({
        response: cleanedResponse,
        citations,
        conversationId: convId,
      });
    }

    const grounding = await retrieveGroundingContext(message);

    const systemPrompt = buildSystemPrompt({
      knowledgeInventory: grounding.inventory.content,
      retrievalContext: grounding.content,
      fallbackWarning: grounding.fallbackWarning,
      fallbackContext: grounding.fallbackContext,
    });

    const conversationContext = formatConversationContext(previousMessages.slice(0, -1));
    const answerPrompt = [
      conversationContext ? `Recent conversation:\n${conversationContext}` : null,
      `Current user question:\n${message}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    let finalText: string;
    try {
      finalText = await generateBifrostText({
        apiKey: llmSettings.apiKey,
        model: llmSettings.model,
        maxTokens: CHAT_MAX_TOKENS,
        temperature: 0.2,
        system: systemPrompt,
        prompt: answerPrompt,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes("504") && !errorMessage.toLowerCase().includes("timed out")) {
        throw error;
      }

      console.warn("Retrying Bifrost chat answer with compact prompt after timeout:", errorMessage);
      finalText = await generateBifrostText({
        apiKey: llmSettings.apiKey,
        model: llmSettings.model,
        maxTokens: 900,
        temperature: 0.1,
        system: buildSystemPrompt({
          knowledgeInventory: "Compact retry mode. Use the retrieved excerpts below.",
          retrievalContext: limitText(grounding.content, 7000),
          fallbackWarning: grounding.fallbackWarning,
          fallbackContext: grounding.fallbackContext,
        }),
        prompt: `Answer this Pub 1075 question concisely using the required IRS Office of Safeguards response format and the retrieved excerpts: ${message}`,
      });
    }

    if (isNewConversation && convId) {
      generateBifrostText({
        apiKey: llmSettings.apiKey,
        model: getConfiguredBifrostModel("BIFROST_TITLE_MODEL"),
        maxTokens: 12,
        system:
          "Generate a concise 3-5 word title for the user's message. Return only the title.",
        prompt: message,
      })
        .then((title) => {
          const cleanTitle = title.trim();
          if (!cleanTitle) return null;
          return db.conversation.update({
            where: { id: convId, userId: userInfo.id },
            data: { title: cleanTitle },
          });
        })
        .catch((err) => console.warn("Failed to generate Bifrost title:", err));
    }

    const citations = extractCitations(finalText);
    const cleanedResponse = cleanResponseText(finalText);
    const retrievalAudit = {
      mode: grounding.mode,
      toolCallsExecuted: grounding.toolCallsExecuted,
      rounds: 1,
      stopReason: "stop",
    };

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

    try {
      await writeChatAudit({
        request,
        organizationId: userInfo.organizationId,
        userId: userInfo.id,
        conversationId: convId,
        input: message,
        output: cleanedResponse,
        citations,
        retrieval: retrievalAudit,
        model: llmSettings.model,
      });
    } catch {
      // ignore
    }

    return NextResponse.json({
      response: cleanedResponse,
      citations,
      conversationId: convId,
      retrieval: retrievalAudit,
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
      errorMessage.includes("Bifrost") ||
      errorMessage.includes("bifrost") ||
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
