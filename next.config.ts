import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {};

/**
 * Build-time Eve root selection — never derived from request, session or chat input.
 *
 * `FITCHECK_EVE_ROOT` is read once when this config loads (build/start), so a running server cannot
 * switch roots:
 *   - unset or `legacy`   => the repo-root `agent/` root (model `openai/gpt-5.4-mini`), the default.
 *   - `deterministic`     => `agent-deterministic/` (the zero-provider transport; same channel, same
 *                            `stylist_turn` tool, same Convex backend).
 * Any other value throws, so a typo fails the build instead of silently shipping the wrong root.
 * Both roots mount on the same public path (`/eve/v1/*`), so `useEveAgent` is unchanged.
 */
const EVE_ROOTS = { legacy: undefined, deterministic: "agent-deterministic" } as const;
type EveRootName = keyof typeof EVE_ROOTS;

function selectEveRoot(): string | undefined {
  const raw = process.env.FITCHECK_EVE_ROOT?.trim();
  if (!raw || raw === "legacy") return undefined;
  if (Object.prototype.hasOwnProperty.call(EVE_ROOTS, raw)) {
    return EVE_ROOTS[raw as EveRootName];
  }
  throw new Error(
    `Unknown FITCHECK_EVE_ROOT "${raw}". Known roots: ${Object.keys(EVE_ROOTS).join(", ")}.`,
  );
}

const eveRoot = selectEveRoot();

/** Mounts the selected stylist root on this origin at `/eve/v1/*`, so `useEveAgent` needs no host. */
export default withEve(nextConfig, eveRoot ? { eveRoot } : {});
