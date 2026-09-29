import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";

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

// Keep real item, outfit, thread, agent and styling modules. Only Convex's database
// transport is in memory; no AI, provider, or network call ever runs.
globalThis.Convex = {
  async asyncSyscall(operation, args) {
    assert.equal(operation, "1.0/createFunctionHandle");
    return JSON.stringify(`handle:${JSON.parse(args).name}`);
  },
};

const items = await import("../convex/items.ts");
const agent = await import("../convex/agent.ts");
const styling = await import("../convex/styling.ts");
const { isConsideringItem, isOwnedItem } = await import("../convex/model/items.ts");
const { dayKey } = await import("../convex/shared/credits.ts");

const now = Date.parse("2026-10-03T12:00:00Z");

const baseItem = (id, overrides = {}) => ({
  userId: "owner",
  name: `Item ${id}`,
  category: "top",
  subcategory: "shirt",
  colours: { primary: "blue", secondary: [], hex: [] },
  pattern: "solid",
  material: "cotton",
  season: ["summer"],
  formality: "casual",
  description: `Synthetic ${id} blue shirt`,
  searchText: `item ${id} blue shirt top cotton summer casual`,
  status: "ready",
  wearCount: 0,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

function fixture() {
  const tables = {
    users: new Map(),
    items: new Map(),
    uploads: new Map(),
    jobs: new Map(),
    outfits: new Map(),
    threads: new Map(),
    proposals: new Map(),
    creditLedger: new Map(),
    usageCounters: new Map(),
    dailyStats: new Map(),
    systemCounters: new Map(),
    itemEmbeddings: new Map(),
    shoppingAdvice: new Map(),
  };
  let nextId = 0;
  const put = (table, id, data) =>
    tables[table].set(id, structuredClone({ ...data, _id: id, _creationTime: nextId++ }));
  const userFields = {
    plan: "free",
    planCredits: 0,
    packCredits: 25,
    dailySpend: { dayKey: dayKey(now), credits: 0 },
    features: [],
    prefs: { presentation: "neutral", fit: "regular", avoidColours: [] },
  };
  put("users", "owner", { clerkId: "owner-sub", ...userFields });
  put("users", "foreign", { clerkId: "foreign-sub", ...userFields });
  // Legacy row: no ownership field at all.
  put("items", "legacy-shirt", baseItem("legacy-shirt", { name: "Legacy Shirt" }));
  put("items", "owned-jeans", baseItem("owned-jeans", { name: "Owned Jeans", category: "bottom", ownership: "owned" }));
  put("items", "owned-trainers", baseItem("owned-trainers", { name: "Owned Trainers", category: "shoes", ownership: "owned" }));
  put("items", "saved-jacket", baseItem("saved-jacket", { name: "Saved Jacket", category: "outerwear", ownership: "considering", uploadId: "shopping-upload" }));
  put("items", "saved-dress", baseItem("saved-dress", { name: "Saved Dress", category: "dress", ownership: "considering", uploadId: "shopping-upload" }));
  put("items", "extracting-top", { ...baseItem("extracting-top"), status: "extracting" });
  put("items", "foreign-coat", baseItem("foreign-coat", { name: "Foreign Coat", category: "outerwear", userId: "foreign" }));
  put("uploads", "shopping-upload", {
    userId: "owner",
    batchId: "shopping:import-9",
    storageId: "blob-9",
    fileName: "Saved Jacket.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 4000,
    status: "done",
    source: "shopping",
    sourceTitle: "Field Jacket",
    sourcePageUrl: "https://shop.example.com/field-jacket",
    clientImportId: "import-9",
    createdAt: 1,
  });
  const tableRows = (table) => [...tables[table].values()];
  const db = {
    async get(id) {
      for (const rows of Object.values(tables)) if (rows.has(id)) return structuredClone(rows.get(id));
      return null;
    },
    async patch(id, fields) {
      for (const rows of Object.values(tables)) {
        if (!rows.has(id)) continue;
        const next = { ...rows.get(id) };
        for (const [key, value] of Object.entries(fields)) {
          if (value === undefined) delete next[key];
          else next[key] = structuredClone(value);
        }
        rows.set(id, next);
        return;
      }
      assert.fail(`Missing fixture row: ${id}`);
    },
    async insert(table, fields) {
      const id = `${table}-${++nextId}`;
      put(table, id, fields);
      return id;
    },
    async delete(...args) {
      const id = args.at(-1);
      for (const rows of Object.values(tables)) rows.delete(id);
    },
    normalizeId(_table, id) {
      for (const rows of Object.values(tables)) if (rows.has(id)) return id;
      return null;
    },
    query(table) {
      const filters = [];
      let descending = false;
      let search = null;
      const selected = () =>
        tableRows(table)
          .filter((row) => filters.every(([field, value]) => row[field] === value))
          .filter((row) => !search || row.searchText?.includes(search.term))
          .sort((a, b) => (descending ? -1 : 1) * (a._creationTime - b._creationTime));
      const fakeQuery = {
        eq(field, value) {
          filters.push([field, value]);
          return fakeQuery;
        },
        search(_field, term) {
          search = { term };
          return fakeQuery;
        },
      };
      const query = {
        withIndex(_name, build) {
          const chain = {
            eq(field, value) {
              filters.push([field, value]);
              return chain;
            },
          };
          build(chain);
          return query;
        },
        withSearchIndex(_name, build) {
          build(fakeQuery);
          return query;
        },
        order(direction) {
          descending = direction === "desc";
          return query;
        },
        async collect() {
          return structuredClone(selected());
        },
        async take(limit) {
          return structuredClone(selected().slice(0, limit));
        },
        async first() {
          return structuredClone(selected()[0] ?? null);
        },
        async unique() {
          assert.ok(selected().length <= 1);
          return structuredClone(selected()[0] ?? null);
        },
      };
      return query;
    },
  };
  const context = (subject = "owner-sub") => ({
    db,
    auth: {
      async getUserIdentity() {
        return subject ? { subject } : null;
      },
    },
    storage: {
      async getUrl(id) {
        return `https://storage.invalid/${id}`;
      },
      async delete() {},
    },
    async runMutation() {
      return "workflow-1";
    },
  });
  // db.system serves stored-blob metadata for assertStoredImage.
  db.system = {
    async get(_table, id) {
      if (id === "blob-shop") return { contentType: "image/jpeg", size: 4000 };
      return null;
    },
  };
  return { db, context, put, tableRows };
}

test.beforeEach(() => {
  mock.method(Date, "now", () => now);
  process.env.AGENT_SERVICE_KEY = "test-service-key";
});
test.afterEach(() => {
  mock.restoreAll();
  delete process.env.AGENT_SERVICE_KEY;
});

// ---------- Data / migration ----------

test("1: legacy undefined ownership is treated as owned", () => {
  const f = fixture();
  return f.db.get("legacy-shirt").then((row) => {
    assert.equal(row.ownership, undefined);
    assert.equal(isOwnedItem(row), true);
    assert.equal(isConsideringItem(row), false);
  });
});

test("2: a normal upload item behaves owned", async () => {
  const f = fixture();
  const view = (await items.list._handler(f.context(), {}));
  const names = view.map((item) => item.name);
  assert.ok(names.includes("Legacy Shirt"));
  assert.ok(names.includes("Owned Jeans"));
  for (const item of view) assert.equal(item.ownership, "owned");
});

test("3: a shopping import item becomes considering", async () => {
  const f = fixture();
  const view = await items.get._handler(f.context(), { itemId: "saved-jacket" });
  assert.equal(view?.item.ownership, "considering");
  assert.equal(isConsideringItem(await f.db.get("saved-jacket")), true);
});

test("4: ItemView normalizes ownership to owned/considering", async () => {
  const f = fixture();
  const legacy = await items.get._handler(f.context(), { itemId: "legacy-shirt" });
  assert.equal(legacy?.item.ownership, "owned");
  const saved = await items.get._handler(f.context(), { itemId: "saved-jacket" });
  assert.equal(saved?.item.ownership, "considering");
});

// ---------- Wardrobe ----------

test("5/7: default list excludes considering but keeps owned", async () => {
  const f = fixture();
  const names = (await items.list._handler(f.context(), {})).map((item) => item.name);
  assert.ok(!names.includes("Saved Jacket") && !names.includes("Saved Dress"));
  assert.ok(names.includes("Legacy Shirt") && names.includes("Owned Jeans") && names.includes("Owned Trainers"));
});

test("6: default search excludes considering candidates", async () => {
  const f = fixture();
  const names = (await items.search._handler(f.context(), { query: "blue" })).map((item) => item.name);
  assert.ok(!names.includes("Saved Jacket"));
  assert.ok(names.includes("Legacy Shirt"));
});

test("8/9: saved-shopping query returns considering only, foreign rows inaccessible", async () => {
  const f = fixture();
  const { listSavedShoppingItems } = await import("../convex/model/shoppingImports.ts");
  const owner = await f.db.get("owner");
  const saved = await listSavedShoppingItems({ db: f.db }, owner);
  const names = saved.map((entry) => entry.item.name);
  assert.ok(names.includes("Saved Jacket") && names.includes("Saved Dress"));
  assert.ok(!names.includes("Legacy Shirt") && !names.includes("Owned Jeans"));
  const [jacket] = saved.filter((entry) => entry.item.name === "Saved Jacket");
  assert.equal(jacket.sourceTitle, "Field Jacket");
  assert.equal(jacket.sourcePageUrl, "https://shop.example.com/field-jacket");
  assert.equal(jacket.item.ownership, "considering");
  const foreign = await f.db.get("foreign");
  assert.deepEqual(await listSavedShoppingItems({ db: f.db }, foreign), []);
});

// ---------- General stylist ----------

test("10/11/12: the agent wardrobe context excludes considering, keeps owned", async () => {
  const f = fixture();
  const wardrobe = await agent.getWardrobe._handler(f.context(), {
    serviceKey: "test-service-key",
    clerkUserId: "owner-sub",
  });
  const names = wardrobe.map((item) => item.name);
  assert.ok(!names.includes("Saved Jacket") && !names.includes("Saved Dress"));
  assert.ok(names.includes("Legacy Shirt") && names.includes("Owned Jeans"));
});

// ---------- Style this item ----------

test("13/14: a selected considering hero is allowed and forced into every suggestion", async () => {
  const f = fixture();
  const { persistStylingSuggestions } = await import("../convex/model/styling.ts");
  const owner = await f.db.get("owner");
  const result = await persistStylingSuggestions({ db: f.db }, owner, "saved-jacket", [
    { name: "Field look", reasoning: "Works.", slots: { outerwear: "saved-jacket", bottom: "owned-jeans", shoes: "owned-trainers", accessories: [] } },
  ]);
  assert.equal(result.suggestions.length, 1);
  const outfit = await f.db.get(result.suggestions[0].outfitId);
  assert.equal(outfit.slots.outerwear, "saved-jacket");
});

test("15: complementary items must be owned only", async () => {
  const f = fixture();
  const { persistStylingSuggestions } = await import("../convex/model/styling.ts");
  const owner = await f.db.get("owner");
  const result = await persistStylingSuggestions({ db: f.db }, owner, "saved-jacket", [
    { name: "Two candidates", reasoning: "Works.", slots: { outerwear: "saved-jacket", dress: "saved-dress", accessories: [] } },
  ]);
  assert.equal(result.suggestions.length, 0, "a second considering complement is rejected");
  assert.equal(result.threadId, undefined, "no thread for an empty result");
});

test("16: a second considering item is rejected as a complement", async () => {
  const f = fixture();
  const owner = await f.db.get("owner");
  const { validateSlots } = await import("../convex/model/outfits.ts");
  const problems = await validateSlots(
    { db: f.db },
    owner,
    { outerwear: "saved-jacket", dress: "saved-dress", accessories: [] },
    true,
  );
  assert.ok(problems.some((problem) => problem.includes("saved for later")));
});

test("17: a selected owned hero still works", async () => {
  const f = fixture();
  const result = await styling.suggestOutfits._handler(
    {
      auth: { async getUserIdentity() { return { subject: "owner-sub" }; } },
      db: f.db,
      runQuery: async (_ref, args) => styling.stylingContext._handler({ db: f.db }, args),
      runMutation: async (_ref, args) => {
        if ("suggestions" in args) return styling.persistStyling._handler({ db: f.db }, args);
        return styling.consumeStylingTurn._handler({ db: f.db }, args);
      },
      runAction: async () => ({
        suggestions: [
          { name: "Owned look", reasoning: "Works.", slots: { top: "legacy-shirt", bottom: "owned-jeans", shoes: "owned-trainers", accessories: [] } },
        ],
        usage: { inputTextTokens: 10, outputTokens: 10 },
      }),
    },
    { itemId: "legacy-shirt" },
  );
  assert.equal(result.suggestions.length, 1);
});

// ---------- Lifecycle ----------

test("18: markOwned moves considering to owned", async () => {
  const f = fixture();
  await items.markOwned._handler(f.context(), { itemId: "saved-jacket" });
  assert.equal((await f.db.get("saved-jacket")).ownership, "owned");
  assert.equal((await items.get._handler(f.context(), { itemId: "saved-jacket" }))?.item.ownership, "owned");
});

test("19: markOwned on an owned item is an idempotent no-op", async () => {
  const f = fixture();
  await items.markOwned._handler(f.context(), { itemId: "legacy-shirt" });
  await items.markOwned._handler(f.context(), { itemId: "legacy-shirt" });
  assert.equal((await f.db.get("legacy-shirt")).ownership, undefined, "legacy rows stay untouched");
});

test("20: foreign markOwned is rejected", async () => {
  const f = fixture();
  await assert.rejects(items.markOwned._handler(f.context("foreign-sub"), { itemId: "saved-jacket" }), (error) => error?.data?.code === "NOT_FOUND");
  assert.equal((await f.db.get("saved-jacket")).ownership, "considering");
});

test("21: unready items cannot change ownership", async () => {
  const f = fixture();
  await assert.rejects(items.markOwned._handler(f.context(), { itemId: "extracting-top" }), (error) => error?.data?.code === "INVALID_INPUT");
});

test("22/23/24: markOwned performs no extraction, charges nothing, keeps embedding and provenance", async () => {
  const f = fixture();
  const embId = await f.db.insert("itemEmbeddings", { itemId: "saved-jacket", userId: "owner", embedding: [0.1] });
  assert.ok(embId);
  const before = await f.db.get("saved-jacket");
  await items.markOwned._handler(f.context(), { itemId: "saved-jacket" });
  const after = await f.db.get("saved-jacket");
  assert.equal(after.ownership, "owned");
  assert.equal(after.storageId, before.storageId);
  assert.equal(f.tableRows("creditLedger").length, 0, "no credit movement");
  assert.equal(f.tableRows("itemEmbeddings").length, 1, "embedding retained");
  const upload = await f.db.get("shopping-upload");
  assert.equal(upload.sourceTitle, "Field Jacket", "provenance retained");
});

test("remove works for considering items through the existing mutation", async () => {
  const f = fixture();
  await items.remove._handler(f.context(), { itemIds: ["saved-dress"] });
  assert.equal(await f.db.get("saved-dress"), null);
  assert.ok(await f.db.get("saved-jacket"), "other items untouched");
});

// ---------- Duplicates ----------

test("26: a shopping candidate can flag an owned duplicate", async () => {
  const f = fixture();
  const { readyItemsForEmbeddings } = await import("../convex/model/items.ts");
  const embJacket = await f.db.insert("itemEmbeddings", { itemId: "saved-jacket", userId: "owner", embedding: [0.1] });
  const embJeans = await f.db.insert("itemEmbeddings", { itemId: "owned-jeans", userId: "owner", embedding: [0.2] });
  const targets = await readyItemsForEmbeddings({ db: f.db }, [embJacket, embJeans], "owned-jeans");
  assert.ok(targets.includes("saved-jacket"), "considering candidates stay comparable");
});

test("27: owned duplicates sort ahead of considering ones", async () => {
  const f = fixture();
  const { readyItemsForEmbeddings } = await import("../convex/model/items.ts");
  const embDress = await f.db.insert("itemEmbeddings", { itemId: "saved-dress", userId: "owner", embedding: [0.1] });
  const embJeans = await f.db.insert("itemEmbeddings", { itemId: "owned-jeans", userId: "owner", embedding: [0.2] });
  const [first, second] = await readyItemsForEmbeddings({ db: f.db }, [embDress, embJeans], "legacy-shirt");
  assert.equal(first, "owned-jeans");
  assert.equal(second, "saved-dress");
});

// ---------- Limits / security ----------

test("28: considering items count toward the bounded total limit", async () => {
  const f = fixture();
  const { countReady } = await import("../convex/model/items.ts");
  // 3 owned ready + 2 considering ready = 5 against the same ceiling.
  assert.equal(await countReady({ db: f.db }, "owner"), 5);
});

test("29: clients cannot set ownership through items.update", async () => {
  const f = fixture();
  const source = (await import("node:fs")).readFileSync(
    fileURLToPath(new URL("../convex/items.ts", import.meta.url)),
    "utf8",
  );
  const patch = source.slice(source.indexOf("patch: v.object({"), source.indexOf("returns: v.null(),"));
  assert.ok(!patch.includes("ownership"), "the update validator has no ownership field");
  // Even past the validator, the model allowlist drops unknown keys instead of writing them.
  await items.update._handler(f.context(), {
    itemId: "saved-jacket",
    patch: { name: "Renamed Jacket", ownership: "owned" },
  });
  const row = await f.db.get("saved-jacket");
  assert.equal(row.name, "Renamed Jacket", "legitimate fields still apply");
  assert.equal(row.ownership, "considering", "smuggled ownership is ignored");
});

test("30: shopping registration cannot request ownership", async () => {
  const f = fixture();
  const { readFileSync } = await import("node:fs");
  const read = (file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
  // Input-only check: ownership strings elsewhere in these files are outputs
  // (status views, saved-shopping entries), never a registration input.
  const model = read("../convex/model/shoppingImports.ts");
  const registerBody = model.slice(
    model.indexOf("export async function registerShoppingImport"),
    model.indexOf("export async function readShoppingImportStatus"),
  );
  assert.ok(!registerBody.includes("ownership"), "registration never reads an ownership input");
  const inputType = model.slice(model.indexOf("export type ShoppingImportInput"), model.indexOf("export type ShoppingImportState"));
  assert.ok(!inputType.includes("ownership"), "the registration input type has no ownership field");
  const api = read("../convex/shoppingImports.ts");
  const registerArgs = api.slice(api.indexOf("export const register = mutation({"), api.indexOf("export const status = query({"));
  assert.ok(!registerArgs.includes("ownership"), "the public register validator has no ownership field");
  const { registerShoppingImport } = await import("../convex/model/shoppingImports.ts");
  const owner = await f.db.get("owner");
  const { uploadId } = await registerShoppingImport({ db: f.db, runMutation: async () => "workflow-1" }, owner, {
    storageId: "blob-shop",
    fileName: "Shop.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 4000,
    clientImportId: "import-owned-sneak",
    ownership: "owned",
  });
  const upload = await f.db.get(uploadId);
  assert.ok(upload, "registration succeeds; the extra field is inert");
});

test("31: no Live Mirror interaction in the ownership surface", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["../convex/items.ts", "../convex/model/items.ts", "../convex/model/shoppingImports.ts"]) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    assert.ok(!source.includes("liveMirror") && !source.includes("LiveMirror"), `${file} is Live Mirror free`);
  }
});
