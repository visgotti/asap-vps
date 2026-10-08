// node:fs for the sandbox: there is no disk. Reads find nothing, writes say so.

import { unavailable } from './unavailable';

export const existsSync = (): boolean => false;
export const readFileSync = (path: string): never => {
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}' (the sandbox has no disk)`), { code: 'ENOENT' });
};
export const statSync = readFileSync;
export const readdirSync = readFileSync;
export const mkdirSync = unavailable('fs.mkdirSync');
export const mkdtempSync = unavailable('fs.mkdtempSync');
export const writeFileSync = unavailable('fs.writeFileSync');
export const appendFileSync = unavailable('fs.appendFileSync');
export const copyFileSync = unavailable('fs.copyFileSync');
export const chmodSync = unavailable('fs.chmodSync');
export const symlinkSync = unavailable('fs.symlinkSync');
export const rmSync = unavailable('fs.rmSync');
export const unlinkSync = unavailable('fs.unlinkSync');
export const createReadStream = unavailable('fs.createReadStream');
export const createWriteStream = unavailable('fs.createWriteStream');
export const unlink = unavailable('fs.promises.unlink');
export const promises = { unlink };
