import { auth } from "@/lib/auth";
import { canAccessPath } from "@/lib/roles";
import { NextResponse } from "next/server";

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Public paths
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/health") ||
    pathname === "/"
  ) {
    return NextResponse.next();
  }

  if (
    pathname.startsWith("/api/scsems/sync") &&
    req.headers.has("authorization")
  ) {
    return NextResponse.next();
  }

  // Check auth for protected routes
  if (!req.auth) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const role = (req.auth.user as { role?: string } | undefined)?.role;
  const mfaEnabled = Boolean(
    (req.auth.user as { mfaEnabled?: boolean } | undefined)?.mfaEnabled
  );

  if (
    !mfaEnabled &&
    !pathname.startsWith("/settings") &&
    !pathname.startsWith("/api/mfa")
  ) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "MFA enrollment required" },
        { status: 403 }
      );
    }

    const setupUrl = new URL("/settings", req.url);
    setupUrl.searchParams.set("mfa", "setup");
    return NextResponse.redirect(setupUrl);
  }

  if (!canAccessPath(role, pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  // Add security headers
  const response = NextResponse.next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  return response;
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|public/|.*\\.png$|.*\\.jpg$|.*\\.jpeg$|.*\\.svg$|.*\\.ico$|.*\\.webp$|.*\\.gif$).*)",
  ],
};
