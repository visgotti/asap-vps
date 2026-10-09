export function promisify<T>(fn: (...args: any[]) => unknown): (...args: any[]) => Promise<T> {
    return (...args) => new Promise<T>((resolve, reject) => fn(...args, (err: Error | null, value: T) => (err ? reject(err) : resolve(value))));
}
