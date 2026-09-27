import { auth } from "@clerk/nextjs/server";
import { fetchQuery } from "convex/nextjs";
import { notFound } from "next/navigation";
import { api } from "@convex/_generated/api";

/**
 * Resource-level protection for every signed-in page and layout (Clerk 7 guidance: the proxy no
 * longer gates routes by path). Redirects to sign-in when there is no session.
 */
export async function requireSignedIn(): Promise<void> {
  await auth.protect();
}

/**
 * Admin-only pages. The role lives in Convex, not in the Clerk session, so this asks Convex with the
 * user's own token and hides the route otherwise. Every admin function re-checks on the server; this
 * only stops the page itself from rendering for everyone else.
 */
export async function requireAdminPage(): Promise<void> {
  const session = await auth.protect();
  const token = await session.getToken({ template: "convex" });
  const me = token ? await fetchQuery(api.users.me, {}, { token }) : null;
  if (me?.role !== "admin") notFound();
}
