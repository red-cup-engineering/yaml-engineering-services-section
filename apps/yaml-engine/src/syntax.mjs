/**
 * YAML 1.2 (core schema) syntax: the one reader and writer of YAML in the Group.
 *
 * `parseDocument(text, options)` reads one YAML document into an ordered syntax
 * tree that keeps source offsets, so edits can be made byte-for-byte:
 * `YAMLMap` and `YAMLSeq` (`items`, `flow`), `Scalar` (`value`, `type`), `Alias`
 * and `Pair` (`key`, `value`). Every node has `range: [start, valueEnd, nodeEnd]`.
 * Malformed input does not throw: the document carries `errors` (each with a
 * `code`, `pos` and `linePos`) and `warnings` (unresolved tags). `toJS` projects
 * the tree to values; `stringify` writes values as block-style YAML.
 *
 * Supported: block and flow collections, plain, single- and double-quoted
 * scalars with folding and escapes, literal and folded block scalars with
 * indentation and chomping indicators, comments, anchors and aliases, tags
 * (`!!str`, `!!int`, `!!float`, `!!bool`, `!!null`, `!!map`, `!!seq`; any other
 * tag is an unresolved-tag warning), explicit keys, `%YAML` and `%TAG`
 * directives. One document per source.
 */

export class Scalar {
  constructor(value) { this.value = value; }
}
export class YAMLMap {
  constructor() { this.items = []; this.flow = false; }
}
export class YAMLSeq {
  constructor() { this.items = []; this.flow = false; }
}
export class Pair {
  constructor(key, value) { this.key = key; this.value = value; }
}
export class Alias {
  constructor(source) { this.source = source; }
  /** The anchored node this alias names, among those that precede it. */
  resolve(document) {
    const anchored = document?.anchors?.get(this.source);
    return anchored !== undefined && anchored.range[0] < this.range[0] ? anchored : undefined;
  }
}

export const isScalar = (node) => node instanceof Scalar;
export const isMap = (node) => node instanceof YAMLMap;
export const isSeq = (node) => node instanceof YAMLSeq;
export const isPair = (node) => node instanceof Pair;
export const isAlias = (node) => node instanceof Alias;
export const isCollection = (node) => node instanceof YAMLMap || node instanceof YAMLSeq;
export const isNode = (node) => isScalar(node) || isCollection(node) || isAlias(node);

export class YAMLParseError extends SyntaxError {
  constructor(code, reason, pos, source) {
    const lines = lineTable(source);
    const where = linePositionOf(lines, pos[0]);
    const lineText = source.slice(lines[where.line - 1], source.indexOf("\n", lines[where.line - 1]) < 0 ? source.length : source.indexOf("\n", lines[where.line - 1])).replace(/\r$/u, "");
    super(`${reason} at line ${where.line}, column ${where.col}:\n\n${lineText}\n${" ".repeat(where.col - 1)}^\n`);
    this.name = "YAMLParseError";
    this.code = code;
    this.pos = pos;
    this.linePos = [where, linePositionOf(lines, pos[1])];
  }
}

function lineTable(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
    else if (source[index] === "\r" && source[index + 1] !== "\n") starts.push(index + 1);
  }
  return starts;
}
function lineIndexOf(starts, pos) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function linePositionOf(starts, pos) {
  const index = lineIndexOf(starts, pos);
  return { line: index + 1, col: pos - starts[index] + 1 };
}

const TAG_PREFIX = "tag:yaml.org,2002:";
const isBreak = (c) => c === undefined || c === "\n" || c === "\r";
const isBlank = (c) => c === " " || c === "\t";
const isSeparator = (c) => isBreak(c) || isBlank(c);
const FLOW_INDICATORS = ",[]{}";
const ESCAPES = { 0: "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: " ", L: " ", P: " " };

function resolvePlain(text, intAsBigInt) {
  if (text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (/^[-+]?[0-9]+$/u.test(text)) return intAsBigInt ? BigInt(text) : Number(text);
  if (/^0o[0-7]+$/u.test(text)) return intAsBigInt ? BigInt(text) : parseInt(text.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/u.test(text)) return intAsBigInt ? BigInt(text) : parseInt(text.slice(2), 16);
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/u.test(text)) return Number(text);
  if (/^[-+]?\.(?:inf|Inf|INF)$/u.test(text)) return text[0] === "-" ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/u.test(text)) return NaN;
  return text;
}

class Parser {
  constructor(source, options, document) {
    this.src = source;
    this.options = options;
    this.document = document;
    this.pos = 0;
    this.lines = lineTable(source);
    this.tagHandles = new Map([["!", "!"], ["!!", TAG_PREFIX]]);
  }

  error(code, reason, start = this.pos, end = start + 1) {
    this.document.errors.push(new YAMLParseError(code, reason, [start, Math.max(start, end)], this.src));
  }
  warn(code, reason, start, end) {
    this.document.warnings.push(new YAMLParseError(code, reason, [start, end], this.src));
  }
  col(pos) { return pos - this.lines[lineIndexOf(this.lines, pos)]; }
  atEnd() { return this.pos >= this.src.length; }
  at(pos = this.pos) { return this.src[pos]; }
  /** Document marker (`---` or `...`) at the start of a line. */
  marker(pos = this.pos) {
    return this.col(pos) === 0 && /^(?:---|\.\.\.)(?:[ \t\r\n]|$)/u.test(this.src.slice(pos, pos + 4));
  }
  skipInline() {
    while (isBlank(this.src[this.pos])) this.pos++;
  }
  /** Skip a comment that starts at `pos` (preceded by whitespace or a line start). */
  skipComment() {
    if (this.src[this.pos] !== "#") return;
    if (this.pos > 0 && !isBlank(this.src[this.pos - 1]) && !isBreak(this.src[this.pos - 1])) return;
    while (!isBreak(this.src[this.pos])) this.pos++;
  }
  newline() {
    if (this.src[this.pos] === "\r" && this.src[this.pos + 1] === "\n") this.pos += 2;
    else this.pos++;
  }
  /** Advance to the next content character, across blanks, comments and line breaks. */
  skipToContent() {
    for (;;) {
      this.skipInline();
      this.skipComment();
      if (isBreak(this.src[this.pos]) && this.pos < this.src.length) this.newline();
      else return;
    }
  }
  /** The end of the line holding `pos`, after trailing blanks and a comment, past its line break. */
  afterLine(pos) {
    let at = pos;
    while (isBlank(this.src[at])) at++;
    if (this.src[at] === "#") while (!isBreak(this.src[at])) at++;
    if (this.src[at] === "\r" && this.src[at + 1] === "\n") return at + 2;
    return isBreak(this.src[at]) && at < this.src.length ? at + 1 : at;
  }

  finish(node, start, valueEnd, nodeEnd = valueEnd) {
    node.range = [start, valueEnd, nodeEnd];
    return node;
  }
  nullScalar(at) {
    const node = new Scalar(null);
    node.type = "PLAIN";
    node.source = "";
    return this.finish(node, at, at);
  }

  // ---- properties: anchors and tags ----
  readProperties() {
    const props = { anchor: undefined, tag: undefined, start: this.pos, end: this.pos };
    for (;;) {
      const c = this.src[this.pos];
      if (c === "&" && props.anchor === undefined) {
        const begin = ++this.pos;
        while (!isSeparator(this.src[this.pos]) && !FLOW_INDICATORS.includes(this.src[this.pos])) this.pos++;
        props.anchor = this.src.slice(begin, this.pos);
        if (props.anchor === "") this.error("BAD_ALIAS", "Anchor name must not be empty", begin - 1);
      } else if (c === "!" && props.tag === undefined) {
        const begin = this.pos;
        if (this.src[this.pos + 1] === "<") {
          const close = this.src.indexOf(">", this.pos);
          this.pos = close < 0 ? this.src.length : close + 1;
          props.tag = this.src.slice(begin + 2, close < 0 ? this.src.length : close);
        } else {
          while (!isSeparator(this.src[this.pos]) && !FLOW_INDICATORS.includes(this.src[this.pos])) this.pos++;
          const written = this.src.slice(begin, this.pos);
          const handle = /^!(?:[0-9A-Za-z-]*!)?/u.exec(written)[0];
          props.tag = this.tagHandles.has(handle) ? this.tagHandles.get(handle) + decodeURIComponent(written.slice(handle.length)) : written;
          if (written === "!") props.tag = "!";
        }
      } else break;
      props.end = this.pos;
      if (!isBlank(this.src[this.pos])) break;
      this.skipInline();
    }
    return props.anchor === undefined && props.tag === undefined ? null : props;
  }
  applyProperties(node, props, start) {
    if (props === null) return node;
    if (props.anchor !== undefined) {
      node.anchor = props.anchor;
      this.document.anchors.set(props.anchor, node);
    }
    if (props.tag !== undefined) this.applyTag(node, props.tag, props);
    if (props.start < node.range[0]) node.range[0] = Math.min(node.range[0], start ?? props.start);
    return node;
  }
  applyTag(node, tag, props) {
    node.tag = tag;
    const core = tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : null;
    if (node instanceof Scalar) {
      if (tag === "!" || core === "str") { node.value = node.source ?? String(node.value ?? ""); return; }
      const text = node.source ?? "";
      if (core === "null") { node.value = null; return; }
      if (core === "bool") {
        const resolved = resolvePlain(text, false);
        if (typeof resolved === "boolean") node.value = resolved; else this.error("BAD_SCALAR", `Cannot resolve ${JSON.stringify(text)} as !!bool`, node.range[0], node.range[1]);
        return;
      }
      if (core === "int") {
        const resolved = resolvePlain(text, this.options.intAsBigInt);
        if (typeof resolved === "bigint" || (typeof resolved === "number" && Number.isInteger(resolved) && !/[.eE]/u.test(text))) node.value = resolved;
        else this.error("BAD_SCALAR", `Cannot resolve ${JSON.stringify(text)} as !!int`, node.range[0], node.range[1]);
        return;
      }
      if (core === "float") {
        const resolved = resolvePlain(text, false);
        if (typeof resolved === "number") node.value = resolved; else this.error("BAD_SCALAR", `Cannot resolve ${JSON.stringify(text)} as !!float`, node.range[0], node.range[1]);
        return;
      }
    } else if (node instanceof YAMLMap && core === "map") return;
    else if (node instanceof YAMLSeq && core === "seq") return;
    this.warn("TAG_RESOLVE_FAILED", `Unresolved tag: ${tag}`, props.start, props.end);
  }

  // ---- block nodes ----
  /**
   * The node whose content starts at or after the current position and is
   * indented deeper than `parentIndent` (a block sequence may sit at `parentIndent`
   * itself when `sameIndentSeq`). Returns null, consuming nothing past blank
   * lines, when no node is there.
   */
  parseBlockNode(parentIndent, sameIndentSeq = false, inlineValue = false) {
    const origin = this.pos;
    this.skipToContent();
    if (this.atEnd() || this.marker()) return null;
    const props = this.readProperties();
    let propsOnOwnLine = false;
    if (props !== null) {
      const probe = this.pos;
      this.skipInline();
      this.skipComment();
      if (isBreak(this.src[this.pos])) {
        propsOnOwnLine = true;
        this.skipToContent();
        if (this.atEnd() || this.marker()) return this.applyProperties(this.nullScalar(props.end), props, props.start);
      } else this.pos = probe, this.skipInline();
    }
    const start = this.pos;
    const indent = this.col(propsOnOwnLine || props === null ? start : props.start);
    const here = this.src[this.pos];
    const seqAllowed = sameIndentSeq && here === "-" && isSeparator(this.src[this.pos + 1]) && indent >= parentIndent;
    if (this.col(start) <= parentIndent && !seqAllowed) {
      if (props !== null) return this.applyProperties(this.nullScalar(props.end), props, props.start);
      this.pos = Math.max(origin, this.pos);
      return null;
    }
    const nodeStart = propsOnOwnLine || props === null ? start : props.start;
    if (here === "-" && isSeparator(this.src[this.pos + 1])) {
      if (inlineValue) this.error("BLOCK_IN_FLOW", "Block sequence is not allowed here", this.pos);
      return this.applyProperties(this.parseBlockSeq(this.col(start)), props, nodeStart);
    }
    if (here === "?" && isSeparator(this.src[this.pos + 1])) {
      return this.applyProperties(this.parseBlockMap(this.col(start), null), props, nodeStart);
    }
    const node = this.parseInlineNode(parentIndent, false);
    // An implicit key: this scalar is followed by a colon on its own line.
    const after = this.pos;
    this.skipInline();
    if (this.src[this.pos] === ":" && isSeparator(this.src[this.pos + 1]) && node.kind !== "block-scalar" && this.lineOf(node.range[0]) === this.lineOf(this.pos)) {
      if (inlineValue) this.error("BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings", node.range[0], node.range[1]);
      const keyIndent = this.col(props !== null && !propsOnOwnLine ? props.start : node.range[0]);
      if (props !== null && !propsOnOwnLine) this.applyProperties(node, props, props.start);
      const map = this.parseBlockMap(keyIndent, node);
      return propsOnOwnLine ? this.applyProperties(map, props, nodeStart) : map;
    }
    this.pos = after;
    if (props !== null) this.applyProperties(node, props, nodeStart);
    this.rejectTrailing(node);
    return node;
  }
  lineOf(pos) { return lineIndexOf(this.lines, pos); }
  /** Text after a complete node on its line, other than a comment, is an error. */
  rejectTrailing(node) {
    if (node.kind === "block-scalar") return;
    const at = this.pos;
    this.skipInline();
    if (isBreak(this.src[this.pos]) || (this.src[this.pos] === "#" )) { this.pos = at; return; }
    this.error("UNEXPECTED_TOKEN", "Unexpected scalar at node end", this.pos);
    while (!isBreak(this.src[this.pos])) this.pos++;
  }

  /** A scalar, alias or flow collection that starts at the current position. */
  parseInlineNode(parentIndent, flow) {
    const c = this.src[this.pos];
    const start = this.pos;
    if (c === "*") {
      this.pos++;
      const begin = this.pos;
      while (!isSeparator(this.src[this.pos]) && !(flow && FLOW_INDICATORS.includes(this.src[this.pos]))) this.pos++;
      const alias = new Alias(this.src.slice(begin, this.pos));
      if (alias.source === "") this.error("BAD_ALIAS", "Alias name must not be empty", start);
      this.finish(alias, start, this.pos);
      if (!this.document.anchors.has(alias.source)) this.error("BAD_ALIAS", `Aliased anchor not found: ${alias.source}`, start, this.pos);
      return alias;
    }
    if (c === "[" || c === "{") return this.parseFlowCollection();
    if (c === '"' || c === "'") return this.parseQuoted(c, parentIndent);
    if ((c === "|" || c === ">") && !flow) return this.parseBlockScalar(parentIndent);
    return this.parsePlain(parentIndent, flow);
  }

  parseBlockSeq(indent) {
    const seq = new YAMLSeq();
    const start = this.pos;
    let end = start;
    for (;;) {
      const entryStart = this.pos;
      this.pos++;
      let item = this.parseBlockNode(indent, false);
      if (item === null) item = this.nullScalar(entryStart + 1);
      seq.items.push(item);
      end = Math.max(end, this.afterLine(item.range[2] ?? item.range[1]));
      this.skipToContent();
      if (this.atEnd() || this.marker()) break;
      const column = this.col(this.pos);
      if (column === indent && this.src[this.pos] === "-" && isSeparator(this.src[this.pos + 1])) continue;
      if (column > indent) {
        this.error("BAD_INDENT", "All collection items must start at the same column", this.pos);
        while (!isBreak(this.src[this.pos])) this.pos++;
        continue;
      }
      break;
    }
    return this.finish(seq, start, end, end);
  }

  parseBlockMap(indent, firstKey) {
    const map = new YAMLMap();
    const start = firstKey === null ? this.pos : firstKey.range[0];
    let end = start;
    let pending = firstKey;
    const seen = [];
    for (;;) {
      let key = pending;
      pending = null;
      let explicit = false;
      if (key === null) {
        if (this.src[this.pos] === "?" && isSeparator(this.src[this.pos + 1])) {
          explicit = true;
          this.pos++;
          key = this.parseBlockNode(indent, false) ?? this.nullScalar(this.pos);
        } else {
          key = this.parseKey();
        }
      }
      let value = null;
      const keyEnd = key.range[2] ?? key.range[1];
      const resume = this.pos;
      this.skipInline();
      if (explicit) {
        this.skipToContent();
        if (this.col(this.pos) === indent && this.src[this.pos] === ":" && isSeparator(this.src[this.pos + 1])) {
          this.pos++;
          value = this.parseMapValue(indent);
        } else this.pos = resume;
      } else if (this.src[this.pos] === ":" && isSeparator(this.src[this.pos + 1])) {
        this.pos++;
        value = this.parseMapValue(indent);
      } else if (this.src[this.pos] === ":" && this.src[this.pos + 1] !== undefined && (key.type === "QUOTE_DOUBLE" || key.type === "QUOTE_SINGLE")) {
        this.pos++;
        value = this.parseMapValue(indent);
      } else {
        this.error("MISSING_CHAR", "Implicit map keys need to be followed by map values", this.pos);
        while (!isBreak(this.src[this.pos])) this.pos++;
      }
      const pair = new Pair(key, value ?? this.nullScalar(keyEnd));
      if (value === null) pair.value = this.nullScalar(keyEnd);
      pair.srcToken = { start: [] };
      const identity = keyIdentity(key);
      if (identity !== undefined) {
        if (seen.includes(identity)) this.error("DUPLICATE_KEY", "Map keys must be unique", key.range[0], key.range[1]);
        seen.push(identity);
      }
      map.items.push(pair);
      end = Math.max(end, this.afterLine(pair.value.range[2] ?? pair.value.range[1]));
      this.skipToContent();
      if (this.atEnd() || this.marker()) break;
      const column = this.col(this.pos);
      if (column === indent && !(this.src[this.pos] === "-" && isSeparator(this.src[this.pos + 1]))) continue;
      if (column > indent) {
        this.error("BAD_INDENT", "Implicit map keys need to be on a single line", this.pos);
        while (!isBreak(this.src[this.pos])) this.pos++;
        this.skipToContent();
        if (this.atEnd() || this.col(this.pos) !== indent) break;
        continue;
      }
      if (column === indent) this.error("UNEXPECTED_TOKEN", "A block sequence may not be used as an implicit map key", this.pos);
      break;
    }
    return this.finish(map, start, end, end);
  }

  parseMapValue(indent) {
    this.skipInline();
    const inline = !isBreak(this.src[this.pos]) && this.src[this.pos] !== "#";
    const value = this.parseBlockNode(indent, true, inline);
    return value;
  }

  /** An implicit mapping key: one line, scalar, alias or flow collection. */
  parseKey() {
    const props = this.readProperties();
    if (this.src[this.pos] === "-" && isSeparator(this.src[this.pos + 1])) {
      this.error("UNEXPECTED_TOKEN", "A block sequence may not be used as an implicit map key", this.pos);
    }
    const node = this.parseInlineNode(-1, false);
    if (props !== null) this.applyProperties(node, props, props.start);
    return node;
  }

  // ---- scalars ----
  parsePlain(parentIndent, flow) {
    const start = this.pos;
    const first = this.src[this.pos];
    if (first === "@" || first === "`") {
      this.error("BAD_SCALAR_START", `Plain value cannot start with reserved character ${first}`, start);
    } else if (!flow && (first === "," || first === "]" || first === "}")) {
      this.error("UNEXPECTED_TOKEN", `Unexpected ${first}`, start);
    } else if (first === "%" && this.col(start) === 0) {
      this.error("BAD_DIRECTIVE", "Directives are not allowed here", start);
    }
    const scan = (from) => {
      let at = from;
      while (at < this.src.length) {
        const ch = this.src[at];
        if (isBreak(ch)) break;
        if (ch === ":" && (isSeparator(this.src[at + 1]) || (flow && FLOW_INDICATORS.includes(this.src[at + 1])))) break;
        if (ch === "#" && isBlank(this.src[at - 1])) break;
        if (flow && FLOW_INDICATORS.includes(ch)) break;
        at++;
      }
      return at;
    };
    let end = scan(start);
    let stop = end;
    while (stop > start && isBlank(this.src[stop - 1])) stop--;
    const parts = [this.src.slice(start, stop)];
    let valueEnd = stop;
    this.pos = end;
    // Continuation lines of a multi-line plain scalar.
    if (isBreak(this.src[this.pos]) && this.pos < this.src.length) {
      let cursor = this.pos;
      let blanks = 0;
      for (;;) {
        let at = cursor;
        if (this.src[at] === "\r" && this.src[at + 1] === "\n") at += 2; else at++;
        let lineStart = at;
        while (isBlank(this.src[at])) at++;
        if (isBreak(this.src[at]) && at < this.src.length) { blanks++; cursor = at; continue; }
        if (at >= this.src.length) break;
        const column = at - lineStart;
        if (column <= parentIndent || this.marker(lineStart) || this.src[at] === "#") break;
        if (flow && FLOW_INDICATORS.includes(this.src[at])) break;
        if (!flow && this.src[at] === ":" && isSeparator(this.src[at + 1])) break;
        const lineEnd = scan(at);
        let trimmed = lineEnd;
        while (trimmed > at && isBlank(this.src[trimmed - 1])) trimmed--;
        if (this.src[lineEnd] === ":" ) {
          this.error("BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings", at, lineEnd);
          break;
        }
        parts.push("\n".repeat(blanks) || " ");
        parts.push(this.src.slice(at, trimmed));
        blanks = 0;
        valueEnd = trimmed;
        this.pos = lineEnd;
        cursor = lineEnd;
        if (!isBreak(this.src[lineEnd]) || lineEnd >= this.src.length) break;
      }
      if (valueEnd !== stop) end = this.pos;
    }
    const text = parts.join("");
    const node = new Scalar(null);
    node.type = "PLAIN";
    node.source = text;
    node.value = resolvePlain(text, this.options.intAsBigInt);
    this.finish(node, start, valueEnd, valueEnd);
    this.pos = valueEnd === stop ? end : this.pos;
    if (parts.length === 1) this.pos = end;
    return node;
  }

  parseQuoted(quote, parentIndent) {
    const start = this.pos;
    let at = start + 1;
    let out = "";
    let closed = false;
    const lineText = [];
    let segment = "";
    const flush = (trimEnd) => {
      lineText.push(trimEnd ? segment.replace(/[ \t]+$/u, "") : segment);
      segment = "";
    };
    while (at < this.src.length) {
      const ch = this.src[at];
      if (quote === "'" && ch === "'") {
        if (this.src[at + 1] === "'") { segment += "'"; at += 2; continue; }
        closed = true; at++; break;
      }
      if (quote === '"' && ch === '"') { closed = true; at++; break; }
      if (quote === '"' && ch === "\\") {
        const next = this.src[at + 1];
        if (isBreak(next) && next !== undefined) {
          // Escaped line break: join without a space, and skip the next line's indentation.
          flush(false);
          lineText.push("\u0000join");
          at += 2;
          if (next === "\r" && this.src[at] === "\n") at++;
          while (isBlank(this.src[at])) at++;
          continue;
        }
        if (next === "x" || next === "u" || next === "U") {
          const width = next === "x" ? 2 : next === "u" ? 4 : 8;
          const digits = this.src.slice(at + 2, at + 2 + width);
          if (!new RegExp(`^[0-9a-fA-F]{${width}}$`, "u").test(digits)) {
            this.error("BAD_DQ_ESCAPE", `Invalid escape sequence ${this.src.slice(at, at + 2 + width)}`, at, at + 2 + width);
            at += 2;
            continue;
          }
          const code = parseInt(digits, 16);
          if (code > 0x10ffff) { this.error("BAD_DQ_ESCAPE", "Invalid code point", at, at + 2 + width); at += 2 + width; continue; }
          segment += String.fromCodePoint(code);
          at += 2 + width;
          continue;
        }
        if (Object.hasOwn(ESCAPES, next)) { segment += ESCAPES[next]; at += 2; continue; }
        this.error("BAD_DQ_ESCAPE", `Invalid escape sequence ${this.src.slice(at, at + 2)}`, at, at + 2);
        at += 2;
        continue;
      }
      if (isBreak(ch)) {
        if (ch === "\r" && this.src[at + 1] === "\n") at++;
        at++;
        flush(true);
        lineText.push("\u0000break");
        while (isBlank(this.src[at])) at++;
        continue;
      }
      segment += ch;
      at++;
    }
    if (!closed) {
      this.error("MISSING_CHAR", `Missing closing ${quote} quote`, start, this.src.length);
      at = this.src.length;
    }
    flush(false);
    // Fold the recorded lines.
    for (let index = 0; index < lineText.length; index++) {
      const piece = lineText[index];
      if (piece === "\u0000join") continue;
      if (piece === "\u0000break") {
        let breaks = 1;
        while (lineText[index + 1] === "" && lineText[index + 2] === "\u0000break") { breaks++; index += 2; }
        out += breaks === 1 ? " " : "\n".repeat(breaks - 1);
        continue;
      }
      out += piece;
    }
    const node = new Scalar(out);
    node.type = quote === '"' ? "QUOTE_DOUBLE" : "QUOTE_SINGLE";
    node.source = out;
    this.pos = at;
    return this.finish(node, start, at, at);
  }

  parseBlockScalar(parentIndent) {
    const start = this.pos;
    const literal = this.src[this.pos] === "|";
    this.pos++;
    let chomp = "clip", explicit = 0;
    for (let i = 0; i < 2; i++) {
      const ch = this.src[this.pos];
      if (ch === "+" || ch === "-") { chomp = ch === "+" ? "keep" : "strip"; this.pos++; }
      else if (ch >= "1" && ch <= "9") { explicit = Number(ch); this.pos++; }
    }
    this.skipInline();
    this.skipComment();
    if (!isBreak(this.src[this.pos])) {
      this.error("UNEXPECTED_TOKEN", "Block scalar header must be followed by a line break", this.pos);
      while (!isBreak(this.src[this.pos])) this.pos++;
    }
    if (this.pos < this.src.length) this.newline();
    const base = Math.max(parentIndent, -1);
    let blockIndent = explicit > 0 ? Math.max(base, 0) + explicit : -1;
    const lines = [];
    let cursor = this.pos;
    let last = this.pos;
    while (cursor < this.src.length) {
      let at = cursor;
      while (this.src[at] === " ") at++;
      const indentHere = at - cursor;
      const rest = this.src.slice(at, this.src.indexOf("\n", at) < 0 ? this.src.length : this.src.indexOf("\n", at)).replace(/\r$/u, "");
      const empty = at >= this.src.length || isBreak(this.src[at]) || (this.src[at] === "\t" && rest.trim() === "" && blockIndent >= 0 && indentHere < blockIndent);
      const lineEnd = this.src.indexOf("\n", cursor) < 0 ? this.src.length : this.src.indexOf("\n", cursor) + 1;
      if (empty) {
        lines.push({ text: blockIndent >= 0 && indentHere > blockIndent ? " ".repeat(indentHere - blockIndent) : "", empty: true });
        cursor = lineEnd;
        continue;
      }
      if (blockIndent < 0) {
        if (indentHere <= base) break;
        blockIndent = indentHere;
      }
      if (indentHere < blockIndent || this.marker(cursor)) break;
      const raw = this.src.slice(cursor, lineEnd).replace(/\r?\n$/u, "");
      lines.push({ text: raw.slice(blockIndent), empty: false });
      cursor = lineEnd;
      last = lineEnd;
    }
    // Trailing empty lines belong to the scalar for chomping, but not to its tree range unless kept.
    let trailing = 0;
    while (lines.length && lines.at(-1).empty) { lines.pop(); trailing++; }
    let value;
    if (lines.length === 0) value = chomp === "keep" ? "\n".repeat(trailing) : "";
    else {
      let body;
      if (literal) body = lines.map((line) => line.text).join("\n");
      else {
        body = "";
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          if (index === 0) { body = line.text; continue; }
          const previous = lines[index - 1];
          const moreIndented = (item) => !item.empty && /^[ \t]/u.test(item.text);
          if (line.empty) { body += "\n"; continue; }
          if (previous.empty) {
            // A run of empty lines after text: the first break is folded away unless a more-indented line is involved.
            let back = index - 1;
            while (back >= 0 && lines[back].empty) back--;
            const before = lines[back];
            body += moreIndented(before) || moreIndented(line) ? "\n" : "";
            body += line.text;
          } else body += moreIndented(previous) || moreIndented(line) ? "\n" + line.text : " " + line.text;
        }
      }
      value = chomp === "strip" ? body : chomp === "keep" ? body + "\n" + "\n".repeat(trailing) : body + "\n";
    }
    const node = new Scalar(value);
    node.type = literal ? "BLOCK_LITERAL" : "BLOCK_FOLDED";
    node.source = value;
    node.kind = "block-scalar";
    const end = chomp === "keep" ? cursor : last;
    this.pos = end;
    return this.finish(node, start, Math.max(end, start + 1), Math.max(end, start + 1));
  }

  // ---- flow collections ----
  skipFlowSpace() {
    for (;;) {
      this.skipInline();
      this.skipComment();
      if (isBreak(this.src[this.pos]) && this.pos < this.src.length) this.newline(); else return;
    }
  }
  parseFlowNode() {
    const props = this.readProperties();
    const start = props === null ? this.pos : props.start;
    const c = this.src[this.pos];
    let node;
    if (c === undefined || c === "," || c === "]" || c === "}" || (c === ":" && (isSeparator(this.src[this.pos + 1]) || FLOW_INDICATORS.includes(this.src[this.pos + 1])))) {
      node = this.nullScalar(this.pos);
    } else node = this.parseInlineNode(-1, true);
    return this.applyProperties(node, props, start);
  }
  parseFlowCollection() {
    const open = this.src[this.pos];
    const isMapping = open === "{";
    const close = isMapping ? "}" : "]";
    const collection = isMapping ? new YAMLMap() : new YAMLSeq();
    collection.flow = true;
    const start = this.pos;
    this.pos++;
    let comma = null;
    for (;;) {
      this.skipFlowSpace();
      const c = this.src[this.pos];
      if (c === close) { this.pos++; break; }
      if (c === undefined) {
        this.error("MISSING_CHAR", `Flow ${isMapping ? "map" : "sequence"} must end with ${close}`, start, this.pos);
        break;
      }
      if (c === ",") {
        this.error("UNEXPECTED_TOKEN", "Unexpected , in flow collection", this.pos);
        this.pos++;
        continue;
      }
      let key;
      if (c === "?" && isSeparator(this.src[this.pos + 1])) { this.pos++; this.skipFlowSpace(); key = this.parseFlowNode(); }
      else key = this.parseFlowNode();
      this.skipFlowSpace();
      let value = null, hasValue = false;
      const adjacent = key.type === "QUOTE_DOUBLE" || key.type === "QUOTE_SINGLE" || key instanceof YAMLMap || key instanceof YAMLSeq;
      if (this.src[this.pos] === ":" && (isSeparator(this.src[this.pos + 1]) || FLOW_INDICATORS.includes(this.src[this.pos + 1]) || adjacent)) {
        this.pos++;
        this.skipFlowSpace();
        hasValue = true;
        value = this.parseFlowNode();
      }
      const itemEnd = (hasValue ? value : key).range[2] ?? (hasValue ? value : key).range[1];
      if (isMapping) {
        const pair = new Pair(key, hasValue ? value : this.nullScalar(itemEnd));
        pair.srcToken = { start: comma === null ? [] : [{ type: "comma", offset: comma }] };
        collection.items.push(pair);
      } else if (hasValue) {
        const single = new YAMLMap();
        single.flow = true;
        const pair = new Pair(key, value);
        pair.srcToken = { start: comma === null ? [] : [{ type: "comma", offset: comma }] };
        single.items.push(pair);
        this.finish(single, key.range[0], itemEnd);
        collection.items.push(single);
      } else collection.items.push(key);
      comma = null;
      this.skipFlowSpace();
      if (this.src[this.pos] === ",") { comma = this.pos; this.pos++; }
      else if (this.src[this.pos] !== close && this.src[this.pos] !== undefined) {
        this.error("MISSING_CHAR", `Missing , or ${close} between flow collection items`, this.pos);
        while (!isBreak(this.src[this.pos]) && this.src[this.pos] !== close) this.pos++;
      }
    }
    return this.finish(collection, start, this.pos);
  }

  // ---- document ----
  parseDocumentContent() {
    const document = this.document;
    // Directives.
    let sawDirective = false;
    for (;;) {
      this.skipToContent();
      if (this.src[this.pos] === "%" && this.col(this.pos) === 0) {
        sawDirective = true;
        const lineEnd = this.src.indexOf("\n", this.pos) < 0 ? this.src.length : this.src.indexOf("\n", this.pos);
        const words = this.src.slice(this.pos, lineEnd).replace(/#.*$/u, "").trim().split(/[ \t]+/u);
        if (words[0] === "%YAML") {
          if (!/^1\.[0-9]+$/u.test(words[1] ?? "")) this.error("BAD_DIRECTIVE", "Invalid %YAML directive", this.pos, lineEnd);
          else document.directives.yaml.version = words[1];
        } else if (words[0] === "%TAG") {
          if (words.length < 3) this.error("BAD_DIRECTIVE", "Invalid %TAG directive", this.pos, lineEnd);
          else this.tagHandles.set(words[1], words[2]);
        }
        this.pos = lineEnd;
        continue;
      }
      break;
    }
    if (this.src.startsWith("---", this.pos) && this.col(this.pos) === 0 && isSeparator(this.src[this.pos + 3])) {
      this.pos += 3;
    } else if (sawDirective) this.error("MISSING_CHAR", "Missing directives-end indicator line", this.pos);
    const contents = this.parseBlockNode(-1, false, false);
    document.contents = contents;
    this.skipToContent();
    if (!this.atEnd()) {
      if (this.src.startsWith("...", this.pos) && this.col(this.pos) === 0) {
        this.pos += 3;
        this.skipToContent();
      }
      if (!this.atEnd()) {
        if (this.src.startsWith("---", this.pos) && this.col(this.pos) === 0)
          this.error("MULTIPLE_DOCS", "Source contains multiple documents; please use a multi-document reader", this.pos);
        else this.error("UNEXPECTED_TOKEN", "Unexpected content after the document's root node", this.pos);
      }
    }
  }
}

function keyIdentity(key) {
  if (key instanceof Scalar) return `${typeof key.value}:${String(key.value)}`;
  return undefined;
}

export class Document {
  constructor(value, options = {}) {
    this.version = options.version ?? "1.2";
    this.value = value;
    this.contents = null;
    this.errors = [];
    this.warnings = [];
    this.anchors = new Map();
    this.directives = { yaml: { version: this.version } };
    this.options = options;
  }

  /** Project the tree (or the value this document was made from) to values. */
  toJS({ maxAliasCount = 100 } = {}) {
    if (this.contents === null && this.value !== undefined) return this.value;
    const options = this.options;
    const made = new Map();
    let aliasCount = 0;
    const countAliases = (node, visiting = new Set()) => {
      if (node === null || node === undefined || visiting.has(node)) return 0;
      visiting.add(node);
      let total = 0;
      if (node instanceof Alias) total = 1 + countAliases(this.anchors.get(node.source), visiting);
      else if (node instanceof Pair) total = countAliases(node.key, visiting) + countAliases(node.value, visiting);
      else if (isCollection(node)) for (const item of node.items) total += countAliases(item, visiting);
      visiting.delete(node);
      return total;
    };
    const keyOf = (key) => {
      const projected = project(key);
      if (projected === null || (typeof projected !== "object" && typeof projected !== "bigint") || typeof projected === "bigint") return String(projected);
      return JSON.stringify(projected, (_, item) => (typeof item === "bigint" ? Number(item) : item));
    };
    const project = (node) => {
      if (node === null || node === undefined) return null;
      if (node instanceof Alias) {
        const source = this.anchors.get(node.source);
        if (source === undefined) throw new ReferenceError(`Unresolved alias (the anchor must be set before the alias): ${node.source}`);
        aliasCount += 1;
        if (maxAliasCount >= 0 && aliasCount * Math.max(1, countAliases(source)) > maxAliasCount)
          throw new ReferenceError("Excessive alias count indicates a resource exhaustion attack");
        return project(source);
      }
      if (made.has(node)) return made.get(node);
      if (node instanceof Scalar) return node.value;
      if (node instanceof YAMLSeq) {
        const array = [];
        made.set(node, array);
        for (const item of node.items) array.push(project(item));
        return array;
      }
      const object = {};
      made.set(node, object);
      for (const pair of node.items) {
        const name = options.stringKeys === true || typeof project(pair.key) !== "string" ? keyOf(pair.key) : project(pair.key);
        Object.defineProperty(object, name, { value: project(pair.value), enumerable: true, writable: true, configurable: true });
      }
      return object;
    };
    return project(this.contents);
  }

  toString() {
    return stringify(this.value);
  }
}

export function parseDocument(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("yaml: source must be a string");
  const document = new Document(undefined, options);
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const parser = new Parser(source, options, document);
  parser.parseDocumentContent();
  document.contents ??= null;
  if (options.version !== undefined) document.directives.yaml.version = document.directives.yaml.version ?? options.version;
  return document;
}

/** Read YAML text into values; refuses a document that has errors. */
export function parse(text, options = {}) {
  const document = parseDocument(text, options);
  if (document.errors.length) throw document.errors[0];
  return document.toJS(options);
}

/**
 * Visit nodes depth-first. `visitor` is a function `(key, node, path)` or an
 * object with `Alias`, `Scalar`, `Map`, `Seq`, `Pair` and `Node` methods; `path` is the
 * list of ancestors, starting with the document.
 */
export function visit(document, visitor) {
  const call = (name, key, node, path) => {
    const handler = typeof visitor === "function" ? visitor : visitor[name] ?? visitor.Node;
    return typeof handler === "function" ? handler(key, node, path) : undefined;
  };
  const walk = (key, node, path) => {
    if (node === null || node === undefined) return;
    const name = node instanceof Pair ? "Pair" : node instanceof Alias ? "Alias" : node instanceof Scalar ? "Scalar" : node instanceof YAMLMap ? "Map" : "Seq";
    call(name, key, node, path);
    const below = [...path, node];
    if (node instanceof Pair) {
      walk("key", node.key, below);
      walk("value", node.value, below);
    } else if (isCollection(node)) node.items.forEach((item, index) => walk(index, item, below));
  };
  walk(null, document.contents, [document]);
}

// ---- writing ----
const PLAIN_UNSAFE_START = /^[-?:,[\]{}#&*!|>'"%@`]/u;
function plainOk(text) {
  if (text === "" || text !== text.trim() || /[\n\r\t]/u.test(text)) return false;
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u0084\u0086-\u009f\ud800-\udfff￾￿]/u.test(text)) return false;
  if (PLAIN_UNSAFE_START.test(text) && !/^[-?:][^\s]/u.test(text)) return false;
  if (/^[-?:][^\s]/u.test(text) && /^[-?:]$/u.test(text)) return false;
  if (/: |:$| #/u.test(text)) return false;
  const document = parseDocument(text);
  return document.errors.length === 0 && document.warnings.length === 0 && document.contents instanceof Scalar
    && document.contents.type === "PLAIN" && document.contents.value === text;
}
function quote(text) {
  return JSON.stringify(text).replace(/[\u007f-\u0084\u0086-\u009f￾￿]/gu,
    (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}
function scalarText(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ".nan";
    if (!Number.isFinite(value)) return value > 0 ? ".inf" : "-.inf";
    return String(value);
  }
  if (typeof value === "string") return plainOk(value) ? value : quote(value);
  throw new TypeError(`yaml: cannot write a value of type ${typeof value}`);
}
function writeNode(value, indent, lines, prefix) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value) && value.length > 0) {
    value.forEach((item, index) => {
      const lead = index === 0 && prefix !== null ? prefix : pad;
      writeEntry(lead + "- ", item, indent + 2, lines);
    });
    return;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
    Object.entries(value).forEach(([key, item], index) => {
      if (item === undefined) return;
      const lead = index === 0 && prefix !== null ? prefix : pad;
      const name = plainOk(key) && !/^[-?:]/u.test(key) ? key : quote(key);
      writeEntry(`${lead}${name}:`, item, indent + (Array.isArray(item) ? 2 : 2), lines, true);
    });
  }
}
function writeEntry(head, item, childIndent, lines, isKey = false) {
  if (Array.isArray(item) && item.length > 0) {
    if (isKey) { lines.push(head); writeNode(item, childIndent, lines, null); }
    else writeNode(item, childIndent, lines, head);
  } else if (item !== null && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length > 0) {
    if (isKey) { lines.push(head); writeNode(item, childIndent, lines, null); }
    else writeNode(item, childIndent, lines, head);
  } else if (Array.isArray(item)) lines.push(`${head}${isKey ? " " : ""}[]`);
  else if (item !== null && typeof item === "object") lines.push(`${head}${isKey ? " " : ""}{}`);
  else if (typeof item === "string" && item.includes("\n") && !/[\u0000-\u0008\u000b-\u001f\u007f-\u0084\u0086-\u009f\ud800-\udfff￾￿\r]/u.test(item) && !/^\n|[ \t]\n/u.test(item) && item.trim() !== "") {
    const chomp = item.endsWith("\n") ? (item.endsWith("\n\n") ? "+" : "") : "-";
    const body = item.endsWith("\n") ? item.slice(0, -1) : item;
    const leadSpace = /^[ \t]/u.test(item) ? "2" : "";
    lines.push(`${head}${isKey ? " " : ""}|${leadSpace}${chomp}`);
    for (const line of body.split("\n")) lines.push(line === "" ? "" : " ".repeat(childIndent) + line);
  } else lines.push(`${head}${isKey ? " " : ""}${scalarText(item)}`);
}

/** Write a value as block-style YAML with a trailing newline. */
export function stringify(value) {
  if (value === undefined) return "";
  const lines = [];
  if ((Array.isArray(value) && value.length > 0) || (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0)) writeNode(value, 0, lines, null);
  else writeEntry("", value, 0, lines);
  return lines.join("\n") + "\n";
}

export default { parse, parseDocument, stringify, visit, Document, Scalar, YAMLMap, YAMLSeq, Pair, Alias, isMap, isSeq, isScalar, isPair, isAlias, isCollection, isNode };
