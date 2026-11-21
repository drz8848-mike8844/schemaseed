/**
 * A tiny regular expression sampler.
 *
 * The generator has to produce strings that match a schema's "pattern"
 * keyword, otherwise every positive sample would fail validation. Full regex
 * semantics are out of scope, so this module supports the subset that shows up
 * in real API schemas:
 *
 *   literals, ".", character classes ([a-z], [^0-9]), escapes (\d \w \s and
 *   their negations), groups, non-capturing groups, alternation, anchors,
 *   and the quantifiers ?, *, +, {n}, {n,m}.
 *
 * The parser also reports the minimum and maximum length a match can have,
 * which lets the constraint analyser detect contradictory schemas such as
 * "pattern that can only match 6 characters" together with "maxLength: 3".
 */
/** Parse errors are reported by returning null. */
class PatternError extends Error {
}
const DIGITS = '0123456789';
const WORD = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';
const SPACES = ' \t\n\r\f\v';
class Parser {
    source;
    pos = 0;
    constructor(source) {
        this.source = source;
    }
    parse() {
        const node = this.parseAlternation();
        if (this.pos !== this.source.length) {
            throw new PatternError('unexpected character at ' + this.pos);
        }
        return node;
    }
    peek() {
        return this.source[this.pos];
    }
    parseAlternation() {
        const options = [this.parseSequence()];
        while (this.peek() === '|') {
            this.pos++;
            options.push(this.parseSequence());
        }
        if (options.length === 1)
            return options[0];
        return { kind: 'alt', options };
    }
    parseSequence() {
        const items = [];
        for (;;) {
            const c = this.peek();
            if (c === undefined || c === '|' || c === ')')
                break;
            items.push(this.parseTerm());
        }
        if (items.length === 1)
            return items[0];
        return { kind: 'seq', items };
    }
    parseTerm() {
        const atom = this.parseAtom();
        const c = this.peek();
        if (c === '*') {
            this.pos++;
            return { kind: 'repeat', node: atom, min: 0, max: 5 };
        }
        if (c === '+') {
            this.pos++;
            return { kind: 'repeat', node: atom, min: 1, max: 5 };
        }
        if (c === '?') {
            this.pos++;
            return { kind: 'repeat', node: atom, min: 0, max: 1 };
        }
        if (c === '{') {
            const match = /^\{(\d+)(?:,(\d*)?)?\}/.exec(this.source.slice(this.pos));
            if (match) {
                this.pos += match[0].length;
                const min = Number(match[1]);
                const max = match[2] === undefined ? min : match[2] === '' ? min + 5 : Number(match[2]);
                return { kind: 'repeat', node: atom, min, max };
            }
        }
        return atom;
    }
    parseAtom() {
        const c = this.peek();
        if (c === undefined)
            throw new PatternError('unexpected end of pattern');
        if (c === '^' || c === '$') {
            this.pos++;
            return { kind: 'anchor' };
        }
        if (c === '.') {
            this.pos++;
            return { kind: 'any' };
        }
        if (c === '(') {
            this.pos++;
            if (this.source.startsWith('?:', this.pos))
                this.pos += 2;
            else if (this.source.startsWith('?', this.pos))
                throw new PatternError('unsupported group');
            const inner = this.parseAlternation();
            if (this.peek() !== ')')
                throw new PatternError('unbalanced group');
            this.pos++;
            return inner;
        }
        if (c === '[')
            return this.parseClass();
        if (c === '\\')
            return this.parseEscape();
        if (c === ')' || c === '|' || c === '*' || c === '+' || c === '?') {
            throw new PatternError('unexpected quantifier');
        }
        this.pos++;
        return { kind: 'literal', text: c };
    }
    parseEscape() {
        this.pos++;
        const c = this.peek();
        if (c === undefined)
            throw new PatternError('dangling backslash');
        this.pos++;
        switch (c) {
            case 'd':
                return { kind: 'char', chars: DIGITS.split('') };
            case 'D':
                return { kind: 'char', chars: (WORD + ' ').split('') };
            case 'w':
                return { kind: 'char', chars: WORD.split('') };
            case 'W':
                return { kind: 'char', chars: ('-.' + SPACES).split('') };
            case 's':
                return { kind: 'char', chars: SPACES.split('') };
            case 'S':
                return { kind: 'char', chars: 'abcXYZ019'.split('') };
            case 'n':
                return { kind: 'literal', text: '\n' };
            case 't':
                return { kind: 'literal', text: '\t' };
            case 'r':
                return { kind: 'literal', text: '\r' };
            default:
                return { kind: 'literal', text: c };
        }
    }
    parseClass() {
        this.pos++;
        let negated = false;
        if (this.peek() === '^') {
            negated = true;
            this.pos++;
        }
        const chars = [];
        let first = true;
        for (;;) {
            const c = this.peek();
            if (c === undefined)
                throw new PatternError('unterminated character class');
            if (c === ']' && !first) {
                this.pos++;
                break;
            }
            first = false;
            if (c === '\\') {
                const escaped = this.parseEscape();
                if (escaped.kind === 'char')
                    chars.push(...escaped.chars);
                else if (escaped.kind === 'literal')
                    chars.push(escaped.text);
                continue;
            }
            this.pos++;
            // A range such as a-z.
            if (this.peek() === '-' && this.source[this.pos + 1] !== ']' && this.source[this.pos + 1] !== undefined) {
                this.pos++;
                const end = this.peek();
                this.pos++;
                const startCode = c.charCodeAt(0);
                const endCode = end.charCodeAt(0);
                if (endCode < startCode)
                    throw new PatternError('invalid range');
                for (let code = startCode; code <= endCode; code++) {
                    chars.push(String.fromCharCode(code));
                }
                continue;
            }
            chars.push(c);
        }
        if (negated) {
            const excluded = new Set(chars);
            const allowed = (WORD + DIGITS + SPACES + '-_./:@#').split('').filter((ch) => !excluded.has(ch));
            return { kind: 'char', chars: allowed };
        }
        if (chars.length === 0)
            throw new PatternError('empty character class');
        return { kind: 'char', chars };
    }
}
/** Minimum and maximum length of a parsed pattern. */
function measure(node) {
    switch (node.kind) {
        case 'seq': {
            let min = 0;
            let max = 0;
            for (const item of node.items) {
                const m = measure(item);
                min += m.min;
                max += m.max;
            }
            return { min, max };
        }
        case 'alt': {
            let min = Number.POSITIVE_INFINITY;
            let max = 0;
            for (const option of node.options) {
                const m = measure(option);
                min = Math.min(min, m.min);
                max = Math.max(max, m.max);
            }
            return { min, max };
        }
        case 'repeat': {
            const m = measure(node.node);
            return { min: m.min * node.min, max: m.max * node.max };
        }
        case 'char':
            return { min: 1, max: 1 };
        case 'literal':
            return { min: node.text.length, max: node.text.length };
        case 'any':
            return { min: 1, max: 1 };
        case 'anchor':
            return { min: 0, max: 0 };
    }
}
/** Parse a pattern. Returns null when the pattern uses unsupported syntax. */
export function analyzePattern(pattern) {
    try {
        const root = new Parser(pattern).parse();
        const bounds = measure(root);
        return { root, minLength: bounds.min, maxLength: bounds.max };
    }
    catch {
        return null;
    }
}
/** Render a parsed pattern into a matching string. */
export function samplePattern(info, rng) {
    const render = (node) => {
        switch (node.kind) {
            case 'seq':
                return node.items.map(render).join('');
            case 'alt':
                return render(rng.pick(node.options));
            case 'repeat': {
                const count = node.min === node.max ? node.min : rng.nextInt(node.min, node.max);
                let out = '';
                for (let i = 0; i < count; i++)
                    out += render(node.node);
                return out;
            }
            case 'char':
                return rng.pick(node.chars);
            case 'literal':
                return node.text;
            case 'any':
                return rng.pick('abcdefghijklmnopqrstuvwxyz0123456789'.split(''));
            case 'anchor':
                return '';
        }
    };
    return render(info.root);
}
