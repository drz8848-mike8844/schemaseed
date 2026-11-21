/**
 * Value generation.
 *
 * A value is produced from a schema plus the *structural path* that leads to
 * it. The path is the only source of randomness: two runs with the same seed
 * and the same input produce identical values, and reordering properties in the
 * source document does not change any value.
 *
 * The generator honours the constraints a schema declares (enum, const,
 * minimum/maximum, lengths, patterns, item counts, formats) so that generated
 * samples pass validation without post-processing.
 */

import { analyzePattern, samplePattern } from './regex-sample.js';
import { RefResolver } from './ref-resolver.js';
import { schemaNullable, schemaType } from './loader.js';
import type { PathRng, SplitMix64 } from './prng.js';
import type { Schema } from './types.js';

/** Context handed to every value generation call. */
export interface ValueContext {
  /** Addressed randomness. */
  rng: PathRng;
  /** The resolver used to follow $ref. */
  resolver: RefResolver;
  /** File the schema lives in (needed to resolve relative references). */
  file: string;
  /** The structural path of the value being generated. */
  path: string;
  /** Current nesting depth. */
  depth: number;
  /** Maximum nesting depth before generation stops. */
  maxDepth: number;
  /** Refs currently being expanded, used to detect cycles. */
  stack: string[];
  /** Warnings collected during generation. */
  warnings: string[];
}

/** The words used to build readable strings. */
const WORDS = [
  'alpha', 'bravo', 'cedar', 'delta', 'ember', 'fable', 'grove', 'harbor',
  'indigo', 'juniper', 'kelp', 'lumen', 'meadow', 'nimbus', 'onyx', 'pebble',
  'quartz', 'river', 'summit', 'tundra', 'umbra', 'vertex', 'willow', 'zephyr',
];

const FIRST_NAMES = [
  'Ada', 'Bao', 'Chen', 'Dara', 'Eli', 'Fay', 'Gus', 'Hana', 'Iris', 'Jun',
  'Kai', 'Lena', 'Milo', 'Nia', 'Omar', 'Pia', 'Quinn', 'Rosa', 'Sami', 'Tara',
];

const LAST_NAMES = [
  'Adler', 'Bianchi', 'Costa', 'Duarte', 'Engel', 'Fontaine', 'Grant', 'Holt',
  'Ibarra', 'Jansen', 'Kaur', 'Lund', 'Moreau', 'Novak', 'Okafor', 'Petrov',
];

const DOMAINS = ['example.com', 'example.org', 'example.net', 'test.dev', 'mail.example'];
const CITIES = ['Lisbon', 'Osaka', 'Nairobi', 'Toronto', 'Berlin', 'Bogota', 'Auckland'];
const STREETS = ['Maple Street', 'Harbor Road', 'Elm Avenue', 'Riverside Lane', 'Oak Drive'];

/** A random element of a list. */
function pick<T>(rng: SplitMix64, items: readonly T[]): T {
  return items[rng.nextInt(0, items.length - 1)]!;
}

/** Lowercase hex string of the given length. */
function hex(rng: SplitMix64, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += '0123456789abcdef'[rng.nextInt(0, 15)];
  return out;
}

/** A random UUID v4 shaped string. */
export function makeUuid(rng: SplitMix64): string {
  const a = hex(rng, 8);
  const b = hex(rng, 4);
  const c = '4' + hex(rng, 3);
  const d = (8 + rng.nextInt(0, 3)).toString(16) + hex(rng, 3);
  const e = hex(rng, 12);
  return a + '-' + b + '-' + c + '-' + d + '-' + e;
}

/** An ISO-8601 timestamp. */
function makeTimestamp(rng: SplitMix64): string {
  const year = 2020 + rng.nextInt(0, 6);
  const month = 1 + rng.nextInt(0, 11);
  const day = 1 + rng.nextInt(0, 27);
  const hour = rng.nextInt(0, 23);
  const minute = rng.nextInt(0, 59);
  const second = rng.nextInt(0, 59);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    year + '-' + pad(month) + '-' + pad(day) + 'T' + pad(hour) + ':' + pad(minute) + ':' + pad(second) + '.000Z'
  );
}

/** An email address. */
function makeEmail(rng: SplitMix64): string {
  const first = pick(rng, FIRST_NAMES).toLowerCase();
  const last = pick(rng, LAST_NAMES).toLowerCase();
  return first + '.' + last + rng.nextInt(1, 999) + '@' + pick(rng, DOMAINS);
}

/** The numeric bounds of a schema. */
export interface NumericBounds {
  min?: number;
  max?: number;
  exclusiveMin?: number;
  exclusiveMax?: number;
  multipleOf?: number;
}

/** Read numeric bounds, understanding both OpenAPI 3.0 and JSON Schema styles. */
export function numericBounds(schema: Schema): NumericBounds {
  const bounds: NumericBounds = {};
  if (typeof schema.minimum === 'number') bounds.min = schema.minimum;
  if (typeof schema.maximum === 'number') bounds.max = schema.maximum;
  if (typeof schema.exclusiveMinimum === 'number') bounds.exclusiveMin = schema.exclusiveMinimum;
  if (typeof schema.exclusiveMaximum === 'number') bounds.exclusiveMax = schema.exclusiveMaximum;
  // OpenAPI 3.0 style: exclusiveMinimum: true next to minimum: 5.
  if (schema.exclusiveMinimum === true && typeof schema.minimum === 'number') {
    bounds.exclusiveMin = schema.minimum;
    bounds.min = undefined;
  }
  if (schema.exclusiveMaximum === true && typeof schema.maximum === 'number') {
    bounds.exclusiveMax = schema.maximum;
    bounds.max = undefined;
  }
  if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) bounds.multipleOf = schema.multipleOf;
  return bounds;
}

/** Generate a number honouring the schema bounds. */
export function generateNumber(schema: Schema, rng: SplitMix64, integer: boolean): number {
  const bounds = numericBounds(schema);
  let min = bounds.min ?? (bounds.exclusiveMin !== undefined ? bounds.exclusiveMin + 1 : integer ? 1 : 0);
  let max = bounds.max ?? (bounds.exclusiveMax !== undefined ? bounds.exclusiveMax - 1 : 1000);
  if (bounds.exclusiveMin !== undefined) min = Math.max(min, bounds.exclusiveMin + (integer ? 1 : 0.001));
  if (bounds.exclusiveMax !== undefined) max = Math.min(max, bounds.exclusiveMax - (integer ? 1 : 0.001));
  if (min > max) {
    const swap = min;
    min = max;
    max = swap;
  }
  let value = (rng.nextInt(0, 10000) / 10000) * (max - min) + min;
  if (integer) {
    value = Math.floor(value);
    value = Math.min(Math.max(value, Math.ceil(min)), Math.floor(max));
  }
  if (bounds.multipleOf) {
    const step = bounds.multipleOf;
    value = Math.ceil(value / step) * step;
    if (value > max) value = Math.floor(max / step) * step;
    if (value < min) value = Math.ceil(min / step) * step;
    if (integer) value = Math.round(value);
  }
  if (integer) return Math.round(value);
  return Math.round(value * 100) / 100;
}

/** Generate a string honouring format, length and pattern constraints. */
export function generateString(schema: Schema, rng: SplitMix64, path: string): string {
  const format = typeof schema.format === 'string' ? schema.format : undefined;
  const minLength = typeof schema.minLength === 'number' ? schema.minLength : 0;
  const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : Infinity;
  const hasPattern = typeof schema.pattern === 'string';

  const build = (): string => {
    switch (format) {
      case 'uuid':
        return makeUuid(rng);
      case 'email':
      case 'idn-email':
        return makeEmail(rng);
      case 'date-time':
        return makeTimestamp(rng);
      case 'date':
        return makeTimestamp(rng).slice(0, 10);
      case 'time':
        return makeTimestamp(rng).slice(11, 19) + 'Z';
      case 'uri':
      case 'url':
      case 'uri-reference':
        return 'https://' + pick(rng, DOMAINS) + '/' + pick(rng, WORDS) + '/' + rng.nextInt(1, 999);
      case 'hostname':
        return pick(rng, WORDS) + '.' + pick(rng, DOMAINS);
      case 'ipv4':
        return rng.nextInt(1, 254) + '.' + rng.nextInt(0, 255) + '.' + rng.nextInt(0, 255) + '.' + rng.nextInt(1, 254);
      case 'ipv6':
        return hex(rng, 4) + ':' + hex(rng, 4) + ':' + hex(rng, 4) + ':' + hex(rng, 4) + '::' + hex(rng, 4);
      case 'password':
        return pick(rng, WORDS) + '-' + rng.nextInt(100, 999);
      case 'byte':
        return Buffer.from(pick(rng, WORDS)).toString('base64');
      case 'phone':
        return '+1-' + rng.nextInt(200, 999) + '-' + rng.nextInt(200, 999) + '-' + rng.nextInt(1000, 9999);
      default:
        break;
    }
    if (hasPattern) {
      const info = analyzePattern(schema.pattern as string);
      if (info) return samplePattern(info, rng);
    }
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    switch (rng.nextInt(0, 5)) {
      case 0:
        return first + ' ' + last;
      case 1:
        return first.toLowerCase() + '.' + last.toLowerCase() + '@' + pick(rng, DOMAINS);
      case 2:
        return pick(rng, WORDS) + '-' + pick(rng, WORDS) + '-' + rng.nextInt(10, 999);
      case 3:
        return pick(rng, CITIES) + ', ' + pick(rng, STREETS) + ' ' + rng.nextInt(1, 250);
      default:
        return pick(rng, WORDS) + ' ' + pick(rng, WORDS);
    }
  };

  // Satisfy the length bounds. A pattern is preferred over the length bounds:
  // a value that matches the pattern is more useful than one that merely fits.
  for (let attempt = 0; attempt < 24; attempt++) {
    const candidate = build();
    if (candidate.length >= minLength && candidate.length <= maxLength) return candidate;
    if (!hasPattern && candidate.length < minLength) {
      return candidate + '-'.repeat(minLength - candidate.length);
    }
    if (!hasPattern && candidate.length > maxLength) {
      return candidate.slice(0, maxLength);
    }
  }
  const fallback = build();
  return fallback.length > maxLength && !hasPattern ? fallback.slice(0, maxLength) : fallback;
}

/**
 * Generate a value for a schema.
 *
 * @param schema the schema to satisfy (a boolean schema is allowed too)
 * @param ctx    generation context
 * @param path   structural path of the value (defaults to ctx.path)
 */
export function generateValue(
  schema: Schema | boolean | undefined,
  ctx: ValueContext,
  path?: string,
): unknown {
  const valuePath = path ?? ctx.path;
  const rng = ctx.rng.stream(valuePath);

  if (schema === true || schema === undefined) return {};
  if (schema === false) return null;

  if (RefResolver.isRef(schema)) {
    const resolved = ctx.resolver.resolve(schema.$ref, ctx.file, false);
    if (!resolved) {
      ctx.warnings.push(valuePath + ': could not resolve $ref "' + schema.$ref + '", generated null');
      return null;
    }
    if (ctx.stack.includes(resolved.id)) {
      // Cycle: stop expanding and use the field's own constraints.
      return generateCycleBreak(schema, ctx, valuePath);
    }
    if (ctx.depth >= ctx.maxDepth) {
      ctx.warnings.push(
        valuePath + ': maximum nesting depth reached, stopped expanding $ref "' + schema.$ref + '"',
      );
      return generateCycleBreak(schema, ctx, valuePath);
    }
    const nextCtx: ValueContext = { ...ctx, depth: ctx.depth + 1, stack: [...ctx.stack, resolved.id] };
    // Sibling keywords next to $ref override the referenced schema (OpenAPI 3.1).
    const siblings: Schema = { ...schema };
    delete siblings.$ref;
    const merged = Object.keys(siblings).length > 0 ? { ...resolved.schema, ...siblings } : resolved.schema;
    return generateValue(merged, nextCtx, valuePath);
  }

  if (schema.const !== undefined) return schema.const;

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return pick(rng, schema.enum);
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const branch = pick(rng, schema.oneOf);
    const merged = { ...branch, ...stripKeywords(schema, ['oneOf', 'anyOf', 'allOf']) };
    return generateValue(merged, ctx, valuePath);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const branch = pick(rng, schema.anyOf);
    const merged = { ...branch, ...stripKeywords(schema, ['oneOf', 'anyOf', 'allOf']) };
    return generateValue(merged, ctx, valuePath);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return generateValue(mergeAllOf(schema), ctx, valuePath);
  }

  const type = schemaType(schema);
  const nullable = schemaNullable(schema);

  if (type === 'null') return null;

  if (type === 'boolean') return rng.bool();
  if (type === 'integer') return generateNumber(schema, rng, true);
  if (type === 'number') return generateNumber(schema, rng, false);

  if (type === 'string') {
    if (nullable && rng.bool(0.08)) return null;
    return generateString(schema, rng, valuePath);
  }

  if (type === 'array') {
    const minItems = typeof schema.minItems === 'number' ? schema.minItems : 0;
    const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : Math.max(minItems, 3);
    const unique = schema.uniqueItems === true;
    const items = schema.items ?? {};
    const count = rng.nextInt(minItems, Math.max(minItems, Math.min(maxItems, minItems + 3)));
    const out: unknown[] = [];
    let guard = 0;
    while (out.length < count && guard < count * 10 + 20) {
      guard++;
      const item = generateValue(items, ctx, valuePath + '[' + out.length + ']');
      if (unique && out.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) continue;
      out.push(item);
    }
    return out;
  }

  if (type === 'object' || schema.properties || schema.additionalProperties) {
    return generateObject(schema, ctx, valuePath);
  }

  if (nullable) return null;
  return generateString(schema, rng, valuePath);
}

/** Generate the members of an object schema. */
export function generateObject(schema: Schema, ctx: ValueContext, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const properties = (
    schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
  ) as Record<string, Schema>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);

  for (const name of Object.keys(properties)) {
    const propSchema = properties[name]!;
    const isRequired = required.has(name);
    if (!isRequired) {
      // Optional properties are present most of the time but not always.
      const keep = ctx.rng.stream(path + '.' + name + '.present').bool(0.85);
      if (!keep) continue;
    }
    out[name] = generateValue(propSchema, ctx, path + '.' + name);
  }

  if (schema.additionalProperties === true && Object.keys(properties).length === 0) {
    out.extra = pick(ctx.rng.stream(path + '.extra'), WORDS);
  }
  return out;
}

/**
 * The value used when a reference cycle is hit.
 *
 * The field's own constraints win: enum, then const, then default, then the
 * declared type.
 */
export function generateCycleBreak(schema: Schema, ctx: ValueContext, path: string): unknown {
  const rng = ctx.rng.stream(path + '.cycle');
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return pick(rng, schema.enum);
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  const type = schemaType(schema);
  if (type === 'integer' || type === 'number') return generateNumber(schema, rng, type === 'integer');
  if (type === 'boolean') return rng.bool();
  if (type === 'string') return generateString(schema, rng, path);
  if (type === 'array') return [];
  if (type === 'null') return null;
  if (schemaNullable(schema)) return null;
  ctx.warnings.push(path + ': stopped at a reference cycle and used a minimal value');
  return null;
}

/** Merge allOf branches into one schema (shallow but sufficient for generation). */
export function mergeAllOf(schema: Schema): Schema {
  const merged: Schema = { ...schema };
  delete merged.allOf;
  const properties: Record<string, Schema> = { ...((schema.properties as Record<string, Schema>) ?? {}) };
  const required: string[] = Array.isArray(schema.required) ? [...(schema.required as string[])] : [];
  for (const branch of schema.allOf as Schema[]) {
    if (!branch || typeof branch !== 'object') continue;
    const branchProperties = (branch.properties as Record<string, Schema>) ?? {};
    for (const key of Object.keys(branchProperties)) {
      properties[key] = { ...(properties[key] ?? {}), ...branchProperties[key] };
    }
    if (Array.isArray(branch.required)) {
      for (const key of branch.required as string[]) {
        if (!required.includes(key)) required.push(key);
      }
    }
    for (const key of ['type', 'format', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern']) {
      if (merged[key] === undefined && branch[key] !== undefined) merged[key] = branch[key];
    }
  }
  merged.properties = properties;
  if (required.length > 0) merged.required = required;
  return merged;
}

/** Copy a schema without the given keywords. */
export function stripKeywords(schema: Schema, keywords: string[]): Schema {
  const copy: Schema = { ...schema };
  for (const keyword of keywords) delete copy[keyword];
  return copy;
}
