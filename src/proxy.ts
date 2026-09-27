import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Clerk 7 keeps auth context in the proxy but gates access per resource: every signed-in page and
 * layout calls `requireSignedIn()` (src/lib/auth.ts) and every Convex function calls `requireUser`.
 * Public routes (landing, sign-in/up, /share, eve) simply don't call it; eve verifies its own bearer tokens.
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
