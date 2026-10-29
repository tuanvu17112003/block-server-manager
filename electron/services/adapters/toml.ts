// Minimal TOML reader for packwiz metadata only.
//
// Why hand-written: this project ships exactly one runtime dependency (`yauzl`) and adding a general TOML
// library for four known shapes would be a poor trade. The subset implemented here is exactly what the
// packwiz schema uses, established by reading packwiz's own struct tags
// (docs/research/2026-10-29-p1c-format-census.md §3):
//
//   [table] and [table.sub] headers
//   key = "string"  (basic, with \" \\ \n \t escapes)
//   key = 'string'  (literal)
//   key = true/false
//   key = 123 / 1.5
//   key = [ "a", "b" ]            (inline array of scalars)
//   [[array.of.tables]]           (packwiz does not use it, but it is cheap and unambiguous)
//   # comments, blank lines
//
// Deliberately NOT supported (and detected as unsupported rather than silently mis-parsed): multi-line
// strings, inline tables `{a=1}`, heterogeneous arrays, dates, dotted keys without a table header.
// Anything unsupported throws `TomlParseError` so a caller fails closed instead of acting on a half-read file.

export class TomlParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `${message} (line ${line})`);
    this.name = 'TomlParseError';
  }
}

type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
export type TomlTable = { [key: string]: TomlValue };

/** Parse one TOML scalar token. Returns `undefined` when the token is not a supported scalar. */
function parseScalar(raw: string): TomlValue | undefined {
  const token = raw.trim();
  if (token === '') return undefined;
  if (token === 'true') return true;
  if (token === 'false') return false;
  // Basic string
  if (token.startsWith('"')) {
    if (!token.endsWith('"') || token.length < 2) return undefined;
    const body = token.slice(1, -1);
    if (/(?<!\\)"/.test(body)) return undefined;
    return body
      .replaceAll('\\"', '"')
      .replaceAll('\\n', '\n')
      .replaceAll('\\t', '\t')
      .replaceAll('\\\\', '\\');
  }
  // Literal string
  if (token.startsWith("'")) {
    if (!token.endsWith("'") || token.length < 2) return undefined;
    return token.slice(1, -1);
  }
  // Inline array of scalars
  if (token.startsWith('[')) {
    if (!token.endsWith(']')) return undefined;
    const inner = token.slice(1, -1).trim();
    if (inner === '') return [];
    const items: TomlValue[] = [];
    for (const part of splitTopLevel(inner)) {
      const value = parseScalar(part);
      if (value === undefined) return undefined;
      items.push(value);
    }
    return items;
  }
  if (/^[+-]?\d+$/.test(token)) return Number(token);
  if (/^[+-]?\d*\.\d+$/.test(token)) return Number(token);
  return undefined;
}

/** Split an inline array body on commas that are not inside a quoted string. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quote) {
      current += character;
      if (character === quote && input[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    if (character === ',') { parts.push(current); current = ''; continue; }
    current += character;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

/** Assign `value` at a dotted path, creating intermediate tables. */
function assign(root: TomlTable, path: string[], value: TomlValue, line: number): void {
  let cursor = root;
  for (const segment of path.slice(0, -1)) {
    const existing = cursor[segment];
    if (existing === undefined) {
      const created: TomlTable = {};
      cursor[segment] = created;
      cursor = created;
    } else if (Array.isArray(existing)) {
      // Assigning into an array-of-tables: use its last element.
      const last = existing[existing.length - 1];
      if (typeof last !== 'object' || last === null || Array.isArray(last)) {
        throw new TomlParseError(`cannot descend into array at "${segment}"`, line);
      }
      cursor = last as TomlTable;
    } else if (typeof existing === 'object') {
      cursor = existing as TomlTable;
    } else {
      throw new TomlParseError(`key "${segment}" is a scalar but used as a table`, line);
    }
  }
  const key = path[path.length - 1]!;
  if (Object.hasOwn(cursor, key) && !Array.isArray(cursor[key])) {
    throw new TomlParseError(`duplicate key "${path.join('.')}"`, line);
  }
  cursor[key] = value;
}

/** Parse a TOML document. Throws `TomlParseError` on anything outside the supported subset. */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let table: TomlTable = root;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index]!;
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    // [[array.of.tables]]
    const arrayHeader = line.match(/^\[\[(.+)\]\]$/);
    if (arrayHeader) {
      const path = splitDotted(arrayHeader[1]!, lineNumber);
      let cursor: TomlTable = root;
      for (const segment of path.slice(0, -1)) {
        const next = cursor[segment];
        if (next === undefined) { const created: TomlTable = {}; cursor[segment] = created; cursor = created; }
        else if (Array.isArray(next)) {
          const last = next[next.length - 1];
          if (typeof last !== 'object' || last === null || Array.isArray(last)) throw new TomlParseError('bad array of tables', lineNumber);
          cursor = last as TomlTable;
        } else if (typeof next === 'object') cursor = next as TomlTable;
        else throw new TomlParseError(`"${segment}" is not a table`, lineNumber);
      }
      const key = path[path.length - 1]!;
      const existing = cursor[key];
      const entry: TomlTable = {};
      if (Array.isArray(existing)) existing.push(entry);
      else if (existing === undefined) cursor[key] = [entry];
      else throw new TomlParseError(`"${key}" already defined`, lineNumber);
      table = entry;
      continue;
    }

    // [table]
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      const path = splitDotted(header[1]!, lineNumber);
      let cursor: TomlTable = root;
      for (const segment of path) {
        const next = cursor[segment];
        if (next === undefined) { const created: TomlTable = {}; cursor[segment] = created; cursor = created; }
        else if (Array.isArray(next)) {
          const last = next[next.length - 1];
          if (typeof last !== 'object' || last === null || Array.isArray(last)) throw new TomlParseError('bad table', lineNumber);
          cursor = last as TomlTable;
        } else if (typeof next === 'object') cursor = next as TomlTable;
        else throw new TomlParseError(`"${segment}" is not a table`, lineNumber);
      }
      table = cursor;
      continue;
    }

    // key = value
    const assignment = line.match(/^([A-Za-z0-9_.\-"']+)\s*=\s*(.+)$/);
    if (!assignment) throw new TomlParseError(`unsupported syntax: ${line.slice(0, 60)}`, lineNumber);
    const rawKey = assignment[1]!;
    const rawValue = assignment[2]!;
    if (rawValue.startsWith('"""') || rawValue.startsWith("'''")) {
      throw new TomlParseError('multi-line strings are not supported', lineNumber);
    }
    const value = parseScalar(rawValue);
    if (value === undefined) {
      throw new TomlParseError(`unsupported value for "${rawKey}": ${rawValue.slice(0, 40)}`, lineNumber);
    }
    const keyPath = rawKey.includes('.') ? splitDotted(rawKey, lineNumber) : [unquoteKey(rawKey)];
    assign(table, keyPath, value, lineNumber);
  }
  return root;
}

/** Remove a trailing `#` comment that is not inside a quoted string. */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote) {
      if (character === quote && line[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '#') return line.slice(0, index);
  }
  return line;
}

function unquoteKey(key: string): string {
  if (key.length >= 2 && ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))) {
    return key.slice(1, -1);
  }
  return key;
}

function splitDotted(input: string, line: number): string[] {
  const parts = splitTopLevel(input).map(part => unquoteKey(part.trim()));
  if (parts.some(part => part === '')) throw new TomlParseError(`bad table path "${input}"`, line);
  return parts;
}

/** Read a nested string value, or null. */
export function tomlString(table: TomlTable | undefined, ...path: string[]): string | null {
  const value = tomlAt(table, path);
  return typeof value === 'string' ? value : null;
}

/** Read a nested value. */
export function tomlAt(table: TomlTable | undefined, path: string[]): TomlValue | undefined {
  let cursor: TomlValue | undefined = table;
  for (const segment of path) {
    if (cursor === undefined || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as TomlTable)[segment];
  }
  return cursor;
}

/** Read a nested table, or undefined. */
export function tomlTable(table: TomlTable | undefined, ...path: string[]): TomlTable | undefined {
  const value = tomlAt(table, path);
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as TomlTable : undefined;
}
