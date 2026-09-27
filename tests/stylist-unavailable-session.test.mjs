import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { ClientError, EveAgentStore, defaultMessageReducer } from "eve/client";
import { isMissingStylistSession } from "../src/lib/stylist-session-error.ts";

const missingBody = JSON.stringify({ ok: false, error: "Session not found." });
const fixtureKey = "__fitcheckUnavailableSessionTest";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith("/use-stylist.ts")) return nextResolve(specifier, context);
    const fixture = `globalThis.${fixtureKey}`;
    const mocks = {
      react:
        "export const useRef=value=>({current:value});export const useEffect=()=>{};export const useMemo=fn=>fn();export const useCallback=fn=>fn;export const useState=fn=>[typeof fn==='function'?fn():fn,()=>{}]",
      "@clerk/nextjs": "export const useAuth=()=>({getToken:async()=> 'test-token'})",
      "convex/react": `export const useConvexAuth=()=>({isAuthenticated:true});export const useQuery=()=>undefined;export const useMutation=()=>async value=>{${fixture}.writes.push(value)}`,
      "@convex/_generated/api": "export const api={threads:{linkSession:'link',list:'list',proposals:'proposals'}}",
      "@/lib/errors": `export const reportError=(error)=>${fixture}.errors.push(error)`,
      "eve/react": `export const useEveAgent=options=>${fixture}.bind(options)`,
    };
    if (specifier === "@/lib/stylist-session-error")
      return { url: new URL("../src/lib/stylist-session-error.ts", import.meta.url).href, shortCircuit: true };
    if (specifier in mocks)
      return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { useStylistSession } = await import("../src/hooks/use-stylist.ts");

test("only Eve's structured missing-session response is classified as unavailable history", () => {
  assert.equal(isMissingStylistSession(new ClientError(404, missingBody)), true);
  // eve/react includes a bundled ClientError constructor separate from eve/client.
  const bundledError = Object.assign(new Error("Session not found."), {
    name: "ClientError",
    status: 404,
    body: missingBody,
  });
  assert.equal(isMissingStylistSession(bundledError), true);
  for (const error of [
    undefined,
    new Error("Session not found."),
    new TypeError("Failed to fetch"),
    new ClientError(401, missingBody),
    new ClientError(403, missingBody),
    new ClientError(503, missingBody),
    new ClientError(404, "<html>Page not found</html>"),
    new ClientError(404, JSON.stringify({ ok: false, error: "Route not found." })),
    new ClientError(404, JSON.stringify({ ok: true, error: "Session not found." })),
    new ClientError(404, "Session not found."),
  ])
    assert.equal(isMissingStylistSession(error), false, String(error));
});

async function resumeFixture(response) {
  const requests = [];
  const fixture = {
    writes: [],
    errors: [],
    store: null,
    bind(options) {
      this.store = new EveAgentStore({
        host: "https://fitcheck.invalid",
        initialSession: options.initialSession,
        session: options.session,
        headers: options.headers,
        reducer: defaultMessageReducer(),
      });
      this.store.setCallbacks(options);
      return {
        ...this.store.snapshot,
        send: () => {},
        respond: () => {},
        resume: () => {},
        cancel: () => {},
        reset: () => {},
      };
    },
  };
  globalThis[fixtureKey] = fixture;
  const savedThread = {
    _id: "historical-thread",
    title: "An earlier look",
    eveSessionId: "local-session",
    streamIndex: 27,
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), method: options?.method ?? "GET" });
    return response.clone();
  };
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- React/Convex are replaced by the isolated hook fixture above.
    useStylistSession(savedThread);
    await fixture.store.resume();
    return { ...fixture, requests, savedThread };
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis[fixtureKey];
  }
}

test("a missing historical session settles after one replay, preserves its binding and cursor, and does not create a session", async () => {
  const result = await resumeFixture(
    new Response(missingBody, { status: 404, headers: { "content-type": "application/json" } }),
  );
  assert.equal(result.store.snapshot.status, "error");
  assert.equal(isMissingStylistSession(result.store.snapshot.error), true);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].method, "GET");
  assert.match(result.requests[0].url, /local-session/);
  assert.deepEqual(
    result.writes,
    [],
    "failed replay callbacks never persist Eve's reset cursor or replace the old binding",
  );
  assert.deepEqual(result.errors, [], "the actionable unavailable-history UI replaces a generic toast");
  assert.deepEqual(result.savedThread, {
    _id: "historical-thread",
    title: "An earlier look",
    eveSessionId: "local-session",
    streamIndex: 27,
  });
  assert.equal(result.store.snapshot.session.sessionId, "local-session");
});

test("an authorization error remains an ordinary error, not an unavailable-history migration state", async () => {
  const result = await resumeFixture(
    Response.json({ ok: false, error: "This conversation is not available." }, { status: 403 }),
  );
  assert.equal(result.store.snapshot.status, "error");
  assert.equal(isMissingStylistSession(result.store.snapshot.error), false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.requests.length, 1);
  assert.equal(result.store.snapshot.session.sessionId, "local-session");
});

test("a valid historical stream still restores its transcript and advances only the existing binding", async () => {
  const events = [
    {
      type: "message.received",
      data: { turnId: "past-turn", message: "A past outfit" },
      meta: { id: "past-message", at: "2026-09-16T12:00:00.000Z" },
    },
    { type: "session.completed", meta: { id: "past-finish", at: "2026-09-16T12:00:01.000Z" } },
  ];
  const result = await resumeFixture(
    new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", {
      headers: { "content-type": "application/x-ndjson", "x-eve-stream-version": "25", "x-eve-stream-tail-index": "1" },
    }),
  );
  assert.equal(result.store.snapshot.status, "ready");
  assert.equal(result.store.snapshot.error, undefined);
  assert.equal(result.requests.length, 1);
  assert.equal(result.store.snapshot.data.messages[0].parts[0].text, "A past outfit");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.writes, [{ threadId: "historical-thread", eveSessionId: "local-session", streamIndex: 2 }]);
});
