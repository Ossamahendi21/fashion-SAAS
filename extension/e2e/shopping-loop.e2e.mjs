// Shopping-extension browser E2E: the complete shopping loop in a REAL Chrome
// extension runtime. Zero paid providers: every Convex/Clerk/Decart/OpenAI boundary is
// stubbed in the harness room; the background image fetch hits only the local fixture
// server. Run via `npm run test:e2e` (orchestrator provides E2E_* env), never directly.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const FIXTURE_URL = process.env.E2E_FIXTURE_URL || "";
// Node-side log reads must bypass the Chrome-only host alias (Node uses system DNS).
const FIXTURE_LOCAL = process.env.E2E_FIXTURE_LOCAL || "";
const EXTENSION_DIR = process.env.E2E_EXTENSION_DIR || "";
const CHROME_PATH =
  process.env.E2E_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const HEADED = process.env.E2E_HEADED === "1";

if (!FIXTURE_URL || !FIXTURE_LOCAL || !EXTENSION_DIR) {
  throw new Error("E2E_* env missing: run via npm run test:e2e");
}

let browser;
let page;
const requestedUrls = [];
const consoleErrors = [];
const attachedTargets = new Set();
let profileDir = "";

const PROVIDER_HOST = /(decart\.ai|openai\.com|ai-gateway|oaistatic)/i;

async function watchTarget(target) {
  // Exposed targets that can issue network: pages, OOPIF frames (Puppeteer maps the CDP
  // "iframe" type to TargetType.OTHER), workers and the extension background page.
  const ignored = new Set(["browser", "tab"]);
  if (ignored.has(target.type())) return;
  // Track the live target object (its url() updates as it navigates), not a snapshot.
  attachedTargets.add(target);
  try {
    const session = await target.createCDPSession();
    await session.send("Network.enable");
    session.on("Network.requestWillBeSent", (params) => {
      requestedUrls.push(params.request.url);
    });
  } catch {
    // A target that is already gone: nothing to observe.
  }
}

async function roomFrame(timeout = 10000) {
  // A just-mounted iframe reports no URL for a moment, so wait for the real room document
  // instead of failing the moment the extension swaps it in.
  const deadline = Date.now() + timeout;
  for (;;) {
    const match = page.frames().find((frame) => frame.url().includes("/tabs/room.html"));
    if (match) return match;
    if (Date.now() >= deadline) {
      const all = page.frames().map((f) => `${f.url() || "(no url)"}`);
      throw new Error(`room iframe never appeared (frames present: ${JSON.stringify(all)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The harness API appears when the harness bundle mounts; a remounted iframe boots it again. */
async function waitHarnessReady(timeout = 10000) {
  const frame = await roomFrame();
  await frame.waitForFunction(() => window.__owE2e?.ready === true, { timeout });
}

function roomEvaluate(fn, ...args) {
  return roomFrame().then((frame) => frame.evaluate(fn, ...args));
}

/** Read-only access to a harness field (calls, events, registered). */
function e2eGet(prop) {
  return roomEvaluate((p) => window.__owE2e[p], prop);
}

/** Invoke a harness method with structured-clone args (never logs its arguments). */
function e2eCall(method, ...args) {
  return roomEvaluate((m, a) => window.__owE2e[m](...a), method, args);
}

async function waitRoomText(text, timeout = 15000) {
  const frame = await roomFrame();
  await frame.waitForFunction((t) => document.body.textContent?.includes(t), { timeout }, text);
}

/** Card identity, ignoring the transient status line that settles asynchronously. */
function roomCardNames() {
  return roomEvaluate(() => [...document.querySelectorAll(".garment-card .garment-name")].map((node) => node.textContent ?? ""))
}

/** Pill state read straight out of the extension shadow root. */
function pillState() {
  return page.evaluate(() => {
    const pill = document.querySelector("openwear-root")?.shadowRoot?.querySelector(".ow-contextual");
    if (!pill) return null;
    const buttons = [...pill.querySelectorAll("button")].map((b) => ({ text: b.textContent, disabled: b.disabled }));
    return {
      visible: pill.style.display !== "none",
      title: pill.querySelector(".ow-contextual-title")?.textContent ?? "",
      buttons,
      left: pill.style.left,
      top: pill.style.top,
    };
  });
}

function shadowIframes() {
  return page.evaluate(
    () => document.querySelector("openwear-root")?.shadowRoot?.querySelectorAll("iframe").length ?? 0
  );
}

/** Park the mouse over ineligible chrome so the pill hides: launcher clicks must land
 * on the launcher, never on a lingering pill that happens to overlap its fixed spot. */
async function hidePill() {
  await page.hover("header img");
  await page.waitForFunction(
    () => {
      const pill = document.querySelector("openwear-root")?.shadowRoot?.querySelector(".ow-contextual");
      return pill && pill.style.display === "none";
    },
    { timeout: 10000 }
  );
}

/** Trusted input click on a shadow-DOM pill button (real CDP mouse, not synthetic). */
async function clickPillButton(text) {
  const point = await page.evaluate((t) => {
    const root = document.querySelector("openwear-root")?.shadowRoot;
    const pill = root?.querySelector(".ow-contextual");
    const btn = [...pill?.querySelectorAll("button") ?? []].find((b) => b.textContent === t);
    if (!btn || pill?.style.display === "none") return null;
    const r = btn.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, text);
  assert.ok(point, `pill button ${JSON.stringify(text)} is visible and measurable`);
  // Real trusted input at the measured point: move first (a real pointer does), then click.
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
}

/** Programmatic click on a room button by exact text (room UI needs no trusted input). */
function clickRoomButton(text) {
  return roomEvaluate((t) => {
    const button = [...document.querySelectorAll(".garment-card button")].find((b) => b.textContent === t);
    if (!button || button.disabled) throw new Error(`room button missing or disabled: ${t}`);
    button.click();
  }, text);
}

/** Same-tick double dispatch: both clicks land before React re-renders (race tests). */
function doubleClickRoomButton(text) {
  return roomEvaluate((t) => {
    const button = [...document.querySelectorAll(".garment-card button")].find((b) => b.textContent === t);
    if (!button) throw new Error(`room button missing: ${t}`);
    button.click();
    button.click();
  }, text);
}

async function fetchCount(path) {
  const res = await fetch(`${FIXTURE_LOCAL}/__e2e/requests`);
  const log = await res.json();
  return log.filter((entry) => entry.path === path).length;
}

before(async () => {
  profileDir = mkdtempSync(join(tmpdir(), "ow-e2e-"));
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: HEADED ? false : true,
    // Puppeteer disables extensions by default: re-enable them. The extension itself
    // is installed at runtime via CDP Extensions.loadUnpacked (Chrome 154 silently
    // ignores --load-extension, even headed), which also returns its id for the log.
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--host-resolver-rules=MAP shop.e2e.ow 127.0.0.1",
      // A real shop page is https, i.e. a secure context, and the extension depends on that:
      // issueCapability() mints one-time tokens with crypto.randomUUID(), which is undefined
      // on an insecure origin. Treat the local fixture origin as secure so the harness
      // exercises the same capability path a production page does.
      `--unsafely-treat-insecure-origin-as-secure=${FIXTURE_URL.replace(/\/$/, "")}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--deny-permission-prompts",
      "--window-size=1366,900",
      "--disable-dev-shm-usage",
    ],
  });
  {
    const browserTarget = browser.targets().find((t) => t.type() === "browser");
    assert.ok(browserTarget, "browser target exists for extension install");
    const session = await browserTarget.createCDPSession();
    const installed = await session.send("Extensions.loadUnpacked", { path: EXTENSION_DIR });
    assert.ok(installed && installed.id, "test extension installed via CDP");
  }
  for (const target of browser.targets()) await watchTarget(target);
  browser.on("targetcreated", (target) => void watchTarget(target));
  page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${message.location().url}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error)}`));
  await page.goto(FIXTURE_URL, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector("openwear-root", { timeout: 20000 });
  // Let the content script settle (mount delay) and the hostile fixture script fire.
  await new Promise((resolve) => setTimeout(resolve, 1500));
});

after(async () => {
  await browser?.close().catch(() => {});
  rmSync(profileDir, { recursive: true, force: true });
});

test("1: fixture loads and the hostile page script fires", async () => {
  const sent = await page.evaluate(() => window.__owE2eHostile?.sent ?? 0);
  assert.ok(sent >= 3, "hostile page-world posts fired");
});

test("2: the main product gets one Try on / Save pill; site DOM untouched", async () => {
  await page.hover("#product-main");
  const pill = await pillState();
  assert.ok(pill?.visible, "pill is visible on hover");
  assert.equal(pill?.title, "Olive field jacket");
  assert.deepEqual(
    pill?.buttons.map((b) => b.text),
    ["Try on", "Save"]
  );
  assert.equal(await shadowIframes(), 0, "room stays closed until asked");
  // Our own shadow host legitimately carries the ownership marker (it is how a retargeted
  // pointer crossing is recognised); site-authored markup must never carry one.
  const marked = await page.evaluate(() =>
    [...document.querySelectorAll("[data-ow-ui]")].map((n) => `${n.tagName}${n === document.querySelector("openwear-root") ? "(host)" : ""}`)
  );
  assert.deepEqual(marked, ["OPENWEAR-ROOT(host)"], "no extension markers leak into site-owned DOM");
  const attrs = await page.evaluate(() => document.querySelector("#product-main")?.getAttributeNames().sort());
  assert.deepEqual(attrs, ["alt", "id", "src"], "product node untouched");
});

test("3: tiny, branded and banner imagery gets no pill", async () => {
  for (const selector of ["header img", ".banner img"]) {
    await page.hover(selector);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await pillState())?.visible, false, `${selector} must not summon the pill`);
  }
});

test("4: scroll and resize reposition the pill", async () => {
  await page.hover("#product-main");
  const before = await pillState();
  await page.evaluate(() => window.scrollTo(0, 500));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = await pillState();
  assert.ok(after?.visible, "pill survives scrolling");
  assert.notEqual(after?.top, before?.top, "pill tracks the anchor on scroll");
  await page.setViewport({ width: 1000, height: 700 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const resized = await pillState();
  const left = Number.parseFloat(resized?.left || "0");
  assert.ok(left >= 8 && left + 220 <= 1000, "pill stays inside the resized viewport");
  await page.setViewport({ width: 1366, height: 900 });
  await page.evaluate(() => window.scrollTo(0, 0));
});

test("5: moving to the second product retargets", async () => {
  await page.hover("#product-second");
  const pill = await pillState();
  assert.ok(pill?.visible, "pill follows to the nested card");
  // Alt text wins over the card heading by design (productName prefers alt).
  assert.equal(pill?.title, "Rose summer dress");
});

test("6: exactly one root, one pill, no room iframe yet", async () => {
  const counts = await page.evaluate(() => ({
    roots: document.querySelectorAll("openwear-root").length,
    pills: document.querySelector("openwear-root")?.shadowRoot?.querySelectorAll('[data-ow-ui="contextual"]').length ?? 0,
    iframes: document.querySelector("openwear-root")?.shadowRoot?.querySelectorAll("iframe").length ?? 0,
  }));
  assert.deepEqual(counts, { roots: 1, pills: 1, iframes: 0 });
});

test("7: a trusted Try on reaches the room exactly once", async () => {
  // Real user flow, with the room still closed: hover the product, click the pill. The
  // room window is opened by the click itself, so the pill is reachable at this point.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.hover("#product-main");
  const pill = await pillState();
  assert.ok(pill?.visible, "pill is visible for the trusted click");
  await clickPillButton("Try on");
  // Staged waits: React state first (window opens), then the iframe, then the harness.
  await page.waitForFunction(
    () => document.querySelector("openwear-root")?.shadowRoot?.querySelector(".ow-window") !== null,
    { timeout: 10000 }
  );
  await page.waitForFunction(
    () => document.querySelector("openwear-root")?.shadowRoot?.querySelector("iframe") !== null,
    { timeout: 15000 }
  );
  await waitHarnessReady();
  await e2eCall("setFixtureBase", FIXTURE_URL);
  await waitRoomText("Olive field jacket");
  const names = await roomEvaluate(() => [...document.querySelectorAll(".garment-card")].map((card) => card.textContent));
  assert.equal(names.length, 1, "exactly one garment");
  assert.ok(names[0]?.includes("Olive field jacket"), "the trusted product arrived");
  const calls = await e2eGet("calls");
  assert.equal(calls.liveMirror, 0, "authorization never attempted: no camera, no prompt");
});

test("8: forged page posts change nothing", async () => {
  await waitHarnessReady();
  const fetchesBefore = await fetchCount("/images/product-jacket.png");
  // The room legitimately holds test 7's garment, so the invariant is that forged posts
  // ADD nothing, not that the room is empty. Compare card identity (the name), not the
  // card's transient status text, which legitimately settles from loading to a rejection.
  const namesBefore = await roomCardNames();
  await page.evaluate((base) => {
    window.postMessage({ type: "openwear:garment", url: `${base}/images/product-jacket.png`, name: "Forged again" }, "*");
    window.postMessage({ type: "openwear:garment", url: `${base}/images/product-jacket.png`, name: "Forged cap", capability: "owcap-garment-forged-9" }, "*");
    window.postMessage({ type: "openwear:save-garment", imageUrl: `${base}/images/product-jacket.png`, clientImportId: "forged-save-9", token: "owcap-save-forged-9" }, "*");
  }, FIXTURE_URL);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const namesAfter = await roomCardNames();
  assert.deepEqual(namesAfter, namesBefore, "forged posts add no garment");
  assert.equal(namesAfter.some((name) => name.includes("Forged")), false, "no forged garment accepted");
  const calls = await e2eGet("calls");
  assert.equal(calls.register, 0, "no save ran");
  assert.equal(calls.liveMirror, 0, "no provider path ran");
  assert.equal(await fetchCount("/images/product-jacket.png"), fetchesBefore, "no image fetch ran");
});

test("9: replayed garment capability is rejected", async () => {
  const fetchesBefore = await fetchCount("/images/product-jacket.png");
  const replayed = await e2eCall("replayLastGarment");
  assert.equal(replayed, true, "a legitimate handoff exists to replay");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(await fetchCount("/images/product-jacket.png"), fetchesBefore, "replay triggers no second fetch");
  const names = await roomEvaluate(() => [...document.querySelectorAll(".garment-card")].map((card) => card.textContent));
  assert.equal(names.length, 1, "still exactly one garment");
  const calls = await e2eGet("calls");
  assert.equal(calls.liveMirror, 0, "replay never reaches the provider path");
});

test("11: save and garment scopes cannot substitute", async () => {
  const before = await e2eGet("calls");
  const garmentToken = await e2eCall("mintToken", "garment");
  const saveToken = await e2eCall("mintToken", "save");
  const events = await e2eGet("events");
  assert.ok(!JSON.stringify(events).includes(garmentToken), "tokens never enter the event log");
  assert.ok(!JSON.stringify(events).includes(saveToken), "tokens never enter the event log");
  await page.evaluate(
    ([garment, save, base]) => {
      const frame = document.querySelector("openwear-root")?.shadowRoot?.querySelector("iframe");
      frame?.contentWindow?.postMessage(
        { type: "openwear:save-garment", imageUrl: `${base}/images/product-jacket.png`, clientImportId: "scope-save-1", token: garment },
        "*"
      );
      frame?.contentWindow?.postMessage({ type: "openwear:garment", url: `${base}/images/product-dress.png`, name: "Scoped dress", capability: save }, "*");
    },
    [garmentToken, saveToken, FIXTURE_URL]
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const after = await e2eGet("calls");
  assert.equal(after.register, before.register, "cross-scope tokens authorize nothing");
  const pill = await pillState();
  assert.equal(pill?.title, "Olive field jacket", "pill still anchored to the trusted product");
});

test("12: contextual Save walks Saving, Processing, Saved", async () => {
  await e2eCall("setSaveSequence", ["processing", "ready"]);
  await page.hover("#product-main");
  const fetchesBefore = await fetchCount("/images/product-jacket.png");
  await clickPillButton("Save");
  await page.waitForFunction(
    () => {
      const pill = document.querySelector("openwear-root")?.shadowRoot?.querySelector(".ow-contextual");
      return [...pill?.querySelectorAll("button") ?? []].some((b) => b.textContent === "Saving…");
    },
    { timeout: 10000 }
  );
  await page.waitForFunction(
    () => {
      const pill = document.querySelector("openwear-root")?.shadowRoot?.querySelector(".ow-contextual");
      return [...pill?.querySelectorAll("button") ?? []].some((b) => b.textContent === "Saved ✓");
    },
    { timeout: 15000 }
  );
  const calls = await e2eGet("calls");
  assert.equal(calls.register, 1, "one registration");
  assert.ok(calls.status >= 2, "status polled to a terminal state");
  assert.equal(await fetchCount("/images/product-jacket.png"), fetchesBefore + 1, "room fetched the image through the background worker");
});

test("13: Style, Advice and Own actions appear after save", async () => {
  await waitRoomText("Style this item");
  await waitRoomText("Should I buy this?");
  await waitRoomText("I bought this");
});

test("14: double-click Save issues one operation", async () => {
  await e2eCall("setSaveSequence", ["ready"]);
  await page.hover("#product-second");
  const before = await e2eGet("calls");
  await clickPillButton("Save");
  await clickPillButton("Save").catch(() => {});
  await page.waitForFunction(
    () => {
      const pill = document.querySelector("openwear-root")?.shadowRoot?.querySelector(".ow-contextual");
      return [...pill?.querySelectorAll("button") ?? []].some((b) => b.textContent === "Saved ✓");
    },
    { timeout: 15000 }
  );
  const after = await e2eGet("calls");
  assert.equal(after.register, before.register + 1, "double click collapses to one save");
});

test("15: a retargeted pill keeps the newer product UI", async () => {
  await e2eCall("setDelays", { statusMs: 700 });
  await e2eCall("setSaveSequence", ["processing", "ready"]);
  await page.hover("#product-main");
  await clickPillButton("Save");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.hover("#product-second");
  let pill = await pillState();
  assert.equal(pill?.title, "Rose summer dress", "pill retargeted mid-flight");
  assert.ok(pill?.buttons.some((b) => b.text === "Save"), "retarget resets to idle");
  const frame = await roomFrame();
  await frame.waitForFunction(() => (window.__owE2e?.calls.status ?? 0) >= 5, { timeout: 20000 });
  pill = await pillState();
  assert.ok(pill?.buttons.some((b) => b.text === "Save"), "the finished older save stays silent on the newer pill");
  await e2eCall("setDelays", { statusMs: 0 });
});

test("16: Style this item renders two suggestion cards", async () => {
  await clickRoomButton("Style this item");
  const frame = await roomFrame();
  await frame.waitForFunction(() => document.querySelectorAll(".suggestion-card").length === 2, { timeout: 15000 });
  const names = await roomEvaluate(() => [...document.querySelectorAll(".suggestion-card strong")].map((el) => el.textContent));
  assert.deepEqual(names, ["E2E Riverside Combo", "E2E Gallery Evening"]);
  const calls = await e2eGet("calls");
  assert.equal(calls.style, 1, "one styling request");
  await waitRoomText("Saved ✓");
  await waitRoomText("I bought this");
});

test("17: double-click Style and Advice stay single-flight", async () => {
  await e2eCall("setDelays", { styleMs: 400, adviceMs: 400 });
  const before = await e2eGet("calls");
  await doubleClickRoomButton("Style this item");
  await doubleClickRoomButton("Should I buy this?");
  await roomEvaluate(() => new Promise((resolve) => setTimeout(resolve, 1200)));
  const after = await e2eGet("calls");
  assert.equal(after.style, before.style + 1, "one styling request for a double click");
  assert.equal(after.advice, before.advice + 1, "one advice request for a double click");
  await e2eCall("setDelays", { styleMs: 0, adviceMs: 0 });
});

test("18: the decision panel renders deterministic content", async () => {
  const frame = await roomFrame();
  await frame.waitForSelector(".advice-panel", { timeout: 15000 });
  await waitRoomText("Works with 7 pieces");
  await waitRoomText("8 outfit possibilities");
  await waitRoomText("E2E summary");
  const bullets = await roomEvaluate(() => document.querySelectorAll(".advice-panel ul li").length);
  assert.ok(bullets >= 3, "bounded pros and considerations render");
  const panel = await roomEvaluate(() => document.querySelector(".advice-panel")?.textContent ?? "");
  assert.ok(!/\d+\s*%|confidence|decart|openai/i.test(panel), "no scores, percentages or provider names");
});

test("19: I bought this completes the ownership transition", async () => {
  await clickRoomButton("I bought this");
  await waitRoomText("Added to your wardrobe ✓");
  const calls = await e2eGet("calls");
  assert.equal(calls.owned, 1, "one ownership transition");
  const panelGone = await roomEvaluate(() => document.querySelector(".advice-panel") === null);
  assert.equal(panelGone, true, "decision actions disappear once owned");
  const adviceGone = await roomEvaluate(
    () => ![...document.querySelectorAll(".garment-card button")].some((b) => b.textContent === "Should I buy this?")
  );
  assert.equal(adviceGone, true, "the advice button is gone once owned");
  const styleStays = await roomEvaluate(() => document.querySelectorAll(".suggestion-card").length === 2);
  assert.equal(styleStays, true, "style cards remain for the now-owned item");
});

test("20: harness event evidence covers the whole loop", async () => {
  const events = await e2eGet("events");
  const names = events.map((e) => e.event);
  for (const required of ["garment-received", "save-started", "style-started", "advice-started", "owned-marked"]) {
    assert.ok(names.includes(required), `event log contains ${required}`);
  }
  assert.ok(!JSON.stringify(events).includes("owcap-"), "no capability values in the log");
});

test("21: close remounts fresh and reopen boots clean", async () => {
  // Closing unmounts the room iframe by design (prod behavior): reopening boots a
  // fresh harness with no carried-over garment or backend counts. This test runs after
  // every cumulative assertion for exactly that reason.
  const closeHandle = await page.evaluateHandle(() => {
    const root = document.querySelector("openwear-root")?.shadowRoot;
    return (
      [...root?.querySelectorAll("button") ?? []].find((b) => b.getAttribute("aria-label") === "Close fitting room") ?? null
    );
  });
  const closeButton = closeHandle.asElement();
  assert.ok(closeButton, "room close button exists");
  await closeButton.click();
  await page.waitForFunction(
    () => document.querySelector("openwear-root")?.shadowRoot?.querySelector(".ow-window") === null,
    { timeout: 10000 }
  );
  await hidePill();
  const handle = await page.evaluateHandle(() => {
    const root = document.querySelector("openwear-root")?.shadowRoot;
    return root?.querySelector(".ow-launcher-main") ?? null;
  });
  const reopen = handle.asElement();
  assert.ok(reopen, "launcher button exists for reopen");
  await reopen.click();
  await page.waitForFunction(
    () => document.querySelector("openwear-root")?.shadowRoot?.querySelector("iframe") !== null,
    { timeout: 15000 }
  );
  await waitHarnessReady();
  const fresh = await roomEvaluate(() => document.querySelector(".garment-card") === null);
  assert.equal(fresh, true, "reopen starts clean: no carried-over garment");
});

test("22: settings toggle hides and restores the overlay", async () => {
  await roomEvaluate(() => chrome.storage.local.set({ shoppingActionsEnabled: false }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.hover("#product-main");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await pillState())?.visible ?? false, false, "overlay disappears when disabled");
  await roomEvaluate(() => chrome.storage.local.set({ shoppingActionsEnabled: true }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.hover("#product-main");
  assert.equal((await pillState())?.visible, true, "overlay works again after re-enable");
});

test("23: SPA replacement keeps singletons; detach clears the pill", async () => {
  await page.evaluate(() => {
    document.querySelector("main").innerHTML =
      '<img id="product-fresh" src="/images/product-jacket.png" alt="Fresh jacket" style="width:600px;height:800px">';
  });
  await page.hover("#product-fresh");
  assert.equal((await pillState())?.title, "Fresh jacket", "overlay works on replaced DOM");
  const counts = await page.evaluate(() => ({
    roots: document.querySelectorAll("openwear-root").length,
    pills: document.querySelector("openwear-root")?.shadowRoot?.querySelectorAll('[data-ow-ui="contextual"]').length ?? 0,
    iframes: document.querySelector("openwear-root")?.shadowRoot?.querySelectorAll("iframe").length ?? 0,
  }));
  assert.deepEqual(counts, { roots: 1, pills: 1, iframes: 1 }, "no duplicate roots, pills or iframes");
  await page.evaluate(() => document.querySelector("#product-fresh")?.remove());
  await page.mouse.move(10, 10);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await pillState())?.visible, false, "detached target clears the overlay");
});

test("24: zero providers and zero console errors", async () => {
  const providerHits = requestedUrls.filter((url) => PROVIDER_HOST.test(url));
  assert.deepEqual(providerHits, [], "zero OpenAI/Gateway/Decart requests across all targets");
  const convexHits = requestedUrls.filter((url) => url.includes("convex.cloud"));
  assert.deepEqual(convexHits, [], "zero Convex calls: the mock boundary holds");
  assert.ok(
    [...attachedTargets].some((t) => t.url().includes("tabs/room.html")),
    "network observation covered the room target"
  );
  assert.deepEqual(consoleErrors, [], `no uncontrolled console errors: ${consoleErrors.join(" | ").slice(0, 500)}`);
});
