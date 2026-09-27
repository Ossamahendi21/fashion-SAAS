import { PricingTable } from "@clerk/nextjs";
import { SectionBoundary } from "./section-boundary";

/**
 * Clerk Billing owns upgrades, downgrades and cancellations — the table opens Clerk's
 * in-app checkout drawer; the Clerk SDK confirms the current credit allowance.
 */
export function PlansCard() {
  return (
    <section id="plans" className="scroll-mt-24 space-y-6" aria-labelledby="plans-title">
      <div className="grid gap-3 sm:grid-cols-[1fr_1.2fr] sm:items-end">
        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">Membership</p>
          <h2 id="plans-title" className="text-3xl font-medium tracking-[-0.045em]">
            A little more room to create.
          </h2>
        </div>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground sm:justify-self-end">
          Choose a monthly allowance that suits your wardrobe. Plan credits refresh each cycle. Manage your subscription
          with Clerk.
        </p>
      </div>
      <div>
        <SectionBoundary
          title="Plans are unavailable right now"
          message="Plans could not be loaded. Try again in a moment."
        >
          <PricingTable
            appearance={{
              variables: { borderRadius: "0.25rem", fontFamily: "inherit" },
              elements: { card: { boxShadow: "none" } },
            }}
            fallback={
              <div className="grid gap-4 sm:grid-cols-3" aria-busy="true" aria-label="Loading plans">
                <div className="h-56 animate-pulse rounded-xl bg-muted" />
                <div className="h-56 animate-pulse rounded-xl bg-muted" />
                <div className="h-56 animate-pulse rounded-xl bg-muted" />
              </div>
            }
          />
        </SectionBoundary>
      </div>
    </section>
  );
}
