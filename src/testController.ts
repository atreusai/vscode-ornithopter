import { spawn } from "child_process";
import * as vscode from "vscode";
import { cpExecAsync, getCurrentFolder, getCurrentWorkspaceFolder } from "./util";
import Logger from "./logger";
import { LOCAL_FDRY_BIN } from "./constants";
import * as path from 'path';

interface TestItemMetadata {
    file: string | undefined;
    cls: string | undefined;
    test: string | undefined;
}

const getAllItems = (items: readonly vscode.TestItem[]): vscode.TestItem[] => {
    let allItems = [];

    let children = Array.from(items);
    while (children.length > 0) {
        let value = children.pop();
        if (value === undefined) {
            break;
        }
        value.children.forEach(child => {
            children.push(child);
        });
        allItems.push(value);
    }
    return allItems;
};

export const testControllerSetup = (useLocalBin: boolean): vscode.TestController => {
    // This is a WeakMap because VSCode recommends it. The purpose is so that if a TestItem is deallocated our WeakMap doesn't
    // continue to hold a reference.
    let testMetadata: WeakMap<vscode.TestItem, TestItemMetadata> = new WeakMap();

    const testController = vscode.tests.createTestController(
        "foundry_test_controller",
        "Foundry Tests"
    );
    // TODO: get TestItems again when the files change.
    testController.resolveHandler = async (item) => {
        // At the moment, listing out all the tests for a large project like solmate takes 2-3s, which kind of sucks.
        // If we could instead just list out the top-level files and then use resolveHandler when requested to resolve items,
        // that would be much faster.

        if (item === undefined) {
            try {
                // List out all tests
                const folder = getCurrentWorkspaceFolder(vscode.workspace.workspaceFolders);
                if (folder === undefined) {
                    return;
                }
                const forgeBin = useLocalBin ? path.join(folder?.uri?.toString(), LOCAL_FDRY_BIN, "forge") : "forge";
                const cpResult = await cpExecAsync(`${forgeBin} test --list -j --root ${getCurrentFolder(vscode.workspace.workspaceFolders)?.uri?.fsPath}`);
                // For some reason forge loves to give us a line that talks about how it compiles the files and then the actual results,
                // so we have to do a little bit of parsing to get the actual json.
                const hierarchyOfTests = JSON.parse(cpResult.split("\n")[1]);

                // This creates a test hierarchy that looks like the following:
                // * file_1.sol
                //     * contract_1
                //         * test_1
                //         * test_2
                //     * contract_2
                //         * test_3
                //         * test_4
                // * file_2.sol
                //      etc.
                // Each of the bullet points is a vscode.TestItem object, that users can click on to run that test and all subtests.
                // We have the `testMetadata` map to map between a TestItem (e.g. contract_1) and the file and contract it's a part
                // of so we can pass that to forge to actually run the relevant tests.
                for (let file in hierarchyOfTests) {
                    const fileItem = testController.createTestItem(`${file}`, file);
                    for (let cls in hierarchyOfTests[file]) {
                        const clsItem = testController.createTestItem(`${file}_${cls}`, cls);
                        for (let test of hierarchyOfTests[file][cls]) {
                            const testItem = testController.createTestItem(`${file}_${cls}_${test}`, test);
                            clsItem.children.add(testItem);
                            testMetadata.set(testItem, { file, cls, test });
                        }
                        fileItem.children.add(clsItem);
                        testMetadata.set(clsItem, { file, cls, test: undefined });
                    }
                    testController.items.add(fileItem);
                    testMetadata.set(fileItem, { file, cls: undefined, test: undefined });
                }
            } catch (e) {
                Logger.error(`failed compilation ${e}.  Please remove errors from solidity files`);
                vscode.window.showErrorMessage(`failed compilation ${e}. Please remove errors from solidity files`);

            }
        }
    };

    testController.createRunProfile("Run", vscode.TestRunProfileKind.Run, (request, token) => {
        let allIncludedItems: vscode.TestItem[] = [];

        const folder = getCurrentFolder(vscode.workspace.workspaceFolders)?.uri?.fsPath;
        if (folder === undefined) {
            vscode.window.showErrorMessage("Can't find current workspace");
            return;
        }

        let invocation: string[] = ["test", "--root", folder];

        const allTestsBeingRun: Map<string, vscode.TestItem> = new Map();

        // TODO: handle request.exclude. Should be fairly easy, as we can use the same mechanism but in reverse.
        if (request.include) {
            // We need a list of all the nodes, because we want to be able to show in the UI which have completed and which have failed.
            allIncludedItems = getAllItems(request.include);
            // If we got something in particular, figure out which files, classes, tests we want.
            let allFiles: Set<string> = new Set();
            let allClasses: Set<string> = new Set();
            let allTests: Set<string> = new Set();
            // TOFIGUREOUT: can request.include have multiple things? What does that even look like in the UI?
            request.include.forEach(testGrp => {
                const result = testMetadata.get(testGrp);
                if (result === undefined) {
                    return;
                }
                if (result.file === undefined) {
                    console.error("Got TestItem without file");
                    return;
                }
                allFiles.add(result.file);
                if (result.cls) {
                    allClasses.add(result.cls);
                } else {
                    // TODO: get all subclasses and subtests we want to match against
                    return;
                }
                if (result.test) {
                    allTests.add(result.test);
                }
            });

            let fileMatchArr: string[] = [];
            allFiles.forEach(file => fileMatchArr.push(file));
            let classMatchArr: string[] = [];
            allClasses.forEach(cls => classMatchArr.push(cls));
            let testMatchArr: string[] = [];
            allTests.forEach(test => testMatchArr.push(test));

            // TODO: match on files also. Not doing this at the moment because this takes globs, not regexes. Possibly talk to Foundry guy?
            if (testMatchArr.length > 0) {
                invocation.push("--match-test");
                invocation.push(testMatchArr.join("|"));
            }
            if (classMatchArr.length > 0) {
                invocation.push("--match-contract");
                invocation.push(classMatchArr.join("|"));
            }
            console.log("test_match_arr is", testMatchArr, "class_match_arr is", classMatchArr, "file_match_arr is", fileMatchArr);
        } else {
            // If we didn't get a more specific request, just run everything.

            // testController.items has everything we want to run, but we need all the leaf nodes we're running too.
            let listVersion: vscode.TestItem[] = [];
            testController.items.forEach(item => listVersion.push(item));
            allIncludedItems = getAllItems(listVersion);
        }

        allIncludedItems.forEach(item => {
            if (item.children.size === 0) {
                allTestsBeingRun.set(item.label, item);
            }
        });

        if (token.isCancellationRequested) {
            return;
        }
        const testRun = testController.createTestRun(request, "run", false);
        allIncludedItems.map(item => testRun.started(item));
        let forge = spawn("forge", invocation);
        forge.on("close", close => testRun.end());
        forge.on("error", code => vscode.window.showErrorMessage("Unable to run tests"));
        forge.on("disconnect", () => vscode.window.showErrorMessage("Unable to run tests"));
        forge.on("exit", code => vscode.window.showErrorMessage("Unable to run tests"));
        token.onCancellationRequested(() => forge.kill());
        forge.stdout.on("data", (data: any) => {
            const stringy: string = data.toString();
            const lines: string[] = stringy.split("\n");
            for (let line of lines) {
                if (!line.includes("PASS") && !line.includes("FAIL")) {
                    continue;
                }
                const results = line.split(" ");
                if (results.length < 2) {
                    continue;
                }
                let functionName = results[1];
                if (line.includes("Counterexample")) {
                    functionName = results[4];
                }
                functionName = functionName.split("(")[0];

                const test = allTestsBeingRun.get(functionName);
                if (test) {
                    if (results[0].includes("PASS")) {
                        testRun.passed(test);
                    } else {
                        testRun.failed(test, {
                            message: "test failed"
                        });
                    }
                }
            }
            testRun.appendOutput(stringy);
        });
    }, true);

    return testController;
};