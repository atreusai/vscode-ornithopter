import * as vscode from "vscode";

export function buildFoundryTaskProvider(
  folder: vscode.WorkspaceFolder
): vscode.TaskProvider<vscode.Task> {
  let task = new vscode.Task(
    { type: "foundry", task: "compile", group: {kind: "build", isDefault: true} },
    folder,
    "Forge",
    "Build",
    new vscode.ShellExecution("forge build")
  );
  task.group = vscode.TaskGroup.Build;

  const provider = {
    provideTasks(token?: vscode.CancellationToken) {
      return [task];
    },
    resolveTask(task: vscode.Task, token?: vscode.CancellationToken) {
      return task;
    },
  };

  return provider;
}