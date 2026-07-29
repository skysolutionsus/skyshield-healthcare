import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auditRequestContext, logAudit } from "@/lib/audit";
import { requireCurrentUser } from "@/lib/current-user-auth";
import {
  BIFROST_QUOTA_FALLBACK_MODELS,
  isSupportedBifrostChatModel,
} from "@/lib/ai/models";
import { saveBifrostChatModel } from "@/lib/ai/model-settings";

const ALLOWED_FALLBACK_MODELS = new Set<string>(
  BIFROST_QUOTA_FALLBACK_MODELS.map((option) => option.value)
);

// POST /api/settings/llm/switch — Let an authenticated agent user recover
// from provider quota exhaustion by selecting one of the approved fallbacks.
export async function POST(request: NextRequest) {
  try {
    const access = await requireCurrentUser();
    if (!access.ok) return access.response;

    const body = await request.json();
    const model = typeof body?.model === "string" ? body.model.trim() : "";

    if (!isSupportedBifrostChatModel(model) || !ALLOWED_FALLBACK_MODELS.has(model)) {
      return NextResponse.json(
        { error: "Select an approved Bifrost fallback model." },
        { status: 400 }
      );
    }

    await saveBifrostChatModel(db, model, access.user.id);

    try {
      await logAudit({
        organizationId: access.user.organizationId,
        userId: access.user.id,
        action: "LLM_MODEL_SWITCHED_AFTER_QUOTA",
        resourceType: "system_setting",
        metadata: { model, trigger: "chat_quota_fallback" },
        ...auditRequestContext(request),
      });
    } catch {
      // The setting change must remain available even if audit storage is degraded.
    }

    return NextResponse.json({ success: true, model });
  } catch (error) {
    console.error("LLM fallback switch error:", error);
    return NextResponse.json(
      { error: "Failed to switch the model in settings." },
      { status: 500 }
    );
  }
}
