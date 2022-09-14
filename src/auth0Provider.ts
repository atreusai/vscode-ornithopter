import {
  authentication,
  AuthenticationProvider,
  AuthenticationProviderAuthenticationSessionsChangeEvent,
  AuthenticationSession,
  Disposable,
  env,
  EventEmitter,
  ExtensionContext,
  ProgressLocation,
  Uri,
  UriHandler,
  window,
} from "vscode";
import { v4 as uuid } from "uuid";
import { PromiseAdapter, promiseFromEvent } from "./util";
import { createHash, randomBytes } from "crypto";
import { AxiosRequestConfig } from "axios";
import axios from "axios";
import jwt_decode, { JwtPayload } from "jwt-decode";
import Logger from "./logger";

export const AUTH_TYPE = `atreus`;
const AUTH_NAME = `Atreus`;
const CLIENT_ID = `yH0GnSjBSWX9RljcxhcOLRZiHw8h93fN`;
const AUTH0_DOMAIN = `dev-mj00ysbm.us.auth0.com`;
const SESSIONS_SECRET_KEY = `${AUTH_TYPE}.sessions`;
const AUTH_AUDIENCE = "ATREUS_ANALYSIS";


interface AtreusAuthenticationSession extends AuthenticationSession {
  idToken?: string;
  refreshToken?: string;
}

interface IToken {
  accessToken?: string; // When unable to refresh due to network problems, the access token becomes undefined
  idToken?: string; // depending on the scopes can be either supplied or empty

  expiresIn?: number; // How long access token is valid, in seconds
  expiresAt?: number; // UNIX epoch time at which token will expire
  refreshToken: string;

  account: {
    label: string;
    id: string;
  };
  scope: string;
  sessionId: string; // The account id + the scope
}

class UriEventHandler extends EventEmitter<Uri> implements UriHandler {
  public handleUri(uri: Uri) {
    this.fire(uri);
  }
}

export class Auth0AuthenticationProvider
  implements AuthenticationProvider, Disposable {
  private sessionChangeEmitter =
    new EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private disposable: Disposable;
  private pendingStates: string[] = [];
  private codeExchangePromises = new Map<
    string,
    { promise: Promise<object>; cancel: EventEmitter<void> }
  >();
  private uriHandler = new UriEventHandler();
  private verifier = this.base64URLEncode(randomBytes(32));
  private codeChallenge = this.generateCodeChallenge();


  constructor(private readonly context: ExtensionContext) {
    this.disposable = Disposable.from(
      authentication.registerAuthenticationProvider(
        AUTH_TYPE,
        AUTH_NAME,
        this,
        {
          supportsMultipleAccounts: false,
        }
      ),
      window.registerUriHandler(this.uriHandler)
    );
  }

  get onDidChangeSessions() {
    return this.sessionChangeEmitter.event;
  }

  get redirectUri() {
    const publisher = this.context.extension.packageJSON.publisher;
    const name = this.context.extension.packageJSON.name;
    const redirectUri = `${env.uriScheme}://${publisher}.${name}`;
    return redirectUri;
  }

  private isCompleteSession(session: AtreusAuthenticationSession) {
    if (session.refreshToken === undefined) {
      Logger.info("No refresh token");
      return false;
    }
    return true;
  }


  private isExpiredSession(session: AtreusAuthenticationSession): boolean {
    const decodedToken = jwt_decode(session.accessToken) as JwtPayload;
    if (decodedToken && decodedToken.exp) {
      Logger.info(`Session ${session.id} expires in ${decodedToken.exp - Date.now() / 1000} seconds`);
      return decodedToken.exp < Date.now() / 1000;
    }
    return true;
  }

  private async refreshSessionIfNeeded(session: AtreusAuthenticationSession) {
    if (!this.isExpiredSession(session)) {
      return [session];
    }
    const newSession = await this.getRefreshedSession(session);
    await this.context.secrets.store(
      SESSIONS_SECRET_KEY,
      JSON.stringify([newSession])
    );
    this.sessionChangeEmitter.fire({
      added: [newSession],
      removed: [],
      changed: [],
    });
    return [newSession];
  }


  /**
   * Returns either, a valid session, a refreshed session, or an empty array if no valid refresh token is available
   */
  public async getSessions(
    scopes?: string[]
  ): Promise<readonly AuthenticationSession[]> {
    const allSessions = await this.context.secrets.get(SESSIONS_SECRET_KEY);
    if (!allSessions) {
      Logger.info("No sessions found");
      return [];
    }

    Logger.info(`Got sessions: ${allSessions}`);
    const sessions = JSON.parse(allSessions) as AtreusAuthenticationSession[];
    if (!!!sessions) {
      Logger.error("Error parsing sessions");
      return [];
    }
    for (const session of sessions) {
      if (!this.isCompleteSession(session)) {
        Logger.info(`Session ${session.id} is not complete, removing`);
        await this.removeSession(session.id);
        return [];
      }
      try {
        const refreshedSession = await this.refreshSessionIfNeeded(session);
        if (!refreshedSession) {
          throw Error("No refreshed session");
        }
        return refreshedSession;
      } catch (error) {
        Logger.error("Something went wrong with the refresh. Removing existing sessions. Please log back in.");
        await this.context.secrets.delete(SESSIONS_SECRET_KEY);
        return [];
      }
    }
    return [];
  }

  /**
   * Create a new auth session
   * @param scopes
   * @returns
   */
  public async createSession(scopes: string[]): Promise<AuthenticationSession> {
    try {
      Logger.info("Creating session...");
      const token = await this.login(scopes);
      if (!!!token.accessToken) {
        throw new Error("Could not log into auth0");
      }

      const userinfo: { name: string; email: string; exp: number } =
        await this.getUserInfo(token.accessToken);

      const session: AtreusAuthenticationSession = {
        id: uuid(),
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        account: {
          id: userinfo.email,
          label: userinfo.name,
        },
        scopes: scopes,
      };

      await this.context.secrets.store(
        SESSIONS_SECRET_KEY,
        JSON.stringify([session])
      );

      this.sessionChangeEmitter.fire({
        added: [session],
        removed: [],
        changed: [],
      });
      return session;
    } catch (e) {
      window.showErrorMessage(`Sign in failed: ${e}`);
      throw e;
    }
  }

  /**
   * Remove an existing session
   * @param sessionId
   */
  public async removeSession(sessionId: string): Promise<void> {
    const allSessions = await this.context.secrets.get(SESSIONS_SECRET_KEY);
    if (allSessions) {
      const sessions = JSON.parse(allSessions) as AuthenticationSession[];
      const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
      const session = sessions[sessionIdx];
      sessions.splice(sessionIdx, 1);

      await this.context.secrets.store(
        SESSIONS_SECRET_KEY,
        JSON.stringify(sessions)
      );

      if (session) {
        this.sessionChangeEmitter.fire({
          added: [],
          removed: [session],
          changed: [],
        });
      }
    }
  }

  /**
   * Dispose the registered services
   */
  public async dispose() {
    this.disposable.dispose();
  }

  /**
   * Log in to Auth0
   */
  private async login(scopes: string[] = []): Promise<IToken> {
    return await window.withProgress<IToken>(
      {
        location: ProgressLocation.Notification,
        title: "Signing in to Auth0...",
        cancellable: true,
      },
      async (_, token) => {
        const stateId = uuid();
        this.pendingStates.push(stateId);
        const scopeString = await this.getScopeString(scopes);

        const searchParams = new URLSearchParams([
          ["response_type", "code"],
          ["client_id", CLIENT_ID],
          ["redirect_uri", this.redirectUri],
          ["state", stateId],
          ["scope", scopeString],
          ["prompt", "login"],
          ["grant_type", "authorization_code"],
          ["code_challenge_method", "S256"],
          ["code_challenge", this.codeChallenge],
          ["audience", AUTH_AUDIENCE],
        ]);
        const uri = Uri.parse(
          `https://${AUTH0_DOMAIN}/authorize?${searchParams.toString()}`
        );
        await env.openExternal(uri);

        let codeExchangePromise = this.codeExchangePromises.get(scopeString);
        if (!codeExchangePromise) {
          codeExchangePromise = promiseFromEvent(
            this.uriHandler.event,
            this.handleUri(scopes)
          );
          this.codeExchangePromises.set(scopeString, codeExchangePromise);
        }

        try {
          return await Promise.race([
            codeExchangePromise.promise,
            new Promise<object>((_, reject) =>
              setTimeout(() => reject("Cancelled"), 60000)
            ),
            promiseFromEvent<any, any>(
              token.onCancellationRequested,
              (_, __, reject) => {
                reject("User Cancelled");
              }
            ).promise,
          ]);
        } finally {
          this.pendingStates = this.pendingStates.filter(
            (n) => n !== stateId
          );
          codeExchangePromise?.cancel.fire();
          this.codeExchangePromises.delete(scopeString);
        }
      }
    );
  }

  private async getRefreshedSession(session: AtreusAuthenticationSession): Promise<AtreusAuthenticationSession> {
    if (session.refreshToken === undefined) {
      throw new Error("No refresh token");
    }
    const token = await this.refreshAccessToken(session.refreshToken);
    const currentAccessToken = token.access_token;
    if (currentAccessToken === undefined) {
      throw new Error("No access token");
    }
    return {
      id: uuid(),
      accessToken: currentAccessToken,
      refreshToken: session.refreshToken,
      scopes: token.scope,
      account: {
        id: session.account.id,
        label: session.account.label,
      }
    };
  }

  /**
   * Given a refresh token, get a new access token
   */
  private async refreshAccessToken(refreshToken: string) {
    const options = {
      method: "POST",
      url: `https://${AUTH0_DOMAIN}/oauth/token`,
      // eslint-disable-next-line @typescript-eslint/naming-convention
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID as string,
        refresh_token: refreshToken as string,
        audience: AUTH_AUDIENCE as string,
      }),
    };
    const response = await axios.request(options as AxiosRequestConfig);
    try {
      if (response.status === 200) {
        return response.data;
      } else {
        Logger.error(response.data);
      }
    } catch (e) {
      if (e instanceof Error) {
        Logger.error(e.message);
        throw e;
      }
      else {
        throw e;
      }
    }
  }

  /**
   * Get tokens from Auth0
   */
  private async getTokens(authCode: string, verifier: string, scopes: string) {
    const options = {
      method: "POST",
      url: `https://${AUTH0_DOMAIN}/oauth/token`,
      /* eslint-disable @typescript-eslint/naming-convention */
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: authCode,
        redirect_uri: this.redirectUri,
        code_verifier: verifier,
        scope: scopes,
        audience: AUTH_AUDIENCE,
      }),
      /* eslint-enable @typescript-eslint/naming-convention */
    };

    const response = await axios.request(options as any);

    try {
      if (response.status === 200) {
        return response.data;
      } else {
        Logger.error(response.data);
      }
    } catch (e) {
      if (e instanceof Error) {
        Logger.error(e.message);
        throw e;
      }
      else {
        throw e;
      }
    }
  }

  /**
   * Handle the redirect to VS Code (after sign in from Auth0)
   * @param scopes
   * @returns
   */
  private handleUri: (
    scopes: readonly string[]
  ) => PromiseAdapter<Uri, IToken> =
    (scopes) => async (uri, resolve, reject) => {
      const queryFragment = uri.query;
      const query = new URLSearchParams(queryFragment);
      const code = query.get("code");
      const state = query.get("state");
      const scopesStr = scopes.join(" ");
      //get the access token using the code
      if (code === null) {
        reject("No code found in the redirect URL");
      }
      const response = await this.getTokens(code as string, this.verifier, scopesStr);
      const accessToken = await response.access_token;
      const refreshToken = response.refresh_token;
      const tokenResponse = {
        accessToken: accessToken,
        refreshToken: refreshToken,
        expiresIn: response.expires_in,
        scope: scopesStr,
        account: {
          id: response.sub,
          label: response.name,
        },
        sessionId: "string",
      }

      if (!accessToken) {
        reject(new Error("No token"));
        return;
      }
      if (!state) {
        reject(new Error('No state'));
        return;
      }

      // Check if it is a valid auth request started by the extension
      if (!this.pendingStates.some(n => n === state)) {
        reject(new Error('State not found'));
        return;
      }

      resolve(tokenResponse);
    };

  /**
   * Get the user info from Auth0
   * @param token
   * @returns
   */
  private async getUserInfo(token: string): Promise<any> {

    const options = {
      method: "POST",
      url: `https://${AUTH0_DOMAIN}/userinfo`,
      // eslint-disable-next-line @typescript-eslint/naming-convention
      headers: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        Authorization: `Bearer ${token}`,
      },
    };
    const response = await axios.request(options as AxiosRequestConfig);
    try {
      if (response.status === 200) {
        return response.data;
      } else if (response.status === 401) {
        const errorMessage = "Unauthorized request to get userinfo from Auth0";
        throw new Error(errorMessage);
      } else {
        throw new Error(response.data);
      }
    } catch (e) {
      if (e instanceof Error) {
        Logger.error(e.message);
        throw e;
      }
      else {
        throw e;
      }
    }
  }

  private async getScopeString(scopes: string[]): Promise<string> {
    if (!scopes.includes("openid")) {
      scopes.push("openid");
    }
    if (!scopes.includes("profile")) {
      scopes.push("profile");
    }
    if (!scopes.includes("email")) {
      scopes.push("email");
    }
    if (!scopes.includes("offline_access")) {
      scopes.push("offline_access");
    }
    const scopeString = scopes.join(" ");
    return scopeString;
  }
  private generateCodeChallenge() {
    return this.base64URLEncode(
      this.sha256(Buffer.from(this.verifier, "utf8"))
    );
  }
  private sha256(buffer: Buffer) {
    return createHash("sha256").update(buffer).digest();
  }
  private base64URLEncode(buffer: Buffer) {
    return buffer
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }
}
