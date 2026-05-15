import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import {
    getConfiguredBifrostModel,
    hasConfiguredBifrostApiKey,
    isLikelyBifrostVirtualKey,
    maskSecret,
    normalizeBifrostModel,
} from "@/lib/ai/bifrost";

// GET /api/settings/llm — Returns current LLM configuration (admin-only)
export async function GET() {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const userInfo = session.user as unknown as {
            id: string;
            role: string;
            organizationId: string;
        };

        if (userInfo.role !== "ADMIN") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const settings = await db.systemSetting.findMany({
            where: {
                key: { in: ["llm_model", "llm_api_key"] },
            },
        });

        const settingsMap: Record<string, string> = {};
        let storedApiKey = "";
        for (const s of settings) {
            if (s.key === "llm_api_key") {
                storedApiKey = s.value;
            } else {
                settingsMap[s.key] = s.value;
            }
        }

        const hasStoredBifrostKey =
            isLikelyBifrostVirtualKey(storedApiKey) && hasConfiguredBifrostApiKey(storedApiKey);
        const hasEnvKey = hasConfiguredBifrostApiKey(process.env.BIFROST_API_KEY);

        return NextResponse.json({
            model: normalizeBifrostModel(settingsMap["llm_model"] || getConfiguredBifrostModel("BIFROST_MODEL")),
            apiKeyMasked: hasStoredBifrostKey ? maskSecret(storedApiKey) : hasEnvKey ? "server env" : "",
            hasApiKey: hasStoredBifrostKey || hasEnvKey,
            legacyKeyIgnored: Boolean(storedApiKey && !hasStoredBifrostKey),
        });
    } catch (error) {
        console.error("LLM settings GET error:", error);
        return NextResponse.json(
            { error: "Failed to fetch settings" },
            { status: 500 }
        );
    }
}

// PUT /api/settings/llm — Update LLM configuration (admin-only)
export async function PUT(request: NextRequest) {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const userInfo = session.user as unknown as {
            id: string;
            role: string;
            organizationId: string;
        };

        if (userInfo.role !== "ADMIN") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const body = await request.json();
        const { model, apiKey } = body;

        const updates: Array<{ key: string; value: string }> = [];

        if (model !== undefined && typeof model === "string") {
            updates.push({ key: "llm_model", value: normalizeBifrostModel(model) });
        }

        if (apiKey !== undefined && typeof apiKey === "string" && apiKey.trim()) {
            if (!isLikelyBifrostVirtualKey(apiKey) || !hasConfiguredBifrostApiKey(apiKey)) {
                return NextResponse.json(
                    { error: "Enter a Bifrost virtual key beginning with sk-bf-." },
                    { status: 400 }
                );
            }
            updates.push({ key: "llm_api_key", value: apiKey.trim() });
        }

        if (updates.length === 0) {
            return NextResponse.json(
                { error: "No valid settings provided" },
                { status: 400 }
            );
        }

        // Upsert each setting
        for (const { key, value } of updates) {
            await db.systemSetting.upsert({
                where: { key },
                create: { key, value, updatedBy: userInfo.id },
                update: { value, updatedBy: userInfo.id },
            });
        }

        // Audit log
        try {
            await logAudit({
                organizationId: userInfo.organizationId,
                userId: userInfo.id,
                action: "LLM_SETTINGS_UPDATED",
                resourceType: "system_setting",
                metadata: {
                    updatedKeys: updates.map((u) => u.key),
                    model: model || undefined,
                    // Never log the API key itself
                },
                ipAddress:
                    request.headers.get("x-forwarded-for") ||
                    request.headers.get("x-real-ip") ||
                    undefined,
                userAgent: request.headers.get("user-agent") || undefined,
            });
        } catch {
            // ignore audit failure
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("LLM settings PUT error:", error);
        return NextResponse.json(
            { error: "Failed to update settings" },
            { status: 500 }
        );
    }
}
