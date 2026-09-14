import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  AuthError,
  authenticate,
  type JwtVerifier,
  type TokenIdentity,
} from "./auth.js";
import type { AppConfig } from "./config.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./mcp-server.js";

declare module "express-serve-static-core" {
  interface Request {
    identity?: TokenIdentity;
  }
}

const MCP_PATH = "/mcp";

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}

export function createApp(config: AppConfig, verify: JwtVerifier) {
  const app = express();
  app.disable("x-powered-by");

  const resourceMetadataUrl = `${config.publicBaseUrl}/.well-known/oauth-protected-resource`;

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  // RFC 9728 metadata so MCP clients can discover where to get a token.
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: config.publicBaseUrl,
      authorization_servers: [
        `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
      ],
      scopes_supported: [`${config.audiences[0]}/${config.requiredScope}`],
      bearer_methods_supported: ["header"],
    });
  });

  const requireEntraToken = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      req.identity = await authenticate(
        req.headers.authorization,
        verify,
        config.requiredScope,
      );
      next();
    } catch (error) {
      const authError =
        error instanceof AuthError
          ? error
          : new AuthError(401, "invalid_token", "Access token could not be validated.");
      res
        .status(authError.status)
        .set("WWW-Authenticate", authError.challenge(resourceMetadataUrl))
        .json(
          jsonRpcError(
            authError.status === 403 ? -32003 : -32001,
            authError.message,
          ),
        );
    }
  };

  // The body is only parsed once the caller is authenticated, so unauthenticated
  // traffic can never reach the JSON parser.
  const parseJsonBody = express.json({ limit: "1mb" });
  const handleBodyErrors = (
    error: unknown,
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (error) {
      res.status(400).json(jsonRpcError(-32700, "Parse error: invalid JSON body."));
      return;
    }
    next();
  };

  app.post(
    MCP_PATH,
    requireEntraToken,
    parseJsonBody,
    handleBodyErrors,
    async (req: Request, res: Response) => {
      // Stateless mode: a server + transport pair per request, scoped to the
      // identity that was just validated.
      const server = createMcpServer(req.identity!);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
          res.status(500).json(jsonRpcError(-32603, "Internal server error"));
        }
      }
    },
  );

  // Stateless servers have nothing to stream or terminate out-of-band.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res
      .status(405)
      .set("Allow", "POST")
      .json(jsonRpcError(-32000, "Method not allowed. Use POST for MCP requests."));
  };
  app.get(MCP_PATH, methodNotAllowed);
  app.delete(MCP_PATH, methodNotAllowed);

  return app;
}
