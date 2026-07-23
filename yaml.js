// Minimal YAML subset parser/emitter for test case files.
//
// The emitter writes a deterministic, diff-friendly subset of YAML (plain or
// double-quoted scalars, block sequences, one level of mappings inside
// sequences). The parser reads that same subset plus common hand-written
// variations, and throws YamlUnsupportedError on anything beyond it (anchors,
// flow collections, block scalars, multi-document files) so the editor can
// fall back to raw-text editing instead of silently mangling a file.
//
// Type coercion intentionally follows PyYAML (YAML 1.1), because the CI
// scripts that build the dashboard index use PyYAML and both sides must agree
// on what a file means.

export class YamlUnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = "YamlUnsupportedError";
  }
}

const FIELD_ORDER = [
  "id",
  "title",
  "suite",
  "priority",
  "status",
  "automated",
  "owner",
  "tags",
  "linked_ticket",
  "preconditions",
  "steps",
  "created_at",
  "updated_at",
];

const STEP_FIELD_ORDER = ["action", "expected"];

// Conservative: anything outside this shape gets double-quoted.
const PLAIN_SAFE = /^[A-Za-z](?:[A-Za-z0-9 _.,/()&-]*[A-Za-z0-9_.,/()&-])?$/;
const TRUE_WORDS = new Set(["true", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "no", "off"]);
const NULL_WORDS = new Set(["null", "~"]);
const INT_RE = /^[-+]?\d+$/;
const FLOAT_RE = /^[-+]?(\d+\.\d*|\.\d+|\d+[eE][-+]?\d+|\d+\.\d*[eE][-+]?\d+)$/;

function isReservedWord(s) {
  const lower = s.toLowerCase();
  return TRUE_WORDS.has(lower) || FALSE_WORDS.has(lower) || NULL_WORDS.has(lower);
}

function emitScalar(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const s = String(value);
  if (PLAIN_SAFE.test(s) && !isReservedWord(s)) return s;
  return JSON.stringify(s);
}

function orderedEntries(obj, knownOrder) {
  const keys = Object.keys(obj).filter((k) => {
    const v = obj[k];
    return v !== undefined && v !== null && v !== "";
  });
  keys.sort((a, b) => {
    const ia = knownOrder.indexOf(a);
    const ib = knownOrder.indexOf(b);
    return (ia === -1 ? knownOrder.length : ia) - (ib === -1 ? knownOrder.length : ib);
  });
  return keys.map((k) => [k, obj[k]]);
}

export function emitTestCase(tc) {
  const lines = [];
  for (const [key, value] of orderedEntries(tc, FIELD_ORDER)) {
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          orderedEntries(item, STEP_FIELD_ORDER).forEach(([k, v], idx) => {
            lines.push(`${idx === 0 ? "  - " : "    "}${k}: ${emitScalar(v)}`);
          });
        } else {
          lines.push(`  - ${emitScalar(item)}`);
        }
      }
    } else {
      lines.push(`${key}: ${emitScalar(value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

// --- parser ---

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:[ ](.*))?$/;
const UNSUPPORTED_LEAD = new Set(["|", ">", "&", "*", "{", "[", "!", "?", "%", "@", "`"]);

function fail(msg, lineNo) {
  throw new YamlUnsupportedError(`${msg} (line ${lineNo})`);
}

function parseDoubleQuoted(s, lineNo) {
  let end = -1;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') {
      end = i;
      break;
    }
  }
  if (end === -1) fail("unterminated double-quoted string", lineNo);
  const rest = s.slice(end + 1).trim();
  if (rest !== "" && !rest.startsWith("#")) fail("trailing content after quoted string", lineNo);
  try {
    return JSON.parse(s.slice(0, end + 1));
  } catch {
    fail("unsupported escape in double-quoted string", lineNo);
  }
}

function parseSingleQuoted(s, lineNo) {
  let out = "";
  let i = 1;
  for (;;) {
    if (i >= s.length) fail("unterminated single-quoted string", lineNo);
    if (s[i] === "'") {
      if (s[i + 1] === "'") {
        out += "'";
        i += 2;
      } else {
        i++;
        break;
      }
    } else {
      out += s[i];
      i++;
    }
  }
  const rest = s.slice(i).trim();
  if (rest !== "" && !rest.startsWith("#")) fail("trailing content after quoted string", lineNo);
  return out;
}

function parseScalar(raw, lineNo) {
  let s = raw.trim();
  if (s.startsWith('"')) return parseDoubleQuoted(s, lineNo);
  if (s.startsWith("'")) return parseSingleQuoted(s, lineNo);
  if (s !== "" && UNSUPPORTED_LEAD.has(s[0])) fail(`unsupported YAML syntax "${s[0]}"`, lineNo);
  // A "#" preceded by whitespace starts a comment in a plain scalar.
  const hash = s.search(/\s#/);
  if (hash !== -1) s = s.slice(0, hash).trim();
  if (s === "") return null;
  if (/:(\s|$)/.test(s)) fail("ambiguous colon in unquoted value — quote the string", lineNo);
  const lower = s.toLowerCase();
  if (TRUE_WORDS.has(lower)) return true;
  if (FALSE_WORDS.has(lower)) return false;
  if (NULL_WORDS.has(lower)) return null;
  if (INT_RE.test(s)) return parseInt(s, 10);
  if (FLOAT_RE.test(s)) return parseFloat(s);
  return s;
}

export function parseYaml(text) {
  if (typeof text !== "string") throw new YamlUnsupportedError("input is not a string");
  const lines = [];
  const rawLines = text.split(/\r?\n/);
  for (let n = 0; n < rawLines.length; n++) {
    const raw = rawLines[n];
    if (/^\s*$/.test(raw)) continue;
    const leading = raw.match(/^[ \t]*/)[0];
    if (leading.includes("\t")) fail("tab characters in indentation", n + 1);
    const content = raw.slice(leading.length);
    if (content.startsWith("#")) continue;
    if (content === "---") {
      if (lines.length > 0) fail("multi-document YAML", n + 1);
      continue;
    }
    if (content === "..." || content.startsWith("%")) fail("unsupported document marker", n + 1);
    lines.push({ indent: leading.length, content, lineNo: n + 1 });
  }
  if (lines.length === 0) return {};
  if (lines[0].indent !== 0) fail("top level must not be indented", lines[0].lineNo);

  const state = { i: 0 };
  const doc = parseNode(lines, state, 0);
  if (state.i < lines.length) fail("unexpected indentation", lines[state.i].lineNo);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new YamlUnsupportedError("top level must be a mapping");
  }
  return doc;
}

function parseNode(lines, state, indent) {
  const line = lines[state.i];
  if (line.content === "-" || line.content.startsWith("- ")) {
    return parseSequence(lines, state, indent);
  }
  return parseMapping(lines, state, indent);
}

function parseMapping(lines, state, indent) {
  const obj = {};
  while (state.i < lines.length) {
    const line = lines[state.i];
    if (line.indent !== indent) {
      if (line.indent > indent) fail("unexpected indentation", line.lineNo);
      break;
    }
    if (line.content === "-" || line.content.startsWith("- ")) {
      fail("sequence item where mapping key expected", line.lineNo);
    }
    const m = line.content.match(KEY_RE);
    if (!m) fail("cannot parse line as key: value", line.lineNo);
    const key = m[1];
    if (Object.prototype.hasOwnProperty.call(obj, key)) fail(`duplicate key "${key}"`, line.lineNo);
    state.i++;
    if (m[2] === undefined || m[2].trim() === "" || m[2].trim().startsWith("#")) {
      const next = lines[state.i];
      if (next && next.indent > indent) {
        obj[key] = parseNode(lines, state, next.indent);
      } else {
        obj[key] = null;
      }
    } else {
      obj[key] = parseScalar(m[2], line.lineNo);
    }
  }
  return obj;
}

function parseSequence(lines, state, indent) {
  const items = [];
  while (state.i < lines.length) {
    const line = lines[state.i];
    if (line.indent !== indent || !(line.content === "-" || line.content.startsWith("- "))) {
      if (line.indent > indent) fail("unexpected indentation", line.lineNo);
      break;
    }
    if (line.content === "-") {
      state.i++;
      const next = lines[state.i];
      if (next && next.indent > indent) {
        items.push(parseNode(lines, state, next.indent));
      } else {
        items.push(null);
      }
      continue;
    }
    const spaces = line.content.match(/^-( +)/)[1].length;
    const itemIndent = indent + 1 + spaces;
    const remainder = line.content.slice(1 + spaces);
    if (KEY_RE.test(remainder)) {
      // Inline first key of a mapping item: re-frame this line as if the key
      // started at the item's indent, then parse a normal mapping block.
      lines[state.i] = { indent: itemIndent, content: remainder, lineNo: line.lineNo };
      items.push(parseMapping(lines, state, itemIndent));
    } else {
      items.push(parseScalar(remainder, line.lineNo));
      state.i++;
    }
  }
  return items;
}
