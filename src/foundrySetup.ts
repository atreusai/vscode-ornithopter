import * as vscode from "vscode";
import { promisify } from "node:util";
const exec = promisify(require('child_process').exec);
import { cpExecAsync, cpExecAsyncEnv, getCurrentWorkspaceFolder, getCurrentFolder } from "./util";
import { stdout } from "node:process";
import { INSTALL_FILE_NAME, LOCAL_FDRY_BIN } from "./constants";
import Logger from "./logger";
import * as path from "path";

async function isFileFound(strSearch: string) {
    const files = await vscode.workspace.findFiles(strSearch);
    if (!files || !files.length) {
        return false;
    } else {
        return true;
    }
}

export async function isFoundryInstalledOnSystem(context: vscode.ExtensionContext) {
    try {
        const { error, stdout, stderr } = await exec("forge -h", {
            "cwd": getCurrentFolder(vscode.workspace.workspaceFolders)?.uri?.fsPath,
            "env": process.env
        });
        return true;
    } catch (err) {
        Logger.error(`isFoundryInstalledOnSystem failed with error: ${err}`);
        return false;
    }
}

export async function isFoundryProject() {
    return isFileFound('{**/foundry.toml,**/*.t.sol}');
}

export async function isFoundryExecutableInstalledLocally() {
    let folder = getCurrentFolder(vscode.workspace.workspaceFolders)?.uri?.fsPath;
    if (!folder) {
        return false;
    }
    return isFileFound(path.join(folder, LOCAL_FDRY_BIN, 'forge'));


}

export async function getFoundryVersion(context: vscode.ExtensionContext) {
    try {
        const { stdout, stderr } = await exec("forge -V");
        Logger.info(`stdout: ${stdout}`);
        return stdout;
    }
    catch (err) {
        Logger.error(`getFoundryVersion failed with error ${err}`);
        return "unknown verison";
    }
}

async function runExecs(context: vscode.ExtensionContext, commands: string[]) {
    try {
        let doExit = false;
        let i = 0;
        const opts = {
            "cwd": getCurrentFolder(vscode.workspace.workspaceFolders)?.uri?.fsPath,
            "env": process.env,
            "maxBuffer": 2000 * 1024 * 1024 * 1000
        };

        while (!doExit && i < commands.length) {
            const { stdout, stderr } = await exec(commands[i], opts);
            if (stderr) {
                vscode.window.showErrorMessage(`err with command: ${commands[i]} with error ${stderr}`);
                Logger.error(`err with command: ${commands[i]} with error ${stderr}`);
                doExit = true;
            }

            ++i;
        }
    } catch (e) {
        Logger.error(`runExecs failed wieth error  ${e}`);
    }
}

export async function installFoundaryLocally(context: vscode.ExtensionContext, vscode: any) {
    try {
        const extensionFolder = vscode.extensions.getExtension("atreus.ornithopter").extensionPath;
        let commands: string[] = [];
        commands.push(`cp ${extensionFolder}/${INSTALL_FILE_NAME} ${INSTALL_FILE_NAME}`);
        commands.push(`chmod +x ${INSTALL_FILE_NAME}`);
        commands.push(`./${INSTALL_FILE_NAME}`);
        commands.push(`rm ${INSTALL_FILE_NAME}`);

        await runExecs(context, commands);
        return "";
    } catch (err) {
        Logger.error(`error with installFoundaryLocally with error ${err}`);
        return err instanceof Error ? err.message : err;
    }
}


