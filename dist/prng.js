/**
 * Deterministic pseudo random numbers.
 *
 * Everything random in SchemaSeed comes from here. Two rules make the output
 * reproducible:
 *
 *   1. There is exactly one seed. Same seed + same input => same bytes.
 *   2. Randomness is *addressed*, not sequential. A value is drawn from a
 *      sub-stream keyed by the structural path that produced it
 *      ("Order.items[2].sku"), so reordering properties in the source document
 *      never changes the values that are produced.
 */
/** 64 bit mask. */
const MASK64 = (1n << 64n) - 1n;
/** The golden ratio constant used by splitmix64. */
const GAMMA = 0x9e3779b97f4a7c15n;
/**
 * splitmix64 — small, fast, and well distributed. State is a single 64 bit
 * integer; every draw is a pure function of (state, state + gamma).
 */
export class SplitMix64 {
    state;
    constructor(seed) {
        this.state = seed & MASK64;
    }
    /** Next uniformly distributed 64 bit integer. */
    nextUint64() {
        this.state = (this.state + GAMMA) & MASK64;
        let z = this.state;
        z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
        z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
        return (z ^ (z >> 31n)) & MASK64;
    }
    /** Next float in [0, 1). */
    nextFloat() {
        // 53 significant bits -> exactly representable.
        return Number(this.nextUint64() >> 11n) / 9007199254740992;
    }
    /** Next integer in [min, max] (inclusive). */
    nextInt(min, max) {
        if (max < min) {
            const tmp = min;
            min = max;
            max = tmp;
        }
        const span = BigInt(max - min + 1);
        return min + Number(this.nextUint64() % span);
    }
    /** Pick one element of a non-empty array. */
    pick(items) {
        if (items.length === 0) {
            throw new Error('cannot pick from an empty array');
        }
        return items[this.nextInt(0, items.length - 1)];
    }
    /** True with the given probability (default 0.5). */
    bool(probability = 0.5) {
        return this.nextFloat() < probability;
    }
}
/**
 * FNV-1a 64 bit hash of a string, used to turn a structural path into a seed.
 * Implemented here (rather than with node:crypto) so the hash is explicit,
 * dependency free and identical on every platform.
 */
export function fnv1a64(text, seed = 0xcbf29ce484222325n) {
    let hash = seed & MASK64;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        // Mix the UTF-16 code unit byte-wise so the hash does not depend on the
        // platform's text encoding.
        hash ^= BigInt(code & 0xff);
        hash = (hash * 0x100000001b3n) & MASK64;
        hash ^= BigInt((code >> 8) & 0xff);
        hash = (hash * 0x100000001b3n) & MASK64;
    }
    return hash;
}
/** Mix two 64 bit values (splitmix64 finalizer). */
export function mix64(a, b) {
    let z = (a ^ (b + GAMMA)) & MASK64;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
}
/**
 * Addressed randomness.
 *
 * `stream(path)` returns an independent generator for that structural path.
 * Two calls with the same path return generators in the same state, no matter
 * how many other streams were created in between.
 */
export class PathRng {
    seed;
    cache = new Map();
    constructor(seed) {
        this.seed = BigInt(seed) & MASK64;
    }
    /** The root seed. */
    get rootSeed() {
        return this.seed;
    }
    /** An independent generator for the given structural path. */
    stream(path) {
        const cached = this.cache.get(path);
        if (cached)
            return cached;
        const rng = new SplitMix64(mix64(this.seed, fnv1a64(path)));
        this.cache.set(path, rng);
        return rng;
    }
    /** A generator for a path built from parts, e.g. ["Order", "items", "2"]. */
    streamOf(...parts) {
        return this.stream(parts.join('.'));
    }
}
/**
 * Derive a seed from arbitrary content. Used when the user does not pass
 * --seed: the seed then depends on the input bytes, so the same document always
 * produces the same data even across machines.
 */
export function seedFromContent(content) {
    const hash = fnv1a64(content, 0x84222325cbf29ce4n);
    // Fold to 53 bits so it survives a JSON round trip without precision loss.
    return Number(hash & 0x1fffffffffffffn);
}
/** Turn a user supplied seed (string or number) into a 64 bit integer. */
export function normalizeSeed(seed, fallbackContent) {
    if (seed === undefined || seed === null || seed === '') {
        return fallbackContent === undefined ? 0 : seedFromContent(fallbackContent);
    }
    if (typeof seed === 'number') {
        if (!Number.isFinite(seed)) {
            throw new Error('seed must be a finite number');
        }
        return Math.trunc(seed);
    }
    const trimmed = seed.trim();
    if (/^-?\d+$/.test(trimmed)) {
        const asNumber = Number(trimmed);
        if (!Number.isSafeInteger(asNumber)) {
            throw new Error('seed "' + seed + '" is out of the safe integer range');
        }
        return asNumber;
    }
    return seedFromContent(trimmed);
}
