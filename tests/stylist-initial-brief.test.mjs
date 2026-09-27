import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { EveAgentStore, defaultMessageReducer } from "eve/client";

const { detachEveAgentStore } = await import(new URL("./eve-agent-store.js", import.meta.resolve("eve/client")));
const fixtureKey = "__fitcheckInitialBriefTest";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "react" && context.parentURL?.endsWith("/use-initial-stylist-brief.ts")) {
      const source = `export function useRef(value){const f=globalThis.${fixtureKey};return f.ref??=( {current:value} )};export function useEffect(effect){globalThis.${fixtureKey}.effect=effect}`;
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { useInitialStylistBrief } = await import("../src/hooks/use-initial-stylist-brief.ts");

function sessionFixture() {
  const deliveries = [];
  const errors = [];
  const session = {
    state: { sessionId: "initial-brief-session", streamIndex: 0 },
    async send(message, options) {
      await delay(1, undefined, { signal: options.signal });
      deliveries.push({ message, clientContext: options.clientContext });
      return (async function* () {
        yield {
          type: "message.received",
          data: { turnId: "turn-1", message },
          meta: { id: "received-1", at: new Date().toISOString() },
        };
        yield {
          type: "turn.completed",
          data: { turnId: "turn-1" },
          meta: { id: "completed-1", at: new Date().toISOString() },
        };
      })();
    },
  };
  const store = new EveAgentStore({ session, reducer: defaultMessageReducer() });
  store.setCallbacks({ onError: (error) => errors.push(error) });
  return { store, deliveries, errors };
}

function hookFixture(store) {
  const lifecycle = {};
  globalThis[fixtureKey] = lifecycle;
  const context = { page: { kind: "item", item: { _id: "navy-shirt" } } };
  let consumed = 0;
  const options = {
    brief: "Style this piece.",
    isBusy: false,
    isResuming: false,
    contextLoading: false,
    messageCount: 0,
    onSend: (message) => store.send({ message, clientContext: context }),
    onConsume: () => consumed++,
  };
  const render = (changes = {}) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- hooks are replaced by the lifecycle fixture above
    useInitialStylistBrief({ ...options, ...changes });
    return lifecycle.effect();
  };
  return { render, lifecycle, context, consumed: () => consumed };
}

test("installed Eve reproduces the silent failed message when a mount effect immediately sends then detaches", async () => {
  const { store, deliveries, errors } = sessionFixture();
  const pending = store.send({ message: "Initial message" });
  detachEveAgentStore(store);
  await pending;
  assert.equal(deliveries.length, 0);
  assert.equal(store.snapshot.status, "ready");
  assert.equal(store.snapshot.error, undefined);
  assert.equal(errors.length, 0);
  assert.equal(store.snapshot.data.messages[0].metadata.status, "failed");
});

test("the actual initial-brief hook survives setup/cleanup/setup and delivers once with the original context", async () => {
  const { store, deliveries, errors } = sessionFixture();
  const hook = hookFixture(store);
  const firstCleanup = hook.render();
  detachEveAgentStore(store);
  firstCleanup();
  const secondCleanup = hook.render();
  await delay(30);
  assert.deepEqual(deliveries, [{ message: "Style this piece.", clientContext: hook.context }]);
  assert.equal(hook.consumed(), 1);
  assert.equal(errors.length, 0);
  assert.equal(store.snapshot.data.messages[0].metadata.status, "complete");
  secondCleanup();
  hook.render();
  await delay(10);
  assert.equal(deliveries.length, 1, "later renders do not resend the carried brief");
});

test("initial dispatch waits for page context, session catch-up and busy work without consuming the brief", async () => {
  const { store, deliveries } = sessionFixture();
  const hook = hookFixture(store);
  for (const guard of [{ contextLoading: true }, { isResuming: true }, { isBusy: true }]) {
    assert.equal(hook.render(guard), undefined);
    await delay(5);
  }
  assert.equal(deliveries.length, 0);
  assert.equal(hook.consumed(), 0);
  hook.render();
  await delay(30);
  assert.equal(deliveries.length, 1);
});

test("unmount before dispatch creates no abandoned session and a recovered transcript never resends its brief", async () => {
  const { store, deliveries } = sessionFixture();
  const hook = hookFixture(store);
  hook.render()();
  await delay(10);
  assert.equal(deliveries.length, 0);
  assert.equal(hook.consumed(), 0);
  assert.equal(hook.render({ messageCount: 1 }), undefined);
  await delay(10);
  assert.equal(deliveries.length, 0);
});
