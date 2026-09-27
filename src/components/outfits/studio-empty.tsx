import type { ReactNode } from "react";

export function StudioEmpty({ title, description, action }: { title: string; description: string; action: ReactNode }) {
  return (
    <div className="flex flex-col gap-6 border-y border-foreground/15 py-10 sm:flex-row sm:items-end sm:justify-between sm:py-14">
      <div className="max-w-lg space-y-3">
        <h2 className="text-2xl font-medium tracking-[-0.04em] sm:text-3xl">{title}</h2>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
