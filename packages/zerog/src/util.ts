export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses model output that should be a JSON object, tolerating a surrounding markdown code fence. */
export function parseModelJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch (err) {
    return { ok: false, error: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
}
