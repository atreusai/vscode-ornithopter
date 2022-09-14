import * as assert from 'assert';
// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');
	console.log(`folders: ${(vscode.workspace.workspaceFolders)}`);
	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
	test('Foundry Scripting', async () => {
		const USE_LOCAL_ANVIL = false;
		const USE_LOCAL_FORGE = false;
		let extensionContext: vscode.ExtensionContext;
		const ext = vscode.extensions.getExtension("atreus.ornithopter");
		let result2 = await ext?.activate();
		console.log(`result of activation: ${result2}`);

		if (ext !== undefined) {
			assert.ok(!!ext);
			extensionContext = (global as any).testExtensionContext;
			console.log((extensionContext));
			extensionContext.secrets.store("dkddkdk", "dkdkd");
			console.log("zzz");
		}
		assert.strictEqual(2, 2);
	});
});
