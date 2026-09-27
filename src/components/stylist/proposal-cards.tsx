"use client";

import { useMutation } from "convex/react";
import { ArrowUpRight, Bookmark, Check } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ItemImage } from "@/components/common/item-image";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useThreadProposals, type ThreadProposal } from "@/hooks/use-stylist";
import { reportError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { ItemSummary } from "@convex/views";

type ProposalCardsProps = {
  threadId: Id<"threads">;
  /** Outfit ids this particular `compose_outfits` call produced. */
  outfitIds: Id<"outfits">[];
  problems: { name: string; problems: string[] }[];
};

export function ProposalCards({ threadId, outfitIds, problems }: ProposalCardsProps) {
  const proposals = useThreadProposals(threadId);

  if (outfitIds.length === 0 && problems.length === 0) return null;

  if (proposals === undefined && outfitIds.length > 0) {
    return (
      <div className="grid gap-6 @min-[560px]:grid-cols-2">
        {outfitIds.map((id) => (
          <Skeleton key={id} className="aspect-[4/5] rounded-none" />
        ))}
      </div>
    );
  }

  const wanted = new Set<string>(outfitIds);
  const shown = (proposals ?? []).filter((proposal) => wanted.has(proposal.outfit._id));

  return (
    <div className="space-y-3">
      {shown.length > 0 ? (
        <div className="grid gap-x-6 gap-y-8 @min-[560px]:grid-cols-2">
          {shown.map((proposal) => (
            <ProposalCard key={proposal._id} proposal={proposal} />
          ))}
        </div>
      ) : null}

      {problems.map((problem, index) => (
        <p key={`${problem.name}-${index}`} className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{problem.name}</span> could not be saved:{" "}
          {problem.problems.join("; ")}
        </p>
      ))}
    </div>
  );
}

/**
 * Saving is a one-tap mutation (`threads.saveProposal`), not a chat message: the stylist's own
 * `save_outfit` tool does the same thing, so keeping a look never costs the user a turn.
 */
function ProposalCard({ proposal }: { proposal: ThreadProposal }) {
  const saveProposal = useMutation(api.threads.saveProposal);
  const [saving, setSaving] = useState(false);
  const saved = proposal.savedAt !== undefined;
  const slots = proposal.outfit.items;
  const pieces = [slots.outerwear, slots.dress, slots.top, slots.bottom, slots.shoes, ...slots.accessories].filter(
    (item): item is ItemSummary => Boolean(item),
  );

  async function save() {
    setSaving(true);
    try {
      await saveProposal({ outfitId: proposal.outfit._id });
      toast.success(`"${proposal.outfit.name}" is in your outfits.`);
    } catch (error) {
      reportError(error, "Could not save that outfit.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="flex min-w-0 flex-col gap-4">
      <Link
        href={routes.outfit(proposal.outfit._id)}
        aria-label={`View outfit: ${proposal.outfit.name}`}
        className={`group relative grid aspect-[5/4] gap-2 bg-muted/60 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring ${pieces.length < 3 ? "grid-cols-2" : "grid-cols-3"}`}
      >
        {pieces.slice(0, 6).map((item, index) => (
          <ItemImage
            key={item._id}
            src={item.url}
            alt={item.name}
            aspect="aspect-auto"
            className={
              pieces.length === 1
                ? "col-span-2 size-full rounded-none bg-transparent p-0 dark:bg-transparent"
                : index === 0 && pieces.length > 2
                  ? "col-span-2 row-span-2 size-full rounded-none bg-transparent p-0 dark:bg-transparent"
                  : "size-full min-h-0 rounded-none bg-transparent p-0 dark:bg-transparent"
            }
            imgClassName="transition-transform duration-200 group-hover:scale-[1.03] motion-reduce:transform-none"
          />
        ))}
        <span className="absolute right-3 bottom-3 bg-background/90 px-2 py-1 font-mono text-[9px] tracking-wide uppercase">
          {pieces.length} pieces
        </span>
      </Link>
      <div className="space-y-1.5">
        {proposal.outfit.occasion ? (
          <p className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
            {proposal.outfit.occasion}
          </p>
        ) : null}
        <h3 className="text-xl leading-tight font-medium tracking-[-0.035em]">{proposal.outfit.name}</h3>
      </div>

      {proposal.outfit.reasoning ? (
        <p className="text-xs leading-relaxed text-pretty text-muted-foreground">{proposal.outfit.reasoning}</p>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <Button
          size="sm"
          variant="link"
          className="h-9 px-0"
          nativeButton={false}
          render={<Link href={routes.outfit(proposal.outfit._id)} />}
          aria-label={`View outfit: ${proposal.outfit.name}`}
        >
          View outfit
          <ArrowUpRight data-icon="inline-end" />
        </Button>
        {saved ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Check className="size-3.5" aria-hidden />
            Saved to outfits
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-9 rounded-none px-3"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? <Spinner data-icon="inline-start" /> : <Bookmark data-icon="inline-start" />}
            Save to outfits
          </Button>
        )}
      </div>
    </article>
  );
}
