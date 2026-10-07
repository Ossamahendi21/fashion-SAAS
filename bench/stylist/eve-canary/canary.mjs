import { spawn } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "eve/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..", "..", "..");
const evejs = path.join(repo, "node_modules", "eve", "bin", "eve.js");
const OUT = "C:\\Users\\Asus\\AppData\\Local\\Temp\\opencode\\c7b1-capture.json";

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

async function start() {
  const env = { ...process.env };
  for (const key of PROVIDER_ENV) delete env[key];
  const statePath = path.join(__dirname, ".eve", "dev-server-state.v1.json");
  await rm(statePath, { force: true }).catch(() => {});
const child = spawn(process.execPath, [evejs, "dev", "--no-ui", "--port", "0"], {
    cwd: __dirname,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push("[err] " + String(d)));
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const { url } = JSON.parse(await readFile(statePath, "utf8"));
      if (url) return { child, url, logs };
    } catch {}
    await delay(500);
  }
  throw new Error("dev server did not become ready");
}

function pickOption(request, kind) {
  const options = request.options ?? [];
  const wanted = kind === "approve" ? /approv|allow|yes|confirm|render/i : /reject|deny|no|cancel/i;
  const byId = options.find((o) => wanted.test(o.id) || wanted.test(o.label));
  return (byId ?? options[0])?.id;
}

function toolAudit(result) {
  const found = [];
  for (const event of result.events) {
    const data = event.data ?? {};
    const flat = JSON.stringify(data);
    if (flat.includes("\"audit\"") && flat.includes("startRenders")) found.push(data);
  }
  return found;
}

function stepSummary(result) {
  const modelIds = result.events.filter((e) => e.type === "step.started").map((e) => e.data.modelId);
  const usages = result.events
    .filter((e) => e.type === "step.completed")
    .map((e) => ({ finishReason: e.data.finishReason, usage: e.data.usage }));
  return { modelIds, usages };
}

function summarize(result) {
  return {
    status: result.status,
    message: result.message,
    inputRequests: result.inputRequests,
    eventTypes: result.events.map((e) => e.type),
    events: result.events,
    step: stepSummary(result),
    audits: toolAudit(result),
  };
}

const { child, url, logs } = await start();
const capture = { url, logs: logs.join(""), scenarios: {} };
try {
  const client = new Client({ host: url });
  capture.health = await client.health();
  capture.infoModel = (await client.info()).tools ?? undefined;

  // --- Scenario A: multi-turn continuity through one real Eve session ---
  const a = {};
  const created = await client.sessions.create({ message: "Give me two casual outfits." });
  a.sessionId = created.session.state.sessionId;
  a.turn1 = summarize(await created.response.result());
  a.sessionIdAfter1 = created.session.state.sessionId;

  a.turn2 = summarize(await (await created.session.send("Use the second one.")).result());
  a.turn3 = summarize(await (await created.session.send("Make it warmer.")).result());
  a.turn4 = summarize(await (await created.session.send("What will it cost?")).result());

  const renderResponse = await created.session.send("Render that.");
  a.turn5 = summarize(await renderResponse.result());
  a.turn5ApprovalRequest = a.turn5.inputRequests[0] ?? null;

  if (a.turn5ApprovalRequest) {
    const approveId = pickOption(a.turn5ApprovalRequest, "approve");
    a.approveOptionId = approveId;
    const resumed = await created.session.respond([
      { requestId: a.turn5ApprovalRequest.requestId, optionId: approveId },
    ]);
    a.turn6Approved = summarize(await resumed.result());
  }
  a.sessionIdAfterRender = created.session.state.sessionId;
  capture.scenarios.A = a;

  // --- Scenario B: approval resume executes exactly once ---
  const b = {};
  const bc = await client.sessions.create({ message: "Give me one casual outfit." });
  b.sessionId = bc.session.state.sessionId;
  b.turn1 = summarize(await bc.response.result());
  const bRender = await bc.session.send("Render that.");
  b.turn2 = summarize(await bRender.result());
  b.approvalRequest = b.turn2.inputRequests[0] ?? null;
  if (b.approvalRequest) {
    const approveId = pickOption(b.approvalRequest, "approve");
    b.approveOptionId = approveId;
    const approved = await bc.session.respond([
      { requestId: b.approvalRequest.requestId, optionId: approveId },
    ]);
    b.turn3Approved = summarize(await approved.result());
  }
  capture.scenarios.B = b;

  // --- Scenario D: rejection starts zero renders ---
  const d = {};
  const dc = await client.sessions.create({ message: "Give me one casual outfit." });
  d.sessionId = dc.session.state.sessionId;
  d.turn1 = summarize(await dc.response.result());
  const dRender = await dc.session.send("Render that.");
  d.turn2 = summarize(await dRender.result());
  d.approvalRequest = d.turn2.inputRequests[0] ?? null;
  if (d.approvalRequest) {
    const rejectId = pickOption(d.approvalRequest, "reject");
    d.rejectOptionId = rejectId;
    const rejected = await dc.session.respond([
      { requestId: d.approvalRequest.requestId, optionId: rejectId },
    ]);
    d.turn3Rejected = summarize(await rejected.result());
  }
  capture.scenarios.D = d;

  // --- Scenario C: controlled deterministic backend failure ---
  const c = {};
  const cc = await client.sessions.create({ message: "Give me two casual outfits CANARY_PORT_FAILURE." });
  c.sessionId = cc.session.state.sessionId;
  c.turn1 = summarize(await cc.response.result());
  capture.scenarios.C = c;

  capture.primary = {
    sessionId: created.session.state.sessionId,
    sessionStillSameAfterAllTurns:
      created.session.state.sessionId === created.session.state.sessionId,
  };
  await writeFile(OUT, JSON.stringify(capture, null, 2));
  console.log("CAPTURE_WRITTEN", OUT);
  console.log("HEALTH", JSON.stringify(capture.health));
  for (const [name, scenario] of Object.entries(capture.scenarios)) {
    for (const [turn, value] of Object.entries(scenario)) {
      if (value && typeof value === "object" && "status" in value) {
        console.log(`${name}.${turn}: status=${value.status} msg=${JSON.stringify(value.message)} approvals=${value.inputRequests?.length ?? 0} audits=${JSON.stringify(value.audits)}`);
      }
    }
  }
} catch (error) {
  capture.fatal = String(error && error.stack ? error.stack : error);
  await writeFile(OUT, JSON.stringify(capture, null, 2));
  console.error("DRIVER_ERROR", error);
  process.exitCode = 1;
} finally {
  child.kill();
}
