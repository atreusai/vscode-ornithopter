// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {
  analyze,
  foundryBuild,
  foundryBuildSilent,
  foundryInit,
  loginCommandFn,
  logoutCommandFn,
} from "./commands";
import { testControllerSetup } from "./testController";
import { getCurrentFolder, serverLocation, toCamelCase, IssueForDecoration, getRepoOwnerName, pollServerForDecorationIssues, getRepoBranch, parseUserIssueReference, toText,  getFoundryVersion } from "./util";
import * as vscode from "vscode";
import { initAnalysisWatchers } from "./analysisWatcher";
import { Auth0AuthenticationProvider } from "./auth0Provider";
import type { StateManager } from "./state";
import { buildFoundryTaskProvider } from "./taskProvider";
import { storeToSecretsFn, getFromSecretsFn } from "./commands/secretSettings";
import { FoundryLocalScriptingCodeLens, FoundryScripting } from "./foundryScripting";
import { isFoundryProject, installFoundaryLocally, isFoundryInstalledOnSystem, isFoundryExecutableInstalledLocally } from "./foundrySetup";
import { promisify } from "node:util";
import { updateDecorations } from "./textDecorations";
import Logger from "./logger";

const exec = promisify(require('child_process').exec);

export async function activate(context: vscode.ExtensionContext) {
  try {
    Logger.info("enter activate");
    // How to check if another extension is there?
    const folder = getCurrentFolder(vscode.workspace.workspaceFolders);
    const folderPath = folder?.uri?.fsPath;
    if (folder === undefined) {
      vscode.window.showErrorMessage("unable to find folder");
      Logger.error("unable to find folder");
      return;
    }
    // TO: DO get repo branch for user comment github integration
    //Logger.info(`RepoBranch: ${toText(await getRepoBranch())}`);

    if (!await isFoundryProject()) {
      Logger.error("unable to find FoundryProject files");
      const result = await vscode.window.showErrorMessage("Could not find foundry project files. \
      This extension only works with Foundry projects.  Do you want to continue?", "yes", "no");
      if (result === 'no') {
        return;
      }
    }
    /*
    // TODO: text decoration part
    let { repoOwner, repoName } = await getRepoOwnerName();
    Logger.info(`repoOwner: ${repoOwner}, repoName: ${repoName}`);
  
    let repoDecorationIssues: IssueForDecoration[] = [];
    let testIssue = await parseUserIssueReference('https://github.com/risingsun007/Solidity_DEX_trading/blob/16d9027f1ff09a5e0e0470007cf51dac70b95447/DEX_trading.sol#L41');
    repoDecorationIssues.push(testIssue);
    Logger.info(`return testissues: ${toText(testIssue)}`);
  
    vscode.window.onDidChangeActiveTextEditor(editor => {
      vscode.window.activeTextEditor = editor;
      if (editor) {
        updateDecorations(repoDecorationIssues);
      }
    }, null, context.subscriptions);
  
    vscode.workspace.onDidChangeTextDocument(event => {
      let activeEditor = vscode.window.activeTextEditor;
      if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
        updateDecorations(repoDecorationIssues);
      }
    }, null, context.subscriptions);
  */
    // Install foundry executables locally if not present
    // Determine which foundry executables to use(local vs system installed) 
    const isFoundryOnMachine = await isFoundryInstalledOnSystem(context);
    let isFoundryLocal = await isFoundryExecutableInstalledLocally();

    Logger.info(`found locally: ${isFoundryLocal}`);
    if (!isFoundryLocal && !isFoundryOnMachine) {
      const result = await vscode.window.showInformationMessage("Foundry executables not \
      found installed in your project folder.  Would you like to install Foundry in your project?", "yes", "no");
      if (result === 'yes') {
        const result = await installFoundaryLocally(context, vscode);
        isFoundryLocal = await isFoundryExecutableInstalledLocally();
        if (!isFoundryLocal) {
          const errMsg = `failed at installing Foundry locally ${toText(result)}`;
          Logger.error(errMsg);
          vscode.window.showErrorMessage(errMsg);
        }
      }
    }

    Logger.info(`is foundry on machine: ${isFoundryOnMachine}, is foundry in local workspace: ${isFoundryLocal}`);

    if (!isFoundryOnMachine && !isFoundryLocal) {
      Logger.error("Foundry executables not found in local project folder or on machine.  Exiting");
      vscode.window.showErrorMessage("Foundry executables not found in local project folder or on machine.  Exiting extension");
      return;
    }

    let selectedForgeLocation = vscode.workspace.getConfiguration('ornithopter').get<string>('foundryExecutableLocation');
    selectedForgeLocation = selectedForgeLocation ? selectedForgeLocation : "";
    let useLocalFoundry = selectedForgeLocation.search("Use Foundry Installed in Local Project Folder") >= 0 ? true : false;

    if (useLocalFoundry && !isFoundryLocal) {
      useLocalFoundry = false;
      Logger.error("Your setting requested using a local foundry install, but the local install in unvailable.  Using system install");
    }
    else if (!useLocalFoundry && !isFoundryOnMachine) {
      useLocalFoundry = true;
      Logger.error("Your setting requested using a system foundry install, but the system install could not be found.  Using local install");
    }

    const foundryVer = await getFoundryVersion(context, useLocalFoundry);
    Logger.info(`Foundry version being used: ${foundryVer?.join('.')}`);
    if(!foundryVer || foundryVer.length<3 ){
      vscode.window.showErrorMessage(`Could not find your foundry install.  Please install Foundry.`);
    }
    else if(foundryVer[1]<2 && foundryVer[0]===0){
      vscode.window.showErrorMessage(`The Atreus extension only supports foundry version 0.2.0 or higher, your version is ${foundryVer.join('.')}\
       Please update your Foundry Install and then restart VSCode.`);
    }



    ////
    /// TO DO: maybe we should initialize workspace to ensure they have the right lib/forge-std files installed?
    //await initProjectForFoundry(context, useLocalFoundry);

    const authProvider = new Auth0AuthenticationProvider(context);

    const diagnostics = vscode.languages.createDiagnosticCollection();

    let stateManager: StateManager = {
      authProvider,
      serverLocation: serverLocation,
      hovers: [],
      collection: diagnostics,
      session: undefined,
    };

    // TODO: handle changes in settings
    vscode.workspace.onDidChangeConfiguration(event => {
      Logger.info(`event: ${event}`);
      let affected = event.affectsConfiguration(".compiler");
      if (affected) {
        Logger.info("setting changed");

      }
    });

    const analyzeHandler = async () => {
      await vscode.window.withProgress(
        {
          cancellable: false,
          title: "Analysis",
          location: vscode.ProgressLocation.Notification,
        },
        async (progress) => {
          progress.report({
            message: "Building code...",
            increment: 0,
          });

          const buildResult = await foundryBuildSilent(context, useLocalFoundry);
          if (buildResult === false) {
            vscode.window.showErrorMessage(
              `Foundry must be able to successfully build the project before you can use analysis.`
            );
            return false;
          }
          progress.report({
            message: "Processing code on server...",
            increment: 25,
          });

          await analyze(stateManager);
          progress.report({
            message: "Analysis complete",
            increment: 100,
          });
        }
      );
    };

    // Task Providers
    vscode.tasks.registerTaskProvider(
      "foundry",
      buildFoundryTaskProvider(folder)
    );

    // Secrets Variable Load Priority
    // 1) Environomental Variable
    // 2) Stored Secret Variable 
    const envCreds: string[] = ["RINKEBY_RPC_URL", "PRIVATE_KEY", "ETHERSCAN_KEY"];
    envCreds.forEach(x => {
      if (x in process.env) {
        context.secrets.store(toCamelCase(x), process.env[x] || "");
      }
    });

    // Commands
    let analyzeCommand = vscode.commands.registerCommand(
      "ornithopter.analyze",
      analyzeHandler
    );

    let buildFoundryCommand = vscode.commands.registerCommand(
      "ornithopter.foundryBuild",
      async () => await foundryBuild(context, useLocalFoundry)
    );

    let initFoundrycommand = vscode.commands.registerCommand(
      "ornithopter.foundryInit",
      async () => foundryInit(context, useLocalFoundry)
    );

    let logoutCommand = vscode.commands.registerCommand(
      "ornithopter.logout",
      async () => await logoutCommandFn(authProvider)
    );

    let loginCommand = vscode.commands.registerCommand(
      "ornithopter.login",
      loginCommandFn
    );

    let installFoundryCommand = vscode.commands.registerCommand(
      "ornithopter.install.foundry.locally",
      async () => await installFoundaryLocally(context, vscode)
    );

    const setterSecretCommands = await Promise.all(envCreds.map(async x => {
      return vscode.commands.registerCommand(
        `ornithopter.set.${toCamelCase(x)}`,
        async () => await storeToSecretsFn(context.secrets, toCamelCase(x), `Input ${x}`)
      );
    }));

    const getterSecretCommands = await Promise.all(envCreds.map(async x => {
      Logger.info(`get secret command: ${toCamelCase(x)}`);
      return vscode.commands.registerCommand(
        `ornithopter.get.${toCamelCase(x)}`,
        async () => await getFromSecretsFn(context.secrets, toCamelCase(x))
      );
    }));

    //run foundary scripts
    const foundryScripting: FoundryScripting = new FoundryScripting(true, useLocalFoundry, context);
    //await foundryScripting.initialize(context);

    const forgeScriptLocalCommand = vscode.commands.registerCommand(
      "ornithopter.forge.script.local",
      async (name=undefined) => await foundryScripting.runFoundryScriptLocallyFn(context, name)
    );
    const forgeScriptRinkebyCommand = vscode.commands.registerCommand(
      "ornithopter.forge.script.rinkeby",
      async () => await foundryScripting.runFoundryScriptRinkebyFn(context, false)
    );

    let forgeScriptRinkebyWithVerifyCommand = vscode.commands.registerCommand(
      "ornithopter.forge.script.rinkeby.with.verification",
      async () => await foundryScripting.runFoundryScriptRinkebyFn(context, true)
    );
    // this command is used to open a file in a text editor from a webviewpanel
    let openFileCommand = vscode.commands.registerCommand(
      "ornithopter.openFile",
      (input) => {
        Logger.info(`ornithopter.openFile ${input}`);
        vscode.workspace.openTextDocument(input).then(doc => {
          Logger.info(`ornithopter.openFile2 ${toText(doc)}`);
          vscode.window.showTextDocument(doc)
        });
      }
    );

    let scriptDocSelector = {
      language: "solidity",
      //pattern: "**/*.s.sol"
    };

    // Register our CodeLens provider
    let forgeScriptCodeLensProviderDisposable = vscode.languages.registerCodeLensProvider(
      scriptDocSelector,
      new FoundryLocalScriptingCodeLens(context)
    );

    // Register repo: we shouldn't have this in prod.
    // let sCommand = vscode.commands.registerCommand("ornithopter.register", () => register)
    // Subscriptions
    context.subscriptions.push(analyzeCommand);
    context.subscriptions.push(buildFoundryCommand);
    context.subscriptions.push(initFoundrycommand);
    context.subscriptions.push(logoutCommand);
    context.subscriptions.push(loginCommand);
    context.subscriptions.push(installFoundryCommand);

    context.subscriptions.push(testControllerSetup(useLocalFoundry));
    context.subscriptions.push(authProvider);
    context.subscriptions.push(...setterSecretCommands);
    context.subscriptions.push(...getterSecretCommands);
    context.subscriptions.push(forgeScriptLocalCommand);
    context.subscriptions.push(forgeScriptRinkebyCommand);
    context.subscriptions.push(forgeScriptRinkebyWithVerifyCommand);
    context.subscriptions.push(forgeScriptCodeLensProviderDisposable)
    context.subscriptions.push(openFileCommand);

    stateManager.session = await vscode.authentication.getSession("atreus", [], {
      createIfNone: false,
    });
    if (stateManager.session) {
      Logger.info("Logged in");
      Logger.info("Activating Analysis Sync");
      initAnalysisWatchers(stateManager);
    }

  } catch (e) {
    Logger.error(`extension activation failed with error ${e}`);
    throw (e);
  }

}

export function deactivate() { }
