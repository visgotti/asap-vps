// The first-boot script that runs a container on a VM, read as text and run
// for real: bash, with stand-ins for docker, apt-get and systemctl (and
// nvidia-smi and nvidia-ctk) on a PATH that holds nothing else, so what each
// was called with is exactly what a machine would run.

import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ContainerSpec } from '../../types';
import { cloudInitParts, containerBootScript, shellQuote, VM_CONTAINER_ENV_FILE, VM_CONTAINER_NAME, withUserData } from './container';

const ENV_DIR = VM_CONTAINER_ENV_FILE.replace(/\/[^/]+$/, '');

type Machine = {
    /** Docker is installed already (else apt-get "installs" it). */
    docker?: boolean,
    /** An NVIDIA driver (nvidia-smi), and the container toolkit (nvidia-ctk). */
    nvidia?: 'driver' | 'driver+toolkit',
    /** The docker subcommand that fails (exit 1). */
    failing?: string,
};

/**
 * Runs `script` on a stand-in machine: each command it calls, one line each
 * (`docker [run] [-d] ...`, a login's stdin as `stdin [...]`), the env file it
 * wrote (with its mode), and its exit status and stderr.
 */
function runOn(script: string, m: Machine = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'asap-vps-boot-'));
    try {
        const bin = join(dir, 'bin');
        const log = join(dir, 'calls.log');
        mkdirSync(bin);
        writeFileSync(log, '');
        // The tools the script uses that are not bash builtins, from this machine; nothing else is on the PATH.
        for (const tool of ['cat', 'cp', 'seq', 'mkdir', 'sleep', 'ls']) {
            symlinkSync(execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), join(bin, tool));
        }
        const stub = (name: string, body = '') => {
            writeFileSync(join(bin, name), `#!/bin/bash\n{ printf '%s' ${name}; for a in "$@"; do printf ' [%s]' "$a"; done; echo; } >> ${shellQuote(log)}\n${body}\n`);
            chmodSync(join(bin, name), 0o755);
        };
        const docker = `if [ "$1" = login ]; then printf 'stdin [%s]\\n' "$(cat)" >> ${shellQuote(log)}; fi\n`
            + `if [ "$1" = ${shellQuote(m.failing ?? 'none')} ]; then echo "docker $1 failed" >&2; exit 1; fi`;
        if (m.docker !== false) stub('docker', docker);
        // Installing docker.io puts docker on the PATH.
        writeFileSync(join(dir, 'docker.stub'), '');
        stub('apt-get', `case " $* " in *" docker.io "*) cp ${shellQuote(join(dir, 'docker.stub'))} ${shellQuote(join(bin, 'docker'))};; esac`);
        if (m.docker === false) {
            writeFileSync(join(dir, 'docker.stub'), `#!/bin/bash\n{ printf '%s' docker; for a in "$@"; do printf ' [%s]' "$a"; done; echo; } >> ${shellQuote(log)}\n${docker}\n`);
            chmodSync(join(dir, 'docker.stub'), 0o755);
        }
        stub('systemctl');
        if (m.nvidia) stub('nvidia-smi');
        if (m.nvidia === 'driver+toolkit') stub('nvidia-ctk');
        const envDir = join(dir, 'etc-asap-vps');
        const path = join(dir, 'boot.sh');
        writeFileSync(path, script.split(ENV_DIR).join(envDir));
        let status = 0;
        let stderr = '';
        try {
            execFileSync('/bin/bash', [path], { env: { PATH: bin }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            status = (e as { status: number }).status;
            stderr = String((e as { stderr: string }).stderr);
        }
        const envFile = join(envDir, VM_CONTAINER_ENV_FILE.slice(ENV_DIR.length + 1));
        let env: { text: string, mode: number } | undefined;
        try {
            env = { text: readFileSync(envFile, 'utf8'), mode: statSync(envFile).mode & 0o777 };
        } catch {
            env = undefined;
        }
        return { calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), env, envFile, status, stderr };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('shellQuote: one word of a POSIX shell command', () => {
    it.each([
        ['plain', `'plain'`],
        ['two words', `'two words'`],
        [`it's`, `'it'\\''s'`],
        ['$HOME `id` "x"', `'$HOME \`id\` "x"'`],
        ['', `''`],
    ])('%j -> %s', (s, quoted) => {
        expect(shellQuote(s)).toBe(quoted);
    });

    it('reaches a command as the very same word', () => {
        for (const s of [`it's`, '$HOME `id` "x" \\ ;|&', '  spaced  ', '']) {
            expect(execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(s)}`], { encoding: 'utf8' })).toBe(s);
        }
    });
});

describe('containerBootScript: a container on a VM, run at the first boot', () => {
    const spec: ContainerSpec = {
        image: 'ghcr.io/acme/app:1',
        env: { MODE: 'serve', QUOTED: `it's "x" $HOME`, EMPTY: '' },
        command: ['sh', '-c', `echo "it's $MODE"`],
        ports: ['8000/tcp', '9000/udp', '7860/http', '22'],
    };

    it('runs the image as the container asap-vps, restarted with the machine: its command, ports and env, each value one word', () => {
        const r = runOn(containerBootScript(spec, { gpu: false }));
        expect(r.status).toBe(0);
        expect(r.calls).toEqual([
            'systemctl [enable] [--now] [docker]',
            'docker [pull] [ghcr.io/acme/app:1]',
            `docker [rm] [-f] [${VM_CONTAINER_NAME}]`,
            `docker [run] [-d] [--name] [asap-vps] [--restart] [unless-stopped] [--env-file] [${r.envFile}] `
            + '[-p] [8000:8000/tcp] [-p] [9000:9000/udp] [-p] [7860:7860/tcp] [-p] [22:22/tcp] '
            + `[ghcr.io/acme/app:1] [sh] [-c] [echo "it's $MODE"]`,
        ]);
        // Docker reads an env file as it is: no quotes, no expansion.
        expect(r.env).toEqual({ text: `MODE=serve\nQUOTED=it's "x" $HOME\nEMPTY=\n`, mode: 0o600 });
    });

    it('logs in with the password on stdin only, pulls, and logs out again', () => {
        const auth = { username: 'nologin', password: `s3cret 'pass' $X`, server: 'rg.fr-par.scw.cloud' };
        const r = runOn(containerBootScript({ image: 'rg.fr-par.scw.cloud/ns/app:1', registryAuth: auth }, { gpu: false }));
        expect(r.status).toBe(0);
        expect(r.calls.slice(1, 5)).toEqual([
            'docker [login] [-u] [nologin] [--password-stdin] [rg.fr-par.scw.cloud]',
            `stdin [s3cret 'pass' $X]`,
            'docker [pull] [rg.fr-par.scw.cloud/ns/app:1]',
            'docker [logout] [rg.fr-par.scw.cloud]',
        ]);
        // No command line holds it.
        expect(r.calls.filter((c) => !c.startsWith('stdin')).join('\n')).not.toContain('s3cret');
    });

    it('logs in to the image\'s registry when the login names none', () => {
        const r = runOn(containerBootScript({ image: 'acme/private:2', registryAuth: { username: 'bot', password: 'p' } }, { gpu: false }));
        expect(r.calls[1]).toBe('docker [login] [-u] [bot] [--password-stdin] [docker.io]');
        expect(r.calls[4]).toBe('docker [logout] [docker.io]');
    });

    it('installs Docker where the image has none, and writes an empty env file for an image without env', () => {
        const r = runOn(containerBootScript({ image: 'busybox' }, { gpu: false }), { docker: false });
        expect(r.status).toBe(0);
        expect(r.calls.slice(0, 3)).toEqual([
            'apt-get [-o] [DPkg::Lock::Timeout=60] [update] [-y]',
            'apt-get [-o] [DPkg::Lock::Timeout=60] [install] [-y] [docker.io]',
            'systemctl [enable] [--now] [docker]',
        ]);
        expect(r.calls.at(-1)).toMatch(/^docker \[run\] .* \[busybox\]$/);
        expect(r.env).toEqual({ text: '', mode: 0o600 });
    });

    it('a GPU machine passes its GPUs through, with the toolkit configured for Docker; installed first where missing', () => {
        const withToolkit = runOn(containerBootScript({ image: 'nvidia/cuda:12.8.1-base-ubuntu24.04', command: ['nvidia-smi'] }, { gpu: true }), { nvidia: 'driver+toolkit' });
        expect(withToolkit.status).toBe(0);
        expect(withToolkit.calls).toContain('nvidia-ctk [runtime] [configure] [--runtime=docker]');
        expect(withToolkit.calls).toContain('systemctl [restart] [docker]');
        expect(withToolkit.calls.at(-1)).toMatch(/\[--gpus\] \[all\] \[nvidia\/cuda:12\.8\.1-base-ubuntu24\.04\] \[nvidia-smi\]$/);
        // The toolkit's install writes to the system's apt sources, so it is read here, not run.
        const script = containerBootScript({ image: 'nvidia/cuda:12.8.1-base-ubuntu24.04' }, { gpu: true });
        expect(script).toMatch(/if ! command -v nvidia-ctk[^\n]*\n[^]*apt_get install -y nvidia-container-toolkit\n {2}fi/);
        expect(script).toContain('https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list');
    });

    it('a GPU machine without a driver, or a CPU one, passes none', () => {
        const noDriver = runOn(containerBootScript({ image: 'busybox' }, { gpu: true }));
        expect(noDriver.calls.at(-1)).not.toContain('--gpus');
        expect(noDriver.calls.join('\n')).not.toContain('nvidia');
        expect(containerBootScript({ image: 'busybox' }, { gpu: false })).not.toContain('nvidia');
    });

    it('stops at the first failure: a pull that fails runs nothing', () => {
        const r = runOn(containerBootScript({ image: 'busybox' }, { gpu: false }), { failing: 'pull' });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('docker pull failed');
        expect(r.calls.some((c) => c.startsWith('docker [run]'))).toBe(false);
    });

    it('refuses an env name a shell or Docker cannot take, a value with a line break, and a port it cannot publish', () => {
        expect(() => containerBootScript({ image: 'x', env: { 'BAD-NAME': '1' } }, { gpu: false })).toThrow(/bad env name "BAD-NAME"/);
        expect(() => containerBootScript({ image: 'x', env: { '1ST': '1' } }, { gpu: false })).toThrow(/bad env name/);
        expect(() => containerBootScript({ image: 'x', env: { A: 'one\nASAP_VPS_ENV\nB=2' } }, { gpu: false })).toThrow(/line break/);
        expect(() => containerBootScript({ image: 'x', env: { A: 'one\r' } }, { gpu: false })).toThrow(/line break/);
        for (const port of ['80:8080', 'http', '8000/sctp', '']) {
            expect(() => containerBootScript({ image: 'x', ports: [port] }, { gpu: false })).toThrow(/bad port/);
        }
    });

    it('is a bash script cloud-init runs as it is', () => {
        const script = containerBootScript(spec, { gpu: true });
        expect(script.startsWith('#!/bin/bash\n')).toBe(true);
        expect(() => execFileSync('/bin/bash', ['-n'], { input: script })).not.toThrow();
    });
});

describe('withUserData: the caller\'s user data and the container\'s script, as one cloud-init document', () => {
    const script = containerBootScript({ image: 'busybox' }, { gpu: false });

    it('is just the script when the caller has none', () => {
        expect(withUserData(script)).toBe(script);
        expect(withUserData(script, '')).toBe(script);
    });

    /** The parts of a multipart document: each part's headers and body. */
    const parts = (doc: string) => {
        const boundary = /boundary="([^"]+)"/.exec(doc)![1];
        expect(doc.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
        return doc.split(`--${boundary}`).slice(1, -1).map((p) => {
            const [head, ...body] = p.replace(/^\n/, '').split('\n\n');
            return { type: /Content-Type: ([^;\n]+)/.exec(head)![1], body: body.join('\n\n').replace(/\n$/, '') };
        });
    };

    it('the caller\'s script first, then the container\'s, each a shell script', () => {
        const doc = withUserData(script, '#!/bin/bash\necho mine\n');
        expect(doc).toMatch(/^Content-Type: multipart\/mixed; boundary="[^"]+"\nMIME-Version: 1\.0\n\n/);
        expect(parts(doc)).toEqual([
            { type: 'text/x-shellscript', body: '#!/bin/bash\necho mine\n' },
            { type: 'text/x-shellscript', body: script },
        ]);
    });

    it('a cloud-config stays a cloud-config, leading space or not', () => {
        expect(parts(withUserData(script, '#cloud-config\npackages: [htop]\n'))[0].type).toBe('text/cloud-config');
        expect(parts(withUserData(script, '\n  #cloud-config\nruncmd: []\n'))[0].type).toBe('text/cloud-config');
    });

    /** The leaf parts of a MIME document, nested multiparts walked as cloud-init walks them: each one's type and body. */
    const leaves = (doc: string): Array<{ type: string, body: string }> => {
        const [head, ...rest] = doc.split('\n\n');
        const body = rest.join('\n\n');
        const type = /^content-type:\s*([^;\n]+)/im.exec(head)![1].trim();
        const boundary = /boundary="([^"]+)"/i.exec(head)?.[1];
        if (!type.startsWith('multipart/') || !boundary) return [{ type, body }];
        const pieces: string[][] = [];
        let open = false;
        for (const line of body.split('\n')) {
            if (line === `--${boundary}--`) open = false;
            else if (line === `--${boundary}`) open = !!pieces.push([]);
            else if (open) pieces[pieces.length - 1].push(line);
        }
        return pieces.flatMap((lines) => leaves(lines.join('\n')));
    };

    it('each part is typed as cloud-init types it, by how it begins: an archive is not a cloud-config, a boothook not a script', () => {
        const formats: Array<[string, string]> = [
            ['#!/bin/sh\necho hi', 'text/x-shellscript'],
            ['#cloud-config\nruncmd: []', 'text/cloud-config'],
            ['#cloud-config-archive\n- type: text/cloud-config\n  content: "runcmd: []"', 'text/cloud-config-archive'],
            ['#cloud-config-jsonp\n[{"op": "add", "path": "/runcmd", "value": []}]', 'text/cloud-config-jsonp'],
            ['#cloud-boothook\n#!/bin/sh\necho early', 'text/cloud-boothook'],
            ['#include\nhttps://example.com/user-data', 'text/x-include-url'],
            ['#include-once\nhttps://example.com/once', 'text/x-include-once-url'],
            ['#part-handler\ndef list_types(): return []', 'text/part-handler'],
            ['## template: jinja\n#cloud-config\nruncmd: []', 'text/jinja2'],
            ['  #CLOUD-CONFIG\nruncmd: []', 'text/cloud-config'],
            // Anything else runs as a script, as it did.
            ['echo no shebang', 'text/x-shellscript'],
        ];
        for (const [body, type] of formats) expect([body, leaves(withUserData(script, body))[0]]).toEqual([body, { type, body }]);
    });

    it('a MIME document of the caller\'s goes in whole, nested: its parts keep their own types, and the container\'s script follows', () => {
        const theirs = [
            'Content-Type: multipart/mixed; boundary="===============123=="', 'MIME-Version: 1.0', '',
            '--===============123==', 'Content-Type: text/cloud-config; charset="us-ascii"', 'MIME-Version: 1.0', '', '#cloud-config\npackages: [htop]',
            '--===============123==', 'Content-Type: text/x-shellscript-per-boot; charset="us-ascii"', 'MIME-Version: 1.0', '', '#!/bin/sh\necho every boot',
            '--===============123==--', '',
        ].join('\n');
        const expected = [
            { type: 'text/cloud-config', body: '#cloud-config\npackages: [htop]' },
            { type: 'text/x-shellscript-per-boot', body: '#!/bin/sh\necho every boot' },
            { type: 'text/x-shellscript', body: script },
        ];
        expect(leaves(withUserData(script, theirs))).toEqual(expected);
        // As a mailbox writes it too (a "From " line first).
        expect(leaves(withUserData(script, `From nobody Wed Oct  7 2026\n${theirs}`))).toEqual(expected);
    });

    it('its boundary is one no part contains: a document of its own nests in another', () => {
        const inner = cloudInitParts(['#cloud-config\nruncmd: []', '#!/bin/sh\necho a'])!;
        const outer = cloudInitParts([inner, '#!/bin/sh\necho b'])!;
        const boundary = (doc: string) => /boundary="([^"]+)"/.exec(doc)![1];
        expect(boundary(outer)).not.toBe(boundary(inner));
        expect(leaves(outer)).toEqual([
            { type: 'text/cloud-config', body: '#cloud-config\nruncmd: []' },
            { type: 'text/x-shellscript', body: '#!/bin/sh\necho a' },
            { type: 'text/x-shellscript', body: '#!/bin/sh\necho b' },
        ]);
    });
});

describe('cloudInitParts: several parts, run by cloud-init in order', () => {
    it('none is undefined; one is itself; more are one multipart document, each part typed', () => {
        expect(cloudInitParts([])).toBeUndefined();
        expect(cloudInitParts([undefined, ''])).toBeUndefined();
        expect(cloudInitParts([undefined, '#!/bin/bash\necho one\n'])).toBe('#!/bin/bash\necho one\n');
        const doc = cloudInitParts(['#cloud-config\nruncmd: []\n', undefined, '#!/bin/bash\necho two\n', '#!/bin/bash\necho three\n'])!;
        expect(doc).toMatch(/^Content-Type: multipart\/mixed; boundary="==asap-vps-container=="/);
        expect([...doc.matchAll(/Content-Type: (text\/[a-z-]+);/g)].map((m) => m[1])).toEqual(['text/cloud-config', 'text/x-shellscript', 'text/x-shellscript']);
        expect(doc.indexOf('echo two')).toBeLessThan(doc.indexOf('echo three'));
    });

    it('a part is a MIME document only when it begins with its headers: a script that prints one is a script', () => {
        const script = '#!/bin/sh\necho "Content-Type: text/plain"\n';
        expect(cloudInitParts([script, '#!/bin/sh\necho b'])).toBe([
            'Content-Type: multipart/mixed; boundary="==asap-vps-container=="', 'MIME-Version: 1.0', '',
            '--==asap-vps-container==', 'Content-Type: text/x-shellscript; charset="utf-8"', 'MIME-Version: 1.0', '', script,
            '--==asap-vps-container==', 'Content-Type: text/x-shellscript; charset="utf-8"', 'MIME-Version: 1.0', '', '#!/bin/sh\necho b',
            '--==asap-vps-container==--', '',
        ].join('\n'));
    });

    it('a MIME document goes in without the "From " line a mailbox puts first: its headers begin the part', () => {
        const theirs = 'Content-Type: multipart/mixed; boundary="b1"\nMIME-Version: 1.0\n\n--b1\nContent-Type: text/cloud-config\n\n#cloud-config\nruncmd: []\n--b1--\n';
        expect(cloudInitParts([`From nobody Wed Oct  7 2026\n${theirs}`, '#!/bin/sh\necho b'])).toBe([
            'Content-Type: multipart/mixed; boundary="==asap-vps-container=="', 'MIME-Version: 1.0', '',
            '--==asap-vps-container==', theirs.replace(/\n+$/, ''),
            '--==asap-vps-container==', 'Content-Type: text/x-shellscript; charset="utf-8"', 'MIME-Version: 1.0', '', '#!/bin/sh\necho b',
            '--==asap-vps-container==--', '',
        ].join('\n'));
    });

    it('its boundary is the first of ==asap-vps-container==, then -2, -3, ... that no part contains', () => {
        const boundary = (doc: string) => /boundary="([^"]+)"/.exec(doc)![1];
        const one = cloudInitParts(['#!/bin/sh\necho a', '#!/bin/sh\necho b'])!;
        const two = cloudInitParts([one, '#!/bin/sh\necho c'])!;
        const three = cloudInitParts([two, '#!/bin/sh\necho d'])!;
        expect([boundary(one), boundary(two), boundary(three)]).toEqual(['==asap-vps-container==', '==asap-vps-container-2==', '==asap-vps-container-3==']);
    });
});
