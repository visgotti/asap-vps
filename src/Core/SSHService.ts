
import * as path from 'path';
import * as fs from 'fs';
import { NodeSSH } from 'node-ssh';
import { encrypt, decrypt, makeId, retryInvoke, ensureDirectoryExists, createSSHKeyPair } from './utils';
import { MACHINE_TYPES, SETUP_SCRIPTS } from '../constants';
import type { EncryptedSSHData, SSHConnectOptions, SSHData, SSHEndpoint, SSHKeyData, SSHRetryOptions, UnencryptedSSHData } from '../types';

const DEFAULT_SSH_PATH =  path.join(__dirname, 'temp_ssh');
const DEFAULT_RETRY: SSHRetryOptions = { maxRetries: 10, retryTimeout: 5000 };

export class SSHService {
    private openConnections : {[ip: string]: { [publicKey: string]: NodeSSH } }  = {};
    readonly useTempSSHDirectory: boolean = false;
  constructor(readonly sshPath?: string) {
    if(!sshPath) {
      this.useTempSSHDirectory = true;
      this.sshPath =DEFAULT_SSH_PATH;
    } else {
      this.sshPath = sshPath;
    }
  }

  /**
   * An ssh session. The options form reaches any login on any port, so a GPU
   * server's endpoint spreads straight in: connect({ ...server.ssh, privateKey }).
   * The positional forms log in as root on port 22.
   */
  public static async connect(options: SSHConnectOptions):  Promise<NodeSSH>;
  public static async connect(ip: string, privateKey: string, decryptionKey?: string):  Promise<NodeSSH>;
  public static async connect(ip: string, sshData: EncryptedSSHData, decryptionKey: string):  Promise<NodeSSH>;
  public static async connect(ip: string, sshData: UnencryptedSSHData) : Promise<NodeSSH>;
  public static async connect(ip: string, privateKey: string, decryptionKey: string | undefined, retryOption: SSHRetryOptions):  Promise<NodeSSH>;
  public static async connect(ip: string | SSHConnectOptions, sshData?: EncryptedSSHData | UnencryptedSSHData | string, decryptionKey?: string, retryOption?: SSHRetryOptions) : Promise<NodeSSH> {
    const s = new SSHService();
    if (typeof ip === 'object') {
      return s.connect(ip);
    } else if (retryOption) {
      return s.connect(ip, sshData as any, decryptionKey as string, retryOption);
    } else {
      return s.connect(ip, sshData as any, decryptionKey as string);
    }
  }

  public async connect(options: SSHConnectOptions):  Promise<NodeSSH>;
  public async connect(ip: string, privateKey: string, decryptionKey?: string):  Promise<NodeSSH>;
  public async connect(ip: string, sshData: EncryptedSSHData, decryptionKey: string):  Promise<NodeSSH>;
  public async connect(ip: string, sshData: UnencryptedSSHData) : Promise<NodeSSH>;
  public async connect(ip: string, privateKey: string, decryptionKey: string | undefined, retryOption: SSHRetryOptions):  Promise<NodeSSH>;
  public async connect(ipOrOptions: string | SSHConnectOptions, sshData?: SSHData<boolean> | string, decryptionKey?: string, retryOption=DEFAULT_RETRY) : Promise<NodeSSH> {
    if (typeof ipOrOptions === 'object') {
      const o = ipOrOptions;
      const ssh = new NodeSSH();
      const retry = o.retry ?? DEFAULT_RETRY;
      try {
        const privateKey = o.decryptionKey ? decrypt(o.privateKey, o.decryptionKey) : o.privateKey;
        await SSHService.dial(ssh, { host: o.host, port: o.port ?? 22, username: o.username ?? 'root' }, privateKey, retry);
        return ssh;
      } catch (err) {
        console.error(`[SSHService] Failed to connect to ${o.host} after ${retry.maxRetries} retries:`, err.message);
        throw err;
      }
    }
    const ip = ipOrOptions;
    if (sshData === undefined) throw new Error(`No private key given to connect to ${ip}`);
    const ssh = new NodeSSH();
    let decryptedPrivateKey = '';
    if(typeof sshData !== "string") {
      if(!sshData.privateKey) throw new Error(`There is no private key on the ssh entity ${JSON.stringify(sshData)}`);
      if(sshData.isEncrypted && !decryptionKey) {
        throw new Error(`SSH Entity is encrypted but no decryption key was provided`);
      }

      decryptedPrivateKey = sshData.isEncrypted || (sshData.isEncrypted === undefined && decryptionKey) ? decrypt(sshData.privateKey, decryptionKey as string) : sshData.privateKey
      if(this.openConnections[ip] && sshData.publicKey in this.openConnections[ip]) {
          throw new Error(`There is already an open connection with the publicKey: ${sshData.publicKey} on the ip ${ip}`);
      }
      if(!this.openConnections[ip]) {
          this.openConnections[ip] = {};
      }
      this.openConnections[ip][sshData.publicKey] = ssh;
    } else {
      decryptedPrivateKey = decryptionKey ? decrypt(sshData, decryptionKey as string) : sshData
    }

    const removeConnection = () => {
      if(typeof sshData !== "string") {
        let had = ip in this.openConnections;
        if(!had) return false;

        had = sshData.publicKey in this.openConnections[ip];

        if(had) {
          delete this.openConnections[ip][sshData.publicKey];
        }

        if(!(Object.keys(this.openConnections[ip]).length)) {
          delete this.openConnections[ip];
        }
        return had;
      }
    }
    try {
        const _dispose = ssh.dispose.bind(ssh);
        ssh.dispose = async () => {
            try { await _dispose();
            } catch (err) {};
            removeConnection();
        }
        await SSHService.dial(ssh, { host: ip, port: 22, username: 'root' }, decryptedPrivateKey, retryOption);

        return ssh;
    } catch (err) {
        console.error(`[SSHService] Failed to connect to ${ip} after ${retryOption.maxRetries} retries:`, err.message);
        removeConnection();
        throw err;
    }
  }

  /** Connect `ssh` to the endpoint, trying `retry.maxRetries` times. */
  private static async dial(ssh: NodeSSH, endpoint: SSHEndpoint, privateKey: string, retry: SSHRetryOptions): Promise<void> {
    await retryInvoke(() => ssh.connect({
      tryKeyboard: true,
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.username,
      privateKey,
      onKeyboardInteractive(_name: unknown, _instructions: unknown, _instructionsLang: unknown, _prompts: unknown, finish: Function) {
        finish([]);
      },
    }), retry.retryTimeout, retry.maxRetries);
    // node-ssh stops listening for the connection's errors once it is up, so one that drops later (a read
    // that times out, a reset) would be an uncaught exception that ends the process: it ends the session
    // instead, and a command in flight fails.
    const connection = ssh.connection;
    connection?.on('error', (err: Error) => {
      console.error(`[SSHService] The connection to ${endpoint.host} dropped: ${err.message}`);
      if (ssh.connection === connection) ssh.dispose();
    });
  }

  public static async installNodeModule(ssh: NodeSSH, options: { module: string, sudo: boolean, global: boolean }) {
    let cmd = `npm install ${options.module}`;
    if(options.sudo) {
      cmd = `sudo ${cmd}`;
    }
    if(options.global) {
      cmd = `${cmd} -g`;
    }
    await ssh.execCommand(cmd);
  }

  public static async sshGetFileText(ssh: NodeSSH, filePath: string) : Promise<string | null> {
    const fileContents = await ssh.execCommand(`cat ${filePath}`);
    return fileContents?.stdout?.trim() || null;
  }

  public static async sshEnsureFileTextExists(ssh: NodeSSH, filePath: string, stringToCheck: string) : Promise<boolean> {
    const f = await SSHService.sshGetFileText(ssh, filePath);
    return f === stringToCheck;
  }

  public static async installNvm(ssh: NodeSSH, machineType: MACHINE_TYPES = MACHINE_TYPES.UBUNTU_22) {
    await SSHService.sshSetupScript(ssh, machineType, SETUP_SCRIPTS.NVM);
    await ssh.execCommand(`source ~/.profile`);
  }

  public static async installNode(ssh: NodeSSH, version='--lts') {
    await SSHService.installNvm(ssh);
    await ssh.execCommand(`nvm install ${version}`);
    await ssh.execCommand(`nvm use ${version}`);
  }

  public static async sshExecFile(ssh: NodeSSH, fromPath: string, toPath: string) {
    try {
      await ssh.putFile(fromPath, toPath);
      await ssh.execCommand(`chmod 700 ${toPath}`);
      await ssh.execCommand(`sed -i -e \'s/\\r$//\' ${toPath}`);
      await ssh.execCommand(toPath);
      await ssh.execCommand(`rm -rf ${toPath}`);
    } catch (error) {
      console.error(`Error in sshExecFile: ${error.message}`);
      throw error;
    }
  }

  public static async writeJsonFile(ssh: NodeSSH, json: object, toPath: string) {
    const id = `__tempjson${makeId(10)}.json`;
    fs.writeFileSync(id, JSON.stringify(json, null, 2));
    try {
      await ssh.putFile(id, toPath)
    } catch (err) {};
    fs.unlinkSync(id);
  }

  public static async sshPutTextFile (ssh: NodeSSH, text: string, toPath: string) {
    return ssh.execCommand(`echo "${text}" > ${toPath}`);
  }

  public static async sshSetupScript(ssh: NodeSSH, machineType: MACHINE_TYPES, scriptType: SETUP_SCRIPTS) {
    try {
      const toPath = `~/tempsetup_${makeId(10)}.sh`;
      await SSHService.sshExecFile(
        ssh,
        path.resolve(__dirname, '..', 'scripts', 'setup', machineType, scriptType + '.sh'),
        toPath
      )
    } catch (error) {
      console.error(`Error in sshSetupScript: ${error.message}`);
      throw error;
    }
  }


  /**
   * A new key pair, generated in-process (Core/utils/ssh.ts): an RSA 2048
   * private key in PEM, as `ssh-keygen -m PEM -t rsa -b 2048` makes it, and its
   * authorized_keys line. Nothing touches the disk unless `deleteAfter` is
   * false: then the pair is also written to `<path>/id_rsa_<id>` (mode 0600)
   * and `<path>/id_rsa_<id>.pub`, refusing to overwrite either.
   */
  public static async createKeys(path=DEFAULT_SSH_PATH, id?: string | number, deleteAfter=true) : Promise<SSHKeyData>{
    const keys = await createSSHKeyPair();
    if(!deleteAfter) {
      writeKeyFiles(path || DEFAULT_SSH_PATH, id ?? makeId(10), keys);
    }
    return keys;
  }


  private async createKeys(id?: string | number) {
    return SSHService.createKeys(this.sshPath, id)
  }

  public static async initKeys(sshOptions: { id?: string | number, encryptionKey?: string, username?: string }={}) : Promise<SSHData<boolean>> {
    const s = new SSHService();
    return s.initKeys(sshOptions);
  }

  public async initKeys(sshOptions: { id?: string | number, encryptionKey?: string, username?: string }={}) : Promise<SSHData<boolean>> {
    const { id, encryptionKey, username } = sshOptions;
    const { publicKey, privateKey } = await this.createKeys(id);
    if(!publicKey || !privateKey) throw new Error(`Could not create keys for ssh ${sshOptions.id}`)
    const sshData : SSHData<boolean> = {
      isEncrypted: encryptionKey ? true : false,
      privateKey: encryptionKey ? encrypt(privateKey, encryptionKey) : privateKey,
      publicKey,
    }
    if(username) {
      sshData.username = username;
    }
    if(id || id === 0 || id === "0") {
      sshData.id = id;
    }
    return sshData;
  }

  private async generateSSHKeyPair(id?: number | string) : Promise<string> {
    return SSHService.generateSSHKeyPair(this.sshPath, id);
  }

  /** createKeys, written to `<sshPath>/id_rsa_<id>` and `.pub`: the private key's path. */
  public static async generateSSHKeyPair(sshPath=DEFAULT_SSH_PATH, id: string | number = makeId(10)) : Promise<string> {
    return writeKeyFiles(sshPath, id, await createSSHKeyPair());
  }
}

/** `<dir>/id_rsa_<id>` (mode 0600) and its `.pub`, as ssh-keygen writes them; never over existing files. */
function writeKeyFiles(dir: string, id: string | number, keys: SSHKeyData): string {
  ensureDirectoryExists(dir);
  const keyPath = path.join(dir, `id_rsa_${id}`);
  for (const p of [keyPath, `${keyPath}.pub`]) {
    if (fs.existsSync(p)) throw new Error(`${p} already exists`);
  }
  fs.writeFileSync(keyPath, keys.privateKey, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(`${keyPath}.pub`, `${keys.publicKey}\n`, { mode: 0o644, flag: 'wx' });
  return keyPath;
}
