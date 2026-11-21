/**
 * Loading source documents.
 *
 * A "document" is either an OpenAPI 3.0/3.1 file or a JSON Schema file, in
 * YAML or JSON. Loading produces:
 *   - the parsed document
 *   - the document kind
 *   - the set of *named schemas* (the tables) it defines
 */

import { readFileSync } from 'node:fs';
import { basename, extname, resolve as resolvePath } from 'node:path';
import { parseYaml, YamlParseError } from './yaml.js';
import type { DocKind, LoadedDoc, NamedSchema, Schema } from './types.js';

/** A fatal, user facing error with enough context to act on. */
export class SchemaSeedError extends Error {
  readonly file: string;

  constructor(file: string, message: string) {
    super(file + ': ' + message);
    this.name = 'SchemaSeedError';
    this.file = file;
  }
}

/** Parse JSON, turning the byte offset into a line/column pair. */
export function parseJsonWithPosition(text: string, file: string): any {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const positionMatch = /position (\d+)/.exec(message);
    if (!positionMatch) {
      throw new SchemaSeedError(file, 'invalid JSON: ' + message);
    }
    const offset = Number(positionMatch[1]);
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - before.lastIndexOf('\n');
    const snippet = text.split('\n')[line - 1] ?? '';
    throw new SchemaSeedError(file, 'invalid JSON at line ' + line + ', column ' + column + ': ' + message + '\n  | ' + snippet.trim());
  }
}

/** Decide whether the text should be parsed as JSON or YAML. */
export function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return true;
  const extension = extname(trimmed.split('\n')[0] ?? '').toLowerCase();
  return extension === '.json';
}

/** Parse document text, choosing JSON or YAML automatically. */
export function parseDocumentText(text: string, file: string): { doc: any; json: boolean } {
  if (looksLikeJson(text)) {
    try {
      return { doc: parseJsonWithPosition(text, file), json: true };
    } catch (error) {
      if (!(error instanceof SchemaSeedError)) throw error;
      // A file that starts with "{" but is not valid JSON might still be valid YAML
      // (YAML is a superset of JSON). Fall through to the YAML parser, which
      // reports a much better error message.
      try {
        return { doc: parseYaml(text, file), json: false };
      } catch (yamlError) {
        throw error;
      }
    }
  }
  try {
    return { doc: parseYaml(text, file), json: false };
  } catch (error) {
    if (error instanceof YamlParseError) {
      throw new SchemaSeedError(file, 'YAML parse error at line ' + error.line + ': ' + error.message.split('\n')[0]);
    }
    throw error;
  }
}

/** Read and parse a document from disk. */
export function loadDocument(file: string): LoadedDoc {
  const absolute = resolvePath(file);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new SchemaSeedError(absolute, 'file not found');
    }
    if (code === 'EISDIR') {
      throw new SchemaSeedError(absolute, 'expected a file but found a directory');
    }
    throw new SchemaSeedError(absolute, 'cannot read file: ' + (error as Error).message);
  }
  const parsed = parseDocumentText(text, absolute);
  const kind = detectKind(parsed.doc, absolute);
  return { file: absolute, kind, doc: parsed.doc, json: parsed.json };
}

/** Detect whether a document is an OpenAPI description or a plain JSON Schema. */
export function detectKind(doc: any, file: string): DocKind {
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    if (typeof doc.openapi === 'string') {
      if (!doc.openapi.startsWith('3.')) {
        throw new SchemaSeedError(file, 'unsupported OpenAPI version "' + doc.openapi + '" (only 3.x is supported)');
      }
      return 'openapi';
    }
    if (typeof doc.swagger === 'string') {
      throw new SchemaSeedError(file, 'Swagger 2.0 is not supported; convert the document to OpenAPI 3.x first');
    }
    if (doc.$schema || doc.type || doc.properties || doc.$defs || doc.definitions || doc.items || doc.allOf) {
      return 'jsonschema';
    }
  }
  throw new SchemaSeedError(
    file,
    'cannot recognise the document: expected an OpenAPI 3.x document or a JSON Schema document',
  );
}

/** Turn a file name into a usable table name. */
export function schemaNameFromFile(file: string): string {
  const base = basename(file, extname(file));
  const cleaned = base.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'root' : cleaned;
}

/** Collect the named schemas (tables) defined by a document. */
export function extractNamedSchemas(doc: LoadedDoc): NamedSchema[] {
  const result: NamedSchema[] = [];
  if (doc.kind === 'openapi') {
    const schemas = doc.doc?.components?.schemas;
    if (schemas && typeof schemas === 'object') {
      for (const name of Object.keys(schemas)) {
        result.push({
          name,
          id: doc.file + '#/components/schemas/' + name,
          file: doc.file,
          pointer: '/components/schemas/' + name,
          schema: schemas[name],
          origin: 'components/schemas',
        });
      }
    }
    return result;
  }

  // JSON Schema: the root schema plus every entry in $defs / definitions.
  const rootName = schemaNameFromFile(doc.file);
  result.push({
    name: rootName,
    id: doc.file + '#',
    file: doc.file,
    pointer: '',
    schema: doc.doc,
    origin: 'root',
  });
  const defs = doc.doc?.$defs ?? doc.doc?.definitions;
  if (defs && typeof defs === 'object') {
    const origin = doc.doc?.$defs ? '$defs' : 'definitions';
    for (const name of Object.keys(defs)) {
      result.push({
        name,
        id: doc.file + '#/' + origin + '/' + name,
        file: doc.file,
        pointer: '/' + origin + '/' + name,
        schema: defs[name],
        origin,
      });
    }
  }
  return result;
}

/** Read a value from a schema, tolerating missing pieces. */
export function schemaType(schema: Schema | undefined): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const type = schema.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t: unknown) => t !== 'null');
    return nonNull.length === 1 ? String(nonNull[0]) : undefined;
  }
  return undefined;
}

/** True when the schema explicitly allows null. */
export function schemaNullable(schema: Schema | undefined): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.nullable === true) return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  if (Array.isArray(schema.enum) && schema.enum.some((v: unknown) => v === null)) return true;
  return false;
}
