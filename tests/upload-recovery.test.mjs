import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { setImmediate as flush } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";
import { imageUploadMimeType } from "../src/lib/image-upload.ts";

const fixtureKey = "__fitcheckUploadRecovery";
const f = `globalThis.${fixtureKey}`;
const hookSource = `
export function useState(initial){const f=${f},i=f.cursor++;if(!(i in f.slots))f.slots[i]=typeof initial==='function'?initial():initial;return [f.slots[i],v=>{f.slots[i]=typeof v==='function'?v(f.slots[i]):v}]}
export function useRef(value){const f=${f},i=f.cursor++;return f.slots[i]??=( {current:value} )}
export function useEffect(effect){${f}.effects.push(effect)}
export function useCallback(callback){return callback}
`;
const apiSource =
  'export const api={uploads:{listBatch:"listBatch",createBatch:"createBatch",resume:"resume",generateUploadUrl:"generateItemUrl"},avatars:{generateUploadUrl:"generateAvatarUrl"},subscriptions:{refresh:"refresh"}}';
const shared = {
  react: hookSource,
  "convex/react": `export function useConvexAuth(){return {isAuthenticated:true}};export function useQuery(_key,args){return args==='skip'?undefined:${f}.batches.get(args.batchId)};export function useMutation(key){return ${f}.mutations[key]};export function useAction(){return async()=>{${f}.billingRefreshes++}}`,
  "@convex/_generated/api": apiSource,
};
const componentModules = {
  ...shared,
  "next/navigation": `export function useRouter(){return {replace(url){const f=${f};f.requestedBatchId=new URL(url,'https://fixture.invalid').searchParams.get('batch');if(!f.deferNavigation)f.batchId=f.requestedBatchId},push(){}}};export function useSearchParams(){return {get(){return ${f}.batchId}}}`,
  "next/link": "export default function Link(){}",
  sonner: `export const toast={success(){},warning(){},error(message){${f}.errors.push(message)}}`,
  "@/hooks/use-current-user": 'export function useCurrentUser(){return {user:{prefs:{presentation:"masculine"}}}}',
  "@/hooks/use-upload": `export function useUpload(){return ${f}.transport};export function isUploadSuccess(result){return result.storageId!==undefined}`,
  "@/lib/errors": 'export function toClientError(error){return {code:"UNKNOWN",message:error.message}}',
  "@/lib/format":
    'export function formatCredits(n){return `${n} credits`};export function pluralize(n,word){return `${n} ${word}${n===1?"":"s"}`}',
  "@/lib/routes": 'export const routes={add:"/add",wardrobe:"/wardrobe",settings:"/settings",billing:"/billing"}',
  "@convex/shared/credits": "export const LIMITS={maxPhotosPerUpload:50};export const CREDIT_COSTS={extractItem:1}",
  "@convex/shared/demo_wardrobe": "export const DEMO_WARDROBE=[]",
  "./drop-zone": 'export function DropZone(){};export function describeRejection(){return "Rejected"}',
};
for (const [specifier, name] of Object.entries({
  "@/components/common/error-alert": "ErrorAlert",
  "@/components/common/item-image": "ItemImage",
  "@/components/common/page-header": "PageHeader",
  "@/components/ui/button": "Button",
  "@/components/ui/skeleton": "Skeleton",
  "./pending-tile": "PendingTile",
  "./recent-uploads": "RecentUploads",
  "./upload-tile": "UploadTile",
  "./import-queue": "ImportQueue",
}))
  componentModules[specifier] = `export function ${name}(){}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isComponent = context.parentURL?.endsWith("/add-clothes.tsx");
    const isTransport = context.parentURL?.endsWith("/use-upload.ts");
    if (isComponent || isTransport) {
      if (specifier === "@/lib/image-upload")
        return nextResolve(new URL("../src/lib/image-upload.ts", import.meta.url).href, context);
      const source = (isComponent ? componentModules : shared)[specifier];
      if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/add-clothes.tsx"))
      return {
        format: "module",
        source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
          compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
        }).outputText,
        shortCircuit: true,
      };
    return nextLoad(url, context);
  },
});
const { AddClothes } = await import("../src/components/upload/add-clothes.tsx");
const { useUpload } = await import("../src/hooks/use-upload.ts");

function nodes(tree, name) {
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, name));
  if (!tree || typeof tree !== "object") return [];
  return [
    ...(tree.type === name || tree.type?.name === name ? [tree.props] : []),
    ...nodes(tree.props?.children, name),
  ];
}

function fixture({ failedNames = [], registrationFailures = 0, deferNavigation = false, deferRows = false } = {}) {
  const state = {
    slots: [],
    cursor: 0,
    effects: [],
    batchId: null,
    batches: new Map(),
    createdBatches: new Map(),
    deferNavigation,
    errors: [],
    billingRefreshes: 0,
    uploads: [],
    registrations: [],
    failedNames: new Set(failedNames),
    registrationFailures,
  };
  state.mutations = {
    createBatch: async ({ files }) => {
      state.registrations.push(structuredClone(files));
      if (state.registrationFailures-- > 0) throw new Error("Registration unavailable");
      const batchId = `batch-${state.registrations.length}`;
      const rows = files.map((file) => ({ upload: { _id: file.storageId, fileName: file.fileName } }));
      state.createdBatches.set(batchId, rows);
      if (!deferRows) state.batches.set(batchId, rows);
      return { batchId };
    },
    resume: async () => {},
    generateItemUrl: async () => "https://fixture.invalid/upload",
    generateAvatarUrl: async () => "https://fixture.invalid/avatar",
  };
  const upload = async (file, key) => {
    state.uploads.push({ name: file.name, key });
    if (state.failedNames.has(file.name)) throw new Error("Connection interrupted");
    return `stored-${state.uploads.length}`;
  };
  state.transport = {
    progress: {},
    upload,
    uploadMany: async (entries) =>
      Promise.all(
        entries.map(async ({ file, key }) => {
          try {
            return { file, key, storageId: await upload(file, key) };
          } catch (error) {
            return { file, key, error: error.message };
          }
        }),
      ),
  };
  const render = () => {
    globalThis[fixtureKey] = state;
    state.cursor = 0;
    state.effects = [];
    const tree = AddClothes();
    for (const effect of state.effects) effect();
    return tree;
  };
  return { state, render, drop: (files) => nodes(render(), "DropZone")[0].onDrop(files, []) };
}
const photo = (name, type = "image/jpeg") => new File(["fixture"], name, { type });

test("accepted photos stay visible through delayed navigation and subscription, then hand over once", async () => {
  const { state, render, drop } = fixture({
    failedNames: ["failed.jpg"],
    deferNavigation: true,
    deferRows: true,
  });
  await drop([photo("accepted.jpg"), photo("failed.jpg")]);
  let tree = render();
  assert.equal(state.batchId, null, "navigation has not committed yet");
  assert.equal(nodes(tree, "PendingTile").length, 2);
  assert.equal(nodes(tree, "PendingTile")[0].file.acceptedBatchId, state.requestedBatchId);
  assert.equal(nodes(tree, "PendingTile")[0].onRetry, undefined, "accepted photo cannot register again");
  assert.equal(
    nodes(tree, "section").some((props) => props["aria-labelledby"] === "scan-preview-heading"),
    false,
  );
  state.batchId = state.requestedBatchId;
  tree = render();
  assert.equal(nodes(tree, "PendingTile").length, 2, "tiles persist while the batch subscription is loading");
  assert.equal(nodes(tree, "UploadTile").length, 0);
  state.batches.set(state.batchId, state.createdBatches.get(state.batchId));
  tree = render();
  assert.deepEqual(
    nodes(tree, "PendingTile").map(({ file }) => file.name),
    ["failed.jpg"],
  );
  assert.deepEqual(
    nodes(tree, "UploadTile").map(({ row }) => row.upload.fileName),
    ["accepted.jpg"],
  );
  state.batchId = "older-batch";
  state.batches.set("older-batch", []);
  assert.deepEqual(
    nodes(render(), "PendingTile").map(({ file }) => file.name),
    ["failed.jpg"],
    "accepted tile never returns after handoff",
  );
  assert.equal(state.registrations.length, 1);
  assert.equal(state.uploads.length, 2);
});

test("successful photos become server rows while failed photos keep retry/dismiss controls", async () => {
  const { state, render, drop } = fixture({ failedNames: ["failed.jpg"] });
  await drop([photo("good.jpg"), photo("failed.jpg")]);
  let tree = render();
  assert.deepEqual(
    nodes(tree, "UploadTile").map(({ row }) => row.upload.fileName),
    ["good.jpg"],
  );
  const failed = nodes(tree, "PendingTile");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].file.name, "failed.jpg");
  assert.equal(typeof failed[0].onRetry, "function");
  assert.equal(typeof failed[0].onDismiss, "function");
  assert.equal(state.billingRefreshes, 0, "free scan registration never depends on billing");
  state.failedNames.clear();
  failed[0].onRetry();
  await flush();
  tree = render();
  assert.equal(nodes(tree, "PendingTile").length, 0);
  assert.deepEqual(
    state.uploads.map(({ name }) => name),
    ["good.jpg", "failed.jpg", "failed.jpg"],
  );
  assert.deepEqual(
    state.registrations.map((files) => files.map(({ fileName }) => fileName)),
    [["good.jpg"], ["failed.jpg"]],
  );
});

test("registration retry reuses its stored blob and never registers unrelated failed photos", async () => {
  const { state, render, drop } = fixture({ registrationFailures: 1 });
  await drop([photo("first.JPG", ""), photo("second.png", "")]);
  assert.equal(nodes(render(), "PendingTile").length, 2);
  assert.deepEqual(
    state.registrations[0].map(({ mimeType }) => mimeType),
    ["image/jpeg", "image/png"],
  );
  nodes(render(), "PendingTile")[0].onRetry();
  await flush();
  assert.equal(state.uploads.length, 2, "already stored data is not uploaded twice");
  assert.deepEqual(state.registrations[1], [state.registrations[0][0]]);
  assert.equal(nodes(render(), "PendingTile")[0].file.name, "second.png");
  nodes(render(), "PendingTile")[0].onDismiss();
  assert.equal(nodes(render(), "PendingTile").length, 0);
});

test("all-file failures remain actionable through another drop and opening earlier scans", async () => {
  const { state, render, drop } = fixture({ failedNames: ["first.jpg", "second.jpg"] });
  await drop([photo("first.jpg")]);
  await drop([photo("second.jpg")]);
  assert.equal(nodes(render(), "PendingTile").length, 2);
  nodes(render(), "RecentUploads")[0].onOpenBatch("older-batch");
  assert.equal(nodes(render(), "PendingTile").length, 2);
  assert.equal(state.registrations.length, 0);
  nodes(render(), "PendingTile")[0].onDismiss();
  assert.equal(nodes(render(), "PendingTile")[0].file.name, "second.jpg");
});

test("storage transport uses the same MIME fallback as registration and preserves explicit unsupported types", async () => {
  const { state } = fixture();
  globalThis[fixtureKey] = state;
  const requests = [];
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class {
    status = 200;
    responseText = JSON.stringify({ storageId: "mime-fixture" });
    events = new Map();
    headers = {};
    upload = { addEventListener() {}, removeEventListener() {} };
    open() {}
    setRequestHeader(key, value) {
      this.headers[key] = value;
    }
    addEventListener(key, value) {
      this.events.set(key, value);
    }
    removeEventListener(key) {
      this.events.delete(key);
    }
    send(file) {
      requests.push({ file, headers: this.headers });
      queueMicrotask(() => this.events.get("load")());
    }
  };
  try {
    function UploadTransportFixture() {
      return useUpload();
    }
    const transport = UploadTransportFixture();
    for (const file of [
      photo("PHOTO.JPG", ""),
      photo("piece.webp", ""),
      photo("misnamed.jpg", "text/plain"),
      photo("unknown", ""),
    ]) {
      await transport.upload(file);
      assert.equal(requests.at(-1).headers["Content-Type"], imageUploadMimeType(file));
    }
    assert.deepEqual(
      requests.map(({ headers }) => headers["Content-Type"]),
      ["image/jpeg", "image/webp", "text/plain", "application/octet-stream"],
    );
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test("stalled and aborted storage uploads release busy state, clean listeners, and allow retry", async () => {
  const { state } = fixture();
  globalThis[fixtureKey] = state;
  const requests = [];
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class {
    status = 200;
    responseText = JSON.stringify({ storageId: "retried-photo" });
    events = new Map();
    progressEvents = new Map();
    upload = {
      addEventListener: (name, callback) => this.progressEvents.set(name, callback),
      removeEventListener: (name) => this.progressEvents.delete(name),
    };
    open() {}
    setRequestHeader() {}
    addEventListener(name, callback) {
      this.events.set(name, callback);
    }
    removeEventListener(name) {
      this.events.delete(name);
    }
    send() {
      requests.push(this);
    }
  };
  const UploadTransportFixture = () => {
    state.cursor = 0;
    return useUpload();
  };
  try {
    for (const event of ["timeout", "abort", "error"]) {
      const result = UploadTransportFixture().uploadMany([{ key: event, file: photo(`${event}.jpg`) }]);
      await flush();
      const request = requests.at(-1);
      assert.equal(UploadTransportFixture().isUploading, true);
      assert.equal(request.timeout, 10 * 60 * 1000, "20 MB mobile uploads get a generous but finite deadline");
      request.events.get(event)();
      const [failed] = await result;
      assert.equal(failed.storageId, undefined);
      assert.match(failed.error, event === "timeout" ? /timed out.*retry/i : /try again/i);
      assert.equal(UploadTransportFixture().isUploading, false);
      assert.equal(request.events.size, 0, "terminal events cannot settle a finished request twice");
      assert.equal(request.progressEvents.size, 0, "late progress cannot update a finished request");
    }
    const retry = UploadTransportFixture().upload(photo("timeout.jpg"), "timeout");
    await flush();
    const request = requests.at(-1);
    request.events.get("load")();
    assert.equal(await retry, "retried-photo");
    const transport = UploadTransportFixture();
    assert.equal(transport.isUploading, false);
    assert.equal(transport.progress.timeout, 1);
    assert.equal(request.events.size, 0);
    assert.equal(request.progressEvents.size, 0);
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});
