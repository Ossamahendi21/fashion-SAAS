import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { formatNumber } from "@/lib/format";
import { CREDIT_COSTS } from "@convex/shared/credits";

const CREDIT_ROWS = [
  {
    number: 0,
    title: "Explore every possibility.",
    detail: "Scan photos, build outfits and talk to your stylist. All free.",
  },
  {
    number: CREDIT_COSTS.extractItem,
    title: "Keep a piece. Try a look.",
    detail: "Each selected clothing cutout or standard try-on image.",
  },
  {
    number: CREDIT_COSTS.render.hq,
    title: "Get the finer details.",
    detail: "Each HQ try-on image. Available with Plus.",
  },
] as const;

export function CreditsExplainer() {
  return (
    <section id="credits" aria-labelledby="credits-heading" className="scroll-mt-24 border-y border-foreground/15">
      <div className="landing-shell grid gap-12 py-16 md:grid-cols-[0.85fr_1.15fr] md:gap-16 md:py-24">
        <div className="flex flex-col items-start">
          <p className="landing-kicker">The credit edit</p>
          <h2
            id="credits-heading"
            className="landing-display mt-5 max-w-[9ch] text-[clamp(2.75rem,5vw,5.25rem)] leading-[0.96] tracking-[-0.055em]"
          >
            Good style.
            <br />
            Clear costs.
          </h2>
          <p className="mt-6 max-w-sm text-sm leading-relaxed text-muted-foreground md:text-base">
            Only the images you create use credits. You choose the pieces, approve the cost, and see exactly where each
            credit goes.
          </p>
          <Link
            href="#pricing"
            className="mt-8 inline-flex items-center gap-3 border-b border-foreground/40 pb-2 text-sm font-medium transition-colors hover:border-foreground focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            Find your plan <ArrowUpRight aria-hidden className="size-4" />
          </Link>
        </div>
        <div>
          <dl className="border-t border-foreground/20">
            {CREDIT_ROWS.map((row) => (
              <div
                key={row.number}
                className="grid grid-cols-[5rem_1fr] gap-5 border-b border-foreground/15 py-6 sm:grid-cols-[6.5rem_1fr] sm:gap-8"
              >
                <dt className="sr-only">{row.title}</dt>
                <dd className="flex flex-col">
                  <span className="landing-display text-6xl leading-none tracking-[-0.06em] tabular-nums sm:text-7xl">
                    {formatNumber(row.number)}
                  </span>
                  <span className="mt-1 font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
                    {row.number === 1 ? "Credit" : "Credits"}
                  </span>
                </dd>
                <dd className="self-center">
                  <p aria-hidden className="text-lg font-medium tracking-tight">
                    {row.title}
                  </p>
                  <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">{row.detail}</p>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
            An image fails? Its credits come back automatically. Free scanning and stylist chat are subject to daily
            limits.
          </p>
        </div>
      </div>
    </section>
  );
}
