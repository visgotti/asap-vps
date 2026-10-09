// A container on a VM: what CreateServerOptions.container becomes where the
// platform rents VMs (DigitalOcean, Scaleway, Lambda): a script cloud-init
// runs once, at the first boot, as root. It installs Docker where the image
// has none (and, on a machine with an NVIDIA GPU, the NVIDIA container toolkit
// where it is missing), logs in to the image's registry, and runs the image as
// the container `asap-vps` (restarted with the machine), with its environment
// from a root-only env file, its ports published on the host's, and the GPUs
// passed through. The caller's own user data still runs: both go to cloud-init
// as one multipart document.

import type { ContainerSpec } from '../../types';
import { registryOf } from './registry';

/** The container's name on the VM: `docker logs asap-vps`. */
export const VM_CONTAINER_NAME = 'asap-vps';
/** Where its environment is written (root only). */
export const VM_CONTAINER_ENV_FILE = '/etc/asap-vps/container.env';

/** `s` as one word of a POSIX shell command: single-quoted, a single quote spelled out. */
export function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A port as Docker publishes it: '8000/tcp' -> '8000:8000/tcp' (udp kept; http, a container platform's word, is tcp). */
function publish(port: string): string {
    const m = /^(\d+)(?:\/(tcp|udp|http))?$/.exec(port.trim());
    if (!m) throw new Error(`bad port "${port}": use <port>/<tcp|udp>`);
    return `${m[1]}:${m[1]}/${m[2] === 'udp' ? 'udp' : 'tcp'}`;
}

/**
 * The first-boot script that runs `c` on a VM (bash, as root), `gpu` passing
 * its NVIDIA GPUs through. Env values are written to a root-only file, one
 * per line (so a value cannot hold a line break); a registry login goes to
 * `docker login --password-stdin` and is then removed from the machine's
 * Docker config. The login also rides in the server's user data, which the
 * account and the server itself can read: give a token that can only pull.
 */
export function containerBootScript(c: ContainerSpec, o: { gpu: boolean }): string {
    for (const [k, v] of Object.entries(c.env ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`bad env name "${k}"`);
        if (/[\r\n]/.test(v)) throw new Error(`env ${k}: a value cannot hold a line break`);
    }
    const env = Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
    const login = c.registryAuth ? { host: registryOf(c.registryAuth, c.image), ...c.registryAuth } : undefined;
    const run = ['docker', 'run', '-d', '--name', VM_CONTAINER_NAME, '--restart', 'unless-stopped', '--env-file', VM_CONTAINER_ENV_FILE,
        ...(c.ports ?? []).flatMap((p) => ['-p', publish(p)])].map(shellQuote).join(' ');
    const tail = [c.image, ...(c.command ?? [])].map(shellQuote).join(' ');
    return [
        '#!/bin/bash',
        '# asap-vps: the server\'s container (CreateServerOptions.container), run once at the first boot.',
        'set -euo pipefail',
        'export DEBIAN_FRONTEND=noninteractive',
        // A fresh machine's own apt run (unattended-upgrades) can hold the lock for minutes: wait it out.
        'apt_get() { for i in $(seq 1 60); do apt-get -o DPkg::Lock::Timeout=60 "$@" && return 0; sleep 10; done; return 1; }',
        'if ! command -v docker >/dev/null 2>&1; then',
        '  apt_get update -y',
        '  apt_get install -y docker.io',
        'fi',
        'systemctl enable --now docker',
        'GPUS=""',
        ...(o.gpu ? [
            'if command -v nvidia-smi >/dev/null 2>&1; then',
            '  if ! command -v nvidia-ctk >/dev/null 2>&1; then',
            '    apt_get install -y curl gpg',
            '    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg',
            "    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list",
            '    apt_get update -y',
            '    apt_get install -y nvidia-container-toolkit',
            '  fi',
            '  nvidia-ctk runtime configure --runtime=docker && systemctl restart docker',
            '  GPUS="--gpus all"',
            'fi',
        ] : []),
        `mkdir -p ${shellQuote(VM_CONTAINER_ENV_FILE.replace(/\/[^/]+$/, ''))} && umask 077`,
        `cat > ${shellQuote(VM_CONTAINER_ENV_FILE)} <<'ASAP_VPS_ENV'`,
        ...(env ? [env] : []),
        'ASAP_VPS_ENV',
        ...(login ? [
            `printf '%s' ${shellQuote(login.password)} | docker login -u ${shellQuote(login.username)} --password-stdin ${shellQuote(login.host)}`,
            `docker pull ${shellQuote(c.image)}`,
            `docker logout ${shellQuote(login.host)} || true`,
        ] : [`docker pull ${shellQuote(c.image)}`]),
        `docker rm -f ${VM_CONTAINER_NAME} >/dev/null 2>&1 || true`,
        `${run} $GPUS ${tail}`,
        '',
    ].join('\n');
}

/**
 * The user data of a VM that runs a container: the caller's own (a shell
 * script, a cloud-config, anything cloud-init reads) and the container's
 * script, as one multipart document cloud-init runs part by part; just the
 * script when the caller has none.
 */
export function withUserData(script: string, userData?: string): string {
    return cloudInitParts([userData, script]) ?? script;
}

/**
 * cloud-init's user-data formats by how a part begins, as cloud-init itself
 * tells them apart (its INCLUSION_TYPES_MAP: case and leading space ignored,
 * the longest prefix first, so a `#cloud-config-archive` is not taken for a
 * `#cloud-config`): https://cloudinit.readthedocs.io/en/latest/explanation/format.html
 */
const CLOUD_INIT_TYPES: ReadonlyArray<readonly [string, string]> = [
    ['#cloud-config-archive', 'text/cloud-config-archive'],
    ['#cloud-config-jsonp', 'text/cloud-config-jsonp'],
    ['## template: jinja', 'text/jinja2'],
    ['#cloud-boothook', 'text/cloud-boothook'],
    ['#part-handler', 'text/part-handler'],
    ['#include-once', 'text/x-include-once-url'],
    ['#cloud-config', 'text/cloud-config'],
    ['#include', 'text/x-include-url'],
    ['#!', 'text/x-shellscript'],
];

/** A part's MIME type: its cloud-init format's, a shell script's for anything else. */
function cloudInitType(part: string): string {
    const head = part.trimStart().toLowerCase();
    return CLOUD_INIT_TYPES.find(([prefix]) => head.startsWith(prefix))?.[1] ?? 'text/x-shellscript';
}

/** Whether user data is a MIME document already (what `cloud-init devel make-mime` writes): it begins with its headers. */
const isMime = (part: string) => /^(From [^\n]*\n)?(content-type|mime-version):/i.test(part.trimStart());

/**
 * User data made of several parts, run by cloud-init in this order: one
 * multipart document, or the part itself when there is one; undefined when
 * there is none. Each part is typed as cloud-init types it (a shell script, a
 * cloud-config, a cloud-config archive, a boothook, an include, ...). A part
 * that is a MIME document already goes in whole, as a nested multipart with
 * its own headers and parts: cloud-init walks into it.
 */
export function cloudInitParts(parts: Array<string | undefined>): string | undefined {
    const bodies = parts.filter((p): p is string => !!p);
    if (bodies.length <= 1) return bodies[0];
    // A boundary no part contains (a nested document may be one of ours).
    let boundary = '==asap-vps-container==';
    for (let n = 2; bodies.some((b) => b.includes(boundary)); n++) boundary = `==asap-vps-container-${n}==`;
    const part = (body: string) => (isMime(body)
        ? [`--${boundary}`, body.trimStart().replace(/^From [^\n]*\n/, '').replace(/\n*$/, '')].join('\n')
        : [`--${boundary}`, `Content-Type: ${cloudInitType(body)}; charset="utf-8"`, 'MIME-Version: 1.0', '', body].join('\n'));
    return [`Content-Type: multipart/mixed; boundary="${boundary}"`, 'MIME-Version: 1.0', '', ...bodies.map(part), `--${boundary}--`, ''].join('\n');
}
