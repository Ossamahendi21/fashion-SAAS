import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "eve/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..", "..", "..");
const evejs = path.join(repo, "node_modules", "eve", "bin", "eve.js");

async function start() {
  const child = spawn(process.execPath, [evejs, "dev", "--no-ui", "--port", "0"], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stderr.write("[eve] " + d));
  child.stderr.on("data", (d) => process.stderr.write("[eve!] " + d));
  const statePath = path.join(__dirname, ".eve", "dev-server-state.v1.json");
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const { url } = JSON.parse(await readFile(statePath, "utf8"));
      if (url) return { child, url };
    } catch {}
    await delay(500);
  }
  throw new Error("dev server did not become ready");
}

const { child, url } = await start();
console.log("URL", url);
try {
  const client = new Client({ host: url });
  console.log("HEALTH", JSON.stringify(await client.health()));
  const { response, session } = await client.sessions.create({
    message: "give me two casual outfits",
  });
  const result = await response.result();
  console.log("STATUS", result.status);
  console.log("MESSAGE", JSON.stringify(result.message));
  console.log("INPUT_REQUESTS", JSON.stringify(result.inputRequests));
  console.log("EVENT_TYPES", JSON.stringify(result.events.map((e) => e.type)));
  console.log("EVENTS", JSON.stringify(result.events, null, 2));
  console.log("SESSION_ID", session.state.sessionId);
} catch (error) {
  console.error("DRIVER_ERROR", error);
  process.exitCode = 1;
} finally {
  child.kill();
}