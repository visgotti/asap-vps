// SSHService's positional connect: dispose() must really close the session.

import { NodeSSH } from 'node-ssh';
import { SSHService } from './SSHService';

describe('SSHService.connect (positional)', () => {
    afterEach(() => jest.restoreAllMocks());

    it('dispose() closes the connection (an open one keeps the process alive)', async () => {
        const { EventEmitter } = await import('events');
        const closed: string[] = [];
        jest.spyOn(NodeSSH.prototype, 'connect').mockImplementation(async function (this: NodeSSH, c: { host?: string }) {
            this.connection = Object.assign(new EventEmitter(), { end: () => closed.push(String(c.host)) }) as unknown as NodeSSH['connection'];
            return this;
        });
        await (await SSHService.connect('h2', 'PEM')).dispose();
        expect(closed).toEqual(['h2']);
    });
});
