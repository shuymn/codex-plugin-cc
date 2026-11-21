export type JsonObject = Record<string, unknown>;

// Narrows parsed JSON (or any unknown value) to a plain object.
export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
