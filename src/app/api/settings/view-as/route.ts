import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { cookies } from "next/headers";

const VIEW_AS_COOKIE = "skyshield-view-as";

// POST /api/settings/view-as — Set "view as" user (admin-only)
export async function POST(request: NextRequest) {
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

        const { userId } = await request.json();

        if (!userId) {
            return NextResponse.json(
                { error: "userId is required" },
                { status: 400 }
            );
        }

        // Verify the target user exists and is in the same org
        const targetUser = await db.user.findFirst({
            where: {
                id: userId,
                organizationId: userInfo.organizationId,
            },
            select: { id: true, name: true, role: true },
        });

        if (!targetUser) {
            return NextResponse.json(
                { error: "User not found" },
                { status: 404 }
            );
        }

        // Set the view-as cookie
        const cookieStore = await cookies();
        cookieStore.set(VIEW_AS_COOKIE, userId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 60 * 60, // 1 hour
            path: "/",
        });

        // Audit log
        try {
            await logAudit({
                organizationId: userInfo.organizationId,
                userId: userInfo.id,
                action: "VIEW_AS_STARTED",
                resourceType: "user",
                resourceId: userId,
                metadata: {
                    targetUserName: targetUser.name,
                    targetUserRole: targetUser.role,
                },
                ipAddress:
                    request.headers.get("x-forwarded-for") ||
                    request.headers.get("x-real-ip") ||
                    undefined,
                userAgent: request.headers.get("user-agent") || undefined,
            });
        } catch {
            // ignore
        }

        return NextResponse.json({
            success: true,
            viewingAs: {
                id: targetUser.id,
                name: targetUser.name,
                role: targetUser.role,
            },
        });
    } catch (error) {
        console.error("View-as POST error:", error);
        return NextResponse.json(
            { error: "Failed to set view-as" },
            { status: 500 }
        );
    }
}

// DELETE /api/settings/view-as — Clear "view as" (admin-only)
export async function DELETE(request: NextRequest) {
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

        const cookieStore = await cookies();
        cookieStore.delete(VIEW_AS_COOKIE);

        // Audit log
        try {
            await logAudit({
                organizationId: userInfo.organizationId,
                userId: userInfo.id,
                action: "VIEW_AS_ENDED",
                resourceType: "user",
                ipAddress:
                    request.headers.get("x-forwarded-for") ||
                    request.headers.get("x-real-ip") ||
                    undefined,
                userAgent: request.headers.get("user-agent") || undefined,
            });
        } catch {
            // ignore
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("View-as DELETE error:", error);
        return NextResponse.json(
            { error: "Failed to clear view-as" },
            { status: 500 }
        );
    }
}

// GET /api/settings/view-as — Get current view-as status
export async function GET() {
    try {
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const userInfo = session.user as unknown as {
            role: string;
            organizationId: string;
        };

        if (userInfo.role !== "ADMIN") {
            return NextResponse.json({ viewingAs: null });
        }

        const cookieStore = await cookies();
        const viewAsUserId = cookieStore.get(VIEW_AS_COOKIE)?.value;

        if (!viewAsUserId) {
            return NextResponse.json({ viewingAs: null });
        }

        const targetUser = await db.user.findFirst({
            where: {
                id: viewAsUserId,
                organizationId: userInfo.organizationId,
            },
            select: { id: true, name: true, email: true, role: true },
        });

        if (!targetUser) {
            // Invalid cookie, clear it
            cookieStore.delete(VIEW_AS_COOKIE);
            return NextResponse.json({ viewingAs: null });
        }

        return NextResponse.json({ viewingAs: targetUser });
    } catch (error) {
        console.error("View-as GET error:", error);
        return NextResponse.json({ viewingAs: null });
    }
}
