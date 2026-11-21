/**
 * Reference resolution.
 *
 * Supports:
 *   - local pointers:  "#/components/schemas/User", "#/$defs/Thing"
 *   - external files:  "./common.yaml#/components/schemas/Address", "common.yaml"
 *   - relative external files are resolved against the directory of the file
 *     that contains the reference (not the process working directory)
 *
 * The resolver also detects reference *cycles* so the generator can stop
 * expanding instead of recursing forever.
 */
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { loadDocument, SchemaSeedError } from './loader.js';
// The resolver throws SchemaSeedError, so callers can catch it from here.
export { SchemaSeedError } from './loader.js';
/** Split "#/a/b" into its segments, honouring ~0 (~) and ~1 (/) escapes. */
export function decodePointer(pointer) {
    if (pointer === '' || pointer === '#')
        return [];
    const body = pointer.startsWith('#') ? pointer.slice(1) : pointer;
    if (body === '')
        return [];
    if (!body.startsWith('/')) {
        throw new SchemaSeedError('<ref>', 'invalid JSON pointer "' + pointer + '"');
    }
    return body
        .split('/')
        .slice(1)
        .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}
/**
 * Build the canonical id of a location inside a file.
 *
 * The canonical id is "<absolute file>#<json pointer>" and it holds exactly one
 * "#". The pointer never carries a leading "#" of its own, so a local
 * reference ("#/components/schemas/User") and the id of the named schema it
 * points at ("<file>#/components/schemas/User") are the same string. Without
 * that rule a local reference would be looked up under an id that can never
 * match, and no local $ref would ever become a foreign key.
 */
export function canonicalId(file, pointer) {
    return file + '#' + (pointer.startsWith('#') ? pointer.slice(1) : pointer);
}
/** Walk a JSON pointer inside a document. */
export function resolvePointer(doc, pointer, file) {
    const segments = decodePointer(pointer);
    let current = doc;
    for (const segment of segments) {
        if (current === null || current === undefined) {
            throw new SchemaSeedError(file, 'cannot resolve pointer "' + pointer + '" (path "' + segment + '" does not exist)');
        }
        if (Array.isArray(current)) {
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0 || index >= current.length) {
                throw new SchemaSeedError(file, 'cannot resolve pointer "' + pointer + '" (index "' + segment + '" is out of range)');
            }
            current = current[index];
            continue;
        }
        if (typeof current !== 'object' || !(segment in current)) {
            throw new SchemaSeedError(file, 'cannot resolve pointer "' + pointer + '" (property "' + segment + '" does not exist)');
        }
        current = current[segment];
    }
    return current;
}
/**
 * Holds every document that has been loaded, so that external references can
 * pull in more files on demand without loading the same file twice.
 */
export class DocumentStore {
    docs = new Map();
    /** Load (or return the already loaded) document at an absolute path. */
    load(file) {
        const absolute = resolvePath(file);
        const existing = this.docs.get(absolute);
        if (existing)
            return existing;
        const doc = loadDocument(absolute);
        this.docs.set(absolute, doc);
        return doc;
    }
    /** All documents loaded so far, in load order. */
    all() {
        return [...this.docs.values()];
    }
}
/**
 * Resolves $ref strings.
 *
 * The resolver is stateless apart from the document store, and it is safe to
 * use concurrently because it never mutates shared state.
 */
export class RefResolver {
    store;
    /** Unresolvable references, collected as warnings instead of thrown. */
    warnings = [];
    constructor(store = new DocumentStore()) {
        this.store = store;
    }
    /**
     * Resolve a $ref.
     *
     * @param ref        the raw reference string
     * @param fromFile   absolute path of the file the reference was written in
     * @param strict     throw on failure (true) or record a warning (false)
     */
    resolve(ref, fromFile, strict = true) {
        const hashIndex = ref.indexOf('#');
        const filePart = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
        const pointerPart = hashIndex === -1 ? '' : ref.slice(hashIndex);
        // The fragment of a reference is a JSON pointer that may carry its own
        // "#" ("#/components/schemas/User"). The canonical pointer, and with it
        // the canonical id, never does.
        const pointer = pointerPart.startsWith('#') ? pointerPart.slice(1) : pointerPart;
        let targetFile;
        if (filePart === '') {
            targetFile = fromFile;
        }
        else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePart)) {
            const message = 'remote reference "' + ref + '" is not supported; SchemaSeed never accesses the network';
            if (strict)
                throw new SchemaSeedError(fromFile, message);
            this.warnings.push(fromFile + ': ' + message);
            return null;
        }
        else {
            const base = isAbsolute(filePart) ? filePart : resolvePath(dirname(fromFile), filePart);
            targetFile = resolvePath(base);
        }
        let doc;
        try {
            doc = this.store.load(targetFile);
        }
        catch (error) {
            const message = 'cannot resolve reference "' + ref + '": ' + error.message;
            if (strict)
                throw new SchemaSeedError(fromFile, message);
            this.warnings.push(fromFile + ': ' + message);
            return null;
        }
        try {
            const schema = resolvePointer(doc.doc, pointerPart, targetFile);
            return { schema, file: targetFile, pointer: pointerPart, id: canonicalId(targetFile, pointer) };
        }
        catch (error) {
            const message = 'cannot resolve reference "' + ref + '": ' + error.message;
            if (strict)
                throw new SchemaSeedError(fromFile, message);
            this.warnings.push(fromFile + ': ' + message);
            return null;
        }
    }
    /** True when the schema object carries a $ref. */
    static isRef(schema) {
        return !!schema && typeof schema === 'object' && !Array.isArray(schema) && typeof schema.$ref === 'string';
    }
    /**
     * Follow a chain of $refs until a concrete schema is reached.
     *
     * @param schema      the schema (possibly a $ref)
     * @param fromFile    file the schema came from
     * @param stack       ids already visited (cycle detection)
     */
    deref(schema, fromFile, stack = []) {
        let current = schema;
        let currentFile = fromFile;
        let currentId = canonicalId(fromFile, '');
        // The starting id counts as visited: a reference that resolves back to it
        // (for example { $ref: '#' } pointing at the document root) is a cycle.
        const visited = [currentId, ...stack];
        for (let depth = 0; depth < 64; depth++) {
            if (!RefResolver.isRef(current)) {
                return { schema: current, file: currentFile, id: currentId, cyclic: false };
            }
            const resolved = this.resolve(current.$ref, currentFile, false);
            if (!resolved) {
                return { schema: {}, file: currentFile, id: currentId, cyclic: false };
            }
            if (visited.includes(resolved.id)) {
                return { schema: resolved.schema, file: resolved.file, id: resolved.id, cyclic: true };
            }
            visited.push(resolved.id);
            current = resolved.schema;
            currentFile = resolved.file;
            currentId = resolved.id;
        }
        return { schema: current, file: currentFile, id: currentId, cyclic: true };
    }
}
/**
 * Find every reference inside a schema, without expanding them.
 * Used by the inspector and by cycle detection.
 */
export function collectRefs(schema, found = []) {
    if (!schema || typeof schema !== 'object')
        return found;
    if (Array.isArray(schema)) {
        for (const item of schema)
            collectRefs(item, found);
        return found;
    }
    if (typeof schema.$ref === 'string') {
        found.push(schema.$ref);
    }
    for (const key of Object.keys(schema)) {
        if (key === '$ref')
            continue;
        collectRefs(schema[key], found);
    }
    return found;
}
/** Map every named schema to the named schemas it references. */
export function buildReferenceGraph(named, resolver) {
    const graph = new Map();
    const byId = new Map(named.map((entry) => [entry.id, entry]));
    for (const entry of named) {
        const targets = new Set();
        for (const ref of collectRefs(entry.schema)) {
            const resolved = resolver.resolve(ref, entry.file, false);
            if (!resolved)
                continue;
            const target = byId.get(resolved.id);
            if (target && target.name !== entry.name) {
                targets.add(target.name);
            }
        }
        graph.set(entry.name, targets);
    }
    return graph;
}
/**
 * Find cycles in a directed graph.
 * Returns the names that participate in at least one cycle.
 */
export function findCycles(graph) {
    const cycles = [];
    const state = new Map(); // 0 = unvisited, 1 = on stack, 2 = done
    const stack = [];
    const visit = (node) => {
        state.set(node, 1);
        stack.push(node);
        for (const next of graph.get(node) ?? []) {
            const status = state.get(next) ?? 0;
            if (status === 0) {
                visit(next);
            }
            else if (status === 1) {
                const start = stack.indexOf(next);
                if (start >= 0)
                    cycles.push([...stack.slice(start), next]);
            }
        }
        stack.pop();
        state.set(node, 2);
    };
    for (const node of graph.keys()) {
        if ((state.get(node) ?? 0) === 0)
            visit(node);
    }
    return cycles;
}
