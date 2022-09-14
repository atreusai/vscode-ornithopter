import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { getCurrentFolder, getServerLocation } from "./util";
import { StateManager } from "./state";
import { client, connection } from "websocket";
import { once } from "events";
import Logger from "./logger";

export async function initAnalysisWatchers(stateManager: StateManager) {
  const folder = getCurrentFolder(vscode.workspace.workspaceFolders)?.uri
    ?.fsPath;
  if (folder === undefined) {
    vscode.window.showErrorMessage("unable to find folder");
    Logger.error("unable to find folder");
    return;
  }

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.sol");

  if (!stateManager.session) {
    Logger.error("NO SESSION?");
    return;
  }

  let connection: connection;
  const socket = new client({});
  socket.connect(getServerLocation() + "file_change");
  let promise = once(socket, "connect");
  // const socket = new WebSocket(serverLocation + "file_change");
  let hasInitializedSocket = false;

  const filesChanged = async (
    type: "change" | "create" | "delete",
    changed: vscode.Uri
  ) => {
    const relativePath = path.relative(folder, changed.fsPath);
    const header = Buffer.from(
      JSON.stringify({ type, path: relativePath }) + "\n"
    );
    if (type === "delete") {
      connection.sendBytes(header);
    } else {
      const data = await fs.readFile(changed.fsPath);
      connection.sendBytes(Buffer.concat([header, data]));
    }
  };
  watcher.onDidChange((data) => filesChanged("change", data));
  watcher.onDidCreate((data) => filesChanged("create", data));
  watcher.onDidDelete((data) => filesChanged("delete", data));

  const session = await vscode.authentication.getSession("atreus", [], {
    createIfNone: false,
  });
  if (session === undefined) {
    vscode.window.showErrorMessage("Please log in in order to use analysis");
    return;
  }
  Logger.info("about to await connect");
  connection = (await promise)[0];
  Logger.info("awaited connect happened");
  connection.sendUTF(
    JSON.stringify({ token: session.accessToken, id: session.account.id })
  );
  Logger.info("SENDING ACCESS TOKEN");
  vscode.workspace.findFiles("**/*.sol", "**/*.t.sol").then((files) =>
    files.forEach((file) => {
      Logger.info("created " + file);
      filesChanged("create", file);
    })
  );
  vscode.workspace.findFiles("**/cache/*.json").then((files) =>
    files.forEach((file) => {
      Logger.info("created " + file);
      filesChanged("create", file);
    })
  );
  vscode.workspace
    .findFiles("*.toml")
    .then((files) => files.forEach((file) => filesChanged("create", file)));
  Logger.info("FINISHED FINDING FILES");
}
