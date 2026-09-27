import Link from "next/link";
import { routes } from "@/lib/routes";

export default function SharedRenderNotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Fitcheck</p>
      <h1 className="text-xl font-semibold tracking-tight">This link is no longer available</h1>
      <p className="text-sm text-muted-foreground">The render was deleted, or whoever shared it turned sharing off.</p>
      <Link
        href={routes.home}
        className="mt-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
      >
        See what Fitcheck does
      </Link>
    </main>
  );
}
