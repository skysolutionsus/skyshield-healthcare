import { NextResponse } from "next/server";
import { requireScsemStewardOrCron } from "@/lib/scsem-steward-auth";

export const runtime = "nodejs";

/** Retired legacy CIS-to-database mutation path. */
export async function POST(request: Request) {
    const access = await requireScsemStewardOrCron(request);
    if (!access.ok) return access.response;

    return NextResponse.json({
        error:
            "Legacy SCSEM benchmark synchronization is retired. Use the exact-source SCSEM Updater, " +
            "which records pinned CIS WorkBench workbook evidence and requires per-change review.",
        code: "LEGACY_SCSEM_SYNC_RETIRED",
    }, { status: 410 });
}
