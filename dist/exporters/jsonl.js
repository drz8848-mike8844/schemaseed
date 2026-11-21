/**
 * JSON Lines exporter.
 *
 * One file per table, one JSON object per line. Handy for streaming into
 * anything that reads newline delimited JSON.
 */
import { jsonLine, slug } from './common.js';
export function exportJsonl(data) {
    const files = [];
    for (const view of data.views) {
        const lines = view.rows.map((row) => jsonLine(row));
        files.push({
            path: 'jsonl/' + slug(view.name) + '.jsonl',
            content: lines.length === 0 ? '' : lines.join('\n') + '\n',
        });
    }
    if (data.mode === 'relational' && data.nestedExpanded.length > 0) {
        const nested = data.nestedExpanded.flatMap((view) => view.rows);
        const lines = nested.map((row) => jsonLine(row));
        files.push({
            path: 'jsonl/nested.jsonl',
            content: lines.length === 0 ? '' : lines.join('\n') + '\n',
        });
    }
    return files;
}
