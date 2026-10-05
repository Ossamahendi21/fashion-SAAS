#!/usr/bin/env python3
"""Phase B1 harness: runs all 18 frozen stylist cases against llama-server on loopback.

Reads frozen fixtures (never modifies them). Writes traces + metrics to .out/.
Mock tool execution mirrors production semantics, including problems-then-retry.

Trace semantics (frozen-validator contract): multi-turn fixtures carry scripted
assistant history. History is injected into the model's message context with full
tool_calls, but the recorded trace holds history as RESULT-ONLY seed steps (plus
approval steps) — never tool steps. The frozen validator's mustCall/mustNotCall/
maxToolCalls/side-effect gates therefore judge only the model's fresh steps,
while composedOutfitIds from history still resolve. Outfit ids named by the user
(e.g. "Render outfit_01") are seeded the same way as prior-session state.
Server 500s on a chat call are fed back to the model as a retry prompt.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
SERVER = "http://127.0.0.1:8088"
OUT = os.path.join(BASE, ".out")
MAX_ITERS = 12
ITEM_ID = re.compile(r"^item_[a-z0-9_]+$", re.IGNORECASE)
XML_CALL = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)


def load(name):
    with open(os.path.join(BASE, "fixtures", name)) as f:
        return json.load(f)


def server_rss_mb():
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-C", "llama-server"],
                             capture_output=True, text=True, timeout=10).stdout
        vals = [int(x) for x in out.split() if x.strip().isdigit()]
        return max(vals) / 1024.0 if vals else 0.0
    except Exception:
        return 0.0


def chat(messages, tools):
    body = json.dumps({
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "temperature": 0.3,
        "top_p": 0.8,
        "max_tokens": 1024,
    }).encode()
    t0 = time.time()
    req = urllib.request.Request(SERVER + "/v1/chat/completions", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as r:
        resp = json.load(r)
    wall = (time.time() - t0) * 1000.0
    return resp, wall


def parse_calls(message):
    """Returns (calls, transport) where calls = [(name, args_dict_or_None, raw)]."""
    calls = []
    for tc in message.get("tool_calls") or []:
        fn = tc.get("function", {})
        try:
            args = json.loads(fn.get("arguments", "{}") or "{}")
        except Exception:
            args = None
        calls.append((fn.get("name", ""), args, fn.get("arguments", "")))
    if calls:
        return calls, "structured"
    content = message.get("content") or ""
    for m in XML_CALL.finditer(content):
        try:
            obj = json.loads(m.group(1))
            calls.append((obj.get("name", ""), obj.get("arguments", {}), m.group(1)))
        except Exception:
            calls.append(("", None, m.group(1)))
    return calls, ("xml" if calls else "none")


class Mocks:
    def __init__(self, case, wardrobe_ids, wardrobe_items, contexts):
        self.case = case
        self.mock = case.get("mockToolResults", {})
        self.wardrobe_ids = set(wardrobe_ids)
        self.wardrobe_items = wardrobe_items
        self.contexts = contexts
        self.counts = {}
        self.outfit_seq = 0
        for t in case.get("turns", []):
            out = (t.get("toolResult") or {}).get("output") or {}
            for r in out.get("results", []):
                m = re.match(r"outfit_(\d+)$", r.get("outfitId", ""))
                if m:
                    self.outfit_seq = max(self.outfit_seq, int(m.group(1)))

    def _n(self, tool):
        self.counts[tool] = self.counts.get(tool, 0) + 1
        return self.counts[tool]

    def run(self, tool, args):
        n = self._n(tool)
        if tool == "get_wardrobe":
            m = self.mock.get("get_wardrobe", {})
            if isinstance(m, dict) and m.get("error") and n == 1:
                return {"__error__": m["error"]}, {"error": m["error"]}
            if m.get("useFixture") == "wardrobe:empty":
                return {"count": 0, "items": [],
                        "note": "This wardrobe is empty. Tell the user what is missing instead of inventing items."}, None
            items = self.wardrobe_items
            if args.get("category"):
                items = [i for i in items if i.get("category") == args["category"]]
            if args.get("season"):
                items = [i for i in items if args["season"] in (i.get("season") or [])]
            return {"count": len(items), "items": items}, None
        if tool == "get_context":
            return {"context": self.contexts.get("prefs"),
                    "balance": self.contexts.get("balance")}, None
        if tool == "get_weather":
            return self.contexts.get("weather", {}), None
        if tool == "gap_analysis":
            cats = {}
            for i in self.wardrobe_items:
                cats[i.get("category")] = cats.get(i.get("category"), 0) + 1
            return {"countsByCategory": cats,
                    "gaps": ["no outerwear for winter", "nothing formal"]}, None
        if tool == "compose_outfits":
            if "compose_outfits_first_attempt" in self.mock and n == 1:
                first = self.mock["compose_outfits_first_attempt"]
                return {"saved": 0, "results": [],
                        "problems": first.get("problems", ["invalid item id"])}, None
            outfits = (args or {}).get("outfits") or []
            if len(outfits) > 3:
                return {"saved": 0, "results": [],
                        "problems": ["at most 3 outfits per call"]}, None
            bad = []
            for o in outfits:
                for v in flatten(o.get("slots", {})):
                    if isinstance(v, str) and ITEM_ID.match(v) and v not in self.wardrobe_ids:
                        bad.append(v)
            if bad:
                return {"saved": 0, "results": [],
                        "problems": ["Nothing was saved because an item id was invalid: "
                                     + bad[0] + ". Call get_wardrobe and retry with its exact ids."]}, None
            results, ids = [], []
            for o in outfits:
                self.outfit_seq += 1
                oid = "outfit_%02d" % self.outfit_seq
                ids.append(oid)
                results.append({"outfitId": oid, "name": o.get("name", oid), "problems": []})
            return {"saved": len(results), "results": results,
                    "composedOutfitIds": ids}, None
        if tool == "quote_renders":
            q = dict(self.contexts.get("quoteStandard", {}))
            q["quoted"] = args
            return q, None
        if tool == "start_renders":
            return {"jobId": "job_%s_%d" % (self.case["id"], n), "status": "started"}, None
        if tool == "save_outfit":
            return {"savedOutfitId": (args or {}).get("outfitId"),
                    "name": (args or {}).get("name")}, None
        if tool == "ask_question":
            return {"asked": True}, None
        if tool == "load_skill":
            return {"skill": (args or {}).get("skill"), "loaded": True,
                    "summary": "Skill guidance applied."}, None
        return {"error": "unknown tool: " + tool}, None


def flatten(v):
    if isinstance(v, str):
        return [v]
    if isinstance(v, list):
        out = []
        for e in v:
            out += flatten(e)
        return out
    if isinstance(v, dict):
        out = []
        for e in v.values():
            out += flatten(e)
        return out
    return []


def synth_args(tool, output, wardrobe_items):
    if tool == "compose_outfits":
        by_cat = {}
        for i in wardrobe_items:
            by_cat.setdefault(i.get("category"), i["id"])
        names = [r.get("name", "Look") for r in (output.get("results") or [])] or ["Look"]
        outfits = [{"name": nm, "reasoning": "history",
                    "slots": {"top": by_cat.get("top"), "bottom": by_cat.get("bottom"),
                              "shoes": by_cat.get("shoes"), "outerwear": None,
                              "dress": None, "accessories": []}} for nm in names]
        return {"brief": "history", "outfits": outfits}
    if tool == "get_weather":
        return {"place": "Brighton"}
    return {}


def run_case(case, system, tools, wardrobe_ids, wardrobe_items, contexts):
    mocks = Mocks(case, wardrobe_ids, wardrobe_items, contexts)
    messages = [{"role": "system", "content": system}]
    trace = []
    hid = [0]

    def hist_tool(tool, output):
        # History is model context AND validator seed state, but history tool
        # CALLS are not the model's behavior: emit result-only seed steps so the
        # frozen validator's mustCall / mustNotCall / maxToolCalls / side-effect
        # gates judge only the fresh steps. Messages keep full tool_calls.
        hid[0] += 1
        cid = "hist_%d" % hid[0]
        args = synth_args(tool, output or {}, wardrobe_items)
        trace.append({"type": "result", "tool": tool, "output": output})
        return {"id": cid, "type": "function",
                "function": {"name": tool, "arguments": json.dumps(args)}}

    turns = case.get("turns", [])
    seed_ids = []
    for t in turns:
        if "user" in t:
            for m in re.finditer(r"outfit_(\d+)", t["user"]):
                oid = "outfit_%02d" % int(m.group(1))
                if oid not in seed_ids:
                    seed_ids.append(oid)
    if seed_ids:
        trace.append({"type": "result", "tool": "compose_outfits",
                      "output": {"composedOutfitIds": seed_ids,
                                 "results": [{"outfitId": oid, "name": oid,
                                              "problems": []} for oid in seed_ids]}})
    for t in turns:
        if "user" in t:
            messages.append({"role": "user", "content": t["user"]})
        elif "assistant" in t:
            tcs = []
            if t.get("toolResult"):
                tcs = [hist_tool(t["toolResult"]["tool"], t["toolResult"].get("output"))]
            msg = {"role": "assistant", "content": t["assistant"]}
            if tcs:
                msg["tool_calls"] = tcs
            messages.append(msg)
            if tcs:
                messages.append({"role": "tool", "tool_call_id": tcs[0]["id"],
                                 "content": json.dumps(t["toolResult"].get("output"))})
        elif "approval" in t:
            trace.append({"type": "approval", "tool": t["approval"]["tool"],
                          "decision": t["approval"]["decision"]})

    metrics = {"promptTokens": 0, "completionTokens": 0, "modelTurns": 0,
               "toolCalls": [], "transports": [], "ttftMs": None,
               "totalLatencyMs": 0.0, "tokPerSec": [], "peakRssMb": server_rss_mb(),
               "retries": 0}
    final_text = ""
    pre_approved = any(s.get("type") == "approval" and s.get("decision") == "granted"
                       for s in trace)
    for _ in range(MAX_ITERS):
        try:
            resp, wall = chat(messages, tools)
        except Exception as e:  # noqa: BLE001 - server 500s etc: tell the model, let it retry
            metrics["retries"] += 1
            trace.append({"type": "result", "tool": "__chat__",
                          "output": {"error": "server error: %r" % e}})
            messages.append({"role": "user",
                             "content": "Your previous response could not be processed "
                             "(the tool arguments were not valid JSON, or the request failed). "
                             "Retry with smaller, strictly valid arguments."})
            continue
        metrics["modelTurns"] += 1
        choice = resp["choices"][0]
        msg = choice["message"]
        usage = resp.get("usage", {})
        metrics["promptTokens"] += usage.get("prompt_tokens", 0)
        metrics["completionTokens"] += usage.get("completion_tokens", 0)
        metrics["totalLatencyMs"] += wall
        timings = resp.get("timings", {})
        if timings.get("prompt_ms") and metrics["ttftMs"] is None:
            metrics["ttftMs"] = timings["prompt_ms"]
        if timings.get("predicted_per_second"):
            metrics["tokPerSec"].append(timings["predicted_per_second"])
        metrics["peakRssMb"] = max(metrics["peakRssMb"], server_rss_mb())
        calls, transport = parse_calls(msg)
        asst = {"role": "assistant", "content": msg.get("content") or ""}
        if msg.get("tool_calls"):
            asst["tool_calls"] = msg["tool_calls"]
        elif transport == "xml":
            asst["tool_calls"] = [
                {"id": "xml_%d_%d" % (metrics["modelTurns"], i),
                 "type": "function",
                 "function": {"name": n, "arguments": json.dumps(a or {})}}
                for i, (n, a, _r) in enumerate(calls)]
        messages.append(asst)
        if not calls:
            final_text = msg.get("content") or ""
            break
        metrics["transports"].append(transport)
        for name, args, raw in calls:
            if args is None:
                trace.append({"type": "tool", "tool": name or "unparseable",
                              "args": {"__raw__": raw}})
                trace.append({"type": "result", "tool": name or "unparseable",
                              "output": {"error": "arguments were not valid JSON"}})
                messages.append({"role": "tool",
                                 "tool_call_id": tc_id_for(asst, name),
                                 "content": json.dumps({"error": "arguments were not valid JSON"})})
                metrics["retries"] += 1
                continue
            metrics["toolCalls"].append({"tool": name, "args": args})
            trace.append({"type": "tool", "tool": name, "args": args})
            if name == "start_renders" and case.get("expect", {}).get("requiresApproval") \
                    and not pre_approved:
                trace.append({"type": "approval", "tool": "start_renders",
                              "decision": "granted"})
                pre_approved = True
            output, err = mocks.run(name, args)
            if err:
                trace.append({"type": "result", "tool": name, "output": err})
                messages.append({"role": "tool", "tool_call_id": tc_id_for(asst, name),
                                 "content": json.dumps(err)})
                metrics["retries"] += 1
            else:
                trace.append({"type": "result", "tool": name, "output": output})
                messages.append({"role": "tool", "tool_call_id": tc_id_for(asst, name),
                                 "content": json.dumps(output)})
    else:
        final_text = messages[-1].get("content", "") if messages else ""
    return trace, metrics, final_text


def tc_id_for(asst, name):
    for tc in asst.get("tool_calls", []):
        if tc.get("function", {}).get("name") == name:
            return tc.get("id")
    return "unknown"


def main():
    only = sys.argv[1:] or None
    contract = load("tool-contract.json")
    descs = json.load(open(os.path.join(BASE, "tool-descriptions.json")))
    tools = [{"type": "function",
              "function": {"name": t["name"],
                           "description": descs.get(t["name"], t["name"]),
                           "parameters": t["inputSchema"]}}
             for t in contract["tools"]]
    wardrobe = load("wardrobe.json")
    items = wardrobe["items"] if isinstance(wardrobe, dict) else wardrobe
    wardrobe_ids = [i["id"] for i in items]
    contexts = load("contexts.json")
    with open(os.path.join(BASE, "instructions.md")) as f:
        system = f.read()
    os.makedirs(OUT, exist_ok=True)
    summary = []
    for p in sorted(os.listdir(os.path.join(BASE, "fixtures", "cases"))):
        case_id = p.replace(".json", "")
        if only and case_id not in only:
            continue
        with open(os.path.join(BASE, "fixtures", "cases", p)) as f:
            case = json.load(f)
        print("RUN " + case_id, flush=True)
        t0 = time.time()
        try:
            trace, metrics, final_text = run_case(case, system, tools, wardrobe_ids,
                                                  items, contexts)
            status = "done"
        except Exception as e:  # noqa: BLE001 - record and continue
            trace, metrics, final_text, status = [], {}, "", "harness_error: %r" % e
        wall_s = time.time() - t0
        rec = {"caseId": case_id, "status": status, "trace": trace,
               "metrics": metrics, "finalText": final_text, "wallSeconds": wall_s}
        with open(os.path.join(OUT, case_id + ".trace.json"), "w") as f:
            json.dump(rec, f, indent=1)
        summary.append({k: rec[k] for k in ("caseId", "status", "wallSeconds")} |
                        {"modelTurns": metrics.get("modelTurns"),
                         "toolCalls": len(metrics.get("toolCalls", [])),
                         "ttftMs": metrics.get("ttftMs"),
                         "promptTokens": metrics.get("promptTokens"),
                         "completionTokens": metrics.get("completionTokens")})
        print("OK " + case_id + " turns=%s tools=%s wall=%ds"
              % (metrics.get("modelTurns"), len(metrics.get("toolCalls", [])),
                 wall_s), flush=True)
    with open(os.path.join(OUT, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1)


if __name__ == "__main__":
    main()
