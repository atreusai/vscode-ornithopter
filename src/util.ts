import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as cp from "child_process";
import { Disposable, Event, EventEmitter } from "vscode";
import Logger from "./logger";
import axios from 'axios';
import { promisify } from "node:util";
import { isDeepStrictEqual } from "util";
import { LOCAL_NODE_HTTP } from "./constants";
import fetch from "node-fetch";
import { stringify } from "querystring";
const exec = promisify(require('child_process').exec);
import * as path from 'path';

export enum IssueType {
  githubIssue,
  solidityIssue
};

export interface IssueForDecoration {
  type: IssueType,
  lineRef?: string,
  comment?: string,
  data0?: string,
  data1?: string,
  szInFront?: number,
  filePath?: string,
  repoOwner?: string,
  repoName?: string,
  commit?: string
};


export enum ForgeResult {
  success,
  scriptSucessVerifyFail,
  failGas,
  failRevert,
  failNonce,
  failUserInput,
  failUnknownReason
};

export interface ScriptResponse {
  result: ForgeResult;
  info: any;
  /*
  successMap?: Map<string, string>;
  successString?: string; 
  failMap?: Map<string, string>;
  failString?: string;
  failReason?: string;
  transaction?: ForgeTransaction; 
  */
};

export const serverLocation = "https://atreus.ai/api/dev";
export function getServerLocation(): string {
  const apiURL = vscode.workspace.getConfiguration().get("ornithopter.APIUrl") as string;
  return apiURL;
}

export const getCurrentFolder = (
  folders: readonly vscode.WorkspaceFolder[] | undefined
) => {
  return getCurrentWorkspaceFolder(folders);
};

export const getCurrentWorkspaceFolder = (
  folders: readonly vscode.WorkspaceFolder[] | undefined
) => {
  if (folders === undefined) {
    return undefined;
  }
  const location = folders[0].uri;
  if (location.scheme !== "file") {
    // we don't handle anything other than local files.
    return undefined;
  }
  return folders[0];
};

export const getToken = () => {
  const fileLocation = `${os.homedir}/.config/atreus/login_secret_jwt.json`;
  try {
    let response: any = JSON.parse(fs.readFileSync(fileLocation).toString());
    let token: string = response.access_token;
    return token;
  } catch (e) {
    vscode.window.showErrorMessage(
      `Failed to load auth token at ${fileLocation} with error ${e}`
    );
  }
};

export function cpExecAsync(invocation: string): Promise<string> {
  return cpExecAsyncEnv(invocation, {});
}

export async function cpExecAsyncEnv(
  invocation: string,
  env: object
): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(
      invocation,
      {
        env: {
          ...process.env,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(stderr);
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

export interface PromiseAdapter<T, U> {
  (
    value: T,
    resolve: (value: U | PromiseLike<U>) => void,
    reject: (reason: any) => void
  ): any;
}

const passthrough = (value: any, resolve: (value?: any) => void) =>
  resolve(value);

/**
 * Return a promise that resolves with the next emitted event, or with some future
 * event as decided by an adapter.
 *
 * If specified, the adapter is a function that will be called with
 * `(event, resolve, reject)`. It will be called once per event until it resolves or
 * rejects.
 *
 * The default adapter is the passthrough function `(value, resolve) => resolve(value)`.
 *
 * @param event the event
 * @param adapter controls resolution of the returned promise
 * @returns a promise that resolves or rejects as specified by the adapter
 */
export function promiseFromEvent<T, U>(
  event: Event<T>,
  adapter: PromiseAdapter<T, U> = passthrough
): { promise: Promise<U>; cancel: EventEmitter<void> } {
  let subscription: Disposable;
  let cancel = new EventEmitter<void>();

  return {
    promise: new Promise<U>((resolve, reject) => {
      cancel.event((_) => reject("Cancelled"));
      subscription = event((value: T) => {
        try {
          Promise.resolve(adapter(value, resolve, reject)).catch(reject);
        } catch (error) {
          reject(error);
        }
      });
    }).then(
      (result: U) => {
        subscription.dispose();
        return result;
      },
      (error) => {
        subscription.dispose();
        throw error;
      }
    ),
    cancel,
  };
}

// Poll analysis server every 5 minutes to get issues for decoration
export async function pollServerForDecorationIssues(
  issues: IssueForDecoration[],
  repoOwner: string,
  repoName: string
): Promise<void> {
  while (true) {
    let result = await axios.get(`http://localhost:8888/download_issues?repoOwner=${repoOwner}'&repoName=${repoName}`);
    Logger.info(toText(result));
    await new Promise(r => setTimeout(r, 300000));
  }
};

// Get repo owner and name from local git configuration
export async function getRepoOwnerName() {
  try {
    const opts = {
      "cwd": getCurrentFolder(vscode.workspace.workspaceFolders)?.uri?.fsPath,
      "env": process.env
    };
    let result = (await exec("git config --get remote.origin.url", opts)).stdout.split("/");
    return {
      'repoOwner': result[result.length - 2],
      'repoName': result[result.length - 1].slice(0, -5) //remove the ".git\n" from end
    };
  } catch (e) {
    Logger.error(`getRepoOwnerName failed with error: ${e}`);
    return { 'repoOwner': '', 'repoName': '' };
  }
}

// Get repo owner and name from local git configuration
export async function getRepoBranch() {
  try {
    const opts = {
      "cwd": getCurrentFolder(vscode.workspace.workspaceFolders)?.uri?.fsPath,
      "env": process.env
    };
    const { stdout } = (await exec("git rev-parse  HEAD", opts));
    return stdout ? stdout.replace('\n', '') : "";

  } catch (e) {
    Logger.error(`getRepoOwnerName failed with error: ${e}`);
    return '';
  }
}

export function toCamelCase(snakeStr: string) {
  let STR = snakeStr.toLowerCase()
    .trim()
    .split(/[ -_]/g)
    .map(word => word.replace(word[0], word[0].toString().toUpperCase()))
    .join('');
  return STR.replace(STR[0], STR[0].toLowerCase());
};

export async function parseUserIssueReference(url: string): Promise<IssueForDecoration> {
  let issue = { type: IssueType.githubIssue } as IssueForDecoration;
  try {
    const fileLink = 'https://github.com/risingsun007/Solidity_DEX_trading/blob/16d9027f1ff09a5e0e0470007cf51dac70b95447/DEX_trading.sol#L41-L42';
    //https://raw.githubusercontent.com/username/folder/example.css
    //const fileLink = "https://raw.githubusercontent.com/risingsun007/Solidity_DEX_trading/16d9027f1ff09a5e0e0470007cf51dac70b95447/DEX_trading.sol#L41-L42";

    let parts = url.split('/');
    if (parts.length < 6) {
      Logger.error(`parseUserIssueReference issue ${fileLink}`);
      return { 'repoOwner': '', 'repoName': '', filePath: '' } as IssueForDecoration;
    }

    issue.repoOwner = parts[3];
    issue.repoName = parts[4];

    let pathName = /(?<=[a-fA-F0-9]{40}\/).*(?=#)/.exec(url);
    if (!pathName) {
      Logger.error(`parseUserIssueReference issue couldn't find commit hash ${fileLink}`);
      return issue;
    }

    const rawFileLink = fileLink.replace(/github/, "raw.githubusercontent").replace('blob/', '');

    let result2 = await fetch(rawFileLink); //"https://github.com/risingsun007/Solidity_DEX_trading/blob/16d9027f1ff09a5e0e0470007cf51dac70b95447/DEX_trading.sol");
    const fileData = await result2.text();
    let results = /(?<=#).*/.exec(fileLink);//L28-L32
    if (!results || !results.length) {
      Logger.error(`parseUserIssueReference couldn't find file line ${result2}`);
      return issue;
    }
    let lineNums = results[0].replace(/L/g, '').split('-');

    const lines = fileData.split('\n');
    let commentStr = '';
    const last = Number(lineNums[lineNums.length - 1]);
    for (let i = Number(lineNums[0]); i <= last; ++i) {
      commentStr += i < last ? lines[i - 1] + '\n' : lines[i - 1];
    }

    let szInFront = 0;

    for (let line of lines) {
      szInFront += line.length;
    }

    issue.comment = "get this hover";
    issue.lineRef = commentStr;
    issue.szInFront = szInFront;
    issue.data0 = commentStr;

    return issue;
  } catch (e) {
    Logger.error(`parseUserIssueReference caught error: ${toText(e)}`);
    return { type: IssueType.githubIssue } as IssueForDecoration;
  }
};

export async function etherRpc(method: string, parms: any[], url: string = LOCAL_NODE_HTTP) {
  try {
    return (await axios.post(
      url,
      JSON.stringify({
        jsonrpc: "2.0",
        method: method,
        params: parms.length >= 1 ? [parms[0]] : [],
        id: 2
      }),
      { headers: { 'content-type': 'application/json' } })
    ).data;
  } catch (e) {
    if (e instanceof Error) {
      Logger.error(`etherRpc failed with error: ${e.message}`);
    } else {
      Logger.info(`etherRpc failed with error: ${toText(e)}`);
    }
    return {};
  }
}

export async function getTransactionHash(hash: string, url: string = LOCAL_NODE_HTTP) {
  const trans = (await etherRpc("eth_getTransactionByHash", [hash], url)).result;
  for (const key in trans) {
    if (!["blockHash", "hash", "input", "from", "r", "s", "accessList", "to"].includes(key)) {
      trans[key] = parseInt(trans[key], 16);
    }
  }
  return trans;
}

export function jsonToHtml(jsonObj: any): string {
  try {
    if (typeof (jsonObj) !== 'object') {
      Logger.error("non json object passed into jsonToHtml");
      return jsonObj;
    }
    let str = "";
    for (let [key, value] of Object.entries(jsonObj)) {
      if (value && typeof (value) === 'string' && value.length > 300) {
        value = `${value.slice(0, 300)}...`;
      } else if (value && typeof (value) === 'object') {
        value = `{${jsonToHtml(JSON.parse(JSON.stringify(value)))}}`;
      }
      str += `${key}: ${value}\n`;
    }
    return str;
  }
  catch (e) {
    Logger.error(`toText function failed with error ${e}`);
    return jsonObj;
  }
}

export function toText(input: any) {
  try {
    if (typeof (input) === 'object') {
      const copyObj = JSON.parse(JSON.stringify(input));
      Object.keys(copyObj).forEach(function (key) {
        if (copyObj[key] && typeof (copyObj[key]) === 'string' && copyObj[key].length > 300) {
          copyObj[key] = `${copyObj[key].slice(0, 300)}...`;
        }
        else if (copyObj[key] && typeof (copyObj[key]) === 'object') {
          copyObj[key] = `{${toText(copyObj[key])}}`;
        }
      });
      return JSON.stringify(copyObj);
    } else if (typeof (input) === 'number') {
      return String(input);
    } else {
      return input;
    }
  } catch (e) {
    Logger.error(`toText function failed with error ${e}`);
    return input;
  }
}

export async function getFoundryVersion(context: vscode.ExtensionContext, useLocalBin: boolean) {
  try {
    const folder = getCurrentFolder(vscode.workspace.workspaceFolders)?.uri?.fsPath || "";
    const { stdout, stderr } = await exec(useLocalBin ? path.join(folder, 'forge') : 'forge -V');
    const parts = stdout.split(/\s+/);
    if (parts.length < 2) {
      vscode.window.showErrorMessage("Could not Foundry find version.  Make sure Foundry is installed correctly");
      return undefined;
    }
    const versions = parts[1].split(".");
    if (versions.length < 3) {
      vscode.window.showErrorMessage("Could not Foundry find version.  Make sure Foundry is installed correctly");
      return undefined;
    }
    return versions;

  }
  catch (err) {
    vscode.window.showErrorMessage("Could not Foundry find version.  Make sure Foundry is installed correctly");
    Logger.error(`getFoundryVersion failed with error ${err}`);
    return undefined;
  }
}


