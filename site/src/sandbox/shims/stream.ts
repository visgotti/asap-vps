// node:stream for the sandbox: streaming a file through a pipeline is a Node thing (disk uploads); the classes exist so the library loads.

import { NotInSandbox } from './unavailable';

export class Readable {
    static toWeb(): never {
        throw new NotInSandbox('stream.Readable.toWeb');
    }
    static fromWeb(): never {
        throw new NotInSandbox('stream.Readable.fromWeb');
    }
}
export class Transform {
    constructor() {
        throw new NotInSandbox('stream.Transform');
    }
}
export const pipeline = (): never => {
    throw new NotInSandbox('stream.pipeline');
};
