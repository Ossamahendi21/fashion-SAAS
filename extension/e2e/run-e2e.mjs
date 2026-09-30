// One-command shopping-extension browser E2E: `npm run test:e2e` in extension/.
//
// 1. Fresh production build (also proves the shippable bundle still compiles).
// 2. Assembles the test-only extension overlay (production build is never modified).
// 3. Starts the synthetic fixture server on 127.0.0.1 (reached as shop.e2e.ow via
//    Chrome host-resolver rules, so production private-network guards stay intact).
// 4. Runs the browser tests in real Chrome with the test extension loaded.
// 5. Cleans up the server and temp workdirs; the exit code is the tests' exit code.
//
// Zero paid providers anywhere: the harness room stubs every backend boundary and the
// test asserts no OpenAI/Gateway/Decart/Convex traffic was even attempted.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "./fixture/server.mjs";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = join(extensionDir, "e2e", ".work");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

const keepWork = process.env.E2E_KEEP_WORK === "1";
try {
  console.log("[e2e] building fresh production extension…");
  await run("npm", ["run", "build"], { cwd: extensionDir });
  console.log("[e2e] assembling test extension…");
  await run("node", ["e2e/scripts/assemble-test-extension.mjs"], { cwd: extensionDir });
  const server = await startFixtureServer();
  console.log(`[e2e] fixture server on 127.0.0.1:${server.port}`);
  const fixtureBrowserUrl = `http://shop.e2e.ow:${server.port}`;
  // Chrome resolves shop.e2e.ow via --host-resolver-rules; Node (log reads below)
  // uses system DNS, so it needs the literal loopback URL for the same server.
  const fixtureLocalUrl = `http://127.0.0.1:${server.port}`;
  try {
    await run("node", ["--test", "e2e/shopping-loop.e2e.mjs"], {
      cwd: extensionDir,
      env: {
        ...process.env,
        E2E_FIXTURE_URL: fixtureBrowserUrl,
        E2E_FIXTURE_LOCAL: fixtureLocalUrl,
        E2E_EXTENSION_DIR: join(workDir, "test-extension"),
      },
    });
    console.log("[e2e] PASS: shopping loop verified with zero provider calls");
  } finally {
    await server.stop();
  }
  if (!keepWork) rmSync(workDir, { recursive: true, force: true });
} catch (error) {
  console.error(`[e2e] FAIL: ${error.message}`);
  if (!keepWork) rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}
