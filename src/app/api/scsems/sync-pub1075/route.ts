import { NextResponse } from "next/server";
import { requireScsemStewardOrCron } from "@/lib/scsem-steward-auth";

export const runtime = "nodejs";

/** Retired legacy DB-review generator; the hash-pinned updater is authoritative. */
export async function POST(request: Request) {
    const access = await requireScsemStewardOrCron(request);
    if (!access.ok) return access.response;

    return NextResponse.json({
        error:
            "Legacy Publication 1075 review generation is retired. Use the pinned-source SCSEM Updater workflow.",
        code: "LEGACY_SCSEM_REVIEW_RETIRED",
    }, { status: 410 });
}
