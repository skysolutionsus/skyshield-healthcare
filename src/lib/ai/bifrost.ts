import { BIFROST_CHAT_MODEL_OPTIONS } from "@/lib/ai/models";

export const DEFAULT_BIFROST_MODEL = BIFROST_CHAT_MODEL_OPTIONS[0].value;
export const DEFAULT_BIFROST_EMBEDDING_MODEL = "azure/text-embedding-ada-002";
export const DEFAULT_BIFROST_BASE_URL = "http://192.168.16.104:8080/v1";

type JsonObject = Record<string, unknown>;
const DEFAULT_MAX_OUTPUT_TOKENS = 6000;

export class BifrostRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = "BifrostRequestError";
  }
}

export function isBifrostQuotaError(error: unknown): boolean {
  const code = error instanceof BifrostRequestError ? error.code || "" : "";
  const message = error instanceof Error ? error.message : String(error || "");
  const haystack = `${code} ${message}`.toLowerCase();

  return [
    "insufficient_quota",
    "quota_exceeded",
    "quota exceeded",
    "quota has been exhausted",
    "quota exhausted",
    "out of tokens",
    "token quota",
    "token budget exhausted",
    "budget exceeded",
    "budget_exceeded",
    "spend limit exceeded",
    "billing hard limit",
    "billing_hard_limit_reached",
    "insufficient credits",
  ].some((indicator) => haystack.includes(indicator));
}

export interface BifrostToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments?: string | JsonObject;
  };
}

export interface BifrostChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: BifrostToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface BifrostChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonObject;
  };
}

export interface BifrostChatCompletionRequest {
  model: string;
  messages: BifrostChatMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: BifrostChatTool[];
  tool_choice?: "auto" | "none";
}

export interface BifrostChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: unknown;
      tool_calls?: BifrostToolCall[];
    };
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

export interface BifrostEmbeddingResponse {
  data: Array<{ index: number; embedding: number[] }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

export function normalizeBifrostBaseUrl(rawBaseUrl?: string | null): string {
  const fallback = DEFAULT_BIFROST_BASE_URL;
  let baseUrl = (rawBaseUrl || fallback).trim() || fallback;

  baseUrl = baseUrl.replace(/\/+$/, "");

  if (baseUrl.endsWith("/chat/completions")) {
    baseUrl = baseUrl.slice(0, -"/chat/completions".length);
  }

  if (!baseUrl.endsWith("/v1")) {
    baseUrl = `${baseUrl}/v1`;
  }

  return baseUrl;
}

export function getBifrostBaseUrl(): string {
  return normalizeBifrostBaseUrl(process.env.BIFROST_BASE_URL);
}

export function getBifrostChatCompletionsUrl(baseUrl?: string): string {
  return `${normalizeBifrostBaseUrl(baseUrl || getBifrostBaseUrl())}/chat/completions`;
}

export function getBifrostEmbeddingsUrl(baseUrl?: string): string {
  return `${normalizeBifrostBaseUrl(baseUrl || getBifrostBaseUrl())}/embeddings`;
}

export function normalizeBifrostModel(model?: string | null): string {
  const value = (model || "").trim();
  if (!value) return DEFAULT_BIFROST_MODEL;
  if (value.startsWith("azure/")) return value;
  if (value.startsWith("claude-")) {
    return DEFAULT_BIFROST_MODEL;
  }
  if (value.startsWith("gpt-")) {
    return `azure/${value}`;
  }
  return value;
}

export function getConfiguredBifrostModel(
  specificEnvVar?: "BIFROST_MODEL" | "BIFROST_TITLE_MODEL" | "BIFROST_SCSEM_MODEL"
): string {
  if (specificEnvVar && process.env[specificEnvVar]) {
    return normalizeBifrostModel(process.env[specificEnvVar]);
  }
  return normalizeBifrostModel(process.env.BIFROST_MODEL);
}

export function getConfiguredBifrostEmbeddingModel(): string {
  return (process.env.BIFROST_EMBEDDING_MODEL || DEFAULT_BIFROST_EMBEDDING_MODEL).trim();
}

export function hasConfiguredBifrostApiKey(apiKey?: string | null): boolean {
  const value = (apiKey || "").trim();
  return Boolean(value && value !== "sk-bf-placeholder");
}

export function isLikelyBifrostVirtualKey(apiKey?: string | null): boolean {
  return (apiKey || "").trim().startsWith("sk-bf-");
}

export function maskSecret(secret?: string | null): string {
  const value = (secret || "").trim();
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return `${"•".repeat(Math.max(value.length - 4, 4))}${value.slice(-4)}`;
}

export function extractBifrostMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }

  return "";
}

export function parseBifrostToolArguments(args: string | JsonObject | undefined): JsonObject {
  if (!args) return {};
  if (typeof args === "object") return args;

  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function clampBifrostMaxTokens(maxTokens?: number): number | undefined {
  if (maxTokens === undefined) return undefined;
  const configuredMax = Number(process.env.BIFROST_MAX_OUTPUT_TOKENS || DEFAULT_MAX_OUTPUT_TOKENS);
  if (!Number.isFinite(configuredMax) || configuredMax <= 0) return maxTokens;
  return Math.min(maxTokens, configuredMax);
}

export async function createBifrostChatCompletion(
  request: BifrostChatCompletionRequest,
  options: { apiKey?: string; baseUrl?: string; signal?: AbortSignal } = {}
): Promise<BifrostChatCompletionResponse> {
  const apiKey = (options.apiKey || process.env.BIFROST_API_KEY || "").trim();
  if (!hasConfiguredBifrostApiKey(apiKey)) {
    throw new Error("BIFROST_API_KEY is not set");
  }

  const response = await fetch(getBifrostChatCompletionsUrl(options.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...request,
      model: normalizeBifrostModel(request.model),
      max_tokens: clampBifrostMaxTokens(request.max_tokens),
    }),
    signal: options.signal,
  });

  const responseText = await response.text();
  let payload: BifrostChatCompletionResponse | null = null;

  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      responseText.slice(0, 500) ||
      response.statusText ||
      "Unknown Bifrost error";
    throw new BifrostRequestError(
      `Bifrost chat completion failed (${response.status}): ${message}`,
      response.status,
      payload?.error?.code || payload?.error?.type
    );
  }

  if (!payload) {
    throw new Error(`Bifrost returned a non-JSON response: ${responseText.slice(0, 500)}`);
  }

  if (payload.error?.message) {
    throw new BifrostRequestError(
      `Bifrost chat completion failed: ${payload.error.message}`,
      undefined,
      payload.error.code || payload.error.type
    );
  }

  return payload;
}

export async function createBifrostEmbedding(
  input: string[],
  options: { apiKey?: string; baseUrl?: string; model?: string; signal?: AbortSignal } = {}
): Promise<BifrostEmbeddingResponse> {
  const apiKey = (options.apiKey || process.env.BIFROST_API_KEY || "").trim();
  if (!hasConfiguredBifrostApiKey(apiKey)) {
    throw new Error("BIFROST_API_KEY is not set");
  }

  const response = await fetch(getBifrostEmbeddingsUrl(options.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model || getConfiguredBifrostEmbeddingModel(),
      input,
    }),
    signal: options.signal,
  });

  const responseText = await response.text();
  let payload: BifrostEmbeddingResponse | null = null;

  try {
    payload = responseText ? JSON.parse(responseText) : { data: [] };
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      responseText.slice(0, 500) ||
      response.statusText ||
      "Unknown Bifrost embedding error";
    throw new Error(`Bifrost embedding request failed (${response.status}): ${message}`);
  }

  if (!payload) {
    throw new Error(`Bifrost returned a non-JSON embedding response: ${responseText.slice(0, 500)}`);
  }

  if (payload.error?.message) {
    throw new Error(`Bifrost embedding request failed: ${payload.error.message}`);
  }

  return payload;
}

export async function generateBifrostText(options: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const messages: BifrostChatMessage[] = [];
  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: options.prompt });

  const response = await createBifrostChatCompletion(
    {
      model: normalizeBifrostModel(options.model),
      max_tokens: clampBifrostMaxTokens(options.maxTokens),
      temperature: options.temperature,
      messages,
    },
    { apiKey: options.apiKey, baseUrl: options.baseUrl, signal: options.signal }
  );

  return extractBifrostMessageText(response.choices?.[0]?.message?.content).trim();
}
