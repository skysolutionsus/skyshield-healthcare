import { NextResponse } from "next/server";
import { requireScsemSteward } from "@/lib/scsem-steward-auth";

export async function GET() {
    const access = await requireScsemSteward();
    if (!access.ok) return access.response;

    return NextResponse.json({
        error:
            "Legacy database reconstruction export is retired. Export only from a creator-scoped, " +
            "hash-pinned SCSEM Updater session after reviewing every proposed change.",
        code: "LEGACY_SCSEM_EXPORT_RETIRED",
    }, { status: 410 });
}
