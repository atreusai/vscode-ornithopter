import { WebviewPanel } from "vscode";
import * as vscode from "vscode";
import Logger from "./logger";
import { ForgeResult, ScriptResponse, etherRpc, getTransactionHash, jsonToHtml, toText } from "./util";
import * as path from "path";
import { ANVIL_NET_ID, ANVIL_DEFAULT_PORT, LOCAL_FDRY_BIN, LOCAL_NODE_HTTP } from "./constants";

export class ScriptingOutput {
    panel: any;
    startTime: number;
    cssFilePath: string;
    context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.startTime = 0;
        this.cssFilePath = path.join(context.extensionPath, 'src/css/theme.css');
        this.context = context;
    }

    getWaitingHtml(title: string[], body: string[], panel: any) {
        const styleSrc = panel.webview.asWebviewUri(vscode.Uri.file(this.cssFilePath));
        let bodyData = "";
        for (let i = 0; i < body.length; ++i) {
            bodyData += `<h1 class="waiting">${title[i]} </h1> <br> ${body[i]} <br>`;
        }


        return ` <!DOCTYPE html>
        <html lang="en">
        <head>
            <link rel="stylesheet" href=${styleSrc}>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="X-UA-Compatible" content="ie=edge">
        </head>
        <style>
        h2 {
          text-align: center;
        }
        .ring {
          border: 20px solid rgb(211, 211, 211);
          position: absolute;
          left: 45%;
          border-radius: 50%;
          border-top: 20px solid black;
          width: 60px;
          height: 60px;
          animation: spin 1s linear infinite;
          margin-top: 200px;
        }
        @keyframes spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }
        </style>
        <div class="ring"> </div>
        <body>
        ${bodyData}
        </body>
        </html>
        `;
    }

    getWebviewContent2(header: string[], body: string[], headerColor: string[]) {
        if (body.length !== headerColor.length) {
            Logger.info("getWebviewContent2, body length != headerColor length");
            return `parsing error`;
        }
        let bodyData = "";
        for (let i = 0; i < body.length; ++i) {
            bodyData += `<h2 style="color:${headerColor[i]};"> ${header[i]} </h2> <br> ${body[i]} <br>`;
        }

        return ` <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="X-UA-Compatible" content="ie=edge">
        </head>
        <body>
        ${bodyData}
        </body>
        </html>
        `;
    }

    private async createPanelWaiting(title: string[], text: string[], headerColor: string[]): Promise<vscode.WebviewPanel> {
        let panel = vscode.window.createWebviewPanel(
            'ornithopter.view',
            title[0],
            vscode.ViewColumn.Beside,
            {
                enableScripts: true, //this enables javascript
                enableCommandUris: true
            }
        );
        panel.webview.html = this.getWaitingHtml(title, text, panel);
        return panel;
    }

    private replaceColors(str: string) {
        let colorArray = ['black', 'red', 'green', '#cccc00', '#03f4fc', 'magenta', 'cyan', 'white'];
        for (let i = 0; i < colorArray.length; ++i) {
            str = str.replace(new RegExp(`(?:\x1b\\[3${i}m)(.*?)(?:\x1b\\[0m)`, 'gs'), `<span style="color:${colorArray[i]}">$1</span>`);
        };
        return str;
    }

    private async makeHtmlForSimulationSuccess(stdout: string, startTime: number, header: string, jsonObj: any, panel: vscode.WebviewPanel) {
        try {
            const fileLoc = /(?<=Transactions saved to:).*(\.json)/m.exec(stdout);
            let fileLink;
            if (fileLoc) {
                fileLink = `<a href="command:ornithopter.openFile?${encodeURIComponent(JSON.stringify([fileLoc[0].trim()]))}"> Saved to: ${fileLoc[0]}</a>`;
            } else {
                fileLink = "";
            }
            const styleSrc = panel.webview.asWebviewUri(vscode.Uri.file(this.cssFilePath));
            let html = ` <!DOCTYPE html>
            <html lang="en">
            <head>
                <link rel="stylesheet" href=${styleSrc}>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="X-UA-Compatible" content="ie=edge">
            </head>
            <body>`;

            let body = `<h2 style="color:green"> ${header} </h2> <br> <br>`;
            if (fileLink) {
                body += fileLink + `<br><br>`;
            }
            body += stdout;
            body = body.replace(/(\n|\r)/g, "<br>");
            body = body.replace(String.fromCharCode(9474), `&nbsp&nbsp${String.fromCharCode(9474)}`);
            body = this.replaceColors(body);
            html += body;
            html += " </body></html>";
            Logger.info(`html FFFFFFFFFFF: ${html}`);
            return html;
        } catch (e) {
            Logger.error(`makeHtmlForScriptSuccess error parsing ${e}`);
            return stdout;
        }
    }

    private async outputSuccessfulRunSimulation(panel: vscode.WebviewPanel, stdout: string, response: ScriptResponse, transDataName: string, startTime: number, panelTitle: string, nodeURL: string = LOCAL_NODE_HTTP) {
        response.info = stdout;
        let successMsg = `Local Simulation Ran Successfully ${response.info}. \n result : ${stdout}`;
        Logger.info(successMsg);
        vscode.window.showInformationMessage(successMsg);
        response.result = ForgeResult.success;
        if (panel) {
            panel.webview.html = await this.makeHtmlForSimulationSuccess(stdout, startTime, panelTitle, response.info, panel);
        }
    }

    private async parseForgeOutput2(output: string, startTime: number): Promise<any> {
        try {
            const mapForge = new Map();
            mapForge.set('time', Date.now());
            mapForge.set('runTimeMillsec', Date.now() - startTime);

            const xs = output.split("\n");
            xs.forEach(line => {
                Logger.info(`line: ${line}`);
                try {
                    const obj = JSON.parse(line);
                    for (var key in obj) {
                        mapForge.set(key, obj[key]);
                    }
                } catch (e) {
                    if (line.search(":") > 0) {
                        const strs = line.split(":");
                        if (strs.length > 1) {
                            mapForge.set(strs[0], strs[1].trim());
                        }
                    }
                }
            });
            return (Object.fromEntries(mapForge));

        } catch (e) {
            Logger.error(`error with parseForgeOutput with error ${e}`);
            return {};
        }
    }

    private async makeHtmlForScriptSuccess(stdout: string, startTime: number, header: string, jsonObj: any, panel: vscode.WebviewPanel, nodeURL = LOCAL_NODE_HTTP) {
        try {
            const fileLoc = /(?<=Transactions saved to:).*(\.json)/m.exec(stdout);
            let fileLink;
            if (fileLoc) {
                fileLink = `<a href="command:ornithopter.openFile?${encodeURIComponent(JSON.stringify([fileLoc[0].trim()]))}"> Saved to: ${fileLoc[0]}</a>`;
            } else {
                fileLink = "";
            }
            //I don't know if this regex below matches all cases and this will fail if they change output
            let traces = /(?<=Simulated On-chain Traces)(.|\n)*(├─.*\n)/gm.exec(stdout);
            const styleSrc = panel.webview.asWebviewUri(vscode.Uri.file(this.cssFilePath));

            Logger.debug(`traces length: ${traces ? traces.length : ""}`);
            let html = ` <!DOCTYPE html>
                <html lang="en">
                <head>
                    <link rel="stylesheet" href=${styleSrc}>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <meta http-equiv="X-UA-Compatible" content="ie=edge">
                </head>
                <body>`;
            let body = `<h2 style="color:green"> ${header} </h2> <br> <br>`;

            if (fileLink) {
                body += fileLink + `<br><br>`;
            }
            if (jsonObj.gas_used) {
                body += `Gas Used: ${jsonObj.gas_used} <br><br>`;
            }
            if (traces && traces.length) {
                body += "Simulated On-chain Traces";
                body += traces[0];
                body += '<br><br>';
            }
            body += "<br>";
            body += "<h3>transactionInfo:</h3>";
            body += `<div class="my-json">${JSON.stringify(jsonObj, null, 2)}</div>`;
            body += "<br>";
            body = body.replace(/(\n|\r)/g, "<br>");

            html += body;
            html += " </body></html>";
            return html;
        } catch (e) {
            Logger.error(`makeHtmlForScriptSuccess error parsing ${e}`);
            return stdout;
        }
    }

    private async outputSuccessfulRun(panel: vscode.WebviewPanel, stdout: string, response: ScriptResponse, transDataName: string, startTime: number, panelTitle: string, nodeURL: string = LOCAL_NODE_HTTP) {
        try {
            Logger.debug("enter outputSuccessfulRun");
            response.info = await this.parseForgeOutput2(stdout, startTime);
            response.info[transDataName] = response.info['✅ Hash'] ? await getTransactionHash(response.info['✅ Hash'], nodeURL) : {};
            Logger.info(`Script ran successfully on node. \n result : ${toText(response.info)}`);
            vscode.window.showInformationMessage(`Script ran successfully, ${toText(response.info)}`);
            response.result = ForgeResult.success;
            if (panel) {
                panel.webview.html = await this.makeHtmlForScriptSuccess(stdout, startTime, panelTitle, response.info, panel, nodeURL = LOCAL_NODE_HTTP);
            }
        } catch (e) {
            Logger.error(`there was an error ${e}`);
        }
    }

    private parseCatchError(s: string) {
        if (!s) {
            return s;
        }
        let rtn = /(?<=Message:).*\\x1B/g.exec(s);
        if (!rtn || rtn.length === 0) {
            rtn = /(?<=\x1B)(.|\s)*(?=\x1B)/gm.exec(s);
            Logger.debug(`got here ${rtn}`);
        }
        let rtnStr = rtn && rtn.length ? rtn[0] /*.replace(/(\[36m|\\x1B|\[31m|\[0m)/g, '') */ : '';

        Logger.debug(`RegExMessage: ${toText(rtnStr)}`); //for debugging purposes, remove in production
        Logger.debug(`RegExinput: ${toText(s)}`);  //for debugging purposes, remove in production
        return rtnStr ? rtnStr : "";
    }

    private async handleError(err: any, panel: any, title: string) {
        let errMsg = err instanceof Error ? err.message : toText(err);

        let adjErrMsg = errMsg ? `${this.parseCatchError(errMsg)} <br><br> ${errMsg}` : 'Unknown Error';
        if (panel) {
            adjErrMsg = this.replaceColors(adjErrMsg);
            panel.webview.html = this.getWebviewContent2([title], [adjErrMsg], ["red"]);
        }
        vscode.window.showErrorMessage(`Failed at ${title} with error ${adjErrMsg}`);
        Logger.debug(`Failed at ${title} with error ${adjErrMsg}`);
    }

    private async makeVerifySuccessHtml(s: string, header: string) {
        const etherscanhttp = /(http|ftp|https):\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:\/~+#-]*[\w@?^=%&\/~+#-])/gm.exec(s);
        const etherHtmlLink = etherscanhttp && etherscanhttp.length ? `<a href=\"${etherscanhttp[0]}\">Etherscan Link: ${etherscanhttp[0]}</a>` : "";
        const fileLoc = /(?<=Transactions saved to:).*(\.json)/m.exec(s);
        // Couldn't figure how to make file links successfully clickable
        // const fileLink = fileLoc && fileLoc.length ? `<a href=file:///${fileLoc[0].trim()}>Saved to: ${fileLoc[0]}</a>/` : "";
        const fileLink = fileLoc && fileLoc.length ? `Saved to: ${fileLoc[0]}` : "";
        let html = ` <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="X-UA-Compatible" content="ie=edge">
        </head>
        <body>`;

        html = `<h2 style="color:green"> ${header} </h2> <br> <br>`;

        if (etherHtmlLink) {
            html += etherHtmlLink + `<br><br>`;
        }
        if (fileLink) {
            html += fileLink + `<br><br>`;
        }
        html += s.replace(/"([^"]+)":/g, '$1:').replace(/\\t/g, '');
        html += " </body></html>";
        Logger.debug(`verify html Success: ${html}`);
        return html;
    }

    async preScriptSimOutput(pathContractName: string, execCmd: string, doUsePanel = true) {
        try {
            this.startTime = Date.now();
            Logger.info(`Running simulation for script: ${pathContractName}, cmd to execute: ${execCmd}`);
            if (doUsePanel) {
                this.panel = await this.createPanelWaiting(["Simulating Script..."], [``], ["black"]);
            }
        } catch (e) {
            Logger.debug(`preScriptSimOutput failed with error: ${e}`);
            throw (e);
        }
    }

    async postScriptSimOutput(stdout: string | undefined, stderr: string | undefined, response: ScriptResponse, doUsePanel = true) {
        try {
            Logger.debug(`Finished running script simulation : stdout: ${stdout}\n, stderr: ${stderr}`);
            if (stdout) {
                response.result = ForgeResult.success;
                this.outputSuccessfulRunSimulation(doUsePanel && this.panel ? this.panel : null, stdout, response, 'simulationTransData', this.startTime, 'Simulation Ran Successfully');
            }
            if (stderr) {
                this.handleError(stderr, this.panel && doUsePanel ? this.panel : null, "Failed Simulation");
            }
        } catch (e) {
            Logger.error(`postScriptSimOutput failed with error: ${e}`);
            throw (e);
        }
    }
    //////
    // When you are running a script on the RINKEBY_RPC_URL   

    async preScriptChainRun(pathContractName: string, execCmd: string, doUsePanel = true) {
        try {
            this.startTime = Date.now();
            Logger.info(`Running Script on Rinkeby: ${pathContractName}, cmd to execute: ${execCmd}`);
            if (doUsePanel) {
                this.panel = await this.createPanelWaiting(["Running Script on Rinkeby..."], [``], ["grey"]);
            }
        } catch (e) {
            Logger.error(`preScriptChainRun failed with error: ${e}`);
            throw (e);
        }
    }

    async postScriptChainRun(stdout: string | undefined, stderr: string | undefined, response: ScriptResponse, nodeUrl: string, doUsePanel = true) {
        try {
            Logger.debug(`Finished Running script: stdout: ${stdout}\n, stderr: ${stderr}`);
            if (stdout) {
                response.result = ForgeResult.success;
                this.outputSuccessfulRun(doUsePanel && this.panel ? this.panel : null, stdout, response, 'RinkebyNodeTransData', this.startTime, 'Rinkeby Script Ran Successfully', nodeUrl);
            }
            if (stderr) {
                this.handleError(stderr, this.panel && doUsePanel ? this.panel : null, "Failed Rinkeby Script");
            }
        } catch (e) {
            Logger.error(`postScriptChainRun failed with error: ${e}`);
            throw (e);
        }
    }

    async preVerifyOutput(execCmd: string, doUsePanel = true) {
        try {
            this.startTime = Date.now();
            Logger.info(`Running Verify... with cmd: ${execCmd}`);
            if (doUsePanel) {
                this.panel = await this.createPanelWaiting(["Verifying Contract (Can take a few minutes)..."], [``], ["grey"]);
            }
        } catch (e) {
            Logger.error(`preScriptChainRun failed with error: ${e}`);
            throw (e);
        }
    }

    async postVerifyOutput(stdout: string, stderr: string, doUsePanel = true): Promise<boolean> {
        try {
            Logger.debug(`runForgeVerifyContract stdout: ${stdout}`);
            Logger.debug(`runForgeVerifyContract stderr: ${stderr}`);
            if (stdout) {
                Logger.info(`Contract Verified Successfully`);
                if (doUsePanel && this.panel) {
                    this.panel.webview.html = await this.makeVerifySuccessHtml(stdout, "Contract Verified Successfully");
                }
                return true;
            }
            if (stderr) {
                this.handleError(stderr, this.panel && doUsePanel ? this.panel : null, "Contract Verification Failed");
                return false;
            }
            return false;
        } catch (e) {
            Logger.error(`postVerifyOutput failed with error ${e}`);
            if (this.panel && doUsePanel) {
                this.panel.webview.html = e instanceof Error ? e.message : toText(e);
            }
            return false;
        }
    }
}
