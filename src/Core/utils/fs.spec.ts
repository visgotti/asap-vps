// ensureDirectoryExists: where SSHService writes the key files it is asked to keep.

import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureDirectoryExists } from './fs';

describe('ensureDirectoryExists', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'asap-vps-fs-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('makes the directory and the parents it is missing; one that exists is left as it is', () => {
        const nested = join(dir, 'a', 'b', 'keys');
        ensureDirectoryExists(nested);
        expect(statSync(nested).isDirectory()).toBe(true);
        expect(() => ensureDirectoryExists(nested)).not.toThrow();
    });
});
