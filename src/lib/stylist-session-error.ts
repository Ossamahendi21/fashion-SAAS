/** Eve 0.56's stream route returns this exact JSON for an unavailable durable session. */
export function isMissingStylistSession(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    error.name !== "ClientError" ||
    !("status" in error) ||
    error.status !== 404 ||
    !("body" in error) ||
    typeof error.body !== "string"
  ) {
    return false;
  }

  try {
    const body: unknown = JSON.parse(error.body);
    return (
      typeof body === "object" &&
      body !== null &&
      "ok" in body &&
      body.ok === false &&
      "error" in body &&
      body.error === "Session not found."
    );
  } catch {
    return false;
  }
}
