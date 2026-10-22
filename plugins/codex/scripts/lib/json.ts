export type JsonObject = Record<string, unknown>;

// Narrows parsed JSON (or any unknown value) to a plain object.
export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Checks for hand-written validators of one fixed schema. Each returns an
// error message naming the location, or null when the value passes.

export function checkKeys(object: JsonObject, keys: readonly string[], where: string): string | null {
  for (const key of keys) {
    if (!(key in object)) {
      return `${where}: missing property "${key}"`;
    }
  }
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) {
      return `${where}: unexpected property "${key}"`;
    }
  }
  return null;
}

export function checkString(value: unknown, where: string, minLength: number): string | null {
  if (typeof value !== "string") {
    return `${where}: expected a string`;
  }
  return value.length < minLength ? `${where}: must not be empty` : null;
}

export function checkEnum(value: unknown, allowed: readonly string[], where: string): string | null {
  return typeof value === "string" && allowed.includes(value)
    ? null
    : `${where}: expected one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`;
}

export function checkPositiveInteger(value: unknown, where: string): string | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? null
    : `${where}: expected an integer >= 1`;
}
