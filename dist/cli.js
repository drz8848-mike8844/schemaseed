#!/usr/bin/env node
/**
 * schemaseed command line interface.
 *
 *   schemaseed generate --input <file> --out <dir> [--formats json,jsonl,csv,sql,ts,pytest]
 *                         [--count N] [--seed S] [--relations]
 *   schemaseed validate --input <file>
 *   schemaseed inspect  --input <file>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { DocumentStore, RefResolver, collectRefs } from './ref-resolver.js';
import { extractNamedSchemas, SchemaSeedError } from './loader.js';
import { buildModel } from './model.js';
import { normalizeSeed } from './prng.js';
import { generateData } from './exporters/dataset.js';
import { exportJson } from './exporters/json.js';
import { exportJsonl } from './exporters/jsonl.js';
import { exportCsv } from './exporters/csv.js';
import { exportSql } from './exporters/sql.js';
import { exportTs } from './exporters/ts.js';
import { exportPytest } from './exporters/pytest.js';
/** The formats the CLI knows. */
const FORMATS = ['json', 'jsonl', 'csv', 'sql', 'ts', 'pytest'];
function main(argv) {
    const command = argv[0];
    if (!command || command === 'help' || command === '--help' || command === '-h') {
        printHelp();
        return command ? 0 : 1;
    }
    const args = parseArgs(argv.slice(1));
    if (args.help) {
        printHelp();
        return 0;
    }
    try {
        if (command === 'generate')
            return commandGenerate(args);
        if (command === 'validate')
            return commandValidate(args);
        if (command === 'inspect')
            return commandInspect(args);
    }
    catch (error) {
        if (error instanceof SchemaSeedError) {
            process.stderr.write('error: ' + error.message + '\n');
            return 1;
        }
        throw error;
    }
    process.stderr.write('error: unknown command "' + command + '"\n');
    printHelp();
    return 1;
}
/** Parse the flags. */
function parseArgs(argv) {
    const args = { relations: false, help: false };
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        const next = () => {
            const value = argv[index + 1];
            if (value === undefined)
                throw new SchemaSeedError('<args>', token + ' needs a value');
            index++;
            return value;
        };
        switch (token) {
            case '--input':
            case '-i':
                args.input = next();
                break;
            case '--out':
            case '-o':
                args.out = next();
                break;
            case '--formats':
            case '-f': {
                const value = next();
                const formats = [];
                for (const part of value.split(',')) {
                    const name = part.trim();
                    if (name === '')
                        continue;
                    if (!FORMATS.includes(name)) {
                        throw new SchemaSeedError('<args>', 'unknown format "' + name + '" (known formats: ' + FORMATS.join(', ') + ')');
                    }
                    formats.push(name);
                }
                args.formats = formats;
                break;
            }
            case '--count':
            case '-n': {
                const value = next();
                const count = Number(value);
                if (!Number.isInteger(count) || count < 0) {
                    throw new SchemaSeedError('<args>', '--count needs a non negative integer, got "' + value + '"');
                }
                args.count = count;
                break;
            }
            case '--seed':
            case '-s':
                args.seed = next();
                break;
            case '--relations':
            case '-r':
                args.relations = true;
                break;
            case '--help':
            case '-h':
                args.help = true;
                break;
            default:
                throw new SchemaSeedError('<args>', 'unknown option "' + token + '"');
        }
    }
    return args;
}
/**
 * Load the input document and everything it references.
 *
 * External documents are pulled in through the resolver, so a $ref that points
 * at another file contributes its named schemas as tables.
 */
function loadProject(input) {
    const store = new DocumentStore();
    const resolver = new RefResolver(store);
    const root = store.load(input);
    const queue = [root];
    const seen = new Set();
    let index = 0;
    while (index < queue.length) {
        const doc = queue[index];
        index++;
        if (seen.has(doc.file))
            continue;
        seen.add(doc.file);
        for (const ref of collectRefs(doc.doc)) {
            // Resolving loads the referenced document into the store.
            resolver.resolve(ref, doc.file, false);
        }
        for (const candidate of store.all()) {
            if (!seen.has(candidate.file) && !queue.includes(candidate))
                queue.push(candidate);
        }
    }
    const named = [];
    const ids = new Set();
    for (const doc of store.all()) {
        for (const entry of extractNamedSchemas(doc)) {
            if (ids.has(entry.id))
                continue;
            ids.add(entry.id);
            named.push(entry);
        }
    }
    // The model builder flattens the schemas on copies, so the documents stay
    // untouched and the inspector and the validator still see every reference
    // that the source declares.
    const model = buildModel(named, resolver);
    return { store, resolver, docs: store.all(), named, model };
}
/** generate: write the dataset in the requested formats. */
function commandGenerate(args) {
    const input = requireOption(args.input, '--input');
    const out = requireOption(args.out, '--out');
    const formats = args.formats && args.formats.length > 0 ? args.formats : [...FORMATS];
    const count = args.count ?? 10;
    const mode = args.relations ? 'relational' : 'nested';
    const absoluteInput = resolvePath(input);
    const content = readFileSync(absoluteInput, 'utf8');
    const seed = normalizeSeed(args.seed, content);
    const project = loadProject(absoluteInput);
    const data = generateData({
        model: project.model,
        named: project.named,
        resolver: project.resolver,
        seed,
        count,
        mode,
    });
    const files = [];
    for (const format of formats) {
        switch (format) {
            case 'json':
                files.push(...exportJson(data));
                break;
            case 'jsonl':
                files.push(...exportJsonl(data));
                break;
            case 'csv':
                files.push(...exportCsv(data));
                break;
            case 'sql':
                files.push(...exportSql(data));
                break;
            case 'ts':
                files.push(...exportTs(data));
                break;
            case 'pytest':
                files.push(...exportPytest(data));
                break;
            default:
                break;
        }
    }
    const outDir = resolvePath(out);
    for (const file of files) {
        const target = resolvePath(outDir, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content, 'utf8');
    }
    const manifest = {
        tool: 'schemaseed',
        input: absoluteInput,
        seed,
        count,
        mode,
        formats,
        documents: project.docs.map((doc) => ({ file: doc.file, kind: doc.kind })),
        tables: data.views.map((view) => ({
            name: view.name,
            rows: view.rows.length,
            kind: view.kind,
        })),
        negativeCases: data.negatives.length,
        warnings: data.warnings,
        files: files.map((file) => file.path),
    };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolvePath(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    process.stdout.write('Generated ' + files.length + ' file(s) into ' + outDir + '\n');
    process.stdout.write('  input:    ' + absoluteInput + '\n');
    process.stdout.write('  seed:     ' + seed + '\n');
    process.stdout.write('  count:    ' + count + ' row(s) per table\n');
    process.stdout.write('  mode:     ' + mode + (args.relations ? ' (--relations)' : ' (nested documents)') + '\n');
    for (const view of data.views) {
        process.stdout.write('  table:    ' + view.name + ' — ' + view.rows.length + ' row(s)\n');
    }
    process.stdout.write('  negatives: ' + data.negatives.length + ' case(s)\n');
    if (formats.includes('sql') && mode !== 'relational') {
        process.stdout.write('  note:     the SQL export always uses the relational projection\n');
    }
    if (data.warnings.length > 0) {
        process.stdout.write('  warnings:\n');
        for (const warning of data.warnings)
            process.stdout.write('    - ' + warning + '\n');
    }
    return 0;
}
/** validate: can the document be parsed and are all its references resolvable? */
function commandValidate(args) {
    const input = requireOption(args.input, '--input');
    const absoluteInput = resolvePath(input);
    const project = loadProject(absoluteInput);
    const problems = [];
    let references = 0;
    for (const doc of project.docs) {
        for (const ref of collectRefs(doc.doc)) {
            references++;
            const resolved = project.resolver.resolve(ref, doc.file, false);
            if (!resolved) {
                problems.push(doc.file + ': cannot resolve $ref "' + ref + '"' + reasonFor(project.resolver, doc.file, ref));
            }
        }
    }
    process.stdout.write('Validating ' + absoluteInput + '\n');
    process.stdout.write('\nDocuments (' + project.docs.length + '):\n');
    for (const doc of project.docs) {
        process.stdout.write('  ' + doc.kind.padEnd(12) + doc.file + '\n');
    }
    process.stdout.write('\nNamed schemas (' + project.named.length + '):\n');
    for (const entry of project.named) {
        process.stdout.write('  ' +
            entry.name.padEnd(24) +
            entry.origin.padEnd(20) +
            entry.file +
            (entry.pointer === '' ? '#' : '#' + entry.pointer));
        process.stdout.write('\n');
    }
    process.stdout.write('\nReferences: ' + references + ' checked\n');
    if (problems.length === 0) {
        process.stdout.write('Result: OK — every $ref resolves.\n');
        return 0;
    }
    process.stdout.write('Result: FAILED — ' + problems.length + ' unresolved $ref(s):\n');
    for (const problem of problems)
        process.stdout.write('  - ' + problem + '\n');
    return 1;
}
/** The reason the resolver recorded for a failed reference. */
function reasonFor(resolver, file, ref) {
    for (const warning of resolver.warnings) {
        if (warning.includes(ref))
            return ' (' + warning.trim() + ')';
    }
    return '';
}
/** inspect: what tables, columns and relations does the document describe? */
function commandInspect(args) {
    const input = requireOption(args.input, '--input');
    const absoluteInput = resolvePath(input);
    const project = loadProject(absoluteInput);
    const model = project.model;
    const root = project.docs[0];
    process.stdout.write('Inspecting ' + absoluteInput + '\n');
    process.stdout.write('\nDocument kind: ' + (root ? root.kind : 'unknown'));
    if (root && root.kind === 'openapi' && typeof root.doc?.openapi === 'string') {
        process.stdout.write(' (OpenAPI ' + root.doc.openapi + ')');
    }
    process.stdout.write('\n');
    process.stdout.write('Documents loaded (' + project.docs.length + '):\n');
    for (const doc of project.docs) {
        process.stdout.write('  ' + doc.kind.padEnd(12) + doc.file + '\n');
    }
    process.stdout.write('\nTables (' + model.tables.size + '):\n');
    for (const name of model.order) {
        const table = model.tables.get(name);
        if (!table)
            continue;
        process.stdout.write('  ' + table.name + '  [primary key: ' + table.primaryKey.property + ' (' + table.primaryKey.type + ')' + (table.primaryKey.synthetic ? ', synthesised' : '') + ']\n');
        process.stdout.write('    source: ' + table.file + (table.pointer === '' ? '#' : '#' + table.pointer) + '\n');
        process.stdout.write('    columns:\n');
        for (const column of table.columns) {
            let line = '      ' +
                column.name.padEnd(20) +
                column.type.padEnd(10) +
                (column.format ?? '-').padEnd(12) +
                (column.required ? 'required' : 'optional') +
                (column.nullable ? ', nullable' : '');
            if (column.fk) {
                line += ' -> ' + column.fk.target + '.' + column.fk.targetProperty;
            }
            else if (column.idListOf) {
                line += ' (list of ' + column.idListOf + ' ids)';
            }
            process.stdout.write(line + '\n');
        }
        if (table.foreignKeys.length === 0) {
            process.stdout.write('    foreign keys: none\n');
        }
        else {
            process.stdout.write('    foreign keys:\n');
            for (const fk of table.foreignKeys) {
                process.stdout.write('      ' + fk.property + ' -> ' + fk.target + '.' + fk.targetProperty + ' (' + fk.type + ')' + (fk.required ? ', required' : ', optional') + '\n');
            }
        }
    }
    process.stdout.write('\nRelations:\n');
    if (model.oneToMany.length === 0) {
        process.stdout.write('  one-to-many: none\n');
    }
    else {
        for (const relation of model.oneToMany) {
            process.stdout.write('  one-to-many: ' +
                relation.parent +
                '.' +
                relation.collectionProperty +
                ' -> ' +
                relation.child +
                '.' +
                relation.backReferenceProperty +
                '\n');
        }
    }
    if (model.manyToMany.length === 0) {
        process.stdout.write('  many-to-many: none\n');
    }
    else {
        for (const relation of model.manyToMany) {
            process.stdout.write('  many-to-many: ' +
                relation.left +
                ' <- ' +
                relation.join +
                '.' +
                relation.leftProperty +
                '/' +
                relation.rightProperty +
                ' -> ' +
                relation.right +
                '\n');
        }
    }
    process.stdout.write('  cycles: ' + (model.cycles.length === 0 ? 'none' : JSON.stringify(model.cycles)) + '\n');
    const warnings = [...model.warnings, ...project.resolver.warnings];
    if (warnings.length > 0) {
        process.stdout.write('\nWarnings (' + warnings.length + '):\n');
        for (const warning of warnings)
            process.stdout.write('  - ' + warning + '\n');
    }
    return 0;
}
/** Read a required option. */
function requireOption(value, name) {
    if (!value)
        throw new SchemaSeedError('<args>', name + ' is required');
    return value;
}
/** The help text. */
function printHelp() {
    process.stdout.write([
        'schemaseed — deterministic seed data from an OpenAPI 3.x or JSON Schema document.',
        '',
        'Usage:',
        '  schemaseed generate --input <file> --out <dir> [options]',
        '  schemaseed validate --input <file>',
        '  schemaseed inspect  --input <file>',
        '',
        'generate options:',
        '  --input, -i <file>     the schema document to read (required)',
        '  --out, -o <dir>        where the generated files are written (required)',
        '  --formats, -f <list>   comma separated: ' + FORMATS.join(', ') + ' (default: all)',
        '  --count, -n <n>        rows per table (default: 10)',
        '  --seed, -s <seed>      seed for the generator (default: derived from the input)',
        '  --relations, -r        export the flattened relational tables instead of',
        '                         nested documents (the SQL export is always relational)',
        '',
        'validate reports every $ref that cannot be resolved.',
        'inspect prints the tables, columns, primary keys and foreign keys.',
        '',
    ].join('\n'));
}
process.exitCode = main(process.argv.slice(2));
