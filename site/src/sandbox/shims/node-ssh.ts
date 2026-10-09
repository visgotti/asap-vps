// node-ssh for the sandbox: no sockets in a browser, so no SSH. Everything before the login (renting, waiting, listing) works.

import { NotInSandbox } from './unavailable';

export class NodeSSH {
    connection = undefined;
    constructor() {
        throw new NotInSandbox('an SSH login');
    }
}
