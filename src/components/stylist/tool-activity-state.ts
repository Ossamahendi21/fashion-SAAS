import type { EveMessage, EveMessagePart } from "eve/react";
import { CATEGORY_LABELS, isCategory } from "../../../convex/shared/wardrobe";
import type { TranscriptPart } from "./render-transcript";

export type ActivityTool = Extract<EveMessagePart, { type: "dynamic-tool" }>;
export type ActivityState = "running" | "done" | "error" | "cancelled" | "paused" | "waiting";
export type ActivityRow = {
  key: string;
  toolName: string;
  state: ActivityState;
  label: string;
  detail: string;
  calls: number;
};

type ActivitySegment = { kind: "activity"; key: string; tools: ActivityTool[] };
type PartSegment = { kind: "part"; key: string; value: TranscriptPart };

const LABELS: Record<string, { running: string; done: string; failed: string }> = {
  get_wardrobe: { running: "Checking your wardrobe", done: "Wardrobe checked", failed: "Couldn’t check your wardrobe" },
  get_context: {
    running: "Checking your preferences",
    done: "Preferences checked",
    failed: "Couldn’t load your preferences",
  },
  get_weather: { running: "Checking the weather", done: "Forecast checked", failed: "Couldn’t check the weather" },
  gap_analysis: {
    running: "Looking for wardrobe gaps",
    done: "Wardrobe gaps checked",
    failed: "Couldn’t check wardrobe gaps",
  },
  load_skill: {
    running: "Reviewing styling guidance",
    done: "Styling guidance reviewed",
    failed: "Couldn’t load styling guidance",
  },
  quote_renders: {
    running: "Checking the credit cost",
    done: "Credit cost checked",
    failed: "Couldn’t check the credit cost",
  },
  compose_outfits: {
    running: "Putting your looks together",
    done: "Looks put together",
    failed: "Couldn’t finish those looks",
  },
  start_renders: { running: "Starting your try-on", done: "Try-on started", failed: "Couldn’t start your try-on" },
  save_outfit: { running: "Saving your outfit", done: "Outfit saved", failed: "Couldn’t save your outfit" },
  ask_question: { running: "Using your answer", done: "Answer received", failed: "Couldn’t use that answer" },
};
const FALLBACK = { running: "Working on your request", done: "Step completed", failed: "This step didn’t finish" };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function activityState(part: ActivityTool, active: boolean): ActivityState {
  if (part.state === "output-error") return "error";
  if (part.state === "output-denied") return "cancelled";
  if (part.state === "approval-requested") return "waiting";
  if (part.state === "output-available" && !part.partial) return "done";
  return active ? "running" : "paused";
}

export function activityGroupState(states: readonly ActivityState[]): ActivityState {
  return (
    (["running", "error", "waiting", "paused", "cancelled", "done"] as const).find((state) => states.includes(state)) ??
    "paused"
  );
}

function hasCard(part: ActivityTool): boolean {
  return (
    part.state === "approval-requested" ||
    (part.state === "output-available" && !part.partial && ["compose_outfits", "start_renders"].includes(part.toolName))
  );
}

/** Keep visible prose and rich cards in order; adjacent low-level steps share one activity disclosure. */
export function groupActivityParts(parts: readonly TranscriptPart[]): (ActivitySegment | PartSegment)[] {
  const groups: (ActivitySegment | PartSegment)[] = [];
  for (const [index, value] of parts.entries()) {
    const { part } = value;
    if (part.type === "text" && !part.text.trim()) continue;
    if (!["text", "dynamic-tool", "authorization"].includes(part.type)) continue;
    if (part.type === "dynamic-tool" && !hasCard(part) && !value.renderJobIds) {
      const previous = groups.at(-1);
      if (previous?.kind === "activity") previous.tools.push(part);
      else groups.push({ kind: "activity", key: part.toolCallId, tools: [part] });
    } else {
      groups.push({ kind: "part", key: part.type === "dynamic-tool" ? part.toolCallId : `part-${index}`, value });
    }
  }
  return groups;
}

/** Session activity belongs only to the latest assistant message, never to unfinished historical calls. */
export function isActiveActivityMessage(messages: readonly EveMessage[], index: number, streaming: boolean): boolean {
  return streaming && index === messages.length - 1 && messages[index]?.role === "assistant";
}

function resultDetail(part: ActivityTool): string {
  const output = part.state === "output-available" && !part.partial ? record(part.output) : {};
  if (part.toolName === "get_wardrobe") {
    const found = count(output.count);
    return found === null
      ? ""
      : found === 0
        ? "No matching pieces"
        : `${found} ${found === 1 ? "piece" : "pieces"} found`;
  }
  if (part.toolName === "gap_analysis" && Array.isArray(output.gaps)) {
    return output.gaps.length === 0 ? "No obvious gaps" : `${output.gaps.length} possible gaps`;
  }
  if (part.toolName === "get_weather") {
    if (output.found === false) return "Location not found — confirm the place in chat";
    if (Array.isArray(output.outlook)) {
      const days = output.outlook.length;
      return days === 0 ? "No forecast available for those dates" : `${days}-day forecast`;
    }
  }
  if (part.toolName === "quote_renders") {
    const credits = count(output.credits);
    return credits === null
      ? ""
      : `${credits} ${credits === 1 ? "credit" : "credits"}${Array.isArray(output.blockers) && output.blockers.length > 0 ? " · Action needed before rendering" : " · Estimate only"}`;
  }
  return "";
}

function wardrobeFilters(parts: ActivityTool[]): string {
  const categories = new Set<string>();
  for (const part of parts) {
    const category = record(part.input).category;
    if (typeof category === "string" && isCategory(category)) categories.add(CATEGORY_LABELS[category]);
  }
  return [...categories].join(", ");
}

export function summarizeActivity(tools: readonly ActivityTool[], active: boolean): ActivityRow[] {
  const byName = new Map<string, ActivityTool[]>();
  for (const tool of tools) {
    const existing = byName.get(tool.toolName);
    if (existing) existing.push(tool);
    else byName.set(tool.toolName, [tool]);
  }
  return [...byName].map(([toolName, parts]) => {
    const states = parts.map((part) => activityState(part, active));
    const state = activityGroupState(states);
    const copy = LABELS[toolName === "eve:load-skill" ? "load_skill" : toolName] ?? FALLBACK;
    const label =
      state === "done"
        ? copy.done
        : state === "error"
          ? copy.failed
          : state === "cancelled"
            ? "Cancelled"
            : state === "paused"
              ? "No result received"
              : state === "waiting"
                ? "Waiting for your answer"
                : copy.running;
    const last = parts.at(-1);
    const failed = states.filter((state) => state === "error").length;
    const cancelled = states.filter((state) => state === "cancelled").length;
    const details = [
      parts.length > 1 ? `${parts.length} ${toolName === "get_wardrobe" ? "searches" : "steps"}` : "",
      toolName === "get_wardrobe" ? wardrobeFilters(parts) : "",
      state === "error" ? "The stylist can help you try again." : "",
      failed > 0 && state !== "error" ? `${failed} failed` : "",
      cancelled > 0 && state !== "cancelled" ? `${cancelled} cancelled` : "",
      state === "paused" ? "This step stopped before a result arrived." : "",
      state === "cancelled" ? "This action was not approved." : "",
      state === "done" && last && parts.length === 1 ? resultDetail(last) : "",
    ].filter(Boolean);
    return { key: parts[0].toolCallId, toolName, state, label, detail: details.join(" · "), calls: parts.length };
  });
}

export function activityRetry(tools: readonly ActivityTool[]): { label: string; message: string } | null {
  const failed = tools.filter((part) => part.state === "output-error");
  if (failed.length === 0) return null;
  const readOnly = failed.every((part) =>
    [
      "get_wardrobe",
      "get_context",
      "get_weather",
      "gap_analysis",
      "load_skill",
      "eve:load-skill",
      "quote_renders",
    ].includes(part.toolName),
  );
  return readOnly
    ? { label: "Ask to retry", message: "Please retry the checks that failed earlier in this conversation." }
    : {
        label: "Check what happened",
        message:
          "A step failed earlier in this conversation. Please check what completed before trying again. Ask for my approval before starting any new try-ons.",
      };
}
