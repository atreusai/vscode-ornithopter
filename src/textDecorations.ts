import * as vscode from "vscode";
import Logger from "./logger";
import { IssueForDecoration, IssueType, toText } from "./util";
const lineGithubDecorationType = vscode.window.createTextEditorDecorationType({
    borderWidth: '2px',
    borderStyle: 'solid',
    overviewRulerColor: 'green',
    overviewRulerLane: vscode.OverviewRulerLane.Right,

    light: {
        // this color will be used in light color themes
        borderColor: 'darkblue'
    },
    dark: {
        // this color will be used in dark color themes
        borderColor: 'lightblue'
    }
});

export function updateDecorations(issues: IssueForDecoration[]) {
    try {
        Logger.debug(`updateDecorations: enter`);
        let activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            return;
        }
        const text = activeEditor.document.getText();
        Logger.debug(`updateDecorations: numIssues ${issues.length}`);
        for (let j = 0; j < text.length; ++j) {
            Logger.debug(`${j}: ${text[j].charCodeAt(0)}`);
        }
        const foundIssues: vscode.DecorationOptions[] = [];
        for (let i = 0; i < issues.length; ++i) {
            for (let j = 0; j < issues[i].data0!.length; ++j) {
                Logger.debug(`${j}: ${issues[i].data0![j].charCodeAt(0)}`);
            }
            Logger.debug(`issue: ${toText(issues[i])}`);

            if (issues[i].type === IssueType.githubIssue && issues[i].data0) {
                const largeNumbers: vscode.DecorationOptions[] = [];
                let match;
                let str1 = issues[i].data0!;
                Logger.debug(`str1: ${str1}`);
                let regEx = new RegExp(str1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

                if (match = regEx.exec(text)) {
                    Logger.debug(`got match!!! ${match.index} + ${match[0].length}`);

                    const startPos = activeEditor.document.positionAt(match.index);
                    const endPos = activeEditor.document.positionAt(match.index + match[0].length);
                    const decoration = { range: new vscode.Range(startPos, endPos), hoverMessage: issues[i].comment };
                    Logger.debug(`startPos: ${toText(startPos)}, endPos: ${toText(endPos)}`);
                    foundIssues.push(decoration);

                }
            }
        }
        activeEditor.setDecorations(lineGithubDecorationType, foundIssues);
    }
    catch (e) {
        Logger.error(`error with updateDecorations: ${e}`)
    }
}