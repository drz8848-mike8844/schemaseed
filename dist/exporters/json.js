/**
 * JSON exporter.
 *
 * One file per table holding a JSON array of rows. In relational mode the rows
 * are flat (one object per row); the nested view is written next to them as
 * "nested.json", where parents hold their children again.
 */
import { jsonText, slug } from './common.js';
export function exportJson(data) {
    const files = [];
    for (const view of data.views) {
        files.push({
            path: 'json/' + slug(view.name) + '.json',
            content: jsonText(view.rows),
        });
    }
    if (data.mode === 'relational' && data.nestedExpanded.length > 0) {
        const nested = data.nestedExpanded.flatMap((view) => view.rows);
        files.push({ path: 'json/nested.json', content: jsonText(nested) });
    }
    return files;
}
