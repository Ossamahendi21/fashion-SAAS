import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { formatCredits } from "@/lib/format";
import { routes } from "@/lib/routes";
import { PLANS } from "@convex/shared/credits";

const LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#credits", label: "Credits" },
  { href: "#pricing", label: "Pricing" },
  { href: routes.signIn, label: "Sign in" },
] as const;

export function SiteFooter() {
  return (
    <footer className="overflow-hidden bg-foreground text-background">
      <div className="landing-shell pt-14 sm:pt-20">
        <div className="flex flex-col justify-between gap-8 pb-14 md:flex-row md:items-end md:pb-20">
          <h2 className="landing-display max-w-[12ch] text-[clamp(2.75rem,5.3vw,5.5rem)] leading-[0.98] tracking-[-0.055em]">
            Your next look
            <br />
            is already yours.
          </h2>
          <div className="flex flex-col items-start md:items-end">
            <Link
              href={routes.signUp}
              className="group inline-flex min-h-14 items-center justify-between gap-8 rounded-full bg-background py-2 pr-2 pl-6 text-sm font-medium text-foreground transition-colors hover:bg-background/85 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-background"
            >
              Get dressed differently
              <span className="flex size-10 items-center justify-center rounded-full border border-foreground/25">
                <ArrowUpRight aria-hidden className="size-5" />
              </span>
            </Link>
            <p className="mt-4 text-xs text-background/65">
              {formatCredits(PLANS.free.signupCredits)} to make your first move.
            </p>
          </div>
        </div>
        <div className="flex flex-col justify-between gap-5 border-t border-background/25 pt-6 sm:flex-row sm:items-center">
          <p className="font-mono text-[10px] tracking-[0.13em] text-background/65 uppercase">
            Same wardrobe. New possibilities.
          </p>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-3 text-xs">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-background/80 transition-colors hover:text-background focus-visible:outline-2 focus-visible:outline-offset-4"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <p
          aria-label="Fitcheck"
          className="landing-display mt-10 -ml-[0.055em] pb-[0.06em] text-[clamp(3.5rem,20.6vw,20rem)] leading-[0.83] font-semibold tracking-[-0.08em] sm:mt-14"
        >
          fitcheck.
        </p>
      </div>
    </footer>
  );
}
