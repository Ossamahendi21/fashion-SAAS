"use client";

import { UserButton } from "@clerk/nextjs";
import { Settings, Sparkles } from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useStylistPanel } from "@/components/stylist/stylist-provider";
import { CreditBadge } from "@/components/common/credit-badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrentUser } from "@/hooks/use-current-user";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { ActivityPopover } from "./activity-popover";
import { isActivePath, PRIMARY_NAV, SECONDARY_NAV } from "./nav-items";
import { ThemeToggle } from "./theme-toggle";

export function Topbar() {
  const pathname = usePathname();
  const { open, toggle } = useStylistPanel();
  const { user } = useCurrentUser();
  const onboarded = Boolean(user?.onboardedAt);

  return (
    <header className="sticky top-0 z-30 border-b border-foreground/10 bg-background/95 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1520px] items-center gap-2 px-4 sm:h-[72px] sm:gap-4 sm:px-8 lg:px-12">
        <Link
          href={routes.wardrobe}
          aria-label="Fitcheck home"
          className="flex min-h-11 shrink-0 items-center gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 sm:gap-2.5"
        >
          <svg viewBox="0 0 28 28" fill="none" className="size-6 sm:size-7" aria-hidden="true">
            <path d="M9 2H2v7M19 2h7v7M26 19v7h-7M9 26H2v-7" stroke="currentColor" strokeWidth="2" />
            <path d="m8 14 4 4 8-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square" />
          </svg>
          <span className="text-[23px] leading-none font-bold tracking-[-0.065em] max-[359px]:hidden sm:text-[27px]">
            fitcheck<span className="text-muted-foreground">.</span>
          </span>
        </Link>
        {onboarded ? (
          <nav aria-label="Main navigation" className="ml-auto hidden h-full items-center gap-4 lg:flex xl:gap-6">
            {PRIMARY_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                prefetch
                aria-current={isActivePath(pathname, item.href) ? "page" : undefined}
                className={cn(
                  "relative flex h-full items-center text-[13px] font-medium whitespace-nowrap transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4",
                  isActivePath(pathname, item.href)
                    ? "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-foreground"
                    : "text-muted-foreground",
                )}
              >
                {item.label}
                <NavigationPending />
              </Link>
            ))}
          </nav>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center sm:gap-1 lg:ml-2">
          {onboarded ? (
            <Button
              onClick={toggle}
              aria-label="Ask stylist"
              aria-expanded={open}
              aria-controls="stylist-panel"
              className="size-11 rounded-full p-0 text-xs sm:mr-1 sm:h-9 sm:w-auto sm:px-4"
            >
              <Sparkles className="size-3.5" />
              <span className="hidden sm:inline">Ask stylist</span>
            </Button>
          ) : null}
          <CreditBadge className="h-8 border border-border bg-transparent px-2 sm:mr-1 sm:px-3" />
          <ActivityPopover />
          <span className="hidden sm:contents">
            <ThemeToggle />
          </span>
          {onboarded ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon" aria-label="Account settings" className="hidden sm:inline-flex" />
                }
              >
                <Settings className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44 p-2">
                {SECONDARY_NAV.filter((item) => !item.adminOnly || user?.role === "admin").map((item) => (
                  <DropdownMenuItem key={item.href} render={<Link href={item.href} />} className="h-10 gap-3">
                    <item.icon />
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <div className="flex items-center sm:ml-1 sm:border-l sm:border-border sm:pl-2">
            <UserButton
              appearance={{ elements: { avatarBox: "size-8", userButtonTrigger: "size-11 justify-center sm:size-8" } }}
            >
              <UserButton.MenuItems>
                {onboarded
                  ? SECONDARY_NAV.filter((item) => !item.adminOnly || user?.role === "admin").map((item) => (
                      <UserButton.Link
                        key={item.href}
                        label={item.label}
                        href={item.href}
                        labelIcon={<item.icon className="size-4" />}
                      />
                    ))
                  : null}
              </UserButton.MenuItems>
            </UserButton>
          </div>
        </div>
      </div>
      {onboarded ? (
        <nav
          aria-label="Mobile navigation"
          className="flex [scrollbar-width:none] overflow-x-auto border-t border-border/60 px-3 lg:hidden [&::-webkit-scrollbar]:hidden"
        >
          {PRIMARY_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch
              aria-current={isActivePath(pathname, item.href) ? "page" : undefined}
              className={cn(
                "relative flex min-h-11 flex-1 items-center justify-center gap-1.5 border-b-2 px-2 text-[11px] font-medium whitespace-nowrap sm:min-h-12 sm:px-2.5 sm:text-xs",
                isActivePath(pathname, item.href)
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground",
              )}
            >
              <item.icon className="hidden size-3.5 sm:block" aria-hidden />
              {item.label}
              <NavigationPending />
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}

function NavigationPending() {
  const { pending } = useLinkStatus();
  return pending ? (
    <span
      className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 bg-background px-1"
      role="status"
      aria-label="Opening page"
    >
      <Spinner className="size-3" />
    </span>
  ) : null;
}
