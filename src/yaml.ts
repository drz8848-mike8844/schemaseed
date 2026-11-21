/**
 * A minimal YAML subset parser — written from scratch, zero dependencies.
 *
 * Supported:
 *   - block mappings (nested, arbitrary depth)
 *   - block sequences ("- item"), including compact mappings ("- key: value")
 *   - plain, single quoted and double quoted scalars
 *   - inline flow collections: [a, b] and {k: v}
 *   - comments ("# ..."), blank lines, document start marker ("---")
 *   - block scalars: |, |-, |+, >, >-, >+
 *   - scalars: null/~/Null, true/false, integers, floats, strings
 *
 * NOT supported (reported as an explicit error, never silently mis-parsed):
 *   - anchors (&a), aliases (*a), custom tags (!!str)
 *   - merge keys (<<:)
 *   - multi-line plain scalars
 *   - multi-document streams (the first document is used, the rest is ignored)
 *
 * Every error carries the file, the 1-based line number and the offending
 * source line so a user can jump straight to the problem.
 */

/** A parse failure with enough context to fix the document. */
export class YamlParseError extends Error {
  /** File the error occurred in. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** The offending source line. */
  readonly snippet: string;

  constructor(file: string, line: number, snippet: string, message: string) {
    super(file + ':' + line + ': ' + message + '\n  | ' + snippet.trim());
    this.name = 'YamlParseError';
    this.file = file;
    this.line = line;
    this.snippet = snippet;
  }
}

interface SourceLine {
  text: string;
  no: number;
}

/** Remove a trailing comment, respecting quotes. */
function stripComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inSingle) {
      if (c === "'") {
        if (text[i + 1] === "'") {
          i++;
          continue;
        }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]!))) {
      return text.slice(0, i);
    }
  }
  return text;
}

/** True when the line carries no data. */
function isBlankLine(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

class YamlParser {
  private readonly lines: SourceLine[];
  private pos = 0;
  private readonly file: string;

  constructor(text: string, file: string) {
    const raw = text.split(/\r?\n/);
    this.lines = raw.map((t, i) => ({ text: t, no: i + 1 }));
    this.file = file;
  }

  private fail(index: number, message: string): never {
    const line = this.lines[Math.min(index, this.lines.length - 1)]!;
    throw new YamlParseError(this.file, line.no, line.text, message);
  }

  private isBlank(index: number): boolean {
    return index >= this.lines.length || isBlankLine(this.lines[index]!.text);
  }

  /** Advance past blank and comment-only lines. */
  private skipBlanks(): void {
    while (this.pos < this.lines.length && this.isBlank(this.pos)) this.pos++;
  }

  private indentOf(index: number): number {
    const text = this.lines[index]!.text;
    let n = 0;
    while (n < text.length && text[n] === ' ') n++;
    if (n < text.length && text[n] === '\t') {
      this.fail(index, 'tab characters are not allowed for indentation');
    }
    return n;
  }

  /** The significant content of a line (comment removed, trimmed). */
  private contentOf(index: number): string {
    return stripComment(this.lines[index]!.text).trim();
  }

  parse(): any {
    this.skipBlanks();
    if (this.pos >= this.lines.length) return null;
    if (this.contentOf(this.pos) === '---') {
      this.pos++;
      this.skipBlanks();
      if (this.pos >= this.lines.length) return null;
    }
    const value = this.parseBlock(this.indentOf(this.pos));
    this.skipBlanks();
    if (this.pos < this.lines.length) {
      const content = this.contentOf(this.pos);
      if (content !== '---' && content !== '...') {
        this.fail(this.pos, 'unexpected content after the end of the document');
      }
    }
    return value;
  }

  /** Parse a block node whose first line is the current line. */
  private parseBlock(indent: number): any {
    this.skipBlanks();
    if (this.pos >= this.lines.length) return null;
    const content = this.contentOf(this.pos);
    if (content === '-' || content.startsWith('- ')) return this.parseSequence(indent);
    if (this.looksLikeKey(content)) return this.parseMapping(indent);
    // A bare scalar node, e.g. the body of a sequence item.
    this.pos++;
    return this.parseScalarOrFlow(content, this.pos - 1);
  }

  /** True when the content is a "key: value" pair rather than a plain scalar. */
  private looksLikeKey(content: string): boolean {
    let inSingle = false;
    let inDouble = false;
    let depth = 0;
    for (let i = 0; i < content.length; i++) {
      const c = content[i]!;
      if (inSingle) {
        if (c === "'") {
          if (content[i + 1] === "'") {
            i++;
            continue;
          }
          inSingle = false;
        }
        continue;
      }
      if (inDouble) {
        if (c === '\\') {
          i++;
          continue;
        }
        if (c === '"') inDouble = false;
        continue;
      }
      if (c === "'") {
        inSingle = true;
        continue;
      }
      if (c === '"') {
        inDouble = true;
        continue;
      }
      if (c === '[' || c === '{') {
        depth++;
        continue;
      }
      if (c === ']' || c === '}') {
        depth--;
        continue;
      }
      if (c === ':' && depth === 0) {
        const next = content[i + 1];
        if (next === undefined || next === ' ') return true;
      }
    }
    return false;
  }

  private parseMapping(indent: number): any {
    const result: Record<string, any> = {};
    for (;;) {
      this.skipBlanks();
      if (this.pos >= this.lines.length) break;
      const lineIndent = this.indentOf(this.pos);
      if (lineIndent < indent) break;
      if (lineIndent > indent) {
        this.fail(this.pos, 'unexpected indentation (expected ' + indent + ' spaces)');
      }
      const content = this.contentOf(this.pos);
      if (content === '---' || content === '...') break;
      if (content === '-' || content.startsWith('- ')) break;
      const split = this.splitKey(content, this.pos);
      const lineNo = this.lines[this.pos]!.no;
      this.pos++;
      result[split.key] = this.parseValueAfterKey(split.rest, indent, lineNo);
    }
    return result;
  }

  private parseSequence(indent: number): any {
    const items: any[] = [];
    for (;;) {
      this.skipBlanks();
      if (this.pos >= this.lines.length) break;
      const lineIndent = this.indentOf(this.pos);
      if (lineIndent < indent) break;
      if (lineIndent > indent) {
        this.fail(this.pos, 'unexpected indentation inside a sequence (expected ' + indent + ' spaces)');
      }
      const content = this.contentOf(this.pos);
      if (content !== '-' && !content.startsWith('- ')) break;
      const rawText = this.lines[this.pos]!.text;
      const dashColumn = rawText.indexOf('-');
      const afterDash = content.slice(1);
      const trimmedAfter = afterDash.trim();
      if (trimmedAfter === '') {
        this.pos++;
        this.skipBlanks();
        if (this.pos < this.lines.length && this.indentOf(this.pos) > indent) {
          items.push(this.parseBlock(this.indentOf(this.pos)));
        } else {
          items.push(null);
        }
        continue;
      }
      // Compact form: rewrite the line so the item body starts at its own
      // column, then parse it as a normal block node.
      const contentColumn = dashColumn + 1 + (afterDash.length - afterDash.trimStart().length);
      const rewritten = ' '.repeat(contentColumn) + afterDash.trimStart();
      this.lines[this.pos] = { text: rewritten, no: this.lines[this.pos]!.no };
      items.push(this.parseBlock(contentColumn));
    }
    return items;
  }

  /** Split "key: value" respecting quotes and flow collections. */
  private splitKey(content: string, index: number): { key: string; rest: string } {
    let inSingle = false;
    let inDouble = false;
    let depth = 0;
    for (let i = 0; i < content.length; i++) {
      const c = content[i]!;
      if (inSingle) {
        if (c === "'") {
          if (content[i + 1] === "'") {
            i++;
            continue;
          }
          inSingle = false;
        }
        continue;
      }
      if (inDouble) {
        if (c === '\\') {
          i++;
          continue;
        }
        if (c === '"') inDouble = false;
        continue;
      }
      if (c === "'") {
        inSingle = true;
        continue;
      }
      if (c === '"') {
        inDouble = true;
        continue;
      }
      if (c === '[' || c === '{') {
        depth++;
        continue;
      }
      if (c === ']' || c === '}') {
        depth--;
        continue;
      }
      if (c === ':' && depth === 0) {
        const next = content[i + 1];
        if (next === undefined || next === ' ') {
          const rawKey = content.slice(0, i).trim();
          const key = this.parseKeyScalar(rawKey, index);
          return { key, rest: content.slice(i + 1).trim() };
        }
      }
    }
    this.fail(index, 'expected "key: value" but found ' + JSON.stringify(content));
  }

  private parseKeyScalar(raw: string, index: number): string {
    if (raw.startsWith('"')) return this.parseDoubleQuoted(raw, index);
    if (raw.startsWith("'")) return this.parseSingleQuoted(raw, index);
    if (raw.startsWith('&') || raw.startsWith('*') || raw.startsWith('!')) {
      this.fail(index, 'anchors, aliases and tags are not supported by the YAML subset parser');
    }
    return raw;
  }

  /** The value that follows "key:" on the same line, or a nested block. */
  private parseValueAfterKey(rest: string, parentIndent: number, lineNo: number): any {
    if (rest === '') {
      this.skipBlanks();
      if (this.pos < this.lines.length) {
        const childIndent = this.indentOf(this.pos);
        const childContent = this.contentOf(this.pos);
        if (childIndent > parentIndent) return this.parseBlock(childIndent);
        if (childIndent === parentIndent && (childContent === '-' || childContent.startsWith('- '))) {
          return this.parseSequence(childIndent);
        }
      }
      return null;
    }
    if (rest[0] === '|' || rest[0] === '>') return this.parseBlockScalar(rest, parentIndent, lineNo);
    if (rest.startsWith('&') || rest.startsWith('*') || rest.startsWith('!')) {
      this.fail(this.pos - 1, 'anchors, aliases and tags are not supported by the YAML subset parser');
    }
    return this.parseScalarOrFlow(rest, this.pos - 1);
  }

  private parseBlockScalar(header: string, parentIndent: number, lineNo: number): string {
    const style = header[0]!;
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const collected: string[] = [];
    let blockIndent = -1;
    let index = this.pos;
    while (index < this.lines.length) {
      const text = this.lines[index]!.text;
      if (text.trim() === '') {
        collected.push('');
        index++;
        continue;
      }
      const indent = this.indentOf(index);
      if (indent <= parentIndent) break;
      if (blockIndent === -1) blockIndent = indent;
      if (indent < blockIndent) break;
      collected.push(text.slice(blockIndent));
      index++;
    }
    while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
    this.pos = index;
    let body: string;
    if (style === '|') {
      body = collected.join('\n');
    } else {
      const folded: string[] = [];
      for (const line of collected) {
        if (line === '') {
          folded.push('\n');
        } else if (folded.length > 0 && folded[folded.length - 1] !== '\n') {
          folded[folded.length - 1] = folded[folded.length - 1] + ' ' + line;
        } else {
          folded.push(line);
        }
      }
      body = folded.join('');
    }
    if (chomp === 'keep') body += '\n';
    else if (chomp === 'clip' && body !== '') body += '\n';
    void lineNo;
    return body;
  }

  private parseScalarOrFlow(text: string, index: number): any {
    if (text.startsWith('[')) {
      const result = this.flowValue(text, 0, index);
      if (result.pos !== text.length) {
        this.fail(index, 'unexpected trailing content after a flow sequence');
      }
      return result.value;
    }
    if (text.startsWith('{')) {
      const result = this.flowValue(text, 0, index);
      if (result.pos !== text.length) {
        this.fail(index, 'unexpected trailing content after a flow mapping');
      }
      return result.value;
    }
    if (text.startsWith('"')) return this.parseDoubleQuoted(text, index);
    if (text.startsWith("'")) return this.parseSingleQuoted(text, index);
    return this.parsePlainScalar(text);
  }

  private parsePlainScalar(text: string): any {
    const value = text.trim();
    if (value === '' || value === '~' || value === 'null' || value === 'Null' || value === 'NULL') {
      return null;
    }
    if (value === 'true' || value === 'True' || value === 'TRUE') return true;
    if (value === 'false' || value === 'False' || value === 'FALSE') return false;
    if (/^[-+]?\d+$/.test(value)) {
      const asNumber = Number(value);
      if (Number.isSafeInteger(asNumber)) return asNumber;
      return value;
    }
    if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)) return Number(value);
    if (/^[-+]?\d+[eE][-+]?\d+$/.test(value)) return Number(value);
    return value;
  }

  private parseDoubleQuoted(text: string, index: number): string {
    let out = '';
    for (let i = 1; i < text.length; i++) {
      const c = text[i]!;
      if (c === '"') {
        if (i !== text.length - 1) {
          this.fail(index, 'unexpected content after a double quoted string');
        }
        return out;
      }
      if (c !== '\\') {
        out += c;
        continue;
      }
      const esc = text[++i];
      switch (esc) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case '0': out += '\0'; break;
        case '"': out += '"'; break;
        case "'": out += "'"; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'u': {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.fail(index, 'invalid unicode escape sequence \\u' + hex);
          }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          this.fail(index, 'unsupported escape sequence \\\\' + String(esc));
      }
    }
    this.fail(index, 'unterminated double quoted string');
  }

  private parseSingleQuoted(text: string, index: number): string {
    let out = '';
    for (let i = 1; i < text.length; i++) {
      const c = text[i]!;
      if (c === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        if (i !== text.length - 1) {
          this.fail(index, 'unexpected content after a single quoted string');
        }
        return out;
      }
      out += c;
    }
    this.fail(index, 'unterminated single quoted string');
  }

  // ---- flow collections -------------------------------------------------

  private flowValue(text: string, pos: number, index: number): { value: any; pos: number } {
    let p = pos;
    while (p < text.length && /\s/.test(text[p]!)) p++;
    const c = text[p];
    if (c === '[') return this.flowSequence(text, p, index);
    if (c === '{') return this.flowMapping(text, p, index);
    if (c === '"') {
      const value = this.parseDoubleQuoted(this.readDoubleQuoted(text, p, index), index);
      return { value, pos: this.lastFlowEnd };
    }
    if (c === "'") {
      const value = this.parseSingleQuoted(this.readSingleQuoted(text, p, index), index);
      return { value, pos: this.lastFlowEnd };
    }
    return this.flowPlain(text, p, index);
  }

  private lastFlowEnd = 0;

  private readDoubleQuoted(text: string, start: number, index: number): string {
    let i = start + 1;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') break;
    }
    if (i >= text.length) this.fail(index, 'unterminated double quoted string in a flow collection');
    this.lastFlowEnd = i + 1;
    return text.slice(start, i + 1);
  }

  private readSingleQuoted(text: string, start: number, index: number): string {
    let i = start + 1;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (c === "'") {
        if (text[i + 1] === "'") {
          i++;
          continue;
        }
        break;
      }
    }
    if (i >= text.length) this.fail(index, 'unterminated single quoted string in a flow collection');
    this.lastFlowEnd = i + 1;
    return text.slice(start, i + 1);
  }

  private flowPlain(text: string, start: number, index: number): { value: any; pos: number } {
    let i = start;
    while (i < text.length && !',]}'.includes(text[i]!)) i++;
    const raw = text.slice(start, i).trim();
    if (raw.startsWith('&') || raw.startsWith('*') || raw.startsWith('!')) {
      this.fail(index, 'anchors, aliases and tags are not supported by the YAML subset parser');
    }
    return { value: this.parsePlainScalar(raw), pos: i };
  }

  private flowSequence(text: string, start: number, index: number): { value: any; pos: number } {
    const items: any[] = [];
    let p = start + 1;
    for (;;) {
      while (p < text.length && /\s/.test(text[p]!)) p++;
      if (p >= text.length) this.fail(index, 'unterminated flow sequence');
      if (text[p] === ']') return { value: items, pos: p + 1 };
      const entry = this.flowValue(text, p, index);
      items.push(entry.value);
      p = entry.pos;
      while (p < text.length && /\s/.test(text[p]!)) p++;
      if (text[p] === ',') {
        p++;
        continue;
      }
      if (text[p] === ']') return { value: items, pos: p + 1 };
      this.fail(index, 'expected "," or "]" in a flow sequence');
    }
  }

  private flowMapping(text: string, start: number, index: number): { value: any; pos: number } {
    const result: Record<string, any> = {};
    let p = start + 1;
    for (;;) {
      while (p < text.length && /\s/.test(text[p]!)) p++;
      if (p >= text.length) this.fail(index, 'unterminated flow mapping');
      if (text[p] === '}') return { value: result, pos: p + 1 };
      const key = this.flowKey(text, p, index);
      p = key.pos;
      while (p < text.length && /\s/.test(text[p]!)) p++;
      if (text[p] !== ':') this.fail(index, 'expected ":" in a flow mapping');
      p++;
      const entry = this.flowValue(text, p, index);
      result[key.key] = entry.value;
      p = entry.pos;
      while (p < text.length && /\s/.test(text[p]!)) p++;
      if (text[p] === ',') {
        p++;
        continue;
      }
      if (text[p] === '}') return { value: result, pos: p + 1 };
      this.fail(index, 'expected "," or "}" in a flow mapping');
    }
  }

  private flowKey(text: string, start: number, index: number): { key: string; pos: number } {
    if (text[start] === '"') {
      const raw = this.readDoubleQuoted(text, start, index);
      return { key: this.parseDoubleQuoted(raw, index), pos: this.lastFlowEnd };
    }
    if (text[start] === "'") {
      const raw = this.readSingleQuoted(text, start, index);
      return { key: this.parseSingleQuoted(raw, index), pos: this.lastFlowEnd };
    }
    let i = start;
    while (i < text.length && !':,]}'.includes(text[i]!)) i++;
    return { key: text.slice(start, i).trim(), pos: i };
  }
}

/**
 * Parse a YAML document (subset) into plain JavaScript values.
 *
 * @param text  the document source
 * @param file  file name used in error messages
 */
export function parseYaml(text: string, file = '<yaml>'): any {
  return new YamlParser(text, file).parse();
}
