import * as vscode from "vscode";
import { cpExecAsync, getCurrentWorkspaceFolder } from "../util";
import { LOCAL_FDRY_BIN } from "../constants";
import { promisify } from "node:util";
const exec = promisify(require('child_process').exec);
import * as path from 'path';

export async function foundryBuild(context: vscode.ExtensionContext, isLocalBin: boolean, isOutput = true) {
    // TODO: integrate this with VSCode's Build APIs
    const folder = getCurrentWorkspaceFolder(vscode.workspace.workspaceFolders);
    if (folder === undefined) {
        return;
    }
    try {
        const forgeBin = isLocalBin ? path.join(folder?.uri?.toString(), LOCAL_FDRY_BIN, "forge") : "forge";
        await exec(`${forgeBin} build --extra-output storageLayout --root ${folder.uri.fsPath}`, {
            "cwd": folder.uri.fsPath,
            "env": process.env
        });
        if (isOutput) {
            vscode.window.showInformationMessage("Compilation succeeded");
        }
        return true;
    } catch (e) {
        if (isOutput) {
            vscode.window.showErrorMessage(`Compilation failed with error ${e}`);
        }
        return false;
    }
}

export async function foundryBuildSilent(context: vscode.ExtensionContext, isLocalBin: boolean) {
    return foundryBuild(context, isLocalBin, false);
}