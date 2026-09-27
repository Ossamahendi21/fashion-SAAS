import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
const { completeOnboarding } = await import("../convex/users.ts");

function fixture({ presentation = "neutral", onboardedAt, avatarOwner = "owner", subject = "owner-sub" } = {}) {
  const user = { _id: "owner", clerkId: "owner-sub", prefs: { presentation }, onboardedAt };
  const patches = [];
  return {
    user,
    patches,
    ctx: {
      auth: { getUserIdentity: async () => (subject ? { subject } : null) },
      db: {
        query(table) {
          const filters = [];
          const index = {
            eq: (key, value) => {
              filters.push([key, value]);
              return index;
            },
          };
          const doc = table === "users" ? user : { _id: "avatar", userId: avatarOwner };
          const result = () => (filters.every(([key, value]) => doc[key] === value) ? doc : null);
          return {
            withIndex: (_name, build) => {
              build(index);
              return { unique: async () => result(), first: async () => result() };
            },
          };
        },
        async patch(id, patch) {
          assert.equal(id, user._id);
          patches.push(patch);
          Object.assign(user, patch);
        },
      },
    },
  };
}
const hasCode = (code) => (error) => error.data?.code === code;

test("public onboarding completion rejects the default neutral preference without writing completion", async () => {
  const f = fixture();
  await assert.rejects(completeOnboarding._handler(f.ctx, {}), hasCode("INVALID_INPUT"));
  assert.equal(f.user.onboardedAt, undefined);
  assert.deepEqual(f.patches, []);
});

test("both explicit wardrobe choices complete once and keep the same completion timestamp on retry", async () => {
  for (const presentation of ["masculine", "feminine"]) {
    const f = fixture({ presentation });
    assert.equal(await completeOnboarding._handler(f.ctx, {}), null);
    assert.equal(typeof f.user.onboardedAt, "number");
    const timestamp = f.user.onboardedAt;
    await completeOnboarding._handler(f.ctx, {});
    assert.equal(f.user.onboardedAt, timestamp);
    assert.equal(f.patches.length, 1);
  }
});

test("already-onboarded neutral accounts stay compatible and are not rewritten", async () => {
  const f = fixture({ onboardedAt: 123 });
  assert.equal(await completeOnboarding._handler(f.ctx, {}), null);
  assert.equal(f.user.prefs.presentation, "neutral");
  assert.equal(f.user.onboardedAt, 123);
  assert.deepEqual(f.patches, []);
});

test("wardrobe choice cannot bypass authentication or use another account's avatar", async () => {
  for (const subject of [null, "foreign-sub"]) {
    const f = fixture({ presentation: "masculine", subject });
    await assert.rejects(completeOnboarding._handler(f.ctx, {}), hasCode("UNAUTHENTICATED"));
    assert.deepEqual(f.patches, []);
  }
  const f = fixture({ presentation: "feminine", avatarOwner: "foreign" });
  await assert.rejects(completeOnboarding._handler(f.ctx, {}), hasCode("INVALID_INPUT"));
  assert.deepEqual(f.patches, []);
});
