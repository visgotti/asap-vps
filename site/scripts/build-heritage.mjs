// What each provider class inherits, read from the library's source with the TypeScript compiler (so the page cannot drift from the code):
// its chain of base classes (with their type arguments), the interfaces each class implements, the API client's own chain, and for every
// capability the provider declares: the interface and which class supplies each of its methods (the provider itself, or ComputeProvider).

import { createRequire } from 'node:module';
import path from 'node:path';
import { ROOT } from '../esbuild.shared.mjs';

const require = createRequire(path.join(ROOT, 'package.json'));
const ts = require('typescript');

// provider id -> the class and the file it is in
const CLASSES = {
    digitalocean: ['DigitalOcean', 'src/Providers/DigitalOcean/DigitalOcean.ts'],
    scaleway: ['Scaleway', 'src/Providers/Scaleway/Scaleway.ts'],
    lambda: ['LambdaCloud', 'src/Providers/LambdaCloud/LambdaCloud.ts'],
    runpod: ['RunPod', 'src/Providers/RunPod/RunPod.ts'],
    vast: ['VastAI', 'src/Providers/VastAI/VastAI.ts'],
};

/** @param {Record<string, { capabilities: Record<string, unknown> }>} caps what each provider declares (capabilities.json) */
export function buildHeritage(caps) {
    const cfg = ts.getParsedCommandLineOfConfigFile(path.join(ROOT, 'tsconfig.build.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
    const program = ts.createProgram(Object.values(CLASSES).map(([, f]) => path.join(ROOT, f)).concat(path.join(ROOT, 'src/capabilities.ts')), cfg.options);
    const checker = program.getTypeChecker();
    const rel = (sf) => path.relative(ROOT, sf.fileName).split(path.sep).join('/');

    const classIn = (file, name) => {
        const sf = program.getSourceFile(path.join(ROOT, file));
        const found = sf?.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === name);
        if (!found) throw new Error(`heritage: no class ${name} in ${file}`);
        return found;
    };
    const resolve = (expr) => {
        let sym = checker.getSymbolAtLocation(expr);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        return sym?.declarations?.find((d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d));
    };
    const isAbstract = (d) => !!d.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword);
    const text = (n) => n.getText().replace(/\s+/g, ' ');
    const summary = (d) => ts.displayPartsToString(checker.getSymbolAtLocation(d.name)?.getDocumentationComment(checker) ?? []).split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();

    /** The class, then each base class up, with what each extends and implements as written. */
    const chainOf = (decl) => {
        const chain = [];
        for (let d = decl; d;) {
            const ext = d.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
            const impl = d.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ImplementsKeyword)?.types ?? [];
            chain.push({
                name: d.name.text, abstract: isAbstract(d), file: rel(d.getSourceFile()), summary: summary(d),
                typeParams: d.typeParameters?.map(text) ?? [],
                extends: ext ? text(ext) : null,
                implements: impl.map(text),
            });
            d = ext ? resolve(ext.expression) : undefined;
        }
        return chain;
    };

    // The interface each capability name stands for.
    const capsIface = program.getSourceFile(path.join(ROOT, 'src/capabilities.ts')).statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === 'CapabilityInterfaces');
    const ifaceOf = Object.fromEntries(capsIface.members.map((m) => [m.name.getText(), m.type.typeName.getText()]));
    const ifaceDecl = (name) => program.getSourceFile(path.join(ROOT, 'src/capabilities.ts')).statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === name);

    const out = {};
    for (const [id, [cls, file]] of Object.entries(CLASSES)) {
        const decl = classIn(file, cls);
        const chain = chainOf(decl);
        const type = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(decl.name));
        const props = new Map(checker.getPropertiesOfType(type).map((p) => [p.name, p]));
        // The API client is the class's `api` property's type: its own chain.
        const apiDecl = resolve(decl.heritageClauses.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword).types[0].typeArguments.at(-1).typeName ?? decl.name);

        const capabilities = Object.keys(caps[id].capabilities).map((c) => {
            const iface = ifaceDecl(ifaceOf[c]);
            const methods = iface.members.filter((m) => m.name && ts.isMethodSignature(m)).map((m) => {
                const name = m.name.getText();
                const impl = props.get(name)?.valueDeclaration;
                const owner = impl?.parent && ts.isClassDeclaration(impl.parent) ? impl.parent.name.text : cls;
                return { name, from: owner, own: owner === cls, abstract: !!impl && isAbstract(impl), summary: summary(m) };
            });
            return { name: c, interface: text(capsIface.members.find((m) => m.name.getText() === c).type), methods };
        });

        // What the base classes give every provider: their public members.
        const inherited = chain.slice(1).map((c) => {
            const d = resolveByName(c.name);
            return {
                name: c.name, abstract: c.abstract,
                members: d.members.filter((m) => m.name && !m.modifiers?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword)
                    && !ts.isConstructorDeclaration(m)).map((m) => ({
                    name: m.name.getText(), kind: ts.isMethodDeclaration(m) ? 'method' : ts.isGetAccessor(m) ? 'getter' : 'property',
                    abstract: isAbstract(m), protected: !!m.modifiers?.some((x) => x.kind === ts.SyntaxKind.ProtectedKeyword),
                    // a member the provider class declares itself overrides the base's
                    overridden: decl.members.some((x) => x.name?.getText() === m.name.getText()),
                })),
            };
        });
        out[id] = {
            class: cls, file, chain, capabilities, inherited,
            api: chainOf(apiDecl).map((c) => ({ name: c.name, extends: c.extends, file: c.file, summary: c.summary })),
        };
    }

    function resolveByName(name) {
        for (const sf of program.getSourceFiles()) {
            const d = sf.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === name);
            if (d && !sf.fileName.includes('node_modules')) return d;
        }
        throw new Error(`heritage: no class ${name}`);
    }
    return out;
}
