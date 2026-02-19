import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const MODELS_TO_TRY = [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
    "claude-sonnet-4-6-20250929",
    "claude-opus-4-6-20250929",
];

export async function GET() {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey || apiKey === "sk-ant-placeholder") {
        return NextResponse.json({ status: "no_key", error: "ANTHROPIC_API_KEY not set" });
    }

    const anthropic = new Anthropic({ apiKey });
    const results: Record<string, string> = {};

    for (const model of MODELS_TO_TRY) {
        try {
            const response = await anthropic.messages.create({
                model,
                max_tokens: 10,
                messages: [{ role: "user", content: "Say OK" }],
            });
            const text = response.content[0].type === "text" ? response.content[0].text : "(no text)";
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
