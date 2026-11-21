// Escapes backslashes and control characters (C0, DEL, and C1) as \\, \n, \t,
// and \xNN, so a path or message always prints on one line and reads back
// unambiguously.
export function escapeLine(text: string): string {
  let escaped = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") {
      escaped += "\\\\";
    } else if (char === "\n") {
      escaped += "\\n";
    } else if (char === "\t") {
      escaped += "\\t";
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      escaped += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      escaped += char;
    }
  }
  return escaped;
}
