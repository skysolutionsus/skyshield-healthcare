import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export async function GET() {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey || apiKey === "sk-ant-placeholder") {
        return NextResponse.json({ status: "no_key", error: "ANTHROPIC_API_KEY not set or is placeholder" });
    }

    try {
        const anthropic = new Anthropic({ apiKey });
        const response = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 50,
            messages: [{ role: "user", content: "Say 'OK' and nothing else." }],
        });

        const text = response.content[0].type === "text" ? response.content[0].text : "(no text)";
        return NextResponse.json({ status: "ok", response: text, model: response.model });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return NextResponse.json({ status: "error", error: msg }, { status: 500 });
    }
}
