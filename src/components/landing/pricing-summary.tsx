import { ArrowUpRight, Plus } from "lucide-react";
import Link from "next/link";
import { formatCredits, formatUsd, pluralize } from "@/lib/format";
import { routes } from "@/lib/routes";
import { PLANS, PLAN_IDS, type PlanDefinition, type PlanId } from "@convex/shared/credits";
import { LandingFaq } from "./faq";
import { FEATURE_LABELS } from "./plan-copy";

const PLAN_COPY: Record<PlanId, { introduction: string; cta: string }> = {
  free: { introduction: "Find your first new favourite.", cta: "Start free" },
  pro: { introduction: "Make it an everyday thing.", cta: "Get started with Pro" },
  plus: { introduction: "For the full picture.", cta: "Get started with Plus" },
};

function planPerks(plan: PlanDefinition): string[] {
  return [
    "Your wardrobe, outfit builder & stylist",
    pluralize(plan.maxAvatars, "personal photo"),
    ...plan.features.map((feature) => FEATURE_LABELS[feature]),
  ];
}

export function PricingSummary() {
  return (
    <section id="pricing" aria-labelledby="pricing-heading" className="landing-shell scroll-mt-24 py-16 md:py-24">
      <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
        <div>
          <p className="landing-kicker">Find your fit</p>
          <h2
            id="pricing-heading"
            className="landing-display mt-5 max-w-[12ch] text-[clamp(2.75rem,5vw,5.25rem)] leading-[0.96] tracking-[-0.055em]"
          >
            Start small.
            <br />
            Style endlessly.
          </h2>
        </div>
        <p className="max-w-xs text-sm leading-relaxed text-muted-foreground md:pb-1">
          Every plan includes your digital wardrobe, outfit builder and personal stylist. Pick the image allowance that
          works for you.
        </p>
      </div>
      <div className="mt-12 grid border-y border-foreground/20 md:grid-cols-3 md:divide-x md:divide-foreground/20">
        {PLAN_IDS.map((planId, index) => {
          const plan = PLANS[planId];
          const copy = PLAN_COPY[planId];
          const allowance = plan.monthlyCredits || plan.signupCredits;
          return (
            <article
              key={plan.id}
              aria-labelledby={`plan-${plan.id}`}
              className="flex flex-col border-b border-foreground/20 py-8 last:border-b-0 md:border-b-0 md:px-7 md:py-10 md:first:pl-0 md:last:pr-0 lg:px-10"
            >
              <div className="flex items-baseline justify-between gap-4">
                <h3 id={`plan-${plan.id}`} className="text-xl font-medium tracking-tight">
                  {plan.name}
                </h3>
                <span className="font-mono text-[10px] text-muted-foreground" aria-hidden>
                  / 0{index + 1}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{copy.introduction}</p>
              <p className="mt-8 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="landing-display text-[clamp(3.5rem,5.2vw,5rem)] leading-none tracking-[-0.075em] tabular-nums">
                  {formatUsd(plan.priceUsd)}
                </span>
                <span className="text-xs text-muted-foreground">{plan.priceUsd > 0 ? "/ month" : "to start"}</span>
              </p>
              <p className="mt-6 text-base font-medium tracking-tight">
                {formatCredits(allowance)}
                <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                  {plan.monthlyCredits ? "every cycle" : "on signup"}
                </span>
              </p>
              <ul className="mt-6 mb-10 flex flex-1 flex-col gap-3 text-sm text-muted-foreground">
                {planPerks(plan).map((perk) => (
                  <li key={perk} className="flex items-start gap-2.5">
                    <Plus aria-hidden className="mt-0.5 size-3.5 shrink-0 text-foreground/70" />
                    {perk}
                  </li>
                ))}
              </ul>
              <Link
                href={routes.signUp}
                className="group flex min-h-12 items-center justify-between gap-4 border-t border-foreground/20 pt-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-4"
              >
                {copy.cta}
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-foreground/25 transition-colors duration-200 group-hover:bg-foreground group-hover:text-background">
                  <ArrowUpRight aria-hidden className="size-4" />
                </span>
              </Link>
            </article>
          );
        })}
      </div>
      <LandingFaq />
    </section>
  );
}
