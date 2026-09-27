"use client";

import type { ReactNode } from "react";
import { StylistPanel } from "@/components/stylist/stylist-panel";
import { useStylistPanel } from "@/components/stylist/stylist-provider";
import { cn } from "@/lib/utils";
import { Topbar } from "./topbar";

export function AppFrame({ children }: { children: ReactNode }) {
  const { open } = useStylistPanel();
  return (
    <div className="studio-shell min-h-svh min-w-0 [--app-content-padding:48px] [--app-header-height:110px] sm:[--app-header-height:122px] lg:[--app-content-padding:56px] lg:[--app-header-height:73px]">
      <a
        href="#main-content"
        className="sr-only fixed top-3 left-3 z-50 rounded-full bg-primary px-5 py-3 text-primary-foreground focus:not-sr-only"
      >
        Skip to content
      </a>
      <Topbar />
      <div
        className={cn(
          "min-w-0 transition-[margin] duration-200 motion-reduce:transition-none",
          open && "xl:mr-[440px]",
        )}
      >
        <main
          id="main-content"
          className="@container mx-auto w-full max-w-[1520px] px-4 py-[calc(var(--app-content-padding)/2)] sm:px-8 lg:px-12"
        >
          {children}
        </main>
      </div>
      <StylistPanel />
    </div>
  );
}
