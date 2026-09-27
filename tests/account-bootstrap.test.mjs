import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const fixtureKey = "__fitcheckAccountBootstrap";
const f = `globalThis.${fixtureKey}`;
const sourceFiles = [
  "src/components/layout/app-shell.tsx",
  "src/components/layout/app-frame.tsx",
  "src/components/layout/onboarding-gate.tsx",
  "src/components/providers/navigation-data.tsx",
  "src/components/providers/store-user.tsx",
  "src/hooks/use-current-user.ts",
];
const sourceUrls = new Set(sourceFiles.map((file) => new URL(`../${file}`, import.meta.url).href));
const protectedQuery = `function read(key,args){const f=${f};f.calls.push([key,args]);if(args==='skip')return undefined;if(key==='users.me')return f.user;if(!f.authenticated||!f.user||f.user.clerkId!==f.userId)throw new Error('Protected query before account setup: '+key);return []}`;
const mocks = {
  "@clerk/nextjs": `export function useAuth(){return {userId:${f}.userId}}`,
  "@clerk/nextjs/experimental": "export function useSubscription(){return {data:undefined}}",
  "convex/react": `${protectedQuery};export function useConvexAuth(){return {isAuthenticated:${f}.authenticated,isLoading:${f}.authLoading}};export const useQuery=read;export function usePaginatedQuery(key,args){read(key,args);return {results:[],status:'Exhausted'}};export function useMutation(){return async()=>{${f}.ensures++}};export function useAction(){return async()=>{${f}.refreshes++}}`,
  "@convex/_generated/api": `export const api={users:{me:'users.me',ensure:'users.ensure'},subscriptions:{refresh:'subscriptions.refresh'},items:{list:'items.list',hasAny:'items.hasAny'},avatars:{list:'avatars.list'},outfits:{list:'outfits.list',listSummaries:'outfits.listSummaries'},renders:{listMine:'renders.listMine'}}`,
  "next/navigation": `export function usePathname(){return ${f}.path};export function useRouter(){return {replace(path){${f}.redirects.push(path)}}}`,
  "@/components/stylist/stylist-provider":
    "export function StylistProvider({children}){return children};export function useStylistPanel(){return {open:false}}",
  "@/components/stylist/stylist-panel": `${protectedQuery};export function StylistPanel(){read('threads.list',{});return 'STYLIST'}`,
  "./topbar": `${protectedQuery};export function Topbar(){read('credits.balance',{});read('jobs.listActive',{});return 'TOPBAR'}`,
  "@/components/common/error-alert": "export function ErrorAlert(){return 'ACCOUNT_ERROR'}",
  "@/components/common/page-skeleton": "export function PageSkeleton(){return 'PAGE_SKELETON'}",
  "@/components/onboarding/onboarding-skeleton": "export function OnboardingSkeleton(){return 'ONBOARDING_SKELETON'}",
  "@/hooks/use-clerk-plan": "export function useClerkPlan(){return {planId:'free'}}",
  "@/lib/errors": `export function reportError(error){${f}.errors.push(error.message)}`,
  "@/lib/utils": "export function cn(...values){return values.filter(Boolean).join(' ')}",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (sourceUrls.has(context.parentURL)) {
      if (mocks[specifier])
        return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
      if (specifier.startsWith("@/")) {
        const relative = `src/${specifier.slice(2)}`;
        const file = sourceFiles.find((candidate) => candidate.replace(/\.tsx?$/, "") === relative) ?? `${relative}.ts`;
        return nextResolve(new URL(`../${file}`, import.meta.url).href, context);
      }
      if (specifier.startsWith(".")) return nextResolve(new URL(`${specifier}.tsx`, context.parentURL).href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (sourceUrls.has(url) && url.endsWith(".tsx"))
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

const { AppShell } = await import("../src/components/layout/app-shell.tsx");
const { OnboardingGate } = await import("../src/components/layout/onboarding-gate.tsx");
const { NavigationDataProvider } = await import("../src/components/providers/navigation-data.tsx");
const { StoreUser } = await import("../src/components/providers/store-user.tsx");

function fixture(overrides = {}) {
  return (globalThis[fixtureKey] = {
    authenticated: true,
    authLoading: false,
    userId: "clerk-a",
    user: null,
    path: "/wardrobe",
    calls: [],
    redirects: [],
    errors: [],
    ensures: 0,
    refreshes: 0,
    ...overrides,
  });
}
function readyUser(clerkId = "clerk-a", onboardedAt = 1) {
  return { _id: `stored-${clerkId}`, clerkId, onboardedAt };
}
function renderApp() {
  return renderToStaticMarkup(createElement(NavigationDataProvider, null, createElement(AppShell, null, "PAGE")));
}
function protectedCalls(state) {
  return state.calls.filter(([key, args]) => key !== "users.me" && args !== "skip");
}

test("first sign-in waits for the stored user before mounting credit, activity, stylist or page queries", () => {
  for (const user of [undefined, null]) {
    const state = fixture({ user });
    const html = renderApp();
    assert.deepEqual(protectedCalls(state), []);
    assert.doesNotMatch(html, /TOPBAR|STYLIST/);
    assert.match(html, /PAGE_SKELETON/);
    assert.match(html, user === null ? /Setting up your Fitcheck account/ : /Loading your account/);
  }
});

test("a matching stored user mounts the complete app and shared navigation queries", () => {
  const state = fixture({ user: readyUser() });
  const html = renderApp();
  assert.match(html, /TOPBAR/);
  assert.match(html, /STYLIST/);
  assert.match(html, />PAGE<\/main>/);
  assert.doesNotMatch(html, /SKELETON/);
  for (const key of [
    "credits.balance",
    "jobs.listActive",
    "threads.list",
    "items.list",
    "outfits.list",
    "renders.listMine",
  ])
    assert.ok(
      protectedCalls(state).some(([called]) => called === key),
      key,
    );
});

test("account switching discards the previous user's result before any protected read", () => {
  const state = fixture({ user: readyUser(), userId: "clerk-b" });
  assert.match(renderApp(), /Setting up your Fitcheck account/);
  assert.deepEqual(protectedCalls(state), []);
  state.user = readyUser("clerk-b");
  assert.match(renderApp(), /TOPBAR/);
  assert.ok(protectedCalls(state).length > 0);
});

test("sign-out and unverified Convex auth cannot unlock a cached account", () => {
  for (const overrides of [{ authenticated: false }, { authenticated: false, authLoading: true }, { userId: null }]) {
    const state = fixture({ user: readyUser(), ...overrides });
    assert.doesNotMatch(renderApp(), /TOPBAR|STYLIST/);
    assert.deepEqual(protectedCalls(state), []);
    if (!state.authenticated) assert.ok(state.calls.every(([, args]) => args === "skip"));
  }
});

test("onboarding remains accessible after provisioning and other app content waits for its redirect", () => {
  const state = fixture({ user: readyUser("clerk-a", undefined), path: "/onboarding" });
  // Omit the onboarding marker rather than allowing the default argument to supply it.
  delete state.user.onboardedAt;
  assert.match(renderApp(), /TOPBAR/);
  state.calls = [];
  state.path = "/wardrobe";
  assert.match(renderApp(), /PAGE_SKELETON/);
  assert.ok(!protectedCalls(state).some(([key]) => key === "credits.balance" || key === "threads.list"));
});

test("public children stay visible while provisioning is pending or signed out", () => {
  for (const authenticated of [true, false]) {
    const state = fixture({ authenticated });
    const html = renderToStaticMarkup(createElement(NavigationDataProvider, null, "PUBLIC_SIGN_IN"));
    assert.equal(html, "PUBLIC_SIGN_IN");
    assert.deepEqual(protectedCalls(state), []);
  }
});

test("account setup and retry state are keyed to identity while normal navigation preserves them", () => {
  const state = fixture();
  const firstBootstrap = StoreUser();
  const firstGate = OnboardingGate({ children: "PAGE" });
  state.path = "/outfits";
  assert.equal(StoreUser().key, firstBootstrap.key);
  assert.equal(OnboardingGate({ children: "PAGE" }).key, firstGate.key);
  state.userId = "clerk-b";
  assert.notEqual(StoreUser().key, firstBootstrap.key);
  assert.notEqual(OnboardingGate({ children: "PAGE" }).key, firstGate.key);
  state.authenticated = false;
  assert.equal(StoreUser(), null);
});
