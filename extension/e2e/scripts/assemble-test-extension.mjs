// Assembles the test-only extension for the shopping browser E2E.
//
// Copies a FRESH production build into e2e/.work/test-extension and overlays exactly
// one file: tabs/room.html boots the harness bundle (real Room + stub adapters +
// __owE2e log) instead of the production room chunk. The production build directory is
// never modified. Usage: node e2e/scripts/assemble-test-extension.mjs
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const baseBuild = join(extensionDir, "build", "chrome-mv3-prod");
const workDir = join(extensionDir, "e2e", ".work");
const testExtension = join(workDir, "test-extension");

const roomHtml = join(baseBuild, "tabs", "room.html");
if (!existsSync(roomHtml)) {
  console.error("missing production build: run `npm run build` in extension/ first");
  process.exit(1);
}

rmSync(workDir, { recursive: true, force: true });
mkdirSync(testExtension, { recursive: true });
cpSync(baseBuild, testExtension, { recursive: true });

const bundled = await build({
  entryPoints: [join(extensionDir, "e2e", "harness", "room-harness.tsx")],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  jsx: "automatic",
  loader: { ".css": "empty" },
  plugins: [
    {
      name: "e2e-auth-provider-stub",
      setup(build) {
        // Build-time only: the real Room mounts in the harness without Clerk/Convex.
        // Production bundles never see this substitution (see the bundle tests).
        build.onResolve({ filter: /lib\/auth-provider$/ }, () => ({
          path: join(extensionDir, "e2e", "harness", "auth-provider-stub.ts"),
        }));
      },
    },
  ],
  // The harness never mounts auth, but it bundles the modules that read these: Plasmo
  // normally inlines them at compile time, so do the same here. Values are inert
  // dummies (RFC-2606 .invalid origin, key-shaped test string with zero authority) —
  // no network, no Clerk, no Convex can ever be reached with them.
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.PLASMO_PUBLIC_CLERK_PUBLISHABLE_KEY": '"pk_test_e2e_harness"',
    "process.env.PLASMO_PUBLIC_CONVEX_URL": '"https://e2e.invalid"',
    "process.env.PLASMO_PUBLIC_CLERK_SYNC_HOST": '""',
    "process.env.PLASMO_PUBLIC_FITCHECK_APP_URL": '"https://e2e.invalid"',
    "process.env.BUF_BIGINT_DISABLE": '"1"',
  },
  write: false,
});
writeFileSync(join(testExtension, "tabs", "e2e-room.js"), bundled.outputFiles[0].text);

const html = readFileSync(join(testExtension, "tabs", "room.html"), "utf8");
const match = html.match(/<script src="([^"]*room\.[^"]*\.js)" defer><\/script>/);
if (!match) throw new Error("could not find the production room chunk in tabs/room.html");
for (const entry of readdirSync(join(testExtension, "tabs"))) {
  if (/^room\..+\.js$/.test(entry)) {
    // The test extension boots ONLY the harness: the production room chunk is removed
    // from the copy so a stale reference can never execute.
    rmSync(join(testExtension, "tabs", entry));
  }
}
writeFileSync(
  join(testExtension, "tabs", "room.html"),
  html.replace(match[0], '<script src="/tabs/e2e-room.js" defer></script>')
);
writeFileSync(join(workDir, "meta.json"), JSON.stringify({ baseBuild, at: new Date().toISOString() }, null, 2));
console.log("test extension assembled at", testExtension);
