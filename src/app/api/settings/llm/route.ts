import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";

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
        for (const s of settings) {
            if (s.key === "llm_api_key") {
                // Mask the API key — show only last 4 characters
                settingsMap[s.key] = s.value.length > 4
                    ? "•".repeat(s.value.length - 4) + s.value.slice(-4)
                    : "••••";
            } else {
                settingsMap[s.key] = s.value;
            }
        }

        return NextResponse.json({
            model: settingsMap["llm_model"] || "",
            apiKeyMasked: settingsMap["llm_api_key"] || "",
            hasApiKey: settings.some((s) => s.key === "llm_api_key"),
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
            updates.push({ key: "llm_model", value: model });
        }

        if (apiKey !== undefined && typeof apiKey === "string" && apiKey.trim()) {
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
