import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { eveChannel } from "eve/channels/eve";
import { routeAuth } from "eve/channels/auth";
import { getFunctionName } from "convex/server";

// Node 24 strips TypeScript; resolve the extensionless imports used by the bundled application.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      for (const extension of [".ts", ".js"]) {
        const candidate = new URL(`${specifier}${extension}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
      }
      throw error;
    }
  },
});

const { withSessionOwnership } = await import("../agent/lib/session-ownership.ts");
const { samePrincipal } = await import("../agent/lib/session-auth.ts");
const { bindSession, canAccessSession, linkSession, resolveByEveSession } = await import("../convex/model/threads.ts");
const { clerkUserId, convex } = await import("../agent/lib/convex.ts");
const { default: startRenders } = await import("../agent/tools/start_renders.ts");
const { default: composeOutfits } = await import("../agent/tools/compose_outfits.ts");
const { attachRouteSessionCreator } = await import(
  new URL("./internal/nitro/routes/channel-route-context.js", import.meta.resolve("eve"))
);

const alice = {
  principalId: "alice",
  principalType: "user",
  authenticator: "clerk",
  issuer: "test-clerk",
  attributes: { clerkUserId: "alice", threadId: "thread-a" },
};
const bob = { ...alice, principalId: "bob", attributes: { clerkUserId: "bob", threadId: "thread-b" } };
const aliceUser = { _id: "user-a" };
const bobUser = { _id: "user-b" };

function database(initial = []) {
  const rows = new Map(initial.map((row) => [row._id, { ...row }]));
  const ctx = {
    db: {
      async get(id) {
        return rows.get(id) ?? null;
      },
      async patch(id, fields) {
        rows.set(id, { ...rows.get(id), ...fields });
      },
      query(table) {
        assert.equal(table, "threads");
        return {
          withIndex(index, select) {
            assert.equal(index, "by_eveSessionId");
            let value;
            select({
              eq(field, match) {
                assert.equal(field, "eveSessionId");
                value = match;
              },
            });
            return {
              async take(limit) {
                return [...rows.values()].filter((row) => row.eveSessionId === value).slice(0, limit);
              },
            };
          },
        };
      },
    },
  };
  return { ctx, rows };
}

test("session bindings require service-owned thread, are unique and cannot be retargeted", async () => {
  const { ctx, rows } = database([
    { _id: "thread-a", userId: "user-a" },
    { _id: "thread-b", userId: "user-b" },
  ]);
  await assert.rejects(bindSession(ctx, bobUser, "thread-a", "session-a"));
  await assert.rejects(linkSession(ctx, rows.get("thread-b"), "session-a", 0));
  await bindSession(ctx, aliceUser, "thread-a", "session-a");
  assert.equal(await canAccessSession(ctx, aliceUser, "session-a"), true);
  assert.equal(await canAccessSession(ctx, bobUser, "session-a"), false);
  await assert.rejects(bindSession(ctx, bobUser, "thread-b", "session-a"));
  await assert.rejects(bindSession(ctx, aliceUser, "thread-a", "another-session"));
  await assert.rejects(resolveByEveSession(ctx, bobUser, "session-a", "thread-b"));
  assert.equal(await resolveByEveSession(ctx, aliceUser, "session-a", "thread-a"), "thread-a");
  assert.equal(rows.size, 2, "startup binding never creates a duplicate thread");
});

test("unknown, unverified legacy, duplicate, and deleted bindings all deny access", async () => {
  const { ctx, rows } = database([{ _id: "thread-a", userId: "user-a", eveSessionId: "old" }]);
  assert.equal(await canAccessSession(ctx, aliceUser, "missing"), false);
  assert.equal(await canAccessSession(ctx, aliceUser, "old"), false);
  rows.set("thread-a", { ...rows.get("thread-a"), sessionVerifiedAt: 1 });
  rows.set("duplicate", { ...rows.get("thread-a"), _id: "duplicate" });
  assert.equal(await canAccessSession(ctx, aliceUser, "old"), false);
  rows.clear();
  assert.equal(await canAccessSession(ctx, aliceUser, "old"), false);
});

test("browser may only advance its already verified session cursor", async () => {
  const { ctx, rows } = database([
    { _id: "thread-a", userId: "user-a", eveSessionId: "session-a", sessionVerifiedAt: 1, streamIndex: 20 },
  ]);
  await linkSession(ctx, rows.get("thread-a"), "session-a", 10);
  assert.equal(rows.get("thread-a").streamIndex, 20);
  await linkSession(ctx, rows.get("thread-a"), "session-a", 30);
  assert.equal(rows.get("thread-a").streamIndex, 30);
  await assert.rejects(linkSession(ctx, rows.get("thread-a"), "foreign-session", 0));
  for (const cursor of [-1, NaN, Infinity, 1.5])
    await assert.rejects(linkSession(ctx, rows.get("thread-a"), "session-a", cursor));
});

function protectedChannel(caller, access = true, overrides = {}) {
  const calls = [];
  const auth = async () => caller;
  const channel = withSessionOwnership(eveChannel({ auth }), {
    authenticate: (request) => routeAuth(request, auth),
    async canAccessThread(_caller, id) {
      calls.push(["thread-access", id]);
      return access && id === "thread-a";
    },
    async canAccessSession(_caller, id) {
      calls.push(["session-access", id]);
      return access && caller.principalId === "alice" && id === "session-a";
    },
    async bindSession(_caller, threadId, sessionId) {
      calls.push(["bind", threadId, sessionId]);
    },
    ...overrides,
  });
  const context = {
    params: { sessionId: "session-a" },
    requestIp: null,
    waitUntil() {},
    async resolveSession() {
      return undefined;
    },
    attachSession(id) {
      calls.push(["dispatch", id]);
      const accepted = async () => ({ status: "accepted", sessionId: id });
      return {
        id,
        send: accepted,
        respond: accepted,
        cancel: accepted,
        compact: accepted,
        clear: accepted,
        async reset() {
          return { status: "reset", previousSessionId: id };
        },
        async getEventStream() {
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
      };
    },
  };
  return { channel, calls, context };
}

const sessionRoutes = eveChannel({ auth: async () => alice }).routes.filter((route) =>
  route.path.startsWith("/eve/v1/session/"),
);
for (const descriptor of sessionRoutes) {
  test(`foreign caller blocked before Eve dispatch: ${descriptor.method} ${descriptor.path}`, async () => {
    const { channel, context, calls } = protectedChannel(bob);
    if (descriptor.path.includes(":parentSessionId"))
      context.params = { parentSessionId: "session-a", callId: "call", childSessionId: "child" };
    const route = channel.routes.find((entry) => entry.path === descriptor.path && entry.method === descriptor.method);
    const request = new Request("http://localhost/eve/v1/session/session-a", {
      method: descriptor.method,
      ...(descriptor.method === "POST"
        ? {
            body: JSON.stringify({
              message: "approve",
              inputResponses: [{ requestId: "approval", optionId: "approve" }],
            }),
          }
        : {}),
    });
    const response = await route.handler(request, context);
    assert.equal(response.status, 403);
    assert.equal(
      calls.some(([name]) => name === "dispatch"),
      false,
    );
  });
}

test("owner can send, approve, stream, and control using the actual Eve route handlers", async () => {
  for (const descriptor of sessionRoutes.filter((route) => !route.path.includes(":parentSessionId"))) {
    const { channel, context, calls } = protectedChannel(alice);
    const route = channel.routes.find((entry) => entry.path === descriptor.path && entry.method === descriptor.method);
    const body = descriptor.path.endsWith(":sessionId") ? { message: "hello" } : {};
    const response = await route.handler(
      new Request("http://localhost/test", {
        method: descriptor.method,
        ...(descriptor.method === "POST" ? { body: JSON.stringify(body) } : {}),
      }),
      context,
    );
    assert.equal(response.ok, true, await response.text());
    assert.equal(
      calls.some(([name]) => name === "dispatch"),
      true,
    );
  }
  const { channel, context } = protectedChannel(alice);
  const route = channel.routes.find((entry) => entry.path === "/eve/v1/session/:sessionId");
  const response = await route.handler(
    new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ inputResponses: [{ requestId: "approval", optionId: "approve" }] }),
    }),
    context,
  );
  assert.equal(response.status, 202);
});

test("creation checks thread ownership then binds actual Eve-created ID before returning it", async () => {
  const { channel, context, calls } = protectedChannel(alice);
  context.params = {};
  attachRouteSessionCreator(context, async () => {
    calls.push(["create"]);
    return { sessionId: "new-session" };
  });
  const route = channel.routes.find((entry) => entry.path === "/eve/v1/session" && entry.method === "POST");
  const response = await route.handler(
    new Request("http://localhost/eve/v1/session", {
      method: "POST",
      headers: { "x-fitcheck-thread-id": "thread-a" },
      body: JSON.stringify({ message: "hello" }),
    }),
    context,
  );
  assert.equal(response.status, 202);
  assert.deepEqual(calls, [["thread-access", "thread-a"], ["create"], ["bind", "thread-a", "new-session"]]);
});

test("missing identity, missing thread, and foreign thread never create a session", async () => {
  for (const [caller, threadId, expected] of [
    [null, "thread-a", 401],
    [alice, null, 400],
    [alice, "thread-b", 403],
  ]) {
    const { channel, context, calls } = protectedChannel(caller);
    context.params = {};
    const route = channel.routes.find((entry) => entry.path === "/eve/v1/session" && entry.method === "POST");
    const response = await route.handler(
      new Request("http://localhost/test", {
        method: "POST",
        headers: threadId ? { "x-fitcheck-thread-id": threadId } : {},
        body: JSON.stringify({ message: "hello" }),
      }),
      context,
    );
    assert.equal(response.status, expected);
    assert.equal(
      calls.some(([name]) => name === "create" || name === "bind"),
      false,
    );
  }
});

test("tool identity and render approval reject a different principal or issuer", () => {
  assert.equal(clerkUserId({ session: { auth: { current: alice, initiator: alice } } }), "alice");
  assert.throws(() => clerkUserId({ session: { auth: { current: bob, initiator: alice } } }));
  assert.equal(samePrincipal({ ...alice, issuer: "other-issuer" }, alice), false);
  assert.deepEqual(startRenders.approval.response({ responder: alice, session: { initiator: alice } }), {
    status: "allowed",
  });
  assert.equal(startRenders.approval.response({ responder: bob, session: { initiator: alice } }).status, "rejected");
});

test("an ownership-store outage denies existing-session dispatch", async () => {
  const { channel, context, calls } = protectedChannel(alice, true, {
    async canAccessSession() {
      throw new Error("temporary outage");
    },
  });
  const route = channel.routes.find((entry) => entry.path === "/eve/v1/session/:sessionId/stream");
  const response = await route.handler(new Request("http://localhost/test"), context);
  assert.equal(response.status, 503);
  assert.equal(
    calls.some(([name]) => name === "dispatch"),
    false,
  );
});

test("a failed ownership write never exposes a newly created session ID", async () => {
  const { channel, context } = protectedChannel(alice, true, {
    async bindSession() {
      throw new Error("temporary outage");
    },
  });
  context.params = {};
  attachRouteSessionCreator(context, async () => ({ sessionId: "must-not-be-returned" }));
  const route = channel.routes.find((entry) => entry.path === "/eve/v1/session" && entry.method === "POST");
  const response = await route.handler(
    new Request("http://localhost/test", {
      method: "POST",
      headers: { "x-fitcheck-thread-id": "thread-a" },
      body: JSON.stringify({ message: "hello" }),
    }),
    context,
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-eve-session-id"), null);
  assert.equal((await response.text()).includes("must-not-be-returned"), false);
});

test("compose executor omits unused garment slots and defaults accessories before the Convex call", async (t) => {
  const priorUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const priorServiceKey = process.env.AGENT_SERVICE_KEY;
  process.env.NEXT_PUBLIC_CONVEX_URL = "http://127.0.0.1:3210";
  process.env.AGENT_SERVICE_KEY = "unit-test-service-key";
  t.after(() => {
    if (priorUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
    else process.env.NEXT_PUBLIC_CONVEX_URL = priorUrl;
    if (priorServiceKey === undefined) delete process.env.AGENT_SERVICE_KEY;
    else process.env.AGENT_SERVICE_KEY = priorServiceKey;
  });
  const calls = [];
  let invalidId = false;
  t.mock.method(convex(), "mutation", async (reference, args) => {
    const name = getFunctionName(reference);
    if (name === "agent:resolveThread") return "thread-a";
    assert.equal(name, "agent:composeOutfits");
    calls.push(args);
    if (invalidId) throw new Error("ArgumentValidationError: invalid item id");
    return [{ outfitId: "outfit-a", name: args.outfits[0].name, items: [], problems: [] }];
  });
  const context = { session: { id: "session-a", auth: { current: alice, initiator: alice } } };
  for (const unused of [undefined, null, "", "   "]) {
    const input = composeOutfits.inputSchema.parse({
      brief: "One casual men's look",
      outfits: [
        {
          name: "Casual",
          reasoning: "Neutral colours and a light layer.",
          occasion: null,
          slots: { top: " item-top ", bottom: "item-jeans", shoes: "item-trainers", dress: unused, outerwear: unused },
        },
      ],
    });
    const result = await composeOutfits.execute(input, context);
    assert.equal(result.saved, 1);
    assert.deepEqual(calls.at(-1).outfits[0].slots, {
      top: "item-top",
      bottom: "item-jeans",
      shoes: "item-trainers",
      accessories: [],
    });
  }
  const input = composeOutfits.inputSchema.parse({
    brief: "One dress look",
    outfits: [
      {
        name: "Dress",
        reasoning: "A tonal pairing.",
        slots: { dress: "item-dress", top: null, bottom: " ", accessories: [null, " ", " item-bag "] },
      },
    ],
  });
  await composeOutfits.execute(input, context);
  assert.deepEqual(calls.at(-1).outfits[0].slots, { dress: "item-dress", accessories: ["item-bag"] });
  invalidId = true;
  const result = await composeOutfits.execute(input, context);
  assert.equal(result.saved, 0);
  assert.equal(result.results[0].outfitId, null);
  assert.match(result.results[0].problems[0], /exact ids/);
  assert.match(result.results[0].problems[0], /dress is never required/);
});
