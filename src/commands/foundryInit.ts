import * as vscode from "vscode";
import { cpExecAsync, getCurrentFolder } from "../util";
import { LOCAL_FDRY_BIN } from "../constants";
import { promisify } from "node:util";
const exec = promisify(require('child_process').exec);
import * as path from 'path';

export async function foundryInit(context: vscode.ExtensionContext, useLocalBin: boolean) {
    const folder = getCurrentFolder(vscode.workspace.workspaceFolders);
    if (folder === undefined) {
        vscode.window.showErrorMessage("No folder currently open");
        return;
    }

    await vscode.window.withProgress({
        cancellable: false,
        title: "Initializing project...",
        location: vscode.ProgressLocation.Window,
    }, async (progress) => {
        progress.report({
            message: "starting...",
            increment: 0.5,
        });
        const forgeBin = useLocalBin ? path.join(folder?.uri?.toString(), LOCAL_FDRY_BIN, "forge") : "forge";
        await exec(`${forgeBin} init ${folder?.uri?.fsPath} --vscode`, {
            "cwd": folder.uri.fsPath,
            "env": process.env
        });
        progress.report({
            message: "completed.",
            increment: 1,
        });
        vscode.window.showInformationMessage("Init completed!");
    });
}