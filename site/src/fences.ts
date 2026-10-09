// The code blocks of a docs page. A ```ts block is an editor; its info string says how it behaves:
//
//   ```ts run title="Rent a droplet"   an editor with a Run button: executed in the sandbox (and by `npm run check`)
//   ```ts                              an editor with completions; type-checked by `npm run check`
//   ```ts error                        an editor that must have a type error: what the compiler refuses (checked: it does fail)
//   ```ts static                       highlighted only: pseudo-code, or a fragment that is not a program
//   ```bash / ```json / ...            highlighted only
//
// Shared by the site (which renders them) and by the check (which compiles and runs them), so what the page shows is what was verified.

export type Fence = {
    /** `<page>#<n>`, n counting the page's blocks from 1. */
    id: string,
    lang: string,
    flags: Set<string>,
    attrs: Record<string, string>,
    code: string,
};

/** What a ts block's flags make of it. */
export type SnippetKind = 'run' | 'edit' | 'error' | 'static';

export function parseInfo(info: string): { lang: string, flags: Set<string>, attrs: Record<string, string> } {
    const attrs: Record<string, string> = {};
    const rest = info.replace(/(\w+)="([^"]*)"/g, (_m, k: string, v: string) => {
        attrs[k] = v;
        return '';
    });
    const [lang = '', ...flags] = rest.trim().split(/\s+/).filter(Boolean);
    return { lang, flags: new Set(flags), attrs };
}

export function kindOf(f: Pick<Fence, 'lang' | 'flags'>): SnippetKind {
    if (f.lang !== 'ts' && f.lang !== 'typescript') return 'static';
    if (f.flags.has('static')) return 'static';
    if (f.flags.has('error')) return 'error';
    if (f.flags.has('run')) return 'run';
    return 'edit';
}

/** Every fenced block of a markdown source, in order. */
export function fencesOf(page: string, markdown: string): Fence[] {
    const out: Fence[] = [];
    const re = /^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm;
    for (let m = re.exec(markdown); m; m = re.exec(markdown)) {
        out.push({ id: `${page}#${out.length + 1}`, ...parseInfo(m[1]), code: m[2].replace(/\n$/, '') });
    }
    return out;
}
