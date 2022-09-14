import * as vscode from "vscode";

export const logoutCommandFn = async (authProvider: vscode.AuthenticationProvider) => {
  let session = await vscode.authentication.getSession("atreus", [], {
    createIfNone: false,
  });

  session;
  if (!session) {
    vscode.window.showErrorMessage(`Atreus is not logged in`);
  } else {
    await authProvider.removeSession(session.id);
    vscode.window.showInformationMessage(`Atreus logged out`);
  }
};

export const loginCommandFn = async () => {
  let session = await vscode.authentication.getSession("atreus", [], {
    createIfNone: false,
  });
  if (session) {
    vscode.window.showInformationMessage(
      `Atreus is already logged in with account: ${session.account.label}`
    );
  }
  session = await vscode.authentication.getSession("atreus", [], {
    createIfNone: true,
  });
  vscode.window.showInformationMessage(
    `Welcome to Atreus, ${session.account.label}`
  );
};
