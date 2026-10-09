// The dead-man switch startWatchdog (./live.ts) spawns, detached:
//   node -r ts-node/register/transpile-only watchdog.ts <provider> <runName> <launcherPid> <deadline>
// Once the launcher is gone or the deadline passes, it deletes the run's
// servers (verified), keys and images, unless the run marked itself done first.

import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { providerFromEnv, loadCredentials, watchdogFiles, watchdogLoop } from './live';

async function main(): Promise<number> {
    const [id, runName, launcherPid, deadline] = process.argv.slice(2);
    const { doneFile, logFile } = watchdogFiles(runName);
    mkdirSync(dirname(logFile), { recursive: true });
    const log = (m: string) => appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`);
    try {
        loadCredentials();
        const provider = providerFromEnv(id);
        log(`watchdog ${process.pid} armed for ${runName} on ${id} (launcher ${launcherPid}, deadline ${new Date(Number(deadline)).toISOString()})`);
        await watchdogLoop({ provider, runName, parentPid: Number(launcherPid), deadline: Number(deadline), doneFile, log });
        return 0;
    } catch (e) {
        log(`watchdog failed: ${(e as Error).message}: check the provider's console by hand`);
        return 1;
    }
}

if (require.main === module) {
    main().then((code) => process.exit(code));
}
