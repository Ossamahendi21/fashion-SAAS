// Step 7 Phase C8 — out-of-tree provider/network audit.
//
// This file deliberately lives OUTSIDE the deterministic Eve root. The root must stay free of any
// audit instrumentation; the canary process instead injects this preload into the spawned Eve dev
// child via NODE_OPTIONS=--require, wraps that child's global fetch, and appends one JSON line per
// observed request to $C8_AUDIT_OUT. The canary later classifies those lines by host.
//
// It never prints, and it never mutates the request: it only records {host, port, provider} and
// delegates to the original fetch.

/* eslint-disable @typescript-eslint/no-require-imports -- a Node --require preload must be CommonJS */
"use strict";

const fs = require("node:fs");

const OUT = process.env.C8_AUDIT_OUT;

// Known paid/legacy provider hosts. Any hit is a hard C8 failure.
const PROVIDER_RULES = [
  { provider: "openai", test: /(^|\.)openai\.com$/i },
  { provider: "anthropic", test: /(^|\.)anthropic\.com$/i },
  { provider: "google", test: /(^|\.)googleapis\.com$/i },
  { provider: "gateway", test: /(^|\.)vercel\.ai$/i },
  { provider: "gateway", test: /(^|\.)ai-gateway\.vercel\.sh$/i },
  { provider: "openrouter", test: /(^|\.)openrouter\.ai$/i },
  { provider: "omnirouter", test: /omnirouter/i },
  { provider: "groq", test: /(^|\.)groq\.com$/i },
  { provider: "mistral", test: /(^|\.)mistral\.ai$/i },
  { provider: "paid-render", test: /(withoutbg|florencesam|bge)-api\.duckdns\.org$/i },
  { provider: "paid-render", test: /(^|\.)decart\.ai$/i },
];

// Local ports that host a model runtime rather than the app's own infra.
const LOCAL_LLM_PORTS = new Set(["11434", "1234", "8000", "5000", "7860", "8080", "9000", "3001"]);

function classify(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { kind: "unparsed", host: String(raw), provider: null };
  }
  const host = url.hostname;
  const port = url.port;

  for (const rule of PROVIDER_RULES) {
    if (rule.test.test(host)) return { kind: "disallowed", host, port, provider: rule.provider };
  }

  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    if (LOCAL_LLM_PORTS.has(port)) return { kind: "disallowed", host, port, provider: "local-llm" };
    if (port === "3210") return { kind: "allowed", host, port, provider: null };
    return { kind: "allowed", host, port, provider: null };
  }

  return { kind: "external", host, port, provider: null };
}

function record(input) {
  if (!OUT) return;
  try {
    const raw = typeof input === "string" ? input : input && (input.url || input.href) ? input.url || input.href : "";
    fs.appendFileSync(OUT, JSON.stringify({ t: Date.now(), ...classify(raw) }) + "\n");
  } catch {
    /* audit must never break the child */
  }
}

const original = globalThis.fetch;
if (typeof original === "function" && !original.__c8Audited) {
  const audited = function c8AuditedFetch(input, init) {
    record(input);
    return original.call(this, input, init);
  };
  audited.__c8Audited = true;
  globalThis.fetch = audited;
}