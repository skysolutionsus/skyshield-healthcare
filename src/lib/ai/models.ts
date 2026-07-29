export const BIFROST_CHAT_MODEL_OPTIONS = [
  {
    value: "azure/claude-sonnet-4-6",
    label: "Bifrost Claude Sonnet 4.6 (Default)",
  },
  {
    value: "azure/gpt-5.1-chat",
    label: "Bifrost GPT-5.1 Chat",
  },
  {
    value: "gemma-4-26b",
    label: "Bifrost Gemma 4 26B",
  },
] as const;

export type BifrostChatModel = (typeof BIFROST_CHAT_MODEL_OPTIONS)[number]["value"];

export const BIFROST_QUOTA_FALLBACK_MODELS = BIFROST_CHAT_MODEL_OPTIONS.filter(
  (option) => option.value !== "azure/claude-sonnet-4-6"
);

export function isSupportedBifrostChatModel(model: unknown): model is BifrostChatModel {
  return (
    typeof model === "string" &&
    BIFROST_CHAT_MODEL_OPTIONS.some((option) => option.value === model.trim())
  );
}
