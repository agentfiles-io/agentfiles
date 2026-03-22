import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ConnectClientKind } from "@attach/shared";

export interface ConnectSessionResponse {
  id: string;
  approval_url: string;
  expires_at: string;
}

export interface RedeemResponse {
  api_base_url: string;
  api_key: string;
  principal: { id: string; type: string };
  namespace: { id: string; slug: string } | null;
  scope: { permissions?: string[]; namespaces?: string[] };
  suggested_env: { ATTACH_API_URL: string; ATTACH_API_KEY: string };
}

interface LoopbackServer {
  port: number;
  waitForCallback: () => Promise<{ connectionId: string; code: string }>;
  close: () => void;
}

interface RunBrowserConnectOptions {
  apiUrl: string;
  clientKind: ConnectClientKind;
  displayName: string;
}

interface RunBrowserConnectDependencies {
  fetchImpl?: typeof fetch;
  openBrowserImpl?: typeof openBrowser;
  report?: (message: string) => void;
  startLoopbackServerImpl?: () => Promise<LoopbackServer>;
  approvalTimeoutMs?: number;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function toAttachConfig(credentials: RedeemResponse): {
  api_url: string;
  api_key: string;
  default_namespace?: string;
} {
  const config = {
    api_url: credentials.api_base_url,
    api_key: credentials.api_key,
  };

  if (credentials.namespace?.slug) {
    return {
      ...config,
      default_namespace: credentials.namespace.slug,
    };
  }

  return config;
}

export function resolveApiUrl(
  apiUrl: string | undefined,
  existingConfig: { api_url: string } | null,
): string {
  return (apiUrl ?? existingConfig?.api_url ?? "http://localhost:3000").replace(/\/$/, "");
}

async function openBrowser(url: string): Promise<boolean> {
  try {
    const open = await import("open");
    await open.default(url);
    return true;
  } catch {
    return false;
  }
}

function startLoopbackServer(): Promise<LoopbackServer> {
  return new Promise((resolve, reject) => {
    let callbackResolve!: (value: { connectionId: string; code: string }) => void;
    const callbackPromise = new Promise<{ connectionId: string; code: string }>((res) => {
      callbackResolve = res;
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/callback") {
        const connectionId = url.searchParams.get("connection_id");
        const code = url.searchParams.get("code");

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Approved - AgentFiles</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); padding: 3rem; text-align: center; }
  h1 { color: #22c55e; margin-bottom: 0.5rem; }
  p { color: #666; }
</style>
</head>
<body><div class="card"><h1>Approved!</h1><p>Return to your terminal to complete setup.</p></div></body>
</html>`);

        if (connectionId && code) {
          callbackResolve({ connectionId, code });
        }
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start loopback server"));
        return;
      }

      resolve({
        port: addr.port,
        waitForCallback: () => callbackPromise,
        close: () => server.close(),
      });
    });

    server.on("error", reject);
  });
}

async function parseErrorResponse(response: Response): Promise<string> {
  const error = await response.json().catch(() => ({ message: response.statusText })) as {
    message?: string;
  };
  return error.message ?? "Unknown error";
}

function waitForApprovalCallback(
  loopbackServer: LoopbackServer,
  approvalTimeoutMs: number,
): Promise<{ connectionId: string; code: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for browser approval."));
    }, approvalTimeoutMs);

    void loopbackServer.waitForCallback().then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function runBrowserConnectFlow(
  options: RunBrowserConnectOptions,
  dependencies: RunBrowserConnectDependencies = {},
): Promise<RedeemResponse> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const openBrowserImpl = dependencies.openBrowserImpl ?? openBrowser;
  const report = dependencies.report ?? ((message: string) => console.error(message));
  const startLoopbackServerImpl =
    dependencies.startLoopbackServerImpl ?? startLoopbackServer;
  const approvalTimeoutMs =
    dependencies.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  let loopbackServer: LoopbackServer;
  try {
    loopbackServer = await startLoopbackServerImpl();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to start loopback server: ${message}`);
  }

  const loopbackRedirectUri = `http://127.0.0.1:${loopbackServer.port}/callback`;

  try {
    report("Creating connect session...");
    const startResponse = await fetchImpl(`${options.apiUrl}/v1/connect/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_kind: options.clientKind,
        completion_mode: "loopback",
        display_name: options.displayName,
        code_challenge: codeChallenge,
        loopback_redirect_uri: loopbackRedirectUri,
      }),
    });

    if (!startResponse.ok) {
      throw new Error(
        `Failed to create connect session: ${await parseErrorResponse(startResponse)}`,
      );
    }

    const session = await startResponse.json() as ConnectSessionResponse;

    report("Opening browser for approval...");
    const opened = await openBrowserImpl(session.approval_url);
    if (!opened) {
      report("Could not open browser automatically.");
      report(`Please open this URL manually:\n  ${session.approval_url}`);
    }

    report("Waiting for approval...");
    const { connectionId, code } = await waitForApprovalCallback(
      loopbackServer,
      approvalTimeoutMs,
    );

    report("Received approval, redeeming credentials...");
    const redeemResponse = await fetchImpl(
      `${options.apiUrl}/v1/connect/sessions/${connectionId}/redeem`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code_verifier: codeVerifier,
          one_time_auth_code: code,
        }),
      },
    );

    if (!redeemResponse.ok) {
      throw new Error(
        `Failed to redeem credentials: ${await parseErrorResponse(redeemResponse)}`,
      );
    }

    return await redeemResponse.json() as RedeemResponse;
  } finally {
    loopbackServer.close();
  }
}
