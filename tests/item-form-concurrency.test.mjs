import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as flush } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compiled = ts.transpileModule(
  readFileSync(new URL("../src/components/wardrobe/item-form.tsx", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
).outputText;

function nodes(tree, name) {
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, name));
  if (!tree || typeof tree !== "object") return [];
  return [...(tree.type === name ? [tree.props] : []), ...nodes(tree.props?.children, name)];
}

function fixture() {
  const f = {
    item: {
      _id: "item-1",
      name: "Blue shirt",
      category: "top",
      subcategory: "shirt",
      colours: { primary: "blue", secondary: ["white"], hex: ["#0000ff"] },
      pattern: "striped",
      material: "cotton",
      season: ["summer"],
      formality: "casual",
      fit: "regular",
      brand: "Original brand",
      notes: "",
    },
    slots: [],
    calls: [],
    cursor: 0,
    ids: 0,
    changed: false,
    publishResult: true,
    wait: null,
    failure: null,
  };
  const mocks = {
    react: {
      useId: () => `field-${f.ids++}`,
      useState(initial) {
        const index = f.cursor++;
        if (!(index in f.slots)) f.slots[index] = typeof initial === "function" ? initial() : initial;
        return [
          f.slots[index],
          (next) => {
            f.slots[index] = typeof next === "function" ? next(f.slots[index]) : next;
            f.changed = true;
          },
        ];
      },
    },
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    "convex/react": {
      useMutation: () => async (args) => {
        f.calls.push(structuredClone(args));
        if (f.wait) await f.wait;
        if (f.failure) throw f.failure;
        if (f.publishResult) f.item = { ...f.item, ...args.patch };
      },
    },
    sonner: { toast: { success() {} } },
    "@/lib/errors": { reportError: (error) => ({ message: error.message }) },
    "@convex/_generated/api": { api: { items: { update: "update" } } },
    "@convex/shared/wardrobe": {
      CATEGORIES: ["top", "outerwear"],
      CATEGORY_LABELS: { top: "Top", outerwear: "Outerwear" },
      FITS: ["regular", "relaxed"],
      FORMALITY: ["casual", "smart"],
      FORMALITY_LABELS: {},
      SEASONS: ["summer", "winter"],
    },
  };
  const componentModule = { exports: {} };
  runInNewContext(compiled, {
    module: componentModule,
    exports: componentModule.exports,
    require(name) {
      if (name in mocks) return mocks[name];
      assert.ok(name === "lucide-react" || name.startsWith("@/components/") || name.startsWith("./"), name);
      return new Proxy({}, { get: (_, component) => component });
    },
  });
  f.render = () => {
    for (let i = 0; i < 10; i++) {
      f.cursor = 0;
      f.ids = 0;
      f.changed = false;
      const tree = componentModule.exports.ItemForm({ item: f.item });
      if (!f.changed) return tree;
    }
    throw new Error("The editor did not settle after a server update");
  };
  f.input = (id) => nodes(f.render(), "Input").find((props) => props.id === `field-${id}`);
  f.changeInput = (id, value) => f.input(id).onChange({ target: { value } });
  f.changeNotes = (value) => nodes(f.render(), "Textarea")[0].onChange({ target: { value } });
  f.save = () => nodes(f.render(), "form")[0].onSubmit({ preventDefault() {} });
  f.saveButton = () => nodes(f.render(), "Button").find((props) => props.type === "submit");
  return f;
}

test("a pristine editor adopts live attributes without becoming dirty", () => {
  const f = fixture();
  f.render();
  f.item = { ...f.item, name: "Renamed elsewhere", category: "outerwear", notes: "Remote note" };
  assert.equal(f.input(0).value, "Renamed elsewhere");
  assert.equal(nodes(f.render(), "Select")[0].value, "outerwear");
  assert.equal(nodes(f.render(), "Textarea")[0].value, "Remote note");
  assert.equal(f.saveButton().disabled, true);
});

test("dirty drafts survive live updates and only edited attributes are submitted", async () => {
  const f = fixture();
  f.changeNotes("  Dry clean only  ");
  f.item = { ...f.item, name: "Remote name", material: "linen", brand: "Remote brand" };
  assert.equal(nodes(f.render(), "Textarea")[0].value, "  Dry clean only  ");
  f.save();
  await flush();
  assert.deepEqual(f.calls, [{ itemId: "item-1", patch: { notes: "Dry clean only" } }]);
  assert.equal(f.input(0).value, "Remote name");
  assert.equal(f.input(5).value, "linen");
  assert.equal(nodes(f.render(), "Textarea")[0].value, "Dry clean only");
  assert.equal(f.saveButton().disabled, true);
});

test("editing primary colour keeps live secondary colours and hex values", async () => {
  const f = fixture();
  f.changeInput(2, "  navy  ");
  f.item = { ...f.item, colours: { primary: "blue", secondary: ["cream"], hex: ["#eeeecc"] } };
  f.save();
  await flush();
  assert.deepEqual(f.calls[0].patch, { colours: { primary: "navy", secondary: ["cream"], hex: ["#eeeecc"] } });
  assert.equal(f.input(2).value, "navy");
  assert.deepEqual(Array.from(nodes(f.render(), "ChipsInput")[0].value), ["cream"]);
});

test("a successful trimmed save is not rolled back by an unchanged stale prop", async () => {
  const f = fixture();
  f.publishResult = false;
  f.changeInput(0, "  My shirt  ");
  f.save();
  await flush();
  assert.equal(f.input(0).value, "My shirt");
  assert.equal(f.saveButton().disabled, true);
  assert.equal(f.item.name, "Blue shirt", "the query has not delivered the mutation result yet");
  f.item = { ...f.item, name: "My shirt" };
  assert.equal(f.input(0).value, "My shirt");
  assert.equal(f.saveButton().disabled, true);
});

test("live updates during Save are merged with accepted edits, and failed saves preserve drafts", async () => {
  const f = fixture();
  let finish;
  f.wait = new Promise((resolve) => {
    finish = resolve;
  });
  f.publishResult = false;
  f.changeNotes("Local note");
  f.save();
  f.item = { ...f.item, name: "Updated while saving" };
  assert.equal(f.input(0).disabled, true);
  finish();
  await flush();
  assert.equal(f.input(0).value, "Updated while saving");
  assert.equal(nodes(f.render(), "Textarea")[0].value, "Local note");
  f.failure = new Error("Offline");
  f.changeNotes("Retry this note");
  f.save();
  await flush();
  assert.equal(nodes(f.render(), "Textarea")[0].value, "Retry this note");
  assert.equal(f.saveButton().disabled, false);
  assert.equal(nodes(f.render(), "ErrorAlert")[0].message, "Offline");
});
