// console.log formatting for the output pane: strings as they are, everything else the way Node prints it (objects over lines, depth-limited).

const MAX_WIDTH = 76;

export function inspect(value: unknown, depth = 3, seen = new Set<unknown>(), indent = 0): string {
    if (typeof value === 'string') return indent === 0 && depth === 3 ? value : `'${value.replace(/'/g, "\\'")}'`;
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
    if (value instanceof Error) {
        const extra = Object.entries(value).filter(([k]) => k !== 'stack' && k !== 'message' && k !== 'name');
        const head = `${value.name}: ${value.message}`;
        return extra.length ? `${head} ${inspect(Object.fromEntries(extra), depth - 1, seen, indent)}` : head;
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Response) return `Response { status: ${value.status} }`;
    if (seen.has(value)) return '[Circular]';
    if (depth < 0) return Array.isArray(value) ? '[Array]' : '[Object]';
    seen.add(value);
    const pad = ' '.repeat(indent + 2);
    const end = ' '.repeat(indent);
    let parts: string[];
    let open: string;
    let close: string;
    if (Array.isArray(value)) {
        open = '[';
        close = ']';
        parts = value.slice(0, 100).map((v) => inspect(v, depth - 1, seen, indent + 2));
        if (value.length > 100) parts.push(`... ${value.length - 100} more items`);
    } else if (value instanceof Map) {
        open = 'Map(' + value.size + ') {';
        close = '}';
        parts = [...value].map(([k, v]) => `${inspect(k, depth - 1, seen, indent + 2)} => ${inspect(v, depth - 1, seen, indent + 2)}`);
    } else if (value instanceof Set) {
        open = 'Set(' + value.size + ') {';
        close = '}';
        parts = [...value].map((v) => inspect(v, depth - 1, seen, indent + 2));
    } else {
        const name = (value as object).constructor?.name;
        open = name && name !== 'Object' ? `${name} {` : '{';
        close = '}';
        parts = Object.entries(value as object).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${inspect(v, depth - 1, seen, indent + 2)}`);
    }
    seen.delete(value);
    if (!parts.length) return `${open}${close}`.replace('{}', '{}');
    const one = `${open} ${parts.join(', ')} ${close}`;
    if (one.length <= MAX_WIDTH && !one.includes('\n')) return one;
    return `${open}\n${parts.map((p) => `${pad}${p}`).join(',\n')}\n${end}${close}`;
}

/** console.log's arguments as one line (or block): strings joined as they are, other values inspected. */
export const format = (args: unknown[]): string => args.map((a) => inspect(a)).join(' ');
