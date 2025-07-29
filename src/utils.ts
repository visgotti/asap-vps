import { randomBytes, createCipheriv, createDecipheriv, createHash} from 'crypto';
import * as fs from 'fs';

export function ensureDirectoryExists(directory: string) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}
export function makeId(length: number) {
    let result = '';
    const characters =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }
  

  const ALGORITHM = 'aes-256-cbc';
  const IV_LENGTH = 16;

function hashKey(key: string): Buffer {
    return createHash('sha256').update(key, 'utf-8').digest();
}
  
  export function encrypt(text: string, key: string, algo=ALGORITHM, ivLength=IV_LENGTH): string {
    const iv = randomBytes(ivLength);
    const hashedKey = hashKey(key);
    const cipher = createCipheriv(algo, hashedKey, iv);
    let encrypted = cipher.update(text, 'utf-8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + encrypted;
  }

  export function decrypt(encryptedText: string, key: string, algo=ALGORITHM, ivLength=IV_LENGTH): string {
    const iv = Buffer.from(encryptedText.slice(0, ivLength * 2), 'hex');
    const encryptedData = encryptedText.slice(ivLength * 2);
    const hashedKey = hashKey(key);

    const decipher = createDecipheriv(algo, hashedKey, iv);
    let decrypted = decipher.update(encryptedData, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');

    return decrypted;
 }

 export const asyncTimeout = async (ts: number) => {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(true);
      }, ts)
    })
  }

  export const retryInvoke = async (fn: () => Promise<any>, timeBetween: number, maxTries: number) : Promise<any> => {
    let i = 0;
    let lastErr;
    while(i < maxTries) {
        try {
            const c = await fn();
            return c;
        } catch (err) {
            lastErr = err.message;
            if (i + 1 < maxTries) {
                await asyncTimeout(timeBetween);
            }
        }
        i++;
    }
    throw new Error(lastErr as string || `Can not invoke without failing.`);
}


/*
export const createDirectories = async (scripts: Array<ScriptEntity>, gameFiles: Array<any>, areaFiles: Array<any>) => {
}
*/