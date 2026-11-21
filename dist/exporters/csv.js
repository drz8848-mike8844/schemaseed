/**
 * CSV exporter.
 *
 * One file per table (relational mode) or one file per root schema (nested
 * mode). Nested values are written as JSON inside the cell.
 */
import { csvCell, slug } from './common.js';
export function exportCsv(data) {
    const files = [];
    for (const view of data.views) {
        const columns = columnNames(view);
        const lines = [columns.map(csvCell).join(',')];
        for (const row of view.rows) {
            lines.push(columns.map((column) => csvCell(row[column])).join(','));
        }
        files.push({
            path: 'csv/' + slug(view.name) + '.csv',
            content: lines.join('\n') + '\n',
        });
    }
    return files;
}
/** The columns of a table: the schema properties first, then anything extra. */
function columnNames(view) {
    const names = [];
    const properties = (view.schema.properties ?? {});
    for (const property of Object.keys(properties)) {
        if (view.rows.some((row) => property in row))
            names.push(property);
    }
    for (const row of view.rows) {
        for (const property of Object.keys(row)) {
            if (!names.includes(property))
                names.push(property);
        }
    }
    return names;
}
