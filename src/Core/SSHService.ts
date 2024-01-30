
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { NodeSSH } from 'node-ssh';
import { encrypt, decrypt, makeId, retryInvoke,ensureDirectoryExists } from '../utils';
import { MACHINE_TYPES, SETUP_SCRIPTS } from '../constants';

const { readFile, unlink, rm } = fs.promises;
export type SSHKeyData = {
  publicKey: string,
  privateKey: string
}

export type SSHData<T extends (true | false)> = SSHKeyData & {
  id?: string | number,
  isEncrypted?: T,
  username?: string,
}
export type EncryptedSSHData = SSHData<true>
export type UnencryptedSSHData = SSHData<false>

const DEFAULT_SSH_PATH =  path.join(__dirname, 'temp_ssh');

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

  public static async connect(ip: string, privateKey: string, decryptionKey?: string):  Promise<NodeSSH>;
  public static async connect(ip: string, sshData: EncryptedSSHData, decryptionKey: string):  Promise<NodeSSH>;
  public static async connect(ip: string, sshData: UnencryptedSSHData) : Promise<NodeSSH>;
  public static async connect(ip: string, sshData: EncryptedSSHData | UnencryptedSSHData | string, decryptionKey?: string) : Promise<NodeSSH> {
    const s = new SSHService();
    return s.connect(ip, sshData as any, decryptionKey as string);
  }

  public async connect(ip: string, privateKey: string, decryptionKey?: string):  Promise<NodeSSH>;
  public async connect(ip: string, sshData: EncryptedSSHData, decryptionKey: string):  Promise<NodeSSH>;
  public async connect(ip: string, sshData: UnencryptedSSHData) : Promise<NodeSSH>;
  public async connect(ip: string, sshData: SSHData<boolean> | string, decryptionKey?: string) : Promise<NodeSSH> {
    const ssh = new NodeSSH();
    let decryptedPrivateKey = '';
    if(typeof sshData !== "string") {
      if(!sshData.privateKey) throw new Error(`There is no private key on the ssh entity ${JSON.stringify(sshData)}`);
      if(sshData.isEncrypted && !decryptionKey) {
        throw new Error(`SSH Entity is encrypted but no decryption key was provided`);
      }
  
      decryptedPrivateKey = sshData.isEncrypted || (sshData.isEncrypted === undefined && decryptionKey) ? decrypt(sshData.privateKey, decryptionKey as string) : sshData.privateKey
      if(this.openConnections[ip] && decryptedPrivateKey in this.openConnections[ip]) {
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
        const _dispose = ssh.dispose;
        ssh.dispose = async () => {
            try { await _dispose();
            } catch (err) {};
            removeConnection();
        }
        const doConnection = async () => {
          await ssh.connect({
            tryKeyboard: true,
            host: ip,
            username: 'root',
            privateKey: decryptedPrivateKey,
            onKeyboardInteractive(_name: unknown, _instructions: unknown, _instructionsLang: unknown, _prompts:unknown, finish: Function) {
              finish([])
            }
          });
        }
        await retryInvoke(doConnection, 5000, 3);

        return ssh;
    } catch (err) {
        removeConnection();
        throw err;
    }
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


  public static async createKeys(path=DEFAULT_SSH_PATH, id?: string | number, deleteAfter=true) : Promise<SSHKeyData>{
    id = id ?? makeId(10);
    path = path || DEFAULT_SSH_PATH
    ensureDirectoryExists(path);
    const privateKeyPath = await SSHService.generateSSHKeyPair(path, id);
    const publicKeyPath = privateKeyPath + '.pub';
    const deleteKeys = async () => {
        try {
            await Promise.all([
                unlink(privateKeyPath),
                unlink(publicKeyPath),
                rm(path, { recursive: true, force: true })
            ])
        } catch(err) {
            console.error(err);
        }
    }
    const [ publicKey, privateKey ] = await Promise.all([
      readFile(publicKeyPath, 'utf-8'), 
      readFile(privateKeyPath, 'utf-8')
    ]);
    if(deleteAfter) {
      await deleteKeys();
    }
    return { publicKey, privateKey }
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

  public static async generateSSHKeyPair(sshPath=DEFAULT_SSH_PATH, id: string | number = makeId(10)) : Promise<string> {
    return new Promise((resolve, reject) => {
      ensureDirectoryExists(sshPath);
      const keyPath = path.join(sshPath, `id_rsa_${id}`);
      // Execute ssh-keygen command
      const command = `ssh-keygen -m PEM -t rsa -b 2048 -f ${keyPath} -P ""`;
      exec(command, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve(keyPath);
        }
      });
    });
  }
}



  