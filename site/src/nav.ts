// The pages of the site, in order, by group. Each is a markdown file in ./content.

import overview from './content/overview.md';
import quickStart from './content/quick-start.md';
import digitalocean from './content/digitalocean.md';
import scaleway from './content/scaleway.md';
import lambda from './content/lambda.md';
import runpod from './content/runpod.md';
import vast from './content/vast.md';
import types from './content/types.md';
import containers from './content/containers.md';
import images from './content/images.md';
import volumes from './content/volumes.md';
import serverless from './content/serverless.md';
import costs from './content/costs.md';
import errors from './content/errors.md';
import ssh from './content/ssh.md';
import playground from './content/playground.md';
import sandbox from './content/sandbox.md';

export type Page = { slug: string, title: string, group: string, summary: string, md: string };

export const PAGES: Page[] = [
    { slug: 'overview', title: 'Overview', group: 'Start', summary: 'One set of typed primitives for servers on any cloud.', md: overview },
    { slug: 'quick-start', title: 'Quick start', group: 'Start', summary: 'Install, keys, a first server.', md: quickStart },
    { slug: 'digitalocean', title: 'DigitalOcean', group: 'Providers', summary: 'Droplets: the widest set of capabilities.', md: digitalocean },
    { slug: 'scaleway', title: 'Scaleway', group: 'Providers', summary: 'Instances in zones, with File Storage and serverless containers.', md: scaleway },
    { slug: 'lambda', title: 'Lambda Cloud', group: 'Providers', summary: 'GPU VMs: no stop, shared filesystems.', md: lambda },
    { slug: 'runpod', title: 'RunPod', group: 'Providers', summary: 'GPU and CPU pods, network volumes, serverless endpoints.', md: runpod },
    { slug: 'vast', title: 'Vast.ai', group: 'Providers', summary: 'A GPU marketplace: one offer, one machine.', md: vast },
    { slug: 'types', title: 'Types and completion', group: 'Guides', summary: 'What the compiler knows.', md: types },
    { slug: 'containers', title: 'Containers', group: 'Guides', summary: 'One container spec on every provider.', md: containers },
    { slug: 'images', title: 'Images', group: 'Guides', summary: 'Capture, copy, boot, import.', md: images },
    { slug: 'volumes', title: 'Volumes', group: 'Guides', summary: 'Block and shared storage that outlives servers.', md: volumes },
    { slug: 'serverless', title: 'Serverless', group: 'Guides', summary: 'Endpoints from zero workers.', md: serverless },
    { slug: 'costs', title: 'Costs', group: 'Guides', summary: "Billing, counted each provider's way.", md: costs },
    { slug: 'errors', title: 'Errors and retries', group: 'Guides', summary: 'Typed failures.', md: errors },
    { slug: 'ssh', title: 'Setting a server up', group: 'Guides', summary: 'ServerProvisioner and SSH.', md: ssh },
    { slug: 'sandbox', title: 'How the sandbox works', group: 'Sandbox', summary: 'What is real, what is simulated.', md: sandbox },
    { slug: 'playground', title: 'Playground', group: 'Sandbox', summary: 'A blank file with the fakes behind it.', md: playground },
];

export const bySlug = (slug: string): Page | undefined => PAGES.find((p) => p.slug === slug);
