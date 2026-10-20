export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const strictLeadingOptions = Boolean(config.strictLeadingOptions);
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      if (strictLeadingOptions && positionals.length === 0) {
        throw new Error(`Unknown option --${rawKey}`);
      }
      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    if (strictLeadingOptions && positionals.length === 0) {
      throw new Error(`Unknown option -${shortKey}`);
    }
    positionals.push(token);
  }

  return { options, positionals };
}

function tokenizeRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let start = null;
  let quote = null;
  let escaping = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (start === null && !/\s/.test(character)) {
      start = index;
    }

    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (start !== null) {
        tokens.push({ value: current, start });
        current = "";
        start = null;
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (start !== null) {
    tokens.push({ value: current, start });
  }

  return tokens;
}

export function splitRawArgumentString(raw) {
  return tokenizeRawArgumentString(raw)
    .map((token) => token.value)
    .filter(Boolean);
}

// Splits only the leading options of a raw argument string and keeps everything
// from the first positional on verbatim, so free text such as a task prompt keeps
// its newlines and quotes and cannot smuggle in options like --write.
export function splitRawArgumentPrefix(raw, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const tokens = tokenizeRawArgumentString(raw);
  const argv = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const { value, start } = tokens[index];
    if (value === "--") {
      const rest = tokens[index + 1] ? raw.slice(tokens[index + 1].start).trim() : "";
      return rest ? [...argv, "--", rest] : argv;
    }
    if (!value.startsWith("-") || value === "-") {
      return [...argv, "--", raw.slice(start).trim()];
    }

    argv.push(value);
    const rawKey = value.startsWith("--") ? value.slice(2) : value.slice(1);
    const key = aliasMap[rawKey] ?? rawKey;
    if (valueOptions.has(key) && tokens[index + 1]) {
      index += 1;
      argv.push(tokens[index].value);
    }
  }

  return argv;
}
