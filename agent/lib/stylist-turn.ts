import type { FunctionReturnType } from "convex/server";
import { defineTool } from "eve/tools";
import type { SessionContext } from "eve/tools";
import type { ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
import { RENDER_QUALITIES } from "../../convex/shared/credits";
import type { Formality } from "../../convex/shared/wardrobe";
import { api, convex, convexErrorMessage, serviceArgs, type Id } from "./convex";
import { runStylistTurn, turnNeedsApproval, type StylistPorts, type StylistTurnResult } from "./stylist-orchestrator";
import { mergeStylistTurn, type StylistDateRef, type StylistTurnInput } from "./stylist-plan";
import { formatStylistResponse, responseOutcomeFromTurn } from "./stylist-response";
import type { OutfitSlot, WardrobeItem } from "./stylist-rank";
import { readStylistState, writeStylistState } from "./stylist-session-state";
import { samePrincipal } from "./session-auth";
import type { StylistThreadState } from "./stylist-state";
import { fetchWeatherFacts } from "./stylist-weather";
import { resolveThreadId } from "./threads";

/**
 * Step 7 Phase C4 — the single high-level stylist capability.
 *
 * One `stylist_turn` tool wraps the pure orchestrator: it reads the durable session state, runs the
 * turn through the real ports, writes the new state back, and returns a compact result. Its approval
 * policy is conditional — a `render` turn that resolved a referent quotes first and only then asks
 * the human, while every other turn answers "not-applicable" so no approval card appears.
 *
 * This file is intentionally NOT under `agent/tools/`: it is a latent seam for C5, not a change to
 * the live tool surface, so it is exported by name and imported nowhere yet.
 */

export type StylistTurnOutput = {
  kind: StylistTurnResult["kind"];
  stage: StylistThreadState["stage"];
  summary: string;
  /**
   * The trusted user-facing reply produced by the deterministic formatter from the real outcome.
   * Exposed so a transport layer can echo the exact trusted text without re-running the turn (which
   * would duplicate its side effects). It is never derived from model or user input.
   */
  response: string;
};

const REFERENT_PERIODS = ["today", "tonight", "tomorrow", "dayAfterTomorrow", "weekend"] as const;

const dateRefSchema = z.union([
  z.object({ kind: z.literal("absolute"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ kind: z.literal("relative"), period: z.enum(REFERENT_PERIODS) }),
  z.object({ kind: z.literal("weekday"), weekday: z.number().int().min(0).max(6) }),
]);

const referentSchema = z.union([
  z.object({ kind: z.literal("current") }),
  z.object({ kind: z.literal("ordinal"), position: z.number().int().min(1) }),
]);

export const stylistTurnInputSchema = z.object({
  turn: z.object({
    intent: z.enum(["recommend", "refine", "render", "save", "price", "gaps", "chat"]).optional(),
    brief: z.string().nullable().optional(),
    occasion: z.string().nullable().optional(),
    formality: z.string().nullable().optional(),
    place: z.string().nullable().optional(),
    date: dateRefSchema.nullable().optional(),
    requestedCount: z.number().int().optional(),
    warmthShift: z.number().int().optional(),
    colourFocus: z.array(z.string()).optional(),
    avoidColours: z.array(z.string()).optional(),
    referent: referentSchema.optional(),
    text: z.string().optional(),
  }),
  quality: z.enum(RENDER_QUALITIES).optional(),
  perOutfit: z.number().int().min(1).max(4).optional(),
});

type Input = z.infer<typeof stylistTurnInputSchema>;

export default defineTool({
  description:
    "Run one stylist turn: recommend or refine outfits, price or render one, save it, or report " +
    "wardrobe gaps. Pass the normalised turn; the tool keeps the conversation's state itself. A " +
    "render turn is quoted and approved before anything is spent.",
  inputSchema: stylistTurnInputSchema,
  label: {
    start: () => "Working out your look",
    complete: (_input, output: StylistTurnOutput) => output.summary,
  },
  approval: {
    async request(ctx): Promise<ApprovalStatus> {
      const input = ctx.toolInput;
      if (!input) return { type: "denied", reason: "The stylist turn was missing its arguments." };

      const state = readStylistState();
      const turn = input.turn as StylistTurnInput;
      if (!turnNeedsApproval(state, turn)) return "not-applicable";

      const outfitId = referentOutfitId(state, turn);
      if (!outfitId) return "not-applicable";

      try {
        const { blockers } = await buildPorts(ctx).quoteRenders({
          outfitIds: [outfitId],
          perOutfit: input.perOutfit ?? 1,
          quality: input.quality ?? "standard",
        });
        const [blocker] = blockers;
        if (blocker) return { type: "denied", reason: blocker };
      } catch (error) {
        return { type: "denied", reason: convexErrorMessage(error).message };
      }

      return "user-approval";
    },
    response({ responder, session }) {
      return samePrincipal(responder, session.initiator)
        ? { status: "allowed" }
        : { status: "rejected", reason: "Only the owner of this conversation can approve its renders." };
    },
  },
  async execute(input: Input, ctx): Promise<StylistTurnOutput> {
    const result = await runStylistTurn({
      state: readStylistState(),
      turn: input.turn as StylistTurnInput,
      now: Date.now(),
      ports: buildPorts(ctx),
      quality: input.quality,
      perOutfit: input.perOutfit,
      approved: true,
    });
    writeStylistState(result.state);
    return toStylistTurnOutput(result);
  },
});

function referentOutfitId(state: StylistThreadState, turn: StylistTurnInput): string | null {
  const plan = mergeStylistTurn(
    { turnIndex: state.turnIndex, plan: state.plan, candidates: state.candidates },
    turn,
  );
  return plan.referent?.outfitId ?? null;
}

export function toStylistTurnOutput(result: StylistTurnResult): StylistTurnOutput {
  return {
    kind: result.kind,
    stage: result.state.stage,
    summary: describe(result),
    response: formatStylistResponse(responseOutcomeFromTurn(result)),
  };
}

function describe(result: StylistTurnResult): string {
  switch (result.kind) {
    case "clarification":
      return `Asking about the ${result.clarification.field} before continuing.`;
    case "recommendation":
      return `Proposed ${result.candidates.length} ${result.candidates.length === 1 ? "outfit" : "outfits"}.`;
    case "gap":
      return result.gap.message;
    case "composeFailed":
      return `Could not save a proposal: ${result.problems.join(" ")}`.trim();
    case "quote":
      return `That would cost ${result.credits} credits (${result.available} available).`;
    case "approvalRequired":
      return `Waiting for approval to render (${result.quote.credits} credits).`;
    case "renderBlocked":
      return result.blockers.join(" ");
    case "renderStarted":
      return "Render started.";
    case "saved":
      return "Outfit saved.";
    case "gaps":
      return result.report.gaps.length === 0 ? "No obvious gaps." : `Found ${result.report.gaps.length} gaps.`;
    case "chat":
    default:
      return "Nothing to change.";
  }
}

function buildPorts(ctx: SessionContext): StylistPorts {
  return {
    async listReadyItems() {
      const items = await convex().query(api.agent.getWardrobe, serviceArgs(ctx));
      return items.map(toWardrobeItem);
    },
    async fetchWeather(place, date) {
      return fetchWeatherFacts(place, resolveDateRef(date));
    },
    async composeOutfits(request) {
      const threadId = await resolveThreadId(ctx);
      const results = await convex().mutation(api.agent.composeOutfits, {
        ...serviceArgs(ctx),
        threadId,
        brief: request.brief,
        outfits: request.outfits.map((outfit) => ({
          name: outfit.name,
          reasoning: outfit.reasoning,
          slots: toSlotPayload(outfit.slots),
        })),
      });
      return results.map((result) => ({ outfitId: result.outfitId, name: result.name, problems: result.problems }));
    },
    async quoteRenders(request) {
      await convex().action(api.subscriptions.refreshForAgent, serviceArgs(ctx));
      const quote = await convex().query(api.agent.quoteRenders, {
        ...serviceArgs(ctx),
        outfitIds: request.outfitIds as Id<"outfits">[],
        perOutfit: request.perOutfit,
        quality: request.quality,
      });
      return {
        credits: quote.credits,
        available: quote.available,
        shortfall: quote.shortfall,
        canAfford: quote.canAfford,
        blockers: quote.blockers,
      };
    },
    async startRenders(request) {
      await convex().action(api.subscriptions.refreshForAgent, serviceArgs(ctx));
      const threadId = await resolveThreadId(ctx);
      const { jobId } = await convex().mutation(api.agent.startRenders, {
        ...serviceArgs(ctx),
        threadId,
        outfitIds: request.outfitIds as Id<"outfits">[],
        perOutfit: request.perOutfit,
        quality: request.quality,
      });
      return { jobId };
    },
    async saveOutfit(outfitId) {
      await convex().mutation(api.agent.saveOutfit, {
        ...serviceArgs(ctx),
        outfitId: outfitId as Id<"outfits">,
      });
    },
    async gapAnalysis() {
      const report = await convex().query(api.agent.gapAnalysis, serviceArgs(ctx));
      return { totalItems: report.totalItems, gaps: report.gaps };
    },
  };
}

function toSlotPayload(slots: OutfitSlot): {
  outerwear?: Id<"items">;
  top?: Id<"items">;
  bottom?: Id<"items">;
  dress?: Id<"items">;
  shoes?: Id<"items">;
  accessories: Id<"items">[];
} {
  return {
    ...(slots.outerwear ? { outerwear: slots.outerwear as Id<"items"> } : {}),
    ...(slots.top ? { top: slots.top as Id<"items"> } : {}),
    ...(slots.bottom ? { bottom: slots.bottom as Id<"items"> } : {}),
    ...(slots.dress ? { dress: slots.dress as Id<"items"> } : {}),
    ...(slots.shoes ? { shoes: slots.shoes as Id<"items"> } : {}),
    accessories: (slots.accessories ?? []).map((id) => id as Id<"items">),
  };
}

type WardrobeRow = FunctionReturnType<typeof api.agent.getWardrobe>[number];

function toWardrobeItem(item: WardrobeRow): WardrobeItem {
  const [primary, ...secondary] = item.colours;
  return {
    id: item.id,
    name: item.name,
    status: "ready",
    category: item.category,
    ...(item.subcategory ? { subcategory: item.subcategory } : {}),
    colours: { primary: primary ?? "", secondary, hex: [] },
    season: item.season,
    ...(isFormality(item.formality) ? { formality: item.formality } : {}),
    wearCount: item.wearCount,
    ...(item.lastWornAt !== undefined ? { lastWornAt: item.lastWornAt } : {}),
  };
}

function isFormality(value: string): value is Formality {
  return (["casual", "smart-casual", "formal"] as readonly string[]).includes(value);
}

function resolveDateRef(ref: StylistDateRef, now: Date = new Date()): string {
  if (ref.kind === "absolute") return ref.date;

  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (ref.kind === "weekday") {
    base.setUTCDate(base.getUTCDate() + ((ref.weekday - base.getUTCDay() + 7) % 7));
    return isoDate(base);
  }

  switch (ref.period) {
    case "today":
    case "tonight":
      return isoDate(base);
    case "tomorrow":
      base.setUTCDate(base.getUTCDate() + 1);
      return isoDate(base);
    case "dayAfterTomorrow":
      base.setUTCDate(base.getUTCDate() + 2);
      return isoDate(base);
    case "weekend":
      base.setUTCDate(base.getUTCDate() + ((6 - base.getUTCDay() + 7) % 7));
      return isoDate(base);
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}