/**
 * Dataset generation.
 *
 * This module turns a relational model into data. It is shared by every
 * exporter so that all formats describe *the same* dataset:
 *
 *   - primary keys are drawn once per table and kept in a pool
 *   - a foreign key column always takes its value from the pool of the table
 *     it points at, so referential integrity holds by construction
 *   - nested (document shaped) data is produced by expanding the relational
 *     rows, so the two views never disagree
 *   - negative cases are produced by mutating valid rows in ways the schema
 *     forbids, and boundary rows by pushing values onto the declared limits
 */
import { mergeAllOf } from '../model.js';
import { schemaNullable, schemaType } from '../loader.js';
import { PathRng } from '../prng.js';
import { RefResolver } from '../ref-resolver.js';
import { generateValue } from '../values.js';
import { deepCopy } from './common.js';
/** Kinds of violations the negative generator can produce, in reporting order. */
const KIND_ORDER = [
    'type-mismatch',
    'enum-violation',
    'missing-required',
    'format-violation',
    'length-violation',
    'range-violation',
    'null-violation',
];
/** Invalid values used for the different formats. */
const BAD_FORMAT_VALUES = {
    email: 'not-an-email',
    'idn-email': 'not-an-email',
    uuid: 'not-a-uuid',
    date: '2024-13-45',
    'date-time': 'yesterday afternoon',
    time: '25:61',
    uri: 'not a uri',
    url: 'not a url',
    'uri-reference': 'not a uri reference',
    hostname: 'not a hostname',
    ipv4: '999.999.999.999',
    ipv6: 'zzzz::zzzz',
};
/** Generate the whole dataset. */
export function generateData(options) {
    const model = options.model;
    const rng = new PathRng(options.seed);
    const count = Math.max(0, Math.floor(options.count));
    const maxDepth = options.maxDepth ?? 6;
    const warnings = [...model.warnings];
    const contextFor = (file) => ({
        rng,
        resolver: options.resolver,
        file,
        path: '',
        depth: 0,
        maxDepth,
        stack: [],
        warnings,
    });
    // 1. One pool of primary key values per table. Foreign keys are drawn from
    //    these pools, which is what keeps the referential integrity intact.
    const pools = new Map();
    for (const name of model.order) {
        const table = model.tables.get(name);
        if (!table)
            continue;
        const relationalSchema = model.relationalSchemas.get(name) ?? {};
        const properties = (relationalSchema.properties ?? {});
        const pkProperty = table.primaryKey.property;
        const pkSchema = properties[pkProperty] ?? { type: table.primaryKey.type };
        const ctx = contextFor(table.file);
        const pool = [];
        const seen = new Set();
        for (let index = 0; index < count; index++) {
            const base = name + '.' + index + '.' + pkProperty;
            let value = generateValue(pkSchema, ctx, base);
            let attempt = 0;
            while (seen.has(JSON.stringify(value)) && attempt < 32) {
                attempt++;
                value = generateValue(pkSchema, ctx, base + '#' + attempt);
            }
            if (seen.has(JSON.stringify(value))) {
                warnings.push(name + '.' + pkProperty + ': could not produce a unique value for row ' + index);
            }
            seen.add(JSON.stringify(value));
            pool.push(value);
        }
        pools.set(name, pool);
    }
    // 2. The rows of every table.
    const tableData = [];
    for (const name of model.order) {
        const table = model.tables.get(name);
        if (!table)
            continue;
        const relationalSchema = model.relationalSchemas.get(name) ?? {};
        const properties = (relationalSchema.properties ?? {});
        const ctx = contextFor(table.file);
        const rows = [];
        for (let index = 0; index < count; index++) {
            const row = {};
            for (const column of table.columns) {
                const path = name + '.' + index + '.' + column.name;
                if (column.name === table.primaryKey.property) {
                    row[column.name] = (pools.get(name) ?? [])[index];
                    continue;
                }
                if (column.fk) {
                    const target = pools.get(column.fk.target) ?? [];
                    row[column.name] =
                        target.length === 0
                            ? null
                            : target[rng.stream(path).nextInt(0, target.length - 1)];
                    continue;
                }
                if (column.idListOf) {
                    const target = pools.get(column.idListOf) ?? [];
                    const size = rng.stream(path).nextInt(1, Math.max(1, Math.min(3, target.length)));
                    const list = [];
                    for (let item = 0; item < size && target.length > 0; item++) {
                        list.push(target[rng.stream(path + '[' + item + ']').nextInt(0, target.length - 1)]);
                    }
                    row[column.name] = list;
                    continue;
                }
                // Optional columns are sometimes left out entirely.
                if (!column.required && !rng.stream(path + '.present').bool(0.85))
                    continue;
                row[column.name] = generateValue(properties[column.name] ?? { type: column.type }, ctx, path);
            }
            rows.push(row);
        }
        tableData.push({ info: table, rows });
    }
    // 3. The two views.
    const relational = tableData.map((entry) => {
        const source = model.relationalSchemas.get(entry.info.name) ?? {};
        return {
            name: entry.info.name,
            kind: 'relational',
            rows: entry.rows,
            schema: inlineRefs(source, options.resolver, entry.info.file),
            sourceSchema: source,
            file: entry.info.file,
        };
    });
    const originalByName = new Map();
    for (const entry of options.named)
        originalByName.set(entry.name, entry);
    const rowsByTable = new Map();
    for (const entry of tableData)
        rowsByTable.set(entry.info.name, entry.rows);
    const expanded = [];
    for (const entry of tableData) {
        if (entry.info.childOnly)
            continue;
        const rows = entry.rows.map((row) => expandRow(entry.info.name, row, model, rowsByTable, new Set()));
        const original = originalByName.get(entry.info.name);
        const source = original ? original.schema : entry.info.schema;
        expanded.push({
            name: entry.info.name,
            kind: 'nested',
            rows,
            schema: inlineRefs(source, options.resolver, entry.info.file),
            sourceSchema: source,
            file: entry.info.file,
        });
    }
    // The document shaped view is only needed when it is the exported one; in
    // relational mode it would only produce noise about reference cycles.
    const direct = [];
    for (const entry of options.mode === 'nested' ? options.named : []) {
        const table = model.tables.get(entry.name);
        if (!table || table.childOnly)
            continue;
        const ctx = contextFor(entry.file);
        // The instances are generated from the schema with the references inlined:
        // the generator and the validator then see exactly the same schema, so a
        // reference cycle is cut in the same place in both.
        const inlined = inlineRefs(entry.schema, options.resolver, entry.file);
        const rows = [];
        for (let index = 0; index < count; index++) {
            const value = generateValue(inlined, ctx, entry.name + '.instance.' + index);
            rows.push(value && typeof value === 'object' && !Array.isArray(value)
                ? value
                : { value });
        }
        direct.push({
            name: entry.name,
            kind: 'nested',
            rows,
            schema: inlined,
            sourceSchema: entry.schema,
            file: entry.file,
        });
    }
    const views = options.mode === 'relational' ? relational : direct;
    // 4. Negative cases and boundary rows.
    const relationalNegatives = collectNegatives(relational, options.resolver);
    const nestedNegatives = collectNegatives(direct, options.resolver);
    const negatives = options.mode === 'relational' ? relationalNegatives : nestedNegatives;
    const boundaries = collectBoundaries(views, options.resolver, rng);
    return {
        seed: options.seed,
        count,
        mode: options.mode,
        model,
        views,
        relational,
        nested: direct,
        nestedExpanded: expanded,
        negatives,
        relationalNegatives,
        nestedNegatives,
        boundaries,
        warnings,
    };
}
/** Expand a relational row back into the document shape of the source schema. */
export function expandRow(tableName, row, model, rowsByTable, guard) {
    const table = model.tables.get(tableName);
    if (!table)
        return row;
    const merged = mergeAllOf(table.schema);
    const out = {};
    for (const property of Object.keys(merged.properties)) {
        const column = table.columns.find((candidate) => candidate.name === property);
        if (column?.fk) {
            const value = row[property];
            if (value === undefined)
                continue;
            const target = model.tables.get(column.fk.target);
            if (!target) {
                out[property] = value;
                continue;
            }
            const targetRows = rowsByTable.get(column.fk.target) ?? [];
            const targetRow = targetRows.find((candidate) => candidate[target.primaryKey.property] === value);
            out[property] =
                targetRow && !guard.has(column.fk.target)
                    ? expandRow(column.fk.target, targetRow, model, rowsByTable, new Set([...guard, column.fk.target]))
                    : value;
            continue;
        }
        const relation = model.oneToMany.find((candidate) => candidate.parent === tableName && candidate.collectionProperty === property);
        if (relation) {
            const parentKey = row[table.primaryKey.property];
            const children = (rowsByTable.get(relation.child) ?? []).filter((candidate) => candidate[relation.backReferenceProperty] === parentKey);
            out[property] = children.map((child) => expandRow(relation.child, child, model, rowsByTable, guard));
            continue;
        }
        if (property in row)
            out[property] = row[property];
    }
    return out;
}
/** Replace every $ref by the schema it points at. */
export function inlineRefs(schema, resolver, file, seen = [], depth = 0) {
    // The cut is the same everywhere: an empty object. The generator and the
    // validator then always agree on what a cyclic position holds.
    if (depth > 16)
        return { type: 'object', properties: {} };
    if (Array.isArray(schema)) {
        return schema.map((item) => inlineRefs(item, resolver, file, seen, depth + 1));
    }
    if (!schema || typeof schema !== 'object')
        return schema;
    if (RefResolver.isRef(schema)) {
        const resolved = resolver.resolve(schema.$ref, file, false);
        if (!resolved)
            return schema;
        // A reference cycle is cut here. The cut is an empty object, so the
        // generator and the validator agree on what the position holds.
        if (seen.includes(resolved.id))
            return { type: 'object', properties: {} };
        const inlined = inlineRefs(resolved.schema, resolver, resolved.file, [...seen, resolved.id], depth + 1);
        const siblings = { ...schema };
        delete siblings.$ref;
        return { ...inlined, ...siblings };
    }
    const out = {};
    for (const key of Object.keys(schema)) {
        out[key] = inlineRefs(schema[key], resolver, file, seen, depth + 1);
    }
    return out;
}
/**
 * Collect the negative cases of every view.
 *
 * The mutations are collected from the rows themselves, so every mutation is
 * applied to the very row it was found in: a property that is missing from
 * that row cannot be "broken" by changing it.
 */
export function collectNegatives(views, resolver) {
    const result = [];
    for (const view of views) {
        if (view.rows.length === 0)
            continue;
        const found = [];
        const rowsToInspect = Math.min(view.rows.length, 3);
        for (let row = 0; row < rowsToInspect; row++) {
            const mutations = [];
            collectMutations(view.schema, view.rows[row], resolver, view.file, [], mutations, 0);
            for (const mutation of mutations)
                found.push({ row, mutation });
        }
        const picked = pickMutations(found, 24);
        for (const entry of picked) {
            const mutation = entry.mutation;
            const data = deepCopy(view.rows[entry.row]);
            if (mutation.op === 'delete')
                deleteAtPath(data, mutation.path);
            else
                setAtPath(data, mutation.path, mutation.value);
            result.push({
                table: view.name,
                reason: mutation.reason,
                kind: mutation.kind,
                property: mutation.path.join('.'),
                data,
                keyword: mutation.keyword,
                path: mutation.path.join('.'),
            });
        }
    }
    return result;
}
/** Walk a schema and its data, collecting every mutation the schema forbids. */
function collectMutations(schema, data, resolver, file, path, out, depth) {
    if (depth > 4)
        return;
    if (!schema || typeof schema !== 'object')
        return;
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return;
    const resolved = derefSchema(schema, resolver, file);
    const properties = resolved.schema.properties;
    if (!properties || typeof properties !== 'object')
        return;
    const required = Array.isArray(resolved.schema.required) ? resolved.schema.required : [];
    const source = data;
    for (const property of Object.keys(properties)) {
        if (!(property in source))
            continue;
        const value = source[property];
        const propertySchema = derefSchema(properties[property], resolver, resolved.file);
        const childPath = [...path, property];
        const label = childPath.join('.');
        const type = schemaType(propertySchema.schema) ?? inferType(value);
        const nullable = schemaNullable(propertySchema.schema);
        const isRequired = required.includes(property);
        if (type && value !== null && value !== undefined) {
            const bad = badTypeValue(type);
            if (bad !== undefined) {
                out.push({
                    kind: 'type-mismatch',
                    reason: label +
                        ': expected type ' +
                        type +
                        ', the value is a ' +
                        inferType(bad) +
                        ' instead',
                    keyword: 'type',
                    path: childPath,
                    op: 'set',
                    value: bad,
                });
            }
        }
        const enumValues = propertySchema.schema.enum;
        if (Array.isArray(enumValues) && enumValues.length > 0) {
            out.push({
                kind: 'enum-violation',
                reason: label + ': value is not one of ' + JSON.stringify(enumValues),
                keyword: 'enum',
                path: childPath,
                op: 'set',
                value: '__not_in_enum__',
            });
        }
        const format = typeof propertySchema.schema.format === 'string' ? propertySchema.schema.format : '';
        const badFormat = BAD_FORMAT_VALUES[format];
        if (badFormat !== undefined) {
            out.push({
                kind: 'format-violation',
                reason: label + ': ' + JSON.stringify(badFormat) + ' is not a valid ' + format,
                keyword: 'format',
                path: childPath,
                op: 'set',
                value: badFormat,
            });
        }
        if (type === 'string' && typeof propertySchema.schema.pattern !== 'string') {
            const minLength = typeof propertySchema.schema.minLength === 'number' ? propertySchema.schema.minLength : undefined;
            const maxLength = typeof propertySchema.schema.maxLength === 'number' ? propertySchema.schema.maxLength : undefined;
            if (maxLength !== undefined) {
                out.push({
                    kind: 'length-violation',
                    reason: label + ': longer than maxLength ' + maxLength,
                    keyword: 'maxLength',
                    path: childPath,
                    op: 'set',
                    value: 'x'.repeat(maxLength + 5),
                });
            }
            else if (minLength !== undefined && minLength > 0) {
                out.push({
                    kind: 'length-violation',
                    reason: label + ': shorter than minLength ' + minLength,
                    keyword: 'minLength',
                    path: childPath,
                    op: 'set',
                    value: 'x'.repeat(minLength - 1),
                });
            }
        }
        if (type === 'integer' || type === 'number') {
            const minimum = typeof propertySchema.schema.minimum === 'number' ? propertySchema.schema.minimum : undefined;
            const maximum = typeof propertySchema.schema.maximum === 'number' ? propertySchema.schema.maximum : undefined;
            const exclusiveMinimum = typeof propertySchema.schema.exclusiveMinimum === 'number' ? propertySchema.schema.exclusiveMinimum : undefined;
            const exclusiveMaximum = typeof propertySchema.schema.exclusiveMaximum === 'number' ? propertySchema.schema.exclusiveMaximum : undefined;
            if (minimum !== undefined) {
                out.push({
                    kind: 'range-violation',
                    reason: label + ': below the minimum ' + minimum,
                    keyword: 'minimum',
                    path: childPath,
                    op: 'set',
                    value: minimum - 1,
                });
            }
            else if (exclusiveMinimum !== undefined) {
                out.push({
                    kind: 'range-violation',
                    reason: label + ': not greater than exclusiveMinimum ' + exclusiveMinimum,
                    keyword: 'exclusiveMinimum',
                    path: childPath,
                    op: 'set',
                    value: exclusiveMinimum - 1,
                });
            }
            if (maximum !== undefined) {
                out.push({
                    kind: 'range-violation',
                    reason: label + ': above the maximum ' + maximum,
                    keyword: 'maximum',
                    path: childPath,
                    op: 'set',
                    value: maximum + 1,
                });
            }
            else if (exclusiveMaximum !== undefined) {
                out.push({
                    kind: 'range-violation',
                    reason: label + ': not smaller than exclusiveMaximum ' + exclusiveMaximum,
                    keyword: 'exclusiveMaximum',
                    path: childPath,
                    op: 'set',
                    value: exclusiveMaximum + 1,
                });
            }
        }
        if (!nullable && isRequired) {
            out.push({
                kind: 'null-violation',
                reason: label + ': null is not allowed',
                keyword: 'type',
                path: childPath,
                op: 'set',
                value: null,
            });
        }
        if (isRequired) {
            out.push({
                kind: 'missing-required',
                reason: label + ': required property is missing',
                keyword: 'required',
                path: childPath,
                op: 'delete',
            });
        }
        if (type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
            collectMutations(propertySchema.schema, value, resolver, propertySchema.file, childPath, out, depth + 1);
        }
        if (type === 'array' && Array.isArray(value) && propertySchema.schema.items) {
            const limit = Math.min(value.length, 2);
            for (let index = 0; index < limit; index++) {
                collectMutations(propertySchema.schema.items, value[index], resolver, propertySchema.file, [...childPath, String(index)], out, depth + 1);
            }
        }
    }
}
/** Choose a diverse subset of the collected mutations. */
function pickMutations(found, limit) {
    const byKind = new Map();
    for (const entry of found) {
        const list = byKind.get(entry.mutation.kind) ?? [];
        const key = entry.mutation.path.join('.');
        if (!list.some((existing) => existing.mutation.path.join('.') === key))
            list.push(entry);
        byKind.set(entry.mutation.kind, list);
    }
    const kinds = [...byKind.keys()].sort((left, right) => {
        const leftIndex = KIND_ORDER.indexOf(left);
        const rightIndex = KIND_ORDER.indexOf(right);
        if (leftIndex === -1 && rightIndex === -1)
            return left.localeCompare(right);
        if (leftIndex === -1)
            return 1;
        if (rightIndex === -1)
            return -1;
        return leftIndex - rightIndex;
    });
    const picked = [];
    for (let round = 0; picked.length < limit; round++) {
        let added = false;
        for (const kind of kinds) {
            const list = byKind.get(kind);
            if (round < list.length) {
                picked.push(list[round]);
                added = true;
                if (picked.length >= limit)
                    break;
            }
        }
        if (!added)
            break;
    }
    return picked;
}
/** A value of the wrong type. */
function badTypeValue(type) {
    switch (type) {
        case 'string':
            return 42;
        case 'integer':
        case 'number':
            return 'forty-two';
        case 'boolean':
            return 'yes';
        case 'array':
            return { not: 'an array' };
        case 'object':
            return ['not', 'an', 'object'];
        default:
            return undefined;
    }
}
/** Guess the JSON type of a value. */
function inferType(value) {
    if (value === null || value === undefined)
        return 'null';
    if (Array.isArray(value))
        return 'array';
    if (typeof value === 'number')
        return Number.isInteger(value) ? 'integer' : 'number';
    if (typeof value === 'boolean')
        return 'boolean';
    if (typeof value === 'object')
        return 'object';
    return 'string';
}
/** Follow a $ref once. */
function derefSchema(schema, resolver, file) {
    if (RefResolver.isRef(schema)) {
        const resolved = resolver.resolve(schema.$ref, file, false);
        if (resolved)
            return { schema: resolved.schema, file: resolved.file };
    }
    return { schema, file };
}
/** Write a value at a dotted path. */
function setAtPath(root, path, value) {
    let current = root;
    for (let index = 0; index < path.length - 1; index++) {
        if (current === null || current === undefined)
            return;
        if (Array.isArray(current)) {
            const position = Number(path[index]);
            if (!Number.isInteger(position) || position < 0 || position >= current.length)
                return;
            current = current[position];
            continue;
        }
        if (typeof current !== 'object')
            return;
        const key = path[index];
        if (!(key in current)) {
            current[key] = /^\d+$/.test(path[index + 1] ?? '') ? [] : {};
        }
        current = current[key];
    }
    const last = path[path.length - 1];
    if (last === undefined)
        return;
    if (Array.isArray(current)) {
        const position = Number(last);
        if (Number.isInteger(position) && position >= 0 && position < current.length)
            current[position] = value;
        return;
    }
    if (current && typeof current === 'object')
        current[last] = value;
}
/** Remove the property at a dotted path. */
function deleteAtPath(root, path) {
    const parentPath = path.slice(0, -1);
    const last = path[path.length - 1];
    if (last === undefined)
        return;
    let current = root;
    for (const key of parentPath) {
        if (current === null || current === undefined || typeof current !== 'object')
            return;
        current = Array.isArray(current) ? current[Number(key)] : current[key];
    }
    if (!current || typeof current !== 'object')
        return;
    if (Array.isArray(current)) {
        const position = Number(last);
        if (Number.isInteger(position) && position >= 0 && position < current.length)
            current.splice(position, 1);
        return;
    }
    delete current[last];
}
/** Build the boundary rows of every view. */
export function collectBoundaries(views, resolver, rng) {
    const result = [];
    const warnings = [];
    for (const view of views) {
        if (view.rows.length === 0)
            continue;
        const ctx = {
            rng,
            resolver,
            file: view.file,
            path: '',
            depth: 0,
            maxDepth: 6,
            stack: [],
            warnings,
        };
        for (const kind of ['minimum', 'maximum']) {
            const row = boundaryRow(view, kind, resolver, ctx);
            if (row)
                result.push({ table: view.name, kind, data: row });
        }
    }
    return result;
}
/** One row that sits on the declared limits of the schema. */
function boundaryRow(view, kind, resolver, ctx) {
    const base = view.rows[0];
    if (!base)
        return null;
    const row = deepCopy(base);
    const properties = (view.schema.properties ?? {});
    let touched = false;
    for (const property of Object.keys(properties)) {
        if (!(property in row))
            continue;
        const propertySchema = derefSchema(properties[property], resolver, view.file);
        const value = boundaryValue(propertySchema.schema, kind, view.name + '.' + property, ctx);
        if (value === undefined)
            continue;
        row[property] = value;
        touched = true;
    }
    return touched ? row : null;
}
/** The value that sits on a declared limit. */
function boundaryValue(schema, kind, path, ctx) {
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return kind === 'minimum' ? schema.enum[0] : schema.enum[schema.enum.length - 1];
    }
    const type = schemaType(schema);
    if (type === 'integer' || type === 'number') {
        const step = typeof schema.multipleOf === 'number' && schema.multipleOf > 0 ? schema.multipleOf : type === 'integer' ? 1 : 0.01;
        const exclusiveMinimum = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : undefined;
        const exclusiveMaximum = typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : undefined;
        const minimum = typeof schema.minimum === 'number'
            ? schema.minimum
            : exclusiveMinimum !== undefined
                ? exclusiveMinimum + (type === 'integer' ? 1 : step)
                : undefined;
        const maximum = typeof schema.maximum === 'number'
            ? schema.maximum
            : exclusiveMaximum !== undefined
                ? exclusiveMaximum - (type === 'integer' ? 1 : step)
                : undefined;
        if (kind === 'minimum' && minimum !== undefined) {
            const value = Math.ceil(minimum / step) * step;
            if (maximum === undefined || value <= maximum)
                return type === 'integer' ? Math.round(value) : Math.round(value * 100) / 100;
            return undefined;
        }
        if (kind === 'maximum' && maximum !== undefined) {
            const value = Math.floor(maximum / step) * step;
            if (minimum === undefined || value >= minimum)
                return type === 'integer' ? Math.round(value) : Math.round(value * 100) / 100;
            return undefined;
        }
        return undefined;
    }
    if (type === 'string' && typeof schema.pattern !== 'string' && typeof schema.format !== 'string') {
        const minLength = typeof schema.minLength === 'number' ? schema.minLength : undefined;
        const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
        if (kind === 'minimum' && minLength !== undefined && minLength > 0)
            return 'x'.repeat(minLength);
        if (kind === 'maximum' && maxLength !== undefined)
            return 'x'.repeat(maxLength);
        return undefined;
    }
    if (type === 'array') {
        const minItems = typeof schema.minItems === 'number' ? schema.minItems : undefined;
        const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
        const size = kind === 'minimum' ? minItems : maxItems;
        if (size === undefined || !schema.items)
            return undefined;
        const items = [];
        for (let index = 0; index < size; index++) {
            items.push(generateValue(schema.items, ctx, path + '[' + index + ']'));
        }
        return items;
    }
    return undefined;
}
