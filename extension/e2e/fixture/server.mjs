// Tiny zero-dependency fixture server for the shopping-extension E2E.
// Serves e2e/fixture over plain http on 127.0.0.1 with an ephemeral port and keeps a
// request log so tests can prove which bytes the extension really fetched (notably the
// background worker's image download). No production code depends on this module.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// server.mjs lives inside fixture/, so its own directory IS the fixture root.
const fixtureDir = dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
};

export function startFixtureServer() {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://fixture.invalid");
    const stamp = Date.now();
    requests.push({ method: req.method, path: url.pathname, at: stamp });
    if (url.pathname === "/__e2e/requests") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(requests));
      return;
    }
    const file = normalize(join(fixtureDir, url.pathname === "/" ? "shop.html" : url.pathname.slice(1)));
    if (!file.startsWith(fixtureDir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        requests,
        async stop() {
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}
