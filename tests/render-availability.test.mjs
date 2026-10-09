import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

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

globalThis.Convex = {
  async asyncSyscall(operation, args) {
    assert.equal(operation, "1.0/createFunctionHandle");
    return JSON.stringify(`handle:${JSON.parse(args).name}`);
  },
};

const { isRenderRuntimeEnabled, RENDER_FAILED_MESSAGE, RENDER_UNAVAILABLE_REASON } =
  await import("../convex/shared/render_policy.ts");
const { renderOutfitImage, renderProvider } = await import("../convex/ai/rendering.ts");
const { startRenderJob, toRenderView } = await import("../convex/model/renders.ts");

test("rendering is disabled by default and credentials alone cannot enable it", () => {
  assert.equal(isRenderRuntimeEnabled({}), false);
  assert.equal(isRenderRuntimeEnabled({ OPENAI_API_KEY: "secret" }), false);
  assert.equal(isRenderRuntimeEnabled({ AI_GATEWAY_API_KEY: "secret" }), false);
  assert.equal(renderProvider({}), "disabled");
});

test("an explicit supported provider also needs its server credential", () => {
  assert.equal(isRenderRuntimeEnabled({ RENDER_PROVIDER: "openai" }), false);
  assert.equal(isRenderRuntimeEnabled({ RENDER_PROVIDER: "openai", OPENAI_API_KEY: "secret" }), true);
  assert.equal(isRenderRuntimeEnabled({ RENDER_PROVIDER: "openai", AI_GATEWAY_API_KEY: "secret" }), true);
});

test("the disabled provider calls no runner and exposes only safe product copy", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      renderOutfitImage(
        { person: { bytes: new Uint8Array(), name: "person" }, garments: [], prompt: "test", quality: "standard" },
        {
          openai: async () => {
            calls += 1;
            throw new Error("must not run");
          },
        },
        {},
      ),
    (error) => error?.data?.message === RENDER_UNAVAILABLE_REASON,
  );
  assert.equal(calls, 0);
  assert.ok(!RENDER_UNAVAILABLE_REASON.includes("environment"));
  assert.ok(!RENDER_FAILED_MESSAGE.includes("API"));
});

test("the authoritative guard precedes every render write and views sanitize stored diagnostics", async () => {
  const source = await readFile(new URL("../convex/model/renders.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function startRenderJob");
  const guard = source.indexOf("isRenderRuntimeEnabled(process.env)", start);
  const create = source.indexOf("createJob(ctx", start);
  const reserve = source.indexOf("reserve(ctx", start);
  const insert = source.indexOf('ctx.db.insert("renders"', start);
  assert.ok(start >= 0 && guard > start);
  assert.ok(guard < create && guard < reserve && guard < insert);
  assert.match(source, /error: render\.status === "failed" \? RENDER_FAILED_MESSAGE : undefined/);
  assert.doesNotMatch(source, /error: render\.error/);
});

test("disabled start touches no database and creates no chargeable work", async () => {
  const priorProvider = process.env.RENDER_PROVIDER;
  const priorOpenAi = process.env.OPENAI_API_KEY;
  const priorGateway = process.env.AI_GATEWAY_API_KEY;
  delete process.env.RENDER_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  let touched = false;
  const ctx = new Proxy(
    {},
    {
      get() {
        touched = true;
        throw new Error("disabled render touched the context");
      },
    },
  );
  try {
    await assert.rejects(
      () => startRenderJob(ctx, {}, { outfitIds: ["outfit"], count: 1, quality: "standard" }),
      (error) => error?.data?.message === RENDER_UNAVAILABLE_REASON,
    );
    assert.equal(touched, false);
  } finally {
    if (priorProvider === undefined) delete process.env.RENDER_PROVIDER;
    else process.env.RENDER_PROVIDER = priorProvider;
    if (priorOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorOpenAi;
    if (priorGateway === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = priorGateway;
  }
});

test("a historical provider error is replaced before it reaches a user", async () => {
  const view = await toRenderView(
    {
      db: { get: async () => ({ name: "Red t-shirt" }) },
      storage: { getUrl: async () => null },
    },
    {
      _id: "render",
      outfitId: "outfit",
      avatarId: "avatar",
      jobId: "job",
      status: "failed",
      quality: "standard",
      creditsCharged: 1,
      error: "Missing environment variable AI_GATEWAY_API_KEY",
      createdAt: 1,
    },
  );
  assert.equal(view.error, RENDER_FAILED_MESSAGE);
  assert.ok(!JSON.stringify(view).includes("AI_GATEWAY_API_KEY"));
});
