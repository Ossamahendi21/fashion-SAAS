import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { appError } from "./lib/errors";
import { assertFreshBilling, getBalance, hasCurrentFeature, reconcileSubscription as reconcile } from "./model/credits";
import { getByClerkId, upsertFromProfile } from "./model/users";
import { extractionCreditCost, LIMITS, renderCreditCost } from "./shared/credits";
import { vFeature, vPlanId, vRenderQuality } from "./shared/validators";
import { vBalance } from "./users";
import { vPaginated } from "./views";

export const balance = query({
  args: {},
  returns: vBalance,
  handler: async (ctx) => getBalance(await requireUser(ctx)),
});

/** Why a quote cannot be spent. `feature_locked` mirrors the gate `renders.start` applies. */
export const vQuoteReason = v.union(v.literal("balance"), v.literal("daily_cap"), v.literal("feature_locked"));

export const vQuote = v.object({
  credits: v.number(),
  available: v.number(),
  shortfall: v.number(),
  canAfford: v.boolean(),
  reason: v.optional(vQuoteReason),
});

/**
 * How many credits an action would cost against the current balance and daily cap.
 * Applies the same gates as `renders.start` so the UI never offers a request the mutation refuses.
 */
export const quote = query({
  args: {
    request: v.union(
      v.object({
        kind: v.literal("render"),
        quality: vRenderQuality,
        count: v.number(),
        outfits: v.optional(v.number()),
      }),
      v.object({ kind: v.literal("extract"), items: v.number() }),
    ),
  },
  returns: vQuote,
  handler: async (ctx, { request }) => {
    const user = await requireUser(ctx);
    const { total, dailyRemaining } = getBalance(user);

    if (request.kind === "render") {
      if (request.count < 1 || request.count > LIMITS.maxRendersPerRequest) {
        throw appError("INVALID_INPUT", `Choose between 1 and ${LIMITS.maxRendersPerRequest} images.`, {
          max: LIMITS.maxRendersPerRequest,
        });
      }
      if (request.quality === "hq" && !hasCurrentFeature(user, "hq_renders")) {
        const credits = renderCreditCost(request.quality, request.count, request.outfits ?? 1);
        return {
          credits,
          available: Math.min(total, dailyRemaining),
          shortfall: credits,
          canAfford: false,
          reason: "feature_locked" as const,
        };
      }
    }

    const credits =
      request.kind === "render"
        ? renderCreditCost(request.quality, request.count, request.outfits ?? 1)
        : extractionCreditCost(request.items);
    const available = Math.min(total, dailyRemaining);
    const shortfall = Math.max(0, credits - available);
    if (shortfall === 0) return { credits, available, shortfall, canAfford: true };
    const reason: Infer<typeof vQuoteReason> = credits > dailyRemaining && credits <= total ? "daily_cap" : "balance";
    return { credits, available, shortfall, canAfford: false, reason };
  },
});

export const reconcileSubscription = internalMutation({
  args: {
    clerkUserId: v.string(),
    readStartedAt: v.number(),
    plan: vPlanId,
    features: v.array(vFeature),
    periodStart: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, { clerkUserId, ...snapshot }) => {
    const user = (await getByClerkId(ctx, clerkUserId)) ?? (await upsertFromProfile(ctx, { clerkId: clerkUserId }));
    return reconcile(ctx, user, snapshot);
  },
});

export const billingRefreshOwnerForJob = internalQuery({
  args: { jobId: v.id("jobs") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job || (job.status !== "queued" && job.status !== "running")) return null;
    const user = await ctx.db.get(job.userId);
    if (!user) return null;
    try {
      assertFreshBilling(user);
      return null;
    } catch {
      return user.clerkId;
    }
  },
});

/** The ledger `kind` union, mirrored from the schema so the billing table can label every line. */
export const vLedgerKind = v.union(
  v.literal("plan_grant"),
  v.literal("plan_reset"),
  v.literal("signup_bonus"),
  v.literal("topup"),
  v.literal("reserve"),
  v.literal("refund"),
  v.literal("admin"),
);

export type LedgerKind = Infer<typeof vLedgerKind>;

export const vLedgerLine = v.object({
  _id: v.id("creditLedger"),
  delta: v.number(),
  bucket: v.union(v.literal("plan"), v.literal("pack")),
  kind: vLedgerKind,
  jobId: v.optional(v.id("jobs")),
  note: v.optional(v.string()),
  balanceAfter: v.number(),
  createdAt: v.number(),
});

export const ledger = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: vPaginated(vLedgerLine),
  handler: async (ctx, { paginationOpts }) => {
    const user = await requireUser(ctx);
    const result = await ctx.db
      .query("creditLedger")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .paginate(paginationOpts);
    return {
      ...result,
      page: result.page.map((line) => ({
        _id: line._id,
        delta: line.delta,
        bucket: line.bucket,
        kind: line.kind,
        jobId: line.jobId,
        note: line.note,
        balanceAfter: line.balanceAfter,
        createdAt: line.createdAt,
      })),
    };
  },
});
