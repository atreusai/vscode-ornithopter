import { DiagnosticCollection, AuthenticationSession } from "vscode";
import { Auth0AuthenticationProvider } from "./auth0Provider";


export interface Hover {
    file: string;
    line: number;
    position: number;
    data: string;
};

export interface StateManager {
  authProvider: Auth0AuthenticationProvider;
  serverLocation: string;
  hovers: Hover[];
  collection: DiagnosticCollection;
  session: undefined | AuthenticationSession;
};