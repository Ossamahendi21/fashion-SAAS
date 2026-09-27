import assert from "node:assert/strict";
import test from "node:test";
import { ConvexError } from "convex/values";
import { toast } from "sonner";
import { guardMutation } from "../src/lib/errors.ts";

test("a rejected mutation shows its error without an optional inline error handler", async (context) => {
  const notifications = [];
  context.mock.method(toast, "error", (message) => notifications.push(message));

  const result = await guardMutation(async () => {
    throw new Error("The request could not connect. Try again.");
  });

  assert.equal(result, undefined);
  assert.deepEqual(notifications, ["The request could not connect. Try again."]);
});

test("a rejected mutation toasts once before delivering its normalized error to the inline handler", async (context) => {
  const notifications = [];
  const data = {
    code: "CONFLICT",
    message: "Wait for the try-ons to finish before deleting this.",
    details: { jobId: "render-job" },
  };
  context.mock.method(toast, "error", (message) => notifications.push(["toast", message]));

  const result = await guardMutation(
    async () => {
      throw new ConvexError(data);
    },
    (error) => notifications.push(["inline", error]),
  );

  assert.equal(result, undefined);
  assert.deepEqual(notifications, [
    ["toast", data.message],
    ["inline", data],
  ]);
});

for (const value of [null, { renderId: "render-created" }]) {
  test(`a successful mutation preserves its ${value === null ? "null" : "object"} result without reporting an error`, async (context) => {
    const errorToast = context.mock.method(toast, "error", () => undefined);
    const onError = context.mock.fn();

    const result = await guardMutation(async () => value, onError);

    assert.equal(result, value);
    assert.equal(errorToast.mock.callCount(), 0);
    assert.equal(onError.mock.callCount(), 0);
  });
}
