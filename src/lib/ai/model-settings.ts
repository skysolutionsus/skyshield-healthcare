import {
  isSupportedBifrostChatModel,
  type BifrostChatModel,
} from "@/lib/ai/models";

interface SystemSettingStore {
  systemSetting: {
    upsert(args: {
      where: { key: string };
      create: { key: string; value: string; updatedBy: string };
      update: { value: string; updatedBy: string };
    }): Promise<unknown>;
  };
}

export async function saveBifrostChatModel(
  store: SystemSettingStore,
  model: string,
  updatedBy: string
): Promise<BifrostChatModel> {
  const normalizedModel = model.trim();
  if (!isSupportedBifrostChatModel(normalizedModel)) {
    throw new Error("Unsupported Bifrost chat model");
  }

  await store.systemSetting.upsert({
    where: { key: "llm_model" },
    create: { key: "llm_model", value: normalizedModel, updatedBy },
    update: { value: normalizedModel, updatedBy },
  });

  return normalizedModel;
}
