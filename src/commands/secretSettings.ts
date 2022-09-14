import { ExtensionContext, SecretStorage, window } from "vscode";
import Logger from "../logger";


// Set the value of a key in secrets
//
export const storeToSecretsFn = async (secrets: SecretStorage, key: string, title?: string): Promise<void> => {
    const value = await window.showInputBox({ 'title': title });
    if (value) {
        secrets.store(key, value);
    }
};

// Get the value from a key secrets 
//
export const getFromSecretsFn = async (secrets: SecretStorage, key: string): Promise<string | undefined> => {
    try {
        const value = await secrets.get(key);
        window.showInformationMessage(`${value}`);
        Logger.info(`${key}:${value}`);
        return value;
    } catch (e) {
        Logger.error(`getFromSecretsFn error ${e}`);
        return "";
    }
};


