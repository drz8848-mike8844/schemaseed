/**
 * Shared types for SchemaSeed.
 *
 * The library models an OpenAPI 3.x document or a JSON Schema document as a set of
 * named *tables*. A table is a named schema plus the relational projection that
 * turns "$ref to another named schema" into a foreign key pointing at that
 * table's primary key.
 */

/** Any JSON value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * A JSON Schema / OpenAPI Schema Object.
 *
 * Deliberately loose: the whole point of the library is to consume documents it
 * has never seen, so every keyword is optional and unknown keywords are ignored.
 */
export type Schema = { [key: string]: any };

/** Document flavour. */
export type DocKind = 'openapi' | 'jsonschema';

/** A parsed source document. */
export interface LoadedDoc {
  /** Absolute path of the file the document was read from. */
  file: string;
  /** How the document was parsed. */
  kind: DocKind;
  /** The parsed document. */
  doc: any;
  /** True when the document was parsed as JSON, false for YAML. */
  json: boolean;
}

/** A named schema (a table). */
export interface NamedSchema {
  /** Unique table name. */
  name: string;
  /** Canonical id: "<abs file>#<json pointer>" — stable across runs. */
  id: string;
  /** Absolute file the schema was defined in. */
  file: string;
  /** JSON pointer inside that file, e.g. "/components/schemas/User". */
  pointer: string;
  /** The schema object itself. */
  schema: Schema;
  /** Where the name came from ("components/schemas", "$defs", "root", ...). */
  origin: string;
}

/** Primary key description of a table. */
export interface PrimaryKey {
  /** Property name holding the primary key. */
  property: string;
  /** JSON type of the key ("string", "integer", "number", ...). */
  type: string;
  /** True when the key was synthesised because the schema declared none. */
  synthetic: boolean;
}

/** A foreign key: a property whose schema is a $ref to another named table. */
export interface ForeignKey {
  /** Property holding the foreign key in the child table. */
  property: string;
  /** Table the key points at. */
  target: string;
  /** Property of the target table holding the referenced value. */
  targetProperty: string;
  /** JSON type of the foreign key value. */
  type: string;
  /** True when the property may be null. */
  nullable: boolean;
  /** True when the property is required. */
  required: boolean;
}

/** A property of a table. */
export interface ColumnInfo {
  name: string;
  type: string;
  format?: string;
  nullable: boolean;
  required: boolean;
  /** Present when the column is a foreign key. */
  fk?: ForeignKey;
  /**
   * Present when the column is a list of primary keys of another table
   * (a collection with no back reference column).
   */
  idListOf?: string;
}

/** A one-to-many relation: parent table -> child table. */
export interface OneToMany {
  /** Parent table. */
  parent: string;
  /** Child table. */
  child: string;
  /** Property on the parent holding the collection (array of $ref to child). */
  collectionProperty: string;
  /** Property on the child pointing back at the parent. */
  backReferenceProperty: string;
}

/** A many-to-many relation realised through a join table. */
export interface ManyToMany {
  /** The join table. */
  join: string;
  /** Left hand table. */
  left: string;
  /** Right hand table. */
  right: string;
  /** Property on the join table pointing at the left table. */
  leftProperty: string;
  /** Property on the join table pointing at the right table. */
  rightProperty: string;
}

/** Everything we know about one table. */
export interface TableInfo {
  name: string;
  id: string;
  file: string;
  pointer: string;
  schema: Schema;
  primaryKey: PrimaryKey;
  columns: ColumnInfo[];
  foreignKeys: ForeignKey[];
  /** True when the table only exists as the child side of a one-to-many relation. */
  childOnly: boolean;
}

/** A generated row. */
export type Row = { [key: string]: any };

/** A table of generated rows. */
export interface TableData {
  info: TableInfo;
  rows: Row[];
}

/** A deliberately invalid sample. */
export interface NegativeCase {
  /** Table the case belongs to. */
  table: string;
  /** Human readable reason, e.g. "missing required field 'email'". */
  reason: string;
  /** Machine readable violation kind, e.g. "missing-required". */
  kind: string;
  /** The property that was mutated (when applicable). */
  property?: string;
  /** The invalid payload. */
  data: Row;
}

/** A validation failure. */
export interface ValidationIssue {
  /** JSON pointer into the validated value. */
  path: string;
  /** The keyword that failed. */
  keyword: string;
  /** Human readable message. */
  message: string;
}

/** A dangling foreign key. */
export interface DanglingRef {
  table: string;
  property: string;
  target: string;
  value: any;
  rowIndex: number;
}

/** The full generated dataset. */
export interface Dataset {
  /** The seed used. */
  seed: number;
  /** Tables in generation order. */
  tables: TableData[];
  /** Negative cases across all tables. */
  negatives: NegativeCase[];
  /** Non-fatal problems found while parsing or generating. */
  warnings: string[];
  /** One-to-many relations. */
  oneToMany: OneToMany[];
  /** Many-to-many relations. */
  manyToMany: ManyToMany[];
}
