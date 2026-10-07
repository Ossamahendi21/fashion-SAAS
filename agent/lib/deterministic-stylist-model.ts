import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { parseStylistText } from "./stylist-language";
import type { StylistTurnInput } from "./stylist-plan";
import { formatStylistResponse } from "./stylist-response";

/**
 * Step 7 Phase C7B — the deterministic stylist transport adapter.
 *
 * This is a `LanguageModelV4`-compatible object, NOT an AI model. It performs zero inference, opens
 * no network connection, imports no provider SDK, and reads no clock or random source: for a given
 * prompt it always returns the same result. It is the transport seam that lets the real Eve
 * tool-loop drive the already-verified deterministic pipeline (C1–C5).
 *
 * It implements the two-phase contract the Eve tool loop expects:
 *
 * - PHASE A (no trusted `stylist_turn` result in the prompt): read the latest raw user text and emit
 *   exactly one `stylist_turn` tool call. It only normalises text through `parseStylistText` and
 *   carries the resulting turn; it never interprets a garment id, a persisted outfit id, or an
 *   approval token from the text.
 * - PHASE B (a trusted `stylist_turn` result is present): emit the trusted reply text the tool
 *   produced (`StylistTurnOutput.response`) and finish with no further tool calls.
 *
 * Because it never calls out, its reported usage is exactly zero and its model identity is local
 * (`fitcheck/deterministic-stylist`), so it can never be mistaken for a paid provider.
 */

export const DETERMINISTIC_STYLIST_PROVIDER = "fitcheck";
export const DETERMINISTIC_STYLIST_MODEL_ID = "deterministic-stylist";
export const STYLIST_TURN_TOOL_NAME = "stylist_turn";

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** One deterministic planning decision for a single model step. */
export type StylistModelStep =
  | { type: "tool-call"; toolCallId: string; toolName: string; input: { turn: StylistTurnInput } }
  | { type: "text"; text: string };

/**
 * The pure decision function at the heart of the adapter. Kept separate from the transport so it can
 * be tested directly and reused by any spec version.
 */
export function planStylistModelStep(prompt: LanguageModelV4Prompt): StylistModelStep {
  const trustedResponse = latestTrustedTurnResponse(prompt);
  if (trustedResponse !== null) {
    return { type: "text", text: trustedResponse };
  }

  const text = latestUserText(prompt) ?? "";
  const parse = parseStylistText(text);
  return {
    type: "tool-call",
    toolCallId: `call_${STYLIST_TURN_TOOL_NAME}`,
    toolName: STYLIST_TURN_TOOL_NAME,
    input: { turn: parse.turn },
  };
}

/** The latest authored user-message text, or `null` when the prompt carries no user text. */
export function latestUserText(prompt: LanguageModelV4Prompt): string | null {
  let latest: string | null = null;
  for (const message of prompt) {
    if (message.role !== "user") continue;
    const joined = textPartsToString(message.content);
    if (joined.length > 0) latest = joined;
  }
  return latest;
}

/**
 * The trusted reply text from the newest `stylist_turn` tool result, or `null` when none exists.
 * A failed or denied tool result yields the deterministic safe failure text rather than fabricating
 * a reply.
 *
 * A durable session keeps every prior turn's tool result in its history, so a result only counts as
 * the answer to the CURRENT turn when it appears after the latest user message. Without this guard a
 * persistent session would replay the previous turn's reply for every new user message.
 */
export function latestTrustedTurnResponse(prompt: LanguageModelV4Prompt): string | null {
  let latestUserIndex = -1;
  let latestResultIndex = -1;
  let response: string | null = null;
  let index = -1;
  for (const message of prompt) {
    index += 1;
    if (message.role === "user") {
      latestUserIndex = index;
      continue;
    }
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== STYLIST_TURN_TOOL_NAME) continue;
      response = readTurnResponse(part.output);
      latestResultIndex = index;
    }
  }

  if (latestResultIndex === -1 || latestUserIndex >= latestResultIndex) return null;
  return response;
}

function textPartsToString(content: string | ReadonlyArray<{ type: string }>): string {
  if (typeof content === "string") return content;
  let text = "";
  for (const part of content) {
    if (part.type === "text" && "text" in part && typeof part.text === "string") text += part.text;
  }
  return text;
}

function readTurnResponse(output: { type: string }): string {
  const value = "value" in output ? (output as { value: unknown }).value : undefined;
  if (output.type === "execution-denied" || isDeniedApproval(output) || isDeniedApproval(value)) {
    return DENIED_APPROVAL_TEXT;
  }
  if (output.type === "json") return pickResponseText(value);
  if (output.type === "text" && typeof value === "string") return parseJsonTextResponse(value);
  return formatStylistResponse({ kind: "readFailed" });
}

function parseJsonTextResponse(value: string): string {
  try {
    return pickResponseText(JSON.parse(value));
  } catch {
    return formatStylistResponse({ kind: "readFailed" });
  }
}

function pickResponseText(value: unknown): string {
  if (isDeniedApproval(value)) return DENIED_APPROVAL_TEXT;
  if (value !== null && typeof value === "object" && "response" in value) {
    const response = (value as { response?: unknown }).response;
    if (typeof response === "string" && response.length > 0) return response;
  }
  return formatStylistResponse({ kind: "readFailed" });
}

/**
 * A denied tool approval is not a wardrobe outage: the user declined, and nothing ran. Eve reports it
 * as an error tool result carrying `TOOL_EXECUTION_DENIED` (or an `approval.status` of "denied"), so
 * the adapter answers truthfully instead of reusing the read-failure copy.
 */
function isDeniedApproval(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.code === "TOOL_EXECUTION_DENIED") return true;
  const approval = record.approval;
  return (
    approval !== null && typeof approval === "object" && (approval as Record<string, unknown>).status === "denied"
  );
}

const DENIED_APPROVAL_TEXT = "Okay — I've cancelled that render.";

/** The deterministic content array for a plan, shared by the generate and stream paths. */
function contentForStep(step: StylistModelStep): LanguageModelV4Content[] {
  if (step.type === "tool-call") {
    // The AI SDK's tool-call parser reads `input` as a JSON string and validates it against the
    // tool's schema, so the object is serialised at the transport boundary.
    return [{ type: "tool-call", toolCallId: step.toolCallId, toolName: step.toolName, input: JSON.stringify(step.input) }];
  }
  return [{ type: "text", text: step.text }];
}

function finishForStep(step: StylistModelStep): LanguageModelV4GenerateResult["finishReason"] {
  return step.type === "tool-call"
    ? { unified: "tool-calls", raw: "tool-calls" }
    : { unified: "stop", raw: "stop" };
}

/**
 * Builds the deterministic transport adapter. Each call returns a fresh adapter; it holds no state,
 * because the durable conversation state belongs to the `stylist_turn` tool, not the model.
 */
export function createDeterministicStylistModel(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: DETERMINISTIC_STYLIST_PROVIDER,
    modelId: DETERMINISTIC_STYLIST_MODEL_ID,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      const step = planStylistModelStep(options.prompt);
      return {
        content: contentForStep(step),
        finishReason: finishForStep(step),
        usage: ZERO_USAGE,
        warnings: [],
      };
    },

    async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
      const step = planStylistModelStep(options.prompt);
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];

      if (step.type === "tool-call") {
        parts.push({
          type: "tool-call",
          toolCallId: step.toolCallId,
          toolName: step.toolName,
          input: JSON.stringify(step.input),
        });
      } else {
        parts.push({ type: "text-start", id: "text_0" });
        if (step.text.length > 0) parts.push({ type: "text-delta", id: "text_0", delta: step.text });
        parts.push({ type: "text-end", id: "text_0" });
      }

      parts.push({ type: "finish", usage: ZERO_USAGE, finishReason: finishForStep(step) });

      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}