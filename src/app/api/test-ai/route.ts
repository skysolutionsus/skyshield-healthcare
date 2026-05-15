import { NextResponse } from "next/server";
import {
    createBifrostChatCompletion,
    extractBifrostMessageText,
    getConfiguredBifrostModel,
    hasConfiguredBifrostApiKey,
    normalizeBifrostModel,
} from "@/lib/ai/bifrost";

function modelsToTry(): string[] {
    return Array.from(
        new Set([
            getConfiguredBifrostModel("BIFROST_MODEL"),
            normalizeBifrostModel("azure/claude-sonnet-4-6"),
            normalizeBifrostModel("azure/gpt-5.1-chat"),
        ])
    );
}

export async function GET() {
    const apiKey = process.env.BIFROST_API_KEY;

    if (!hasConfiguredBifrostApiKey(apiKey)) {
        return NextResponse.json({ status: "no_key", error: "BIFROST_API_KEY not set" });
    }

    const results: Record<string, string> = {};

    for (const model of modelsToTry()) {
        try {
            const response = await createBifrostChatCompletion(
                {
                    model,
                    max_tokens: 10,
                    messages: [{ role: "user", content: "Say OK" }],
                },
                { apiKey }
            );
            const text = extractBifrostMessageText(response.choices?.[0]?.message?.content) || "(no text)";
            results[model] = `OK: ${text}`;
            // Found one that works — report immediately
            return NextResponse.json({ status: "ok", working_model: model, response: text, all_results: results });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            results[model] = `ERROR: ${msg.substring(0, 100)}`;
        }
    }

    return NextResponse.json({ status: "all_failed", results }, { status: 500 });
}
