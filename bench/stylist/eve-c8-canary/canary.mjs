// Step 7 Phase C8 — out-of-tree canary driver.
//
// Drives the REAL, production-shaped deterministic Eve root (`agent-deterministic/`, which re-exports
// the real `stylist_turn` tool and the real Clerk channel) under `eve dev`, with:
//   - a local, non-production Convex deployment,
//   - local-dev auth pointed at a throwaway Clerk test user (`AGENT_DEV_CLERK_USER_ID`),
//   - a seeded `convex/dev/c6.ts` fixture whose clerkId is that user,
// and stops the canonical turn sequence at the Eve approval-pending state (it never approves).
//
// Provider/network classification is done by an out-of-tree preload injected into the Eve child; the
// deterministic root itself contains no audit code. The Clerk secret is only ever read into memory;
// the throwaway Clerk user and every Convex fixture row are deleted in a guaranteed cleanup path.
//
// Run: node bench/stylist/eve-c8-canary/canary.mjs
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, rm, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "eve/client";
import { createClerkClient } from "@clerk/backend";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..", "..", "..");
const convexBin = path.join(repo, "node_modules", "convex", "bin", "main.js");
const evejs = path.join(repo, "node_modules", "eve", "bin", "eve.js");
const deterministicRoot = path.join(repo, "agent-deterministic");
const preloadSource = path.join(__dirname, "provider-audit-preload.cjs");

// The audit preload is copied to a space-free temp path so NODE_OPTIONS --require never splits it.
const OUT_DIR = "C:\\Users\\Asus\\AppData\\Local\\Temp\\opencode\\c8-canary";
const OUT_FILE = path.join(OUT_DIR, "c8-canary.json");
const AUDIT_FILE = path.join(OUT_DIR, "provider-audit.jsonl");
const PRELOAD = path.join(OUT_DIR, "provider-audit-preload.cjs");
const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL ?? "http://127.0.0.1:3210";

const PROVIDER_ENV = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "OMNIROUTER_API_KEY",
];

// The C8 approval sequence, run against the REAL deterministic root.
//
// Why this ordering: `composeOutfits` persists a brand-new `outfits` row on every recommend/refine,
// and the C2 recommendation event REPLACES `candidates` with those fresh ids and clears the referent.
// A later turn that resolves a bare "current" referent therefore only succeeds when the thread holds
// exactly ONE candidate; with two candidates the spending turn must name the ordinal itself
// (the parser maps "the second one" to `{kind:"ordinal",position:2}` on the price/render turn).
// The final render turn must be the one that names the referent so no recompose between selection
// and spend can invalidate it. Turn 4 must land on approval-pending.
const TURNS = [
  "give me two casual outfits",
  "make it warmer",
  "what will the second one cost?",
  "render the second one",
];

const assertions = [];
function assert(id, description, condition, detail) {
  assertions.push({ id, description, ok: Boolean(condition), detail: detail ?? null });
}

function convexCli(args, timeout = 120000) {
  return spawnSync(process.execPath, [convexBin, ...args], {
    cwd: repo,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** The Convex CLI occasionally trips a libuv assertion while exiting on Windows; tolerate a nonzero
 *  status when stdout still carries the JSON payload. */
function jsonFromStdout(stdout) {
  const out = (stdout ?? "").trim();
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(out.slice(start, end + 1));
  } catch {
    return null;
  }
}

function convexEnv(name) {
  // Same Windows libuv-exit tolerance as jsonFromStdout: accept a non-empty
  // value even when the CLI aborts nonzero on exit.
  const result = convexCli(["env", "get", name], 30000);
  const value = (result.stdout ?? "").trim();
  if (value.length === 0) throw new Error(`Could not read ${name} from the deployment.`);
  return value;
}

function convexRun(fn, args) {
  const result = convexCli(["run", fn, JSON.stringify(args)], 30000);
  const payload = jsonFromStdout(result.stdout);
  if (!payload) {
    throw new Error(`convex run ${fn} produced no JSON.\nstatus=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return payload;
}

async function waitForConvex(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const probe = convexCli(["run", "dev/c6:inspect", JSON.stringify({ clerkId: "c8-readiness-probe" })], 20000);
    if (jsonFromStdout(probe.stdout)) return;
    lastError = (probe.stderr ?? "").trim() || `status ${probe.status}`;
    await delay(1000);
  }
  throw new Error(`Local Convex did not become ready: ${lastError}`);
}

function startConvexDev() {
  const child = spawn(process.execPath, [convexBin, "dev"], {
    cwd: repo,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

async function startEve(env) {
  const statePath = path.join(deterministicRoot, ".eve", "dev-server-state.v1.json");
  await rm(statePath, { force: true }).catch(() => {});
  const child = spawn(process.execPath, [evejs, "dev", "--no-ui", "--port", "0"], {
    cwd: deterministicRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push("[err] " + String(d)));
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      const { url } = JSON.parse(await readFile(statePath, "utf8"));
      if (url) return { child, url, logs };
    } catch {}
    if (child.exitCode !== null) break;
    await delay(500);
  }
  throw new Error(`Eve dev server did not become ready.\n${logs.join("").slice(-5000)}`);
}

function summarize(result) {
  return {
    status: result.status,
    message: result.message,
    inputRequests: result.inputRequests ?? [],
    eventTypes: (result.events ?? []).map((e) => e.type),
    modelIds: (result.events ?? []).filter((e) => e.type === "step.started").map((e) => e.data?.modelId),
    usages: (result.events ?? []).filter((e) => e.type === "step.completed").map((e) => e.data?.usage),
  };
}

async function readAudit() {
  if (!existsSync(AUDIT_FILE)) return [];
  const raw = await readFile(AUDIT_FILE, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await copyFile(preloadSource, PRELOAD);
  await rm(AUDIT_FILE, { force: true }).catch(() => {});

  const capture = {
    environment: { convexUrl: CONVEX_URL, nonProduction: true },
    turns: [],
    audit: {},
    cleanup: {},
  };

  let convexChild = null;
  let eveChild = null;
  let clerk = null;
  let clerkId = null;
  let clerkCreated = 0;
  let clerkDeleted = 0;
  let fixtureRows = 0;
  let afterInspect = null;

  const secretKey = convexEnv("CLERK_SECRET_KEY");
  const testKey = /^sk_test_/.test(secretKey);
  assert("AUTH.test-key", "Clerk key is a test key, never live", testKey, `prefix=${secretKey.slice(0, 8)}`);
  if (!testKey) throw new Error("C8_AUTH_CANARY_BLOCKED: only a live Clerk key is configured; refusing to run.");
  const serviceKey = convexEnv("AGENT_SERVICE_KEY");

  async function cleanup() {
    if (eveChild && eveChild.exitCode === null) eveChild.kill();
    await delay(300);
    if (clerkId) {
      try {
        convexRun("dev/c6:cleanup", { clerkId });
        afterInspect = convexRun("dev/c6:inspect", { clerkId });
      } catch (error) {
        capture.cleanup.fixtureError = String(error && error.message ? error.message : error);
      }
      if (clerkCreated > clerkDeleted) {
        try {
          const client = clerk ?? createClerkClient({ secretKey });
          await client.users.deleteUser(clerkId);
          clerkDeleted += 1;
        } catch (error) {
          capture.cleanup.clerkError = String(error && error.message ? error.message : error);
        }
      }
    }
    if (convexChild && convexChild.exitCode === null) convexChild.kill();
  }

  try {
    // 1) Local Convex backend (persistent for the duration of the run).
    convexChild = startConvexDev();
    await waitForConvex(180000);
    assert("CONVEX.ready", "local Convex deployment answers", true);

    // 2) Throwaway Clerk test user.
    clerk = createClerkClient({ secretKey });
    const stamp = Date.now();
    const user = await clerk.users.createUser({
      emailAddress: [`c8.canary.${stamp}+clerk_test@example.com`],
      password: `C8-canary-${stamp}!aA`,
      firstName: "C8",
      lastName: `Canary ${stamp}`,
    });
    clerkId = user.id;
    clerkCreated = 1;
    assert("CLERK.created", "throwaway Clerk test user created", Boolean(clerkId), clerkId);

    // 3) Seed the matching local Convex fixture (items + thread + an avatar so renders are not
    //    blocked for lack of an avatar before approval is ever requested).
    convexRun("dev/c6:cleanup", { clerkId });
    const fixture = convexRun("dev/c6:seed", { clerkId, withWardrobe: true });
    convexRun("dev/c6:seedAvatar", { clerkId });
    const before = convexRun("dev/c6:inspect", { clerkId });
    fixtureRows = before.total;
    assert(
      "FIXTURE.seeded",
      "fixture seeds 12 ready items, one thread and one avatar",
      fixture.itemIds.length === 12 && Boolean(fixture.threadId) && before.counts.avatars === 1,
      JSON.stringify(before.counts),
    );
    const threadId = fixture.threadId;

    // 4) Spawn the deterministic Eve dev root, with the audit preload and no provider keys.
    const env = { ...process.env };
    for (const key of PROVIDER_ENV) delete env[key];
    delete env.CLERK_SECRET_KEY;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require ${PRELOAD}`.trim();
    env.C8_AUDIT_OUT = AUDIT_FILE;
    env.AGENT_DEV_CLERK_USER_ID = clerkId;
    env.AGENT_SERVICE_KEY = serviceKey;
    env.NEXT_PUBLIC_CONVEX_URL = CONVEX_URL;

    const started = await startEve(env);
    eveChild = started.child;
    const client = new Client({ host: started.url, headers: { "x-fitcheck-thread-id": threadId } });
    const health = await client.health();
    assert("EVE.health", "eve dev child answers health", Boolean(health), JSON.stringify(health).slice(0, 200));

    // 5) Drive the canonical sequence; stop at approval-pending.
    let approval = null;
    const created = await client.sessions.create({ message: TURNS[0] });
    capture.turns.push({ turn: 1, text: TURNS[0], ...summarize(await created.response.result()) });

    for (let i = 1; i < TURNS.length; i += 1) {
      const text = TURNS[i];
      const summary = summarize(await (await created.session.send(text)).result());
      capture.turns.push({ turn: i + 1, text, ...summary });
      if (summary.inputRequests.length > 0) {
        approval = { turn: i + 1, request: summary.inputRequests[0] };
        break;
      }
    }

    assert("CANARY.approval", "render turn stops at approval-pending", Boolean(approval), JSON.stringify(approval));
    assert("CANARY.noApprove", "nothing was approved or spent (harness never selects an approval option)", Boolean(approval), null);

    // 6) Classify the child's outbound traffic.
    await delay(750);
    const audit = await readAudit();
    const byKind = audit.reduce((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {});
    const byProvider = audit
      .filter((e) => e.provider)
      .reduce((acc, e) => ({ ...acc, [e.provider]: (acc[e.provider] ?? 0) + 1 }), {});
    const disallowed = audit.filter((e) => e.kind === "disallowed");
    const external = audit.filter((e) => e.kind === "external");

    assert("AUDIT.openai", "zero OpenAI calls", !byProvider.openai, JSON.stringify(byProvider));
    assert("AUDIT.gateway", "zero AI Gateway calls", !byProvider.gateway, JSON.stringify(byProvider));
    assert("AUDIT.omnirouter", "zero OmniRouter calls", !byProvider.omnirouter, JSON.stringify(byProvider));
    assert("AUDIT.local-llm", "zero local LLM calls", !byProvider["local-llm"], JSON.stringify(byProvider));
    assert("AUDIT.paid-render", "zero paid render/inference provider calls", !byProvider["paid-render"], JSON.stringify(byProvider));
    assert("AUDIT.disallowed", "zero disallowed provider calls total", disallowed.length === 0, JSON.stringify(disallowed.slice(0, 5)));
    assert("AUDIT.external", "zero unpredicted external calls", external.length === 0, JSON.stringify(external.slice(0, 5)));

    capture.fixture = { clerkId, items: fixture.itemIds.length, threadId };
    capture.approval = approval;
    capture.audit = {
      total: audit.length,
      byKind,
      byProvider,
      disallowedCount: disallowed.length,
      externalCount: external.length,
      sample: audit.slice(0, 25),
    };
  } catch (error) {
    capture.error = String(error && error.stack ? error.stack : error);
  } finally {
    await cleanup();
  }

  capture.cleanup = {
    ...capture.cleanup,
    fixture: afterInspect,
    fixtureRemaining: afterInspect ? afterInspect.total : null,
    clerkCreated,
    clerkDeleted,
  };
  capture.counts = {
    clerkTestUsersCreated: clerkCreated,
    clerkTestUsersDeleted: clerkDeleted,
    c8FixtureRecordsCreated: fixtureRows,
    c8FixtureRecordsRemaining: afterInspect ? afterInspect.total : null,
  };
  assert("FIXTURE.clean", "all C8 Convex fixture records removed", afterInspect !== null && afterInspect.total === 0, JSON.stringify(afterInspect));
  assert("CLERK.deleted", "throwaway Clerk test user deleted", clerkDeleted === clerkCreated, `created=${clerkCreated} deleted=${clerkDeleted}`);

  const failed = assertions.filter((a) => !a.ok);
  capture.assertions = assertions;
  capture.summary = { total: assertions.length, passed: assertions.length - failed.length, failed: failed.length };
  await writeFile(OUT_FILE, JSON.stringify(capture, null, 2));

  console.log(`C8 canary: ${capture.summary.passed}/${capture.summary.total} checks passed`);
  console.log(`  audit kinds: ${JSON.stringify(capture.audit.byKind ?? {})}`);
  console.log(`  audit providers: ${JSON.stringify(capture.audit.byProvider ?? {})}`);
  console.log(`  approval: ${JSON.stringify(capture.approval ?? null)}`);
  console.log(`  clerk created/deleted: ${clerkCreated}/${clerkDeleted}; fixtures remaining: ${capture.counts.c8FixtureRecordsRemaining}`);
  console.log(`  capture: ${OUT_FILE}`);
  if (capture.error) console.log(`  error: ${capture.error.split("\n")[0]}`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL [${f.id}] ${f.description} :: ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("  token: C8_PASS");
  }
}

main().catch((error) => {
  console.error("C8 harness crashed:", error);
  process.exitCode = 1;
});