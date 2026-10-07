import { defineInstrumentation } from "eve/instrumentation";
import { countNetworkCall } from "./lib/canary-ports";

/**
 * Step 7 Phase C7B.1 — the zero-provider witness.
 *
 * Installs a counter around the server process's `globalThis.fetch` at startup. The canary agent runs
 * only on the deterministic model and in-process fakes, so any outbound fetch would be a provider or
 * external call. The tool surfaces the running count in its audit, so each turn proves the number of
 * outbound network calls the deterministic path made.
 */

const realFetch = globalThis.fetch;

export default defineInstrumentation({
  setup() {
    globalThis.fetch = (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
      countNetworkCall();
      return realFetch(...args);
    };
  },
});