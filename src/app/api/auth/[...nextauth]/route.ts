import { handlers } from "@/lib/auth";

// Export each handler explicitly so Next.js 16 Turbopack discovers the route
// during development as well as in production builds.
export const GET = handlers.GET;
export const POST = handlers.POST;
