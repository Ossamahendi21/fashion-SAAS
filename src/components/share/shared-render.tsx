import Link from "next/link";
import { ItemImage } from "@/components/common/item-image";
import { OutfitCollage } from "@/components/common/outfit-collage";
import { formatDate, pluralize } from "@/lib/format";
import { routes } from "@/lib/routes";
import type { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

export type SharedRenderPayload = NonNullable<FunctionReturnType<typeof api.renders.getShared>>;

/**
 * The public render page. Deliberately free of the app shell: no sidebar, no auth,
 * nothing that needs a Convex subscription.
 */
export function SharedRender({ shared }: { shared: SharedRenderPayload }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
      <header className="space-y-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Fitcheck</p>
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{shared.outfitName}</h1>
        <p className="text-sm text-muted-foreground">{formatDate(shared.createdAt)}</p>
      </header>

      <ItemImage
        src={shared.url}
        alt={shared.outfitName}
        variant="render"
        priority
        className="w-full rounded-2xl ring-1 ring-foreground/10"
      />

      {shared.items.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">
            In this look
            <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
              {pluralize(shared.items.length, "piece")}
            </span>
          </h2>
          <OutfitCollage items={shared.items} tile="size-14" max={8} className="flex-wrap" />
        </section>
      ) : null}

      <footer className="mt-auto border-t pt-6 text-sm text-muted-foreground">
        Made with{" "}
        <Link href={routes.home} className="font-medium text-foreground underline underline-offset-4">
          Fitcheck
        </Link>{" "}
        — photograph your clothes, build outfits, see yourself wearing them.
      </footer>
    </main>
  );
}
