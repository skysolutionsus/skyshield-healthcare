import { NextResponse } from "next/server";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";

/** Retired legacy database detail API; the pinned-source updater is authoritative. */
export async function GET() {
    const access = await requireScsemSteward();
    if (!access.ok) return access.response;

    return NextResponse.json({
        error:
            "Legacy SCSEM database detail is retired. Use the pinned-source SCSEM Updater workflow.",
        code: "LEGACY_SCSEM_DETAIL_RETIRED",
    }, {
        status: 410,
        headers: { "Cache-Control": "private, no-store" },
    });
}
