import * as vscode from "vscode";
import {
  CodeLensProvider,
  TextDocument,
  CodeLens,
  Range,
  Command,
} from "vscode";

import axios from "axios";
import {
  cpExecAsync,
  cpExecAsyncEnv,
  getCurrentWorkspaceFolder,
  getCurrentFolder,
  ForgeResult,
  ScriptResponse,
  etherRpc,
  getTransactionHash,
  toText,
} from "./util";
import { isDeepStrictEqual, promisify } from "node:util";
import * as fs from "fs";
import { getHashes, KeyObject, timingSafeEqual } from "node:crypto";
import {
  ANVIL_NET_ID,
  ANVIL_DEFAULT_PORT,
  LOCAL_FDRY_BIN,
  LOCAL_NODE_HTTP,
} from "./constants";
import Logger from "./logger";
import { info } from "node:console";
import { start } from "node:repl";
import path = require("node:path");
import { Stream } from "node:stream";
import { resourceLimits } from "node:worker_threads";
import { ConsoleReporter } from "@vscode/test-electron";
const exec = promisify(require("child_process").exec);
const ANVIL_MNEMONIC =
  "test test test test test test test test test test test junk";
const ANVIL_DERIVATION_PATH = "m/44\\'/60\\'/0\\'/0/";
const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
import { ScriptingOutput } from "./scriptingOutput";

export interface ForgeTransaction {
  gasUsed?: number;
  gasPriceGwei?: number;
  transactionHash?: string;
  time?: number;
  runTimeMillsec?: number;
  contractAddress?: string;
  blockNum?: number;
  logs?: string; //TODO array json objects
  savedTo?: string;
  returns?: string;
  nodeTransData?: any;
}

export class FoundryScripting {
  useLocalNode: boolean;
  opts;
  useLocalForge: boolean;
  scriptingOutput: ScriptingOutput;
  forgeBin: string;
  anvilBin: string;
  // ethersProvider: any;
  //web3: Web3;
  // web3;

  // The following is the a test script, VaultFactory.s.sol, I added
  // to the Vaults respository to test scripting functionality
  /*
    //// SPDX-License-Identifier: UNLICENSED
    pragma solidity ^0.8.10;
    
    import "forge-std/Script.sol";
    import "../src/VaultFactory.sol";
    import {Auth, Authority} from "solmate/auth/Auth.sol";

    contract  MyScript is Script {
        function run() external {
            vm.startBroadcast();

            VaultFactory vaultFactory = new VaultFactory(address(this), Authority(address(0)));
        
            vm.stopBroadcast();
     }
    }
    */

  constructor(
    useLocalAnvil: boolean,
    useLocalForge: boolean,
    context: vscode.ExtensionContext
  ) {
    this.scriptingOutput = new ScriptingOutput(context);
    this.useLocalNode = useLocalAnvil;
    this.useLocalForge = useLocalForge;
    let folder =
      getCurrentFolder(vscode.workspace.workspaceFolders)?.uri?.fsPath || "";
    if (this.useLocalForge) {
      this.forgeBin = path.join(folder, LOCAL_FDRY_BIN, "forge");
      this.anvilBin = path.join(folder, LOCAL_FDRY_BIN, "anvil");
    } else {
      this.forgeBin = "forge";
      this.anvilBin = "anvil";
    }
    this.opts = {
      cwd: getCurrentFolder(vscode.workspace.workspaceFolders)?.uri?.fsPath,
      env: process.env,
    };
  }

  writeErr(str: string) {
    vscode.window.showErrorMessage(str);
    Logger.info(str);
  }

  async isAnvilRunning(): Promise<boolean> {
    try {
      const data = await etherRpc("net_version", []);
      return Number(data.result) === ANVIL_NET_ID ? true : false;
    } catch (e) {
      Logger.error(`isAnvilRunning failed with error ${e}`);
      return false;
    }
  }

  async getContractName(path: string) {
    const str = fs
      .readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); //try to remove comments
    var regex = /contract/g,
      result,
      indices = [];
    let contractNames = [];

    while ((result = regex.exec(str))) {
      let vars = str.slice(result.index, result.index + 200).split(/\ +/);
      if (vars.length > 1) {
        contractNames.push(vars[1]);
      }
    }

    if (contractNames.length === 0) {
      return undefined;
    } else if (contractNames.length === 1) {
      return contractNames[0];
    } else {
      return await vscode.window.showQuickPick(contractNames, {
        placeHolder: "Select which contract to run.",
      });
    }
  }

  async getAllCntNames(path: string): Promise<string[]> {
    const str = fs
      .readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); //try to remove comments
    const regex = /contract\s+([a-zA-Z0-9]+)/gm;
    let contractNames = [];
    let match;

    while ((match = regex.exec(str))) {
      if (match.length > 1) {
        contractNames.push(match[1]);
      }
    }
    return contractNames;
  }

  private async getSecrets(
    secrets: vscode.SecretStorage,
    key: string
  ): Promise<string | undefined> {
    try {
      const value = await secrets.get(key);
      return value;
    } catch (e) {
      Logger.error(`getFromSecretsFn error ${e}`);
      return "";
    }
  }

  async getPathAndContractFromSearchDialog(): Promise<string> {
    try {
      const excludedFolders =
        "lib,**/*.t.sol,node_modules,src/interfaces,src/modules";
      const files = await vscode.workspace.findFiles(
        "{**/*.s.sol}",
        `{${excludedFolders}}`
      );
      const allCnts: any[] = [];
      const folderName = getCurrentFolder(vscode.workspace.workspaceFolders)
        ?.uri?.fsPath;

      if (!folderName) {
        Logger.error("couldn't find folder name");
        vscode.window.showErrorMessage("couldn't find folder name");
        return "";
      } else if (!files || !files.length) {
        const msg = `Could not find any *.sol or *.s.sol files in the ${folderName} directory.  Try adding a s.sol or .sol file (files in these folders: \"${excludedFolders}\" are excluded)`;
        Logger.error(msg);
        vscode.window.showErrorMessage(msg);
        return "";
      }

      for (let x of files) {
        const cntNames = await this.getAllCntNames(x.path);
        Logger.info(`file Name: ${x.path}, cntsNames: ${cntNames} ${x.fsPath}`);
        for (let y of cntNames) {
          let dispName = x.path;
          let loc;
          if ((loc = dispName.search(folderName)) >= 0) {
            dispName = dispName.slice(loc + folderName.length + 1);
          }
          allCnts.push(`${dispName}:${y}`);
        }
      }
      // This seems unlikely to happen where you have a .sol files but no solidity contracts.  It is possible the contracts weren't parsed out correctly.
      if (!allCnts || !allCnts.length) {
        const msg = `Could not find any solidity contracts within your .sol or s.sol files.  Try adding contracts to your solidity contracts to a sol file`;
        Logger.error(msg);
        vscode.window.showErrorMessage(msg);
        return "";
      }

      return await vscode.window.showQuickPick(allCnts, {
        placeHolder: "Select which contract to run.",
      });
    } catch (e) {
      let msg = `Unexpected failure in selecting a file ${e}`;
      Logger.error(msg);
      vscode.window.showErrorMessage(msg);
      return "";
    }
  }
  /////////
  // Not currently used

  async getPathAndContractNameViaFilePicker(
    context: vscode.ExtensionContext
  ): Promise<string | undefined> {
    // await this.getPathAndContractFromSearchDialog();
    const folder = getCurrentFolder(vscode.workspace.workspaceFolders)?.uri
      ?.fsPath;
    const fileSelected = await vscode.window.showOpenDialog({
      title: "Select Script to Run",
      filters: { ".sol": ["sol", "s.sol"] },
    });
    // return(fileSelected);

    if (!folder) {
      this.writeErr("no folder");
      return;
    }
    if (!fileSelected || fileSelected.length === 0) {
      //this.writeErr("no file selected");
      return;
    }

    const contractName = await this.getContractName(fileSelected[0].path);
    if (!contractName) {
      this.writeErr(
        `Could not find a contract to run in the selected script.  Please try another file.`
      );
      return;
    }

    const relativeFileName = fileSelected[0].path.slice(folder.length + 1);
    return `${relativeFileName}:${contractName}`;
  }

  // throws an error if you try to launch anvil and it doesn't run within 10 seconds;

  async runAnvil(): Promise<void> {
    try {
      const numWaitTimesForAnvil = 30;
      if (!(await this.isAnvilRunning())) {
        const cmd = `${this.anvilBin}  --port ${ANVIL_DEFAULT_PORT} --mnemonic '${ANVIL_MNEMONIC}' --derivation-path ${ANVIL_DERIVATION_PATH}`;
        Logger.info(cmd);
        let result = exec(cmd, this.opts);
        vscode.window.showInformationMessage(
          `starting Anvil node... ${this.anvilBin}`
        );
        let i = 0;
        let isRunning;
        await new Promise((r) => setTimeout(r, 50));
        while (
          !(isRunning = await this.isAnvilRunning()) &&
          i < numWaitTimesForAnvil
        ) {
          ++i;
          await new Promise((r) => setTimeout(r, 300));
        }
        if (!isRunning) {
          const msg = "Could not get anvil to run";
          vscode.window.showErrorMessage(msg);
          Logger.error(msg);
          throw Error(msg);
        } else {
          Logger.info(
            `# second to loops taken for anvil Anvil: ${(i + 1) * 0.3}`
          );
          vscode.window.showInformationMessage(`Anvil started correctly`);
        }
      }
    } catch (e) {
      throw Error(`runAnvil error  ${e}`);
    }
  }

  private async notFoundError(
    x: string,
    xcommand: string,
    extraInfo: string = ""
  ) {
    const msg = `Did not find ${x} variable.  Please do one of the following: \
        1) Use palette command \"${xcommand}\", 2) Add environment variable ${x}`;
    Logger.error(msg);
    vscode.window.showErrorMessage(msg);
  }

  async runFoundryScriptLocallyFn(
    context: vscode.ExtensionContext,
    pathContractName: string | undefined = ""
  ): Promise<ScriptResponse> {
    let response = { result: ForgeResult.failUnknownReason } as ScriptResponse;
    let cmdToExec: string = "";
    try {
      if (!pathContractName) {
        pathContractName = await this.getPathAndContractFromSearchDialog();
        if (!pathContractName) {
          response.result = ForgeResult.failUserInput;
          return response;
        }
      }
      await this.runAnvil(); // run anvil does not return until up successfully or throws error if cant get up in x number of seconds
      cmdToExec = `${this.forgeBin} script ${pathContractName} -vvvvv --extra-output storageLayout --rpc-url http://localhost:8545`;
      await this.scriptingOutput.preScriptSimOutput(
        pathContractName,
        cmdToExec
      );

      const { stdout, stderr } = await exec(cmdToExec, this.opts);

      await this.scriptingOutput.postScriptSimOutput(stdout, stderr, response);

      return response;
    } catch (err) {
      await this.scriptingOutput.postScriptSimOutput(
        undefined,
        err instanceof Error ? err.message : toText(err),
        response
      );
      return response;
    }
  }

  private async runForgeVerifyContract(
    context: vscode.ExtensionContext,
    execCmd: string,
    etherscanKey: string
  ): Promise<boolean> {
    try {
      execCmd += ` --resume --verify --etherscan-api-key ${etherscanKey} --delay 20 --retries 3`;
      await this.scriptingOutput.preVerifyOutput(execCmd);
      const { err, stdout, stderr } = await exec(execCmd, this.opts);
      return await this.scriptingOutput.postVerifyOutput(stdout, stderr);
    } catch (err) {
      return await this.scriptingOutput.postVerifyOutput(
        "",
        err instanceof Error ? err.message : toText(err)
      );
    }
  }

  async runFoundryScriptRinkebyFn(
    context: vscode.ExtensionContext,
    doVerify: boolean,
    pathContractName: string | undefined = undefined
  ): Promise<ScriptResponse> {
    let response = { result: ForgeResult.failUnknownReason } as ScriptResponse;
    let execCmd = "";
    try {
      Logger.info("enter runFoundryScriptRinkebyFn");
      const RINKEBY_RPC_URL = await this.getSecrets(
        context.secrets,
        "rinkebyRpcUrl"
      );
      const PRIVATE_KEY = await this.getSecrets(context.secrets, "privateKey");
      const ETHERSCAN_KEY = await this.getSecrets(
        context.secrets,
        "etherscanKey"
      );

      if (!RINKEBY_RPC_URL) {
        await this.notFoundError(
          "RINKEBY_RPC_URL",
          "Add Secret Rinkeby RPC URL"
        );
        return response;
      } else if (!PRIVATE_KEY) {
        await this.notFoundError("PRIVATE_KEY", "Add Secret Private Key");
        return response;
      } else if (doVerify && !ETHERSCAN_KEY) {
        await this.notFoundError(
          "ETHERSCAN_KEY",
          "Add Secret Etherscan Key",
          "You can still run a script without an Etherscan key if you do not verify your contract"
        );
        return response;
      }

      if (!pathContractName) {
        const pathContractName =
          await this.getPathAndContractFromSearchDialog();
      }
      if (!pathContractName) {
        return response;
      }

      execCmd = `${this.forgeBin} script ${pathContractName} --rpc-url ${RINKEBY_RPC_URL} \
            --private-key ${PRIVATE_KEY} --extra-output storageLayout --broadcast --json`;
      Logger.info(`command sent ${execCmd}`);

      await this.scriptingOutput.preScriptChainRun(pathContractName, execCmd);

      const { stdout, stderr } = await exec(execCmd, this.opts);

      await this.scriptingOutput.postScriptChainRun(
        stdout,
        stderr,
        response,
        RINKEBY_RPC_URL
      );

      if (stdout) {
        if (doVerify && ETHERSCAN_KEY) {
          if (
            !(await this.runForgeVerifyContract(
              context,
              execCmd,
              ETHERSCAN_KEY
            ))
          ) {
            response.result = ForgeResult.scriptSucessVerifyFail;
          }
          return response;
        }
      }
      return response;
    } catch (err) {
      await this.scriptingOutput.postScriptChainRun(
        undefined,
        err instanceof Error ? err.message : toText(err),
        response,
        ""
      );
      return response;
    }
  }
}

export class FoundryLocalScriptingCodeLens implements CodeLensProvider {
  // Each provider requires a provideCodeLenses function which will give the various documents
  // the code lenses

  private context: vscode.ExtensionContext;
  private codeLenses: vscode.CodeLens[] = [];
  private regex: RegExp;
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event;

  constructor(context: vscode.ExtensionContext) {
    //this.regex = /(.+)/g;
    this.regex = /^contract ([A-Za-z0-9]*)\s*is\s*Script/gm;
    this.context = context;

    vscode.workspace.onDidChangeConfiguration((_) => {
      this._onDidChangeCodeLenses.fire();
    });
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    if (true) {
      this.codeLenses = [];
      const regex = new RegExp(this.regex);
      const text = document.getText();
      let matches;
      matches = text.matchAll(regex);
      for (const match of matches) {
        console.log(match);
        console.log(match.index);
        if (!match.index) {
            Logger.error(`match.index for match: ${match} in file ${document.fileName} is undefined`);
            continue;
        }
        const line = document.lineAt(document.positionAt(match.index).line);
        const indexOf = line.text.indexOf(match[0]);
        const position = new vscode.Position(line.lineNumber, indexOf);
        const range = document.getWordRangeAtPosition(
          position,
          new RegExp(this.regex)
        );
        const folderName = getCurrentFolder(vscode.workspace.workspaceFolders)
          ?.uri?.fsPath;
        let dispName = document.fileName;
        let loc;
        if (folderName && (loc = dispName.search(folderName)) >= 0) {
          dispName = dispName.slice(loc + folderName.length + 1);
        }

        let command = {
          command: "ornithopter.forge.script.local",
          title: `Run Script (Local)`,
          arguments: [`${dispName}:${match[1]}`],
        };

        if (range) {
          this.codeLenses.push(new vscode.CodeLens(range, command));
        }
      }
      return this.codeLenses;
    }
  }
}
