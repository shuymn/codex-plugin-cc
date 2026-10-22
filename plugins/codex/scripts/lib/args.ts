// Parses only the leading options of the raw slash-command arguments and keeps
// everything from the first non-option token on as verbatim text, so free text
// such as a task prompt keeps its newlines and quotes and cannot smuggle in
// options like --write.
//
//   input := ws* (opt ws+)* ("--" ws+)? text
//   value := a whitespace-delimited token, '...', or "..." (quotes removed)

export class UsageError extends Error {
  override name = "UsageError";
}

export type ArgumentSpec = {
  booleans: readonly string[];
  values: readonly string[];
  text: "forbidden" | "optional";
  textForbiddenHint?: string;
  exclusive?: readonly (readonly [string, string])[];
};

export type ParsedArguments =
  | { help: true }
  | { help: false; options: Partial<Record<string, string | true>>; text: string };

type Token = {
  raw: string;
  value: string;
  start: number;
  end: number;
  quoted: boolean;
  unterminated: boolean;
};

const WHITESPACE = /\s/;

function skipWhitespace(raw: string, index: number): number {
  let cursor = index;
  while (cursor < raw.length && WHITESPACE.test(raw.charAt(cursor))) {
    cursor += 1;
  }
  return cursor;
}

function readToken(raw: string, start: number): Token {
  let value = "";
  let quote: string | null = null;
  let quoted = false;
  let cursor = start;
  for (; cursor < raw.length; cursor += 1) {
    const character = raw.charAt(cursor);
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        value += character;
      }
      continue;
    }
    if (WHITESPACE.test(character)) {
      break;
    }
    if (character === "'" || character === '"') {
      quote = character;
      quoted = true;
      continue;
    }
    value += character;
  }
  return { raw: raw.slice(start, cursor), value, start, end: cursor, quoted, unterminated: quote !== null };
}

function optionKey(name: string, spec: ArgumentSpec): string | null {
  if (name === "-C") {
    return spec.values.includes("cwd") ? "cwd" : null;
  }
  if (!name.startsWith("--") || name.includes("=")) {
    return null;
  }
  const key = name.slice(2);
  return spec.booleans.includes(key) || spec.values.includes(key) ? key : null;
}

export function parseLeadingOptions(raw: string, spec: ArgumentSpec): ParsedArguments {
  const options: Partial<Record<string, string | true>> = {};
  let text = "";
  let cursor = skipWhitespace(raw, 0);

  while (cursor < raw.length) {
    const token = readToken(raw, cursor);
    if (token.raw === "--") {
      text = raw.slice(skipWhitespace(raw, token.end));
      break;
    }
    if (!token.raw.startsWith("-") || token.raw === "-") {
      text = raw.slice(token.start);
      break;
    }
    if (token.raw === "--help" || token.raw === "-h") {
      return { help: true };
    }

    const key = optionKey(token.raw, spec);
    if (key === null) {
      throw new UsageError(`unknown option ${token.raw}. Put free text after "--" if it starts with "-".`);
    }
    if (key in options) {
      throw new UsageError(`duplicate option --${key}.`);
    }

    if (spec.booleans.includes(key)) {
      options[key] = true;
      cursor = skipWhitespace(raw, token.end);
      continue;
    }

    const valueStart = skipWhitespace(raw, token.end);
    if (valueStart >= raw.length) {
      throw new UsageError(`missing value for --${key}.`);
    }
    const value = readToken(raw, valueStart);
    if (value.unterminated) {
      throw new UsageError(`unterminated quote in the value of --${key}.`);
    }
    if (!value.quoted && value.raw.startsWith("-")) {
      throw new UsageError(`missing value for --${key}.`);
    }
    options[key] = value.value;
    cursor = skipWhitespace(raw, value.end);
  }

  if (spec.text === "forbidden" && text !== "") {
    const hint = spec.textForbiddenHint ? ` ${spec.textForbiddenHint}` : "";
    throw new UsageError(`unexpected text: ${JSON.stringify(text.slice(0, 40))}.${hint}`);
  }
  for (const [left, right] of spec.exclusive ?? []) {
    if (left in options && right in options) {
      throw new UsageError(`--${left} and --${right} cannot be used together.`);
    }
  }

  return { help: false, options, text };
}

export function stripTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

// Reads all of stdin. Asynchronous on purpose: a synchronous read of a
// non-blocking pipe can fail with EAGAIN.
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The command templates pass the user's arguments only through a quoted heredoc
// on stdin, so the shell never expands them.
export async function readArgumentInput(): Promise<string> {
  return stripTrailingNewline(await readStdin());
}
