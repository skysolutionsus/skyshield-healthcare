import assert from "node:assert/strict";
import {
  BifrostRequestError,
  isBifrostQuotaError,
  normalizeBifrostModel,
} from "../src/lib/ai/bifrost";
import {
  BIFROST_CHAT_MODEL_OPTIONS,
  BIFROST_QUOTA_FALLBACK_MODELS,
  isSupportedBifrostChatModel,
} from "../src/lib/ai/models";
import { saveBifrostChatModel } from "../src/lib/ai/model-settings";
import { canAccessPath } from "../src/lib/roles";

async function main() {
  assert.deepEqual(
    BIFROST_CHAT_MODEL_OPTIONS.map((option) => option.value),
    ["azure/claude-sonnet-4-6", "azure/gpt-5.1-chat", "gemma-4-26b"]
  );
  assert.deepEqual(
    BIFROST_QUOTA_FALLBACK_MODELS.map((option) => option.value),
    ["azure/gpt-5.1-chat", "gemma-4-26b"]
  );
  assert.equal(normalizeBifrostModel("gpt-5.1-chat"), "azure/gpt-5.1-chat");
  assert.equal(normalizeBifrostModel("gemma-4-26b"), "gemma-4-26b");
  assert.equal(isSupportedBifrostChatModel("azure/gpt-5.1-chat"), true);
  assert.equal(isSupportedBifrostChatModel("gemma-4-26b"), true);
  assert.equal(isSupportedBifrostChatModel("unapproved-model"), false);
  assert.equal(canAccessPath("VIEWER", "/api/settings/llm/switch"), true);
  assert.equal(canAccessPath("VIEWER", "/api/settings/llm"), false);

  assert.equal(
    isBifrostQuotaError(
      new BifrostRequestError("Too many requests", 429, "rate_limit_exceeded")
    ),
    true
  );
  assert.equal(isBifrostQuotaError(new Error("Bifrost quota has been exhausted")), true);
  assert.equal(isBifrostQuotaError(new Error("Bifrost chat completion failed (500)")), false);

  const upserts: unknown[] = [];
  const mockStore = {
    systemSetting: {
      async upsert(args: unknown) {
        upserts.push(args);
        return args;
      },
    },
  };

  await saveBifrostChatModel(mockStore, "gemma-4-26b", "test-user");
  assert.deepEqual(upserts, [
    {
      where: { key: "llm_model" },
      create: { key: "llm_model", value: "gemma-4-26b", updatedBy: "test-user" },
      update: { value: "gemma-4-26b", updatedBy: "test-user" },
    },
  ]);
  await assert.rejects(
    () => saveBifrostChatModel(mockStore, "unapproved-model", "test-user"),
    /Unsupported Bifrost chat model/
  );
  assert.equal(upserts.length, 1);

  console.log("Bifrost model switch tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
