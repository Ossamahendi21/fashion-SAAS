"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { LoadingGrid } from "@/components/common/loading-grid";
import { RenderCard } from "@/components/renders/render-card";
import type { Render } from "@/hooks/use-renders";
import { cn } from "@/lib/utils";

type RenderGridProps = {
  renders: Render[] | undefined;
  showOutfit?: boolean;
  /** Rendered instead of the grid when the list is loaded and empty. */
  empty?: ReactNode;
  skeletonCount?: number;
  className?: string;
};

/** Responsive tile grid for renders, including pending and failed ones. */
export function RenderGrid({ renders, showOutfit = false, empty, skeletonCount = 8, className }: RenderGridProps) {
  const reduceMotion = useReducedMotion();

  if (renders === undefined)
    return (
      <LoadingGrid
        count={skeletonCount}
        aspect="aspect-[2/3]"
        withCaption={showOutfit}
        className={cn(
          "grid-cols-2 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2 @2xl:grid-cols-3 @5xl:grid-cols-4",
          className,
        )}
      />
    );
  if (renders.length === 0) return <>{empty ?? null}</>;

  return (
    <motion.div
      layout={!reduceMotion}
      className={cn("grid grid-cols-2 gap-x-4 gap-y-8 sm:gap-x-6 @2xl:grid-cols-3 @5xl:grid-cols-4", className)}
    >
      <AnimatePresence initial={false}>
        {renders.map((render) => (
          <motion.div
            key={render._id}
            layout={!reduceMotion}
            initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.2 }}
          >
            <RenderCard render={render} showOutfit={showOutfit} />
          </motion.div>
        ))}
      </AnimatePresence>
    </motion.div>
  );
}
