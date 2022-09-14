import * as path from 'path';
import * as cp from 'child_process';
import {
	downloadAndUnzipVSCode,
	runTests,
	resolveCliPathFromVSCodeExecutablePath,
	resolveCliArgsFromVSCodeExecutablePath
} from '@vscode/test-electron';
import { TIMEOUT } from 'dns';

async function main() {
	try {
		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		// The path to test runner
		// Passed to --extensionTestsPath
		const extensionTestsPath = path.resolve(__dirname, './suite/');
		const workspaceFolder = path.resolve(__dirname, '../../src/test/testWorkspaceFolder');
		const vscodeExecutablePath = await downloadAndUnzipVSCode('1.70.2', 'darwin-arm64');
		console.log(`in run tests ${workspaceFolder}`);

		const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, { platform: 'darwin-arm64' });
		cp.spawnSync(cli, [...args, '--install-extension', 'JuanBlanco.solidity'], {
			encoding: 'utf-8',
			stdio: 'inherit'
		});

		// Download VS Code, unzip it and run the integration test
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [workspaceFolder],
			extensionTestsEnv: { PRIVATE_KEY: 'private key' }
		});
	} catch (err) {
		console.error('Failed to run tests');
		process.exit(1);
	}
}

main();
