import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/providers/store-user.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function fixture({ visibility = "visible", authenticated = true, userId = "clerk-a" } = {}) {
  const document = Object.assign(new EventTarget(), { visibilityState: visibility });
  const window = new EventTarget();
  const calls = { ensure: 0, refresh: 0, errors: 0 };
  let ensureResult = () => Promise.resolve();
  let refreshResult = () => Promise.resolve();
  const ensure = async (args) => {
    assert.equal(Object.keys(args).length, 0);
    calls.ensure++;
    await ensureResult();
  };
  const refresh = async (args) => {
    assert.equal(Object.keys(args).length, 0, "the client never supplies a plan or credit allowance");
    calls.refresh++;
    await refreshResult();
  };
  const state = {
    userId,
    planId: "free",
    subscription: {
      updatedAt: new Date(1000),
      subscriptionItems: [
        {
          id: "subscription-item",
          plan: { slug: "free" },
          status: "active",
          periodStart: new Date(1000),
          periodEnd: new Date(2000),
          canceledAt: null,
        },
      ],
    },
  };
  let nextEffect;
  let previousDeps;
  let cleanup;
  let previousKey;
  const mocks = {
    react: { useEffect: (effect, deps) => (nextEffect = { effect, deps }) },
    "react/jsx-runtime": { jsx: (type, props, key) => ({ type, props, key }) },
    "@clerk/nextjs": { useAuth: () => ({ userId: state.userId }) },
    "convex/react": {
      useConvexAuth: () => ({ isAuthenticated: authenticated }),
      useMutation: () => ensure,
      useAction: () => refresh,
    },
    "@clerk/nextjs/experimental": { useSubscription: () => ({ data: state.subscription }) },
    "@/hooks/use-clerk-plan": { useClerkPlan: () => ({ planId: state.planId }) },
    "@convex/_generated/api": { api: { users: { ensure: "ensure" }, subscriptions: { refresh: "refresh" } } },
    "@/lib/errors": { reportError: () => calls.errors++ },
  };
  const componentModule = { exports: {} };
  runInNewContext(compiled, {
    module: componentModule,
    exports: componentModule.exports,
    require: (name) => {
      assert.ok(name in mocks, `Unexpected dependency: ${name}`);
      return mocks[name];
    },
    document,
    window,
  });
  const render = () => {
    nextEffect = undefined;
    const child = componentModule.exports.StoreUser();
    if (child?.key !== previousKey) {
      cleanup?.();
      cleanup = undefined;
      previousDeps = undefined;
      previousKey = child?.key;
    }
    child?.type(child.props);
    if (!nextEffect || nextEffect.deps.every((value, index) => Object.is(value, previousDeps?.[index]))) return;
    cleanup?.();
    previousDeps = nextEffect.deps;
    cleanup = nextEffect.effect();
  };
  return {
    calls,
    state,
    document,
    window,
    render,
    unmount: () => cleanup?.(),
    deferEnsure: (promise) => (ensureResult = () => promise),
    failEnsure: () => (ensureResult = () => Promise.reject(new Error("Temporary setup failure"))),
    deferRefresh: (promise) => (refreshResult = () => promise),
  };
}

test("background checkout updates reconcile credits without waiting for window focus", async () => {
  const f = fixture({ visibility: "hidden" });
  f.render();
  await nextTurn();
  assert.equal(f.calls.refresh, 1);
  f.state.planId = "pro";
  f.render();
  await nextTurn();
  assert.equal(f.calls.refresh, 2, "Clerk entitlements trigger reconciliation even if its subscription cache is stale");
  f.unmount();
});

test("a renewed billing period reconciles even when the top-level subscription timestamp stays unchanged", async () => {
  const f = fixture();
  f.render();
  await nextTurn();
  f.state.subscription.subscriptionItems[0].periodStart = new Date(3000);
  f.state.subscription.subscriptionItems[0].periodEnd = new Date(4000);
  f.render();
  await nextTurn();
  assert.equal(f.calls.refresh, 2);
  f.render();
  await nextTurn();
  assert.equal(f.calls.refresh, 2, "ordinary renders do not repeatedly call Clerk");
  f.unmount();
});

test("returning to a visible tab refreshes without a focus event and coalesces simultaneous focus", async () => {
  const f = fixture();
  f.render();
  await nextTurn();
  f.document.visibilityState = "hidden";
  f.document.dispatchEvent(new Event("visibilitychange"));
  await nextTurn();
  assert.equal(f.calls.refresh, 1);
  let finish;
  f.deferRefresh(new Promise((resolve) => (finish = resolve)));
  f.document.visibilityState = "visible";
  f.document.dispatchEvent(new Event("visibilitychange"));
  f.window.dispatchEvent(new Event("focus"));
  await nextTurn();
  assert.equal(f.calls.refresh, 2);
  finish();
  await nextTurn();
  f.unmount();
  f.window.dispatchEvent(new Event("focus"));
  f.document.dispatchEvent(new Event("visibilitychange"));
  await nextTurn();
  assert.equal(f.calls.refresh, 2, "unmounted account listeners are removed");
});

test("an account disposed during ensure cannot start a later billing refresh", async () => {
  const f = fixture();
  let finish;
  f.deferEnsure(new Promise((resolve) => (finish = resolve)));
  f.render();
  f.unmount();
  finish();
  await nextTurn();
  assert.equal(f.calls.ensure, 1);
  assert.equal(f.calls.refresh, 0);
});

test("signed-out visitors do not ensure a user or reconcile subscriptions", async () => {
  const f = fixture({ authenticated: false });
  f.render();
  await nextTurn();
  assert.equal(f.calls.ensure, 0);
  assert.equal(f.calls.refresh, 0);
});

test("switching accounts reruns setup even when both accounts have the same plan", async () => {
  const f = fixture();
  f.render();
  await nextTurn();
  f.state.userId = "clerk-b";
  f.render();
  await nextTurn();
  assert.equal(f.calls.ensure, 2);
  assert.equal(f.calls.refresh, 2);
  f.render();
  await nextTurn();
  assert.equal(f.calls.ensure, 2, "ordinary renders do not restart account setup");
  f.unmount();
});

test("failed provisioning reports an error, skips billing and can recover on focus", async () => {
  const f = fixture();
  f.failEnsure();
  f.render();
  await nextTurn();
  assert.equal(f.calls.ensure, 1);
  assert.equal(f.calls.errors, 1);
  assert.equal(f.calls.refresh, 0);
  f.deferEnsure(Promise.resolve());
  f.window.dispatchEvent(new Event("focus"));
  await nextTurn();
  assert.equal(f.calls.ensure, 2);
  assert.equal(f.calls.refresh, 1);
  f.unmount();
});

test("a stale Convex authenticated state cannot provision without a Clerk identity", async () => {
  const f = fixture({ userId: null });
  f.render();
  await nextTurn();
  assert.equal(f.calls.ensure, 0);
  assert.equal(f.calls.refresh, 0);
});
