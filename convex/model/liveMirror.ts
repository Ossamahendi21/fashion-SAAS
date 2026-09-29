import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { optionalEnv } from "../lib/env";
import { appError } from "../lib/errors";
import {
  LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_KEY,
  dayKey,
  PLANS,
  type PlanId,
} from "../shared/credits";
import { assertFreshBilling, hasCurrentPlan } from "./credits";
import {
  LIVE_MIRROR_MODEL,
  parseDailyAuthorizedSecondsCap,
  parseSessionCap,
} from "../liveMirror/decart";

export type LiveMirrorBilling = {
  plan: PlanId;
  periodStart: number;
  periodEnd: number;
};

export type LiveMirrorReservation = {
  sessionId: Id<"liveMirrorSessions">;
  userId: Id<"users">;
  sessionSeconds: number;
  model: string;
};

export type LiveMirrorStatus = {
  plan: PlanId;
  monthlyAllowanceSessions: number;
  usedSessions: number;
  remainingSessions: number;
  sessionMaxSeconds: number;
  periodEnd?: number;
};

export type LiveMirrorFinalizeOutcome = "authorized" | "provider_failed";

/**
 * Live Mirror billing gate. Paid users need fresh billing, a current plan, and Clerk-verified
 * billing-period bounds. A paid account with missing/invalid period information fails closed
 * until `subscriptions.refresh` repairs the snapshot. Free users are denied as locked.
 */
export function requireLiveMirrorBilling(user: Doc<"users">, now = Date.now()): LiveMirrorBilling {
  assertFreshBilling(user, now);
  if (!hasCurrentPlan(user, now)) {
    throw appError("FEATURE_LOCKED", "Live Mirror requires a paid plan. Upgrade in Billing to continue.");
  }
  const periodStart = user.planPeriodStart;
  const periodEnd = user.planPeriodEnd;
  if (
    periodStart === undefined ||
    periodEnd === undefined ||
    !Number.isFinite(periodStart) ||
    !Number.isFinite(periodEnd) ||
    periodStart > now ||
    periodEnd <= now
  ) {
    throw appError("SUBSCRIPTION_REFRESH_REQUIRED", "Refresh your subscription before continuing.");
  }
  return { plan: user.plan, periodStart, periodEnd };
}

export function monthlyLiveMirrorAllowance(plan: PlanId): number {
  return PLANS[plan].monthlyLiveMirrorSessions;
}

/** Sessions that still count against the current billing period. */
export async function countActiveLiveMirrorSessions(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  periodStart: number,
): Promise<number> {
  const rows = await ctx.db
    .query("liveMirrorSessions")
    .withIndex("by_user_period", (q) => q.eq("userId", userId).eq("periodStart", periodStart))
    .collect();
  return rows.filter((row) => row.status === "reserved" || row.status === "authorized").length;
}

export async function readDailyAuthorizedSeconds(
  ctx: QueryCtx | MutationCtx,
  day: string,
): Promise<number> {
  const counter = await ctx.db
    .query("systemCounters")
    .withIndex("by_day_key", (q) => q.eq("dayKey", day).eq("key", LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_KEY))
    .unique();
  return counter?.value ?? 0;
}

/**
 * Adjust the daily worst-case counter without ever letting it go negative. Rows are created
 * only for positive reservations; releases merely reduce an existing value.
 */
export async function adjustDailyAuthorizedSeconds(
  ctx: MutationCtx,
  day: string,
  delta: number,
): Promise<number> {
  const counter = await ctx.db
    .query("systemCounters")
    .withIndex("by_day_key", (q) => q.eq("dayKey", day).eq("key", LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_KEY))
    .unique();
  const next = Math.max(0, (counter?.value ?? 0) + delta);
  if (counter) {
    await ctx.db.patch(counter._id, { value: next });
  } else if (delta > 0) {
    await ctx.db.insert("systemCounters", {
      dayKey: day,
      key: LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_KEY,
      value: next,
    });
  }
  return next;
}

/** Current allowance/usage description for an already-authorized reservation period. */
async function describeReservationPeriod(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  periodStart: number,
  now: number,
): Promise<Omit<LiveMirrorStatus, "sessionMaxSeconds">> {
  const plan = hasCurrentPlan(user, now) ? user.plan : "free";
  const monthlyAllowanceSessions = monthlyLiveMirrorAllowance(plan);
  const usedSessions = await countActiveLiveMirrorSessions(ctx, user._id, periodStart);
  return {
    plan,
    monthlyAllowanceSessions,
    usedSessions,
    remainingSessions: Math.max(0, monthlyAllowanceSessions - usedSessions),
    ...(hasCurrentPlan(user, now) && user.planPeriodEnd !== undefined ? { periodEnd: user.planPeriodEnd } : {}),
  };
}

/**
 * Informational allowance status. Free/expired accounts get zeros; paid accounts need valid
 * billing-period information. This never mints a token and never calls Decart.
 */
export async function readLiveMirrorStatus(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
  now = Date.now(),
): Promise<LiveMirrorStatus> {
  if (!hasCurrentPlan(user, now)) {
    return {
      plan: "free",
      monthlyAllowanceSessions: monthlyLiveMirrorAllowance("free"),
      usedSessions: 0,
      remainingSessions: 0,
      sessionMaxSeconds: parseSessionCap(optionalEnv("LIVE_MIRROR_SESSION_MAX_SECONDS")),
    };
  }
  const billing = requireLiveMirrorBilling(user, now);
  const status = await describeReservationPeriod(ctx, user, billing.periodStart, now);
  return {
    ...status,
    sessionMaxSeconds: parseSessionCap(optionalEnv("LIVE_MIRROR_SESSION_MAX_SECONDS")),
  };
}

/**
 * Reserve one monthly session and its worst-case global seconds in a single mutation. Quota,
 * global cap, ledger insert, and counter bump happen together so concurrent reservations
 * cannot both observe the same final allowance.
 */
export async function reserveLiveMirrorUsage(
  ctx: MutationCtx,
  user: Doc<"users">,
  now = Date.now(),
): Promise<LiveMirrorReservation> {
  const billing = requireLiveMirrorBilling(user, now);
  const sessionSeconds = parseSessionCap(optionalEnv("LIVE_MIRROR_SESSION_MAX_SECONDS"));
  const monthlyAllowanceSessions = monthlyLiveMirrorAllowance(billing.plan);
  const usedSessions = await countActiveLiveMirrorSessions(ctx, user._id, billing.periodStart);
  if (usedSessions >= monthlyAllowanceSessions) {
    throw appError(
      "LIVE_MIRROR_LIMIT_REACHED",
      "You've used your Live Mirror sessions for this billing cycle.",
    );
  }

  const dailyCap = parseDailyAuthorizedSecondsCap(optionalEnv("LIVE_MIRROR_DAILY_AUTHORIZED_SECONDS_CAP"));
  const day = dayKey(now);
  const authorizedToday = await readDailyAuthorizedSeconds(ctx, day);
  if (sessionSeconds > dailyCap - authorizedToday) {
    throw appError("SPEND_KILL_SWITCH", "Live Mirror is paused for the moment. Please try again later.");
  }

  const createdAt = now;
  const sessionId = await ctx.db.insert("liveMirrorSessions", {
    userId: user._id,
    plan: billing.plan,
    periodStart: billing.periodStart,
    periodEnd: billing.periodEnd,
    authorizedSeconds: sessionSeconds,
    model: LIVE_MIRROR_MODEL,
    status: "reserved",
    createdAt,
    updatedAt: createdAt,
  });
  await adjustDailyAuthorizedSeconds(ctx, day, sessionSeconds);
  return { sessionId, userId: user._id, sessionSeconds, model: LIVE_MIRROR_MODEL };
}

/**
 * Settle a reservation. Success keeps the monthly and daily consumption. Provider failure
 * releases both exactly once: only a `reserved` row transitions, so repeats, retries, and
 * late releases cannot make usage or the global counter negative. A row that already reached
 * `authorized` is never refunded.
 */
export async function finalizeLiveMirrorSession(
  ctx: MutationCtx,
  sessionId: Id<"liveMirrorSessions">,
  outcome: LiveMirrorFinalizeOutcome,
  now = Date.now(),
): Promise<{ released: boolean } & Omit<LiveMirrorStatus, "sessionMaxSeconds">> {
  const session = await ctx.db.get(sessionId);
  if (!session) throw appError("NOT_FOUND", "Live Mirror session was not found.");
  if (session.status === outcome) {
    const user = await ctx.db.get(session.userId);
    if (!user) throw appError("NOT_FOUND", "User not found for Live Mirror session.");
    const status = await describeReservationPeriod(ctx, user, session.periodStart, now);
    return { released: false, ...status };
  }
  // A minted token is never refunded. A late failure report for an authorized session is a
  // safe no-op; resurrecting a consumed provider_failed row as authorized would be unsafe.
  if (session.status === "authorized" && outcome === "provider_failed") {
    const user = await ctx.db.get(session.userId);
    if (!user) throw appError("NOT_FOUND", "User not found for Live Mirror session.");
    const status = await describeReservationPeriod(ctx, user, session.periodStart, now);
    return { released: false, ...status };
  }
  if (session.status !== "reserved") {
    throw appError("CONFLICT", "Live Mirror session has already settled.");
  }

  if (outcome === "provider_failed") {
    await ctx.db.patch(sessionId, { status: "provider_failed", updatedAt: now });
    await adjustDailyAuthorizedSeconds(ctx, dayKey(now), -session.authorizedSeconds);
    const user = await ctx.db.get(session.userId);
    if (!user) throw appError("NOT_FOUND", "User not found for Live Mirror session.");
    const status = await describeReservationPeriod(ctx, user, session.periodStart, now);
    return { released: true, ...status };
  }

  await ctx.db.patch(sessionId, { status: "authorized", updatedAt: now });
  const user = await ctx.db.get(session.userId);
  if (!user) throw appError("NOT_FOUND", "User not found for Live Mirror session.");
  const status = await describeReservationPeriod(ctx, user, session.periodStart, now);
  return { released: false, ...status };
}
