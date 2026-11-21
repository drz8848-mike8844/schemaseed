/**
 * Shared helpers for the exporters.
 *
 * Everything here is pure formatting: turning generated values into the literal
 * syntax of the target language (SQL, Python, CSV, TypeScript) and the small
 * naming utilities the exporters need.
 */

import type { Schema } from '../types.js';

/** One file produced by an exporter: a path relative to the output directory. */
export interface ExportFile {
  /** Path relative to the output directory, e.g. "json/users.json". */
  path: string;
  /** File content. */
  content: string;
}

/** A deep copy of plain JSON data. */
export function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Pretty printed JSON with a trailing newline. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/** Compact JSON, one line. */
export function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

/** A Python string literal (JSON string syntax is valid Python string syntax). */
export function pyString(text: string): string {
  return JSON.stringify(text);
}

/** A Python literal for any JSON value. */
export function pyLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
  if (typeof value === 'string') return pyString(value);
  if (Array.isArray(value)) return '[' + value.map(pyLiteral).join(', ') + ']';
  if (typeof value === 'object') {
    const parts = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => pyString(key) + ': ' + pyLiteral(item),
    );
    return '{' + parts.join(', ') + '}';
  }
  return 'None';
}

/** A Python identifier derived from an arbitrary name. */
export function pyIdent(name: string): string {
  const cleaned = name.replace(/[^0-9A-Za-z_]/g, '_');
  return /^[0-9]/.test(cleaned) ? '_' + cleaned : cleaned;
}

/** A quoted SQL string literal. */
export function sqlString(text: string): string {
  return "'" + text.replace(/'/g, "''") + "'";
}

/** A SQL literal for any JSON value. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return sqlString(value);
  return sqlString(JSON.stringify(value));
}

/** A quoted SQL identifier. */
export function sqlIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** A CSV cell (objects and arrays are written as JSON). */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return csvEscape(JSON.stringify(value));
  return csvEscape(String(value));
}

/** Quote a CSV field when it contains a separator, quote or newline. */
function csvEscape(text: string): string {
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

/** The PostgreSQL type of a column. */
export function sqlType(schema: Schema, fallback: string): string {
  const declared = schema && typeof schema === 'object' ? schema.type : undefined;
  const type = typeof declared === 'string' ? declared : fallback;
  const format = schema && typeof schema.format === 'string' ? schema.format : '';
  switch (type) {
    case 'integer':
      return 'INTEGER';
    case 'number':
      return 'NUMERIC';
    case 'boolean':
      return 'BOOLEAN';
    case 'array':
      return 'JSONB';
    case 'object':
      return 'JSONB';
    case 'null':
      return 'TEXT';
    case 'string':
      switch (format) {
        case 'uuid':
          return 'UUID';
        case 'date':
          return 'DATE';
        case 'date-time':
          return 'TIMESTAMPTZ';
        case 'time':
          return 'TIME';
        default:
          return 'TEXT';
      }
    default:
      return 'TEXT';
  }
}

/** The TypeScript type of a column. */
export function tsType(schema: Schema, fallback: string): string {
  const declared = schema && typeof schema === 'object' ? schema.type : undefined;
  const type = typeof declared === 'string' ? declared : fallback;
  switch (type) {
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array': {
      const items = schema && typeof schema === 'object' ? schema.items : undefined;
      if (items && typeof items === 'object' && typeof items.type === 'string') {
        const inner = tsType(items as Schema, 'unknown');
        return inner === 'unknown' ? 'unknown[]' : inner + '[]';
      }
      return 'unknown[]';
    }
    case 'object':
      return 'Record<string, unknown>';
    case 'null':
      return 'null';
    case 'string':
      return 'string';
    default:
      return 'unknown';
  }
}

/** "user_id" -> "UserId" */
export function pascalCase(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** "user_id" -> "userId" */
export function camelCase(name: string): string {
  const pascal = pascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** A file system friendly name. */
export function slug(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'schema' : cleaned;
}
