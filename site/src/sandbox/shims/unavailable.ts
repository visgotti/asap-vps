// What a browser cannot do: a call that needs a disk, a socket or a key generator says so, instead of failing obscurely.

export class NotInSandbox extends Error {
    constructor(what: string) {
        super(`${what} is not available in the browser sandbox (it needs Node: run this on your machine)`);
        this.name = 'NotInSandbox';
    }
}

export const unavailable = (what: string) => (): never => {
    throw new NotInSandbox(what);
};
