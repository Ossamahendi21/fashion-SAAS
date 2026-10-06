import { defineState } from "eve/context";
import { EMPTY_STYLIST_STATE, type StylistThreadState } from "./stylist-state";

/**
 * Durable per-session stylist state. Eve's `defineState` backs the slot with a durable context
 * key, so the C2 thread (candidates, quote, stage) survives across workflow steps; the value must
 * stay JSON-serializable, which `StylistThreadState` already is.
 *
 * `defineState` is called at module scope (safe: it only builds a key); `get`/`update` require an
 * active eve context, so this module is imported only by the tool, never by the pure test seam.
 */
const STYLIST_STATE = defineState<StylistThreadState>("fitcheck.stylist", () =>
  structuredClone(EMPTY_STYLIST_STATE),
);

export function readStylistState(): StylistThreadState {
  return STYLIST_STATE.get();
}

export function writeStylistState(state: StylistThreadState): void {
  STYLIST_STATE.update(() => state);
}

export function updateStylistState(update: (current: StylistThreadState) => StylistThreadState): void {
  STYLIST_STATE.update(update);
}