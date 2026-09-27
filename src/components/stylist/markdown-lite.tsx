import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
const BULLET = /^\s*[-*•]\s+/;
const ORDERED = /^\s*(\d+)[.)]\s+/;

/**
 * The stylist replies in short prose, so the chat needs paragraphs, bullets and a little emphasis —
 * not a markdown engine. Everything is rendered as React nodes; no HTML is ever injected.
 */
export function MarkdownLite({ text, className }: { text: string; className?: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className={cn("space-y-2 text-sm leading-relaxed", className)}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { block: string }) {
  const lines = block.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  if (lines.every((line) => BULLET.test(line))) {
    return (
      <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground">
        {lines.map((line, index) => (
          <li key={index}>{inline(line.replace(BULLET, ""))}</li>
        ))}
      </ul>
    );
  }

  if (lines.every((line) => ORDERED.test(line))) {
    return (
      <ol className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">
        {lines.map((line, index) => (
          <li key={index}>{inline(line.replace(ORDERED, ""))}</li>
        ))}
      </ol>
    );
  }

  return (
    <p className="text-pretty">
      {lines.map((line, index) => (
        <Fragment key={index}>
          {index > 0 ? <br /> : null}
          {inline(line)}
        </Fragment>
      ))}
    </p>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((token, index) => {
    if (!token) return null;
    if (token.startsWith("**") && token.endsWith("**")) return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("__") && token.endsWith("__")) return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("`") && token.endsWith("`")) {
      return (
        <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>
      );
    }
    if (token.length > 2 && (token.startsWith("*") || token.startsWith("_"))) {
      return <em key={index}>{token.slice(1, -1)}</em>;
    }
    return <Fragment key={index}>{token}</Fragment>;
  });
}
