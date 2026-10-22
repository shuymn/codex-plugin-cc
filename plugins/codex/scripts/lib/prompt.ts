// Fills {{NAME}} placeholders in a prompt template in a single pass, so a
// value that itself contains "{{...}}" is inserted as is. Unknown names
// become empty.
export function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => values[key] ?? "");
}
