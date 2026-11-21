/**
 * The relational model.
 *
 * This is where an OpenAPI / JSON Schema document becomes a set of tables:
 *
 *   - every named schema that describes an object becomes a *table*
 *   - a property whose schema references another table becomes a *foreign key*
 *     column holding the referenced table's primary key value
 *   - a property that is an array of references to another table becomes a
 *     *one-to-many* relation: the children live in their own table and carry a
 *     foreign key back to the parent
 *   - a table whose only meaningful columns are foreign keys to two other
 *     tables becomes a *many-to-many* join table
 *
 * The projection is deliberate: the output is meant to be inserted into a
 * relational database, so nested objects are normalised into columns and
 * foreign keys. The validator checks this projection, not the original nested
 * shape.
 */

import { RefResolver } from './ref-resolver.js';
import { schemaNullable, schemaType } from './loader.js';
import type {
  ColumnInfo,
  ForeignKey,
  ManyToMany,
  NamedSchema,
  OneToMany,
  Schema,
  TableInfo,
} from './types.js';

/** The full relational model of a document (or several documents). */
export interface RelationalModel {
  /** All tables, keyed by name. */
  tables: Map<string, TableInfo>;
  /** Table names in a deterministic order. */
  order: string[];
  /** One-to-many relations. */
  oneToMany: OneToMany[];
  /** Many-to-many relations. */
  manyToMany: ManyToMany[];
  /** Names involved in a foreign key cycle. */
  cycles: string[][];
  /** Non-fatal modelling problems. */
  warnings: string[];
  /** The relational (flattened) schema of every table, used for generation and validation. */
  relationalSchemas: Map<string, Schema>;
}

/** True when a schema describes an object (and can therefore become a table). */
export function isObjectSchema(schema: Schema | undefined): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const type = schemaType(schema);
  if (type === 'object') return true;
  if (type === undefined && schema.properties && typeof schema.properties === 'object') return true;
  return false;
}

/** Merge the properties of allOf branches into a single property map. */
export function mergeAllOf(schema: Schema): { properties: Record<string, Schema>; required: string[] } {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  const visit = (node: Schema | undefined): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) visit(branch);
    }
    if (node.properties && typeof node.properties === 'object') {
      for (const key of Object.keys(node.properties)) {
        properties[key] = node.properties[key];
      }
    }
    if (Array.isArray(node.required)) {
      for (const key of node.required) {
        if (!required.includes(key)) required.push(key);
      }
    }
  };
  visit(schema);
  return { properties, required };
}

/** Find the primary key of a table. */
export function findPrimaryKey(
  schema: Schema,
  properties: Record<string, Schema>,
): { property: string; type: string; synthetic: boolean } {
  const declared = schema['x-primary-key'];
  if (typeof declared === 'string' && properties[declared]) {
    return { property: declared, type: schemaType(properties[declared]) ?? 'string', synthetic: false };
  }
  const names = Object.keys(properties);
  if (properties.id) {
    return { property: 'id', type: schemaType(properties.id) ?? 'string', synthetic: false };
  }
  for (const name of names) {
    if (properties[name]?.['x-primary-key'] === true) {
      return { property: name, type: schemaType(properties[name]) ?? 'string', synthetic: false };
    }
  }
  for (const name of names) {
    if (/(^|[_-])id$|_id$|Id$/.test(name)) {
      const type = schemaType(properties[name]);
      if (type === 'string' || type === 'integer' || type === 'number') {
        return { property: name, type, synthetic: false };
      }
    }
  }
  return { property: 'id', type: 'string', synthetic: true };
}

/** Table name candidates derived from a property name such as "customerId". */
export function tableNameCandidates(property: string): string[] {
  const trimmed = property.replace(/(_id|Id|ID)$/, '');
  const candidates = new Set<string>();
  if (trimmed) {
    candidates.add(trimmed);
    candidates.add(trimmed.toLowerCase());
    candidates.add(
      trimmed
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[-\s]+/g, '_')
        .toLowerCase(),
    );
  }
  return [...candidates];
}

/**
 * Build the relational model.
 *
 * @param named    all named schemas found in the source document(s)
 * @param resolver the resolver used to follow references
 */
export function buildModel(named: NamedSchema[], resolver: RefResolver): RelationalModel {
  const warnings: string[] = [];
  const byId = new Map<string, NamedSchema>();
  const tableCandidates = new Map<string, NamedSchema>();

  for (const entry of named) {
    byId.set(entry.id, entry);
    if (isObjectSchema(entry.schema)) {
      tableCandidates.set(entry.name, entry);
    }
  }

  const tables = new Map<string, TableInfo>();

  // Pass 1: primary keys.
  for (const [name, entry] of tableCandidates) {
    const merged = mergeAllOf(entry.schema);
    const pk = findPrimaryKey(entry.schema, merged.properties);
    if (pk.synthetic) {
      warnings.push(
        name +
          ': no primary key found, synthesised an "id" column of type string ' +
          '(add x-primary-key to the schema to name it yourself)',
      );
    }
    tables.set(name, {
      name,
      id: entry.id,
      file: entry.file,
      pointer: entry.pointer,
      schema: entry.schema,
      primaryKey: { property: pk.property, type: pk.type, synthetic: pk.synthetic },
      columns: [],
      foreignKeys: [],
      childOnly: false,
    });
  }

  // Pass 2: classify every property into a column or a foreign key.
  const collectionProps: { parent: string; property: string; child: string }[] = [];

  for (const table of tables.values()) {
    const merged = mergeAllOf(table.schema);
    const required = new Set(merged.required);
    const columns: ColumnInfo[] = [];

    for (const property of Object.keys(merged.properties)) {
      const raw = merged.properties[property];
      const isRequired = required.has(property);
      const nullable = schemaNullable(raw);

      const target = resolveTableTarget(raw, property, table, resolver, tables, byId);

      if (target) {
        const targetTable = tables.get(target)!;
        const fk: ForeignKey = {
          property,
          target: targetTable.name,
          targetProperty: targetTable.primaryKey.property,
          type: targetTable.primaryKey.type,
          nullable: nullable || !isRequired,
          required: isRequired,
        };
        columns.push({
          name: property,
          type: fk.type,
          nullable: fk.nullable,
          required: isRequired,
          fk,
        });
        table.foreignKeys.push(fk);
        continue;
      }

      const collection = resolveCollectionTarget(raw, table, resolver, tables, byId);
      if (collection) {
        collectionProps.push({ parent: table.name, property, child: collection });
        continue;
      }

      const type = schemaType(raw) ?? 'string';
      const column: ColumnInfo = {
        name: property,
        type,
        nullable: nullable || !isRequired,
        required: isRequired,
      };
      if (typeof raw?.format === 'string') column.format = raw.format;
      columns.push(column);
    }

    // A synthesised primary key must exist as a column.
    if (!columns.some((column) => column.name === table.primaryKey.property)) {
      columns.unshift({
        name: table.primaryKey.property,
        type: table.primaryKey.type,
        nullable: false,
        required: true,
      });
    }

    table.columns = columns;
  }

  // Pass 3: one-to-many relations (parent collection -> child table).
  const oneToMany: OneToMany[] = [];
  for (const link of collectionProps) {
    const childTable = tables.get(link.child);
    const parentTable = tables.get(link.parent);
    if (!childTable || !parentTable) continue;
    const backReference = childTable.foreignKeys.find((fk) => fk.target === parentTable.name);
    if (backReference) {
      oneToMany.push({
        parent: parentTable.name,
        child: childTable.name,
        collectionProperty: link.property,
        backReferenceProperty: backReference.property,
      });
      parentTable.columns = parentTable.columns.filter((column) => column.name !== link.property);
    } else {
      warnings.push(
        parentTable.name +
          '.' +
          link.property +
          ': references ' +
          childTable.name +
          ' but ' +
          childTable.name +
          ' has no column pointing back, so the collection is stored as a list of ids',
      );
      parentTable.columns.push({
        name: link.property,
        type: 'array',
        nullable: false,
        required: false,
        idListOf: childTable.name,
      });
    }
  }

  // Pass 4: many-to-many join tables.
  const manyToMany: ManyToMany[] = [];
  for (const table of tables.values()) {
    if (table.foreignKeys.length < 2) continue;
    const targets = [...new Set(table.foreignKeys.map((fk) => fk.target))];
    if (targets.length < 2) continue;
    const nonKeyColumns = table.columns.filter(
      (column) => !column.fk && column.name !== table.primaryKey.property,
    );
    if (nonKeyColumns.length > 0) continue;
    manyToMany.push({
      join: table.name,
      left: table.foreignKeys[0]!.target,
      leftProperty: table.foreignKeys[0]!.property,
      right: table.foreignKeys[1]!.target,
      rightProperty: table.foreignKeys[1]!.property,
    });
  }

  for (const relation of oneToMany) {
    const child = tables.get(relation.child);
    if (child) child.childOnly = true;
  }

  // Pass 5: relational (flattened) schemas, used for generation and validation.
  const relationalSchemas = new Map<string, Schema>();
  for (const table of tables.values()) {
    relationalSchemas.set(table.name, buildRelationalSchema(table, tables));
  }

  const order = [...tables.keys()].sort();
  const graph = new Map<string, Set<string>>();
  for (const table of tables.values()) {
    graph.set(table.name, new Set(table.foreignKeys.map((fk) => fk.target)));
  }
  const cycles = detectTableCycles(graph);

  return { tables, order, oneToMany, manyToMany, cycles, warnings, relationalSchemas };
}

/**
 * Find the table a property points at, if any.
 *
 * A property becomes a foreign key when it holds a *single* reference to
 * another named schema:
 *
 *   - a collection of references (an array of $ref) is a one-to-many relation
 *     and never a foreign key column, so the name heuristic never applies to it;
 *   - the "customerId" -> "customer" name heuristic only decides which table a
 *     reference points at, it never invents a reference for a property that
 *     carries none. A property without a reference is an ordinary column.
 */
function resolveTableTarget(
  raw: Schema | undefined,
  property: string,
  table: TableInfo,
  resolver: RefResolver,
  tables: Map<string, TableInfo>,
  byId: Map<string, NamedSchema>,
): string | null {
  if (!raw || typeof raw !== 'object') return null;

  // A collection is a one-to-many relation, never a foreign key column.
  if (schemaType(raw) === 'array' || Array.isArray(raw.items)) return null;

  if (RefResolver.isRef(raw)) {
    const resolved = resolver.resolve(raw.$ref, table.file, false);
    if (resolved) {
      const named = byId.get(resolved.id);
      if (named && tables.has(named.name)) return named.name;
      // A reference to a nested location (not a table root) is an inline object.
      return null;
    }
    // The reference does not resolve, so the name of the property is the only
    // signal left: "customerId" points at the table "customer".
    return tableByName(property, tables);
  }

  // oneOf / anyOf with exactly one table branch.
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const branches = raw[keyword];
    if (!Array.isArray(branches)) continue;
    const tableBranches = branches
      .map((branch: Schema) =>
        branch && typeof branch === 'object'
          ? resolveTableTarget(branch, property, table, resolver, tables, byId)
          : null,
      )
      .filter((name): name is string => name !== null);
    if (tableBranches.length === 1) return tableBranches[0]!;
  }

  return null;
}

/**
 * The table a property name points at: "customerId" -> "customer".
 *
 * Only a property that *is* a reference uses this, see resolveTableTarget.
 */
function tableByName(property: string, tables: Map<string, TableInfo>): string | null {
  for (const candidate of tableNameCandidates(property)) {
    if (tables.has(candidate)) return candidate;
  }
  return null;
}

/** Find the table a property's array items point at, if any. */
function resolveCollectionTarget(
  raw: Schema | undefined,
  table: TableInfo,
  resolver: RefResolver,
  tables: Map<string, TableInfo>,
  byId: Map<string, NamedSchema>,
): string | null {
  if (!raw || typeof raw !== 'object') return null;
  if (schemaType(raw) !== 'array') return null;
  const items = raw.items;
  if (!items || typeof items !== 'object') return null;
  if (!RefResolver.isRef(items)) return null;
  const resolved = resolver.resolve(items.$ref, table.file, false);
  if (!resolved) return null;
  const named = byId.get(resolved.id);
  if (named && tables.has(named.name)) return named.name;
  return null;
}

/**
 * Copy a schema before it is flattened.
 *
 * The relational schema drops the $ref, description and title of a column, so
 * it has to work on a copy. The schema that lives in the source document must
 * keep its $ref, otherwise building a model would delete the references the
 * document declares and the caller could no longer see them.
 */
function copySchema(schema: Schema | undefined): Schema | undefined {
  return schema && typeof schema === 'object' ? { ...schema } : undefined;
}

/**
 * Build the flattened schema of a table: the shape the generator produces and
 * the validator checks. Foreign key columns carry the constraints of the
 * referenced table's primary key.
 *
 * The schema of a column is copied before it is flattened, so building a model
 * never modifies the document it was given.
 */
export function buildRelationalSchema(table: TableInfo, tables: Map<string, TableInfo>): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];

  for (const column of table.columns) {
    let columnSchema: Schema;
    if (column.fk) {
      const target = tables.get(column.fk.target);
      const targetSchema = target ? findColumnSchema(target, column.fk.targetProperty) : undefined;
      columnSchema = copySchema(targetSchema) ?? { type: column.fk.type };
      if (!columnSchema.type) columnSchema.type = column.fk.type;
    } else if (column.idListOf) {
      const target = tables.get(column.idListOf);
      const targetSchema = target ? findColumnSchema(target, target.primaryKey.property) : undefined;
      columnSchema = { type: 'array', items: { ...(copySchema(targetSchema) ?? { type: 'string' }) } };
    } else {
      columnSchema = copySchema(findColumnSchema(table, column.name)) ?? { type: column.type };
    }
    // The keywords that do not survive the flattening are dropped from the copy
    // only: the document the schema came from keeps its $ref.
    delete columnSchema.$ref;
    delete columnSchema.description;
    delete columnSchema.title;
    if (column.nullable) {
      columnSchema = { ...columnSchema, nullable: true };
    }
    properties[column.name] = columnSchema;
    if (column.required) required.push(column.name);
  }

  const result: Schema = { type: 'object', properties };
  if (required.length > 0) result.required = required;
  return result;
}

/** The original schema of a column, looked up in the source document. */
export function findColumnSchema(table: TableInfo, property: string): Schema | undefined {
  const merged = mergeAllOf(table.schema);
  return merged.properties[property];
}

/** Detect cycles among table level foreign keys. */
export function detectTableCycles(graph: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, number>();
  const stack: string[] = [];
  const visit = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const status = state.get(next) ?? 0;
      if (status === 0) visit(next);
      else if (status === 1) {
        const start = stack.indexOf(next);
        if (start >= 0) cycles.push([...stack.slice(start), next]);
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of graph.keys()) {
    if ((state.get(node) ?? 0) === 0) visit(node);
  }
  return cycles;
}
