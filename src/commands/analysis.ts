import * as vscode from "vscode";
import fetch from "node-fetch";
import { getCurrentFolder, getServerLocation } from "../util";
import path = require("path");
import { StateManager } from "../state";
import Logger from "../logger";
interface SourceMap {
  relativeFile: string;
  line: number;
  startingColumn: number;
  length: number;
}

interface Element {
  name: string;
  sourceMapping: SourceMap;
}
type Impact = "High" | "Medium" | "Low" | "Optimization" | "Informational";

interface AnalyzeResult {
  check: string;
  overallDescription: string;
  firstMarkdownSource: string;
  impact: Impact;
  confidence: "High" | "Medium" | "Low";
  elements: Element[];
}

interface AnalysisError {
  message: string;
  detail: string;
}

interface AnalysisRequestBody {
  filename: string;
  id: string;
}

const impactToSeverityMapping = {
  Optimization: vscode.DiagnosticSeverity.Hint,
  Informational: vscode.DiagnosticSeverity.Information,
  Low: vscode.DiagnosticSeverity.Information,
  Medium: vscode.DiagnosticSeverity.Information,
  High: vscode.DiagnosticSeverity.Warning,
};

export async function analyze(stateManager: StateManager) {
  try {
    const session = await getSession();
    const workspaceFolder = await getWorkspaceFolder();
    const currentFile = await getCurrentFile();
    const body = {
      filename: path.relative(workspaceFolder, currentFile.fileName),
      id: session.account.id,
    } as AnalysisRequestBody;
    const analyzeResponse = await analysisReq(session, body);
    if (analyzeResponse === undefined) {
      const errorMessage =
        "Could not get analysis response from server, please check your network connection";
      throw new Error(errorMessage);
    }
    const analyzeResult = analyzeResponse as AnalyzeResult[];
    if (!!!analyzeResult) {
      const errorMessage = `Response from analysis server is malformed`;
      throw new Error(errorMessage);
    }
    const diagnostics = await getDiagnostics(analyzeResult);
    Logger.info("Diagnostics: " + JSON.stringify(diagnostics));
    stateManager.collection.set(currentFile.uri, diagnostics);
  } catch (e) {
    if (e instanceof Error) {
      Logger.error(e.message);
      vscode.window.showErrorMessage(e.message);
    } else {
      const errorMessage =
        "Caught error getting analysis results: + " + JSON.stringify(e);
      Logger.error(errorMessage);
      vscode.window.showErrorMessage(errorMessage);
    }
  }
}

async function analysisReq(
  session: vscode.AuthenticationSession,
  body: AnalysisRequestBody
): Promise<unknown | undefined> {
  try {
    const response = await fetchData(session, body);
    if (response === undefined) {
      Logger.error("Could not fetch data from the server");
      throw new Error(
        "No response from server, please check your network connection"
      );
    }
    let analyzeResult;
    try {
      analyzeResult = await response.json();
    } catch (e) {
      analyzeResult = {};
    }
    if (response.ok) {
      Logger.info(JSON.stringify(analyzeResult));
      return analyzeResult;
    }
    Logger.info(`error reponse analysisReq: ${response}`);
    const analysisError: AnalysisError = analyzeResult as AnalysisError;
    if (response.status === 500) {
      throw new Error(`Error code 500, Internal Server Error  ${analysisError.detail}`);
    }
    if (analysisError.message) {
      throw new Error(analysisError.message);
    } else if (response.status === 401) {
      throw new Error(
        "There is an issue with your authorization token, please log out and log back in."
      );
    } else if (response.status === 403) {
      throw new Error("You do not have permission to run the analyze command. \
      Please check with Atreus to get proper login details");
    } else if (response.status === 404) {
      throw new Error("Error 404: Page Not Found");
    }
    throw new Error(`Uncategorized error while running analysis ${response.status ? ', Response Status:' + response.status : ''}`);
  } catch (e) {
    if (e instanceof Error) {
      throw new Error(`Failed to run analysis: ${e.message}`);
    } else {
      throw new Error(
        `Error of unknown type caught while running analysis. If you get this error please file an issue on github.`
      );
    }
  }
}

async function fetchData(
  session: vscode.AuthenticationSession,
  body: AnalysisRequestBody
) {
  return fetch(path.join(getServerLocation(), "analyze/?token"), {
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      // eslint-disable-next-line @typescript-eslint/naming-convention
      "Content-Type": "application/json",
    },
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function getSession() {
  Logger.info("Getting session");
  return await vscode.authentication.getSession("atreus", [], {
    createIfNone: true,
  });
}

async function getCurrentFile() {
  Logger.info("Getting current file");
  const currentFile = vscode.window.activeTextEditor?.document;
  if (currentFile === undefined) {
    // This happens when we're on e.g. the "get started" page.
    throw new Error("Please open a file to analyze");
  }
  Logger.info("Current file: " + currentFile.fileName);
  return currentFile;
}

async function getWorkspaceFolder() {
  Logger.info("Getting workspace folder");
  const workspaceFolder = getCurrentFolder(vscode.workspace.workspaceFolders)
    ?.uri?.fsPath;
  if (workspaceFolder === undefined) {
    throw new Error(
      "Unable to get current workspace, please ensure you have one workspace open"
    );
  }
  Logger.info("Workspace folder: " + workspaceFolder);
  return workspaceFolder;
}

async function getDiagnostics(
  analyzeResult: any[]
): Promise<vscode.Diagnostic[]> {
  const document = await getCurrentFile();
  return analyzeResult.map((result) => {
    const sourceMapping = result.elements[0].source_mapping;

    //Only first line gets a diagnostic, otherwise looks too clutteredp
    const startPosition = new vscode.Position(
      sourceMapping.line - 1,
      sourceMapping.starting_column - 1
    );
    const endPosition = startPosition.translate(0, sourceMapping.length);
    const range = new vscode.Range(startPosition, endPosition);
    const severity =
      impactToSeverityMapping[
      result.impact as keyof typeof impactToSeverityMapping
      ];
    return new vscode.Diagnostic(range, result.overall_description, severity);
  });
}
